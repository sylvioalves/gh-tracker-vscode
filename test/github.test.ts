import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { authorTrust, customQueries, fetchSnapshot, GithubError, normalize, normalizeIssue, repoLabels, searches, searchPreview, type Gql } from '../src/core/github.ts';

const raw = JSON.parse(readFileSync(new URL('./fixtures/pr-114959.raw.json', import.meta.url), 'utf8'));
const rawIssue = JSON.parse(readFileSync(new URL('./fixtures/issue.raw.json', import.meta.url), 'utf8'));

test('normalize keeps the fields the rules need', () => {
  const pr = normalize(raw);
  assert.equal(pr.repo, 'zephyrproject-rtos/zephyr');
  assert.equal(pr.number, 114959);
  assert.equal(pr.author, 'almir-okato');
  assert.equal(pr.head, '981e9c00ff81352868059be0b2c966c1f75133c4');
  assert.equal(pr.pushedAt, '2026-11-19T19:23:49Z');
  assert.equal(pr.ci, 'FAILURE');
  assert.equal(pr.mergeable, 'CONFLICTING');
  assert.deepEqual(pr.myReview, {
    state: 'CHANGES_REQUESTED',
    at: '2026-11-18T14:00:37Z',
    commit: '19084de379697507dce3ef15c3672feb1a7b14a7',
  });
  assert.equal(pr.pendingReview, null);
  assert.equal(pr.threads.length, 49);
  const open = pr.threads.filter((t) => !t.resolved);
  assert.equal(open.length, 2);
  assert.ok(open.every((t) => t.starter === 'sylvioalves' && t.lastAuthor === 'almir-okato'));
});

test('normalize survives deleted accounts and missing commits', () => {
  const pr = normalize({ ...raw, author: null, commits: { nodes: [] }, pushes: { nodes: [] }, myReviews: { nodes: [] } });
  assert.equal(pr.author, 'ghost');
  assert.equal(pr.ci, null);
  assert.equal(pr.pushedAt, null);
  assert.equal(pr.myReview, null);
});

test('the author association maps to a trust level', () => {
  assert.equal(normalize(raw).authorAssociation, '');
  assert.equal(normalize({ ...raw, authorAssociation: 'MEMBER' }).authorAssociation, 'MEMBER');
  assert.equal(normalizeIssue({ ...rawIssue, authorAssociation: 'NONE' }).authorAssociation, 'NONE');
  for (const [assoc, trust] of [['MEMBER', 'trusted'], ['OWNER', 'trusted'], ['COLLABORATOR', 'trusted'], ['CONTRIBUTOR', 'known'],
    ['FIRST_TIME_CONTRIBUTOR', 'new'], ['FIRST_TIMER', 'new'], ['NONE', 'new'], ['MANNEQUIN', 'new'], ['', 'unknown'], [undefined, 'unknown']]) {
    assert.equal(authorTrust(assoc), trust, String(assoc));
  }
});

test('searches cover each role and every watched label', () => {
  const list = searches({ repos: ['a/b', 'c/d'], labels: ['platform: ESP32', 'area: "x"'], extra: [] });
  assert.deepEqual(list.map((s) => s.role), ['author', 'assigned', 'reviewed', 'requested', 'requested']);
  assert.ok(list.every((s) => s.q.endsWith(' repo:a/b repo:c/d')));
  assert.match(list[3]!.q, /label:"platform: ESP32"/);
  assert.match(list[4]!.q, /label:"area: x"/);
});

test('searches refuse a query GitHub would reject', () => {
  const repos = Array.from({ length: 20 }, (_, i) => `some-long-owner/repository-${i}`);
  assert.throws(() => searches({ repos, labels: [], extra: [] }), /longer than 256/);
});

