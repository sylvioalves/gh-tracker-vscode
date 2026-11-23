import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fetchSnapshot, httpGql, type PrRef } from '../src/core/github.ts';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/snapshot.ts <out.json> [owner/repo#N ...]');
  process.exit(2);
}
const extra: PrRef[] = process.argv.slice(3).map((s) => {
  const m = /^(.+)#(\d+)$/.exec(s);
  if (!m) {
    throw new Error(`bad PR reference ${s}`);
  }
  return { repo: m[1]!, number: Number(m[2]) };
});
const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
const started = Date.now();
const snap = await fetchSnapshot(httpGql(token), {
  repos: ['zephyrproject-rtos/zephyr', 'zephyrproject-rtos/hal_espressif'],
  labels: ['platform: ESP32'],
  extra,
});
writeFileSync(out, JSON.stringify(snap, null, 1));
console.log(`${snap.prs.length} PRs in ${Date.now() - started} ms, rate left ${snap.rateRemaining}`);
