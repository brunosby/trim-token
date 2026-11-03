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
  if (p.source === 'resume') return resumed(p, cfg);
  const parts = [];
  if (CFG.on(cfg, 'contract')) parts.push(require('../lib/texts.cjs').CONTRACT);
  // After /compact the cut outputs left the context, but their full text is still on disk.
  if (p.source === 'compact' && CFG.on(cfg, 'outputs')) {
    const recent = S.recentOutputs(root, p.session_id, 5);
    if (recent.length) {
      parts.push('Full outputs saved earlier in this session; a Grep on them finds what the cut left out without running the commands again:\n' +
        recent.map((r) => `- ${r.file} (${r.chars} chars${r.src ? `, from: ${r.src}` : ''})`).join('\n'));
    }
  }
  if (!parts.length) return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } };
}

/** Resume: a warning to the human when the context will be reprocessed at full price; nothing for the model. */
function resumed(p, cfg) {
  if (!CFG.on(cfg, 'resume')) return null;
  const R = require('../lib/resume.cjs');
  const msg = R.warning(p, cfg);
  if (!msg) return null;
  // The prompt's cold-cache warning would say the same thing again.
  try {
    const u = p.transcript_path && require('../lib/watch.cjs').lastUsage(p.transcript_path);
    if (u && u.at) require('../lib/watch.cjs').markCold(p.cwd, p.session_id, u.at);
  } catch { /* the warning may repeat */ }
  if (CFG.on(cfg, 'resumeHold')) R.arm(p.cwd, p.session_id);
  return { systemMessage: msg };
}

function prompt(p, cfg) {
  // noiseGuard lets a search into a dependency folder through when this prompt names it.
  if (require('../lib/noise.cjs').mode(cfg) !== 'off') {
    try { require('../lib/noise.cjs').savePrompt(p.cwd, p.session_id, p.prompt); } catch { /* the guard just sees no prompt */ }
  }
  if (CFG.on(cfg, 'resumeHold') && require('../lib/resume.cjs').takeHold(p.cwd, p.session_id, p.prompt)) {
    return { decision: 'block', reason: 'trim-token: this prompt was held so you can choose first (resumeHold is on). ' +
      'Send it again to go on, or run /compact <what to keep> or /clear before it.' };
  }
  // The warning reads the last ping time, so the worker is cancelled after it.
  const msg = CFG.on(cfg, 'watch') ? require('../lib/watch.cjs').check({ root: p.cwd, sessionId: p.session_id, transcriptPath: p.transcript_path, cfg, prompt: p.prompt }) : null;
  require('../lib/warm.cjs').cancel(p.cwd, p.session_id);
  return msg ? { systemMessage: msg } : null;
}

/** UserPromptExpansion: plugin commands answered by code, without a model turn. */
function expand(p, cfg) {
  const name = String(p.command_name || '');
  let text = null;
  if (name === 'trim-token:savings') text = require('./stats.cjs').report(p.cwd, p.session_id);
  else if (name === 'trim-token:audit') text = require('./audit.cjs').report(p.cwd);
  if (text == null || !CFG.on(cfg, 'direct')) return null;
  return { decision: 'block', reason: text.length > 9500 ? `${text.slice(0, 9500)}\n…` : text };
}

function subagent(p, cfg) {
  if (!CFG.on(cfg, 'subagent')) return null;
  const { SUBAGENT } = require('../lib/texts.cjs');
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: SUBAGENT } };
}

/* ---------------------------- pre-execution ---------------------------- */

/** noiseGuard: a search or listing that walks into a dependency or build folder. */
function pre(p, cfg) {
  const G = require('../lib/noise.cjs');
  const m = G.mode(cfg);
  if (m === 'off') return null;
  let hit;
  try {
    hit = G.check({ tool: String(p.tool_name || ''), input: p.tool_input, root: p.cwd, cfg, prompt: G.lastPrompt(p.cwd, p.session_id) });
  } catch { return null; } // a token saver, not a security check: any doubt lets the call through
  if (!hit) return null;
  const text = G.message(hit);
  if (m === 'warn') return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } };
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } };
}

/* ---------------------------- post-execution ---------------------------- */

function capText(text, limit, cfg, root, kind, meta) {
  if (text.length <= limit) return null;
  const { cut, footer, alreadyCut } = require('../lib/cap.cjs');
  if (alreadyCut(text)) return null;
  const file = S.saveFull(root, kind, text, meta);
  const c = cut(text, Math.min(cfg.limits.keep, limit - 1));
  return c.text + footer(text.length, file, c.signals > 0);
}

