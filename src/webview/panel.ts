import type { PanelGroup, PanelRow, PanelSession } from '../core/panel-data.ts';

interface Status {
  kind: 'idle' | 'loading' | 'signedOut' | 'limited' | 'error';
  message?: string;
}

interface DataMessage {
  type: 'data';
  groups: PanelGroup[];
  status: Status;
}

interface State {
  open: string[];
  closed: string[];
  query?: string;
}

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): State | undefined;
  setState(s: State): void;
};

const QUERY_GROUP = 'query:';

const vscode = acquireVsCodeApi();
const root = document.getElementById('root')!;
const searchBar = document.getElementById('search')!;
const queryInput = document.getElementById('query') as HTMLInputElement;
const saved = vscode.getState();
const open = new Set<string>(saved?.open ?? []);
const closed = new Set<string>(saved?.closed ?? []);
let data: DataMessage | null = null;
let selected: string | null = null;
let query = saved?.query ?? '';

function save(): void {
  vscode.setState({ open: [...open], closed: [...closed], query });
}

function terms(): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t !== '');
}

function matches(r: PanelRow, words: string[]): boolean {
  const text = `${r.repo} #${r.number} ${r.author} ${r.title} ${r.tooltip}`.toLowerCase();
  return words.every((w) => text.includes(w));
}

function showSearch(show: boolean): void {
  searchBar.hidden = !show;
  document.body.classList.toggle('searching', show);
  if (show) {
    queryInput.focus();
    queryInput.select();
  } else if (query !== '') {
    query = '';
    queryInput.value = '';
    save();
    render();
  }
}

function run(command: string, prKey?: string, sessionId?: string): void {
  vscode.postMessage({ type: 'command', command, prKey, sessionId });
}

let dragging: string | null = null;

/* Moves group `id` in front of `before`, or to the end, and tells the
 * extension the new order of every visible group.
 */
function reorder(id: string, before: string | undefined): void {
  if (!data || id === before) {
    return;
  }
  const ids = data.groups.map((g) => g.id).filter((g) => g !== id);
  const at = before === undefined ? ids.length : ids.indexOf(before);
  ids.splice(at < 0 ? ids.length : at, 0, id);
  data.groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  render();
  vscode.postMessage({ type: 'order', ids });
}

function clearDropMarks(): void {
  for (const e of root.querySelectorAll('.drop-before, .drop-after, .dragging')) {
    e.classList.remove('drop-before', 'drop-after', 'dragging');
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

function icon(name: string, cls = ''): HTMLElement {
  return el('i', `codicon codicon-${name} ${cls}`.trim());
}

function ago(iso: string): string {
  if (!iso) {
    return '';
  }
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 3600) {
    return `${Math.max(1, Math.round(s / 60))}m ago`;
  }
  if (s < 86400) {
    return `${Math.round(s / 3600)}h ago`;
  }
  return `${Math.round(s / 86400)}d ago`;
}

function context(value: Record<string, string>): string {
  return JSON.stringify({ ...value, preventDefaultContextMenuItems: true });
}

function button(name: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'act');
  b.title = title;
  b.setAttribute('aria-label', title);
  b.append(icon(name));
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function isGroupOpen(g: PanelGroup): boolean {
  return g.myTurn ? !closed.has(g.id) : open.has(g.id);
}

function toggle(id: string, defaultOpen: boolean): void {
  const set = defaultOpen ? closed : open;
  if (set.has(id)) {
    set.delete(id);
  } else {
    set.add(id);
  }
  save();
  render();
}

function groupHeader(g: PanelGroup, shown: PanelRow[] | null): HTMLElement {
  const isOpen = shown !== null || isGroupOpen(g);
  const h = el('div', 'group nav');
  h.tabIndex = 0;
  h.setAttribute('role', 'treeitem');
  h.setAttribute('aria-expanded', String(isOpen));
  h.dataset.toggle = g.id;
  h.dataset.defaultOpen = String(g.myTurn);
  if (g.id.startsWith(QUERY_GROUP)) {
    h.dataset.vscodeContext = context({ webviewSection: 'filter', filterName: g.id.slice(QUERY_GROUP.length) });
  }
  h.append(icon(isOpen ? 'chevron-down' : 'chevron-right', 'tw'));
  h.append(el('span', 'glabel', g.label));
  const unseen = g.rows.filter((r) => r.unseen).length;
  if (g.progress !== undefined && g.progress < 100) {
    const p = el('span', 'gcount gprogress', `${g.progress}%`);
    p.prepend(icon('loading', 'codicon-modifier-spin'));
    h.append(p);
  } else if (shown !== null) {
    h.append(el('span', 'gcount', `${shown.length}/${g.rows.length}`));
  } else {
    h.append(el('span', 'gcount', unseen > 0 ? `${g.rows.length} · ${unseen} new` : String(g.rows.length)));
  }
  if (shown === null) {
    h.addEventListener('click', () => toggle(g.id, g.myTurn));
  }
  h.draggable = true;
  h.dataset.group = g.id;
  h.title = 'Drag to reorder, or Alt+Up / Alt+Down';
  h.addEventListener('dragstart', (e) => {
    dragging = g.id;
    h.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', g.id);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  h.addEventListener('dragend', () => {
    dragging = null;
    clearDropMarks();
  });
  h.addEventListener('dragover', (e) => {
    if (dragging === null || dragging === g.id) {
      return;
    }
    e.preventDefault();
    const after = e.offsetY > h.clientHeight / 2;
    h.classList.toggle('drop-before', !after);
    h.classList.toggle('drop-after', after);
  });
  h.addEventListener('dragleave', () => h.classList.remove('drop-before', 'drop-after'));
  h.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = dragging ?? e.dataTransfer?.getData('text/plain');
    const after = e.offsetY > h.clientHeight / 2;
    clearDropMarks();
    if (id && data) {
      const ids = data.groups.map((x) => x.id);
      const next = after ? ids[ids.indexOf(g.id) + 1] : g.id;
      reorder(id, next === id ? ids[ids.indexOf(id) + 1] : next);
    }
  });
  return h;
}

