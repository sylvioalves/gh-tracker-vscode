export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<any>;

export class GithubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const ENDPOINT = 'https://api.github.com/graphql';
const TIMEOUT_MS = 60_000;
const SEARCH_PAGE = 100;
const SEARCH_PAGES_MAX = 5;
const DETAIL_BATCH = 10;
const DETAIL_PARALLEL = 3;
const ITEM_PAGE = 50;
const ITEM_PAGES_MAX = 2;
const QUERY_MAX = 256;

export function httpGql(token: string, fetchImpl: typeof fetch = fetch): Gql {
  return async (query, variables = {}) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'ghtracker',
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 500 && attempt === 0) {
        continue;
      }
      if (!res.ok) {
        throw new GithubError(res.status, `GitHub answered HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
      if (body.errors && body.errors.length > 0) {
        throw new GithubError(200, body.errors.map((e) => e.message).join('; '));
      }
      return body.data;
    }
  };
}

export type Ci = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED' | null;

export interface Review {
  state: string;
  at: string;
  commit: string | null;
}

export interface Thread {
  resolved: boolean;
  outdated: boolean;
  path: string;
  line: number | null;
  starter: string;
  lastAuthor: string;
  lastAt: string;
  url: string;
}

/* How GitHub relates the author to the repository: members and
 * collaborators are trusted, contributors are known, first-timers and
 * outsiders are new. Unknown when the snapshot predates the field.
 */
export type AuthorTrust = 'trusted' | 'known' | 'new' | 'unknown';

export interface PullRequest {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAssociation: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft: boolean;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: string | null;
  ci: Ci;
  head: string;
  pushedAt: string | null;
  base: string;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  labels: string[];
  assignees: string[];
  requested: string[];
  reviews: Record<string, Review>;
  myReview: Review | null;
  pendingReview: { id: string; at: string } | null;
  threads: Thread[];
}

export interface Comment {
  author: string;
  at: string;
  url: string;
}

export interface Issue {
  id: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAssociation: string;
  state: 'OPEN' | 'CLOSED';
  createdAt: string;
  updatedAt: string;
  labels: string[];
  assignees: string[];
  comments: number;
  lastComment: Comment | null;
  myLastCommentAt: string | null;
}

export type Role = 'author' | 'assigned' | 'requested' | 'reviewed' | 'extra';

export interface PrRef {
  repo: string;
  number: number;
}

export interface CustomQuery {
  name: string;
  query: string;
}

export interface Plan {
  repos: string[];
  labels: string[];
  extra: PrRef[];
  queries?: CustomQuery[];
}

export interface QueryResult {
  name: string;
  prs: PullRequest[];
  issues: Issue[];
}

export interface Snapshot {
  viewer: string;
  fetchedAt: string;
  prs: PullRequest[];
  roles: Record<string, Role[]>;
  rateRemaining: number | null;
  queries?: QueryResult[];
}

export function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

const PR_FIELDS = `
  id number title url state isDraft mergeable reviewDecision headRefOid
  baseRefName createdAt updatedAt additions deletions changedFiles
  authorAssociation
  author { login }
  repository { nameWithOwner }
  assignees(first: 20) { nodes { login } }
  labels(first: 20) { nodes { name } }
  reviewRequests(first: 30) { nodes { requestedReviewer {
    __typename ... on User { login } ... on Team { name } } } }
  latestReviews(first: 30) { nodes { author { login } state submittedAt commit { oid } } }
  myReviews: reviews(author: $me, last: 1, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) {
    nodes { state submittedAt commit { oid } } }
  pending: reviews(author: $me, first: 1, states: [PENDING]) { nodes { id createdAt } }
  commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state } } } }
  pushes: timelineItems(last: 1, itemTypes: [HEAD_REF_FORCE_PUSHED_EVENT]) {
    nodes { ... on HeadRefForcePushedEvent { createdAt } } }
  reviewThreads(last: 100) { nodes {
    isResolved isOutdated path line
    first: comments(first: 1) { nodes { author { login } } }
    last: comments(last: 1) { nodes { author { login } createdAt url } } } }
