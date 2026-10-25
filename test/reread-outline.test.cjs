'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, tmpRoot } = require('./helpers.cjs');
const O = require('../lib/outline.cjs');

function readPayload(root, file, content, input = {}, extra = {}) {
  const n = content.split('\n').length;
  return { cwd: root, session_id: 'sess', tool_name: 'Read', tool_input: { file_path: file, ...input },
    tool_response: { type: 'text', file: { filePath: file, content, numLines: n, startLine: 1, totalLines: n } }, ...extra };
}
const out = (r) => r.out && r.out.hookSpecificOutput.updatedToolOutput.file.content;

test('identical re-read becomes a notice; a changed one becomes a diff numbered by the current file', () => {
  const root = tmpRoot();
  const file = path.join(root, 'a.txt');
  const base = Array.from({ length: 300 }, (_, i) => `line ${i} with sample text for the test`);
  assert.strictEqual(runHook('post', readPayload(root, file, base.join('\n'))).raw, '');
  assert.match(out(runHook('post', readPayload(root, file, base.join('\n')))), /unchanged since your last full read/);
  const v2 = [...base]; v2[150] = 'line 150 CHANGED'; v2.splice(200, 0, 'new line');
  const d = out(runHook('post', readPayload(root, file, v2.join('\n'))));
  assert.match(d, /changed since your last full read/);
  assert.match(d, /\+ 151\| line 150 CHANGED/);
  assert.match(d, /- +\| line 150 with sample/);
  assert.ok(d.length < v2.join('\n').length / 4);
});

test('a ranged read is never swapped and is not used as a base', () => {
  const root = tmpRoot();
  const file = path.join(root, 'b.txt');
  const t = 'z\n'.repeat(3000);
  assert.strictEqual(runHook('post', readPayload(root, file, t, { offset: 1, limit: 3000 })).raw, '');
  assert.strictEqual(runHook('post', readPayload(root, file, t)).raw, '');
});

test('a subagent has its own window; compacting resets the window', () => {
  const root = tmpRoot();
  const file = path.join(root, 'c.txt');
  const t = 'repeated content\n'.repeat(400);
  runHook('post', readPayload(root, file, t));
  assert.strictEqual(runHook('post', readPayload(root, file, t, {}, { agent_id: 'ag1' })).raw, '');
  runHook('session-start', { cwd: root, session_id: 'sess', source: 'compact' });
  assert.strictEqual(runHook('post', readPayload(root, file, t)).raw, '');
});

const ON = (root) => fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ on: ['outline'] }));

function bigPython() {
  const parts = ['"""large module"""', 'import os', ''];
  for (let i = 0; i < 120; i++) {
    parts.push(`def funcao_${i}(a, b=${i}):`, `    """Faz a coisa ${i}."""`);
    for (let k = 0; k < 12; k++) parts.push(`    x${k} = a + b * ${k}  # intermediate calculation number ${k} of function ${i}`);
    parts.push('    return x0', '', '');
  }
  parts.push('class Grande:', '    def metodo(self):', '        return 1', '');
  return parts.join('\n');
}

test('symbol map is off by default', () => {
  const root = tmpRoot();
  assert.strictEqual(runHook('post', readPayload(root, path.join(root, 'g.py'), bigPython())).raw, '');
});

test('first read of large code becomes a map (with "on"); a second full read comes complete', () => {
  const root = tmpRoot();
  ON(root);
  const file = path.join(root, 'grande.py');
  const src = bigPython();
  assert.ok(Buffer.byteLength(src) > 51200);
  const m = out(runHook('post', readPayload(root, file, src)));
  assert.match(m, /symbol map/);
  assert.match(m, /def funcao_37\(a, b=37\):  # Faz a coisa 37\./);
  assert.match(m, /class Grande:/);
  assert.ok(m.length < src.length / 5);
  assert.strictEqual(runHook('post', readPayload(root, file, src)).raw, '');
});

test('a large file that is not code passes untouched', () => {
  const root = tmpRoot();
  ON(root);
  assert.strictEqual(runHook('post', readPayload(root, path.join(root, 'log.txt'), 'log line\n'.repeat(6000))).raw, '');
});

test('outline: Python and JS ranges with destructuring in parameters', () => {
  const py = 'class A:\n    def f(self):\n        return 1\n\n    def g(self):\n        pass\n\ndef h():\n    pass\n';
  const s = O.symbols(py, 'x.py').map((x) => `${x.name}:${x.start}-${x.end}:${x.depth}`);
  assert.deepStrictEqual(s, ['A:1-6:0', 'f:2-3:1', 'g:5-6:1', 'h:8-9:0']);
  const js = "function copy(a, { overwrite = true } = {}) {\n  if (a) {\n    return 1;\n  }\n}\nconst f = (x) => {\n  return x;\n};\nclass K {\n  metodo(y) {\n    return y;\n  }\n}\n";
  const j = O.symbols(js, 'x.js').map((x) => `${x.name}:${x.start}-${x.end}`);
  assert.deepStrictEqual(j, ['copy:1-5', 'f:6-8', 'K:9-13', 'metodo:10-12']);
  assert.deepStrictEqual(O.find(O.symbols(py, 'x.py'), 'A.g').map((x) => x.start), [5]);
});

test('Read cut by Claude Code itself: the map comes from the file on disk', () => {
  const root = tmpRoot();
  ON(root);
  const file = path.join(root, 'cortado.py');
  const src = bigPython();
  fs.writeFileSync(file, src);
  const lines = src.split('\n');
  const partial = lines.slice(0, 500).join('\n');
  const payload = { cwd: root, session_id: 'sess', tool_name: 'Read', tool_input: { file_path: file },
    tool_response: { type: 'text', file: { filePath: file, content: partial, numLines: 500, startLine: 1, totalLines: lines.length } } };
  const m = out(runHook('post', payload));
  assert.match(m, /symbol map/);
  assert.match(m, /class Grande:/); // it is after line 500
  assert.strictEqual(runHook('post', payload).raw, ''); // second attempt passes as Read returned it
});
