// A throwaway world for one test: a git repo with linked worktrees, a fake
// `herdr` binary, and private plugin directories. Nothing touches the real
// herdr, the real plugin state or the network.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/herdr-gc', import.meta.url).pathname;

// The fake herdr answers `workspace list` from workspaces.json and appends
// every notification to notifications.log.
const FAKE_HERDR = `#!/bin/sh
dir="$(dirname "$0")"
case "$1 $2" in
  "workspace list")
    [ -f "$dir/down" ] && { echo "herdr is down" >&2; exit 1; }
    printf '{"id":"x","result":{"type":"workspace_list","workspaces":%s}}\\n' "$(cat "$dir/workspaces.json")" ;;
  "notification show")
    shift 2; printf '%s\\n' "$*" >> "$dir/notifications.log" ;;
  *) echo "fake herdr: $*" >&2; exit 1 ;;
esac
`;

export function makeWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'herdr-gc-test-')));
  const w = {
    root,
    repo: join(root, 'wts', 'main'),
    fake: join(root, 'fake'),
    state: join(root, 'state'),
    config: join(root, 'config'),
  };
  mkdirSync(w.repo, { recursive: true });
  mkdirSync(w.fake, { recursive: true });
  writeFileSync(join(w.fake, 'herdr'), FAKE_HERDR);
  chmodSync(join(w.fake, 'herdr'), 0o755);
  writeFileSync(join(w.fake, 'workspaces.json'), '[]');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: w.repo, stdio: 'pipe' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');

  w.git = git;
  w.env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('HERDR_'))),
    HOME: root,
    HERDR_BIN_PATH: join(w.fake, 'herdr'),
    HERDR_PLUGIN_STATE_DIR: w.state,
    HERDR_PLUGIN_CONFIG_DIR: w.config,
  };
  /** Adds a linked worktree next to main and returns its path. */
  w.addWorktree = (name) => {
    const path = join(root, 'wts', name);
    git('worktree', 'add', '-q', '-b', name, path);
    return path;
  };
  /** Writes `.herdr-gc/<file>` into `dir`. */
  w.writeConfig = (dir, files) => {
    for (const [name, text] of Object.entries(files)) {
      const p = join(dir, '.herdr-gc', name);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, text);
      if (name.endsWith('.sh')) chmodSync(p, 0o755);
    }
    return join(dir, '.herdr-gc');
  };
  /** Runs the CLI; returns {code, stdout, stderr}. */
  w.gc = (args, extraEnv = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd: w.root, env: { ...w.env, ...extraEnv }, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  w.setOpen = (workspaces) => writeFileSync(join(w.fake, 'workspaces.json'), JSON.stringify(workspaces));
  w.notifications = () => { try { return readFileSync(join(w.fake, 'notifications.log'), 'utf8'); } catch { return ''; } };
  w.cleanup = () => rmSync(root, { recursive: true, force: true });
  return w;
}

/** A herdr workspace record whose worktree is `path`. */
export const workspaceOn = (id, path, repoRoot) => ({
  workspace_id: id,
  label: id,
  worktree: { checkout_path: path, repo_root: repoRoot, repo_key: `${repoRoot}/.git`, repo_name: 'repo', is_linked_worktree: path !== repoRoot },
});
