'use strict';
/**
 * noiseGuard (PreToolUse): a search or listing that walks into a dependency or build folder from the
 * "noise" list gets the same command without that folder. Reading one file there passes, and so does
 * any call once the user's prompt names the folder or the package. It reads the command line only, so
 * a script that walks the folder by itself passes; any doubt lets the call through.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const CFG = require('./config.cjs');
const S = require('./state.cjs');

// Dependencies wherever they sit. The other names count only where .gitignore (or .ignore) lists
// them, since a "bin" or "build" folder can hold the project's own code.
const ALWAYS = ['node_modules', '.venv', 'venv', 'site-packages'];
// Path parts after the folder that name no package.
const GENERIC = new Set(['lib', 'lib64', 'src', 'dist', 'build', 'bin', 'include', 'scripts', 'esm', 'cjs', 'types',
  'site-packages', 'node_modules', 'package.json', 'index.js']);
const WILD = /[*?[\]{}]/;

/** 'block', 'warn' or 'off'. */
function mode(cfg) {
  if (!CFG.on(cfg, 'noiseGuard') || cfg.noiseGuard === false) return 'off';
  return cfg.noiseGuard === 'warn' ? 'warn' : 'block';
}

/* ---------------------------- the user's prompt ---------------------------- */

// Only a hash of each word of the prompt is kept, never its text: the guard needs to know whether a folder or
// package was named, not what the prompt said.
function promptFile(root, sessionId) {
  return path.join(root, '.trimtoken', 'state', S.safeName(sessionId || 'no-session'), 'prompt-words.json');
}

const wordHash = (w) => S.sha(`w:${w}`, 10);

function promptWords(prompt) {
  const p = String(prompt).slice(0, 4000).toLowerCase();
  const out = new Set();
  for (const w of p.split(/\s+/)) if (w) out.add(wordHash(w.replace(/^[^\w.@~-]+|[^\w-]+$/g, '')));
  for (const w of p.split(/[^\w-]+/)) if (w) out.add(wordHash(w));
  return [...out];
}

function savePrompt(root, sessionId, prompt) {
  if (typeof prompt !== 'string') return;
  S.baseDir(root);
  const f = promptFile(root, sessionId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(promptWords(prompt)));
  try { fs.rmSync(path.join(path.dirname(f), 'prompt.txt'), { force: true }); } catch { /* older versions kept the text */ }
}

