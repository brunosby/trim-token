'use strict';
/**
 * Cost of resuming a session. On SessionStart with source "resume", Claude Code (2.1.251+) says
 * whether the prompt cache has likely expired, how many tokens the context holds and the
 * estimated price of writing them to the cache again. The warning goes to the human
 * (systemMessage, outside the model's context) before the first prompt pays for that.
 *
 * Optionally ("on": ["resumeHold"], off by default) the first prompt after such a resume is
 * held once, so the human can choose /compact or /clear first; sending it again goes through.
 */

const path = require('path');
const S = require('./state.cjs');

function holdFile(root, sessionId) {
  return path.join(S.windowDir(root, sessionId, null), 'resume.json');
}

function usd(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `, estimated US$ ${n < 0.1 ? n.toFixed(3) : n.toFixed(2)} at API prices` : '';
}

/** @returns {string|null} the warning for a resume with a cold cache and a large context. */
function warning(p, cfg) {
  if (p.source !== 'resume' || p.prompt_cache_likely_expired !== true) return null;
  const tokens = Number(p.context_tokens);
  if (!Number.isFinite(tokens) || tokens < cfg.limits.coldMinTokens) return null;
  const k = Math.round(tokens / 1000);
  const window = tokens > cfg.limits.contextWindow ? 1000000 : cfg.limits.contextWindow;
  const pct = Math.round((tokens / window) * 100);
  return `trim-token: this resumed session holds ~${k}k tokens of context and its prompt cache has likely expired, ` +
    `so the first prompt reprocesses all of it at full price${usd(p.estimated_cache_write_usd)}. ` +
    (pct >= cfg.limits.coldHandoffPct
      ? 'If the earlier work is not needed in full, /compact <what to keep> or /clear costs less.'
      : 'If the next prompt is on another topic, /clear costs less.');
}

/** Remembers that the next prompt of this session may be held (resumeHold on). */
function arm(root, sessionId) {
  try { S.writeJson(holdFile(root, sessionId), { hold: true }); } catch { /* no state: no hold */ }
}

/** True once, for the first prompt after an armed resume. Commands (/compact, /clear) are never held. */
function takeHold(root, sessionId, prompt) {
  const file = holdFile(root, sessionId);
  const st = S.readJson(file, null);
  if (!st || !st.hold) return false;
  try { S.writeJson(file, { hold: false }); } catch { return false; }
  return !String(prompt || '').trim().startsWith('/');
}

module.exports = { warning, arm, takeHold };