function card(r: PanelRow): HTMLElement {
  const kids = (r.ledger ? 1 : 0) + r.sessions.length;
  const isOpen = open.has(r.key);
  const c = el('div', `card nav${r.unseen ? ' unread' : ''}${selected === r.key ? ' sel' : ''}`);
  c.tabIndex = 0;
  c.setAttribute('role', 'treeitem');
  c.title = r.tooltip;
  c.dataset.vscodeContext = context({ webviewSection: 'pr', prKey: r.key, ghtrackerItem: r.menu });
  c.dataset.key = r.key;
  if (kids > 0) {
    c.dataset.toggle = r.key;
    c.dataset.defaultOpen = 'false';
    c.setAttribute('aria-expanded', String(isOpen));
  }
  const tw = icon(kids > 0 ? (isOpen ? 'chevron-down' : 'chevron-right') : 'blank', 'tw');
  if (kids > 0) {
    tw.addEventListener('click', (e) => {
      e.stopPropagation();
      toggle(r.key, false);
    });
  }
  const body = el('div', 'body');
  const top = el('div', 'top');
  top.append(el('span', 'repo', r.repo), el('span', 'num', `#${r.number}`));
  if (r.unseen) {
    top.append(el('span', 'dot', '●'));
  }
  if (r.author) {
    top.append(el('span', 'author', r.author));
  }
  if (r.authorTrust === 'new') {
    const mark = icon('person-add', 'newauthor');
    mark.title = `${r.author}: first-time contributor`;
    top.append(mark);
  }
  top.append(el('span', 'when', r.whenLabel ? `${r.whenLabel} ${ago(r.when)}` : ago(r.when)));
  body.append(top, el('div', 'title', r.title));
  const acts = el('div', 'acts');
  if (r.kind === 'issue') {
    acts.append(button('sparkle', 'Analyze Issue with Claude', () => run('ghtracker.analyzeIssue', r.key)));
  } else {
    acts.append(button('sparkle', 'Review with Claude (/pr-rev)', () => run('ghtracker.review', r.key)));
  }
  if (r.checked) {
    acts.append(button('discard', 'Uncheck', () => run('ghtracker.uncheck', r.key)));
  }
  if (r.myTurn && r.reasons.some((x) => x.kind !== 'kept')) {
    acts.append(button('check', 'Mark Checked', () => run('ghtracker.markChecked', r.key)));
  }
  acts.append(button('link-external', 'Open on GitHub', () => run('ghtracker.openOnGitHub', r.key)));
  c.append(tw, icon(r.icon, `kind ${r.reasons[0]?.kind ?? ''}`), body, acts);
  c.addEventListener('click', () => {
    selected = r.key;
    r.unseen = false;
    if (kids > 0) {
      toggle(r.key, false);
    } else {
      render();
    }
    run('ghtracker.markRead', r.key);
  });
  return c;
}

function child(r: PanelRow, label: string, desc: string, iconName: string, onClick: () => void): HTMLElement {
  const c = el('div', 'child nav');
  c.tabIndex = 0;
  c.setAttribute('role', 'treeitem');
  c.append(icon(iconName), el('span', 'clabel', label), el('span', 'cdesc', desc));
  c.addEventListener('click', onClick);
  c.dataset.key = r.key;
  return c;
}

function sessionRow(r: PanelRow, s: PanelSession): HTMLElement {
  const label = s.skills.map((k) => `/${k}`).join(' ');
  const c = child(r, label, `${ago(s.last)}${s.expired ? ', expired' : ''}`, s.expired ? 'circle-slash' : 'comment-discussion',
    () => run('ghtracker.openSession', r.key, s.id));
  c.title = s.id;
  if (!s.expired) {
    c.dataset.vscodeContext = context({ webviewSection: 'session', prKey: r.key, sessionId: s.id });
    const acts = el('div', 'acts small');
    acts.append(
      button('eye', 'Re-check Analysis (/fresh)', () => run('ghtracker.fresh', r.key, s.id)),
      button('list-ordered', 'List Findings (/findings)', () => run('ghtracker.findings', r.key, s.id)),
      button('trash', 'Clean Up Session Files (/cleanup)', () => run('ghtracker.cleanup', r.key, s.id)),
      button('comment-discussion', 'Open Session', () => run('ghtracker.openSession', r.key, s.id)),
    );
    c.append(acts);
  } else {
    c.classList.add('expired');
  }
  return c;
}

