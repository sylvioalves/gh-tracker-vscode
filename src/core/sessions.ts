import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prKey } from './github.ts';

/* One line of the index written by the pr-session-index hook. */
export interface SessionEntry {
  ts: string;
  session_id: string;
  cwd: string;
  skill: string;
  repo: string;
  number: number;
}

export interface Session {
  id: string;
  cwd: string;
  first: string;
  last: string;
  skills: string[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valid(e: any): e is SessionEntry {
  return e && typeof e.ts === 'string' && typeof e.session_id === 'string' && UUID_RE.test(e.session_id)
    && typeof e.cwd === 'string' && typeof e.skill === 'string' && typeof e.repo === 'string'
    && Number.isInteger(e.number);
}

/* Sessions per pull request, newest first, one per session id. */
export function parseSessionIndex(text: string): Map<string, Session[]> {
  const byKey = new Map<string, Map<string, Session>>();
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!valid(e)) {
      continue;
    }
    const key = prKey(e.repo, e.number);
    let sessions = byKey.get(key);
    if (!sessions) {
      sessions = new Map();
      byKey.set(key, sessions);
    }
    const s = sessions.get(e.session_id);
    if (s) {
      s.last = e.ts > s.last ? e.ts : s.last;
      s.first = e.ts < s.first ? e.ts : s.first;
      if (!s.skills.includes(e.skill)) {
        s.skills.push(e.skill);
      }
    } else {
      sessions.set(e.session_id, { id: e.session_id, cwd: e.cwd, first: e.ts, last: e.ts, skills: [e.skill] });
    }
  }
  const out = new Map<string, Session[]>();
  for (const [key, sessions] of byKey) {
    out.set(key, [...sessions.values()].sort((a, b) => (a.last < b.last ? 1 : -1)));
  }
  return out;
}

export function loadSessionIndex(file: string): Map<string, Session[]> {
  try {
    return parseSessionIndex(readFileSync(file, 'utf8'));
  } catch {
    return new Map();
  }
}

/* Where Claude Code keeps a session transcript: the working directory
 * with every non-alphanumeric character replaced by '-'.
 */
export function transcriptPath(claudeDir: string, cwd: string, id: string): string {
  return join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
}
