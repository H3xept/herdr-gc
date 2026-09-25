// Finding, hashing and snapshotting a `.herdr-gc/` folder.
//
// herdr-gc never runs a command out of the folder itself. It reads every file
// once, hashes those bytes, and writes the same bytes to a content-addressed
// snapshot. Trust is checked against that hash, and commands run from the
// snapshot, so an edit made after the check cannot slip into a run. The
// snapshot also outlives the checkout, which the `remove` event needs.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { settings } from './env.mjs';
import { ConfigError, validateConfig } from './model.mjs';
import { sub, trustedHash } from './state.mjs';
import { TomlError, parseToml } from './toml.mjs';

export const FOLDER = '.herdr-gc';
const MAX_FILES = 256;
const MAX_BYTES = 4 * 1024 * 1024;

const hasConfig = (dir) => {
  try { return statSync(join(dir, FOLDER, 'config.toml')).isFile(); } catch { return false; }
};

/**
 * The folder that applies to a checkout: the nearest `.herdr-gc/config.toml`
 * in the checkout or an ancestor, then the repo root's. The search stops at
 * the home directory, or below the filesystem root for paths outside home.
 * The checkout may be gone (the `remove` event); the search then starts at
 * its nearest existing ancestor.
 */
export function findConfigDir(path, repoRoot = '') {
  const home = homedir();
  let dir = path;
  for (;;) {
    if (hasConfig(dir)) return join(dir, FOLDER);
    const parent = dirname(dir);
    if (dir === home || parent === dir || dirname(parent) === parent) break;
    dir = parent;
  }
  if (repoRoot && hasConfig(repoRoot)) return join(repoRoot, FOLDER);
  return null;
}

/** Every regular file under `dir`, read once. Symlinks are refused. */
function readTree(dir) {
  const files = [];
  let bytes = 0;
  const walk = (at) => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name);
      const rel = relative(dir, full);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) throw new ConfigError([`${FOLDER}/${rel}: symlinks are not allowed in ${FOLDER}`]);
      if (st.isDirectory()) { walk(full); continue; }
      if (!st.isFile()) throw new ConfigError([`${FOLDER}/${rel}: only regular files are allowed`]);
      const content = readFileSync(full);
      bytes += content.length;
      files.push({ rel: rel.split(sep).join('/'), exec: (st.mode & 0o111) !== 0, content });
      if (files.length > MAX_FILES || bytes > MAX_BYTES) {
        throw new ConfigError([`${FOLDER} is too large (at most ${MAX_FILES} files and ${MAX_BYTES / 1048576} MiB)`]);
      }
    }
  };
  walk(dir);
  return files;
}

function hashTree(files) {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(`${f.rel}\0${f.exec ? 'x' : '-'}\0${f.content.length}\0`);
    h.update(f.content);
  }
  return h.digest('hex');
}

export const snapshotDir = (hash) => join(sub('snapshots'), hash.slice(0, 24));

function writeSnapshot(files, hash) {
  const target = snapshotDir(hash);
  if (existsSync(target)) return target;
  const tmp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  for (const f of files) {
    const out = join(tmp, ...f.rel.split('/'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, f.content);
    chmodSync(out, f.exec ? 0o755 : 0o644);
  }
  try { renameSync(tmp, target); } catch { rmSync(tmp, { recursive: true, force: true }); }
  return target;
}

function parse(text, where) {
  try {
    return validateConfig(parseToml(text));
  } catch (e) {
    if (e instanceof TomlError) throw new ConfigError([`${where}: ${e.message}`]);
    if (e instanceof ConfigError) throw new ConfigError(e.problems.map((p) => `${where}: ${p}`));
    throw e;
  }
}

/**
 * Reads a folder into a snapshot and parses its config. Throws ConfigError
 * with every problem found.
 */
export function loadConfig(configDir) {
  const files = readTree(configDir);
  const main = files.find((f) => f.rel === 'config.toml');
  if (!main) throw new ConfigError([`${join(configDir, 'config.toml')}: missing`]);
  const hash = hashTree(files);
  const config = parse(main.content.toString('utf8'), join(configDir, 'config.toml'));
  return { configDir, hash, dir: writeSnapshot(files, hash), config };
}

/** A config from its snapshot, for a folder that no longer exists. */
export function loadSnapshot(configDir, hash) {
  const dir = snapshotDir(hash);
  const config = parse(readFileSync(join(dir, 'config.toml'), 'utf8'), join(configDir, 'config.toml'));
  return { configDir, hash, dir, config };
}

export function isTrusted(configDir, hash) {
  return settings().HERDR_GC_TRUST === 'all' || trustedHash(configDir) === hash;
}
