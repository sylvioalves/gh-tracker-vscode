import type { ReasonKind } from './classify.ts';
import { authorTrust, type AuthorTrust } from './github.ts';
import { PRS_KEY, queryKey } from './progress.ts';
import type { Session } from './sessions.ts';
import { rowTime, type Group, type IssueRow, type Row, type ViewRow } from './view.ts';

export interface PanelSession {
  id: string;
  skills: string[];
  last: string;
  expired: boolean;
}

export interface PanelRow {
  kind: 'pr' | 'issue';
  key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorTrust: AuthorTrust;
  base: string;
  updatedAt: string;
  /* Time shown on the card, with the event it marks when not the last update. */
  when: string;
  whenLabel: string;
  unseen: boolean;
  myTurn: boolean;
  pinned: boolean;
  icon: string;
  reasons: { kind: ReasonKind | 'comments'; short: string; text: string }[];
  ledger: { active: number; head: string; reviewedAt: string | null; counts: string; mismatch: boolean } | null;
  sessions: PanelSession[];
  tooltip: string;
  menu: string;
}

export interface PanelGroup {
  id: string;
  label: string;
  myTurn: boolean;
  rows: PanelRow[];
  /* Percent fetched while a refresh runs. */
  progress?: number;
}

export interface PanelOptions {
  expired: (s: Session) => boolean;
  pinned: (key: string) => boolean;
  progress?: Record<string, number> | null;
}

const ICONS: Record<ReasonKind, string> = {
  draftReview: 'edit',
  push: 'git-commit',
  replies: 'comment-discussion',
  ci: 'error',
  conflicts: 'git-merge',
  changes: 'request-changes',
  assigned: 'person',
  requested: 'eye',
  pinned: 'pinned',
};

const TRUST_TEXT: Record<AuthorTrust, string> = {
  trusted: 'member',
  known: 'contributor',
  new: 'first-time contributor',
  unknown: '',
};

function byLine(author: string, trust: AuthorTrust): string {
  return TRUST_TEXT[trust] ? `${author} (${TRUST_TEXT[trust]})` : author;
}

function counts(row: Row): string {
  if (!row.ledger) {
    return '';
  }
  return Object.entries(row.ledger.counts).filter(([, n]) => n > 0).map(([s, n]) => `${n} ${s}`).join(', ');
}

function tooltip(row: Row): string {
  const { pr } = row;
  const lines = [
    `${pr.repo}#${pr.number} ${pr.title}`,
    `by ${byLine(pr.author, authorTrust(pr.authorAssociation))} into ${pr.base}, +${pr.additions} -${pr.deletions} in ${pr.changedFiles} files${pr.draft ? ', draft' : ''}`,
    `head ${pr.head.slice(0, 12)}, CI ${pr.ci ?? 'none'}, ${pr.mergeable.toLowerCase()}`,
  ];
  if (pr.myReview) {
    lines.push(`your review: ${pr.myReview.state.toLowerCase().replace('_', ' ')} at ${pr.myReview.commit?.slice(0, 12) ?? '?'}`);
  }
  if (row.ledger) {
    lines.push(`ledger: head ${row.ledger.head?.slice(0, 12) ?? '?'}, ${counts(row) || 'no findings'}`);
  }
  for (const r of row.reasons) {
    lines.push(`- ${r.text}`);
  }
  if (row.event) {
    lines.push(`${row.event.label} at ${row.event.at}, updated at ${pr.updatedAt}`);
  }
  return lines.join('\n');
}

function issueTooltip(row: IssueRow): string {
  const { issue } = row;
  const lines = [
    `${issue.repo}#${issue.number} ${issue.title}`,
    `issue by ${byLine(issue.author, authorTrust(issue.authorAssociation))}, ${issue.state.toLowerCase()}, ${issue.comments} comments`,
  ];
  if (issue.assignees.length > 0) {
    lines.push(`assigned to ${issue.assignees.join(', ')}`);
  }
  if (issue.labels.length > 0) {
    lines.push(`labels: ${issue.labels.join(', ')}`);
  }
  if (issue.lastComment) {
    lines.push(`last comment by ${issue.lastComment.author} at ${issue.lastComment.at}`);
  }
  if (row.event) {
    lines.push(`${row.event.label} at ${row.event.at}, updated at ${issue.updatedAt}`);
  }
  return lines.join('\n');
}

