// Release contract: package.json is the one version source, herdr-plugin.toml
// has to repeat it, and the code's fallback plugin id has to match the
// manifest's, or a verb run from a plain shell reads another plugin's state.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseToml } from '../lib/toml.mjs';

const root = new URL('..', import.meta.url);
const PKG = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const MANIFEST = parseToml(readFileSync(new URL('herdr-plugin.toml', root), 'utf8'));

function withoutHerdrEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('HERDR_')) delete env[key];
  return env;
}

test('herdr-plugin.toml carries the package.json version', () => {
  assert.equal(MANIFEST.version, PKG.version);
});

test('herdr-gc version prints the package.json version', () => {
  const out = execFileSync(process.execPath, [new URL('bin/herdr-gc', root).pathname, 'version'], {
    encoding: 'utf8',
    env: withoutHerdrEnv(),
  });
  assert.equal(out.trim(), PKG.version);
});

test('the fallback plugin id outside herdr is the manifest id', () => {
  const out = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { PLUGIN_ID } from ${JSON.stringify(new URL('lib/env.mjs', root).href)}; process.stdout.write(PLUGIN_ID);`,
  ], { encoding: 'utf8', env: withoutHerdrEnv() });
  assert.equal(out, MANIFEST.id);
});

test('the manifest hooks every herdr lifecycle event herdr-gc maps', () => {
  const hooked = MANIFEST.events.filter((e) => e.command.join(' ') === 'node bin/herdr-gc hook').map((e) => e.on).sort();
  assert.deepEqual(hooked, ['workspace.closed', 'worktree.created', 'worktree.opened', 'worktree.removed']);
});