test('fetchSnapshot merges roles, follows pages and resolves extra PRs', async () => {
  const pages: Record<string, { ids: string[]; next?: string }[]> = {
    author: [{ ids: ['A'] }],
    assigned: [{ ids: ['B'], next: 'c1' }, { ids: ['C'] }],
    reviewed: [{ ids: ['B'] }],
  };
  const detailCalls: string[][] = [];
  const gql: Gql = async (query, vars = {}) => {
    if (query.includes('rateLimit')) {
      return { viewer: { login: 'me' }, rateLimit: { remaining: 42 } };
    }
    if (query.includes('search(')) {
      const q = vars.q as string;
      const role = q.startsWith('is:pr is:open author:') ? 'author' : (q.includes('assignee:') ? 'assigned' : 'reviewed');
      const page = pages[role]?.[vars.after ? 1 : 0] ?? { ids: [] };
      return { search: { pageInfo: { hasNextPage: Boolean(page.next), endCursor: page.next ?? null }, nodes: page.ids.map((id) => ({ id })) } };
    }
    if (query.includes('pullRequest(number')) {
      return { r0: { pullRequest: { id: 'D' } } };
    }
    const ids = vars.ids as string[];
    detailCalls.push(ids);
    return { nodes: ids.map((id, i) => ({ ...raw, id, number: 1000 + id.charCodeAt(0) + i })) };
  };
  const snap = await fetchSnapshot(gql, { repos: ['zephyrproject-rtos/zephyr'], labels: [], extra: [{ repo: 'x/y', number: 7 }] });
  assert.equal(snap.viewer, 'me');
  assert.equal(snap.rateRemaining, 42);
  assert.equal(snap.prs.length, 4);
  assert.deepEqual(detailCalls.flat().sort(), ['A', 'B', 'C', 'D']);
  const rolesOf = (id: string): string[] => snap.roles[`zephyrproject-rtos/zephyr#${1000 + id.charCodeAt(0) + detailCalls[0]!.indexOf(id)}`]!.sort();
  assert.deepEqual(rolesOf('B'), ['assigned', 'reviewed']);
  assert.deepEqual(rolesOf('D'), ['extra']);
});

test('a detail batch that times out is split until it fits', async () => {
  const sizes: number[] = [];
  const ids = Array.from({ length: 10 }, (_, i) => `N${i}`);
  const gql: Gql = async (query, vars = {}) => {
    if (query.includes('rateLimit')) {
      return { viewer: { login: 'me' }, rateLimit: { remaining: 1 } };
    }
    if (query.includes('search(')) {
      return { search: { pageInfo: { hasNextPage: false }, nodes: (vars.q as string).includes('author:@me repo') ? ids.map((id) => ({ id })) : [] } };
    }
    const batch = vars.ids as string[];
    sizes.push(batch.length);
    if (batch.length > 3) {
      throw new GithubError(504, 'timeout');
    }
    return { nodes: batch.map((id) => ({ ...raw, id, number: Number(id.slice(1)) })) };
  };
  const snap = await fetchSnapshot(gql, { repos: ['o/r'], labels: [], extra: [] });
  assert.deepEqual(snap.prs.map((p) => p.number).sort(), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(sizes, [10, 5, 3, 2, 5, 3, 2]);
});

test('a client error is not retried by splitting', async () => {
  const gql: Gql = async (query) => {
    if (query.includes('rateLimit')) {
      return { viewer: { login: 'me' }, rateLimit: { remaining: 1 } };
    }
    if (query.includes('search(')) {
      return { search: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'A' }, { id: 'B' }] } };
    }
    throw new GithubError(401, 'bad token');
  };
  await assert.rejects(fetchSnapshot(gql, { repos: ['o/r'], labels: [], extra: [] }), /bad token/);
});

test('normalizeIssue keeps the last comment and the viewer last comment', () => {
  const issue = normalizeIssue(rawIssue);
  assert.equal(issue.repo, 'zephyrproject-rtos/zephyr');
  assert.equal(issue.number, 126157);
  assert.equal(issue.author, 'reporter');
  assert.equal(issue.state, 'OPEN');
  assert.deepEqual(issue.labels, ['bug', 'platform: ESP32']);
  assert.deepEqual(issue.assignees, ['sylvioalves']);
  assert.equal(issue.comments, 4);
  assert.deepEqual(issue.lastComment, {
    author: 'reporter',
    at: '2026-11-21T10:30:00Z',
    url: 'https://github.com/zephyrproject-rtos/zephyr/issues/126157#issuecomment-4',
  });
  assert.equal(issue.myLastCommentAt, '2026-11-20T08:00:00Z');
});

test('normalizeIssue survives no comments and deleted accounts', () => {
  const issue = normalizeIssue({ ...rawIssue, author: null, comments: { totalCount: 0, nodes: [] } });
  assert.equal(issue.author, 'ghost');
  assert.equal(issue.comments, 0);
  assert.equal(issue.lastComment, null);
  assert.equal(issue.myLastCommentAt, null);
});

