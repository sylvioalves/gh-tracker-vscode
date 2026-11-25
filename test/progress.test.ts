import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fetchQueries, fetchSnapshot, type Gql } from '../src/core/github.ts';
import { groupProgress, overallProgress } from '../src/core/panel-data.ts';
import { PRS_KEY, Progress, queryKey } from '../src/core/progress.ts';

const raw = JSON.parse(readFileSync(new URL('./fixtures/pr-114959.raw.json', import.meta.url), 'utf8'));
const rawIssue = JSON.parse(readFileSync(new URL('./fixtures/issue.raw.json', import.meta.url), 'utf8'));

test('phases weigh in once planned and empty phases count as done', () => {
  const p = new Progress();
  p.plan('a', 'search', 2);
  assert.deepEqual(p.percent(), { a: 0 });
  p.tick('a', 'search');
  assert.deepEqual(p.percent(), { a: 10 });
  p.tick('a', 'search', 5);
  p.plan('a', 'detail', 0);
  assert.deepEqual(p.percent(), { a: 70 });
  p.plan('a', 'finish', 4);
  p.tick('a', 'finish', 2);
  assert.deepEqual(p.percent(), { a: 85 });
  p.tick('missing', 'finish');
  assert.deepEqual(p.percent(), { a: 85 });
});

test('groups map to their progress key and the overall is the mean', () => {
  const progress = { [PRS_KEY]: 40, [queryKey('Mentioned')]: 80 };
  assert.equal(groupProgress('review', progress), 40);
  assert.equal(groupProgress(queryKey('Mentioned'), progress), 80);
  assert.equal(groupProgress(queryKey('Other'), progress), undefined);
  assert.equal(groupProgress('review', null), undefined);
  assert.equal(overallProgress(progress), 60);
  assert.equal(overallProgress({}), undefined);
});

function fake(): Gql {
  return async (query, vars = {}) => {
    if (query.includes('rateLimit')) {
      return { viewer: { login: 'sylvioalves' }, rateLimit: { remaining: 1 } };
    }
    if (query.includes('... on Issue {') && query.includes('search(')) {
      return { search: { pageInfo: { hasNextPage: false }, nodes: [{ ...rawIssue, id: 'I1', number: 1 }, { __typename: 'PullRequest', id: 'P' }] } };
    }
    if (query.includes('search(')) {
      const own = (vars.q as string).startsWith('is:pr is:open author:');
      return { search: { pageInfo: { hasNextPage: false }, nodes: own ? [{ id: 'A' }, { id: 'B' }] : [] } };
    }
    return { nodes: (vars.ids as string[]).map((id) => ({ ...raw, id, createdAt: '2026-01-01T00:00:00Z', timelineItems: { nodes: [] } })) };
  };
}

test('every group of a full refresh climbs to 100 without going back', async () => {
  const seen = new Map<string, number[]>();
  const progress = new Progress((p) => {
    for (const [k, v] of Object.entries(p)) {
      seen.set(k, [...(seen.get(k) ?? []), v]);
    }
  });
  await fetchSnapshot(fake(), { repos: ['o/r'], labels: [], extra: [], queries: [{ name: 'Mentioned', query: 'mentions:@me' }] }, progress);
  assert.deepEqual(progress.percent(), { [PRS_KEY]: 100, [queryKey('Mentioned')]: 100 });
  for (const [key, values] of seen) {
    assert.deepEqual(values, [...values].sort((a, b) => a - b), key);
  }
});

test('a filters-only fetch reports only the filters it fetches', async () => {
  const progress = new Progress();
  await fetchQueries(fake(), 'sylvioalves', [{ name: 'Plain', query: 'repo:o/r' }], null, progress);
  assert.deepEqual(progress.percent(), { [queryKey('Plain')]: 100 });
});