/** The last prompt of the session as a set of word hashes (empty when there is none). */
function lastPrompt(root, sessionId) {
  try { return new Set(JSON.parse(fs.readFileSync(promptFile(root, sessionId), 'utf8'))); } catch { return new Set(); }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does the prompt (its text, or the set of its word hashes) name `word`? */
function mentions(text, word) {
  if (!text) return false;
  const w = word.toLowerCase();
  if (text instanceof Set) {
    if (text.has(wordHash(w))) return true;
    const pieces = w.split(/[^\w-]+/).filter(Boolean);
    return pieces.length > 0 && pieces.every((x) => text.has(wordHash(x)));
  }
  return new RegExp(`(^|[^\\w-])${esc(w)}($|[^\\w-])`).test(String(text).toLowerCase());
}

/** Does the prompt name the folder, or a package inside it? */
function named(prompt, hit) {
  if (!prompt) return false;
  if (mentions(prompt, hit.folder)) return true;
  return hit.rest
    .filter((s) => s.length >= 3 && !WILD.test(s) && !GENERIC.has(s.toLowerCase()) && !/^python\d/i.test(s))
    .some((s) => mentions(prompt, s));
}

/* ------------------------------ the project ------------------------------ */

function ignoreLists(root) {
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8').split(/\r?\n/); } catch { return []; } };
  const clean = (lines) => lines.map((l) => l.trim()).filter((l) => l && !/^[#!]/.test(l))
    .map((l) => l.replace(/\/\*\*$/, '').replace(/\/+$/, ''));
  const git = clean(read('.gitignore'));
  const own = clean([...read('.ignore'), ...read('.rgignore')]);
  // ripgrep, and the Grep tool built on it, reads .gitignore only inside a git repository.
  return { intent: [...git, ...own], search: fs.existsSync(path.join(root, '.git')) ? [...git, ...own] : own };
}

function listed(lines, rel) {
  const name = rel.split('/').pop();
  return lines.some((p) => p === name || p === `**/${name}` || p === `/${rel}` || p === rel);
}

function context(root, cfg) {
  const defaults = new Set(CFG.DEFAULTS.noise);
  // A name the user added counts everywhere, like the dependency folders.
  const always = new Set([...ALWAYS, ...cfg.noise.filter((n) => !defaults.has(n))]);
  return { root, noise: new Set(cfg.noise), always, ign: ignoreLists(root) };
}

function isNoise(ctx, rel) {
  const name = rel.split('/').pop();
  return ctx.noise.has(name) && (ctx.always.has(name) || listed(ctx.ign.intent, rel));
}

function toAbs(base, p) {
  let s = String(p).replace(/\\/g, '/');
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(s);
  if (drive && process.platform === 'win32') s = `${drive[1]}:/${s.slice(3)}`;
  if (s === '~' || s.startsWith('~/')) s = path.join(os.homedir(), s.slice(1));
  return path.resolve(base, s);
}

const relTo = (root, abs) => path.relative(root, abs).split(path.sep).join('/');
const isDir = (abs) => { try { return fs.statSync(abs).isDirectory(); } catch { return false; } };
const isFile = (abs) => { try { return fs.statSync(abs).isFile(); } catch { return false; } };

/** The part of a path before its first wildcard: `src/*.js` -> `src`. */
function wildBase(p) {
  const segs = String(p).replace(/\\/g, '/').split('/');
  const i = segs.findIndex((s) => WILD.test(s));
  if (i < 0) return p;
  return segs.slice(0, i).join('/') || (String(p).startsWith('/') ? '/' : '.');
}

/** The first noise folder in path `p`: {folder, rel, rest}. */
function inside(ctx, base, p) {
  const segs = relTo(ctx.root, toAbs(base, p)).split('/');
  for (let i = 0; i < segs.length; i++) {
    const rel = segs.slice(0, i + 1).join('/');
    if (ctx.noise.has(segs[i]) && isNoise(ctx, rel)) return { folder: segs[i], rel, rest: segs.slice(i + 1) };
  }
  return null;
}

/** A noise folder named in a glob pattern (`node_modules/**`, `** /node_modules/**`). */
function globHit(ctx, pattern) {
  const segs = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '').split('/');
  for (let i = 0; i < segs.length; i++) {
    const rel = segs.slice(0, i + 1).join('/');
    if (ctx.noise.has(segs[i]) && (ctx.always.has(segs[i]) || listed(ctx.ign.intent, rel))) return { folder: segs[i], rel, rest: segs.slice(i + 1) };
  }
  return null;
}

/** Noise folders up to 3 levels below `dir` (a bounded walk) that `keep` accepts. */
function noiseUnder(ctx, dir, keep = () => true) {
  const out = [];
  let budget = 400;
  const walk = (abs, depth) => {
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory() || e.name === '.git') continue;
      if (budget-- <= 0) return;
      const child = path.join(abs, e.name);
      const rel = relTo(ctx.root, child);
      if (ctx.noise.has(e.name)) {
        if (isNoise(ctx, rel) && keep(rel)) out.push(rel);
        continue;
      }
      if (depth < 3) walk(child, depth + 1);
    }
  };
  walk(dir, 1);
  return out;
}

/** Folders that a ripgrep-style search reads: not ignored (unless told so), not hidden (unless told so). */
function searched(ctx, rel, { noIgnore = false, hidden = true } = {}) {
  if (!hidden && rel.split('/').pop().startsWith('.')) return false;
  return noIgnore || !listed(ctx.ign.search, rel);
}