test('customQueries keeps named queries once and drops broken entries', () => {
  const list = customQueries([
    { name: 'ESP32 issues', query: 'is:issue label:"platform: ESP32"' },
    { name: ' ESP32 issues ', query: 'is:issue' },
    { name: '', query: 'is:issue' },
    { name: 'no query' },
    'junk',
    null,
    { name: 'Mine', query: ' author:@me ' },
  ]);
  assert.deepEqual(list, [
    { name: 'ESP32 issues', query: 'is:issue label:"platform: ESP32"' },
    { name: 'Mine', query: 'author:@me' },
  ]);
  assert.deepEqual(customQueries(undefined), []);
});

test('fetchSnapshot groups custom query results by name', async () => {
  const detailIds: string[] = [];
  const asked: string[] = [];
  const gql: Gql = async (query, vars = {}) => {
    if (query.includes('rateLimit')) {
      return { viewer: { login: 'me' }, rateLimit: { remaining: 1 } };
    }
    if (query.includes('... on Issue')) {
      const q = vars.q as string;
      asked.push(q);
      if (q === 'issues q') {
        const page = vars.after
          ? [{ ...rawIssue, id: 'I2', number: 2 }]
          : [{ ...rawIssue, id: 'I1', number: 1 }, { __typename: 'PullRequest', id: 'A' }];
        return { search: { pageInfo: { hasNextPage: !vars.after, endCursor: vars.after ? null : 'c1' }, nodes: page } };
      }
      return { search: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: 'PullRequest', id: 'Q' }] } };
    }
    if (query.includes('search(')) {
      const own = (vars.q as string).startsWith('is:pr is:open author:');
      return { search: { pageInfo: { hasNextPage: false }, nodes: own ? [{ id: 'A' }] : [] } };
    }
    const ids = vars.ids as string[];
    detailIds.push(...ids);
    return { nodes: ids.map((id) => ({ ...raw, id, number: id === 'A' ? 10 : 20 })) };
  };
  const snap = await fetchSnapshot(gql, {
    repos: ['o/r'], labels: [], extra: [],
    queries: [{ name: 'Issues', query: 'issues q' }, { name: 'Other', query: 'other q' }],
  });
  assert.deepEqual(asked, ['issues q', 'issues q', 'other q']);
  assert.deepEqual(detailIds.sort(), ['A', 'Q']);
  assert.deepEqual(snap.prs.map((p) => p.id), ['A']);
  assert.deepEqual(snap.queries?.map((q) => q.name), ['Issues', 'Other']);
  const [issues, other] = snap.queries!;
  assert.deepEqual(issues!.issues.map((i) => i.number), [1, 2]);
  assert.deepEqual(issues!.prs.map((p) => p.number), [10]);
  assert.deepEqual(other!.issues, []);
  assert.deepEqual(other!.prs.map((p) => p.number), [20]);
});

test('repoLabels follows label pages', async () => {
  const calls: unknown[] = [];
  const gql: Gql = async (_query, vars = {}) => {
    calls.push(vars);
    const first = vars.after === null;
    return {
      repository: {
        labels: {
          nodes: first ? [{ name: 'bug', color: 'd73a4a' }, null] : [{ name: 'platform: ESP32', color: '0e8a16' }],
          pageInfo: { hasNextPage: first, endCursor: first ? 'c1' : null },
        },
      },
    };
  };
  assert.deepEqual(await repoLabels(gql, 'o/r'), [{ name: 'bug', color: 'd73a4a' }, { name: 'platform: ESP32', color: '0e8a16' }]);
  assert.deepEqual(calls, [{ owner: 'o', name: 'r', after: null }, { owner: 'o', name: 'r', after: 'c1' }]);
  await assert.rejects(repoLabels(gql, 'nope'), /owner\/name/);
  await assert.rejects(repoLabels(async () => ({ repository: null }), 'o/r'), /not found/);
});

test('searchPreview keeps the count and the issue or pull request nodes', async () => {
  const gql: Gql = async (_query, vars = {}) => {
    assert.equal(vars.q, 'repo:o/r is:open');
    return { search: { issueCount: 42, nodes: [{ number: 1, title: 'a', url: 'u1' }, {}, { number: 2, title: 'b', url: 'u2' }] } };
  };
  assert.deepEqual(await searchPreview(gql, 'repo:o/r is:open'), {
    count: 42, items: [{ number: 1, title: 'a', url: 'u1' }, { number: 2, title: 'b', url: 'u2' }],
  });
});
