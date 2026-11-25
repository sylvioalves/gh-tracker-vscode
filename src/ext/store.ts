import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Ack } from '../core/classify.ts';
import { customQueries, fetchQueries, fetchSnapshot, GithubError, httpGql, type CustomQuery, type PrRef, type QueryResult, type Snapshot } from '../core/github.ts';
import { loadLedgers, type Ledger } from '../core/ledger.ts';
import { loadSessionIndex, type Session } from '../core/sessions.ts';
import { buildView, orderGroups, type Group, type Row, type ViewRow } from '../core/view.ts';
import { getToken } from './auth.ts';

const RETRY_MIN_MS = 2 * 60 * 1000;
const RETRY_MAX_MS = 30 * 60 * 1000;
const SNAPSHOT_FILE = 'snapshot.json';
const ACKS = 'acks';
const SEEN = 'seen';
const PINS = 'pins';
const GROUP_ORDER = 'groupOrder';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? homedir() + p.slice(1) : p;
}

export interface Settings {
  repos: string[];
  labels: string[];
  pollMs: number;
  ledgerDir: string;
  sessionIndex: string;
  notifications: boolean;
  queries: CustomQuery[];
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('ghtracker');
  return {
    repos: c.get<string[]>('repos', []),
    labels: c.get<string[]>('watchedLabels', []),
    pollMs: Math.max(2, c.get<number>('pollMinutes', 10)) * 60 * 1000,
    ledgerDir: expandHome(c.get<string>('ledgerDir', '~/.claude/reviews')),
    sessionIndex: expandHome(c.get<string>('sessionIndex', '~/.claude/reviews/sessions.jsonl')),
    notifications: c.get<boolean>('notifications', true),
    queries: customQueries(c.get<unknown>('queries', [])),
  };
}

export type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'error'; message: string };