/* ------------------------------ shell commands ------------------------------ */

/** Pipelines (split on ; && || & and newlines), each a list of stages (split on |). Quotes are kept. */
function pipelines(cmd) {
  const s = String(cmd);
  const out = [];
  let stages = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { cur += ch; if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
    if (ch === '&' && (s[i - 1] === '>' || s[i + 1] === '>')) { cur += ch; continue; } // 2>&1, &>
    if (ch === '|' && s[i + 1] !== '|') { stages.push(cur); cur = ''; continue; }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|') {
      if (s[i + 1] === ch) i++;
      stages.push(cur); out.push(stages); stages = []; cur = '';
      continue;
    }
    cur += ch;
  }
  stages.push(cur); out.push(stages);
  return out.map((st) => st.map((x) => x.trim()).filter(Boolean)).filter((st) => st.length);
}

function words(stage) {
  const out = [];
  let cur = '';
  let q = null;
  let quoted = false;
  for (const ch of stage) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; quoted = true; continue; }
    if (/\s/.test(ch)) { if (cur || quoted) out.push(cur); cur = ''; quoted = false; continue; }
    cur += ch;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

function quoter(ps) {
  return (w) => (/^[\w@%+=:,./\\-]+$/.test(w) ? w : ps ? `'${w.replace(/'/g, "''")}'` : `'${w.replace(/'/g, "'\\''")}'`);
}

function findScan(ws) {
  const a = ws.slice(1);
  const lead = [];
  while (a.length && /^-[HLP]$/.test(a[0])) lead.push(a.shift());
  const targets = [];
  while (a.length && !/^[-(!]/.test(a[0]) && a[0] !== '\\(') targets.push(a.shift());
  const t = targets.length ? targets : ['.'];
  return {
    targets: t,
    dotDirs: true,
    fix: (names, qq) => {
      const global = [];
      const rest = [];
      for (let i = 0; i < a.length; i++) {
        if (/^-(max|min)depth$/.test(a[i])) global.push(a[i], ...(a[i + 1] ? [a[++i]] : []));
        else rest.push(a[i]);
      }
      const prune = names.length === 1 ? ['-name', names[0]] : ['(', ...names.flatMap((n, i) => (i ? ['-o', '-name', n] : ['-name', n])), ')'];
      const acts = rest.some((w) => /^-(print0?|printf|fprint\w*|exec(dir)?|ok(dir)?|delete|ls|fls|quit)$/.test(w));
      const body = rest.includes('-o') ? ['(', ...rest, ')'] : rest;
      return [ws[0], ...lead, ...t, ...global, ...prune, '-prune', '-o', ...body, ...(acts ? [] : ['-print'])].map(qq).join(' ');
    },
  };
}

// Options whose value is the next word (grep, rg).
const GREP_LONG = new Set(['--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context',
  '--directories', '--devices', '--label', '--binary-files', '--include', '--exclude', '--exclude-dir', '--exclude-from']);
const RG_LONG = new Set(['--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--max-count', '--max-depth',
  '--context', '--after-context', '--before-context', '--threads', '--max-columns', '--replace', '--encoding', '--sort',
  '--sortr', '--max-filesize', '--type-add', '--pre', '--pre-glob', '--ignore-file', '--path-separator']);

/** Walks the options of a grep-like command; `onFlag(letter)` sees each short flag. Returns positionals. */
function options(ws, longWithValue, shortWithValue, onFlag, onLong) {
  const pos = [];
  let pattern = false;
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (w === '--') { pos.push(...ws.slice(i + 1)); break; }
    if (w.startsWith('--')) {
      onLong(w);
      if (/^--(regexp|file|files)(=|$)/.test(w)) pattern = true;
      if (!w.includes('=') && longWithValue.has(w)) i++;
      continue;
    }
    if (/^-[A-Za-z0-9.]+$/.test(w)) {
      const fl = w.slice(1);
      for (let k = 0; k < fl.length; k++) {
        onFlag(fl[k]);
        if (shortWithValue.includes(fl[k])) {
          if (fl[k] === 'e' || fl[k] === 'f') pattern = true;
          if (k === fl.length - 1) i++; // otherwise the value is glued on: -A3
          break;
        }
      }
      continue;
    }
    pos.push(w);
  }
  const targets = pattern ? pos : pos.slice(1);
  return targets.length ? targets : ['.'];
}

