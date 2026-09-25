// The shipped examples: their configs load, and the reclaim classifier only
// says reclaim when every condition holds. A fake `gh` stands in for GitHub.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { parseToml } from '../lib/toml.mjs';
import { validateConfig } from '../lib/model.mjs';
import { makeWorld } from './fixture.mjs';

const EXAMPLES = new URL('../examples/', import.meta.url).pathname;

let w;
afterEach(() => w?.cleanup());

test('every example config is valid', () => {
  for (const name of readdirSync(EXAMPLES)) {
    const text = readFileSync(join(EXAMPLES, name, '.herdr-gc', 'config.toml'), 'utf8');
    assert.doesNotThrow(() => validateConfig(parseToml(text)), name);
  }
});

function classifierWorld() {
  w = makeWorld();
  const wt = w.addWorktree('feat');
  const dir = join(w.root, 'gc');
  cpSync(join(EXAMPLES, 'reclaim-merged', '.herdr-gc'), dir, { recursive: true });
  const bin = join(w.root, 'bin');
  mkdirSync(bin);
  // `gh pr list … --jq …` prints "<number> <mergedAt>" or nothing.
  w.gh = (answer) => {
    writeFileSync(join(bin, 'gh'), answer === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho '${answer}'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
  };
  w.classify = (path = wt, extra = {}) => {
    const r = spawnSync(join(dir, 'classify.sh'), [], {
      cwd: path,
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: w.root,
        HERDR_GC_WORKTREE: path,
        HERDR_GC_BRANCH: path === wt ? 'feat' : 'main',
        HERDR_GC_LINKED: path === wt ? '1' : '0',
        HERDR_GC_DIR: dir,
        ...extra,
      },
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  w.dir = dir;
  return wt;
}

test('reclaim needs a merged PR and no newer commit', () => {
  classifierWorld();
  w.gh('17 2999-01-01T00:00:00Z');
  assert.deepEqual(w.classify(), { verdict: 'reclaim', reason: 'PR #17 merged 2999-01-01T00:00:00Z' });
  w.gh('17 2000-01-01T00:00:00Z');
  assert.match(w.classify().reason, /a commit is newer than the merge of #17/);
  w.gh('');
  assert.deepEqual(w.classify(), { verdict: 'keep', reason: 'no merged pull request for feat' });
  w.gh(null);
  assert.equal(w.classify().verdict, 'keep');
});

test('reclaim never applies to a dirty checkout or the main checkout', () => {
  const wt = classifierWorld();
  w.gh('17 2999-01-01T00:00:00Z');
  writeFileSync(join(wt, 'notes.txt'), 'unsaved work\n');
  assert.deepEqual(w.classify(), { verdict: 'keep', reason: 'uncommitted or untracked files' });
  assert.deepEqual(w.classify(w.repo), { verdict: 'keep', reason: 'the main checkout' });
});

test('activity-since, when enabled, keeps a worktree with a newer session', () => {
  const wt = classifierWorld();
  w.gh('17 2000-01-01T00:00:00Z');
  // Make HEAD older than the merge, so only activity can say keep.
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--amend', '--allow-empty', '--no-edit', '--date=1999-01-01T00:00:00Z'], {
    cwd: wt, env: { ...process.env, GIT_COMMITTER_DATE: '1999-01-01T00:00:00Z' },
  });
  const hook = join(w.dir, 'activity-since');
  cpSync(join(w.dir, 'activity-since.example'), hook);
  chmodSync(hook, 0o755);
  const sessions = join(w.root, 'sessions', 'project');
  mkdirSync(sessions, { recursive: true });
  const env = { AGENT_SESSION_DIRS: join(w.root, 'sessions') };
  assert.equal(w.classify(wt, env).verdict, 'reclaim');
  // A log that mentions the path, and a session in a sibling whose path
  // starts with the same text, are not activity in this checkout.
  writeFileSync(join(sessions, 'tool.log'), `ls ${wt}\n`);
  writeFileSync(join(sessions, 'other.jsonl'), `${JSON.stringify({ type: 'note', text: `see ${wt}` })}\n${JSON.stringify({ cwd: `${wt}-2` })}\n`);
  assert.equal(w.classify(wt, env).verdict, 'reclaim');
  writeFileSync(join(sessions, 's.jsonl'), `${JSON.stringify({ type: 'session', cwd: join(wt, 'src') })}\n`);
  const v = w.classify(wt, env);
  assert.equal(v.verdict, 'keep');
  assert.match(v.reason, /a session started .*s\.jsonl/);
});
