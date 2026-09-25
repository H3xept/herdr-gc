// Config discovery, snapshots and trust, through the CLI so that each case
// gets its own state directory.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { makeWorld } from './fixture.mjs';

let w;
afterEach(() => w?.cleanup());

const CONFIG = `version = 1
[[step]]
name = "mark"
on = "open"
run = 'echo "$HERDR_GC_DIR" > "$HERDR_GC_WORKTREE/../ran-from"; cat "$HERDR_GC_DIR/payload.txt" >> "$HERDR_GC_WORKTREE/../ran-from"'
`;

test('the nearest .herdr-gc wins over the repo root', () => {
  w = makeWorld();
  const wt = w.addWorktree('feat');
  w.writeConfig(w.repo, { 'config.toml': 'version = 1\n' });
  const near = w.writeConfig(join(w.root, 'wts'), { 'config.toml': CONFIG, 'payload.txt': 'v1\n' });
  const out = w.gc(['check', wt]).stdout;
  assert.match(out, new RegExp(`config +${near}`));
  // The main checkout has its own folder, which is nearer for it.
  assert.match(w.gc(['check', w.repo]).stdout, new RegExp(`config +${join(w.repo, '.herdr-gc')}`));
});

test('a changed folder needs trust again, and steps run from the trusted snapshot', async () => {
  w = makeWorld();
  const wt = w.addWorktree('feat');
  const dir = w.writeConfig(join(w.root, 'wts'), { 'config.toml': CONFIG, 'payload.txt': 'v1\n' });
  assert.equal(w.gc(['trust', dir]).code, 0);
  assert.equal(JSON.parse(w.gc(['run', 'open', wt]).code), 0);
  const { readFileSync } = await import('node:fs');
  const [snapshot, payload] = readFileSync(join(w.root, 'wts', 'ran-from'), 'utf8').split('\n');
  assert.ok(snapshot.startsWith(w.state), `steps must see the snapshot, not ${snapshot}`);
  assert.equal(payload, 'v1');

  // Any byte in any file of the folder counts, not only config.toml.
  writeFileSync(join(dir, 'payload.txt'), 'v2\n');
  const r = w.gc(['run', 'open', wt]);
  assert.match(r.stdout, /blocked: .* is not trusted; nothing ran/);
  assert.equal(JSON.parse(w.gc(['pending', '--json']).stdout).length, 1);
});

test('a symlink inside .herdr-gc is refused', () => {
  w = makeWorld();
  const dir = w.writeConfig(w.repo, { 'config.toml': CONFIG });
  mkdirSync(join(w.root, 'elsewhere'));
  writeFileSync(join(w.root, 'elsewhere', 'script.sh'), 'echo hi\n');
  symlinkSync(join(w.root, 'elsewhere', 'script.sh'), join(dir, 'script.sh'));
  const r = w.gc(['trust', dir]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /symlinks are not allowed/);
  assert.equal(w.gc(['trusted']).stdout, '');
});

test('an invalid config cannot be trusted, and a run reports every problem', () => {
  w = makeWorld();
  const dir = w.writeConfig(w.repo, { 'config.toml': 'version = 1\n[[step]]\nname = "x"\non = "opne"\nrun = "true"\nmdoe = "auto"\n' });
  const t = w.gc(['trust', dir]);
  assert.equal(t.code, 1);
  assert.match(t.stderr, /unknown event "opne"/);
  assert.match(t.stderr, /unknown key "mdoe"/);
  const r = w.gc(['run', 'open', w.repo]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /config error/);
});

test('HERDR_GC_TRUST=all in config.env skips trust', () => {
  w = makeWorld();
  const wt = w.addWorktree('feat');
  w.writeConfig(join(w.root, 'wts'), { 'config.toml': CONFIG, 'payload.txt': 'v1\n' });
  mkdirSync(w.config, { recursive: true });
  writeFileSync(join(w.config, 'config.env'), 'HERDR_GC_TRUST=all\n');
  const r = w.gc(['run', 'open', wt]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /mark: .*\n +ok/);
});
