#!/usr/bin/env node
'use strict';
/**
 * Entry point for all trim-token hooks: `node hook.cjs <event>`, with Claude Code's JSON on
 * stdin. Answers with the event envelope, or writes nothing (= proceed unchanged). Any
 * internal error also results in silence: the plugin never blocks a call because of its
 * own failure.
 */

const CFG = require('../lib/config.cjs');
const S = require('../lib/state.cjs');

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

/* ------------------------------ eventos ------------------------------ */

function sessionStart(p, cfg) {
  const root = p.cwd;
  if (['compact', 'clear'].includes(p.source)) S.resetSession(root, p.session_id);
  if (p.source === 'resume' || !CFG.on(cfg, 'contract')) return null;
  const { CONTRACT } = require('../lib/texts.cjs');
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTRACT } };
}

function prompt(p, cfg) {
  if (!CFG.on(cfg, 'watch')) return null;
  const msg = require('../lib/watch.cjs').check({ root: p.cwd, sessionId: p.session_id, transcriptPath: p.transcript_path, cfg });
  return msg ? { systemMessage: msg } : null;
}

function pre(p, cfg) {
  if (!CFG.on(cfg, 'scan')) return null;
  const reason = require('../lib/scan.cjs').check({ tool: p.tool_name, input: p.tool_input, root: p.cwd, cfg });
  if (!reason) return null;
  S.stat(p.cwd, p.session_id, 'scan', 0, 0);
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

function subagent(p, cfg) {
  if (!CFG.on(cfg, 'subagent')) return null;
  const { SUBAGENT } = require('../lib/texts.cjs');
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT } };
}

/* ---------------------------- post-execution ---------------------------- */

function capText(text, limit, cfg, root, kind) {
  if (text.length <= limit) return null;
  const { cut, footer } = require('../lib/cap.cjs');
  const file = S.saveFull(root, kind, text);
  const c = cut(text, Math.min(cfg.limits.keep, limit - 1));
  return c.text + footer(text.length, file, c.signals > 0);
}

function postBash(resp, cfg, root) {
  if (!resp || typeof resp !== 'object' || typeof resp.stdout !== 'string') return null;
  const SH = require('../lib/shell.cjs');
  const before = resp.stdout.length + (typeof resp.stderr === 'string' ? resp.stderr.length : 0);
  const out = { ...resp };
  let changed = false;
  if (CFG.on(cfg, 'shell')) {
    for (const k of ['stdout', 'stderr']) {
      if (typeof out[k] !== 'string') continue;
      const c = SH.compact(out[k], { minChars: cfg.limits.shellMinChars });
      if (c != null) { out[k] = c; changed = true; }
    }
  }
  if (CFG.on(cfg, 'cap')) {
    const total = out.stdout.length + (typeof out.stderr === 'string' ? out.stderr.length : 0);
    if (total > cfg.limits.shellCap) {
      // The saved full text is the original (before cleanup), with stderr at the end.
      const original = resp.stdout + (resp.stderr ? `\n[stderr]\n${resp.stderr}` : '');
      const file = S.saveFull(root, 'bash', original);
      const { cut, footer } = require('../lib/cap.cjs');
      const budget = Math.min(cfg.limits.keep, cfg.limits.shellCap - 1);
      const errShare = typeof out.stderr === 'string' && out.stderr.length ? Math.min(out.stderr.length, Math.floor(budget * 0.35)) : 0;
      const so = cut(out.stdout, budget - errShare);
      const se = errShare ? cut(out.stderr, errShare) : null;
      out.stdout = so.text + footer(original.length, file, so.signals > 0 || Boolean(se && se.signals));
      if (se) out.stderr = se.text;
      changed = true;
    }
  }
  if (!changed) return null;
  const after = out.stdout.length + (typeof out.stderr === 'string' ? out.stderr.length : 0);
  return { result: out, mechanism: 'bash', before, after };
}

function postGrep(resp, cfg, root) {
  if (!CFG.on(cfg, 'cap')) return null;
  if (resp && typeof resp === 'object' && typeof resp.content === 'string') {
    const t = capText(resp.content, cfg.limits.cap, cfg, root, 'grep');
    return t == null ? null : { result: { ...resp, content: t }, mechanism: 'grep', before: resp.content.length, after: t.length };
  }
  if (typeof resp === 'string') {
    const t = capText(resp, cfg.limits.cap, cfg, root, 'grep');
    return t == null ? null : { result: t, mechanism: 'grep', before: resp.length, after: t.length };
  }
  return null;
}

/** Applies `fn` to every text in an MCP result (string, list of blocks or {content:[...]}). */
function mapMcp(resp, fn) {
  if (typeof resp === 'string') return fn(resp);
  if (Array.isArray(resp)) return resp.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: fn(b.text) } : b));
  if (resp && Array.isArray(resp.content)) return { ...resp, content: mapMcp(resp.content, fn) };
  return resp;
}

function textLength(resp) {
  let n = 0;
  mapMcp(resp, (t) => { n += t.length; return t; });
  return n;
}

function postMcp(resp, cfg, root) {
  const before = textLength(resp);
  if (!before) return null;
  let out = resp;
  if (CFG.on(cfg, 'json')) {
    out = mapMcp(out, (t) => {
      if (t.length < cfg.limits.jsonMinChars || !/^\s*[[{]/.test(t) || !/\n\s/.test(t)) return t;
      try { return JSON.stringify(JSON.parse(t)); } catch { return t; }
    });
  }
  if (CFG.on(cfg, 'cap')) {
    out = mapMcp(out, (t) => capText(t, cfg.limits.cap, cfg, root, 'mcp') ?? t);
  }
  const after = textLength(out);
  return after < before ? { result: out, mechanism: 'mcp', before, after } : null;
}

function post(p, cfg) {
  const tool = String(p.tool_name || '');
  const resp = p.tool_response;
  const root = p.cwd;
  let r = null;
  if (tool === 'Read') {
    r = require('../lib/reread.cjs').onRead({
      input: p.tool_input, result: resp, root, sessionId: p.session_id, agentId: p.agent_id, cfg, on: (id) => CFG.on(cfg, id),
    });
  } else if (tool === 'Bash') r = postBash(resp, cfg, root);
  else if (tool === 'Grep') r = postGrep(resp, cfg, root);
  else if (tool.startsWith('mcp__')) r = postMcp(resp, cfg, root);
  if (!r) return null;
  S.stat(root, p.session_id, r.mechanism, r.before, r.after);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: r.result } };
}

const HANDLERS = { 'session-start': sessionStart, prompt, pre, post, subagent };

async function main() {
  process.stdout.on('error', () => {});
  const handler = HANDLERS[process.argv[2]];
  if (!handler) return;
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (!payload || typeof payload !== 'object' || !payload.cwd) return;
  const cfg = CFG.load(payload.cwd);
  if (cfg.disabled) return;
  const out = handler(payload, cfg);
  // On Windows, pipe writes are asynchronous: exit only after the envelope was delivered.
  if (out) await new Promise((resolve) => process.stdout.write(JSON.stringify(out), () => resolve()));
}

if (require.main === module) {
  main().catch(() => { /* fail safe: silence */ }).finally(() => process.exit(0));
}

module.exports = { HANDLERS, postBash, postGrep, postMcp, mapMcp };
