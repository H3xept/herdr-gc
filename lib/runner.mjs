// The runner: one event for one worktree, a queued suggestion, or one named
// step. Everything that executes a user command goes through here.
//
// A run holds the worktree lock for its whole length. herdr starts the
// `close` and `remove` hooks of a `worktree remove` at the same moment; the
// lock makes them take turns and the worktree record makes the second one a
// no-op.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, writeSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findConfigDir, isTrusted, loadConfig, loadSnapshot } from './config.mjs';
import { settings, stateDir } from './env.mjs';
import { isStopping, runCommand } from './exec.mjs';
import { describeCheckout, worktreesOf } from './git.mjs';
import { listWorkspaces, notify } from './herdr.mjs';
import {
  ConfigError, EXPECTS, openCheckouts, parseVerdict, planSteps, stepEnv, worktreeId,
} from './model.mjs';
import {
  addSuggestion, alive, claimSuggestion, dropSuggestions, listRuns, listSuggestions, lock, logPath, newId, pruneRuns,
  readRecord, readRun, releaseClaim, writeRecord, writeRun,
} from './state.mjs';

const BIN = fileURLToPath(new URL('../bin/herdr-gc', import.meta.url));

export const label = (path) => basename(path) || path;
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

// --- queueing ----------------------------------------------------------------

/**
 * Writes a queued run record. `target` is {event, path, repoRoot, branch,
 * linked, workspaceId}; missing checkout facts are filled from git when the
 * checkout exists.
 */
export function queueRun(target, trigger, extra = {}) {
  let t = { ...target };
  if (existsSync(t.path) && (!t.repoRoot || !t.branch)) {
    try {
      const d = describeCheckout(t.path);
      t = { ...t, repoRoot: t.repoRoot || d.repoRoot, branch: t.branch || d.branch, linked: t.linked ?? d.linked };
    } catch { /* not a git checkout any more */ }
  }
  const run = {
    id: newId(),
    worktreeId: worktreeId(t.path),
    event: t.event,
    path: t.path,
    repoRoot: t.repoRoot ?? '',
    branch: t.branch ?? '',
    linked: Boolean(t.linked),
    workspaceId: t.workspaceId ?? '',
    trigger,
    state: 'queued',
    createdAt: Date.now(),
    steps: [],
    ...extra,
  };
  writeRun(run);
  return run;
}