function issuePanelRow(row: IssueRow): PanelRow {
  const { issue } = row;
  const n = issue.comments;
  const reasons: PanelRow['reasons'] = [
    { kind: 'comments', short: n === 1 ? '1 comment' : `${n} comments`, text: n === 1 ? '1 comment' : `${n} comments` },
  ];
  if (row.assigned) {
    reasons.push({ kind: 'assigned', short: 'assigned', text: 'assigned to you' });
  }
  if (row.newReply && issue.lastComment) {
    reasons.push({ kind: 'replies', short: 'new reply', text: `new reply from ${issue.lastComment.author}` });
  }
  return {
    kind: 'issue',
    key: row.key,
    repo: issue.repo.split('/')[1] ?? issue.repo,
    number: issue.number,
    title: issue.title,
    url: issue.url,
    author: issue.author,
    authorTrust: authorTrust(issue.authorAssociation),
    base: '',
    updatedAt: issue.updatedAt,
    when: rowTime(row),
    whenLabel: row.event?.label ?? '',
    unseen: row.unseen,
    myTurn: false,
    pinned: false,
    icon: issue.state === 'CLOSED' ? 'issue-closed' : 'issues',
    reasons,
    ledger: null,
    sessions: [],
    tooltip: issueTooltip(row),
    menu: 'issue',
  };
}

export function panelRow(row: ViewRow, opts: PanelOptions): PanelRow {
  if (row.kind === 'issue') {
    return issuePanelRow(row);
  }
  const { pr } = row;
  const sessions = row.sessions.map((s) => ({ id: s.id, skills: s.skills, last: s.last, expired: opts.expired(s) }));
  const pinned = opts.pinned(row.key);
  const first = row.reasons[0]?.kind;
  const ledger = row.ledger
    ? {
      active: row.ledger.active,
      head: row.ledger.head?.slice(0, 7) ?? '?',
      reviewedAt: row.ledger.reviewedAt,
      counts: counts(row),
      mismatch: row.ledger.counts.drafted > 0 && !pr.pendingReview,
    }
    : null;
  const menu = ['pr', row.myTurn ? 'myturn' : '', ledger ? 'ledger' : '',
    sessions.some((s) => !s.expired) ? 'session' : '', pinned ? 'pinned' : ''].filter(Boolean).join(' ');
  return {
    kind: 'pr',
    key: row.key,
    repo: pr.repo.split('/')[1] ?? pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author,
    authorTrust: authorTrust(pr.authorAssociation),
    base: pr.base,
    updatedAt: pr.updatedAt,
    when: rowTime(row),
    whenLabel: row.event?.label ?? '',
    unseen: row.unseen,
    myTurn: row.myTurn,
    pinned,
    icon: first ? ICONS[first] : (row.bucket === 'waitingAuthor' ? 'clock' : 'git-pull-request'),
    reasons: row.reasons.map((r) => ({ kind: r.kind, short: r.short, text: r.text })),
    ledger,
    sessions,
    tooltip: tooltip(row),
    menu,
  };
}

/* Progress of a group: its own key for a custom filter, the shared
 * pull request key for the built-in groups.
 */
export function groupProgress(id: string, progress: Record<string, number> | null | undefined): number | undefined {
  return progress?.[id.startsWith(queryKey('')) ? id : PRS_KEY];
}

/* Overall percent of a running fetch, the mean over its groups. */
export function overallProgress(progress: Record<string, number> | null | undefined): number | undefined {
  const values = Object.values(progress ?? {});
  return values.length > 0 ? Math.floor(values.reduce((a, b) => a + b, 0) / values.length) : undefined;
}

export function panelData(groups: Group[], opts: PanelOptions): PanelGroup[] {
  return groups.map((g) => {
    const out: PanelGroup = { id: g.id, label: g.label, myTurn: g.myTurn, rows: g.rows.map((r) => panelRow(r, opts)) };
    const progress = groupProgress(g.id, opts.progress);
    if (progress !== undefined) {
      out.progress = progress;
    }
    return out;
  });
}
