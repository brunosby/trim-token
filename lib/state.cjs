'use strict';
/**
 * State in <project>/.trimtoken/: re-reads per window, full outputs and statistics.
 * A window is the main conversation or a subagent, which shares its session_id
 * but has its own context (agent_id).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Records here stay on disk with no review, so what looks like a credential is hidden before it is written.
const SECRET = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(@)/gi,
  /(\b(?:password|passwd|pwd|senha|secret|token|api[_-]?key)\s*[:=]\s*["']?)[^\s"',;|]{6,}/gi,
];

/** Text with what looks like a credential replaced by [hidden]. */
function mask(text) {
  let out = String(text);
  for (const re of SECRET) out = out.replace(re, (m, a, b) => (typeof a === 'string' && a && m.startsWith(a) ? `${a}[hidden]${typeof b === 'string' ? b : ''}` : '[hidden]'));
  return out;
}

/** The user's home folder as ~, for records that only describe where something ran. */
function home(text) {
  const h = os.homedir();
  if (!h || h.length < 4) return String(text);
  return String(text).split(h).join('~').split(h.replace(/\\/g, '/')).join('~');
}

const MAX_LOG_BYTES = 1024 * 1024;

/** Appends one line; past MAX_LOG_BYTES the file keeps only its newer half. */
function appendCapped(file, line) {
  fs.appendFileSync(file, `${line}\n`);
  try {
    if (fs.statSync(file).size <= MAX_LOG_BYTES) return;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`);
    fs.renameSync(tmp, file);
  } catch { /* trimming is best effort */ }
}

function sha(s, n = 16) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, n);
}

function safeName(s) {
  const raw = String(s);
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return clean === raw ? clean : `${clean}-${sha(raw, 8)}`;
}

/** Creates <root>/.trimtoken and, in a git repository, adds the folder to .git/info/exclude (once). */
function baseDir(root) {
  const dir = path.join(root, '.trimtoken');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const info = path.join(root, '.git', 'info');
      if (fs.existsSync(info)) {
        const exclude = path.join(info, 'exclude');
        const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
        if (!/^\.trimtoken\/?$/m.test(cur)) fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}.trimtoken/\n`);
      }
    } catch { /* no exclude: just one more directory in the status */ }
  }
  return dir;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

/** Window directory: state/<session>/<main | subagent id>. */
function windowDir(root, sessionId, agentId) {
  return path.join(baseDir(root), 'state', safeName(sessionId || 'no-session'), safeName(agentId || 'main'));
}

/** After compacting or clearing, nothing that was read is in the window anymore. */
function resetSession(root, sessionId) {
  try {
    fs.rmSync(path.join(root, '.trimtoken', 'state', safeName(sessionId || 'no-session')), { recursive: true, force: true });
  } catch { /* nada guardado */ }
}

const MAX_OUT_FILES = 60;
const OUT_TTL_MS = 7 * 24 * 3600 * 1000; // saved outputs older than a week are deleted

/**
 * Writes the full output and returns the absolute path. `meta` ({session, source}) goes into
 * out/index.jsonl, so the files of a session can be listed again after /compact.
 */
function saveFull(root, kind, text, meta = {}) {
  const dir = path.join(baseDir(root), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${kind}-${sha(text, 8)}.txt`);
  fs.writeFileSync(file, mask(text));
  try {
    const src = meta.source ? home(mask(String(meta.source).replace(/\s+/g, ' '))).slice(0, 120) : null;
    appendCapped(path.join(dir, 'index.jsonl'), JSON.stringify({ t: Date.now(), s: meta.session || null, kind, file, chars: text.length, src }));
  } catch { /* the index only helps after /compact */ }
  try {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    const old = Date.now() - OUT_TTL_MS;
    all.forEach((f, i) => {
      const t = Number(f.split('-')[0]);
      if (i < all.length - MAX_OUT_FILES || (Number.isFinite(t) && t < old)) fs.rmSync(path.join(dir, f), { force: true });
    });
  } catch { /* pruning is best effort */ }
  return file;
}

/** Full outputs saved in this session that still exist, newest first. */
function recentOutputs(root, sessionId, max = 5) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, '.trimtoken', 'out', 'index.jsonl'), 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < max; i--) {
    let r;
    try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r && r.s === sessionId && r.file && fs.existsSync(r.file)) out.push(r);
  }
  return out;
}

function stat(root, sessionId, mechanism, before, after) {
  try {
    appendCapped(path.join(baseDir(root), 'stats.jsonl'), JSON.stringify({ t: Date.now(), s: sessionId || null, m: mechanism, before, after }));
  } catch { /* statistics never get in the way */ }
}

module.exports = { sha, safeName, baseDir, windowDir, readJson, writeJson, resetSession, saveFull, recentOutputs, stat, mask, home, appendCapped, MAX_LOG_BYTES };
