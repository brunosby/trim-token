#!/usr/bin/env node
'use strict';
/**
 * Summary for /trim-token:savings: how much each mechanism saved (<project>/.trimtoken/stats.jsonl)
 * and the session's token use by kind,
 * read from its transcript. The cache is most of the cost of a long session, so it is shown apart.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAMES = {
  bash: 'Bash output (cleanup and cap)', grep: 'Grep output (cap)',
  mcp: 'MCP output', 'reread-diff': 're-read as diff',
};

function readLines(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return null; }
}

function fmt(n) { return Math.round(n).toLocaleString('en-US'); }

function table(rows, title) {
  const by = {};
  for (const r of rows) {
    const b = (by[r.m] = by[r.m] || { n: 0, saved: 0 });
    b.n += 1;
    b.saved += Math.max(0, (r.before || 0) - (r.after || 0));
  }
  const keys = Object.keys(by).sort((a, b) => by[b].saved - by[a].saved);
  const total = keys.reduce((a, k) => a + by[k].saved, 0);
  let out = `${title}\n`;
  for (const k of keys) out += `  ${(NAMES[k] || k).padEnd(34)} ${String(by[k].n).padStart(5)}×  ~${fmt(by[k].saved / 4)} tokens\n`;
  out += `  ${'total'.padEnd(34)} ${String(rows.length).padStart(5)}×  ~${fmt(total / 4)} tokens (4 characters ≈ 1 token)\n`;
  return out;
}

const ESTIMATE_NOTE = '  Estimated: characters kept out of the context ÷ 4, counted once. The real saving is larger when the output\n' +
  '  would have been re-read from the cache on later turns, and smaller when it would have dropped out at /compact.\n';

// Keep-warm pings are real requests: what they used, from their own usage records (measured, not estimated).
function warmTable(root, session, now = Date.now()) {
  const rows = readLines(path.join(root, '.trimtoken', 'warm.jsonl'));
  if (!rows || !rows.length) return '';
  const d = new Date(now);
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const sum = (xs) => {
    const s = { n: xs.length, failed: xs.filter((x) => !x.ok).length, read: 0, write: 0, output: 0, units: 0 };
    for (const x of xs) {
      s.read += x.read || 0; s.write += x.write || 0; s.output += x.output || 0;
      s.units += readWeight(x.model) * (x.read || 0) + 1.25 * (x.write || 0) + 5 * (x.output || 0);
    }
    return s;
  };
  const line = (label, s) => `  ${label.padEnd(34)} ${String(s.n).padStart(5)}×  cache read ${fmt(s.read)}, cache write ${fmt(s.write)}, output ${fmt(s.output)}` +
    ` = ~${fmt(s.units)} input-token equivalents${s.failed ? ` (${s.failed} failed)` : ''}\n`;
  let out = 'Keep-warm pings (measured: usage reported by each request)\n';
  out += line('this project', sum(rows));
  out += line('today', sum(rows.filter((x) => x.t >= midnight)));
  if (session) out += line('this session', sum(rows.filter((x) => x.s === session)));
  return out;
}

/** The session's transcript, plus its subagents' transcripts when they are kept apart. */
function transcriptsOf(sessionId, home) {
  const base = path.join(home, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(base); } catch { return []; }
  for (const d of dirs) {
    const main = path.join(base, d, `${sessionId}.jsonl`);
    if (!fs.existsSync(main)) continue;
    const files = [main];
    const sub = path.join(base, d, sessionId, 'subagents');
    try { for (const f of fs.readdirSync(sub)) if (f.endsWith('.jsonl')) files.push(path.join(sub, f)); } catch { /* none */ }
    return files;
  }
  return [];
}

// Billed weight of each token kind relative to one uncached input token, from the Claude API price
// table: output 5x, cache writes 1.25x (5 min) or 2x (1 h), cache reads 0.1x (0.05x on the 5.5 models,
// 0.025x on Fable). The base price cancels out, so shares and before/after comparisons hold for any model.
function readWeight(model) {
  const m = String(model || '');
  if (/fable|mythos/.test(m)) return 0.025;
  if (/-5-5|5\.5/.test(m)) return 0.05;
  return 0.1;
}

