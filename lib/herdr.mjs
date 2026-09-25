// herdr through its CLI (`HERDR_BIN_PATH`), as herdr's plugin docs advise:
// the CLI hides the socket transport, which differs per platform.
import { execFile } from 'node:child_process';
import { herdrBin } from './env.mjs';

function herdr(args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    execFile(herdrBin(), args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${(stderr || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

/** Open herdr workspaces. Throws when herdr cannot answer. */
export async function listWorkspaces() {
  const out = JSON.parse(await herdr(['workspace', 'list']));
  const list = out?.result?.workspaces;
  if (!Array.isArray(list)) throw new Error('herdr workspace list: unexpected answer');
  return list;
}

/** Best effort: a failed notification never fails a run. */
export async function notify(title, body) {
  try {
    await herdr(['notification', 'show', title, ...(body ? ['--body', body] : [])], 5_000);
    return true;
  } catch {
    return false;
  }
}

export function openPane(pluginId, entrypoint) {
  return herdr(['plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint]);
}
