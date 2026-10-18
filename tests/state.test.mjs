// The run history in a private state directory: what pruning keeps.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { listRecords, listRuns, pruneRecords, pruneRuns, writeRecord, writeRun } from '../lib/state.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'herdr-gc-state-'));
  process.env.HERDR_PLUGIN_STATE_DIR = dir;
});
afterEach(() => {
  delete process.env.HERDR_PLUGIN_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const run = (id, createdAt, over = {}) => ({
  id, worktreeId: 'wt', event: 'sweep', path: '/wt', trigger: 'sweep', state: 'done', createdAt, steps: [], ...over,
});

test('pruneRuns drops uneventful runs first, so a large sweep keeps the lifecycle runs in history', () => {
  // Oldest: 5 open runs that ran a step. Then 100 sweep runs that kept their worktree.
  for (let i = 0; i < 5; i++) writeRun(run(`open-${i}`, 1000 + i, { event: 'open', steps: [{ name: 'install', action: 'run', ok: true }] }));
  for (let i = 0; i < 100; i++) writeRun(run(`sweep-${i}`, 10_000 + i));
  writeRun(run('live', 20_000, { state: 'running' }));
  writeRun(run('failed', 500, { state: 'failed' }));

  const dropped = pruneRuns();
  const kept = listRuns().map((r) => r.id);
  assert.equal(dropped, 40);
  for (let i = 0; i < 5; i++) assert.ok(kept.includes(`open-${i}`), `open-${i} was pruned`);
  assert.ok(kept.includes('failed'));
  assert.ok(kept.includes('live'));
  assert.equal(kept.filter((id) => id.startsWith('sweep-')).length, 60);
  assert.ok(kept.includes('sweep-99') && !kept.includes('sweep-0'), 'the newest sweep runs stay');
});

test('pruneRuns keeps the newest 300 runs overall, running ones included', () => {
  for (let i = 0; i < 310; i++) writeRun(run(`r-${i}`, i, { state: i === 0 ? 'running' : 'failed' }));
  pruneRuns();
  const kept = listRuns().map((r) => r.id);
  assert.equal(kept.length, 301);
  assert.ok(kept.includes('r-0'), 'a running run is never pruned');
  assert.ok(kept.includes('r-10') && !kept.includes('r-9'));
});

test('pruneRecords forgets checkouts removed more than 30 days ago, and nothing else', () => {
  const day = 86_400_000;
  const now = 100 * day;
  writeRecord({ id: 'old', path: '/old', removedAt: now - 31 * day });
  writeRecord({ id: 'recent', path: '/recent', removedAt: now - 29 * day });
  writeRecord({ id: 'present', path: '/present', removedAt: null });
  assert.equal(pruneRecords(now), 1);
  assert.deepEqual(listRecords().map((r) => r.id).sort(), ['present', 'recent']);
});
