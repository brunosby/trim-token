'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../scripts/stats.cjs');

test('billed cost weights output, cache writes and cache reads by model', () => {
  const usage = { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 10000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 0 } };
  assert.strictEqual(S.costUnits(usage, 0, 'claude-sonnet-5-5'), 10 + 500 + 500 + 500);
  assert.strictEqual(S.costUnits(usage, 0, 'claude-haiku-4-5'), 10 + 500 + 1000 + 500);
  assert.strictEqual(S.costUnits(usage, 400, 'claude-fable-5-1'), 10 + 500 + 250 + 800);
});

test('the savings report shows the billed shares of a session', () => {
  const home = require('./helpers.cjs').tmpRoot('tt-stats-');
  const dir = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const line = (id, u) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: u } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [
    line('a', { input_tokens: 0, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 }),
    line('a', { input_tokens: 0, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 }),
    line('b', { input_tokens: 0, output_tokens: 100, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 }),
  ].join('\n'));
  const out = S.report(home, 's1', home);
  assert.match(out, /Billed cost in input-token equivalents: 5,000/);
  assert.match(out, /output\s+30%/);
  assert.match(out, /cache write \(new content\)\s+50%/);
  assert.match(out, /cache read \(history re-read\)\s+20%/);
});

test('commands that only make sense when typed stay out of the model listing', () => {
  for (const c of ['savings', 'audit']) {
    const s = fs.readFileSync(path.join(__dirname, '..', 'commands', `${c}.md`), 'utf8');
    assert.match(s.split('---')[1], /disable-model-invocation: true/, c);
  }
});
