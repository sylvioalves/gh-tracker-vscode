import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadLedgers, parseLedger } from '../src/core/ledger.ts';

const dir = fileURLToPath(new URL('./fixtures/ledgers/', import.meta.url));

test('loads only pull request ledgers from the directory', () => {
  const ledgers = loadLedgers(dir);
  assert.deepEqual([...ledgers.keys()].sort(), [
    'zephyrproject-rtos/hal_espressif#702',
    'zephyrproject-rtos/zephyr#114959',
  ]);
});

test('reads head, date and status counts', () => {
  const l = loadLedgers(dir).get('zephyrproject-rtos/zephyr#114959')!;
  assert.equal(l.number, 114959);
  assert.equal(l.title, 'soc: espressif: example title');
  assert.equal(l.head, 'ba600e769780');
  assert.equal(l.reviewedAt, '2026-11-19');
  assert.deepEqual(l.counts, { open: 2, drafted: 1, posted: 1, fixed: 1, refuted: 1, moot: 1 });
  assert.equal(l.active, 4);
});

test('accepts a quoted upper case head without a date', () => {
  const l = loadLedgers(dir).get('zephyrproject-rtos/hal_espressif#702')!;
  assert.equal(l.head, 'abd9a470d2805b7183513da3be90487382a80d21');
  assert.equal(l.reviewedAt, null);
  assert.equal(l.active, 1);
});

test('a ledger without a head line still counts findings', () => {
  const l = parseLedger('# o/r#5: t\n\n| F1 | polish | open | a | b |\n', 'x.md')!;
  assert.equal(l.head, null);
  assert.equal(l.counts.open, 1);
});

test('a missing directory gives no ledgers', () => {
  assert.equal(loadLedgers('/nonexistent/ghtracker').size, 0);
});
