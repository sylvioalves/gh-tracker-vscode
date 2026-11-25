import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Lease, processAlive } from '../src/core/lease.ts';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'ghtracker-lease-'));
}

test('the first window takes the lease and the second waits', () => {
  const d = dir();
  let now = 1000;
  const a = new Lease(d, { staleMs: 90, pid: 1, now: () => now, alive: () => true });
  const b = new Lease(d, { staleMs: 90, pid: 2, now: () => now, alive: () => true });
  assert.equal(a.tick(), true);
  assert.equal(b.tick(), false);
  now += 60;
  assert.equal(a.tick(), true);
  assert.equal(b.tick(), false);
  rmSync(d, { recursive: true });
});

test('a stale, dead or released lease passes to another window', () => {
  const d = dir();
  let now = 1000;
  const dead = new Set<number>();
  const alive = (pid: number): boolean => !dead.has(pid);
  const a = new Lease(d, { staleMs: 90, pid: 1, now: () => now, alive });
  const b = new Lease(d, { staleMs: 90, pid: 2, now: () => now, alive });
  a.tick();
  now += 91;
  assert.equal(b.tick(), true);
  assert.equal(a.tick(), false);
  dead.add(2);
  assert.equal(a.tick(), true);
  a.release();
  assert.equal(a.held, false);
  assert.equal(b.tick(), true);
  rmSync(d, { recursive: true });
});

test('the own process counts as alive', () => {
  assert.equal(processAlive(process.pid), true);
});
