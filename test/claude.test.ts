import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeCommand, claudeOpenQuery, issuePrompt, isUnder, postPrompt, prReference, reviewPrompt, shellQuote } from '../src/core/claude.ts';
import type { PullRequest } from '../src/core/github.ts';

const pr = {
  repo: 'zephyrproject-rtos/zephyr',
  number: 124900,
  title: 'lib: libc: common: align riscv malloc arena to pmp granularity',
  url: 'https://github.com/zephyrproject-rtos/zephyr/pull/124900',
} as PullRequest;

test('the open query survives characters that split a query string', () => {
  const q = claudeOpenQuery({ prompt: '/pr-rev a&b=c+d #1', session: '110cafae-778b-4ec7-8006-7573681a09f5' });
  const back = new URLSearchParams(q);
  assert.equal(back.get('prompt'), '/pr-rev a&b=c+d #1');
  assert.equal(back.get('session'), '110cafae-778b-4ec7-8006-7573681a09f5');
  assert.equal(claudeOpenQuery({}), '');
});

test('prompts name the pull request by URL', () => {
  assert.equal(reviewPrompt(pr), '/pr-rev https://github.com/zephyrproject-rtos/zephyr/pull/124900');
  assert.equal(postPrompt(pr), '/pr-post https://github.com/zephyrproject-rtos/zephyr/pull/124900');
});

test('the issue prompt asks for a root cause and a fix plan', () => {
  assert.equal(issuePrompt('https://github.com/zephyrproject-rtos/zephyr/issues/126157'),
    'Analyze issue https://github.com/zephyrproject-rtos/zephyr/issues/126157: reproduce the root cause in the tree and propose a fix plan.');
});

test('the reference names the repository only outside zephyr', () => {
  assert.equal(prReference(pr), 'PR #124900 ("lib: libc: common: align riscv malloc arena to pmp granularity")');
  assert.equal(prReference({ ...pr, repo: 'zephyrproject-rtos/hal_espressif', number: 657, title: 't' }),
    'hal_espressif PR #657 ("t")');
});

test('the terminal line quotes the prompt and carries the profile', () => {
  assert.equal(shellQuote(`it's`), `'it'\\''s'`);
  assert.equal(claudeCommand('/pr-rev https://github.com/o/r/pull/1'), `claude '/pr-rev https://github.com/o/r/pull/1'`);
  assert.equal(claudeCommand('/fresh', { settings: '/home/u/.claude/profiles/review.json', resume: 'abc' }),
    `claude --settings '/home/u/.claude/profiles/review.json' --resume abc '/fresh'`);
  assert.equal(claudeCommand(undefined, { resume: 'abc' }), 'claude --resume abc');
});

test('isUnder matches the folder itself and its children only', () => {
  assert.equal(isUnder('/a/zephyr', ['/a/zephyr/']), true);
  assert.equal(isUnder('/a/zephyr/sub', ['/a/zephyr']), true);
  assert.equal(isUnder('/a/zephyr-other', ['/a/zephyr']), false);
  assert.equal(isUnder('/a/zephyr', []), false);
});