`;

const DETAIL_QUERY = `query($ids: [ID!]!, $me: String!) {
  nodes(ids: $ids) { ... on PullRequest { ${PR_FIELDS} } }
}`;

const SEARCH_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${SEARCH_PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { id } }
  }
}`;

const ISSUE_FIELDS = `
  id number title url state createdAt updatedAt authorAssociation
  author { login }
  repository { nameWithOwner }
  assignees(first: 20) { nodes { login } }
  labels(first: 20) { nodes { name } }
  comments(last: 30) { totalCount nodes { author { login } createdAt url viewerDidAuthor } }
`;

const ITEM_SEARCH_QUERY = `query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: ${ITEM_PAGE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { __typename ... on PullRequest { id } ... on Issue { ${ISSUE_FIELDS} } }
  }
}`;

const VIEWER_QUERY = 'query { viewer { login } rateLimit { remaining } }';

function login(actor: { login?: string } | null | undefined): string {
  return actor?.login ?? 'ghost';
}

const TRUSTED = ['MEMBER', 'OWNER', 'COLLABORATOR'];
const NEW = ['FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE', 'MANNEQUIN'];

export function authorTrust(association: string | null | undefined): AuthorTrust {
  if (!association) {
    return 'unknown';
  }
  if (TRUSTED.includes(association)) {
    return 'trusted';
  }
  return NEW.includes(association) ? 'new' : 'known';
}

function toReview(node: any): Review | null {
  if (!node) {
    return null;
  }
  return { state: node.state, at: node.submittedAt ?? '', commit: node.commit?.oid ?? null };
}

export function normalize(node: any): PullRequest {
  const commit = node.commits?.nodes?.[0]?.commit;
  const reviews: Record<string, Review> = {};
  for (const r of node.latestReviews?.nodes ?? []) {
    const review = toReview(r);
    if (review) {
      reviews[login(r.author)] = review;
    }
  }
  const requested: string[] = [];
  for (const r of node.reviewRequests?.nodes ?? []) {
    const who = r.requestedReviewer;
    if (who?.login) {
      requested.push(who.login);
    } else if (who?.name) {
      requested.push(`team ${who.name}`);
    }
  }
  const threads: Thread[] = [];
  for (const t of node.reviewThreads?.nodes ?? []) {
    const last = t.last?.nodes?.[0];
    threads.push({
      resolved: Boolean(t.isResolved),
      outdated: Boolean(t.isOutdated),
      path: t.path ?? '',
      line: t.line ?? null,
      starter: login(t.first?.nodes?.[0]?.author),
      lastAuthor: login(last?.author),
      lastAt: last?.createdAt ?? '',
      url: last?.url ?? '',
    });
  }
  const pending = node.pending?.nodes?.[0];
  return {
    id: node.id,
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author: login(node.author),
    authorAssociation: node.authorAssociation ?? '',
    state: node.state,
    draft: Boolean(node.isDraft),
    mergeable: node.mergeable,
    reviewDecision: node.reviewDecision ?? null,
    ci: commit?.statusCheckRollup?.state ?? null,
    head: node.headRefOid,
    pushedAt: node.pushes?.nodes?.[0]?.createdAt ?? commit?.committedDate ?? null,
    base: node.baseRefName,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions,
    deletions: node.deletions,
    changedFiles: node.changedFiles,
    labels: (node.labels?.nodes ?? []).map((l: any) => l.name),
    assignees: (node.assignees?.nodes ?? []).map((a: any) => a.login),
    requested,
    reviews,
    myReview: toReview(node.myReviews?.nodes?.[0]),
    pendingReview: pending ? { id: pending.id, at: pending.createdAt } : null,
    threads,
  };
}