function costUnits(usage, long1h, model) {
  const write = usage.cache_creation_input_tokens || 0;
  return (usage.input_tokens || 0) + 5 * (usage.output_tokens || 0) + readWeight(model) * (usage.cache_read_input_tokens || 0) +
    1.25 * (write - long1h) + 2 * long1h;
}

/** Token use by kind, each API response counted once (a response can span several lines). */
function usageOf(files) {
  const seen = new Set();
  const u = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, units: 0 };
  for (const f of files) {
    for (const o of readLines(f) || []) {
      const m = o.type === 'assistant' && o.message;
      if (!m || !m.usage) continue;
      const id = m.id || o.uuid;
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      u.calls += 1;
      u.input += m.usage.input_tokens || 0;
      u.output += m.usage.output_tokens || 0;
      u.cacheRead += m.usage.cache_read_input_tokens || 0;
      u.cacheWrite += m.usage.cache_creation_input_tokens || 0;
      const long = (m.usage.cache_creation && m.usage.cache_creation.ephemeral_1h_input_tokens) || 0;
      u.cacheWrite1h += long;
      u.units += costUnits(m.usage, long, m.model);
    }
  }
  return u;
}

function usageTable(u) {
  const inTotal = u.input + u.cacheRead + u.cacheWrite;
  const hit = inTotal ? Math.round((u.cacheRead / inTotal) * 100) : 0;
  return 'Tokens in this session (measured: from the transcript)\n' +
    `  ${'model calls'.padEnd(34)} ${fmt(u.calls)}\n` +
    `  ${'cache read'.padEnd(34)} ${fmt(u.cacheRead)}  (${hit}% of the input)\n` +
    `  ${'cache write'.padEnd(34)} ${fmt(u.cacheWrite)}\n` +
    `  ${'uncached input'.padEnd(34)} ${fmt(u.input)}\n` +
    `  ${'output'.padEnd(34)} ${fmt(u.output)}\n` +
    costLines(u);
}

// What each kind adds to the bill, in input-token equivalents; the number to compare between sessions.
function costLines(u) {
  if (!u.units) return '';
  const read = u.units - u.input - 5 * u.output - 1.25 * (u.cacheWrite - u.cacheWrite1h) - 2 * u.cacheWrite1h;
  const pct = (x) => `${Math.round((x / u.units) * 100)}%`;
  return `\nBilled cost in input-token equivalents: ${fmt(u.units)}\n` +
    `  ${'output'.padEnd(34)} ${pct(5 * u.output)}\n` +
    `  ${'cache write (new content)'.padEnd(34)} ${pct(1.25 * (u.cacheWrite - u.cacheWrite1h) + 2 * u.cacheWrite1h)}\n` +
    `  ${'cache read (history re-read)'.padEnd(34)} ${pct(read)}\n` +
    `  ${'uncached input'.padEnd(34)} ${pct(u.input)}\n` +
    (u.calls ? `  ${'per model call'.padEnd(34)} ${fmt(u.units / u.calls)}\n` : '');
}

function report(root, session, home = os.homedir()) {
  const all = readLines(path.join(root, '.trimtoken', 'stats.jsonl'));
  const cut = (all || []).filter((r) => r.m !== 'warm'); // a scheduled ping is listed below with what it used
  let out = cut.length ? table(cut, `Project ${root} (estimated)`) : 'No interventions recorded in this project yet.\n';
  if (session && cut.length) {
    const mine = cut.filter((r) => r.s === session);
    out += `\n${mine.length ? table(mine, 'This session (estimated)') : 'This session: no interventions yet.\n'}`;
  }
  if (cut.length) out += ESTIMATE_NOTE;
  const warm = warmTable(root, session);
  if (warm) out += `\n${warm}`;
  if (session) {
    const files = transcriptsOf(session, home);
    if (files.length) out += `\n${usageTable(usageOf(files))}`;
  }
  return out;
}

if (require.main === module) {
  process.stdout.write(report(process.argv[2] || process.cwd(), process.argv[3] || null));
}

module.exports = { report, usageOf, transcriptsOf, costUnits, readWeight, warmTable };
