'use strict';
/**
 * State in <project>/.trimtoken/: re-reads per window, full outputs and statistics.
 * A window is the main conversation or a subagent, which shares its session_id
 * but has its own context (agent_id).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

/** Writes the full output and returns the absolute path. */
function saveFull(root, kind, text) {
  const dir = path.join(baseDir(root), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${kind}-${sha(text, 8)}.txt`);
  fs.writeFileSync(file, text);
  try {
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - MAX_OUT_FILES))) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* pruning is best effort */ }
  return file;
}

function stat(root, sessionId, mechanism, before, after) {
  try {
    const line = JSON.stringify({ t: Date.now(), s: sessionId || null, m: mechanism, before, after });
    fs.appendFileSync(path.join(baseDir(root), 'stats.jsonl'), `${line}\n`);
  } catch { /* statistics never get in the way */ }
}

module.exports = { sha, safeName, baseDir, windowDir, readJson, writeJson, resetSession, saveFull, stat };
