import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigError, fromHerdrEvent, openCheckouts, parseVerdict, parseWorktreeList, planSteps, validateConfig, worktreeId,
} from '../lib/model.mjs';

const problemsOf = (raw) => {
  try { validateConfig(raw); } catch (e) { if (e instanceof ConfigError) return e.problems; throw e; }
  return [];
};

test('validateConfig reports every problem at once', () => {
  const problems = problemsOf({
    step: [
      { name: 'a', on: 'close', run: 'x', mdoe: 'suggest' },
      { name: 'a', on: ['close', 'later'], run: '', mode: 'sometimes', when: 'reclaim', timeout: 'soon' },
    ],
  });
  const expected = [
    '"version = 1" is required',
    'unknown key "mdoe"',
    'the name is used twice',
    'unknown event "later"',
    '"run" must be a non-empty string',
    'unknown mode "sometimes"',
    '"when" needs a classifier for event "close"',
    'bad timeout "soon"',
  ];
  for (const text of expected) assert.ok(problems.some((p) => p.includes(text)), `missing: ${text}\n${problems.join('\n')}`);
});

test('validateConfig normalizes defaults', () => {
  const c = validateConfig({
    version: 1,
    classifier: [{ on: ['close', 'sweep'], run: 'c', timeout: '30s' }],
    step: [{ name: 'x', on: 'close', run: 'r', when: 'reclaim' }],
  });
  assert.equal(c.classifiers.close, c.classifiers.sweep);
  assert.equal(c.classifiers.close.timeoutMs, 30_000);
  assert.deepEqual(c.steps[0], {
    name: 'x', description: '', on: ['close'], run: 'r', mode: 'auto', when: ['reclaim'], timeoutMs: 600_000, continueOnError: false,
  });
});

test('one event may have one classifier only', () => {
  const problems = problemsOf({ version: 1, classifier: [{ on: 'close', run: 'a' }, { on: ['sweep', 'close'], run: 'b' }] });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /event "close" already has a classifier/);
});

test('planSteps: modes, the verdict gate, and file order', () => {
  const config = validateConfig({
    version: 1,
    classifier: [{ on: 'close', run: 'c' }],
    step: [
      { name: 'stop', on: 'close', run: 'r' },
      { name: 'delete', on: 'close', run: 'r', mode: 'suggest', when: ['reclaim', 'stale'] },
      { name: 'archive', on: 'close', run: 'r', mode: 'manual' },
      { name: 'install', on: 'open', run: 'r' },
    ],
  });
  const actions = (verdict) => planSteps(config, 'close', verdict).map((p) => `${p.step.name}:${p.action}`);
  assert.deepEqual(actions('reclaim'), ['stop:run', 'delete:suggest', 'archive:skip']);
  assert.deepEqual(actions('stale'), ['stop:run', 'delete:suggest', 'archive:skip']);
  assert.deepEqual(actions('keep'), ['stop:run', 'delete:skip', 'archive:skip']);
  // A failed classifier unlocks no gated step.
  assert.deepEqual(actions('error'), ['stop:run', 'delete:skip', 'archive:skip']);
  assert.deepEqual(planSteps(config, 'sweep', null), []);
});

test('parseVerdict: the last line decides, and every failure is `error`', () => {
  assert.deepEqual(parseVerdict('checking…\nreclaim\n\n'), { verdict: 'reclaim', reason: '' });
  assert.deepEqual(parseVerdict('{"verdict":"keep","reason":"dirty"}'), { verdict: 'keep', reason: 'dirty' });
  const errors = [
    ['reclaim', { code: 1 }],
    ['reclaim', { timedOut: true }],
    ['', {}],
    ['{"verdict":', {}],
    ['Reclaim!', {}],
    ['error', {}],
    ['{"verdict": 3}', {}],
    ['reclaim everything', {}],
  ];
  for (const [out, opts] of errors) assert.equal(parseVerdict(out, opts).verdict, 'error', JSON.stringify(out));
});

// Envelopes as herdr 0.9.1 sends them (paths shortened).
const workspace = {
  workspace_id: 'w5', label: 'feat', number: 3,
  worktree: { repo_key: '/r/.git', repo_name: 'r', repo_root: '/r', checkout_path: '/wt/feat', is_linked_worktree: true },
};
const worktree = { path: '/wt/feat', branch: 'feat', is_bare: false, is_detached: false, is_prunable: false, is_linked_worktree: true, open_workspace_id: 'w5' };

test('fromHerdrEvent maps the four lifecycle events', () => {
  const base = { path: '/wt/feat', repoRoot: '/r', linked: true, workspaceId: 'w5' };
  assert.deepEqual(fromHerdrEvent({ event: 'worktree_created', data: { type: 'worktree_created', workspace, worktree } }),
    { ...base, event: 'create', branch: 'feat' });
  assert.deepEqual(fromHerdrEvent({ event: 'worktree_opened', data: { workspace, worktree, already_open: false } }),
    { ...base, event: 'open', branch: 'feat' });
  assert.deepEqual(fromHerdrEvent({ event: 'workspace_closed', data: { workspace_id: 'w5', workspace } }),
    { ...base, event: 'close', branch: '' });
  assert.deepEqual(fromHerdrEvent({ event: 'worktree_removed', data: { workspace_id: 'w5', workspace, worktree: { path: '/wt/feat', branch: 'feat' }, forced: false } }),
    { ...base, event: 'remove', branch: 'feat' });
});

test('fromHerdrEvent ignores what is not a worktree lifecycle change', () => {
  const ignored = [
    { event: 'worktree_opened', data: { workspace, worktree, already_open: true } },
    { event: 'worktree_created', data: { workspace, worktree: { ...worktree, is_bare: true } } },
    { event: 'workspace_closed', data: { workspace_id: 'w1', workspace: { workspace_id: 'w1', label: 'scratch' } } },
    { event: 'workspace_created', data: { workspace } },
    null,
  ];
  for (const e of ignored) assert.ok(fromHerdrEvent(e).ignore, JSON.stringify(e));
});

test('openCheckouts leaves out the workspace that is closing', () => {
  const ws = [
    { workspace_id: 'w1', worktree: { checkout_path: '/r' } },
    { workspace_id: 'w5', worktree: { checkout_path: '/wt/feat' } },
    { workspace_id: 'w9', label: 'no worktree' },
  ];
  assert.deepEqual([...openCheckouts(ws, 'w5')], ['/r']);
  assert.deepEqual([...openCheckouts(ws)].sort(), ['/r', '/wt/feat']);
});

test('parseWorktreeList reads git porcelain output', () => {
  const list = parseWorktreeList([
    'worktree /r', 'HEAD abc', 'branch refs/heads/main', '',
    'worktree /wt/feat', 'HEAD def', 'branch refs/heads/feat/x', '',
    'worktree /wt/old', 'HEAD 123', 'detached', 'prunable gitdir file points to non-existent location', '',
  ].join('\n'));
  assert.deepEqual(list.map((w) => [w.path, w.branch, Boolean(w.prunable)]), [
    ['/r', 'main', false], ['/wt/feat', 'feat/x', false], ['/wt/old', '', true],
  ]);
});

test('worktreeId is stable, file-safe, and distinct for same-named checkouts', () => {
  assert.equal(worktreeId('/a/feat'), worktreeId('/a/feat'));
  assert.notEqual(worktreeId('/a/feat'), worktreeId('/b/feat'));
  assert.match(worktreeId('/a/feat x/ü'), /^[A-Za-z0-9._-]+$/);
});
