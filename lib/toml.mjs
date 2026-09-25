// A strict subset of TOML 1.0, enough for `.herdr-gc/config.toml`.
//
// Supported: comments, `[table]` and `[[array.of.tables]]` headers with bare or
// quoted dotted keys, `key = value` with bare, quoted or dotted keys, basic
// strings ("…" with escapes), literal strings ('…'), multi-line basic and
// literal strings, integers, booleans, and arrays (which may span lines and
// end with a comma). Floats, dates, inline tables and redefinitions are
// rejected with the line number, so a config never means something other than
// what it says.

export class TomlError extends Error {
  constructor(message, line) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

const BARE = /[A-Za-z0-9_-]/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };

export function parseToml(text) {
  const src = text.replace(/\r\n/g, '\n');
  let i = 0;
  let line = 1;
  const root = {};
  // Every [table] header seen; a second header for the same table is an
  // error, as in TOML.
  const defined = new Set();
  let current = root;

  const fail = (msg) => { throw new TomlError(msg, line); };
  const peek = () => src[i];
  const advance = () => { if (src[i] === '\n') line++; i++; };

  function skipSpace() { while (peek() === ' ' || peek() === '\t') i++; }
  function skipComment() { if (peek() === '#') while (i < src.length && peek() !== '\n') i++; }
  function skipBlank() {
    for (;;) {
      skipSpace();
      skipComment();
      if (peek() !== '\n') return;
      advance();
    }
  }
  function endOfLine() {
    skipSpace();
    skipComment();
    if (i < src.length && peek() !== '\n') fail(`unexpected "${peek()}"`);
  }

  function parseKeyPart() {
    if (peek() === '"') return parseBasicString();
    if (peek() === "'") return parseLiteralString();
    let s = '';
    while (i < src.length && BARE.test(peek())) s += src[i++];
    if (!s) fail(peek() === undefined ? 'expected a key' : `expected a key, got "${peek()}"`);
    return s;
  }
  function parseKey() {
    const parts = [parseKeyPart()];
    for (;;) {
      skipSpace();
      if (peek() !== '.') return parts;
      i++;
      skipSpace();
      parts.push(parseKeyPart());
    }
  }

  function parseEscape() {
    i++;
    const c = peek();
    if (c in ESCAPES) { i++; return ESCAPES[c]; }
    if (c === 'u' || c === 'U') {
      const n = c === 'u' ? 4 : 8;
      const hex = src.slice(i + 1, i + 1 + n);
      if (hex.length !== n || !/^[0-9A-Fa-f]+$/.test(hex)) fail('bad unicode escape');
      i += 1 + n;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    fail(`bad escape "\\${c ?? ''}"`);
  }

  function parseBasicString() {
    if (src.startsWith('"""', i)) return parseMultiBasic();
    i++;
    let s = '';
    for (;;) {
      const c = peek();
      if (c === undefined || c === '\n') fail('unterminated string');
      if (c === '"') { i++; return s; }
      if (c === '\\') { s += parseEscape(); continue; }
      s += c;
      i++;
    }
  }
  function parseMultiBasic() {
    i += 3;
    if (peek() === '\n') advance();
    let s = '';
    for (;;) {
      if (i >= src.length) fail('unterminated multi-line string');
      if (src.startsWith('"""', i)) {
        i += 3;
        // Up to two quotes may end the content right before the delimiter.
        for (let n = 0; n < 2 && peek() === '"'; n++) { s += '"'; i++; }
        return s;
      }
      if (peek() === '\\') {
        // A backslash at the end of a line trims the newline and the
        // whitespace that follows it.
        let j = i + 1;
        while (src[j] === ' ' || src[j] === '\t') j++;
        if (src[j] === '\n') {
          i = j;
          while (peek() === ' ' || peek() === '\t' || peek() === '\n') advance();
          continue;
        }
        s += parseEscape();
        continue;
      }
      s += peek();
      advance();
    }
  }
  function parseLiteralString() {
    if (src.startsWith("'''", i)) {
      i += 3;
      if (peek() === '\n') advance();
      let s = '';
      for (;;) {
        if (i >= src.length) fail('unterminated multi-line string');
        if (src.startsWith("'''", i)) {
          i += 3;
          for (let n = 0; n < 2 && peek() === "'"; n++) { s += "'"; i++; }
          return s;
        }
        s += peek();
        advance();
      }
    }
    i++;
    let s = '';
    for (;;) {
      const c = peek();
      if (c === undefined || c === '\n') fail('unterminated string');
      if (c === "'") { i++; return s; }
      s += c;
      i++;
    }
  }

  function parseValue() {
    const c = peek();
    if (c === '"') return parseBasicString();
    if (c === "'") return parseLiteralString();
    if (c === '[') return parseArray();
    if (c === '{') fail('inline tables are not supported; use a [table]');
    if (src.startsWith('true', i) && !BARE.test(src[i + 4] ?? '')) { i += 4; return true; }
    if (src.startsWith('false', i) && !BARE.test(src[i + 5] ?? '')) { i += 5; return false; }
    const m = /^[+-]?(0|[1-9](_?[0-9])*)(?=[\s#,\]]|$)/.exec(src.slice(i, i + 64));
    if (m) {
      i += m[0].length;
      const n = Number(m[0].replace(/_/g, ''));
      if (!Number.isSafeInteger(n)) fail('integer out of range');
      return n;
    }
    if (/[0-9+-]/.test(c ?? '')) fail('only integers are supported: no floats, dates or times');
    fail(c === undefined || c === '\n' ? 'expected a value' : `unsupported value starting with "${c}"`);
  }
  function parseArray() {
    i++;
    const out = [];
    for (;;) {
      skipBlank();
      if (peek() === ']') { i++; return out; }
      out.push(parseValue());
      skipBlank();
      if (peek() === ',') { i++; continue; }
      if (peek() === ']') { i++; return out; }
      fail(`expected "," or "]" in array, got "${peek() ?? 'end of file'}"`);
    }
  }

  const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // Walks `parts` from `base`, creating tables. An array of tables resolves to
  // its last element, as in TOML.
  function descend(base, parts) {
    let t = base;
    const path = [];
    for (const p of parts) {
      path.push(p);
      if (!(p in t)) t[p] = {};
      let next = t[p];
      if (Array.isArray(next)) {
        next = next[next.length - 1];
        if (!isTable(next)) fail(`"${path.join('.')}" is not a table`);
      } else if (!isTable(next)) {
        fail(`"${path.join('.')}" is already a value`);
      }
      t = next;
    }
    return t;
  }

  for (;;) {
    skipBlank();
    if (i >= src.length) break;
    if (peek() === '[') {
      const isArray = src[i + 1] === '[';
      i += isArray ? 2 : 1;
      skipSpace();
      const key = parseKey();
      skipSpace();
      const name = key.join('.');
      const parent = descend(root, key.slice(0, -1));
      const last = key[key.length - 1];
      if (isArray) {
        if (!src.startsWith(']]', i)) fail('expected "]]"');
        i += 2;
        if (!(last in parent)) parent[last] = [];
        if (!Array.isArray(parent[last])) fail(`"${name}" is already a table, not an array of tables`);
        const table = {};
        parent[last].push(table);
        current = table;
      } else {
        if (peek() !== ']') fail('expected "]"');
        i++;
        const id = key.join('\u0000');
        if (defined.has(id)) fail(`table "${name}" is defined twice`);
        defined.add(id);
        if (Array.isArray(parent[last])) fail(`"${name}" is an array of tables, not a table`);
        current = descend(parent, [last]);
      }
      endOfLine();
      continue;
    }
    const key = parseKey();
    skipSpace();
    if (peek() !== '=') fail(`expected "=" after "${key.join('.')}"`);
    i++;
    skipSpace();
    const value = parseValue();
    const parent = descend(current, key.slice(0, -1));
    const last = key[key.length - 1];
    if (last in parent) fail(`"${key.join('.')}" is defined twice`);
    parent[last] = value;
    endOfLine();
  }
  return root;
}
