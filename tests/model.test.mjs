import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ConfigError, commonSteps, duration, fromHerdrEvent, openCheckouts, parseVerdict, parseWorktreeList, planSteps, runSummary, stepMoments,
  stepNotice, sweepSummary, uneventful, validateConfig, worktreeId,
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
    name: 'x', description: '', on: ['close'], run: 'r', mode: 'auto', when: ['reclaim'], timeoutMs: 600_000, continueOnError: false, notify: [],
  });
});

test('validateConfig: notify takes a moment, a list, or "all", and nothing else', () => {
  const steps = (notify) => validateConfig({ version: 1, step: [{ name: 'x', on: 'open', run: 'r', notify }] }).steps[0].notify;
  assert.deepEqual(steps('start'), ['start']);
  assert.deepEqual(steps(['failure', 'start', 'failure']), ['failure', 'start']);
  assert.deepEqual(steps('all'), ['start', 'success', 'failure']);
  const problems = problemsOf({ version: 1, step: [{ name: 'x', on: 'open', run: 'r', notify: ['start', 'end'] }] });
  assert.ok(problems.some((p) => p.includes('"notify" must be')), problems.join('\n'));
});

test('stepMoments: off silences a step, verbose announces every step, else the step decides', () => {
  const step = { notify: ['failure'] };
  assert.deepEqual(stepMoments(step, 'off'), []);
  assert.deepEqual(stepMoments(step, 'verbose'), ['start', 'success', 'failure']);
  assert.deepEqual(stepMoments(step, 'all'), ['failure']);
  assert.deepEqual(stepMoments(step, 'attention'), ['failure']);
});

const run = (over) => ({ id: 'r1', event: 'open', path: '/wt/feat', state: 'done', note: '', steps: [], ...over });

test('runSummary: what each level reports, and a step that announced itself is not repeated', () => {
  const ran = run({ steps: [{ name: 'install', action: 'run', ok: true, ms: 130_000 }] });
  assert.equal(runSummary(ran, [], 'off'), null);
  assert.equal(runSummary(ran, [], 'attention'), null);
  assert.deepEqual(runSummary(ran, [], 'all'), { title: '✓ herdr-gc open · feat', body: '✓ install 2m 10s' });
  const announced = run({ steps: [{ name: 'install', action: 'run', ok: true, ms: 1000, announced: true }] });
  assert.equal(runSummary(announced, [], 'all'), null);

  const failed = run({ state: 'failed', steps: [{ name: 'install', action: 'run', ok: false, ms: 500, error: 'exit 1' }] });
  const n = runSummary(failed, [], 'attention');
  assert.equal(n.title, '✗ herdr-gc open · feat');
  assert.match(n.body, /✗ install \(exit 1\) 0\.5s\nlog: herdr-gc log r1/);

  const interrupted = run({ state: 'interrupted', note: 'herdr-gc was stopped by a signal' });
  assert.match(runSummary(interrupted, [], 'attention').body, /stopped by a signal/);

  const suggested = run({ event: 'close', verdict: 'reclaim', reason: 'PR merged', steps: [{ name: 'delete', action: 'suggest' }] });
  const s = runSummary(suggested, [], 'attention');
  assert.equal(s.title, '? herdr-gc close · feat');
  assert.deepEqual(s.body.split('\n'), ['verdict: reclaim (PR merged)', 'suggested: delete', 'accept: action "accept-latest" or `herdr-gc accept --latest`']);

  assert.equal(runSummary(run({ state: 'blocked' }), ['x is new or changed'], 'attention').body, 'x is new or changed');
});

test('stepNotice names the step, the moment, the time it took, and the log on failure', () => {
  const r = run();
  assert.deepEqual(stepNotice(r, { name: 'install' }, 'start'), { title: '▶ herdr-gc open · feat', body: 'install started\nlog: herdr-gc log r1' });
  assert.deepEqual(stepNotice(r, { name: 'install' }, 'success', { ms: 2500 }), { title: '✓ herdr-gc open · feat', body: '✓ install 2.5s' });
  assert.deepEqual(stepNotice(r, { name: 'install' }, 'failure', { ms: 100, error: 'exit 2' }), {
    title: '✗ herdr-gc open · feat', body: '✗ install (exit 2) 0.1s\nlog: herdr-gc log r1',
  });
});

test('sweepSummary: quiet when nothing happened, unless asked; counts steps, suggestions, failures and untrusted', () => {
  const kept = [{ path: '/a', state: 'done', plan: [{ name: 'd', action: 'skip' }] }, { path: '/b', state: 'open' }];
  assert.equal(sweepSummary('/repo/main', kept, 'all'), null);
  assert.deepEqual(sweepSummary('/repo/main', kept, 'all', { always: true }), { title: '✓ herdr-gc sweep · main', body: '2 worktrees, 1 open' });
  assert.equal(sweepSummary('/repo/main', kept, 'off', { always: true }), null);

  const busy = [
    { path: '/a', state: 'done', plan: [{ name: 'free', action: 'ran' }, { name: 'delete', action: 'suggest' }] },
    { path: '/b', state: 'failed', plan: [{ name: 'free', action: 'failed' }] },
    { path: '/c', state: 'blocked' },
  ];
  assert.equal(sweepSummary('/repo/main', [busy[0]].map((r) => ({ ...r, plan: [r.plan[0]] })), 'attention'), null, 'a step that ran is not attention');
  const n = sweepSummary('/repo/main', busy, 'attention');
  assert.equal(n.title, '✗ herdr-gc sweep · main');
  assert.deepEqual(n.body.split('\n'), [
    '3 worktrees, 1 steps ran, 1 suggestions, 1 failed, 1 untrusted',
    'review: herdr-gc pending', 'details: herdr-gc status', 'approve: herdr-gc trust <path>',
  ]);
});

test('uneventful: only a finished run that ran, suggested or failed nothing', () => {
  assert.equal(uneventful(run({ steps: [{ name: 'd', action: 'skip' }] })), true);
  assert.equal(uneventful(run({ state: 'skipped' })), true);
  assert.equal(uneventful(run({ steps: [{ name: 'd', action: 'suggest' }] })), false);
  assert.equal(uneventful(run({ steps: [{ name: 'd', action: 'run', ok: true }] })), false);
  assert.equal(uneventful(run({ state: 'failed' })), false);
  assert.equal(uneventful(run({ state: 'running' })), false);
});

test('duration reads as seconds, minutes or hours', () => {
  assert.equal(duration(1234), '1.2s');
  assert.equal(duration(130_000), '2m 10s');
  assert.equal(duration(3_900_000), '1h 05m');
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

test('commonSteps keeps the step names every config has, in the first config\'s order', () => {
  const steps = (...names) => names.map((name) => ({ name }));
  const lists = [steps('stop', 'delete', 'archive'), steps('archive', 'delete'), steps('delete', 'archive', 'x')];
  assert.deepEqual(commonSteps(lists).map((s) => s.name), ['delete', 'archive']);
  assert.deepEqual(commonSteps([steps('a'), steps('b')]), []);
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
