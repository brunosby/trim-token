'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, tmpRoot } = require('./helpers.cjs');

function readPayload(root, file, content, input = {}, extra = {}) {
  const n = content.split('\n').length;
  return { cwd: root, session_id: 'sess', tool_name: 'Read', tool_input: { file_path: file, ...input },
    tool_response: { type: 'text', file: { filePath: file, content, numLines: n, startLine: 1, totalLines: n } }, ...extra };
}
const out = (r) => r.out && r.out.hookSpecificOutput.updatedToolOutput.file.content;

test('an identical re-read is left alone (Claude Code answers it); a changed one becomes a diff numbered by the current file', () => {
  const root = tmpRoot();
  const file = path.join(root, 'a.txt');
  const base = Array.from({ length: 300 }, (_, i) => `line ${i} with sample text for the test`);
  assert.strictEqual(runHook('post', readPayload(root, file, base.join('\n'))).raw, '');
  assert.strictEqual(runHook('post', readPayload(root, file, base.join('\n'))).raw, '');
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
