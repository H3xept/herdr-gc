// Pure rules, no I/O: config validation, the step plan, the classifier
// protocol, herdr event mapping, and `git worktree list` parsing. Tests run
// every rule here without git, herdr or a shell.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

export const EVENTS = ['create', 'open', 'close', 'remove', 'sweep'];
export const MODES = ['auto', 'suggest', 'manual'];

// The state a worktree must be in for an event of that kind to make sense.
// `accept` checks it again before it runs a queued suggestion.
export const EXPECTS = {
  create: 'present',
  open: 'present',
  close: 'closed',
  sweep: 'closed',
  remove: 'gone',
};

const DEFAULT_STEP_TIMEOUT = 10 * 60_000;
const DEFAULT_CLASSIFIER_TIMEOUT = 2 * 60_000;
const VERDICT = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const STEP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._:-]{0,63}$/;

export class ConfigError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.problems = problems;
  }
}

/** "90", "90s", "45m", "6h", "500ms" -> milliseconds; null for anything else. */
export function durationMs(text) {
  const m = /^(\d+)\s*(ms|s|m|h)?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[m[2] ?? 's'];
}

/**
 * Checks a parsed config.toml and returns the normalized config. Every
 * problem is collected, so one error message lists all of them. Unknown keys
 * are errors: a typo such as `mdoe = "suggest"` must not silently become an
 * `auto` step.
 */
export function validateConfig(raw) {
  const problems = [];
  const where = (kind, i, name) => `${kind} #${i + 1}${name ? ` ("${name}")` : ''}`;
  const unknown = (obj, allowed, label) => {
    for (const key of Object.keys(obj)) if (!allowed.includes(key)) problems.push(`${label}: unknown key "${key}"`);
  };
  const events = (value, label) => {
    const list = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(list) || list.length === 0 || !list.every((e) => typeof e === 'string')) {
      problems.push(`${label}: "on" must be an event name or a list of them`);
      return [];
    }
    for (const e of list) if (!EVENTS.includes(e)) problems.push(`${label}: unknown event "${e}" (use ${EVENTS.join(', ')})`);
    return [...new Set(list.filter((e) => EVENTS.includes(e)))];
  };
  const timeout = (value, fallback, label) => {
    if (value === undefined) return fallback;
    const ms = typeof value === 'number' ? value * 1000 : durationMs(value);
    if (!ms || ms <= 0) { problems.push(`${label}: bad timeout "${value}" (use 90s, 20m, 1h)`); return fallback; }
    return ms;
  };
  const command = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) { problems.push(`${label}: "run" must be a non-empty string`); return ''; }
    return value;
  };

  unknown(raw, ['version', 'classifier', 'step'], 'config');
  if (raw.version !== 1) problems.push('config: "version = 1" is required');

  const classifiers = {};
  const rawClassifiers = raw.classifier ?? [];
  if (!Array.isArray(rawClassifiers)) problems.push('config: use [[classifier]], not [classifier]');
  else rawClassifiers.forEach((c, i) => {
    const label = where('classifier', i);
    unknown(c, ['on', 'run', 'timeout'], label);
    const on = events(c.on, label);
    const entry = { run: command(c.run, label), timeoutMs: timeout(c.timeout, DEFAULT_CLASSIFIER_TIMEOUT, label) };
    for (const e of on) {
      if (classifiers[e]) problems.push(`${label}: event "${e}" already has a classifier`);
      else classifiers[e] = entry;
    }
  });

  const steps = [];
  const rawSteps = raw.step ?? [];
  if (!Array.isArray(rawSteps)) problems.push('config: use [[step]], not [step]');
  else rawSteps.forEach((s, i) => {
    const label = where('step', i, typeof s.name === 'string' ? s.name : '');
    unknown(s, ['name', 'description', 'on', 'run', 'mode', 'when', 'timeout', 'continue_on_error'], label);
    if (typeof s.name !== 'string' || !STEP_NAME.test(s.name)) {
      problems.push(`${label}: "name" is required: letters, digits, space, . _ : -, at most 64`);
    } else if (steps.some((o) => o.name === s.name)) {
      problems.push(`${label}: the name is used twice`);
    }
    const on = events(s.on, label);
    const mode = s.mode ?? 'auto';
    if (!MODES.includes(mode)) problems.push(`${label}: unknown mode "${mode}" (use ${MODES.join(', ')})`);
    let when = null;
    if (s.when !== undefined) {
      const list = typeof s.when === 'string' ? [s.when] : s.when;
      if (!Array.isArray(list) || list.length === 0 || !list.every((v) => typeof v === 'string' && VERDICT.test(v))) {
        problems.push(`${label}: "when" must be a verdict or a list of verdicts ([a-z0-9_-])`);
      } else {
        when = list;
        for (const e of on) {
          if (!classifiers[e]) problems.push(`${label}: "when" needs a classifier for event "${e}"`);
        }
      }
    }
    if (s.continue_on_error !== undefined && typeof s.continue_on_error !== 'boolean') {
      problems.push(`${label}: "continue_on_error" must be true or false`);
    }
    if (s.description !== undefined && typeof s.description !== 'string') problems.push(`${label}: "description" must be a string`);
    steps.push({
      name: s.name,
      description: s.description ?? '',
      on,
      run: command(s.run, label),
      mode,
      when,
      timeoutMs: timeout(s.timeout, DEFAULT_STEP_TIMEOUT, label),
      continueOnError: s.continue_on_error === true,
    });
  });

  if (problems.length) throw new ConfigError(problems);
  return { version: 1, classifiers, steps };
}