export function normalizeIssue(node: any): Issue {
  const comments: any[] = node.comments?.nodes ?? [];
  const last = comments[comments.length - 1];
  const mine = comments.findLast((c) => c?.viewerDidAuthor);
  return {
    id: node.id,
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author: login(node.author),
    authorAssociation: node.authorAssociation ?? '',
    state: node.state,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    labels: (node.labels?.nodes ?? []).map((l: any) => l.name),
    assignees: (node.assignees?.nodes ?? []).map((a: any) => a.login),
    comments: node.comments?.totalCount ?? comments.length,
    lastComment: last ? { author: login(last.author), at: last.createdAt ?? '', url: last.url ?? '' } : null,
    myLastCommentAt: mine?.createdAt ?? null,
  };
}

/* Valid entries of the ghtracker.queries setting, first one wins on a
 * repeated name.
 */
export function customQueries(raw: unknown): CustomQuery[] {
  const out: CustomQuery[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    const query = typeof entry?.query === 'string' ? entry.query.trim() : '';
    if (name && query && !out.some((q) => q.name === name)) {
      out.push({ name, query });
    }
  }
  return out;
}

export function searches(plan: Plan): { role: Role; q: string }[] {
  const scope = plan.repos.map((r) => ` repo:${r}`).join('');
  const out: { role: Role; q: string }[] = [
    { role: 'author', q: `is:pr is:open author:@me${scope}` },
    { role: 'assigned', q: `is:pr is:open assignee:@me -author:@me${scope}` },
    { role: 'reviewed', q: `is:pr is:open reviewed-by:@me -author:@me${scope}` },
  ];
  for (const label of plan.labels) {
    const name = label.replace(/"/g, '');
    out.push({ role: 'requested', q: `is:pr is:open user-review-requested:@me -author:@me label:"${name}"${scope}` });
  }
  for (const s of out) {
    if (s.q.length > QUERY_MAX) {
      throw new Error(`search query longer than ${QUERY_MAX} characters, track fewer repositories`);
    }
  }
  return out;
}

async function searchIds(gql: Gql, q: string): Promise<string[]> {
  const ids: string[] = [];
  let after: string | null = null;
  for (let page = 0; page < SEARCH_PAGES_MAX; page++) {
    const data = await gql(SEARCH_QUERY, { q, after });
    for (const n of data.search.nodes) {
      if (n?.id) {
        ids.push(n.id);
      }
    }
    if (!data.search.pageInfo.hasNextPage) {
      break;
    }
    after = data.search.pageInfo.endCursor;
  }
  return ids;
}

async function searchItems(gql: Gql, q: string): Promise<{ prIds: string[]; issues: Issue[] }> {
  const prIds: string[] = [];
  const issues: Issue[] = [];
  let after: string | null = null;
  for (let page = 0; page < ITEM_PAGES_MAX; page++) {
    const data = await gql(ITEM_SEARCH_QUERY, { q, after });
    for (const n of data.search.nodes) {
      if (n?.__typename === 'PullRequest' && n.id) {
        prIds.push(n.id);
      } else if (n?.__typename === 'Issue' && n.id) {
        issues.push(normalizeIssue(n));
      }
    }
    if (!data.search.pageInfo.hasNextPage) {
      break;
    }
    after = data.search.pageInfo.endCursor;
  }
  return { prIds, issues };
}

async function resolveRefs(gql: Gql, refs: PrRef[]): Promise<string[]> {
  if (refs.length === 0) {
    return [];
  }
  const parts = refs.map((r, i) => {
    const [owner, name] = r.repo.split('/');
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      pullRequest(number: ${Number(r.number)}) { id } }`;
  });
  const data = await gql(`query { ${parts.join('\n')} }`);
  return refs.map((_, i) => data[`r${i}`]?.pullRequest?.id).filter((id): id is string => Boolean(id));
}

/* GitHub times out on large documents: a batch that fails with a
 * server error is split in halves until single pull requests remain.
 */
async function detail(gql: Gql, ids: string[], me: string): Promise<any[]> {
  try {
    const data = await gql(DETAIL_QUERY, { ids, me });
    return data.nodes;
  } catch (err) {
    if (!(err instanceof GithubError) || err.status < 500 || ids.length === 1) {
      throw err;
    }
    const half = Math.ceil(ids.length / 2);
    return [...await detail(gql, ids.slice(0, half), me), ...await detail(gql, ids.slice(half), me)];
  }
}

export async function fetchSnapshot(gql: Gql, plan: Plan): Promise<Snapshot> {
  const head = await gql(VIEWER_QUERY);
  const viewer: string = head.viewer.login;
  const rolesById = new Map<string, Set<Role>>();
  const add = (id: string, role: Role): void => {
    let set = rolesById.get(id);
    if (!set) {
      set = new Set();
      rolesById.set(id, set);
    }
    set.add(role);
  };
  for (const s of searches(plan)) {
    for (const id of await searchIds(gql, s.q)) {
      add(id, s.role);
    }
  }
  for (const id of await resolveRefs(gql, plan.extra)) {
    add(id, 'extra');
  }
  const custom: { name: string; prIds: string[]; issues: Issue[] }[] = [];
  for (const q of plan.queries ?? []) {
    custom.push({ name: q.name, ...await searchItems(gql, q.query) });
  }
  const ids = [...new Set([...rolesById.keys(), ...custom.flatMap((c) => c.prIds)])];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += DETAIL_BATCH) {
    batches.push(ids.slice(i, i + DETAIL_BATCH));
  }
  const answers: any[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const i = next++;
      answers.push(...await detail(gql, batches[i]!, viewer));
    }
  };
  await Promise.all(Array.from({ length: DETAIL_PARALLEL }, worker));
  const prs: PullRequest[] = [];
  const roles: Record<string, Role[]> = {};
  const byId = new Map<string, PullRequest>();
  for (const node of answers) {
    if (!node?.id) {
      continue;
    }
    const pr = normalize(node);
    byId.set(pr.id, pr);
    const set = rolesById.get(pr.id);
    if (set) {
      prs.push(pr);
      roles[prKey(pr.repo, pr.number)] = [...set];
    }
  }
  const queries = custom.map((c) => ({
    name: c.name,
    prs: c.prIds.map((id) => byId.get(id)).filter((pr): pr is PullRequest => pr !== undefined),
    issues: c.issues,
  }));
  return {
    viewer,
    fetchedAt: new Date().toISOString(),
    prs,
    roles,
    rateRemaining: head.rateLimit?.remaining ?? null,
    queries,
  };
}

export interface RepoLabel {
  name: string;
  color: string;
}

export interface SearchPreview {
  count: number;
  items: { number: number; title: string; url: string }[];
}

const LABELS_PAGES_MAX = 20;

const LABELS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, after: $after) { nodes { name color } pageInfo { hasNextPage endCursor } }
  }
}`;

const PREVIEW_QUERY = `query($q: String!) {
  search(type: ISSUE, query: $q, first: 5) {
    issueCount
    nodes { ... on Issue { number title url } ... on PullRequest { number title url } }
  }
}`;

export async function repoLabels(gql: Gql, repo: string): Promise<RepoLabel[]> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    throw new Error(`expected owner/name, got ${repo}`);
  }
  const labels: RepoLabel[] = [];
  let after: string | null = null;
  for (let page = 0; page < LABELS_PAGES_MAX; page++) {
    const data = await gql(LABELS_QUERY, { owner, name, after });
    const conn = data?.repository?.labels;
    if (!conn) {
      throw new Error(`repository ${repo} not found`);
    }
    for (const n of conn.nodes ?? []) {
      if (typeof n?.name === 'string') {
        labels.push({ name: n.name, color: typeof n.color === 'string' ? n.color : '' });
      }
    }
    if (!conn.pageInfo?.hasNextPage) {
      break;
    }
    after = conn.pageInfo.endCursor;
  }
  return labels;
}

export async function searchPreview(gql: Gql, q: string): Promise<SearchPreview> {
  const data = await gql(PREVIEW_QUERY, { q });
  const items = (data.search.nodes ?? [])
    .filter((n: any) => typeof n?.number === 'number')
    .map((n: any) => ({ number: n.number, title: String(n.title ?? ''), url: String(n.url ?? '') }));
  return { count: data.search.issueCount ?? 0, items };
}
