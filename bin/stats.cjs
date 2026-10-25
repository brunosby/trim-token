#!/usr/bin/env node
'use strict';
/** Summary of <project>/.trimtoken/stats.jsonl: how much each mechanism saved. */

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const session = process.argv[3] || null;
const file = path.join(root, '.trimtoken', 'stats.jsonl');
let lines = [];
try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {
  process.stdout.write('No interventions recorded in this project yet.\n');
  process.exit(0);
}

const NAMES = {
  scan: 'scan blocked', bash: 'Bash output (cleanup and cap)', grep: 'Grep output (cap)', mcp: 'MCP output',
  'reread-same': 'identical re-read', 'reread-diff': 're-read as diff', outline: 'symbol map',
};

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
  for (const k of keys) out += `  ${(NAMES[k] || k).padEnd(34)} ${String(by[k].n).padStart(5)}×  ~${Math.round(by[k].saved / 4).toLocaleString('en-US')} tokens\n`;
  out += `  ${'total'.padEnd(34)} ${String(rows.length).padStart(5)}×  ~${Math.round(total / 4).toLocaleString('en-US')} tokens (4 characters ≈ 1 token)\n`;
  return out;
}

const all = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let report = table(all, `Project ${root}`);
if (session) {
  const mine = all.filter((r) => r.s === session);
  report += `\n${mine.length ? table(mine, 'This session') : 'This session: no interventions yet.\n'}`;
}
process.stdout.write(report);
