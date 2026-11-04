'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/warm.cjs');
const CFG = require('../lib/config.cjs');

function transcript(dir, { ttl = '5m', tokens = 50000, model = 'claude-sonnet-5-5' } = {}) {
  const file = path.join(dir, 't.jsonl');
  const cc = ttl === '5m' ? { ephemeral_5m_input_tokens: 1000 } : { ephemeral_1h_input_tokens: 1000 };
  const usage = { input_tokens: 5, cache_read_input_tokens: tokens - 1005, cache_creation_input_tokens: 1000, cache_creation: cc };
  fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { model, usage } })}\n`);
  return file;
}
const tmp = () => require('./helpers.cjs').tmpRoot('tt-warm-');
const lastUsage = require('../lib/watch.cjs').lastUsage;

test('keep-warm: scheduled only for the 5-minute cache', () => {
  const cfg = { ...CFG.load(null), limits: { ...CFG.DEFAULTS.limits, warmPings: 0 } };  // 0 pings: the worker exits at once
  const root = tmp();
  assert.strictEqual(W.schedule({ root, sessionId: 's', transcriptPath: transcript(root, { ttl: '1h' }), cfg, lastUsage }), null);
  const plan = W.schedule({ root, sessionId: 's', transcriptPath: transcript(root, { tokens: 60000 }), cfg, lastUsage });
  assert.ok(plan && plan.gen);
  assert.strictEqual(plan.model, 'claude-sonnet-5-5');
  assert.strictEqual(W.current(root, 's').gen, plan.gen);
  W.cancel(root, 's');
  assert.strictEqual(W.current(root, 's'), null);
});

test('keep-warm: the worker pings until cancelled or replaced, and records each ping', async () => {
  const root = tmp();
  const S = require('../lib/state.cjs');
  const file = path.join(S.windowDir(root, 's', null), 'warm.json');
  S.writeJson(file, { gen: 'g1' });
  let calls = 0;
  const doPing = () => { calls++; return { usage: { cache_read_input_tokens: 48000, cache_creation_input_tokens: 40, output_tokens: 3 } }; };
  const sleep = async () => { if (calls === 2) W.cancel(root, 's'); };
  assert.strictEqual(await W.run({ root, sessionId: 's', gen: 'g1', pings: 4, everyMs: 1, sleep, doPing }), 2);
  const rows = fs.readFileSync(path.join(root, '.trimtoken', 'warm.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(rows.map((r) => r.read), [48000, 48000]);
  S.writeJson(file, { gen: 'g2' });
  assert.strictEqual(await W.run({ root, sessionId: 's', gen: 'g1', pings: 4, everyMs: 1, sleep: async () => {}, doPing }), 0);
  assert.strictEqual(await W.run({ root, sessionId: 's', gen: 'g2', pings: 3, everyMs: 1, sleep: async () => {}, doPing: () => null }), 1);
});

test('keep-warm: a recent ping keeps the cold-cache warning quiet', () => {
  const root = tmp();
  const S = require('../lib/state.cjs');
  const t = transcript(root, { tokens: 60000 });
  const old = Date.now() + 12 * 60000;
  const cfg = CFG.load(null);
  const W2 = require('../lib/watch.cjs');
  S.writeJson(path.join(S.windowDir(root, 's', null), 'warm.json'), { gen: 'g', pingAt: old - 60000 });
  assert.strictEqual(W2.check({ root, sessionId: 's', transcriptPath: t, cfg, now: old }), null);
  W.cancel(root, 's');
  assert.match(W2.check({ root, sessionId: 's', transcriptPath: t, cfg, now: old }) || '', /went cold/);
});

test('keep-warm: finds the running Claude Code without the PATH', () => {
  const dir = tmp();
  const exe = path.join(dir, 'claude');
  fs.writeFileSync(exe, '');
  assert.strictEqual(W.claudeCommand({ TRIMTOKEN_CLAUDE: exe }), exe);
  assert.strictEqual(W.claudeCommand({ CLAUDE_CODE_EXECPATH: exe }), exe);
  assert.strictEqual(W.claudeCommand({ CLAUDE_CODE_EXECPATH: path.join(dir, 'missing') }), null);
  assert.strictEqual(W.claudeCommand({}), null);
  if (process.platform === 'linux') {
    // This test runs under Node, so the process's executable is node: left to the PATH.
    assert.strictEqual(W.claudeCommand({ CLAUDE_PID: String(process.pid) }), null);
  }
});

test('keep-warm: the worker skips a small context (checked after the turn is written)', async () => {
  const root = tmp();
  const S = require('../lib/state.cjs');
  S.writeJson(path.join(S.windowDir(root, 's', null), 'warm.json'), { gen: 'g' });
  let calls = 0;
  const doPing = () => { calls++; return { usage: {} }; };
  const small = () => ({ tokens: 40000 });
  const large = () => ({ tokens: 60000 });
  assert.strictEqual(await W.run({ root, sessionId: 's', transcriptPath: 't', gen: 'g', pings: 3, everyMs: 1, minTokens: 50000, sleep: async () => {}, doPing, usage: small }), 0);
  assert.strictEqual(await W.run({ root, sessionId: 's', transcriptPath: 't', gen: 'g', pings: 3, everyMs: 1, minTokens: 50000, sleep: async () => {}, doPing, usage: large }), 3);
  assert.strictEqual(calls, 3);
});

test('topic change: a prompt that shares almost no words with the recent ones, over a large context, suggests handoff and /clear', () => {
  const root = tmp();
  const cfg = CFG.load(null);
  const W2 = require('../lib/watch.cjs');
  const big = transcript(root, { tokens: 80000, ttl: '1h' });
  const chk = (prompt, t = big) => W2.check({ root, sessionId: 'tp', transcriptPath: t, cfg, prompt });
  assert.strictEqual(chk('Corrija o cálculo do desconto progressivo no carrinho de compras do checkout'), null);
  assert.strictEqual(chk('O desconto progressivo do carrinho ainda falha quando o cupom de frete é aplicado no checkout'), null);
  assert.match(chk('Configure o pipeline de deploy da documentação no GitHub Pages com domínio próprio') || '', /new topic[\s\S]*\/clear/);
  // the new topic is now the reference: a follow-up on it does not warn again
  assert.strictEqual(chk('No deploy da documentação, o domínio próprio precisa de HTTPS no GitHub Pages'), null);
  // a small context never warns
  const small = tmp();
  const t2 = transcript(small, { tokens: 10000, ttl: '1h' });
  W2.check({ root: small, sessionId: 'tp', transcriptPath: t2, cfg, prompt: 'Corrija o cálculo do desconto progressivo no carrinho de compras do checkout' });
  W2.check({ root: small, sessionId: 'tp', transcriptPath: t2, cfg, prompt: 'O desconto progressivo do carrinho falha com o cupom de frete do checkout' });
  assert.strictEqual(W2.check({ root: small, sessionId: 'tp', transcriptPath: t2, cfg, prompt: 'Configure o pipeline de deploy da documentação no GitHub Pages com domínio próprio' }), null);
});
