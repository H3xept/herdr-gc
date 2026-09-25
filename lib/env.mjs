// Plugin directories, settings, and the herdr binary.
//
// Everything the plugin needs about its own installation arrives in the
// environment herdr injects. The fallbacks name the same directories herdr
// would, so `bin/herdr-gc` run from a plain shell and the same verb run from a
// plugin action read and write the same state.
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || 'h3xept.herdr-gc';

const xdg = (key, ...fallback) => process.env[key] || join(homedir(), ...fallback);

export function configDir() {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR
    || join(xdg('XDG_CONFIG_HOME', '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function stateDir() {
  const dir = process.env.HERDR_PLUGIN_STATE_DIR
    || join(xdg('XDG_STATE_HOME', '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const herdrBin = () => process.env.HERDR_BIN_PATH || 'herdr';

/** True when herdr started this process (an action, a hook or a pane). */
export const insideHerdr = () => Boolean(process.env.HERDR_PLUGIN_ID);

export function pluginContext() {
  try { return JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}'); } catch { return {}; }
}

const DEFAULTS = {
  // `ask`: run nothing from a .herdr-gc folder until `herdr-gc trust` approves
  // its exact content. `all`: trust every folder (you accept that any repo
  // you open can run commands).
  HERDR_GC_TRUST: 'ask',
  // `all`: a notification for every run that did something. `attention`:
  // only failures, new suggestions and untrusted configs. `off`: none.
  HERDR_GC_NOTIFY: 'all',
  // How many linked worktrees `sweep` classifies at once.
  HERDR_GC_SWEEP_JOBS: '4',
};

// config.env is KEY=value, one per line, # comments. Environment variables of
// the same name win, so a one-off run can override a setting.
export function settings() {
  const out = { ...DEFAULTS };
  let text = '';
  try { text = readFileSync(join(configDir(), 'config.env'), 'utf8'); } catch { /* no file */ }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  for (const key of Object.keys(DEFAULTS)) {
    if (process.env[key]) out[key] = process.env[key];
  }
  return out;
}
