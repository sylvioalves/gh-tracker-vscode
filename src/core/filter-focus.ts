import { tokenize } from './filter-query.ts';

/* The event a custom filter is about, decided by the qualifier that
 * names the viewer. The card shows when that event happened instead
 * of the item's last update.
 */
export type Focus = 'mentioned' | 'requested' | 'assigned' | 'authored' | 'activity';

export const FOCUS_TEXT: Record<Focus, string> = {
  mentioned: 'mentioned',
  requested: 'review requested',
  assigned: 'assigned',
  authored: 'opened',
  activity: 'updated',
};

const RANK: Focus[] = ['mentioned', 'requested', 'assigned', 'authored'];

const QUALIFIERS: Record<string, Focus> = {
  mentions: 'mentioned',
  'review-requested': 'requested',
  'user-review-requested': 'requested',
  assignee: 'assigned',
  author: 'authored',
};

const QUALIFIER_RE = /^([a-z-]+):"?@?([^"\s]*)"?$/i;

export function queryFocus(query: string, viewer: string): Focus {
  const me = viewer.toLowerCase();
  const found = new Set<Focus>();
  for (const token of tokenize(query)) {
    const m = QUALIFIER_RE.exec(token);
    const focus = m ? QUALIFIERS[m[1]!.toLowerCase()] : undefined;
    const who = m?.[2]?.toLowerCase();
    if (focus && (who === 'me' || who === me)) {
      found.add(focus);
    }
  }
  return RANK.find((f) => found.has(f)) ?? 'activity';
}

/* Timeline event type and the field that names the user it is about. */
export const FOCUS_EVENTS: Partial<Record<Focus, { type: string; event: string; who: string }>> = {
  mentioned: { type: 'MENTIONED_EVENT', event: 'MentionedEvent', who: 'actor' },
  requested: { type: 'REVIEW_REQUESTED_EVENT', event: 'ReviewRequestedEvent', who: 'requestedReviewer' },
  assigned: { type: 'ASSIGNED_EVENT', event: 'AssignedEvent', who: 'assignee' },
};

/* When the filter's event happened to the viewer. Timeline events are
 * used where the focus has one: the latest event naming the viewer,
 * or the creation time when the fetched window holds none.
 */
export function eventAt(focus: Focus, node: any, viewer: string): string {
  const spec = FOCUS_EVENTS[focus];
  if (spec) {
    const me = viewer.toLowerCase();
    let latest = '';
    for (const e of node.timelineItems?.nodes ?? []) {
      if (e?.[spec.who]?.login?.toLowerCase() === me && (e.createdAt ?? '') > latest) {
        latest = e.createdAt;
      }
    }
    return latest || node.createdAt || '';
  }
  return focus === 'authored' ? node.createdAt ?? '' : node.updatedAt ?? '';
}
