export type FilterType = 'issue' | 'pr' | 'both';
export type FilterState = 'open' | 'closed' | 'all';

export interface FilterForm {
  repo: string;
  type: FilterType;
  state: FilterState;
  labels: string[];
  assignee: string;
  author: string;
  extra: string;
}

export function emptyForm(repo = ''): FilterForm {
  return { repo, type: 'both', state: 'all', labels: [], assignee: '', author: '', extra: '' };
}

const TOKEN_RE = /(?:[^\s"]+|"[^"]*"?)+/g;
const QUALIFIER_RE = /^([A-Za-z]+):(.*)$/;

export function tokenize(query: string): string[] {
  return query.match(TOKEN_RE) ?? [];
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function quote(value: string): string {
  return /[\s,]/.test(value) || value === '' ? `"${value}"` : value;
}

const TYPES = new Map<string, FilterType>([['issue', 'issue'], ['pr', 'pr']]);
const STATES = new Map<string, FilterState>([['open', 'open'], ['closed', 'closed']]);

export function parseQuery(query: string): FilterForm {
  const form = emptyForm();
  const extra: string[] = [];
  let typed = false;
  let stated = false;
  for (const token of tokenize(query)) {
    const m = QUALIFIER_RE.exec(token);
    const key = m?.[1]?.toLowerCase() ?? '';
    const raw = m?.[2] ?? '';
    const value = unquote(raw);
    const word = value.toLowerCase();
    if (key === 'repo' && value && !form.repo) {
      form.repo = value;
    } else if ((key === 'is' || key === 'type') && TYPES.has(word) && !typed) {
      form.type = TYPES.get(word)!;
      typed = true;
    } else if ((key === 'is' || key === 'state') && STATES.has(word) && !stated) {
      form.state = STATES.get(word)!;
      stated = true;
    } else if (key === 'label' && value && !(raw === value && raw.includes(',')) && !form.labels.includes(value)) {
      form.labels.push(value);
    } else if (key === 'assignee' && value && !form.assignee) {
      form.assignee = value;
    } else if (key === 'author' && value && !form.author) {
      form.author = value;
    } else {
      extra.push(token);
    }
  }
  form.extra = extra.join(' ');
  return form;
}

export function buildQuery(form: FilterForm): string {
  const parts: string[] = [];
  const repo = form.repo.trim();
  if (repo) {
    parts.push(`repo:${repo}`);
  }
  if (form.type !== 'both') {
    parts.push(`is:${form.type}`);
  }
  if (form.state !== 'all') {
    parts.push(`is:${form.state}`);
  }
  for (const label of form.labels) {
    if (label.trim()) {
      parts.push(`label:${quote(label.trim())}`);
    }
  }
  if (form.assignee.trim()) {
    parts.push(`assignee:${form.assignee.trim()}`);
  }
  if (form.author.trim()) {
    parts.push(`author:${form.author.trim()}`);
  }
  const extra = tokenize(form.extra).join(' ');
  if (extra) {
    parts.push(extra);
  }
  return parts.join(' ');
}
