import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSessionIndex, transcriptPath } from '../src/core/sessions.ts';

const A = '110cafae-778b-4ec7-8006-7573681a09f5';
const B = '220cafae-778b-4ec7-8006-7573681a09f5';
const CWD = '/home/u/espressif/zephyr/zephyr';

function line(ts: string, id: string, skill: string, number = 114959, repo = 'zephyrproject-rtos/zephyr'): string {
  return JSON.stringify({ ts, session_id: id, cwd: CWD, skill, repo, number });
}

test('groups entries per pull request and session, newest session first', () => {
  const text = [
    line('2026-11-18T10:00:00Z', A, 'pr-rev'),
    line('2026-11-18T11:00:00Z', A, 'fresh'),
    line('2026-11-18T11:30:00Z', A, 'fresh'),
    line('2026-11-19T09:00:00Z', B, 'pr-rev'),
    line('2026-11-19T09:00:00Z', B, 'pr-rev', 702, 'zephyrproject-rtos/hal_espressif'),
  ].join('\n');
  const index = parseSessionIndex(text);
  const list = index.get('zephyrproject-rtos/zephyr#114959')!;
  assert.deepEqual(list.map((s) => s.id), [B, A]);
  assert.deepEqual(list[1], { id: A, cwd: CWD, first: '2026-11-18T10:00:00Z', last: '2026-11-18T11:30:00Z', skills: ['pr-rev', 'fresh'] });
  assert.equal(index.get('zephyrproject-rtos/hal_espressif#702')!.length, 1);
});

test('skips broken and foreign lines', () => {
  const text = [
    '{not json',
    '',
    JSON.stringify({ ts: 'x', session_id: 'not-a-uuid', cwd: CWD, skill: 'pr-rev', repo: 'o/r', number: 1 }),
    JSON.stringify({ ts: 'x', session_id: A, cwd: CWD, skill: 'pr-rev', repo: 'o/r', number: '1' }),
    line('2026-11-18T10:00:00Z', A, 'pr-rev', 1, 'o/r'),
  ].join('\n');
  const index = parseSessionIndex(text);
  assert.equal(index.size, 1);
  assert.equal(index.get('o/r#1')!.length, 1);
});

test('transcript path flattens the working directory', () => {
  assert.equal(transcriptPath('/home/u/.claude', CWD, A),
    `/home/u/.claude/projects/-home-u-espressif-zephyr-zephyr/${A}.jsonl`);
});
