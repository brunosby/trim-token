'use strict';
/**
 * Warnings to the human on UserPromptSubmit (systemMessage: does not enter the model's context).
 *   - heavy context: at each step (120k, 180k, ...) of tokens re-read per call;
 *   - cold cache: the last response is older than the prompt cache TTL, so this prompt
 *     reprocesses the whole context at full price. When the context is also large, starting
 *     over from a handoff brief costs less than carrying it on;
 *   - topic change: a prompt that shares almost no words with the last few, over a large context,
 *     carries the old topic's tokens into every call of the new one.
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

const STOP = new Set(('a o os as um uma de do da dos das e em no na nos nas para por com sem que se ao à é ser foi está isso isto esse essa este esta ' +
  'me te lhe eu você voce ele ela nós vamos agora também tambem mais muito pouco como qual quais quando onde porque por que já ja não nao sim ' +
  'the an and or of to in on for with without that this these those it is are was be by as at from into about can could should would ' +
  'please now also just then them they you we me my our your do does did make use add fix run see check let all any some more').split(' '));

function topicWords(text) {
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').match(/[a-z][a-z0-9_-]{2,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w)).map((w) => w.slice(0, 6)))];
}

/** True when the prompt shares under 10% of its words with the recent prompts (needs enough words on both sides). */
function topicChanged(promptWords, recent) {
  if (promptWords.length < 5 || recent.length < 10) return false;
  const seen = new Set(recent);
  return promptWords.filter((w) => seen.has(w)).length / promptWords.length < 0.1;
}

function step(tokens, limits) {
  return tokens < limits.watchFirst ? 0 : 1 + Math.floor((tokens - limits.watchFirst) / limits.watchStep);
}

/** @returns {string|null} */
function check({ root, sessionId, transcriptPath, cfg, prompt, now = Date.now() }) {
  if (!transcriptPath) return null;
  const file = path.join(S.windowDir(root, sessionId, null), 'watch.json');
  const st = S.readJson(file, { step: 0, coldAt: 0 });
  const words = prompt && !String(prompt).trim().startsWith('/') ? topicWords(prompt) : [];
  const recent = Array.isArray(st.recent) ? st.recent : [];
  const remember = () => {
    if (!words.length) return;
    try { S.writeJson(file, { ...S.readJson(file, st), recent: [...new Set([...words, ...recent])].slice(0, 200) }); } catch { /* best effort */ }
  };
  const u = lastUsage(transcriptPath);
  if (!u) { remember(); return null; }
  const k = Math.round(u.tokens / 1000);
  const msgs = [];
  // A keep-warm ping refreshed the cache after the last response.
  const since = Math.max(u.at || 0, require('./warm.cjs').lastPingAt(root, sessionId));
  const idle = since ? now - since : 0;
  const cold = u.ttlMs && u.tokens >= cfg.limits.coldMinTokens && idle > u.ttlMs && st.coldAt !== u.at;
  if (cold) {
    const head = `trim-token: the prompt cache went cold (last response ${Math.round(idle / 60000)} min ago; it lasts ${u.ttlMs >= 3600000 ? '1 h' : '5 min'}). ` +
      `This prompt reprocesses ~${k}k tokens at full price.`;
    // With the cache cold, nothing already paid for is lost by starting over.
    const window = u.tokens > cfg.limits.contextWindow ? 1000000 : cfg.limits.contextWindow;
    const pct = Math.round((u.tokens / window) * 100);
    msgs.push(pct >= cfg.limits.coldHandoffPct
      ? `${head} The context is ~${pct}% full: ask for a handoff brief (the handoff skill), then /clear and start from the brief.`
      : `${head} If you changed topics, /clear before the next prompt is cheaper.`);
  }
  const s = step(u.tokens, cfg.limits);
  if (s > st.step) {
    msgs.push(`trim-token: the context is at ~${k}k tokens, re-read on every call. If the current task is done, /compact or /clear makes the next turns cheaper.`);
  }
  // Only when nothing above already suggested /clear, and with enough context for it to matter.
  const shift = !cold && u.tokens >= cfg.limits.topicMinTokens && topicChanged(words, recent);
  if (shift) {
    msgs.push(`trim-token: this prompt looks like a new topic, and the context still holds ~${k}k tokens of the previous one, re-read on every call. ` +
      'If the earlier work is done, ask for a handoff brief (the handoff skill) and /clear before going on; if it is related, ignore this.');
  }
  try {
    // After a topic change, the remembered words start over from the new topic.
    const nextRecent = words.length ? [...new Set([...words, ...(shift ? [] : recent)])].slice(0, 200) : recent;
    S.writeJson(file, { step: s, coldAt: cold ? u.at : st.coldAt, recent: nextRecent });
  } catch { /* no state: the warning may repeat */ }
  return msgs.length ? msgs.join('\n') : null;
}

module.exports = { check, lastUsage, topicWords, topicChanged };
