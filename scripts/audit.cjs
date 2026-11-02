#!/usr/bin/env node
'use strict';
/**
 * Read-only audit for /trim-token:audit. Every enabled MCP server, plugin and skill costs
 * context in each session (its tool and skill descriptions), used or not. This crosses what is
 * enabled with what the transcripts of the last N days actually used, and lists events where
 * hooks from different sources run on the same tools. It changes nothing. Token and cache numbers
 * are left to Claude Code (claude plugin details, /context, /usage), which measures them.
 *
 *   node audit.cjs [project-dir] [days]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DAY = 864e5;
const FILE_MAX = 64 * 1024 * 1024;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function list(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** Enabled plugins with their install folder, when it can be found. */
function plugins(home, root) {
  const enabled = {};
  for (const f of [path.join(home, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')]) {
    const s = readJson(f);
    if (s && s.enabledPlugins && typeof s.enabledPlugins === 'object') Object.assign(enabled, s.enabledPlugins);
  }
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')) || {};
  const entries = installed.plugins || installed;
  const out = [];
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) continue;
    let dir = null;
    const e = entries && entries[id];
    const first = Array.isArray(e) ? e[0] : e;
    if (first && typeof first.installPath === 'string') dir = first.installPath;
    out.push({ id, name: id.split('@')[0], dir });
  }
  return out;
}

function mcpServers(home, root) {
  const names = new Set();
  const user = readJson(path.join(home, '.claude.json')) || {};
  for (const k of Object.keys(user.mcpServers || {})) names.add(k);
  const proj = user.projects && user.projects[root];
  for (const k of Object.keys((proj && proj.mcpServers) || {})) names.add(k);
  for (const k of Object.keys((readJson(path.join(root, '.mcp.json')) || {}).mcpServers || {})) names.add(k);
  return [...names];
}

function skillsIn(dir, prefix = '') {
  return list(dir).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).map((e) => prefix + e.name);
}

function skills(home, root, plugs) {
  const out = [...skillsIn(path.join(home, '.claude', 'skills')), ...skillsIn(path.join(root, '.claude', 'skills'))];
  for (const p of plugs) if (p.dir) out.push(...skillsIn(path.join(p.dir, 'skills'), `${p.name}:`));
  return [...new Set(out)];
}

/** Tool, skill and agent names used in transcripts modified in the last `days` days. */
function usage(home, days, now = Date.now()) {
  const used = { mcp: {}, skill: {}, agent: {}, command: {}, sessions: 0 };
  const base = path.join(home, '.claude', 'projects');
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  for (const d of list(base)) {
    if (!d.isDirectory()) continue;
    for (const f of list(path.join(base, d.name))) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(base, d.name, f.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > days * DAY || st.size > FILE_MAX) continue;
      used.sessions += 1;
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (line.indexOf('"tool_use"') >= 0) {
          let o;
          try { o = JSON.parse(line); } catch { continue; }
          const content = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
          for (const b of content) {
            if (!b || b.type !== 'tool_use') continue;
            const m = /^mcp__(.+?)__/.exec(b.name || '');
            if (m) bump(used.mcp, m[1]);
            else if (b.name === 'Skill' && b.input && b.input.skill) bump(used.skill, String(b.input.skill));
            else if ((b.name === 'Agent' || b.name === 'Task') && b.input && b.input.subagent_type) bump(used.agent, String(b.input.subagent_type));
          }
        } else if (line.indexOf('<command-name>') >= 0) {
          for (const m of line.matchAll(/<command-name>\/?([^<]+)<\/command-name>/g)) bump(used.command, m[1].trim());
        }
      }
    }
  }
  return used;
}

/** Tool names a matcher can match: '' and '*' match all; otherwise the alternatives of the regex. */
function matcherTools(m) {
  if (!m || m === '*') return ['*'];
  return String(m).split('|').map((x) => x.trim()).filter(Boolean);
}