/**
 * What each step of `event` does, in file order, given the classifier's
 * verdict (null when the event has no classifier). A step whose `when` does
 * not hold the verdict is skipped; so is every gated step when the
 * classifier failed.
 */
export function planSteps(config, event, verdict) {
  const plan = [];
  for (const step of config.steps) {
    if (!step.on.includes(event)) continue;
    if (step.when && !step.when.includes(verdict)) {
      plan.push({ step, action: 'skip', why: `verdict is ${verdict ?? 'none'}, needs ${step.when.join('|')}` });
    } else if (step.mode === 'manual') {
      plan.push({ step, action: 'skip', why: 'manual step' });
    } else {
      plan.push({ step, action: step.mode === 'auto' ? 'run' : 'suggest', why: '' });
    }
  }
  return plan;
}

/**
 * The classifier protocol. The last non-empty stdout line is a bare verdict
 * or a JSON object {"verdict": "...", "reason": "..."}. A nonzero exit, a
 * timeout, or anything else gives the verdict `error`, which no `when` list
 * may name, so a broken classifier never unlocks a gated step.
 */
export function parseVerdict(stdout, { code = 0, timedOut = false } = {}) {
  if (timedOut) return { verdict: 'error', reason: 'classifier timed out' };
  if (code !== 0) return { verdict: 'error', reason: `classifier exited ${code}` };
  const last = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!last) return { verdict: 'error', reason: 'classifier printed nothing' };
  let verdict = last;
  let reason = '';
  if (last.startsWith('{')) {
    try {
      const obj = JSON.parse(last);
      verdict = obj.verdict;
      reason = typeof obj.reason === 'string' ? obj.reason.slice(0, 500) : '';
    } catch {
      return { verdict: 'error', reason: 'classifier printed bad JSON' };
    }
  }
  if (typeof verdict !== 'string' || !VERDICT.test(verdict) || verdict === 'error') {
    return { verdict: 'error', reason: `classifier printed an invalid verdict: ${String(verdict).slice(0, 40)}` };
  }
  return { verdict, reason };
}

/**
 * A herdr event envelope (HERDR_PLUGIN_EVENT_JSON) as a herdr-gc event, or
 * `{ ignore }` with the reason. `close` also needs the checkout to exist and
 * no other workspace on it; the worker checks those, not this function.
 */
