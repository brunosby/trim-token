'use strict';
/**
 * Warnings to the human on UserPromptSubmit (systemMessage: does not enter the model's context).
 *   - heavy context: at each step (120k, 180k, ...) of tokens re-read per call;
 *   - cold cache: the last response is older than the prompt cache TTL, so this prompt
 *     reprocesses the whole context at full price.
 */

const fs = require('fs');
const path = require('path');
const S = require('./state.cjs');

const TAIL = 512 * 1024;

/** Last usage of the main conversation in the transcript: {tokens, at, ttlMs}. */
function lastUsage(transcriptPath) {
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    let found = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf('"usage"') < 0) continue;
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }
      const u = o && o.type === 'assistant' && !o.isSidechain && o.message && o.message.usage;
      if (!u) continue;
      if (!found) {
        const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const at = Date.parse(o.timestamp || '');
        if (!tokens) continue;
        found = { tokens, at: Number.isFinite(at) ? at : null, ttlMs: null };
      }
      const cc = u.cache_creation || {};
      if (cc.ephemeral_1h_input_tokens > 0) { found.ttlMs = 3600000; break; }
      if (cc.ephemeral_5m_input_tokens > 0) { found.ttlMs = 300000; break; }
    }
    return found;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* nada */ }
  }
}

function step(tokens, limits) {
  return tokens < limits.watchFirst ? 0 : 1 + Math.floor((tokens - limits.watchFirst) / limits.watchStep);
}

/** @returns {string|null} */
function check({ root, sessionId, transcriptPath, cfg, now = Date.now() }) {
  if (!transcriptPath) return null;
  const u = lastUsage(transcriptPath);
  if (!u) return null;
  const file = path.join(S.windowDir(root, sessionId, null), 'watch.json');
  const st = S.readJson(file, { step: 0, coldAt: 0 });
  const k = Math.round(u.tokens / 1000);
  const msgs = [];
  const idle = u.at ? now - u.at : 0;
  const cold = u.ttlMs && u.tokens >= cfg.limits.coldMinTokens && idle > u.ttlMs && st.coldAt !== u.at;
  if (cold) {
    msgs.push(`trim-token: the prompt cache went cold (last response ${Math.round(idle / 60000)} min ago; it lasts ${u.ttlMs >= 3600000 ? '1 h' : '5 min'}). ` +
      `This prompt reprocesses ~${k}k tokens at full price. If you changed topics, /clear before the next prompt is cheaper.`);
  }
  const s = step(u.tokens, cfg.limits);
  if (s > st.step) {
    msgs.push(`trim-token: the context is at ~${k}k tokens, re-read on every call. If the current task is done, /compact or /clear makes the next turns cheaper.`);
  }
  if (cold || s !== st.step) {
    try { S.writeJson(file, { step: s, coldAt: cold ? u.at : st.coldAt }); } catch { /* no state: the warning may repeat */ }
  }
  return msgs.length ? msgs.join('\n') : null;
}

module.exports = { check, lastUsage };
