'use strict';
/**
 * Scan guard (PreToolUse): denies listings that would dump the whole tree into the context
 * (unfiltered find, ls -R, tree without a depth, Glob of everything) and returns, in the denial,
 * the command with a filter and a cap. Content searches (grep -r, rg, Grep) stay free: in the
 * A/B test, blocking them only cost turns, and a large output is handled later by the cap.
 *
 * It only acts on large directories (a quick count that stops at the limit) and never when
 * the output already goes to a file, a counter or a limiter.
 */

const fs = require('fs');
const path = require('path');

const LIMITERS = /\|\s*(?:head|tail|wc|sort\s+[^|]*\|\s*uniq\s+-c|uniq\s+-c|less|more|Select-Object\s+-First|grep\s+-c|grep\s+-q)\b/;

/** Counts files up to `limit` (BFS, stops early). */
function atLeastFiles(root, limit) {
  let n = 0;
  const queue = [root];
  while (queue.length && n < limit) {
    const dir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) queue.push(path.join(dir, e.name));
      else if (++n >= limit) return true;
    }
  }
  return n >= limit;
}

/** Splits into top-level commands (&&, ||, ;), respecting quotes. */
function statements(cmd) {
  const out = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) { cur += c; if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if ((c === '&' && cmd[i + 1] === '&') || (c === '|' && cmd[i + 1] === '|')) { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '\n') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function words(s) {
  return (s.match(/"[^"]*"|'[^']*'|\S+/g) || []);
}

function exclusions(noise) {
  return noise.filter((d) => ['node_modules', '.venv', 'venv', '.git', 'dist', 'build'].includes(d))
    .map((d) => `-not -path '*/${d}/*'`).join(' ');
}

/** @returns {string|null} reason for the denial, with the alternative included. */
function checkShell(cmd, noise) {
  for (const stmt of statements(cmd)) {
    if (LIMITERS.test(stmt) || /(^|\s)>{1,2}\s*\S/.test(stmt.replace(/2>&1|2>\/dev\/null|>\/dev\/null/g, ''))) continue;
    const pipeline = stmt.split(/\|(?!\|)/);
    const first = pipeline[0].trim();
    const w = words(first);
    const prog = path.basename(w[0] || '');
    const rest = w.slice(1);
    const piped = pipeline.length > 1;

    if (prog === 'find') {
      const filtered = rest.some((a) => /^-(?:i?name|i?path|i?regex|maxdepth|newer|mtime|mmin|size|empty)$/.test(a));
      if (!filtered && !piped) {
        return `[trimtoken] Blocked: \`${first}\` lists every file under the tree (dependencies and build output included), and all of it would enter the context. ` +
          `Run a filtered, capped form instead, e.g. \`find . -name '*.py' ${exclusions(noise)} | head -50\`, or use the Glob tool with an extension or name pattern.`;
      }
    }
    if (prog === 'ls' && rest.some((a) => /^-[A-Za-z]*R/.test(a))) {
      return `[trimtoken] Blocked: \`${first}\` prints the whole tree recursively. ` +
        "Use the Glob tool with a pattern (e.g. 'src/**/*.ts'), or `ls` one directory at a time.";
    }
    if (prog === 'tree' && !rest.some((a) => a === '-L' || /^-L\d/.test(a)) && !piped) {
      return `[trimtoken] Blocked: \`${first}\` without a depth prints the whole tree. Run \`tree -L 2 -I '${noise.slice(0, 4).join('|')}'\` instead.`;
    }
  }
  return null;
}

/**
 * @param {{tool:string, input:object, root:string, cfg:object}} args
 * @returns {string|null}
 */
function check({ tool, input, root, cfg }) {
  if (!input || typeof input !== 'object') return null;
  let reason = null;
  if (tool === 'Bash' && typeof input.command === 'string') {
    reason = checkShell(input.command, cfg.noise);
  } else if (tool === 'Glob' && typeof input.pattern === 'string') {
    const p = input.pattern.replace(/\\/g, '/');
    const last = p.split('/').pop();
    if (/^(?:\*\*\/)*\*{1,2}(?:\/\*{1,2})*$/.test(p) || (/^\*{1,2}$/.test(last) && /^\*\*\//.test(p) && !input.path)) {
      reason = `[trimtoken] Blocked: Glob "${input.pattern}" matches every path in the tree. ` +
        'Bound it by extension ("**/*.py"), by name ("**/*Service*") or by directory (path: "src").';
    }
  }
  if (!reason) return null;
  return atLeastFiles(root, cfg.limits.scanMinFiles) ? reason : null;
}

module.exports = { check, checkShell, statements, atLeastFiles };