function message(text: string, iconName: string, command?: string, label?: string): HTMLElement {
  const m = el('div', 'message');
  m.append(icon(iconName), el('span', '', text));
  if (command && label) {
    const b = el('button', 'link', label);
    b.addEventListener('click', () => run(command));
    m.append(b);
  }
  return m;
}

function render(): void {
  const focusKey = (document.activeElement as HTMLElement | null)?.dataset?.key;
  root.textContent = '';
  if (!data) {
    root.append(message('Loading pull requests...', 'loading codicon-modifier-spin'));
    return;
  }
  const { status, groups } = data;
  if (status.kind === 'signedOut') {
    root.append(message('Not signed in to GitHub.', 'account', 'ghtracker.signIn', 'Sign in'));
  } else if (status.kind === 'error') {
    root.append(message(status.message ?? 'Error', 'warning', 'ghtracker.refresh', 'Retry'));
  } else if (status.kind === 'limited') {
    root.append(message(status.message ?? 'GitHub rate limit reached.', 'watch'));
  } else if (status.kind === 'loading' && groups.length === 0) {
    root.append(message(status.message ?? 'Loading pull requests...', 'loading codicon-modifier-spin'));
  } else if (groups.length === 0) {
    root.append(message('Nothing waiting on you.', 'check'));
  }
  const words = terms();
  let hits = 0;
  for (const g of groups) {
    const shown = words.length > 0 ? g.rows.filter((r) => matches(r, words)) : null;
    if (shown !== null && shown.length === 0) {
      continue;
    }
    hits += shown?.length ?? 0;
    root.append(groupHeader(g, shown));
    if (shown === null && !isGroupOpen(g)) {
      continue;
    }
    for (const r of shown ?? g.rows) {
      root.append(card(r));
      if (!open.has(r.key)) {
        continue;
      }
      if (r.ledger) {
        const l = r.ledger;
        const ledger = child(r, `Ledger: ${l.active} active`, `reviewed ${l.head}${l.reviewedAt ? ` on ${l.reviewedAt}` : ''}`, 'book',
          () => run('ghtracker.openLedger', r.key));
        ledger.title = l.counts + (l.mismatch ? '\nledger has drafted findings, GitHub has no pending review' : '');
        if (l.mismatch) {
          ledger.append(icon('warning', 'warn'));
        }
        ledger.dataset.vscodeContext = context({ webviewSection: 'ledger', prKey: r.key });
        root.append(ledger);
      }
      for (const s of r.sessions) {
        root.append(sessionRow(r, s));
      }
    }
  }
  if (words.length > 0 && hits === 0 && groups.length > 0) {
    root.append(message(`No matches for "${query.trim()}".`, 'search'));
  }
  if (focusKey) {
    root.querySelector<HTMLElement>(`.card[data-key="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

root.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (!target.classList.contains('nav')) {
    return;
  }
  const items = [...root.querySelectorAll<HTMLElement>('.nav')];
  const i = items.indexOf(target);
  if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && target.dataset.group && data) {
    const ids = data.groups.map((g) => g.id);
    const at = ids.indexOf(target.dataset.group);
    const before = e.key === 'ArrowUp' ? ids[at - 1] : ids[at + 2];
    if (e.key === 'ArrowDown' && at === ids.length - 1) {
      return;
    }
    reorder(target.dataset.group, before);
    root.querySelector<HTMLElement>(`.group[data-group="${CSS.escape(target.dataset.group)}"]`)?.focus();
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    items[i + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
    e.preventDefault();
  } else if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && target.dataset.toggle) {
    const id = target.dataset.toggle;
    const defaultOpen = target.dataset.defaultOpen === 'true';
    const isOpen = target.getAttribute('aria-expanded') === 'true';
    if ((e.key === 'ArrowRight') !== isOpen) {
      toggle(id, defaultOpen);
    }
    e.preventDefault();
  } else if (e.key === 'Enter' || e.key === ' ') {
    target.click();
    e.preventDefault();
  }
});

queryInput.value = query;
showSearch(query !== '');
queryInput.addEventListener('input', () => {
  query = queryInput.value;
  save();
  render();
});
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    showSearch(false);
    e.preventDefault();
  } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
    root.querySelector<HTMLElement>('.card')?.focus();
    e.preventDefault();
  }
});
document.getElementById('clear')!.addEventListener('click', () => showSearch(false));

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as DataMessage | { type: 'collapseAll' | 'search' };
  if (msg.type === 'search') {
    showSearch(searchBar.hidden !== false);
  } else if (msg.type === 'data') {
    data = msg;
    render();
  } else if (msg.type === 'collapseAll') {
    open.clear();
    for (const g of data?.groups ?? []) {
      if (g.myTurn) {
        closed.add(g.id);
      }
    }
    save();
    render();
  }
});

setInterval(render, 60_000);
render();
vscode.postMessage({ type: 'ready' });
