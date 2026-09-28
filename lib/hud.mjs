// The HUD popup: pending suggestions on top, recent runs below, and the
// selected item's details and log at the bottom.
//
// The HUD is a view. Every key here calls the same function a CLI verb calls
// (accept, dismiss, trust, run-step), so nothing is possible only from the
// popup.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadConfig } from './config.mjs';
import { ago, commonSteps } from './model.mjs';
import {
  accept, dismiss, label, openWorkspacesOn, queueNamedStep, spawnWorker, stepsFor,
} from './runner.mjs';
import { listRuns, listSuggestions, logPath, setTrust } from './state.mjs';

const TICK_MS = 2_000;
const RECENT_RUNS = 40;

const ESC = '\x1b';
const sgr = (...codes) => `${ESC}[${codes.join(';')}m`;
const RESET = sgr(0);
const BOLD = sgr(1);
const DIM = sgr(2);
const RED = sgr(31);
const GREEN = sgr(32);
const YELLOW = sgr(33);
const CYAN = sgr(36);

const STATE_STYLE = {
  done: { glyph: '✓', color: GREEN },
  failed: { glyph: '✗', color: RED },
  blocked: { glyph: '!', color: YELLOW },
  skipped: { glyph: '–', color: DIM },
  running: { glyph: '◐', color: CYAN },
  queued: { glyph: '…', color: DIM },
  interrupted: { glyph: '✗', color: YELLOW },
};

function fit(text, cols) {
  const chars = [...String(text ?? '')];
  if (cols <= 0) return '';
  if (chars.length > cols) return `${chars.slice(0, Math.max(0, cols - 1)).join('')}…`;
  return chars.join('') + ' '.repeat(cols - chars.length);
}

const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

function tail(file, n) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}

function suggestionText(s) {
  if (s.kind === 'event') return `trust needed · replay ${s.event}`;
  return `${s.step}${s.verdict ? ` · ${s.verdict}` : ''}`;
}

