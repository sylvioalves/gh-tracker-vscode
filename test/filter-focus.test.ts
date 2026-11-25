import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventAt, queryFocus } from '../src/core/filter-focus.ts';

test('the qualifier naming the viewer picks the focus', () => {
  assert.equal(queryFocus('is:open mentions:@me', 'Me'), 'mentioned');
  assert.equal(queryFocus('mentions:me', 'me'), 'mentioned');
  assert.equal(queryFocus('review-requested:ME is:pr', 'me'), 'requested');
  assert.equal(queryFocus('assignee:@me', 'me'), 'assigned');
  assert.equal(queryFocus('author:me repo:a/b', 'me'), 'authored');
  assert.equal(queryFocus('assignee:@me mentions:@me', 'me'), 'mentioned');
});

test('other users, negations and plain queries keep the last update', () => {
  assert.equal(queryFocus('mentions:someone', 'me'), 'activity');
  assert.equal(queryFocus('-mentions:@me is:open', 'me'), 'activity');
  assert.equal(queryFocus('repo:a/b label:"mentions:@me"', 'me'), 'activity');
  assert.equal(queryFocus('', 'me'), 'activity');
});

const node = {
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-11-25T00:00:00Z',
  timelineItems: { nodes: [
    { createdAt: '2026-03-01T00:00:00Z', actor: { login: 'Me' } },
    { createdAt: '2026-05-01T00:00:00Z', actor: { login: 'other' } },
    { createdAt: '2026-04-01T00:00:00Z', actor: { login: 'me' } },
    {},
  ] },
};

test('the event time is the latest timeline event naming the viewer', () => {
  assert.equal(eventAt('mentioned', node, 'me'), '2026-04-01T00:00:00Z');
  const assigned = { ...node, timelineItems: { nodes: [{ createdAt: '2026-02-02T00:00:00Z', assignee: { login: 'me' } }] } };
  assert.equal(eventAt('assigned', assigned, 'me'), '2026-02-02T00:00:00Z');
  const requested = { ...node, timelineItems: { nodes: [{ createdAt: '2026-02-03T00:00:00Z', requestedReviewer: { login: 'me' } }] } };
  assert.equal(eventAt('requested', requested, 'me'), '2026-02-03T00:00:00Z');
});

test('without a matching event the creation time is used', () => {
  assert.equal(eventAt('mentioned', { ...node, timelineItems: { nodes: [] } }, 'me'), '2026-01-01T00:00:00Z');
  assert.equal(eventAt('assigned', node, 'me'), '2026-01-01T00:00:00Z');
  assert.equal(eventAt('authored', node, 'me'), '2026-01-01T00:00:00Z');
  assert.equal(eventAt('activity', node, 'me'), '2026-11-25T00:00:00Z');
});