function grepScan(ws) {
  let rec = false;
  const targets = options(ws, GREP_LONG, 'efmABCdD', (c) => { if (c === 'r' || c === 'R') rec = true; },
    (w) => { if (/^--(recursive|dereference-recursive)$/.test(w)) rec = true; });
  if (!rec) return null;
  return { targets, dotDirs: true, envFiles: true,
    fix: (names, qq, files = []) => [ws[0], ...names.map((n) => `--exclude-dir=${n}`), ...files.map((f) => `--exclude=${f}`), ...ws.slice(1)].map(qq).join(' ') };
}

function rgScan(ws) {
  let u = 0;
  let noIgnore = false;
  let hidden = false;
  const targets = options(ws, RG_LONG, 'efgtTmABCjdMrE', (c) => { if (c === 'u') u++; if (c === '.') hidden = true; },
    (w) => { if (/^--no-ignore(-vcs)?$/.test(w)) noIgnore = true; if (w === '--hidden') hidden = true; });
  return {
    targets,
    search: { noIgnore: noIgnore || u >= 1, hidden: hidden || u >= 2 },
    fix: (names, qq) => [ws[0], ...names.flatMap((n) => ['-g', `!${n}`]), ...ws.slice(1)].map(qq).join(' '),
  };
}

function lsScan(ws) {
  const rec = ws.slice(1).some((w) => w === '--recursive' || /^-[A-Za-z]*R/.test(w));
  if (!rec) return null;
  const pos = ws.slice(1).filter((w) => !w.startsWith('-'));
  return { targets: pos.length ? pos : ['.'], fix: (names, qq) => [ws[0], ...names.map((n) => `--ignore=${n}`), ...ws.slice(1)].map(qq).join(' ') };
}

function treeScan(ws) {
  const pos = [];
  let windows = false;
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (/^\/[a-z]$/i.test(w)) { windows = true; continue; }
    if (/^-[LIPoHT]$/.test(w) || /^--(filelimit|charset)$/.test(w)) { i++; continue; }
    if (!w.startsWith('-')) pos.push(w);
  }
  return {
    targets: pos.length ? pos : ['.'],
    fix: windows ? null : (names, qq) => [ws[0], '-I', names.join('|'), ...ws.slice(1)].map(qq).join(' '),
  };
}

/** cmd's `dir /s`. */
function dirScan(ws) {
  const switches = ws.slice(1).filter((w) => w.startsWith('/'));
  if (!switches.some((w) => w.split('/').some((x) => /^s$/i.test(x)))) return null;
  const pos = ws.slice(1).filter((w) => !w.startsWith('/'));
  return {
    targets: pos.length ? pos : ['.'],
    fix: (names, qq) => `${ws.map(qq).join(' ')} | findstr /v /i "${names.map((n) => `\\\\${n}\\\\`).join(' ')}"`,
  };
}

