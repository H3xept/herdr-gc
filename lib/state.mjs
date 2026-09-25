// Files in the plugin state directory. Every write is atomic (temp file, then
// rename). Shared data is split into one file per item, so two workers on two
// worktrees never rewrite the same file:
//
//   worktrees/<id>.json      one record per checkout, written under its lock
//   runs/<run>.json          one record per run; logs/<run>.log its output
//   suggestions/<sid>.json   one pending suggestion; accept claims it by rename
//   trust/<hash>.json        one trusted .herdr-gc folder and its content hash
//   snapshots/<hash>/        a content-addressed copy of a trusted folder
//   locks/<id>.lock          the per-worktree lock, created with O_EXCL
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { stateDir } from './env.mjs';

export function sub(name) {
  const dir = join(stateDir(), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(target, value) {
  const tmp = `${target}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, target);
}

export function readJson(target) {
  try { return JSON.parse(readFileSync(target, 'utf8')); } catch { return null; }
}

const listJson = (dir) => readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, f))).filter(Boolean);

export const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// --- worktree records --------------------------------------------------------

export const recordPath = (id) => join(sub('worktrees'), `${id}.json`);
export const readRecord = (id) => readJson(recordPath(id));
export const writeRecord = (record) => writeJson(recordPath(record.id), record);
export const listRecords = () => listJson(sub('worktrees'));

// --- runs --------------------------------------------------------------------

const MAX_RUNS = 300;

export const runPath = (id) => join(sub('runs'), `${id}.json`);
export const logPath = (id) => join(sub('logs'), `${id}.log`);
export const readRun = (id) => readJson(runPath(id));
export const writeRun = (run) => writeJson(runPath(run.id), run);

/** Runs, newest first. */
export function listRuns() {
  return listJson(sub('runs')).sort((a, b) => b.createdAt - a.createdAt);
}

/** Keeps the newest MAX_RUNS runs and their logs. */
export function pruneRuns() {
  for (const run of listRuns().slice(MAX_RUNS)) {
    if (run.state === 'running' || run.state === 'queued') continue;
    rmSync(runPath(run.id), { force: true });
    rmSync(logPath(run.id), { force: true });
  }
}

// --- suggestions -------------------------------------------------------------

const suggestionFile = (id) => join(sub('suggestions'), `${id}.json`);

export function addSuggestion(s) {
  const item = { id: newId(), createdAt: Date.now(), ...s };
  writeJson(suggestionFile(item.id), item);
  return item;
}

/** Pending suggestions, oldest first. */
export function listSuggestions() {
  return listJson(sub('suggestions')).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Takes a suggestion out of the queue. The rename is atomic, so when two
 * acceptors race, exactly one gets the item and the other gets null.
 */
export function claimSuggestion(id) {
  const from = suggestionFile(id);
  const to = join(sub('claimed'), `${id}.${process.pid}.json`);
  try { renameSync(from, to); } catch { return null; }
  const item = readJson(to);
  return item ? { item, file: to } : null;
}

export function releaseClaim(claim, { requeue }) {
  if (requeue) {
    try { renameSync(claim.file, suggestionFile(claim.item.id)); return; } catch { /* fall through */ }
  }
  rmSync(claim.file, { force: true });
}

/** Drops pending suggestions that match; returns how many went. */
export function dropSuggestions(match) {
  let n = 0;
  for (const s of listSuggestions()) {
    if (!match(s)) continue;
    const claim = claimSuggestion(s.id);
    if (claim) { releaseClaim(claim, { requeue: false }); n++; }
  }
  return n;
}

// --- trust -------------------------------------------------------------------

const trustFile = (dir) => join(sub('trust'), `${createHash('sha256').update(dir).digest('hex').slice(0, 16)}.json`);

export const trustedHash = (dir) => readJson(trustFile(dir))?.hash ?? null;
export const setTrust = (dir, hash) => writeJson(trustFile(dir), { dir, hash, at: Date.now() });
export function removeTrust(dir) {
  try { unlinkSync(trustFile(dir)); return true; } catch { return false; }
}
export const listTrust = () => listJson(sub('trust'));

// --- locks -------------------------------------------------------------------
//
// One lock per worktree: a file created with O_EXCL that holds the owner's
// pid. A lock whose pid is dead is stale and is taken over. This serializes
// the runs of one worktree (herdr starts the `close` and `remove` hooks of a
// `worktree remove` at the same time); it does not order them.

export async function lock(id, { timeoutMs = 2 * 3_600_000, onWait } = {}) {
  const file = join(sub('locks'), `${id}.lock`);
  const deadline = Date.now() + timeoutMs;
  let told = false;
  for (;;) {
    try {
      const fd = openSync(file, 'wx');
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => {
        if (Number.parseInt(readFileSync(file, 'utf8'), 10) === process.pid) rmSync(file, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let owner = NaN;
    try { owner = Number.parseInt(readFileSync(file, 'utf8'), 10); } catch { continue; }
    // A lock file younger than a second may not have its pid written yet.
    let young = false;
    try { young = Date.now() - statSync(file).mtimeMs < 1000; } catch { continue; }
    if (!alive(owner) && !young) {
      // Move the stale file aside atomically, then make sure it was the one
      // judged stale. If another process took the lock in between, put its
      // file back.
      const aside = `${file}.${process.pid}.stale`;
      try { renameSync(file, aside); } catch { continue; }
      let moved = NaN;
      try { moved = Number.parseInt(readFileSync(aside, 'utf8'), 10); } catch { /* gone */ }
      if (moved !== owner) { try { linkSync(aside, file); } catch { /* retaken */ } }
      rmSync(aside, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`worktree is busy (lock held by pid ${owner})`);
    if (!told && onWait) { onWait(owner); told = true; }
    await sleep(250);
  }
}
