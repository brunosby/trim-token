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

test('hook post Bash: when similar log lines are grouped, the original is saved and the output says where', () => {
  const root = tmpRoot();
  const lines = Array.from({ length: 60 }, (_, i) => `12:00:${String(i).padStart(2, '0')} INFO request ${1000 + i} served in ${i + 3}ms`);
  const stdout = lines.join('\n') + '\nDone';
  const r = runHook('post', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'tail -60 app.log' }, tool_response: { stdout, stderr: '' } });
  const o = r.out.hookSpecificOutput.updatedToolOutput;
  assert.match(o.stdout, /\[×58 more like: /);
  const file = /Similar log lines were grouped\. Full text: (\S+)/.exec(o.stdout)[1];
  assert.strictEqual(fs.readFileSync(file, 'utf8'), stdout);
  // repeats of the same line lose nothing, so nothing is saved
  const same = Array.from({ length: 300 }, () => 'npm WARN deprecated x@1').join('\n') + '\nadded 3 packages';
  const r2 = runHook('post', { cwd: tmpRoot(), session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm i' }, tool_response: { stdout: same, stderr: '' } });
  assert.doesNotMatch(r2.out.hookSpecificOutput.updatedToolOutput.stdout, /Full text/);
});

test('hook post Bash: output Claude Code already saved in full (persistedOutputPath) is left alone and not copied', () => {
  const root = tmpRoot();
  // Measured: a 247 KB find came to the hook cut at 30k characters, and Claude Code showed the model a 2 KB preview.
  const stdout = Array.from({ length: 1500 }, (_, i) => `node_modules/pkg/file${i}.js with some text`).join('\n').slice(0, 30000);
  const r = runHook('post', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'find node_modules/pkg -type f' },
    tool_response: { stdout, stderr: '', persistedOutputPath: `${root}/tool-results/b1.txt`, persistedOutputSize: 253542 } });
  assert.ok(!r.out);
  assert.ok(!fs.existsSync(`${root}/.trimtoken/out`));
});

test('table rows are data: a header with aligned columns, or pipes, keeps every row; log runs are still grouped', () => {
  const SHx = require('../lib/shell.cjs');
  const rows = ['id  name     started  duration'];
  for (let i = 1; i <= 8; i++) rows.push(`${i}   job      10:0${i}    ${i * 13}ms`);
  assert.doesNotMatch(SHx.clean(rows.join('\n')), /more like/);
  const md = ['| user | login | latency |', '|---|---|---|'];
  for (let i = 1; i <= 6; i++) md.push(`| alice | 09:1${i} | ${i * 7} ms |`);
  assert.doesNotMatch(SHx.clean(md.join('\n')), /more like/);
  const log = [];
  for (let i = 1; i <= 8; i++) log.push(`2026-11-04 10:0${i}:00 INFO  request ${i} served in ${i * 3}ms`);
  assert.match(SHx.clean(log.join('\n')), /\[×6 more like: /);
});

test('when error lines do not fit, the footer says how many and how to list them all', () => {
  const C = require('../lib/cap.cjs');
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`src/mod${i}.js:${i} error: something failed in module number ${i}`);
  const c = C.cut(lines.join('\n'), 3000);
  assert.ok(c.dropped > 0);
  assert.match(C.footer(99999, '/tmp/x.txt', true, c.dropped), new RegExp(`${c.dropped} more error lines are only there`));
});
