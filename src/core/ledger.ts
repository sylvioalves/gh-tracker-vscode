import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prKey } from './github.ts';

export const LEDGER_STATUSES = ['open', 'drafted', 'posted', 'fixed', 'refuted', 'moot'] as const;

export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export interface Ledger {
  key: string;
  repo: string;
  number: number;
  title: string;
  head: string | null;
  reviewedAt: string | null;
  counts: Record<LedgerStatus, number>;
  active: number;
  file: string;
}

const TITLE_RE = /^#\s+([\w.-]+\/[\w.-]+)#(\d+):?\s*(.*)$/m;
const HEAD_RE = /^-\s*Last reviewed head:\s*`?([0-9a-f]{7,40})`?(?:\s*\((\d{4}-\d{2}-\d{2})\))?/im;
const ROW_RE = /^\|\s*F\d+\s*\|[^|]*\|\s*([a-z]+)/gim;

export function parseLedger(text: string, file: string): Ledger | null {
  const title = TITLE_RE.exec(text);
  if (!title) {
    return null;
  }
  const counts = Object.fromEntries(LEDGER_STATUSES.map((s) => [s, 0])) as Record<LedgerStatus, number>;
  for (const m of text.matchAll(ROW_RE)) {
    const status = m[1]!.toLowerCase();
    if ((LEDGER_STATUSES as readonly string[]).includes(status)) {
      counts[status as LedgerStatus]++;
    }
  }
  const head = HEAD_RE.exec(text);
  const repo = title[1]!;
  const number = Number(title[2]);
  return {
    key: prKey(repo, number),
    repo,
    number,
    title: title[3]!.trim(),
    head: head ? head[1]!.toLowerCase() : null,
    reviewedAt: head?.[2] ?? null,
    counts,
    active: counts.open + counts.drafted + counts.posted,
    file,
  };
}

export function loadLedgers(dir: string): Map<string, Ledger> {
  const out = new Map<string, Ledger>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.md')) {
      continue;
    }
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const ledger = parseLedger(text, file);
    if (ledger) {
      out.set(ledger.key, ledger);
    }
  }
  return out;
}
