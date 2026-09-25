// End-to-end runs through the CLI, in a temp git repo with a fake herdr.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { makeWorld, workspaceOn } from './fixture.mjs';

let w;
afterEach(() => w?.cleanup());

// Every step appends "<step> <event> <verdict>" to wts/trace, so a test reads
// what ran, in order, from one file.
const trace = (name) => `echo "${name} $HERDR_GC_EVENT $HERDR_GC_VERDICT" >> "$HERDR_GC_REPO_ROOT/../trace"`;
const CONFIG = `version = 1
[[classifier]]
on = ["close", "sweep"]
run = '"$HERDR_GC_DIR/classify.sh"'

[[step]]
name = "setup"
on = ["create", "open"]
run = '${trace('setup')}'

[[step]]
name = "stop"
on = "close"
run = '${trace('stop')}'

[[step]]
name = "delete"
on = ["close", "sweep"]
when = "reclaim"
mode = "suggest"
run = '${trace('delete')}; git -C "$HERDR_GC_REPO_ROOT" worktree remove "$HERDR_GC_WORKTREE"'

[[step]]
name = "archive"
on = "close"
mode = "manual"
run = 'echo "archive $HERDR_GC_EVENT $HERDR_GC_TRIGGER" >> "$HERDR_GC_REPO_ROOT/../trace"'

[[step]]
name = "goodbye"
on = "remove"
run = '${trace('goodbye')}'
`;
// The classifier answers whatever wts/verdict holds.
const CLASSIFY = '#!/bin/sh\ncat "$HERDR_GC_REPO_ROOT/../verdict"\n';

function setup({ trusted = true } = {}) {
  w = makeWorld();
  const wt = w.addWorktree('feat');
  const dir = w.writeConfig(join(w.root, 'wts'), { 'config.toml': CONFIG, 'classify.sh': CLASSIFY });
  if (trusted) assert.equal(w.gc(['trust', dir]).code, 0);
  w.verdict = (v) => writeFileSync(join(w.root, 'wts', 'verdict'), `${v}\n`);
  w.trace = () => { try { return readFileSync(join(w.root, 'wts', 'trace'), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean); } catch { return []; } };
  w.pending = () => JSON.parse(w.gc(['pending', '--json']).stdout);
  w.verdict('reclaim');
  return wt;
}

test('auto steps run, suggest steps queue, manual steps wait for run-step', () => {
  const wt = setup();
  w.gc(['run', 'close', wt]);
  assert.deepEqual(w.trace(), ['stop close reclaim']);
  assert.deepEqual(w.pending().map((s) => s.step), ['delete']);
  const r = w.gc(['run-step', 'archive', wt]);
  assert.equal(r.code, 0, r.stdout);
  assert.deepEqual(w.trace(), ['stop close reclaim', 'archive close run-step']);
});

test('the verdict gates steps, and a broken classifier unlocks nothing', () => {
  const wt = setup();
  w.verdict('keep');
  w.gc(['run', 'close', wt]);
  w.verdict('exit 3');
  w.gc(['run', 'close', wt]);
  assert.deepEqual(w.trace(), ['stop close keep', 'stop close error']);
  assert.deepEqual(w.pending(), []);
});

test('an untrusted folder runs nothing until trusted, then the event replays', () => {
  const wt = setup({ trusted: false });
  const r = w.gc(['run', 'open', wt]);
  assert.match(r.stdout, /not trusted; nothing ran/);
  assert.deepEqual(w.trace(), []);
  assert.match(w.notifications(), /herdr-gc trust /);
  // Accepting before trust keeps the suggestion.
  const early = w.gc(['accept', '--all']);
  assert.match(early.stdout, /kept: trust it first/);
  assert.equal(w.pending().length, 1);
  w.gc(['trust', wt]);
  assert.equal(w.gc(['accept', '--all']).code, 0);
  assert.deepEqual(w.trace(), ['setup open']);
  assert.deepEqual(w.pending(), []);
});

const waitFor = async (check) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((res) => setTimeout(res, 100));
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * True when every run has ended and its worker has exited. A worker still
 * notifies after it writes the final state, so the state alone is not enough.
 */
const settled = () => {
  const dir = join(w.state, 'runs');
  if (!existsSync(dir)) return false;
  const runs = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  return runs.length > 0 && runs.every((r) => r.state !== 'queued' && r.state !== 'running' && !(r.pid && alive(r.pid)));
};

test('close does nothing while another herdr workspace has the checkout open', async () => {
  const wt = setup();
  w.setOpen([workspaceOn('w7', wt, w.repo)]);
  const r = w.gc(['run', 'close', wt]);
  assert.match(r.stdout, /skipped: a herdr workspace has the checkout open again/);
  assert.deepEqual(w.trace(), []);

  // herdr may still list the workspace that is closing; it does not count.
  const envelope = { event: 'workspace_closed', data: { workspace_id: 'w7', workspace: workspaceOn('w7', wt, w.repo) } };
  w.gc(['hook'], { HERDR_PLUGIN_EVENT_JSON: JSON.stringify(envelope) });
  await waitFor(settled);
  assert.deepEqual(w.trace(), ['stop close reclaim']);
});

