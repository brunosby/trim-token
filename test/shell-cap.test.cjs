'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const SH = require('../lib/shell.cjs');
const CAP = require('../lib/cap.cjs');
const { runHook, tmpRoot } = require('./helpers.cjs');

test('cleanup: ANSI, \\r, repeats and blanks, without losing distinct lines', () => {
  assert.strictEqual(SH.clean('\x1b[32mPASS\x1b[0m a\n\x1b[31mFAIL\x1b[0m b'), 'PASS a\nFAIL b');
  assert.strictEqual(SH.clean('baixando 10%\rbaixando 100%\nok'), 'baixando 100%\nok');
  assert.strictEqual(SH.clean('a\nw\nw\nw\nw\nb'), 'a\nw  [×4]\nb');
  assert.strictEqual(SH.clean('x\nx\ny'), 'x\nx\ny');
  assert.strictEqual(SH.clean('a\n\n\n\nb\n\n'), 'a\n\nb');
  const distinct = 'FAIL t1\nFAIL t2\nFAIL t3';
  assert.strictEqual(SH.clean(distinct), distinct);
});

test('cleanup only swaps when it pays off', () => {
  assert.strictEqual(SH.compact('curto'), null);
  assert.strictEqual(SH.compact('line with nothing to clean '.repeat(100)), null);
  const npm = Array.from({ length: 300 }, () => '\x1b[33mnpm WARN deprecated x@1\x1b[0m').join('\n') + '\nadded 3 packages';
  assert.strictEqual(SH.compact(npm), 'npm WARN deprecated x@1  [×300]\nadded 3 packages');
});

test('cut keeps the start, the end and the error lines in the middle', () => {
  const lines = Array.from({ length: 2000 }, (_, i) => `ok ${i} - caso ${i} passa`);
  lines.splice(1000, 0, 'not ok 1000 - parser aceita vazio', 'AssertionError: expected [] to equal null');
  const c = CAP.cut(lines.join('\n'), 8000);
  assert.ok(c.text.length < 9000);
  assert.match(c.text, /^ok 0 - caso 0/);
  assert.match(c.text, /ok 1999 - caso 1999 passa$/);
  assert.match(c.text, /not ok 1000 - parser aceita vazio/);
  assert.match(c.text, /AssertionError: expected \[\] to equal null/);
  assert.match(c.text, /lines omitted/);
});

test('hook post Bash: cleans medium output without an extra notice', () => {
  const root = tmpRoot();
  const stdout = Array.from({ length: 200 }, (_, i) => `\x1b[2K\rprogresso ${i}%\rprogresso 100%`).join('\n') + '\nBuild OK';
  const r = runHook('post', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });
  const o = r.out.hookSpecificOutput.updatedToolOutput;
  assert.strictEqual(o.interrupted, false);
  assert.match(o.stdout, /Build OK$/);
  assert.ok(o.stdout.length < stdout.length / 5);
  assert.strictEqual(r.out.hookSpecificOutput.additionalContext, undefined);
});

test('hook post Bash: above the cap it cuts, saves the original full text and says where', () => {
  const root = tmpRoot();
  const lines = Array.from({ length: 1500 }, (_, i) => `output line ${i} with some extra text`);
  lines.splice(700, 0, 'ERROR: connection refused at db:5432');
  const stdout = lines.join('\n');
  const r = runHook('post', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: { stdout, stderr: '' } });
  const o = r.out.hookSpecificOutput.updatedToolOutput;
  assert.ok(o.stdout.length < 10000);
  assert.match(o.stdout, /ERROR: connection refused at db:5432/);
  const file = /Full text: (\S+)/.exec(o.stdout)[1];
  assert.strictEqual(fs.readFileSync(file, 'utf8'), stdout);
  assert.ok(fs.existsSync(`${root}/.trimtoken/stats.jsonl`));
});

test('hook post Bash: short clean output passes untouched (no response)', () => {
  const r = runHook('post', { cwd: tmpRoot(), session_id: 's', tool_name: 'Bash', tool_input: {}, tool_response: { stdout: 'ok\n', stderr: '' } });
  assert.strictEqual(r.raw, '');
});

test('TRIMTOKEN=off e componente desligado', () => {
  const root = tmpRoot();
  const stdout = 'x\n'.repeat(5000);
  const payload = { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: {}, tool_response: { stdout, stderr: '' } };
  assert.strictEqual(runHook('post', payload, { TRIMTOKEN: 'off' }).raw, '');
  fs.writeFileSync(`${root}/.trimtoken.json`, JSON.stringify({ off: ['shell', 'cap'] }));
  assert.strictEqual(runHook('post', payload).raw, '');
});
