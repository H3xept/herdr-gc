// Runs one classifier or step command.
//
// A command runs under `/bin/sh -c` in its own process group. A timeout sends
// SIGTERM to the whole group, then SIGKILL after 5 s, so a `yarn` or a stack
// started by the step does not outlive it. Output goes straight to the run
// log; a classifier's stdout is also captured, capped at 64 KiB.
import { spawn } from 'node:child_process';
import { existsSync, writeSync } from 'node:fs';

const CAPTURE_LIMIT = 64 * 1024;
const KILL_GRACE_MS = 5_000;

// herdr injects plugin-invocation variables into every plugin command. A step
// is not a plugin command, so it gets the herdr socket and binary but not the
// plugin's own identity, context or event payload.
function childEnv(extra) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HERDR_PLUGIN_') || key.startsWith('HERDR_GC_')) delete env[key];
  }
  return { ...env, ...extra };
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); } catch { /* group already gone */ }
}

// Process groups of the commands running now. A step runs in its own group,
// so a Ctrl-C or a SIGTERM aimed at herdr-gc does not reach it by itself.
const active = new Set();
let stopping = false;

/** True once stopActive ran: the process is about to exit. */
export const isStopping = () => stopping;

/**
 * Stops every running command: SIGTERM to each group, SIGKILL to the ones
 * still there after the grace time. For signal handlers, before exit.
 */
export async function stopActive() {
  stopping = true;
  for (const pid of active) signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + KILL_GRACE_MS;
  while (active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  for (const pid of active) signalGroup(pid, 'SIGKILL');
}

/**
 * `echo` is a writable stream (the terminal of a foreground CLI run) that
 * gets a copy of the output; the log always gets it.
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean, ms: number, stdout: string, error?: string}>}
 */
export function runCommand({ command, cwd, env, timeoutMs, logFd, capture = false, echo = null }) {
  const started = Date.now();
  return new Promise((resolve) => {
    if (stopping) {
      resolve({ code: null, signal: null, timedOut: false, ms: 0, stdout: '', error: 'herdr-gc is stopping' });
      return;
    }
    if (!existsSync(cwd)) {
      resolve({ code: null, signal: null, timedOut: false, ms: 0, stdout: '', error: `directory ${cwd} does not exist` });
      return;
    }
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: childEnv(env),
      detached: true,
      stdio: ['ignore', capture || echo ? 'pipe' : logFd, echo ? 'pipe' : logFd],
    });
    let stdout = '';
    const copy = (chunk) => {
      try { writeSync(logFd, chunk); } catch { /* the log is best effort */ }
      echo?.write(chunk);
    };
    child.stdout?.on('data', (chunk) => {
      if (capture && stdout.length < CAPTURE_LIMIT) stdout += chunk.toString('utf8').slice(0, CAPTURE_LIMIT - stdout.length);
      copy(chunk);
    });
    child.stderr?.on('data', copy);
    if (child.pid) active.add(child.pid);
    let timedOut = false;
    let killer;
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, 'SIGTERM');
      killer = setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut: false, ms: Date.now() - started, stdout, error: e.message });
    });
    // `close` waits for stdout to close. A command that leaves a background
    // process holding the pipe would block it, so `exit` resolves after 1 s.
    let done = false;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      active.delete(child.pid);
      clearTimeout(timer);
      clearTimeout(killer);
      // The shell is gone; make sure nothing it started in its group stays.
      if (timedOut) signalGroup(child.pid, 'SIGKILL');
      resolve({ code, signal, timedOut, ms: Date.now() - started, stdout });
    };
    child.on('exit', (code, signal) => setTimeout(() => finish(code, signal), 1000));
    child.on('close', finish);
  });
}