/** Starts a worker for a queued run and returns at once. */
export function spawnWorker(run) {
  const child = spawn(process.execPath, [BIN, 'worker', run.id], {
    cwd: stateDir(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  writeRun({ ...readRun(run.id), pid: child.pid });
  return child.pid;
}

/** Runs a queued run to its end, in this process. */
export async function executeRun(runId, { out } = {}) {
  const run = readRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  if (run.state !== 'queued') return run;
  const release = await lock(run.worktreeId, {
    onWait: (pid) => out?.write(`waiting for another run on ${label(run.path)} (pid ${pid})\n`),
  });
  try {
    return await underLock(run, out);
  } finally {
    release();
  }
}

// --- one run -------------------------------------------------------------------

function openLog(run, out) {
  const fd = openSync(logPath(run.id), 'a');
  const say = (text) => {
    const line = `${text}\n`;
    try { writeSync(fd, line); } catch { /* best effort */ }
    out?.write(line);
  };
  return { fd, say, out, close: () => closeSync(fd) };
}

async function openElsewhere(path, exceptWorkspaceId) {
  const open = openCheckouts(await listWorkspaces(), exceptWorkspaceId);
  return open.has(path);
}

function freshRecord(run, previous) {
  return {
    id: run.worktreeId,
    path: run.path,
    repoRoot: run.repoRoot || previous?.repoRoot || '',
    branch: run.branch || previous?.branch || '',
    linked: run.linked,
    generation: (previous?.generation ?? 0) + 1,
    seenAt: Date.now(),
    removedAt: null,
    configDir: previous?.configDir ?? null,
    configHash: previous?.configHash ?? null,
    lastRunId: previous?.lastRunId ?? null,
  };
}

/** The config for a run, or null when none applies. Throws ConfigError. */
function resolveConfig(run, record) {
  if (run.event === 'remove' && record?.configDir && record?.configHash
    && (inside(record.configDir, run.path) || !existsSync(record.configDir))) {
    try { return loadSnapshot(record.configDir, record.configHash); } catch {
      throw new ConfigError([`the snapshot of ${record.configDir} is missing`]);
    }
  }
  const dir = findConfigDir(run.path, run.repoRoot);
  return dir ? loadConfig(dir) : null;
}

function cwdFor(run) {
  if (run.event !== 'remove') return run.path;
  if (run.repoRoot && existsSync(run.repoRoot)) return run.repoRoot;
  let dir = dirname(run.path);
  while (!existsSync(dir)) dir = dirname(dir);
  return dir;
}

async function underLock(run, out) {
  const log = openLog(run, out);
  const now = Date.now();
  Object.assign(run, { state: 'running', pid: process.pid, startedAt: now });
  writeRun(run);
  log.say(`# ${new Date(now).toISOString()} ${run.event} ${run.path} (${run.trigger})`);

  let record = readRecord(run.worktreeId);
  const present = existsSync(run.path);
  const finish = (state, note = '') => {
    Object.assign(run, { state, note, endedAt: Date.now() });
    writeRun(run);
    if (note) log.say(`${state}: ${note}`);
    log.close();
    pruneRuns();
    return run;
  };

  // Generations: a checkout seen again after its `remove` is a new one.
  const back = present && (!record || record.removedAt);
  if (back && run.event !== 'remove') record = freshRecord(run, record);
  if (record) {
    record.seenAt = now;
    if (run.branch) record.branch = run.branch;
    if (run.repoRoot) record.repoRoot = run.repoRoot;
    record.lastRunId = run.id;
    writeRecord(record);
    // A gone checkout has no git facts left; the record remembers them.
    run.branch ||= record.branch;
    run.repoRoot ||= record.repoRoot;
  }

  switch (run.event) {
    case 'create':
    case 'open': {
      if (!present) return finish('skipped', 'the checkout is gone');
      const n = dropSuggestions((s) => s.worktreeId === run.worktreeId && (s.event === 'close' || s.event === 'sweep'));
      if (n) log.say(`dropped ${n} pending close/sweep suggestion${n === 1 ? '' : 's'}: the worktree is in use again`);
      break;
    }
    case 'close':
    case 'sweep':
      if (!present) {
        finish('skipped', 'the checkout is gone');
        if (record && !record.removedAt) await chainRemove(run, out);
        return run;
      }
      break;
    case 'remove':
      if (present) return finish('skipped', 'the checkout still exists');
      if (!record) record = freshRecord(run, null);
      if (record.removedAt) return finish('skipped', 'remove already ran for this checkout');
      break;
    default:
      return finish('failed', `unknown event ${run.event}`);
  }

  let cfg;
  try {
    cfg = resolveConfig(run, record);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    run.error = e.message;
    finish('failed', `config error:\n${e.message}`);
    await report(run, [`config error: ${e.problems[0]}`]);
    return run;
  }
  if (!cfg) return finish('done', 'no .herdr-gc config applies');
  run.configDir = cfg.configDir;
  run.configHash = cfg.hash;
  record = { ...record, configDir: cfg.configDir, configHash: cfg.hash };
  writeRecord(record);

  if (!isTrusted(cfg.configDir, cfg.hash)) {
    const dup = listSuggestions().some((s) => s.kind === 'event' && s.worktreeId === run.worktreeId && s.event === run.event);
    if (!dup) addSuggestion(suggestionFrom(run, cfg, { kind: 'event' }));
    finish('blocked', `${cfg.configDir} is not trusted; nothing ran`);
    await report(run, [`${cfg.configDir} is new or changed. Review it, then: herdr-gc trust ${cfg.configDir}`]);
    return run;
  }

  if (run.event === 'remove') {
    record.removedAt = Date.now();
    writeRecord(record);
  }

  const guard = async () => {
    if (run.event !== 'close' && run.event !== 'sweep') return null;
    try {
      return (await openElsewhere(run.path, run.workspaceId)) ? 'a herdr workspace has the checkout open again' : null;
    } catch (e) {
      return `cannot ask herdr which checkouts are open (${e.message})`;
    }
  };

  let stop = await guard();
  if (stop) return finish('skipped', stop);

  const cwd = cwdFor(run);
  const base = { ...run, dir: cfg.dir, configDir: cfg.configDir, runId: run.id };
  const classifier = cfg.config.classifiers[run.event];
  if (classifier) {
    const v = await classify(classifier, { ...base, trigger: run.trigger }, cwd, log);
    run.verdict = v.verdict;
    run.reason = v.reason;
    if (isStopping()) return finish('interrupted', 'herdr-gc was stopped by a signal');
  }

  const plan = planSteps(cfg.config, run.event, run.verdict ?? null);
  if (plan.length === 0 && !classifier) return finish('done', 'no step for this event');
  let failed = false;
  for (const { step, action, why } of plan) {
    if (failed) { run.steps.push({ name: step.name, action: 'not-reached' }); continue; }
    if (action === 'skip') {
      log.say(`- ${step.name}: skipped (${why})`);
      run.steps.push({ name: step.name, action, why });
      continue;
    }
    if (action === 'suggest') {
      const s = addSuggestion(suggestionFrom(run, cfg, { kind: 'step', step: step.name, description: step.description }));
      log.say(`- ${step.name}: suggested (${s.id})`);
      run.steps.push({ name: step.name, action, suggestion: s.id });
      continue;
    }
    stop = await guard();
    if (stop) {
      run.steps.push({ name: step.name, action: 'not-reached' });
      failed = true;
      run.note = stop;
      log.say(`stopped before ${step.name}: ${stop}`);
      continue;
    }
    const result = await runStep(step, { ...base, trigger: run.trigger, verdict: run.verdict, reason: run.reason }, cwd, log);
    run.steps.push({ name: step.name, action: 'run', ...result });
    writeRun(run);
    if (isStopping()) return finish('interrupted', 'herdr-gc was stopped by a signal');
    if (!result.ok && !step.continueOnError) failed = true;
  }

  // A reopened checkout stops a close/sweep run: that is a skip, not a failure.
  const anyFailed = run.steps.some((s) => s.action === 'run' && !s.ok);
  finish(anyFailed ? 'failed' : run.note ? 'skipped' : 'done', run.note ?? '');
  await report(run);
  if (run.event !== 'remove' && !existsSync(run.path)) await chainRemove(run, out);
  return run;
}

/** The checkout vanished during a run: run `remove` now, under the same lock. */
async function chainRemove(parent, out) {
  const next = queueRun({ ...parent, event: 'remove' }, 'chained', { parentRunId: parent.id });
  return underLock(next, out);
}

async function classify(classifier, ctx, cwd, log) {
  log.say(`- classifier: ${classifier.run}`);
  const r = await runCommand({
    command: classifier.run,
    cwd,
    env: stepEnv({ ...ctx, step: 'classifier' }),
    timeoutMs: classifier.timeoutMs,
    logFd: log.fd,
    capture: true,
    echo: log.out,
  });
  const v = r.error ? { verdict: 'error', reason: r.error } : parseVerdict(r.stdout, { code: r.code ?? 1, timedOut: r.timedOut });
  log.say(`  verdict: ${v.verdict}${v.reason ? ` (${v.reason})` : ''}`);
  return v;
}

async function runStep(step, ctx, cwd, log) {
  log.say(`- ${step.name}: ${step.run.split('\n')[0]}${step.run.includes('\n') ? ' …' : ''}`);
  const r = await runCommand({
    command: step.run,
    cwd,
    env: stepEnv({ ...ctx, step: step.name }),
    timeoutMs: step.timeoutMs,
    logFd: log.fd,
    echo: log.out,
  });
  const ok = r.code === 0 && !r.timedOut && !r.error;
  const why = r.error ?? (r.timedOut ? `timed out after ${Math.round(step.timeoutMs / 1000)}s` : r.signal ? `killed by ${r.signal}` : `exit ${r.code}`);
  log.say(`  ${ok ? 'ok' : `failed: ${why}`} (${(r.ms / 1000).toFixed(1)}s)`);
  return { ok, code: r.code, ms: r.ms, ...(ok ? {} : { error: why }) };
}

function suggestionFrom(run, cfg, extra) {
  return {
    worktreeId: run.worktreeId,
    path: run.path,
    repoRoot: run.repoRoot,
    branch: run.branch,
    linked: run.linked,
    workspaceId: run.workspaceId,
    event: run.event,
    verdict: run.verdict ?? null,
    reason: run.reason ?? '',
    configDir: cfg.configDir,
    configHash: cfg.hash,
    runId: run.id,
    ...extra,
  };
}

// --- notifications -------------------------------------------------------------

/** One notification per run that has something to say, per HERDR_GC_NOTIFY. */
async function report(run, problems = []) {
  const level = settings().HERDR_GC_NOTIFY;
  if (level === 'off' || run.quiet) return;
  const ran = run.steps.filter((s) => s.action === 'run');
  const suggested = run.steps.filter((s) => s.action === 'suggest');
  const failed = ran.filter((s) => !s.ok);
  const attention = problems.length || failed.length || suggested.length || run.state === 'failed';
  if (!attention && (level !== 'all' || ran.length === 0)) return;
  const lines = [...problems];
  if (run.verdict) lines.push(`verdict: ${run.verdict}${run.reason ? ` (${run.reason})` : ''}`);
  for (const s of ran) lines.push(`${s.ok ? '✓' : '✗'} ${s.name}${s.ok ? '' : ` (${s.error})`}`);
  if (run.state === 'failed' && run.note && !problems.length) lines.push(run.note);
  if (suggested.length) {
    lines.push(`suggested: ${suggested.map((s) => s.name).join(', ')}`);
    lines.push('accept: action "accept-latest" or `herdr-gc accept --latest`');
  }
  if (failed.length) lines.push(`log: herdr-gc log ${run.id}`);
  const mark = failed.length || run.state === 'failed' ? '✗' : suggested.length || problems.length ? '?' : '✓';
  await notify(`${mark} herdr-gc ${run.event} · ${label(run.path)}`, lines.join('\n'));
}

// --- suggestions ---------------------------------------------------------------

/**
 * Where a worktree stands now, as far as `expect` needs to know: 'gone',
 * 'present', or for a `closed` expectation 'open' or 'closed'. Only that
 * last case asks herdr.
 */
async function standing(path, expect) {
  if (!existsSync(path)) return 'gone';
  if (expect !== 'closed') return 'present';
  return (await openElsewhere(path, '')) ? 'open' : 'closed';
}

/**
 * Runs one pending suggestion. Before anything runs, it checks that the
 * worktree is still in the state its event expects, that the config it came
 * from is still trusted, and, for a step gated by `when`, that the classifier
 * still gives an allowed verdict. A stale suggestion is dropped.
 */
export async function accept(id, { out } = {}) {
  const claim = claimSuggestion(id);
  if (!claim) return { id, ok: false, message: 'no such pending suggestion (already accepted or dismissed?)' };
  const s = claim.item;
  const release = await lock(s.worktreeId, {
    onWait: (pid) => out?.write(`waiting for another run on ${label(s.path)} (pid ${pid})\n`),
  });
  try {
    const expect = EXPECTS[s.event];
    let now;
    try {
      now = await standing(s.path, expect);
    } catch (e) {
      releaseClaim(claim, { requeue: true });
      return { id, ok: false, message: `kept: cannot ask herdr which checkouts are open (${e.message})` };
    }
    if (now !== expect) {
      releaseClaim(claim, { requeue: false });
      return { id, ok: false, message: `dropped: the ${s.event} suggestion no longer applies (the worktree is ${now})` };
    }

    if (s.kind === 'event') {
      const run = queueRun({ ...s }, 'accept');
      let cfg;
      try {
        cfg = resolveConfig(run, readRecord(s.worktreeId));
      } catch (e) {
        releaseClaim(claim, { requeue: true });
        writeRun({ ...run, state: 'failed', note: e.message, endedAt: Date.now() });
        return { id, ok: false, message: `kept: ${e.message}` };
      }
      if (cfg && !isTrusted(cfg.configDir, cfg.hash)) {
        releaseClaim(claim, { requeue: true });
        writeRun({ ...run, state: 'blocked', note: 'still untrusted', endedAt: Date.now() });
        return { id, ok: false, message: `kept: trust it first: herdr-gc trust ${cfg.configDir}` };
      }
      releaseClaim(claim, { requeue: false });
      const done = await underLock(run, out);
      return { id, ok: done.state === 'done', message: `${s.event} ran: ${done.state}`, runId: done.id };
    }

    if (!isTrusted(s.configDir, s.configHash)) {
      releaseClaim(claim, { requeue: false });
      return { id, ok: false, message: `dropped: ${s.configDir} changed since the suggestion; run the event again` };
    }
    let cfg;
    try {
      cfg = loadSnapshot(s.configDir, s.configHash);
    } catch {
      releaseClaim(claim, { requeue: false });
      return { id, ok: false, message: 'dropped: its config snapshot is gone' };
    }
    const step = cfg.config.steps.find((x) => x.name === s.step);
    if (!step) {
      releaseClaim(claim, { requeue: false });
      return { id, ok: false, message: `dropped: step "${s.step}" is not in the config` };
    }
    releaseClaim(claim, { requeue: false });
    const run = queueRun({ ...s }, 'accept', { suggestionId: s.id, verdict: s.verdict, reason: s.reason });
    const done = await runAccepted(run, cfg, step, out);
    return { id, ok: done.state === 'done', message: `${s.step}: ${done.state}${done.note ? ` (${done.note})` : ''}`, runId: done.id };
  } finally {
    release();
  }
}

async function runAccepted(run, cfg, step, out) {
  const log = openLog(run, out);
  Object.assign(run, { state: 'running', pid: process.pid, startedAt: Date.now(), configDir: cfg.configDir, configHash: cfg.hash });
  writeRun(run);
  log.say(`# ${new Date().toISOString()} ${run.trigger} ${step.name} (${run.event}) ${run.path}`);
  const cwd = cwdFor(run);
  const base = { ...run, dir: cfg.dir, configDir: cfg.configDir, runId: run.id };
  const end = (state, note = '') => {
    Object.assign(run, { state, note, endedAt: Date.now() });
    writeRun(run);
    if (note) log.say(`${state}: ${note}`);
    log.close();
  };
  if (step.when) {
    const classifier = cfg.config.classifiers[run.event];
    const v = await classify(classifier, { ...base, trigger: run.trigger }, cwd, log);
    run.verdict = v.verdict;
    run.reason = v.reason;
    if (!step.when.includes(v.verdict)) {
      end('skipped', `the classifier now says ${v.verdict}${v.reason ? ` (${v.reason})` : ''}; ${step.name} needs ${step.when.join('|')}`);
      return run;
    }
  }
  const result = await runStep(step, { ...base, trigger: run.trigger, verdict: run.verdict, reason: run.reason }, cwd, log);
  run.steps.push({ name: step.name, action: 'run', ...result });
  if (isStopping()) {
    end('interrupted', 'herdr-gc was stopped by a signal');
    return run;
  }
  end(result.ok ? 'done' : 'failed');
  pruneRuns();
  if (run.event !== 'remove' && !existsSync(run.path)) await chainRemove(run, out);
  return run;
}

export function dismiss(id) {
  const claim = claimSuggestion(id);
  if (!claim) return false;
  releaseClaim(claim, { requeue: false });
  return true;
}

/** The pending suggestions of the newest run that still has some. */
export function latestSuggestions() {
  const pending = listSuggestions();
  if (pending.length === 0) return [];
  const newest = pending[pending.length - 1];
  return pending.filter((s) => s.runId === newest.runId);
}

// --- manual steps, previews and sweeps ----------------------------------------

/**
 * Runs one named step now, in any mode, without its classifier gate. The only
 * way to run a `manual` step. The step sees the first event it declares as
 * HERDR_GC_EVENT and `run-step` as HERDR_GC_TRIGGER.
 */
export async function runNamedStep(target, name, { out } = {}) {
  const dir = findConfigDir(target.path, target.repoRoot);
  if (!dir) throw new Error(`no .herdr-gc config applies to ${target.path}`);
  const cfg = loadConfig(dir);
  if (!isTrusted(cfg.configDir, cfg.hash)) throw new Error(`not trusted: herdr-gc trust ${cfg.configDir}`);
  const step = cfg.config.steps.find((x) => x.name === name);
  if (!step) throw new Error(`no step "${name}" in ${cfg.configDir}/config.toml`);
  const run = queueRun({ ...target, event: step.on[0] }, 'run-step');
  const release = await lock(run.worktreeId, {
    onWait: (pid) => out?.write(`waiting for another run on ${label(run.path)} (pid ${pid})\n`),
  });
  try {
    return await runAccepted(run, cfg, { ...step, when: null }, out);
  } finally {
    release();
  }
}

/**
 * What an event would do for a worktree, without running a step: the config,
 * its trust, and, when trusted and `classify` is set, the verdict and plan.
 */
export async function preview(target, { classify: wantVerdict = true } = {}) {
  const dir = findConfigDir(target.path, target.repoRoot);
  if (!dir) return { configDir: null };
  const cfg = loadConfig(dir);
  const trusted = isTrusted(cfg.configDir, cfg.hash);
  const out = { configDir: cfg.configDir, hash: cfg.hash, trusted, config: cfg.config, verdict: null, reason: '' };
  const classifier = cfg.config.classifiers[target.event];
  if (trusted && classifier && wantVerdict) {
    const devnull = openSync('/dev/null', 'a');
    try {
      const v = await classify(classifier, {
        ...target, dir: cfg.dir, configDir: cfg.configDir, trigger: 'preview', runId: '',
      }, target.path, { fd: devnull, say: () => {} });
      out.verdict = v.verdict;
      out.reason = v.reason;
    } finally {
      closeSync(devnull);
    }
  }
  out.plan = planSteps(cfg.config, target.event, out.verdict);
  return out;
}

/**
 * The `sweep` event for every linked worktree of a repo that no herdr
 * workspace has open. `dryRun` only classifies and prints the plan.
 */
export async function sweep(repoDir, { dryRun = false, jobs = 4, out, onResult } = {}) {
  const all = worktreesOf(repoDir);
  const main = all[0];
  let open;
  try {
    open = openCheckouts(await listWorkspaces());
  } catch (e) {
    if (!dryRun) throw new Error(`cannot ask herdr which checkouts are open (${e.message}); sweep needs herdr`);
    out?.write(`herdr is not answering; treating every checkout as closed (${e.message})\n`);
    open = new Set();
  }
  const candidates = all.slice(1).filter((w) => !w.bare && !w.prunable && existsSync(w.path));
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const w = candidates[next++];
      const target = { event: 'sweep', path: w.path, repoRoot: main.path, branch: w.branch, linked: true, workspaceId: '' };
      let r;
      if (open.has(w.path)) {
        r = { path: w.path, state: 'open' };
      } else if (dryRun) {
        try {
          const p = await preview(target);
          r = {
            path: w.path,
            state: !p.configDir ? 'no-config' : p.trusted ? 'preview' : 'untrusted',
            verdict: p.verdict,
            reason: p.reason,
            plan: (p.plan ?? []).map((x) => ({ name: x.step.name, action: x.action })),
          };
        } catch (e) {
          r = { path: w.path, state: 'error', reason: e.message.split('\n')[0] };
        }
      } else {
        const run = queueRun(target, 'sweep', { quiet: true });
        const done = await executeRun(run.id);
        r = {
          path: w.path,
          state: done.state,
          verdict: done.verdict,
          reason: done.reason || done.note,
          plan: done.steps.map((x) => ({ name: x.name, action: x.action === 'run' ? (x.ok ? 'ran' : 'failed') : x.action })),
          runId: done.id,
        };
      }
      results.push(r);
      onResult?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, candidates.length)) }, worker));
  if (!dryRun) {
    const suggested = results.reduce((n, r) => n + (r.plan ?? []).filter((x) => x.action === 'suggest').length, 0);
    const failed = results.filter((r) => r.state === 'failed').length;
    if (suggested || failed) {
      await notify(`${failed ? '✗' : '?'} herdr-gc sweep · ${label(main.path)}`,
        `${results.length} worktrees checked${suggested ? `, ${suggested} suggestions` : ''}${failed ? `, ${failed} failed` : ''}\nreview: herdr-gc pending`);
    }
  }
  return results;
}

// --- recovery ------------------------------------------------------------------

/**
 * Marks runs whose worker died as `interrupted`. herdr-gc never replays a
 * lifecycle event by itself; the user decides with `herdr-gc run`.
 */
export function reconcile() {
  const lost = [];
  for (const run of listRuns()) {
    if (run.state !== 'running' && run.state !== 'queued') continue;
    const young = Date.now() - run.createdAt < 30_000;
    if (alive(run.pid) || (run.state === 'queued' && young)) continue;
    writeRun({ ...run, state: 'interrupted', endedAt: Date.now(), note: 'the worker died before the run ended' });
    lost.push(run);
  }
  return lost;
}