export class Store implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private snapshot: Snapshot | null = null;
  private ledgers = new Map<string, Ledger>();
  private sessions = new Map<string, Session[]>();
  private timer: NodeJS.Timeout | undefined;
  private failures = 0;
  private busy = false;
  private again = false;
  private queriesStale = false;
  private cache: Group[] = [];
  private readonly context: vscode.ExtensionContext;
  status: Status = { kind: 'idle' };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  get fetchedAt(): string | null {
    return this.snapshot?.fetchedAt ?? null;
  }

  get groups(): Group[] {
    return this.cache;
  }

  get myTurn(): Row[] {
    return this.cache.filter((g) => g.myTurn).flatMap((g) => g.rows).filter((r): r is Row => r.kind === 'pr');
  }

  async start(): Promise<void> {
    this.reloadLocal();
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, SNAPSHOT_FILE);
      this.snapshot = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'));
    } catch {
      this.snapshot = null;
    }
    this.recompute();
    await this.refresh(false);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changed.dispose();
  }

  /* Ledgers and the session index change on disk without a GitHub poll. */
  reloadLocal(): void {
    const s = settings();
    const before = new Set(this.ledgers.keys());
    this.ledgers = loadLedgers(s.ledgerDir);
    this.sessions = loadSessionIndex(s.sessionIndex);
    this.recompute();
    const added = [...this.ledgers.keys()].some((k) => !before.has(k));
    if (added && before.size > 0) {
      void this.refresh(false);
    }
  }

  private get acks(): Record<string, Ack> {
    return this.context.globalState.get<Record<string, Ack>>(ACKS, {});
  }

  private get seen(): Record<string, string> {
    return this.context.globalState.get<Record<string, string>>(SEEN, {});
  }

  get pins(): PrRef[] {
    return this.context.globalState.get<PrRef[]>(PINS, []);
  }

  get groupOrder(): string[] {
    return this.context.globalState.get<string[]>(GROUP_ORDER, []);
  }

  async setGroupOrder(ids: string[]): Promise<void> {
    await this.context.globalState.update(GROUP_ORDER, ids.filter((id) => typeof id === 'string'));
    this.recompute();
  }

  private liveKeys(): Set<string> {
    const s = this.snapshot;
    const items = [...(s?.prs ?? []), ...(s?.queries ?? []).flatMap((q) => [...q.prs, ...q.issues])];
    return new Set(items.map((i) => `${i.repo}#${i.number}`));
  }

  private plan(s: Settings): PrRef[] {
    const refs = new Map<string, PrRef>();
    for (const l of this.ledgers.values()) {
      refs.set(l.key, { repo: l.repo, number: l.number });
    }
    for (const p of this.pins) {
      refs.set(`${p.repo}#${p.number}`, p);
    }
    return [...refs.values()].filter((r) => s.repos.length === 0 || s.repos.includes(r.repo));
  }

  private recompute(): void {
    if (!this.snapshot) {
      this.cache = [];
    } else {
      const names = settings().queries.map((q) => q.name);
      const queries = (this.snapshot.queries ?? []).filter((q) => names.includes(q.name));
      this.cache = orderGroups(buildView({
        snapshot: { ...this.snapshot, queries },
        ledgers: this.ledgers,
        sessions: this.sessions,
        acks: this.acks,
        seen: this.seen,
        labels: settings().labels,
      }), this.groupOrder);
    }
    this.changed.fire();
  }

  private schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(false), ms);
  }

  async refresh(interactive: boolean): Promise<void> {
    if (this.busy) {
      this.again = true;
      return;
    }
    const s = settings();
    this.busy = true;
    this.status = { kind: 'loading' };
    this.changed.fire();
    const before = new Set(this.myTurn.filter((r) => r.unseen).map((r) => r.key));
    const first = this.snapshot === null;
    try {
      const token = await getToken(interactive);
      if (!token) {
        this.status = { kind: 'signedOut' };
        return;
      }
      this.snapshot = await fetchSnapshot(httpGql(token), { repos: s.repos, labels: s.labels, extra: this.plan(s), queries: s.queries });
      await this.persist();
      this.failures = 0;
      this.status = { kind: 'idle' };
      this.recompute();
      if (!first && s.notifications) {
        this.announce(this.myTurn.filter((r) => r.unseen && !before.has(r.key)));
      }
    } catch (err) {
      this.failures++;
      const message = err instanceof GithubError && err.status === 401
        ? 'GitHub rejected the token' : (err as Error).message;
      this.status = { kind: 'error', message };
    } finally {
      this.busy = false;
      const retry = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, this.failures - 1));
      if (this.status.kind !== 'signedOut') {
        this.schedule(this.failures > 0 ? retry : s.pollMs);
      }
      this.changed.fire();
      this.next();
    }
  }

  /* Runs the work requested while a fetch was in flight. */
  private next(): void {
    if (this.again) {
      this.again = false;
      this.queriesStale = false;
      void this.refresh(false);
    } else if (this.queriesStale) {
      void this.refreshQueries();
    }
  }

  /* Fetches only the filters that are new or whose query changed, so a
   * saved filter shows up without a full poll.
   */
  async refreshQueries(): Promise<void> {
    if (this.busy) {
      this.queriesStale = true;
      return;
    }
    this.queriesStale = false;
    const snapshot = this.snapshot;
    if (!snapshot) {
      await this.refresh(false);
      return;
    }
    const wanted = settings().queries;
    const have = new Map((snapshot.queries ?? []).map((q) => [q.name, q]));
    const changed = wanted.filter((q) => have.get(q.name)?.query !== q.query);
    if (changed.length === 0) {
      this.recompute();
      return;
    }
    this.busy = true;
    this.status = { kind: 'loading' };
    this.changed.fire();
    try {
      const token = await getToken(false);
      if (!token) {
        this.status = { kind: 'signedOut' };
        return;
      }
      const fetched = new Map((await fetchQueries(httpGql(token), snapshot.viewer, changed)).map((q) => [q.name, q]));
      const current = this.snapshot ?? snapshot;
      const old = new Map((current.queries ?? []).map((q) => [q.name, q]));
      this.snapshot = {
        ...current,
        queries: wanted.map((q) => fetched.get(q.name) ?? old.get(q.name)).filter((q): q is QueryResult => q !== undefined),
      };
      await this.persist();
      this.status = { kind: 'idle' };
      this.recompute();
    } catch (err) {
      const message = err instanceof GithubError && err.status === 401
        ? 'GitHub rejected the token' : (err as Error).message;
      this.status = { kind: 'error', message };
    } finally {
      this.busy = false;
      this.changed.fire();
      this.next();
    }
  }

  private async persist(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    const uri = vscode.Uri.joinPath(this.context.globalStorageUri, SNAPSHOT_FILE);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this.snapshot)));
  }

  private announce(fresh: Row[]): void {
    if (fresh.length === 0) {
      return;
    }
    const top = fresh[0]!;
    const what = `#${top.pr.number} ${top.reasons[0]?.text ?? 'needs you'}`;
    const text = fresh.length === 1 ? what : `${what}, and ${fresh.length - 1} more pull requests need you`;
    void vscode.window.showInformationMessage(`GH Tracker: ${text}`, 'Show').then((pick) => {
      if (pick === 'Show') {
        void vscode.commands.executeCommand('ghtracker.prs.focus');
      }
    });
  }

  rowByKey(key: string): ViewRow | undefined {
    return this.cache.flatMap((g) => g.rows).find((r) => r.key === key);
  }

  isPinned(key: string): boolean {
    return this.pins.some((p) => `${p.repo}#${p.number}` === key);
  }

  async pin(ref: PrRef): Promise<void> {
    if (!this.isPinned(`${ref.repo}#${ref.number}`)) {
      await this.context.globalState.update(PINS, [...this.pins, ref]);
      await this.refresh(false);
    }
  }

  async unpin(key: string): Promise<void> {
    await this.context.globalState.update(PINS, this.pins.filter((p) => `${p.repo}#${p.number}` !== key));
    this.recompute();
  }

  /* Hides the row from the user's turn until the head moves or a reply
   * newer than every current one arrives.
   */
  async ack(row: Row): Promise<void> {
    const replyAt = row.pr.threads.reduce((max, t) => (t.lastAt > max ? t.lastAt : max), '');
    const acks = { ...this.acks, [row.key]: { head: row.pr.head, replyAt } };
    const live = this.liveKeys();
    for (const key of Object.keys(acks)) {
      if (!live.has(key)) {
        delete acks[key];
      }
    }
    await this.context.globalState.update(ACKS, acks);
    this.recompute();
  }

  async markSeen(keys: string[]): Promise<void> {
    const seen = { ...this.seen };
    let changed = false;
    for (const key of keys) {
      const row = this.rowByKey(key);
      if (row && seen[key] !== row.updatedAt) {
        seen[key] = row.updatedAt;
        changed = true;
      }
    }
    const live = this.liveKeys();
    for (const key of Object.keys(seen)) {
      if (!live.has(key)) {
        delete seen[key];
        changed = true;
      }
    }
    if (changed) {
      await this.context.globalState.update(SEEN, seen);
      this.recompute();
    }
  }
}