/** PowerShell's Get-ChildItem -Recurse (also through its gci, ls and dir aliases). */
function gciScan(ws) {
  let rec = false;
  const targets = [];
  let positional = 0;
  for (let i = 1; i < ws.length; i++) {
    const w = ws[i];
    if (w.startsWith('-')) {
      const [name, val] = w.slice(1).toLowerCase().split(':');
      if (name && 'recurse'.startsWith(name)) { rec = val !== '$false'; continue; }
      if (name === 'depth') { rec = true; i++; continue; }
      if (['path', 'literalpath', 'lp', 'pspath'].includes(name)) { targets.push(...String(ws[++i] || '').split(',').filter(Boolean)); continue; }
      if (['filter', 'include', 'exclude', 'attributes'].includes(name)) i++;
      continue;
    }
    if (positional++ === 0) targets.push(...w.split(',').filter(Boolean));
  }
  if (!rec) return null;
  return {
    targets: targets.length ? targets : ['.'],
    fix: (names, qq) => `${ws.map(qq).join(' ')} | Where-Object FullName -notmatch '[\\\\/](${names.map(esc).join('|')})([\\\\/]|$)'`,
  };
}

function scanner(name, ws, ps) {
  if (name === 'find' && !ps) return findScan(ws);
  if (['grep', 'egrep', 'fgrep'].includes(name)) return grepScan(ws);
  if (name === 'rg') return rgScan(ws);
  if (name === 'tree') return treeScan(ws);
  if (['get-childitem', 'gci'].includes(name) || (ps && ['ls', 'dir'].includes(name))) return gciScan(ws);
  if (name === 'ls') return lsScan(ws);
  if (name === 'dir') return dirScan(ws);
  return null;
}

/** What `sc` walks into from `base`: {names, where, parent} or null. */
function walks(ctx, base, sc, text, prompt) {
  const found = [];
  for (const t of sc.targets) {
    const target = wildBase(t);
    const abs = toAbs(base, target);
    const h = inside(ctx, base, target);
    if (h) {
      if (isFile(abs) || named(prompt, h)) continue;
      return { names: [h.folder], where: [h.rel], parent: false };
    }
    if (!isDir(abs)) continue;
    for (const rel of noiseUnder(ctx, abs, (r) => !sc.search || searched(ctx, r, sc.search))) if (!found.includes(rel)) found.push(rel);
  }
  // A folder the command names anyway (--exclude-dir=, -prune, | grep -v) is left out by it.
  const names = [...new Set(found.map((r) => r.split('/').pop()))].filter((n) => !mentions(text, n) && !mentions(prompt, n));
  if (!names.length) return null;
  return { names, where: found.filter((r) => names.includes(r.split('/').pop())).slice(0, 3), parent: true };
}

const ENV_FILE = /^\.env(?:\.[\w.-]+)?$/i;
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/i;

/** Credentials files (.env, .env.local…) directly in the searched folders that the command does not already name. */
function envFilesIn(dirs, text) {
  const out = new Set();
  for (const d of dirs) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (ENV_FILE.test(n) && !ENV_TEMPLATE.test(n) && !text.includes(n)) out.add(n);
  }
  return [...out];
}

