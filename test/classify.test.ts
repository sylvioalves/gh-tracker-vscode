import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { classify, sameCommit, type Context } from '../src/core/classify.ts';
import { normalize, type PullRequest, type Thread } from '../src/core/github.ts';

const base = normalize(JSON.parse(readFileSync(new URL('./fixtures/pr-114959.raw.json', import.meta.url), 'utf8')));
const HEAD = base.head;
const OLD = '19084de379697507dce3ef15c3672feb1a7b14a7';
const ME = 'sylvioalves';

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return { ...base, ...over };
}

function ctx(over: Partial<Context> = {}): Context {
  return { viewer: ME, roles: [], labels: ['platform: ESP32'], ...over };
}

function thread(over: Partial<Thread>): Thread {
  return { resolved: false, outdated: false, path: 'a.c', line: 1, starter: 'other', lastAuthor: 'other', lastAt: '2026-11-19T00:00:00Z', url: '', ...over };
}

test('live 114959: push past the review and two replies put it in re-check', () => {
  const c = classify(base, ctx({ roles: ['reviewed'] }));
  assert.equal(c.bucket, 'recheck');
  assert.equal(c.myTurn, true);
  assert.equal(c.priority, 1);
  assert.deepEqual(c.reasons.map((r) => r.text), ['new push since you requested changes', '2 new replies on threads']);
  assert.deepEqual(c.reasons.map((r) => r.short), ['pushed', '2 replies']);
  assert.equal(c.key, 'zephyrproject-rtos/zephyr#114959');
});

test('a ledger round at the current head counts as seen', () => {
  const c = classify(base, ctx({ ledger: { head: HEAD.slice(0, 12) } }));
  assert.deepEqual(c.reasons.map((r) => r.kind), ['replies']);
});

test('a ledger alone makes a pull request reviewed', () => {
  const c = classify(pr({ myReview: null }), ctx({ ledger: { head: 'ba600e769780' } }));
  assert.equal(c.bucket, 'recheck');
  assert.equal(c.reasons[0]!.text, 'new push since your ledger review');
});

test('marking checked hides it until the head moves or a newer reply comes', () => {
  const ack = { head: HEAD, replyAt: '2026-12-01T00:00:00Z' };
  assert.equal(classify(base, ctx({ ack })).bucket, 'waitingAuthor');
  assert.equal(classify(pr({ head: 'f'.repeat(40) }), ctx({ ack })).bucket, 'recheck');
  const newer = pr({ threads: [thread({ starter: ME, lastAt: '2026-12-02T00:00:00Z' })] });
  assert.deepEqual(classify(newer, ctx({ ack })).reasons.map((r) => r.kind), ['replies']);
});

test('a draft gets no push signal, replies still count', () => {
  const c = classify(pr({ draft: true }), ctx());
  assert.deepEqual(c.reasons.map((r) => r.kind), ['replies']);
});

test('on others pull requests only threads the viewer started count', () => {
  const c = classify(pr({ myReview: { state: 'APPROVED', at: '', commit: HEAD }, threads: [thread({})] }), ctx());
  assert.equal(c.bucket, 'waitingAuthor');
  assert.equal(c.priority, 9);
});

test('a push after an approval is a low priority re-check', () => {
  const c = classify(pr({ myReview: { state: 'APPROVED', at: '', commit: OLD }, threads: [] }), ctx());
  assert.equal(c.reasons[0]!.text, 'new push since your approval');
  assert.equal(c.priority, 5);
});

test('a pending review wins over everything else', () => {
  const c = classify(pr({ pendingReview: { id: 'x', at: '' } }), ctx());
  assert.equal(c.bucket, 'drafts');
  assert.equal(c.priority, 0);
});

test('closed and merged pull requests leave the turn lists', () => {
  assert.equal(classify(pr({ state: 'MERGED' }), ctx()).bucket, 'closed');
  assert.equal(classify(pr({ state: 'MERGED' }), ctx()).myTurn, false);
});

