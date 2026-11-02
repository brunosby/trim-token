'use strict';
/**
 * File re-reads through Claude Code's Read.
 *
 * Per window (main conversation or subagent) it keeps the hash and a copy of every file read
 * in full. On a full re-read:
 * When the content changed and the diff is small, only the changed lines are returned.
 * (An identical re-read is answered by Claude Code itself with a "file unchanged" notice.)
 */

const fs = require('fs');
const path = require('path');
const S = require('./state.cjs');
const { renderHunks } = require('./linediff.cjs');

const MAX_FILES = 40;
const SNAP_MAX = 400000;
const DIFF_MAX_RATIO = 0.5;

/** Content of a Read result: {type:'text', file:{content,...}} or a string. */
function contentOf(result) {
  if (typeof result === 'string') return { text: result, full: true };
  const f = result && result.file;
  if (!f || typeof f.content !== 'string') return null;
  const partial = Number.isFinite(f.numLines) && Number.isFinite(f.totalLines) && f.numLines < f.totalLines;
  return { text: f.content, full: !partial, path: f.filePath };
}

function withContent(result, text) {
  if (typeof result === 'string') return text;
  const lines = text.split('\n').length;
  return { ...result, file: { ...result.file, content: text, numLines: lines, startLine: 1, totalLines: lines } };
}

function isRanged(input) {
  return ['offset', 'limit', 'pages'].some((k) => input && input[k] !== undefined && input[k] !== null && input[k] !== '');
}

function keyOf(file) {
  const norm = path.resolve(String(file)).replace(/\\/g, '/');
  return S.sha(process.platform === 'win32' || process.platform === 'darwin' ? norm.toLowerCase() : norm);
}

/**
 * @returns {null | {result:unknown, mechanism:string, before:number, after:number}}
 */
function onRead({ input, result, root, sessionId, agentId, cfg, on }) {
  const c = contentOf(result);
  const file = (input && (input.file_path || input.path)) || (c && c.path);
  if (!c || !file || !c.text) return null;
  const ranged = isRanged(input) || !c.full;
  const dir = S.windowDir(root, sessionId, agentId);
  const indexFile = path.join(dir, 'index.json');
  const index = S.readJson(indexFile, {});
  const key = keyOf(path.isAbsolute(file) ? file : path.join(root, file));
  const prev = index[key];
  const hash = S.sha(c.text, 20);

  let reply = null;
  if (!ranged && prev && prev.full && c.text.length >= cfg.limits.rereadMinChars && on('reread')) {
    // An identical re-read never gets here with content: Claude Code answers it with "file unchanged".
    if (prev.hash !== hash) {
      const old = readSnap(dir, key);
      const d = old != null ? renderHunks(old, c.text) : null;
      if (d && d.text.length < c.text.length * DIFF_MAX_RATIO) {
        const total = c.text.split('\n').length;
        const head = `[trimtoken] ${path.basename(file)} changed since your last full read in this conversation (that read is still above). ` +
          `Only the ${d.changed} changed line(s) follow; the number after +/- is the line in the CURRENT file (${total} lines). ` +
          'The line numbers on the left of this view are not file lines.';
        reply = { mechanism: 'reread-diff', text: `${head}\n${d.text}` };
      }
    }
  }

  if (!ranged) {
    index[key] = { hash, full: true, at: Date.now() };
    if (c.text.length <= SNAP_MAX) writeSnap(dir, key, c.text);
  } else if (!prev) {
    index[key] = { hash, full: false, at: Date.now() };
  }
  prune(index, dir);
  try { S.writeJson(indexFile, index); } catch { /* no index: the next read passes untouched */ }

  if (!reply) return null;
  return { result: withContent(result, reply.text), mechanism: reply.mechanism, before: c.text.length, after: reply.text.length };
}

function readSnap(dir, key) {
  try { return fs.readFileSync(path.join(dir, `${key}.txt`), 'utf8'); } catch { return null; }
}

function writeSnap(dir, key, text) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${key}.txt`), text); } catch { /* no copy: no diff */ }
}

function prune(index, dir) {
  const keys = Object.keys(index).sort((a, b) => index[a].at - index[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_FILES))) {
    delete index[k];
    try { fs.rmSync(path.join(dir, `${k}.txt`), { force: true }); } catch { /* already gone */ }
  }
}

module.exports = { onRead, contentOf, isRanged };
