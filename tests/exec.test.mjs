import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCommand } from '../lib/exec.mjs';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a timeout kills the whole process group, not only the shell', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-gc-exec-'));
  const log = join(dir, 'log');
  const fd = openSync(log, 'a');
  try {
    // The grandchild ignores SIGTERM, so only the SIGKILL escalation stops it.
    const r = await runCommand({
      command: `sh -c 'trap "" TERM; echo grandchild $$; sleep 30' & wait`,
      cwd: dir,
      env: {},
      timeoutMs: 300,
      logFd: fd,
    });
    assert.equal(r.timedOut, true);
    const pid = Number(readFileSync(log, 'utf8').match(/grandchild (\d+)/)[1]);
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 100));
    assert.equal(alive(pid), false, `grandchild ${pid} survived the timeout`);
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('steps do not inherit the plugin environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-gc-exec-'));
  const fd = openSync(join(dir, 'log'), 'a');
  process.env.HERDR_PLUGIN_EVENT_JSON = '{"secret":1}';
  process.env.HERDR_GC_TRUST = 'all';
  try {
    const r = await runCommand({
      command: 'echo "[$HERDR_PLUGIN_EVENT_JSON][$HERDR_GC_TRUST][$HERDR_GC_EVENT]"',
      cwd: dir,
      env: { HERDR_GC_EVENT: 'close' },
      timeoutMs: 5_000,
      logFd: fd,
      capture: true,
    });
    assert.equal(r.stdout.trim(), '[][][close]');
  } finally {
    delete process.env.HERDR_PLUGIN_EVENT_JSON;
    delete process.env.HERDR_GC_TRUST;
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
});
