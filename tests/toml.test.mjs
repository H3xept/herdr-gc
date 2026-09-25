import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TomlError, parseToml } from '../lib/toml.mjs';

test('parses the shapes a herdr-gc config uses', () => {
  const doc = parseToml(`
# comment
version = 1
[[step]]
name = "install" # trailing comment
on = ["create",
  "open",   # comment inside an array
]
continue_on_error = true
run = """
yarn install
echo "done"\\tok"""

[[step]]
name = 'literal \\n stays'
run = '''
a 'b' "c"
'''
"quoted key".x = -3
`);
  assert.equal(doc.version, 1);
  assert.equal(doc.step.length, 2);
  assert.deepEqual(doc.step[0].on, ['create', 'open']);
  assert.equal(doc.step[0].continue_on_error, true);
  // A newline right after the opening """ is trimmed, as in TOML.
  assert.equal(doc.step[0].run, 'yarn install\necho "done"\tok');
  assert.equal(doc.step[1].name, 'literal \\n stays');
  assert.equal(doc.step[1].run, 'a \'b\' "c"\n');
  assert.deepEqual(doc.step[1]['quoted key'], { x: -3 });
});

test('rejects what it does not support, with the line number', () => {
  const cases = [
    ['a = 1.5', 1],
    ['\nwhen = 1979-05-27', 2],
    ['x = { a = 1 }', 1],
    ['a = 1\na = 2', 2],
    ['[t]\n[t]', 2],
    ['name = "open', 1],
    ['a = "bad \\q escape"', 1],
    ['= 1', 1],
  ];
  for (const [text, line] of cases) {
    assert.throws(() => parseToml(text), (e) => e instanceof TomlError && e.line === line, text);
  }
});