export async function runHud() {
  const out = process.stdout;
  let items = [];
  let selected = 0;
  let status = '';
  let busy = false;
  let confirm = null; // { text, action }
  let picker = null; // { targets, steps, index }: choosing a step to run
  const marked = new Map(); // checkout path -> target, marked with space

  function load() {
    const key = items[selected]?.key;
    const pending = listSuggestions().reverse().map((s) => ({ key: `s:${s.id}`, type: 'suggestion', s }));
    const runs = listRuns().slice(0, RECENT_RUNS).map((r) => ({ key: `r:${r.id}`, type: 'run', r }));
    items = [...pending, ...runs];
    const again = items.findIndex((i) => i.key === key);
    selected = again >= 0 ? again : Math.min(selected, Math.max(0, items.length - 1));
  }

  function render() {
    const cols = out.columns || 100;
    const rows = out.rows || 30;
    if (picker) { renderPicker(cols, rows); return; }
    const lines = [];
    const pendingCount = items.filter((i) => i.type === 'suggestion').length;
    const markedText = marked.size ? `  ${CYAN}${marked.size} marked${RESET}` : '';
    lines.push(`${BOLD} herdr-gc${RESET}  ${pendingCount ? `${YELLOW}${pendingCount} pending${RESET}` : `${DIM}nothing pending${RESET}`}${markedText}`);
    lines.push(`${DIM} y accept · d dismiss · t trust · space mark · x run a step · r reload · j/k move · q close${RESET}`);
    lines.push('');
    const listRows = Math.max(3, Math.floor((rows - 6) / 2));
    const top = Math.max(0, Math.min(selected - Math.floor(listRows / 2), items.length - listRows));
    for (let i = top; i < Math.min(items.length, top + listRows); i++) {
      const it = items[i];
      const cursor = i === selected ? `${BOLD}›${RESET}` : ' ';
      const mark = `${cursor}${marked.has(targetOf(it).path) ? `${CYAN}●${RESET}` : ' '}`;
      let line;
      if (it.type === 'suggestion') {
        const s = it.s;
        line = `${YELLOW}?${RESET} ${fit(label(s.path), 24)} ${fit(s.event, 7)} ${fit(suggestionText(s), cols - 50)} ${DIM}${ago(s.createdAt)}${RESET}`;
      } else {
        const r = it.r;
        const st = STATE_STYLE[r.state] ?? STATE_STYLE.queued;
        const ran = (r.steps ?? []).filter((x) => x.action === 'run').map((x) => `${x.ok ? '' : '✗'}${x.name}`).join(', ');
        line = `${st.color}${st.glyph}${RESET} ${fit(label(r.path), 24)} ${fit(r.event, 7)} ${fit(`${r.state}${r.verdict ? ` · ${r.verdict}` : ''}${ran ? ` · ${ran}` : ''}`, cols - 50)} ${DIM}${ago(r.createdAt)}${RESET}`;
      }
      lines.push(`${mark}${line}`);
    }
    if (items.length === 0) lines.push(`${DIM}  no runs yet: herdr-gc acts when a worktree is created, opened, closed or removed${RESET}`);
    lines.push(`${DIM}${'─'.repeat(cols)}${RESET}`);
    const it = items[selected];
    // [style, text]: the text is cut to the width before the style is added,
    // so escape codes never count against it.
    const detail = [];
    if (it?.type === 'suggestion') {
      const s = it.s;
      detail.push([BOLD, `${s.kind === 'event' ? `replay the ${s.event} event` : `run step "${s.step}"`} for ${tilde(s.path)}`]);
      if (s.description) detail.push(['', s.description]);
      if (s.verdict) detail.push(['', `verdict ${s.verdict}${s.reason ? `: ${s.reason}` : ''}`]);
      detail.push([DIM, `config ${tilde(s.configDir)} · id ${s.id}`]);
      if (s.kind === 'event') detail.push([YELLOW, `The config is new or changed. Review ${tilde(s.configDir)}/config.toml, then t to trust it.`]);
    } else if (it?.type === 'run') {
      const r = it.r;
      detail.push([BOLD, `${r.event} ${tilde(r.path)} (${r.trigger}, ${r.id})`]);
      if (r.verdict) detail.push(['', `verdict ${r.verdict}${r.reason ? `: ${r.reason}` : ''}`]);
      if (r.note) detail.push(['', r.note]);
      for (const line of tail(logPath(r.id), 200)) detail.push([DIM, line]);
    }
    const room = rows - lines.length - 1;
    for (const [style, text] of detail.slice(-room)) lines.push(`${style}${fit(text, cols).trimEnd()}${RESET}`);
    finish(lines, rows);
  }

  function finish(lines, rows) {
    while (lines.length < rows - 1) lines.push('');
    lines.push(confirm ? `${YELLOW}${confirm.text} y/n${RESET}` : busy ? `${CYAN}${status}${RESET}` : status);
    out.write(`${ESC}[H${lines.map((l) => `${l}${ESC}[K`).join('\n')}${ESC}[J`);
  }

  function renderPicker(cols, rows) {
    const { targets, steps, index } = picker;
    const lines = [
      `${BOLD} herdr-gc${RESET}  run a step for ${targets.length === 1 ? tilde(targets[0].path) : `${targets.length} worktrees: ${targets.map((t) => label(t.path)).join(', ')}`}`,
      `${DIM} enter/y choose · j/k move · esc cancel · the classifier does not run${RESET}`,
      '',
    ];
    steps.forEach((s, i) => {
      const mark = i === index ? `${BOLD}›${RESET}` : ' ';
      lines.push(`${mark} ${fit(s.name, 28)} ${fit(s.mode, 8)} ${DIM}${fit(s.on.join(', '), cols - 42).trimEnd()}${RESET}`);
    });
    lines.push(`${DIM}${'─'.repeat(cols)}${RESET}`);
    const s = steps[index];
    const detail = [[BOLD, s.name]];
    if (s.description) detail.push(['', s.description]);
    if (s.when) detail.push(['', `normally needs the verdict ${s.when.join('|')}`]);
    detail.push([DIM, s.run]);
    const room = rows - lines.length - 1;
    for (const [style, text] of detail.slice(0, room)) lines.push(`${style}${fit(text, cols).trimEnd()}${RESET}`);
    finish(lines, rows);
  }

  function targetOf(it) {
    const src = it.type === 'suggestion' ? it.s : it.r;
    return { path: src.path, repoRoot: src.repoRoot ?? '', branch: src.branch ?? '', linked: Boolean(src.linked), workspaceId: '' };
  }

  function toggleMark(it) {
    const target = targetOf(it);
    if (marked.delete(target.path)) return;
    if (!existsSync(target.path)) { status = `${label(target.path)}: the checkout is gone`; return; }
    marked.set(target.path, target);
  }

  // The marked worktrees, or the one under the cursor. The picker offers the
  // steps that every one of their trusted configs has.
  function openPicker(it) {
    const targets = marked.size ? [...marked.values()] : [targetOf(it)];
    const lists = [];
    for (const target of targets) {
      if (!existsSync(target.path)) { status = `${label(target.path)}: the checkout is gone`; return; }
      try {
        lists.push(stepsFor(target).steps);
      } catch (e) {
        status = `${label(target.path)}: ${e.message.split('\n')[0]}`;
        return;
      }
    }
    const steps = commonSteps(lists);
    if (steps.length === 0) {
      status = targets.length === 1 ? `${label(targets[0].path)}: its config has no steps` : 'the marked worktrees share no step';
      return;
    }
    picker = { targets, steps, index: 0 };
    status = '';
  }

  // Asks herdr which workspaces have each checkout open, then asks you. If
  // herdr cannot answer, nothing runs.
  async function chooseStep() {
    const { targets, steps, index } = picker;
    const step = steps[index];
    picker = null;
    busy = true;
    const what = targets.length === 1 ? label(targets[0].path) : `${targets.length} worktrees`;
    status = `asking herdr whether ${what} ${targets.length === 1 ? 'is' : 'are'} open…`;
    render();
    let open;
    try {
      open = await Promise.all(targets.map((t) => openWorkspacesOn(t.path)));
    } catch (e) {
      busy = false;
      status = `cannot ask herdr which workspaces are open: ${e.message}; nothing ran`;
      render();
      return;
    }
    busy = false;
    status = '';
    const jobs = targets.map((target, i) => ({ target, close: open[i].length > 0 }));
    const where = open.flat().map((w) => w.label).join(', ');
    confirm = {
      text: where
        ? `close ${where}, then run "${step.name}" for ${what} (no classifier)?`
        : `run "${step.name}" for ${what} (no classifier)?`,
      action: () => doRunStep(jobs, step.name),
    };
    render();
  }

  // One detached worker per worktree runs the step: closing a workspace can
  // end this popup.
  function doRunStep(jobs, name) {
    const failed = [];
    let queued = 0;
    for (const { target, close } of jobs) {
      try {
        spawnWorker(queueNamedStep(target, name, { close }));
        queued++;
      } catch (e) {
        failed.push(`${label(target.path)}: ${e.message.split('\n')[0]}`);
      }
    }
    marked.clear();
    status = `queued "${name}" for ${queued} worktree${queued === 1 ? '' : 's'}${failed.length ? `; cannot run ${failed.join('; ')}` : ''}`;
    load();
    render();
  }

  function onPickerKey(key) {
    switch (key) {
      case 'q': case '\x1b': case '\x03': picker = null; status = 'cancelled'; break;
      case 'j': case '\x1b[B': picker.index = Math.min(picker.steps.length - 1, picker.index + 1); break;
      case 'k': case '\x1b[A': picker.index = Math.max(0, picker.index - 1); break;
      case '\r': case 'y': chooseStep(); return;
      default: return;
    }
    render();
  }

  async function doAccept(s) {
    busy = true;
    status = `running ${s.kind === 'event' ? s.event : s.step} for ${label(s.path)}…`;
    render();
    try {
      const r = await accept(s.id);
      status = r.message;
    } catch (e) {
      status = `failed: ${e.message}`;
    }
    busy = false;
    load();
    render();
  }

  function doTrust(s) {
    try {
      const cfg = loadConfig(s.configDir);
      setTrust(cfg.configDir, cfg.hash);
      status = `trusted ${tilde(cfg.configDir)}; y replays the ${s.event} event`;
    } catch (e) {
      status = `cannot trust: ${e.message.split('\n')[0]}`;
    }
    load();
    render();
  }

  out.write(`${ESC}[?1049h${ESC}[?25l`);
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  load();
  render();
  const timer = setInterval(() => { if (!busy) { load(); render(); } }, TICK_MS);
  out.on('resize', render);

  return new Promise((resolve) => {
    let closed = false;
    const quit = () => {
      closed = true;
      clearInterval(timer);
      if (stdin.isTTY) stdin.setRawMode(false);
      out.write(`${ESC}[?25h${ESC}[?1049l`);
      resolve(0);
    };
    // One chunk can hold several keys (typed fast, or pasted); an arrow key
    // is one three-byte escape sequence.
    const keysOf = (chunk) => chunk.toString().match(/\x1b\[[A-D]|[\s\S]/g) ?? [];
    stdin.on('data', (chunk) => { for (const key of keysOf(chunk)) onKey(key); });
    function onKey(key) {
      if (closed) return;
      if (confirm) {
        const c = confirm;
        confirm = null;
        if (key === 'y') c.action();
        else { status = 'cancelled'; render(); }
        return;
      }
      if (busy) {
        if (key === 'q' || key === '\x1b' || key === '\x03') { status = 'wait: a step is running'; render(); }
        return;
      }
      if (picker) { onPickerKey(key); return; }
      const it = items[selected];
      switch (key) {
        case 'q': case '\x1b': case '\x03': quit(); return;
        case 'j': case '\x1b[B': selected = Math.min(items.length - 1, selected + 1); break;
        case 'k': case '\x1b[A': selected = Math.max(0, selected - 1); break;
        case 'g': selected = 0; break;
        case 'G': selected = Math.max(0, items.length - 1); break;
        case 'r': load(); status = 'reloaded'; break;
        case 'y':
          if (it?.type === 'suggestion') {
            const s = it.s;
            confirm = { text: s.kind === 'event' ? `replay ${s.event} for ${label(s.path)}?` : `run "${s.step}" for ${label(s.path)}?`, action: () => doAccept(s) };
          }
          break;
        case 'd':
          if (it?.type === 'suggestion') { status = dismiss(it.s.id) ? 'dismissed' : 'already gone'; load(); }
          break;
        case 't':
          if (it?.type === 'suggestion') {
            const s = it.s;
            confirm = { text: `trust ${tilde(s.configDir)} as it is now?`, action: () => doTrust(s) };
          }
          break;
        case ' ':
          if (it) {
            toggleMark(it);
            selected = Math.min(items.length - 1, selected + 1);
          }
          break;
        case 'x':
          if (it) openPicker(it);
          break;
        default:
          return;
      }
      render();
    }
  });
}
