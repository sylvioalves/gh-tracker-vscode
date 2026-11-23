import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { normalize, normalizeIssue, type Snapshot } from '../src/core/github.ts';
import { panelData } from '../src/core/panel-data.ts';
import { buildView } from '../src/core/view.ts';

const pr = normalize(JSON.parse(readFileSync(new URL('./fixtures/pr-114959.raw.json', import.meta.url), 'utf8')));
const key = 'zephyrproject-rtos/zephyr#114959';
const snapshot: Snapshot = { viewer: 'sylvioalves', fetchedAt: '', prs: [pr], roles: { [key]: ['reviewed'] }, rateRemaining: null };
const ledger = {
  key, repo: 'zephyrproject-rtos/zephyr', number: 114959, title: '', head: 'ba600e769780', reviewedAt: '2026-11-19',
  counts: { open: 20, drafted: 2, posted: 0, fixed: 6, refuted: 1, moot: 0 }, active: 22, file: '/x.md',
};
const live = { id: 'a', cwd: '/w', first: '2026-11-20T10:00:00Z', last: '2026-11-20T11:00:00Z', skills: ['pr-rev', 'fresh'] };
const gone = { ...live, id: 'b', last: '2026-10-01T00:00:00Z' };

function build(pinned = false) {
  const groups = buildView({
    snapshot, ledgers: new Map([[key, ledger]]), sessions: new Map([[key, [live, gone]]]), acks: {}, seen: {}, labels: [],
  });
  return panelData(groups, { expired: (s) => s.id === 'b', pinned: () => pinned });
}

test('a row carries what the card draws', () => {
  const [group] = build();
  const row = group!.rows[0]!;
  assert.equal(group!.id, 'recheck');
  assert.equal(row.repo, 'zephyr');
  assert.equal(row.number, 114959);
  assert.equal(row.icon, 'git-commit');
  assert.deepEqual(row.reasons.map((r) => r.short), ['pushed', '2 replies']);
  assert.deepEqual(row.ledger, { active: 22, head: 'ba600e7', reviewedAt: '2026-11-19', counts: '20 open, 2 drafted, 6 fixed, 1 refuted', mismatch: true });
  assert.deepEqual(row.sessions.map((s) => [s.id, s.expired]), [['a', false], ['b', true]]);
  assert.match(row.tooltip, /^zephyrproject-rtos\/zephyr#114959 /);
  assert.match(row.tooltip, /- new push since you requested changes/);
});

test('the author trust reaches the card and the tooltip', () => {
  const row = build()[0]!.rows[0]!;
  assert.equal(row.authorTrust, 'unknown');
  assert.match(row.tooltip, /\nby almir-okato into /);
  const fresh: Snapshot = { ...snapshot, prs: [{ ...pr, authorAssociation: 'FIRST_TIME_CONTRIBUTOR' }] };
  const groups = buildView({ snapshot: fresh, ledgers: new Map(), sessions: new Map(), acks: {}, seen: {}, labels: [] });
  const card = panelData(groups, { expired: () => false, pinned: () => false })[0]!.rows[0]!;
  assert.equal(card.authorTrust, 'new');
  assert.match(card.tooltip, /\nby almir-okato \(first-time contributor\) into /);
});

test('the menu key lists what the context menu may offer', () => {
  assert.equal(build()[0]!.rows[0]!.menu, 'pr myturn ledger session');
  assert.equal(build(true)[0]!.rows[0]!.menu, 'pr myturn ledger session pinned');
});

const issue = normalizeIssue(JSON.parse(readFileSync(new URL('./fixtures/issue.raw.json', import.meta.url), 'utf8')));

function buildQueries(over: Partial<typeof issue> = {}) {
  const snap: Snapshot = {
    ...snapshot,
    queries: [{ name: 'ESP32 issues', prs: [{ ...pr, updatedAt: '2026-11-21T09:00:00Z' }], issues: [{ ...issue, ...over }] }],
  };
  const groups = buildView({ snapshot: snap, ledgers: new Map(), sessions: new Map(), acks: {}, seen: {}, labels: [] });
  return panelData(groups, { expired: () => false, pinned: () => false });
}

test('a custom query is its own group after the pull request groups', () => {
  const groups = buildQueries();
  assert.deepEqual(groups.map((g) => g.id), ['recheck', 'query:ESP32 issues']);
  const q = groups[1]!;
  assert.equal(q.label, 'ESP32 issues');
  assert.equal(q.myTurn, false);
  assert.deepEqual(q.rows.map((r) => [r.kind, r.number]), [['issue', 126157], ['pr', 114959]]);
  assert.equal(q.rows[1]!.menu, 'pr myturn');
});

test('an issue row carries its chips, icon and menu token', () => {
  const row = buildQueries()[1]!.rows[0]!;
  assert.equal(row.key, 'zephyrproject-rtos/zephyr#126157');
  assert.equal(row.repo, 'zephyr');
  assert.equal(row.icon, 'issues');
  assert.equal(row.menu, 'issue');
  assert.equal(row.myTurn, false);
  assert.equal(row.unseen, true);
  assert.deepEqual(row.reasons.map((r) => r.short), ['4 comments', 'assigned', 'new reply']);
  assert.match(row.tooltip, /^zephyrproject-rtos\/zephyr#126157 /);
});

test('an issue reply only counts when the viewer spoke before it', () => {
  const last = { author: 'reporter', at: '2026-11-21T10:30:00Z', url: '' };
  const quiet = buildQueries({ assignees: [], myLastCommentAt: null, comments: 1, lastComment: last })[1]!.rows[0]!;
  assert.deepEqual(quiet.reasons.map((r) => r.short), ['1 comment']);
  const mine = buildQueries({ lastComment: { ...last, author: 'sylvioalves' }, myLastCommentAt: last.at, state: 'CLOSED' })[1]!.rows[0]!;
  assert.deepEqual(mine.reasons.map((r) => r.short), ['4 comments', 'assigned']);
  assert.equal(mine.icon, 'issue-closed');
  assert.equal(mine.unseen, false);
});
