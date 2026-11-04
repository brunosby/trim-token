'use strict';
// Keep-warm is opt-in and capped per day; what the plugin keeps on disk holds no prompt text or credentials and stays bounded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('../lib/config.cjs');
const W = require('../lib/warm.cjs');
const S = require('../lib/state.cjs');
const N = require('../lib/noise.cjs');
const ST = require('../scripts/stats.cjs');
const { runHook } = require('./helpers.cjs');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-privacy-'));
let n = 0;
const tmp = () => { const d = path.join(base, `r${++n}`); fs.mkdirSync(d); return d; };

test('keep-warm is off by default and "on": ["warm"] turns it on', () => {
  const root = tmp();
  assert.strictEqual(CFG.on(CFG.load(root, root), 'warm'), false);
  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ on: ['warm'] }));
  assert.strictEqual(CFG.on(CFG.load(root, root), 'warm'), true);
});

test('keep-warm: the day\'s cap stops the worker, and the executable is looked up once, by the worker', async () => {
  const root = tmp();
  const file = path.join(S.windowDir(root, 's', null), 'warm.json');
  S.writeJson(file, { gen: 'g' });
  let looked = 0;
  let pings = 0;
  const args = { root, sessionId: 's', gen: 'g', pings: 5, everyMs: 1, sleep: async () => {}, findCmd: () => { looked++; return null; },
    doPing: () => { pings++; return { usage: { cache_read_input_tokens: 50000, output_tokens: 2 } }; } };
  assert.strictEqual(await W.run({ ...args, dailyMax: 3 }), 3);
  assert.strictEqual(looked, 1);
  assert.strictEqual(W.pingsToday(root), 3);
  assert.strictEqual(await W.run({ ...args, dailyMax: 3 }), 0, 'cap already reached today');
  assert.strictEqual(pings, 3);
  const report = ST.warmTable(root, 's');
  assert.match(report, /Keep-warm pings \(measured/);
  assert.match(report, /today\s+3×/);
});

test('the prompt is kept only as word hashes, and a folder named in it still lets the search through', () => {
  const root = tmp();
  N.savePrompt(root, 's', 'Procure o bug dentro de node_modules/left-pad, senha=hunter22');
  const dir = path.join(root, '.trimtoken', 'state', 's');
  const files = fs.readdirSync(dir);
  assert.deepStrictEqual(files, ['prompt-words.json']);
  const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.doesNotMatch(raw, /node_modules|hunter22|procure/i);
  const cfg = CFG.load(root, root);
  fs.mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  const call = (prompt) => N.check({ tool: 'Bash', input: { command: 'grep -r "pad" node_modules' }, root, cfg, prompt });
  assert.strictEqual(call(N.lastPrompt(root, 's')), null);
  assert.ok(call(N.lastPrompt(root, 'other')), 'a session whose prompt did not name it is still guarded');
});

test('session end removes the session\'s state', () => {
  const root = tmp();
  N.savePrompt(root, 's2', 'oi');
  runHook('session-end', { cwd: root, session_id: 's2' });
  assert.ok(!fs.existsSync(path.join(root, '.trimtoken', 'state', 's2')));
});

test('saved outputs hide credentials, the index hides the home folder, old outputs expire and logs stay bounded', () => {
  const root = tmp();
  const file = S.saveFull(root, 'bash', 'ok\nAPI_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwx\npostgres://app:hunter22@db:5432/x\n', { session: 's', source: `cat ${os.homedir()}/notes.txt` });
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text, /abcdefghijklmnop|hunter22/);
  assert.match(text, /postgres:\/\/app:\[hidden\]@db/);
  const idx = fs.readFileSync(path.join(root, '.trimtoken', 'out', 'index.jsonl'), 'utf8');
  assert.match(idx, /cat ~\/notes\.txt/);
  const old = path.join(root, '.trimtoken', 'out', `${Date.now() - 8 * 24 * 3600 * 1000}-bash-old.txt`);
  fs.writeFileSync(old, 'x');
  S.saveFull(root, 'bash', 'y', {});
  assert.ok(!fs.existsSync(old), 'an output older than a week is deleted');
  const log = path.join(root, 'big.jsonl');
  const line = JSON.stringify({ pad: 'x'.repeat(1000) });
  for (let i = 0; i < 1200; i++) S.appendCapped(log, line);
  assert.ok(fs.statSync(log).size <= S.MAX_LOG_BYTES);
});

test.after(() => fs.rmSync(base, { recursive: true, force: true }));
