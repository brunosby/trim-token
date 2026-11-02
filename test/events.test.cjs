'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, tmpRoot } = require('./helpers.cjs');

test('there is no PreToolUse hook: listings and repeated commands are left to Claude Code', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.strictEqual(hooks.PreToolUse, undefined);
  assert.strictEqual(hooks.PostToolUseFailure, undefined);
  assert.strictEqual(runHook('pre', { cwd: tmpRoot(), session_id: 's', tool_name: 'Bash', tool_input: { command: 'find .' } }).raw, '');
});

test('session-start injeta o contrato curto, exceto em resume', () => {
  const root = tmpRoot();
  const r = runHook('session-start', { cwd: root, session_id: 's', source: 'startup' });
  const ctx = r.out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /located before it is read/);
  assert.ok(ctx.length < 1000, String(ctx.length));
  assert.strictEqual(runHook('session-start', { cwd: root, session_id: 's', source: 'resume' }).raw, '');
});

test('resume: an expired cache over a large context warns the human with the estimate; nothing goes to the model', () => {
  const root = tmpRoot();
  const p = { cwd: root, session_id: 'rs', source: 'resume', prompt_cache_likely_expired: true, context_tokens: 150000, estimated_cache_write_usd: 0.94 };
  const r = runHook('session-start', p);
  assert.match(r.out.systemMessage, /~150k tokens/);
  assert.match(r.out.systemMessage, /US\$ 0\.94/);
  assert.strictEqual(r.out.hookSpecificOutput, undefined);
  assert.strictEqual(runHook('session-start', { ...p, prompt_cache_likely_expired: false }).raw, '');
  assert.strictEqual(runHook('session-start', { ...p, context_tokens: 5000 }).raw, '');
  // Holding the first prompt is off by default.
  assert.strictEqual(runHook('prompt', { cwd: root, session_id: 'rs', prompt: 'continue' }).raw, '');
});

test('resume: with resumeHold on, the first prompt is held once; a command is never held', () => {
  const root = tmpRoot();
  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ on: ['resumeHold'] }));
  const p = { cwd: root, session_id: 'rh', source: 'resume', prompt_cache_likely_expired: true, context_tokens: 150000 };
  runHook('session-start', p);
  const held = runHook('prompt', { cwd: root, session_id: 'rh', prompt: 'continue' });
  assert.strictEqual(held.out.decision, 'block');
  assert.strictEqual(runHook('prompt', { cwd: root, session_id: 'rh', prompt: 'continue' }).raw, '');
  runHook('session-start', p);
  assert.strictEqual(runHook('prompt', { cwd: root, session_id: 'rh', prompt: '/compact keep the plan' }).raw, '');
});

test('prompt: no cold-cache warning when the conversation was compacted after the last response', () => {
  const root = tmpRoot();
  const t = path.join(root, 't.jsonl');
  const at = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(t, [
    JSON.stringify({ type: 'assistant', timestamp: at, message: { usage: { input_tokens: 5, cache_read_input_tokens: 130000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_1h_input_tokens: 500 } } } }),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: at }),
  ].join('\n') + '\n');
  assert.strictEqual(runHook('prompt', { cwd: root, session_id: 'cb', transcript_path: t, prompt: 'hi' }).raw, '');
});

test('subagent injeta o contrato de resposta-dado', () => {
  const r = runHook('subagent', { cwd: tmpRoot(), session_id: 's', agent_type: 'Explore', agent_id: 'a' });
  assert.match(r.out.hookSpecificOutput.additionalContext, /What helps it most is data/);
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

