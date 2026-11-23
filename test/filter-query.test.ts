import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQuery, emptyForm, parseQuery, tokenize, type FilterForm } from '../src/core/filter-query.ts';

const form = (over: Partial<FilterForm>): FilterForm => ({ ...emptyForm(), ...over });

test('tokenize keeps quoted values together', () => {
  assert.deepEqual(tokenize(' repo:a/b  label:"platform: ESP32" "two words" x'),
    ['repo:a/b', 'label:"platform: ESP32"', '"two words"', 'x']);
  assert.deepEqual(tokenize(''), []);
});

test('parse reads the known qualifiers', () => {
  assert.deepEqual(parseQuery('repo:zephyrproject-rtos/zephyr is:issue is:open label:"platform: ESP32"'), form({
    repo: 'zephyrproject-rtos/zephyr', type: 'issue', state: 'open', labels: ['platform: ESP32'],
  }));
  assert.deepEqual(parseQuery('is:pr is:closed assignee:me author:@me'), form({
    type: 'pr', state: 'closed', assignee: 'me', author: '@me',
  }));
});

test('parse accepts type: and state: spellings, case-insensitively', () => {
  assert.deepEqual(parseQuery('type:pr state:closed'), form({ type: 'pr', state: 'closed' }));
  assert.deepEqual(parseQuery('Type:Issue IS:OPEN'), form({ type: 'issue', state: 'open' }));
});

test('missing type means both and missing state means all', () => {
  const f = parseQuery('repo:a/b label:bug');
  assert.equal(f.type, 'both');
  assert.equal(f.state, 'all');
});

test('parse collects several labels, quoted or not, without duplicates', () => {
  assert.deepEqual(parseQuery('label:bug label:"area: Wi-Fi" label:bug label:x').labels, ['bug', 'area: Wi-Fi', 'x']);
});

test('parse keeps unknown and repeated tokens in extra, in order', () => {
  const f = parseQuery('repo:a/b sort:updated-desc repo:c/d -label:wontfix is:merged is:issue is:pr "free text" in:title');
  assert.equal(f.repo, 'a/b');
  assert.equal(f.type, 'issue');
  assert.equal(f.state, 'all');
  assert.deepEqual(f.labels, []);
  assert.equal(f.extra, 'sort:updated-desc repo:c/d -label:wontfix is:merged is:pr "free text" in:title');
  assert.deepEqual(parseQuery('is:constructor state:toString'), form({ extra: 'is:constructor state:toString' }));
});

test('an unquoted comma label is an OR list and stays in extra', () => {
  const f = parseQuery('label:bug,enhancement label:"a,b"');
  assert.deepEqual(f.labels, ['a,b']);
  assert.equal(f.extra, 'label:bug,enhancement');
});

test('build orders the qualifiers and quotes labels when needed', () => {
  assert.equal(buildQuery(form({
    repo: ' a/b ', type: 'pr', state: 'open', labels: ['bug', 'platform: ESP32', 'a,b', ' '],
    assignee: 'x', author: '@me', extra: '  sort:updated   no:milestone ',
  })), 'repo:a/b is:pr is:open label:bug label:"platform: ESP32" label:"a,b" assignee:x author:@me sort:updated no:milestone');
  assert.equal(buildQuery(emptyForm()), '');
});

test('parse inverts build', () => {
  const forms: FilterForm[] = [
    emptyForm(),
    form({ repo: 'a/b' }),
    form({ repo: 'a/b', type: 'issue', state: 'closed', labels: ['x y', 'z', 'a,b'], assignee: 'me', author: 'you', extra: 'sort:created no:assignee' }),
    form({ type: 'pr', extra: '"quoted text" -label:"needs review"' }),
  ];
  for (const f of forms) {
    assert.deepEqual(parseQuery(buildQuery(f)), f);
  }
});

test('build after parse is a fixed point', () => {
  const queries = [
    'repo:zephyrproject-rtos/zephyr is:issue is:open label:"platform: ESP32"',
    'label:a is:open extra repo:x/y',
    'is:issue is:pr is:open is:closed label:bug,doc "unterminated',
    'state:open type:pr label:"x" author:a author:b',
  ];
  for (const q of queries) {
    const once = buildQuery(parseQuery(q));
    assert.equal(buildQuery(parseQuery(once)), once);
    assert.deepEqual(parseQuery(once), parseQuery(q));
  }
});