test('accept re-checks the worktree state and the classifier', () => {
  const wt = setup();
  w.gc(['run', 'close', wt]);
  const [first] = w.pending();

  // herdr cannot answer: the suggestion stays.
  writeFileSync(join(w.fake, 'down'), '');
  assert.match(w.gc(['accept', first.id]).stdout, /kept: cannot ask herdr/);
  assert.equal(w.pending().length, 1);

  // The checkout is open again: the close suggestion no longer applies.
  rmSync(join(w.fake, 'down'));
  w.setOpen([workspaceOn('w7', wt, w.repo)]);
  assert.match(w.gc(['accept', first.id]).stdout, /dropped: the close suggestion no longer applies \(the worktree is open\)/);
  assert.deepEqual(w.pending(), []);

  w.setOpen([]);
  w.gc(['run', 'close', wt]);
  // The PR got a new commit since: the classifier now says keep.
  w.verdict('keep');
  const r = w.gc(['accept', '--latest']);
  assert.match(r.stdout, /the classifier now says keep/);
  assert.ok(existsSync(wt));
  assert.ok(!w.trace().some((l) => l.startsWith('delete')));
});

test('a reopened worktree drops its close suggestions', () => {
  const wt = setup();
  w.gc(['run', 'close', wt]);
  assert.equal(w.pending().length, 1);
  w.gc(['run', 'open', wt]);
  assert.deepEqual(w.pending(), []);
});

test('two concurrent accepts of one suggestion run the step once', async () => {
  const wt = setup();
  w.gc(['run', 'close', wt]);
  const [s] = w.pending();
  const bin = new URL('../bin/herdr-gc', import.meta.url).pathname;
  const once = () => new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, 'accept', s.id], { cwd: w.root, env: w.env, stdio: 'ignore' });
    p.on('exit', resolve);
  });
  const codes = await Promise.all([once(), once(), once()]);
  assert.equal(codes.filter((c) => c === 0).length, 1, `exit codes ${codes}`);
  assert.equal(w.trace().filter((l) => l.startsWith('delete')).length, 1);
});

test('deleting the checkout runs remove once, whoever notices first', () => {
  const wt = setup();
  w.gc(['run', 'close', wt]);
  assert.equal(w.gc(['accept', '--latest']).code, 0);
  assert.ok(!existsSync(wt));
  // herdr's own worktree.removed arrives after the chained remove.
  const again = w.gc(['run', 'remove', wt]);
  assert.match(again.stdout, /remove already ran for this checkout/);
  assert.deepEqual(w.trace(), ['stop close reclaim', 'delete close reclaim', 'goodbye remove']);
});

test('a recreated checkout at the same path is a new worktree', () => {
  const wt = setup();
  w.gc(['run', 'close', wt]);
  w.gc(['accept', '--latest']);
  w.git('worktree', 'add', '-q', wt, 'feat');
  w.gc(['run', 'open', wt]);
  w.git('worktree', 'remove', wt);
  w.gc(['run', 'remove', wt]);
  assert.deepEqual(w.trace().filter((l) => l.startsWith('goodbye')), ['goodbye remove', 'goodbye remove']);
});

test('the hook verb maps a herdr event and runs it in a detached worker', async () => {
  const wt = setup();
  const envelope = {
    event: 'worktree_created',
    data: {
      type: 'worktree_created',
      workspace: workspaceOn('w5', wt, w.repo),
      worktree: { path: wt, branch: 'feat', is_bare: false, is_linked_worktree: true },
    },
  };
  const r = w.gc(['hook'], { HERDR_PLUGIN_EVENT_JSON: JSON.stringify(envelope) });
  assert.match(r.stdout, /queued create/);
  await waitFor(settled);
  assert.deepEqual(w.trace(), ['setup create']);
});

test('a SIGTERM to a run stops its step, and the run becomes interrupted', async () => {
  w = makeWorld();
  const wt = w.addWorktree('feat');
  const pidFile = join(w.root, 'step.pid');
  w.writeConfig(wt, {
    'config.toml': `version = 1\n[[step]]\nname = "long"\non = "open"\nrun = 'sleep 30 & echo $! > "${pidFile}"; wait'\n`,
  });
  const env = { ...w.env, HERDR_GC_TRUST: 'all' };
  const bin = new URL('../bin/herdr-gc', import.meta.url).pathname;
  const cli = spawn(process.execPath, [bin, 'run', 'open', wt], { cwd: w.root, env, stdio: 'ignore' });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim());
  const stepPid = Number(readFileSync(pidFile, 'utf8'));
  const exited = new Promise((res) => cli.on('exit', (code, signal) => res(code ?? signal)));
  cli.kill('SIGTERM');
  assert.equal(await exited, 143);
  const alive = () => { try { process.kill(stepPid, 0); return true; } catch { return false; } };
  await waitFor(() => !alive());
  assert.equal(alive(), false, 'the step outlived the run');
  assert.match(w.gc(['status', wt], { HERDR_GC_TRUST: 'all' }).stdout, /interrupted +open/);
});

test('sweep suggests for closed worktrees only, and --dry-run queues nothing', () => {
  const wt = setup();
  const other = w.addWorktree('other');
  w.setOpen([workspaceOn('w2', other, w.repo)]);
  const dry = w.gc(['sweep', '--dry-run', w.repo]);
  assert.match(dry.stdout, /feat .*reclaim/);
  assert.doesNotMatch(dry.stdout, /\bother\b.*reclaim/);
  assert.deepEqual(w.pending(), []);
  w.gc(['sweep', w.repo]);
  assert.deepEqual(w.pending().map((s) => [s.path, s.step]), [[wt, 'delete']]);
});
