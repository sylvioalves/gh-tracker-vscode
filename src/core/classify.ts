import { prKey, type PullRequest, type Role } from './github.ts';

export type Bucket = 'drafts' | 'recheck' | 'review' | 'mine' | 'waitingAuthor' | 'waitingReview' | 'closed' | 'other';

export type ReasonKind = 'draftReview' | 'push' | 'replies' | 'ci' | 'conflicts' | 'changes' | 'assigned' | 'requested' | 'pinned';

export interface Reason {
  kind: ReasonKind;
  text: string;
  short: string;
}

/* State the user marked as checked: hides the pull request from their
 * turn until the head moves or a newer reply arrives.
 */
export interface Ack {
  head: string;
  replyAt: string;
}

export interface LedgerHead {
  head: string | null;
}

export interface Context {
  viewer: string;
  roles: Role[];
  labels: string[];
  ledger?: LedgerHead | undefined;
  ack?: Ack | undefined;
}

export interface Classified {
  key: string;
  pr: PullRequest;
  bucket: Bucket;
  myTurn: boolean;
  reasons: Reason[];
  priority: number;
}

const SHA_MIN = 7;

const SINCE: Record<string, string> = {
  CHANGES_REQUESTED: 'you requested changes',
  DISMISSED: 'your review was dismissed',
  COMMENTED: 'your comments',
  APPROVED: 'your approval',
};

/* Lower sorts first: what the viewer blocks, then own pull requests,
 * then reviews owed, then plain follow-ups.
 */
function priorityOf(bucket: Bucket, pr: PullRequest): number {
  if (bucket === 'drafts') {
    return 0;
  }
  if (bucket === 'recheck') {
    const state = pr.myReview?.state;
    return state === 'CHANGES_REQUESTED' || state === 'DISMISSED' ? 1 : (state === 'APPROVED' ? 5 : 3);
  }
  if (bucket === 'mine') {
    return 2;
  }
  return bucket === 'review' ? 4 : 9;
}

export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length < SHA_MIN || b.length < SHA_MIN) {
    return false;
  }
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.startsWith(y) || y.startsWith(x);
}

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function names(list: string[]): string {
  return list.length > 2 ? `${list.slice(0, 2).join(', ')} +${list.length - 2}` : list.join(', ');
}

/* Unresolved threads where someone else spoke last, newer than the
 * acknowledged reply. On another author's pull request only the
 * threads the viewer started count.
 */
function pendingReplies(pr: PullRequest, ctx: Context, ownPr: boolean): number {
  const since = ctx.ack?.replyAt ?? '';
  return pr.threads.filter((t) => !t.resolved
    && !same(t.lastAuthor, ctx.viewer)
    && t.lastAt > since
    && (ownPr || same(t.starter, ctx.viewer))).length;
}

function repliesReason(n: number): Reason {
  return { kind: 'replies', text: n === 1 ? '1 new reply on a thread' : `${n} new replies on threads`, short: n === 1 ? '1 reply' : `${n} replies` };
}

function ownReasons(pr: PullRequest, ctx: Context, acked: boolean): Reason[] {
  const out: Reason[] = [];
  if (!acked) {
    if (pr.ci === 'FAILURE' || pr.ci === 'ERROR') {
      out.push({ kind: 'ci', text: 'CI failed', short: 'CI failed' });
    }
    if (pr.mergeable === 'CONFLICTING') {
      out.push({ kind: 'conflicts', text: 'conflicts', short: 'conflicts' });
    }
    const blockers = Object.entries(pr.reviews)
      .filter(([who, r]) => r.state === 'CHANGES_REQUESTED' && !same(who, ctx.viewer) && sameCommit(r.commit, pr.head))
      .map(([who]) => who);
    if (blockers.length > 0) {
      out.push({ kind: 'changes', text: `changes requested by ${names(blockers)}`, short: 'changes requested' });
    }
  }
  const replies = pendingReplies(pr, ctx, true);
  if (replies > 0) {
    out.push(repliesReason(replies));
  }
  return out;
}

function reviewedReasons(pr: PullRequest, ctx: Context, acked: boolean): Reason[] {
  const out: Reason[] = [];
  const seen = [pr.myReview?.commit, ctx.ledger?.head];
  if (!pr.draft && !acked && !seen.some((c) => sameCommit(c, pr.head))) {
    out.push({ kind: 'push', text: `new push since ${SINCE[pr.myReview?.state ?? ''] ?? 'your ledger review'}`, short: 'pushed' });
  }
  const replies = pendingReplies(pr, ctx, false);
  if (replies > 0) {
    out.push(repliesReason(replies));
  }
  return out;
}

function firstLookReasons(pr: PullRequest, ctx: Context): Reason[] {
  const out: Reason[] = [];
  if (pr.assignees.some((a) => same(a, ctx.viewer))) {
    out.push({ kind: 'assigned', text: 'assigned to you', short: 'assigned' });
  } else if (ctx.roles.includes('requested')) {
    const hit = pr.labels.filter((l) => ctx.labels.some((w) => same(w, l)));
    out.push({ kind: 'requested', text: hit.length > 0 ? `review requested (${hit.join(', ')})` : 'review requested', short: 'requested' });
  }
  if (ctx.roles.includes('extra') && out.length === 0) {
    out.push({ kind: 'pinned', text: 'pinned', short: 'pinned' });
  }
  return out;
}

export function classify(pr: PullRequest, ctx: Context): Classified {
  const key = prKey(pr.repo, pr.number);
  const result = (bucket: Bucket, reasons: Reason[]): Classified => ({
    key,
    pr,
    bucket,
    myTurn: bucket === 'drafts' || bucket === 'recheck' || bucket === 'review' || bucket === 'mine',
    reasons,
    priority: priorityOf(bucket, pr),
  });
  if (pr.state !== 'OPEN') {
    return result('closed', []);
  }
  if (pr.pendingReview) {
    return result('drafts', [{ kind: 'draftReview', text: 'your review is pending, not submitted', short: 'draft pending' }]);
  }
  const acked = sameCommit(ctx.ack?.head, pr.head);
  if (same(pr.author, ctx.viewer)) {
    const reasons = ownReasons(pr, ctx, acked);
    return result(reasons.length > 0 ? 'mine' : 'waitingReview', reasons);
  }
  if (pr.myReview || ctx.ledger?.head) {
    const reasons = reviewedReasons(pr, ctx, acked);
    return result(reasons.length > 0 ? 'recheck' : 'waitingAuthor', reasons);
  }
  if (pr.draft || acked) {
    return result('other', []);
  }
  const reasons = firstLookReasons(pr, ctx);
  return result(reasons.length > 0 ? 'review' : 'other', reasons);
}
