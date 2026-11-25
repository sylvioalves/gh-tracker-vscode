import { classify, type Ack, type Bucket, type Classified } from './classify.ts';
import { FOCUS_TEXT } from './filter-focus.ts';
import { queryKey } from './progress.ts';
import { prKey, type Issue, type PullRequest, type QueryResult, type Snapshot } from './github.ts';
import type { Ledger } from './ledger.ts';
import type { Session } from './sessions.ts';

/* The event a custom filter row is about, shown and sorted on instead
 * of the last update.
 */
export interface RowEvent {
  at: string;
  label: string;
}

export interface Row extends Classified {
  kind: 'pr';
  ledger: Ledger | undefined;
  sessions: Session[];
  updatedAt: string;
  unseen: boolean;
  event?: RowEvent;
}

export interface IssueRow {
  kind: 'issue';
  key: string;
  issue: Issue;
  myTurn: false;
  assigned: boolean;
  newReply: boolean;
  updatedAt: string;
  unseen: boolean;
  event?: RowEvent;
}

export type ViewRow = Row | IssueRow;

export interface Group {
  id: string;
  label: string;
  myTurn: boolean;
  rows: ViewRow[];
}

export interface ViewInput {
  snapshot: Snapshot;
  ledgers: Map<string, Ledger>;
  sessions: Map<string, Session[]>;
  acks: Record<string, Ack>;
  seen: Record<string, string>;
  labels: string[];
}

export const GROUPS: { id: Bucket; label: string; myTurn: boolean }[] = [
  { id: 'drafts', label: 'Pending reviews', myTurn: true },
  { id: 'recheck', label: 'Re-check', myTurn: true },
  { id: 'mine', label: 'My PRs', myTurn: true },
  { id: 'review', label: 'To review', myTurn: true },
  { id: 'waitingAuthor', label: 'Waiting on author', myTurn: false },
  { id: 'waitingReview', label: 'Waiting on reviewers', myTurn: false },
];

/* Latest time the viewer acted on the pull request: their review,
 * their last word on a review thread, or a push to their own one.
 */
export function lastOwnAction(c: Classified, viewer: string): string {
  const me = viewer.toLowerCase();
  let at = c.pr.myReview?.at ?? '';
  if (c.pr.author.toLowerCase() === me && (c.pr.pushedAt ?? '') > at) {
    at = c.pr.pushedAt ?? '';
  }
  for (const t of c.pr.threads) {
    if (t.lastAuthor.toLowerCase() === me && t.lastAt > at) {
      at = t.lastAt;
    }
  }
  return at;
}

/* Latest time the viewer acted on the issue: opening it or their
 * last comment on it.
 */
export function issueOwnAction(issue: Issue, viewer: string): string {
  const opened = issue.author.toLowerCase() === viewer.toLowerCase() ? issue.createdAt : '';
  const commented = issue.myLastCommentAt ?? '';
  return commented > opened ? commented : opened;
}

const ISO_RE = /^\d{4}-\d\d-\d\dT/;

function readMark(input: ViewInput, key: string): string {
  const seen = input.seen[key];
  return seen && ISO_RE.test(seen) ? seen : '';
}

function prRow(pr: PullRequest, input: ViewInput): Row {
  const { snapshot } = input;
  const key = prKey(pr.repo, pr.number);
  const ledger = input.ledgers.get(key);
  const c = classify(pr, {
    viewer: snapshot.viewer,
    roles: snapshot.roles[key] ?? [],
    labels: input.labels,
    ledger,
    ack: input.acks[key],
  });
  const read = readMark(input, key);
  const own = lastOwnAction(c, snapshot.viewer);
  return {
    ...c,
    kind: 'pr',
    ledger,
    sessions: input.sessions.get(key) ?? [],
    updatedAt: pr.updatedAt,
    unseen: pr.updatedAt > read && pr.updatedAt > own,
  };
}

export function issueRow(issue: Issue, input: ViewInput): IssueRow {
  const viewer = input.snapshot.viewer.toLowerCase();
  const key = prKey(issue.repo, issue.number);
  const read = readMark(input, key);
  const own = issueOwnAction(issue, viewer);
  const last = issue.lastComment;
  return {
    kind: 'issue',
    key,
    issue,
    myTurn: false,
    assigned: issue.assignees.some((a) => a.toLowerCase() === viewer),
    newReply: own !== '' && last !== null && last.author.toLowerCase() !== viewer && last.at > own,
    updatedAt: issue.updatedAt,
    unseen: issue.updatedAt > read && issue.updatedAt > own,
  };
}

export function rows(input: ViewInput): Row[] {
  return input.snapshot.prs.map((pr) => prRow(pr, input));
}

export function rowTime(r: ViewRow): string {
  return r.event?.at ?? r.updatedAt;
}

function newestFirst(a: ViewRow, b: ViewRow): number {
  const x = rowTime(a);
  const y = rowTime(b);
  return x < y ? 1 : x > y ? -1 : 0;
}

function withEvent(row: ViewRow, q: QueryResult): ViewRow {
  const at = q.eventAt?.[row.key];
  if (!q.focus || q.focus === 'activity' || !at) {
    return row;
  }
  return { ...row, event: { at, label: FOCUS_TEXT[q.focus] } };
}

export function buildView(input: ViewInput): Group[] {
  const all = rows(input);
  const builtin = GROUPS.map((g): Group => ({
    ...g,
    rows: all.filter((r) => r.bucket === g.id).sort(newestFirst),
  }));
  const custom = (input.snapshot.queries ?? []).map((q): Group => ({
    id: queryKey(q.name),
    label: q.name,
    myTurn: false,
    rows: [...q.prs.map((pr) => prRow(pr, input)), ...q.issues.map((i) => issueRow(i, input))]
      .map((r) => withEvent(r, q)).sort(newestFirst),
  }));
  return [...builtin.filter((g) => g.rows.length > 0), ...custom];
}

/* Groups in the order the user dragged them into. Groups the saved
 * order does not know keep their default place after the known ones.
 */
export function orderGroups(groups: Group[], order: string[]): Group[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = groups.filter((g) => rank.has(g.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...known, ...groups.filter((g) => !rank.has(g.id))];
}

/* The saved order after moving one group in front of another, or to
 * the end when `before` is undefined. Groups not yet in the saved
 * order are inserted at their current position first.
 */
export function moveGroup(current: string[], id: string, before: string | undefined): string[] {
  const ids = current.filter((g) => g !== id);
  const at = before === undefined ? ids.length : ids.indexOf(before);
  ids.splice(at < 0 ? ids.length : at, 0, id);
  return ids;
}

export function ago(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) {
    return '';
  }
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 3600) {
    return `${Math.max(1, Math.round(s / 60))}m ago`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)}h ago`;
  }
  return `${Math.round(s / 86400)}d ago`;
}