export function fromHerdrEvent(envelope) {
  const data = envelope?.data ?? {};
  switch (envelope?.event) {
    case 'worktree_created':
    case 'worktree_opened': {
      if (data.already_open) return { ignore: 'worktree was already open' };
      const wt = data.worktree;
      if (!wt?.path) return { ignore: 'no worktree in event' };
      if (wt.is_bare) return { ignore: 'bare repository' };
      return {
        event: envelope.event === 'worktree_created' ? 'create' : 'open',
        path: wt.path,
        branch: wt.branch ?? '',
        linked: Boolean(wt.is_linked_worktree),
        repoRoot: data.workspace?.worktree?.repo_root ?? '',
        workspaceId: data.workspace?.workspace_id ?? '',
      };
    }
    case 'workspace_closed': {
      const wt = data.workspace?.worktree;
      if (!wt?.checkout_path) return { ignore: 'workspace has no worktree' };
      return {
        event: 'close',
        path: wt.checkout_path,
        branch: '',
        linked: Boolean(wt.is_linked_worktree),
        repoRoot: wt.repo_root ?? '',
        workspaceId: data.workspace_id ?? data.workspace?.workspace_id ?? '',
      };
    }
    case 'worktree_removed': {
      const wt = data.worktree;
      if (!wt?.path) return { ignore: 'no worktree in event' };
      return {
        event: 'remove',
        path: wt.path,
        branch: wt.branch ?? '',
        // worktree_removed carries no is_linked_worktree; the workspace has it.
        linked: Boolean(wt.is_linked_worktree ?? data.workspace?.worktree?.is_linked_worktree),
        repoRoot: data.workspace?.worktree?.repo_root ?? '',
        workspaceId: data.workspace_id ?? '',
      };
    }
    default:
      return { ignore: `event ${envelope?.event ?? '(none)'} is not a lifecycle event` };
  }
}

/** The checkout paths that open herdr workspaces hold, minus one workspace. */
export function openCheckouts(workspaces, exceptWorkspaceId = '') {
  const out = new Set();
  for (const w of workspaces ?? []) {
    if (w.workspace_id === exceptWorkspaceId) continue;
    if (w.worktree?.checkout_path) out.add(w.worktree.checkout_path);
  }
  return out;
}

/** `git worktree list --porcelain` -> entries; the first is the main checkout. */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text).split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: '', head: '', bare: false, detached: false, prunable: false, locked: false };
      out.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line === 'detached') cur.detached = true;
    else if (line === 'prunable' || line.startsWith('prunable ')) cur.prunable = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  return out;
}

/** A stable, readable file name for a checkout path. */
export function worktreeId(path) {
  const slug = basename(path).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'root';
  return `${slug}-${createHash('sha256').update(path).digest('hex').slice(0, 10)}`;
}

/** The environment every classifier and step sees, on top of the user's. */
export function stepEnv({ event, path, branch, repoRoot, linked, workspaceId, dir, configDir, verdict, reason, step, trigger, runId }) {
  return {
    HERDR_GC_EVENT: event,
    HERDR_GC_WORKTREE: path,
    HERDR_GC_BRANCH: branch ?? '',
    HERDR_GC_REPO_ROOT: repoRoot ?? '',
    HERDR_GC_LINKED: linked ? '1' : '0',
    HERDR_GC_WORKSPACE_ID: workspaceId ?? '',
    HERDR_GC_DIR: dir,
    HERDR_GC_CONFIG_DIR: configDir,
    HERDR_GC_VERDICT: verdict ?? '',
    HERDR_GC_REASON: reason ?? '',
    HERDR_GC_STEP: step ?? '',
    HERDR_GC_TRIGGER: trigger,
    HERDR_GC_RUN_ID: runId ?? '',
  };
}

export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