function postBash(resp, cfg, root, meta = {}) {
  if (!resp || typeof resp !== 'object' || typeof resp.stdout !== 'string') return null;
  const SH = require('../lib/shell.cjs');
  const before = resp.stdout.length + (typeof resp.stderr === 'string' ? resp.stderr.length : 0);
  const out = { ...resp };
  let changed = false;
  let grouped = false; // grouping drops the middle lines of a run, so the original is kept on disk
  if (CFG.on(cfg, 'shell')) {
    for (const k of ['stdout', 'stderr']) {
      if (typeof out[k] !== 'string') continue;
      const c = SH.compact(out[k], { minChars: cfg.limits.shellMinChars });
      if (c != null) {
        if (SH.GROUP_LINE.test(c) && !SH.GROUP_LINE.test(out[k])) grouped = true;
        out[k] = c; changed = true;
      }
    }
  }
  let saved = false;
  if (CFG.on(cfg, 'cap')) {
    const total = out.stdout.length + (typeof out.stderr === 'string' ? out.stderr.length : 0);
    const { cut, footer, alreadyCut } = require('../lib/cap.cjs');
    if (total > cfg.limits.shellCap && !alreadyCut(out.stdout)) {
      // The saved full text is the original (before cleanup), with stderr at the end.
      const original = resp.stdout + (resp.stderr ? `\n[stderr]\n${resp.stderr}` : '');
      const file = S.saveFull(root, 'bash', original, meta);
      const budget = Math.min(cfg.limits.keep, cfg.limits.shellCap - 1);
      const errShare = typeof out.stderr === 'string' && out.stderr.length ? Math.min(out.stderr.length, Math.floor(budget * 0.35)) : 0;
      const so = cut(out.stdout, budget - errShare);
      const se = errShare ? cut(out.stderr, errShare) : null;
      out.stdout = so.text + footer(original.length, file, so.signals > 0 || Boolean(se && se.signals));
      if (se) out.stderr = se.text;
      changed = true;
      saved = true;
    }
  }
  if (grouped && !saved) {
    const original = resp.stdout + (resp.stderr ? `\n[stderr]\n${resp.stderr}` : '');
    const file = S.saveFull(root, 'bash', original, meta);
    out.stdout += `\n[trimtoken] Similar log lines were grouped. Full text: ${file} — a Grep there finds any one of them.`;
  }
  if (!changed) return null;
  const after = out.stdout.length + (typeof out.stderr === 'string' ? out.stderr.length : 0);
  return { result: out, mechanism: 'bash', before, after };
}

function postGrep(resp, cfg, root, meta) {
  if (!CFG.on(cfg, 'cap')) return null;
  if (resp && typeof resp === 'object' && typeof resp.content === 'string') {
    const t = capText(resp.content, cfg.limits.cap, cfg, root, 'grep', meta);
    return t == null ? null : { result: { ...resp, content: t }, mechanism: 'grep', before: resp.content.length, after: t.length };
  }
  if (typeof resp === 'string') {
    const t = capText(resp, cfg.limits.cap, cfg, root, 'grep', meta);
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

function postMcp(resp, cfg, root, meta) {
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
    out = mapMcp(out, (t) => capText(t, cfg.limits.cap, cfg, root, 'mcp', meta) ?? t);
  }
  const after = textLength(out);
  return after < before ? { result: out, mechanism: 'mcp', before, after } : null;
}

function post(p, cfg) {
  const tool = String(p.tool_name || '');
  const resp = p.tool_response;
  const root = p.cwd;
  const ti = p.tool_input || {};
  const meta = { session: p.session_id, source: tool === 'Bash' ? ti.command : tool === 'Grep' ? `Grep ${ti.pattern || ''}` : tool };
  let r = null;
  if (tool === 'Read') {
    r = require('../lib/reread.cjs').onRead({
      input: p.tool_input, result: resp, root, sessionId: p.session_id, agentId: p.agent_id, cfg, on: (id) => CFG.on(cfg, id),
    });
  } else if (tool === 'Bash') {
    r = postBash(resp, cfg, root, meta);
  } else if (tool === 'Grep') r = postGrep(resp, cfg, root, meta);
  else if (tool.startsWith('mcp__')) r = postMcp(resp, cfg, root, meta);
  if (!r) return null;
  S.stat(root, p.session_id, r.mechanism, r.before, r.after);
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: r.result } };
}

function stop(p, cfg) {
  if (!CFG.on(cfg, 'warm') || p.stop_hook_active) return null;
  try {
    const plan = require('../lib/warm.cjs').schedule({
      root: p.cwd, sessionId: p.session_id, transcriptPath: p.transcript_path, cfg, lastUsage: require('../lib/watch.cjs').lastUsage,
    });
    if (plan) S.stat(p.cwd, p.session_id, 'warm', 0, 0);
  } catch { /* no worker: the next prompt just pays the cold cache */ }
  return null;
}

function sessionEnd(p) {
  require('../lib/warm.cjs').cancel(p.cwd, p.session_id);
  return null;
}

const HANDLERS = { 'session-start': sessionStart, prompt, pre, post, subagent, expand, stop, 'session-end': sessionEnd };

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
