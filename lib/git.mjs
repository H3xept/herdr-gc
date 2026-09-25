// The few git facts herdr-gc needs when herdr did not supply them: which
// checkout a directory belongs to, its branch, and a repo's worktrees.
import { execFileSync } from 'node:child_process';
import { parseWorktreeList } from './model.mjs';

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 }).trim();
}

/** The checkout that holds `dir`, or null outside git. */
export function checkoutOf(dir) {
  try { return git(dir, ['rev-parse', '--show-toplevel']); } catch { return null; }
}

export function branchOf(checkout) {
  try { return git(checkout, ['branch', '--show-current']); } catch { return ''; }
}

/** Every worktree of the repo that holds `dir`; the first is the main one. */
export function worktreesOf(dir) {
  return parseWorktreeList(git(dir, ['worktree', 'list', '--porcelain']));
}

/**
 * Checkout facts for a path: the main checkout of its repo, its branch, and
 * whether it is a linked worktree.
 */
export function describeCheckout(checkout) {
  const all = worktreesOf(checkout);
  const main = all[0];
  const self = all.find((w) => w.path === checkout);
  return {
    path: checkout,
    repoRoot: main && !main.bare ? main.path : '',
    branch: self?.branch ?? branchOf(checkout),
    linked: Boolean(main && main.path !== checkout),
  };
}