test('own pull request: CI, conflicts, current blocking review and replies', () => {
  const own = pr({
    author: ME,
    reviews: {
      stale: { state: 'CHANGES_REQUESTED', at: '', commit: OLD },
      fresh: { state: 'CHANGES_REQUESTED', at: '', commit: HEAD },
      [ME]: { state: 'COMMENTED', at: '', commit: HEAD },
    },
    threads: [thread({}), thread({ lastAuthor: ME }), thread({ resolved: true })],
  });
  const c = classify(own, ctx({ roles: ['author'] }));
  assert.equal(c.bucket, 'mine');
  assert.deepEqual(c.reasons.map((r) => r.text), ['CI failed', 'conflicts', 'changes requested by fresh', '1 new reply on a thread']);
});

test('own pull request with nothing to do waits on reviewers', () => {
  const own = pr({ author: ME, ci: 'SUCCESS', mergeable: 'MERGEABLE', reviews: {}, threads: [] });
  assert.equal(classify(own, ctx()).bucket, 'waitingReview');
  assert.equal(classify(pr({ author: ME }), ctx({ ack: { head: HEAD, replyAt: '9999' } })).bucket, 'waitingReview');
});

test('a kept own pull request stays in My PRs, also after Mark Checked', () => {
  const idle = pr({ author: ME, ci: 'SUCCESS', mergeable: 'MERGEABLE', reviews: {}, threads: [] });
  const kept = classify(idle, ctx({ kept: true }));
  assert.equal(kept.bucket, 'mine');
  assert.deepEqual(kept.reasons.map((r) => r.kind), ['kept']);
  const checked = classify(pr({ author: ME }), ctx({ kept: true, ack: { head: HEAD, replyAt: '9999' } }));
  assert.equal(checked.bucket, 'mine');
  assert.equal(checked.checked, true);
  assert.deepEqual(checked.reasons.map((r) => r.kind), ['kept']);
  assert.deepEqual(classify(pr({ author: ME }), ctx({ kept: true })).reasons.map((r) => r.kind), ['ci', 'conflicts', 'replies']);
});

test('keeping has no effect on others pull requests', () => {
  const other = pr({ myReview: null, threads: [], assignees: [], draft: false });
  assert.equal(classify(other, ctx({ kept: true })).bucket, 'other');
  assert.equal(classify(other, ctx({ kept: true })).own, false);
});

test('checked follows the head the mark was made on', () => {
  assert.equal(classify(pr(), ctx({ ack: { head: HEAD, replyAt: '' } })).checked, true);
  assert.equal(classify(pr(), ctx({ ack: { head: OLD, replyAt: '' } })).checked, false);
  assert.equal(classify(pr(), ctx()).checked, false);
});

test('first look: assignment, labelled request, pin, drafts left out', () => {
  const fresh = pr({ myReview: null, threads: [], assignees: [] });
  assert.equal(classify(pr({ myReview: null, assignees: ['SylvioAlves'] }), ctx()).reasons[0]!.text, 'assigned to you');
  const requested = classify(pr({ ...fresh, labels: ['platform: ESP32', 'area: Flash'] }), ctx({ roles: ['requested'] }));
  assert.equal(requested.bucket, 'review');
  assert.equal(requested.reasons[0]!.text, 'review requested (platform: ESP32)');
  assert.equal(classify(fresh, ctx({ roles: ['extra'] })).reasons[0]!.kind, 'pinned');
  assert.equal(classify({ ...fresh, draft: true }, ctx({ roles: ['requested'] })).bucket, 'other');
  assert.equal(classify(fresh, ctx()).bucket, 'other');
});

test('sameCommit matches prefixes of seven or more characters only', () => {
  assert.equal(sameCommit(HEAD, HEAD.slice(0, 7).toUpperCase()), true);
  assert.equal(sameCommit(HEAD, HEAD.slice(0, 6)), false);
  assert.equal(sameCommit(HEAD, null), false);
  assert.equal(sameCommit(HEAD, OLD), false);
});