function checkShell(ctx, cmd, ps, prompt) {
  let base = ctx.root;
  const qq = quoter(ps);
  for (const stages of pipelines(cmd)) {
    for (let si = 0; si < stages.length; si++) {
      let ws = words(stages[si]);
      while (ws.length && /^[A-Za-z_]\w*=/.test(ws[0])) ws.shift();
      while (ws.length && /^(sudo|command|time|nice|exec)$/.test(ws[0])) ws.shift();
      if (!ws.length) continue;
      const cmdName = (w) => String(w || '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.exe$/, '');
      let name = cmdName(ws[0]);
      if (name === 'cmd' && /^\/[ck]$/i.test(ws[1] || '')) { ws = ws.slice(2); name = cmdName(ws[0]); }
      if (['cd', 'pushd', 'chdir', 'set-location', 'sl'].includes(name) && stages.length === 1) {
        const d = ws.slice(1).find((w) => !w.startsWith('-'));
        if (d) base = toAbs(base, d);
        continue;
      }
      const sc = scanner(name, ws, ps);
      if (!sc) continue;
      const hit = walks(ctx, base, sc, stages.join(' | '), prompt);
      if (!hit) continue;
      // grep -r and find also read .git; the corrected command leaves it out too when the scan starts above it.
      const text = stages.join(' | ');
      const withGit = sc.dotDirs && !mentions(text, '.git') && sc.targets.some((t) => isDir(path.join(toAbs(base, wildBase(t)), '.git')));
      const names = withGit ? [...hit.names, '.git'] : hit.names;
      // grep -r also prints the lines of a credentials file next to the sources (.env); a corrected command that
      // still reads it would be refused again by any guard on such files, so it leaves that file out as well.
      const files = sc.envFiles ? envFilesIn(sc.targets.map((t) => toAbs(base, wildBase(t))), text) : [];
      const fix = hit.parent && sc.fix ? stages.map((s, k) => (k === si ? sc.fix(names, qq, files) : s)).join(' | ') : null;
      return { ...hit, shown: stages.join(' | '), fix };
    }
  }
  return null;
}

/* ------------------------------ Grep and Glob ------------------------------ */

function checkGrep(ctx, input, prompt) {
  const glob = String(input.glob || '');
  const shown = `Grep "${input.pattern || ''}"${input.path ? ` in ${input.path}` : ''}${glob ? ` (glob ${glob})` : ''}`;
  if (glob && !glob.startsWith('!')) {
    const h = globHit(ctx, glob);
    if (h && !named(prompt, h)) return { names: [h.folder], where: [h.rel], parent: false, shown };
  }
  const p = input.path ? String(input.path) : '.';
  const abs = toAbs(ctx.root, p);
  const h = inside(ctx, ctx.root, p);
  if (h) return isFile(abs) || named(prompt, h) ? null : { names: [h.folder], where: [h.rel], parent: false, shown };
  if (!isDir(abs)) return null;
  const found = noiseUnder(ctx, abs, (r) => searched(ctx, r));
  const names = [...new Set(found.map((r) => r.split('/').pop()))].filter((n) => !mentions(prompt, n) && !mentions(glob, n));
  if (!names.length) return null;
  return {
    names, where: found.filter((r) => names.includes(r.split('/').pop())).slice(0, 3), parent: true, shown,
    hint: 'The same Grep with `path` set to a source folder leaves it out; so does listing the folder in .gitignore, which Grep follows.',
  };
}

function checkGlob(ctx, input, prompt) {
  const pattern = String(input.pattern || '');
  if (!WILD.test(pattern)) return null; // one file by its name
  const shown = `Glob ${pattern}${input.path ? ` in ${input.path}` : ''}`;
  const h = (input.path && inside(ctx, ctx.root, String(input.path))) || globHit(ctx, pattern);
  if (!h || named(prompt, h)) return null;
  return { names: [h.folder], where: [h.rel], parent: false, shown };
}

/* ------------------------------ entry ------------------------------ */

function check({ tool, input, root, cfg, prompt }) {
  const ctx = context(root, cfg);
  const i = input || {};
  if (tool === 'Grep') return checkGrep(ctx, i, prompt);
  if (tool === 'Glob') return checkGlob(ctx, i, prompt);
  if (tool === 'Bash' || tool === 'PowerShell') return checkShell(ctx, String(i.command || ''), tool === 'PowerShell', prompt);
  return null;
}

/** The note for the model, written as facts. */
function message(hit) {
  const shown = hit.shown.length > 160 ? `${hit.shown.slice(0, 157)}...` : hit.shown;
  const where = hit.where.map((w) => `\`${w}\``).join(', ');
  const what = hit.parent ? `walks into ${where}` : `searches inside ${where}`;
  const fix = hit.fix ? ` The same command without it: \`${hit.fix}\`.`
    : hit.hint ? ` ${hit.hint}`
      : hit.parent ? ' A path that points at the source folders leaves it out.' : '';
  return `trim-token: \`${shown}\` ${what}, a dependency or build folder whose files the project did not write.${fix} ` +
    'Reading one file there passes, and so does any search once the request names the folder or the package.';
}

module.exports = { mode, check, message, savePrompt, lastPrompt, pipelines, words, ALWAYS };
