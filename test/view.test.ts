import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalize, normalizeIssue, type PullRequest, type Snapshot } from '../src/core/github.ts';
import { ago, buildView, issueRow, rows, type ViewInput } from '../src/core/view.ts';

const base = normalize(JSON.parse(readFileSync(new URL('./fixtures/pr-114959.raw.json', import.meta.url), 'utf8')));
const ME = 'sylvioalves';
const OLD = '19084de379697507dce3ef15c3672feb1a7b14a7';

function pr(number: number, over: Partial<PullRequest> = {}): PullRequest {
  return { ...base, number, ...over };
}

function input(prs: PullRequest[], over: Partial<ViewInput> = {}): ViewInput {
  const snapshot: Snapshot = { viewer: ME, fetchedAt: '', prs, roles: {}, rateRemaining: null };
  return { snapshot, ledgers: new Map(), sessions: new Map(), acks: {}, seen: {}, labels: [], ...over };
}

const approved = { state: 'APPROVED', at: '', commit: OLD };
const blocked = { state: 'CHANGES_REQUESTED', at: '', commit: OLD };

test('groups follow the fixed order and drop empty ones', () => {
  const groups = buildView(input([
    pr(1, { myReview: approved, threads: [] }),
    pr(2, { pendingReview: { id: 'p', at: '' } }),
    pr(3, { author: ME, ci: 'SUCCESS', mergeable: 'MERGEABLE', reviews: {}, threads: [] }),
  ]));
  assert.deepEqual(groups.map((g) => g.id), ['drafts', 'recheck', 'waitingReview']);
});

test('rows sort by last update, newest first', () => {
  const groups = buildView(input([
    pr(1, { myReview: approved, threads: [], updatedAt: '2026-11-18T00:00:00Z' }),
    pr(2, { myReview: blocked, threads: [], updatedAt: '2026-11-20T00:00:00Z' }),
    pr(3, { myReview: blocked, threads: [], updatedAt: '2026-11-19T00:00:00Z' }),
  ]));
  assert.deepEqual(groups[0]!.rows.map((r) => (r.kind === 'pr' ? r.pr.number : 0)), [2, 3, 1]);
});

test('bold until read: any update newer than the read mark and the own last action', () => {
  const at = '2026-11-20T15:58:07Z';
  const base1 = { myReview: { ...blocked, at: '2026-11-20T13:34:53Z' }, threads: [], updatedAt: at };
  assert.equal(rows(input([pr(1, base1)]))[0]!.unseen, true);
  const key = 'zephyrproject-rtos/zephyr#1';
  assert.equal(rows(input([pr(1, base1)], { seen: { [key]: at } }))[0]!.unseen, false);
  assert.equal(rows(input([pr(1, { ...base1, updatedAt: '2026-11-20T16:10:00Z' })], { seen: { [key]: at } }))[0]!.unseen, true);
  assert.equal(rows(input([pr(1, base1)], { seen: { [key]: 'old|signature' } }))[0]!.unseen, true);
});

test('the viewer acting last leaves the row read', () => {
  const at = '2026-11-20T15:00:00Z';
  const reviewed = pr(1, { myReview: { ...blocked, at }, threads: [], updatedAt: at });
  assert.equal(rows(input([reviewed]))[0]!.unseen, false);
  const replied = pr(2, { myReview: null, updatedAt: at, threads: [{ resolved: false, outdated: false, path: 'a', line: 1, starter: 'x', lastAuthor: ME, lastAt: at, url: '' }] });
  assert.equal(rows(input([replied]))[0]!.unseen, false);
  const waiting = pr(3, { author: ME, ci: 'SUCCESS', mergeable: 'MERGEABLE', reviews: {}, threads: [], updatedAt: '2026-11-20T16:00:00Z', myReview: null });
  assert.equal(rows(input([waiting]))[0]!.unseen, true);
  assert.equal(rows(input([{ ...waiting, pushedAt: '2026-11-20T16:00:00Z' }]))[0]!.unseen, false);
});

test('ledger and sessions attach to their row', () => {
  const key = 'zephyrproject-rtos/zephyr#1';
  const ledger = { key, repo: 'zephyrproject-rtos/zephyr', number: 1, title: '', head: base.head, reviewedAt: null, counts: { open: 1, drafted: 0, posted: 0, fixed: 0, refuted: 0, moot: 0 }, active: 1, file: '/x.md' };
  const session = { id: 's', cwd: '/', first: '', last: '', skills: ['pr-rev'] };
  const [row] = rows(input([pr(1, { myReview: blocked, threads: [] })], {
    ledgers: new Map([[key, ledger]]),
    sessions: new Map([[key, [session]]]),
  }));
  assert.equal(row!.ledger, ledger);
  assert.deepEqual(row!.sessions, [session]);
  assert.equal(row!.bucket, 'waitingAuthor');
});

test('an issue is bold until read or until the viewer comments last', () => {
  const issue = normalizeIssue(JSON.parse(readFileSync(new URL('./fixtures/issue.raw.json', import.meta.url), 'utf8')));
  const key = 'zephyrproject-rtos/zephyr#126157';
  assert.equal(issueRow(issue, input([])).unseen, true);
  assert.equal(issueRow(issue, input([], { seen: { [key]: issue.updatedAt } })).unseen, false);
  assert.equal(issueRow({ ...issue, myLastCommentAt: issue.updatedAt }, input([])).unseen, false);
  assert.equal(issueRow({ ...issue, author: ME, myLastCommentAt: null, createdAt: issue.updatedAt }, input([])).unseen, false);
});

test('ago rounds to minutes, hours and days', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  assert.equal(ago('2026-11-20T11:59:50Z', now), '1m ago');
  assert.equal(ago('2026-11-20T09:00:00Z', now), '3h ago');
  assert.equal(ago('2026-11-17T12:00:00Z', now), '3d ago');
  assert.equal(ago(null, now), '');
});

import { moveGroup, orderGroups, type Group } from '../src/core/view.ts';

test('groups follow the saved order and unknown ones keep their place', () => {
  const g = (id: string): Group => ({ id, label: id, myTurn: false, rows: [] });
  const groups = [g('drafts'), g('mine'), g('review'), g('query:ESP32 issues')];
  assert.deepEqual(orderGroups(groups, []).map((x) => x.id), ['drafts', 'mine', 'review', 'query:ESP32 issues']);
  assert.deepEqual(orderGroups(groups, ['review', 'gone', 'drafts']).map((x) => x.id), ['review', 'drafts', 'mine', 'query:ESP32 issues']);
});

test('moving a group inserts it before another or at the end', () => {
  assert.deepEqual(moveGroup(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveGroup(['a', 'b', 'c'], 'a', undefined), ['b', 'c', 'a']);
  assert.deepEqual(moveGroup(['a', 'b'], 'x', 'b'), ['a', 'x', 'b']);
  assert.deepEqual(moveGroup(['a', 'b'], 'a', 'zzz'), ['b', 'a']);
});