function overlaps(a, b) {
  if (a.includes('*') || b.includes('*')) return true;
  return a.some((x) => b.some((y) => x === y || (x.includes('.*') && new RegExp(`^${x}$`).test(y)) || (y.includes('.*') && new RegExp(`^${y}$`).test(x))));
}

/** Hook events where two different sources act on the same tools. */
function hookConflicts(home, root, plugs) {
  const entries = [];
  const add = (source, hooks) => {
    for (const [event, groups] of Object.entries(hooks || {})) {
      for (const g of Array.isArray(groups) ? groups : []) entries.push({ source, event, tools: matcherTools(g && g.matcher), matcher: (g && g.matcher) || '*' });
    }
  };
  for (const p of plugs) if (p.dir) add(p.name, (readJson(path.join(p.dir, 'hooks', 'hooks.json')) || {}).hooks);
  for (const [label, f] of [['user settings', path.join(home, '.claude', 'settings.json')], ['project settings', path.join(root, '.claude', 'settings.json')]]) {
    add(label, (readJson(f) || {}).hooks);
  }
  const out = [];
  const toolEvents = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      if (a.source === b.source || a.event !== b.event || !toolEvents.has(a.event)) continue;
      if (!overlaps(a.tools, b.tools)) continue;
      out.push(`${a.event}: ${a.source} (${a.matcher}) and ${b.source} (${b.matcher})`);
    }
  }
  return [...new Set(out)];
}

function report(root = process.cwd(), days = 30, home = os.homedir()) {
  const plugs = plugins(home, root);
  const servers = mcpServers(home, root);
  const sk = skills(home, root, plugs);
  const u = usage(home, days);
  const lines = [`Audit of what is enabled vs used in the last ${days} days (${u.sessions} transcripts). Nothing was changed.`, ''];

  lines.push('MCP servers (their tool descriptions load in every session):');
  if (!servers.length) lines.push('  none configured');
  for (const s of servers) lines.push(`  ${s.padEnd(36)} ${u.mcp[s] ? `${u.mcp[s]} calls` : 'UNUSED'}`);

  lines.push('', 'Plugins:');
  if (!plugs.length) lines.push('  none enabled');
  for (const p of plugs) {
    const n = Object.entries({ ...u.skill, ...u.command }).filter(([k]) => k.startsWith(`${p.name}:`)).reduce((a, [, v]) => a + v, 0);
    lines.push(`  ${p.id.padEnd(36)} ${n ? `${n} skill/command uses` : 'no skill or command used (its hooks may still act)'}`);
  }

  lines.push('', 'Skills (each description is listed in every session):');
  if (!sk.length) lines.push('  none found');
  const unused = sk.filter((s) => !u.skill[s] && !u.command[s] && !u.skill[s.split(':').pop()]);
  for (const s of sk.filter((x) => !unused.includes(x))) lines.push(`  ${s.padEnd(36)} ${(u.skill[s] || 0) + (u.command[s] || 0) || u.skill[s.split(':').pop()]} uses`);
  if (unused.length) lines.push(`  unused: ${unused.join(', ')}`);

  const conflicts = hookConflicts(home, root, plugs);
  lines.push('', 'Hooks from different sources on the same tools (their order is not defined; one may undo the other):');
  lines.push(...(conflicts.length ? conflicts.map((c) => `  ${c}`) : ['  none']));
  // Claude Code already measures these; the audit points to its numbers instead of estimating them.
  lines.push('', 'Fixed tokens of a plugin: claude plugin details <name> in a terminal (no model call). Everything loaded: /context.',
    'Prompt cache: the "Prompt cache (main)" line of /usage shows the hit rate and the likely cause of the last miss.',
    'To disable one: /plugin, /mcp, or move the skill folder out.');
  return lines.join('\n');
}

if (require.main === module) {
  process.stdout.write(`${report(path.resolve(process.argv[2] || process.cwd()), Number(process.argv[3]) || 30)}\n`);
}

module.exports = { report, usage, hookConflicts, matcherTools, overlaps };
