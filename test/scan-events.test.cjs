'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, tmpRoot, filesIn } = require('./helpers.cjs');
const SC = require('../lib/scan.cjs');
const CFG = require('../lib/config.cjs');

const noise = CFG.DEFAULTS.noise;
const deny = (cmd) => SC.checkShell(cmd, noise);

test('scan: denies tree listings with no filter or cap', () => {
  for (const c of ['find .', 'find . -type f', 'ls -R', 'ls -laR src', 'tree', 'cd x && find .']) {
    assert.ok(deny(c), c);
  }
});

test('scan: allows content searches and filtered, capped or redirected forms', () => {
  for (const c of ["find . -name '*.py'", 'find . | head -50', 'find . -maxdepth 2', 'tree -L 2', 'grep -rl TODO .',
    "grep -rn TODO --include='*.py' .", 'rg -l TODO', 'rg TODO src', 'grep -rn TODO . | head -20', 'grep -rn TODO . > /tmp/x.txt',
    'git diff | grep foo', 'ls -la', 'grep -n x file.py', "rg -g '*.ts' TODO", 'grep -rc TODO .',
    'grep -rn TODO .', 'rg TODO']) { // content search stays free: in the A/B test, blocking it only cost turns
    assert.strictEqual(deny(c), null, c);
  }
});

test('scan: a recusa traz um comando pronto', () => {
  assert.match(deny('find .'), /find \. -name '\*\.py' .* \| head -50/);
});

test('hook pre: only acts on a large directory', () => {
  const small = tmpRoot();
  filesIn(small, 10);
  const p = (root) => ({ cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'find .' } });
  assert.strictEqual(runHook('pre', p(small)).raw, '');
  const big = tmpRoot();
  filesIn(big, 320);
  const r = runHook('pre', p(big));
  assert.strictEqual(r.out.hookSpecificOutput.permissionDecision, 'deny');
  const g = runHook('pre', { cwd: big, session_id: 's', tool_name: 'Glob', tool_input: { pattern: '**/*' } });
  assert.strictEqual(g.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.strictEqual(runHook('pre', { cwd: big, session_id: 's', tool_name: 'Glob', tool_input: { pattern: '**/*.py' } }).raw, '');
});

test('session-start injeta o contrato curto, exceto em resume', () => {
  const root = tmpRoot();
  const r = runHook('session-start', { cwd: root, session_id: 's', source: 'startup' });
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Locate before reading/);
  assert.ok(ctx.length < 1000, String(ctx.length));
  assert.strictEqual(runHook('session-start', { cwd: root, session_id: 's', source: 'resume' }).raw, '');
});

test('subagent injeta o contrato de resposta-dado', () => {
  const r = runHook('subagent', { cwd: tmpRoot(), session_id: 's', agent_type: 'scout', agent_id: 'a' });
  assert.match(r.out.hookSpecificOutput.additionalContext, /Return data/);
  assert.ok(r.out.hookSpecificOutput.additionalContext.length < 400);
});

test('prompt: cold-cache and heavy-context warnings go only to the human', () => {
  const root = tmpRoot();
  const t = path.join(root, 't.jsonl');
  const at = new Date(Date.now() - 20 * 60000).toISOString();
  fs.writeFileSync(t, JSON.stringify({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: 5, cache_read_input_tokens: 130000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500 } } } }) + '\n');
  const r = runHook('prompt', { cwd: root, session_id: 's', transcript_path: t, prompt: 'hi' });
  assert.match(r.out.systemMessage, /prompt cache went cold/);
  assert.match(r.out.systemMessage, /~131k tokens/);
  assert.strictEqual(r.out.hookSpecificOutput, undefined);
  assert.strictEqual(runHook('prompt', { cwd: root, session_id: 's', transcript_path: t, prompt: 'hi' }).raw, '');
});

test('MCP: indented JSON is minified; a huge result is cut', () => {
  const root = tmpRoot();
  const obj = { items: Array.from({ length: 80 }, (_, i) => ({ id: i, title: `issue ${i}`, state: 'open' })) };
  const pretty = JSON.stringify(obj, null, 2);
  const r = runHook('post', { cwd: root, session_id: 's', tool_name: 'mcp__gh__list', tool_input: {}, tool_response: [{ type: 'text', text: pretty }] });
  const t = r.out.hookSpecificOutput.updatedToolOutput[0].text;
  assert.deepStrictEqual(JSON.parse(t), obj);
  assert.ok(t.length < pretty.length * 0.8);
});

test('fail safe: invalid input, unknown event, no cwd', () => {
  assert.strictEqual(runHook('post', 'lixo').raw, '');
  assert.strictEqual(runHook('nada', { cwd: tmpRoot() }).raw, '');
  assert.strictEqual(runHook('post', { tool_name: 'Bash', tool_response: { stdout: 'x'.repeat(50000) } }).raw, '');
  const r = runHook('post', { cwd: tmpRoot(), tool_name: 'Read', tool_input: {}, tool_response: { weird: true } });
  assert.strictEqual(r.status, 0);
});

test('state stays out of git (.git/info/exclude)', () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, '.git', 'info'), { recursive: true });
  runHook('post', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: {}, tool_response: { stdout: 'y\n'.repeat(20000), stderr: '' } });
  assert.match(fs.readFileSync(path.join(root, '.git', 'info', 'exclude'), 'utf8'), /^\.trimtoken\/$/m);
});

