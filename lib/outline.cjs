'use strict';
/**
 * Dependency-free symbol map: classes, functions and methods with their line ranges.
 *
 * Python: a block ends at the last line before the next non-empty line indented less than or
 * equal to the definition. Brace languages: the end is the brace that closes the first brace
 * opened from the declaration, ignoring strings and comments.
 * Heuristic on purpose: it is for finding where to read, not for compiling.
 */

const LANG = {
  '.py': 'python', '.pyi': 'python',
  '.js': 'brace', '.jsx': 'brace', '.mjs': 'brace', '.cjs': 'brace', '.ts': 'brace', '.tsx': 'brace', '.mts': 'brace', '.cts': 'brace',
  '.java': 'brace', '.cs': 'brace', '.go': 'brace', '.kt': 'brace', '.kts': 'brace', '.scala': 'brace',
  '.c': 'brace', '.h': 'brace', '.cpp': 'brace', '.hpp': 'brace', '.cc': 'brace', '.rs': 'brace', '.swift': 'brace', '.php': 'brace',
};

function langOf(file) {
  const m = /\.[A-Za-z0-9]+$/.exec(String(file || ''));
  return m ? LANG[m[0].toLowerCase()] || null : null;
}

/* ------------------------------ Python ------------------------------ */

const PY_DEF = /^(\s*)(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/;

function indentOf(line) {
  return line.length - line.replace(/^[ \t]+/, '').length;
}

function pythonSymbols(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PY_DEF.exec(lines[i]);
    if (!m) continue;
    const ind = m[1].length;
    let start = i;
    while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) continue;
      if (indentOf(l) <= ind && !/^\s*[)\]}]/.test(l)) break;
      end = j;
    }
    out.push({ kind: m[2] === 'class' ? 'class' : 'def', name: m[3], start: start + 1, end: end + 1, line: i + 1, indent: ind, doc: pyDoc(lines, i) });
  }
  return nest(out);
}

/** First line of the docstring right below the signature, if any. */
function pyDoc(lines, i) {
  let j = i;
  while (j < lines.length && !/:\s*(#.*)?$/.test(lines[j])) j++; // multi-line signature
  const next = lines[j + 1];
  if (!next) return '';
  const m = /^\s*(?:[rRuU]|[rR][bB]|[bB][rR])?("""|''')\s*(.*?)(?:\1)?\s*$/.exec(next);
  return m ? m[2].replace(/("""|''')$/, '').trim() : '';
}

/* --------------------------- chaves (C-like) --------------------------- */

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'with', 'using', 'lock', 'foreach', 'when', 'match', 'new', 'throw', 'typeof', 'sizeof', 'function']);

const BRACE_DECL = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:(?:public|private|protected|internal|static|final|sealed|partial|open|data|inner|abstract)\s+)*(class|interface|enum|struct|record|trait|object|impl|protocol)\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=>/, 'function'],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, 'function'],                 // Go
  [/^\s*(?:(?:pub(?:\([^)]*\))?|async|unsafe|const|extern)\s+)*fn\s+([A-Za-z_]\w*)/, 'function'], // Rust
  [/^\s*(?:(?:public|private|protected|internal|override|open|suspend|inline|operator|abstract)\s+)*fun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?([A-Za-z_]\w*)/, 'function'], // Kotlin
  [/^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+([A-Za-z_]\w*)/, 'function'], // PHP
];
// Method/function with a type before the name (Java, C#, C, TS in a class): ends in "{" or opens "(" and closes ")" without ";".
const METHOD = /^\s*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|synchronized|native|readonly|sealed|extern|inline|get|set|unsafe|new)\s+)*(?:[\w<>[\],.?*&:]+\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([^;]*)$/;

function braceSymbols(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*|#)/.test(line)) continue;
    let hit = null;
    for (const [re, kind] of BRACE_DECL) {
      const m = re.exec(line);
      if (m) { hit = { kind: kind === 'type' ? m[1] : kind, name: kind === 'type' ? m[2] : m[1] }; break; }
    }
    if (!hit) {
      const m = METHOD.exec(line);
      if (m && !KEYWORDS.has(m[1]) && !/[=]\s*$/.test(line) && !/^\s*(?:return|throw|new|await|yield|else)\b/.test(line)) {
        hit = { kind: 'method', name: m[1] };
      }
    }
    if (!hit) continue;
    const end = closeBrace(lines, i);
    if (end < 0) continue; // declaration without a body (prototype, abstract)
    let start = i;
    while (start > 0 && /^\s*(@\w|\[\w|\/\/\/)/.test(lines[start - 1])) start--;
    out.push({ kind: hit.kind, name: hit.name, start: start + 1, end: end + 1, line: i + 1, indent: indentOf(line), doc: '' });
  }
  return nest(out);
}

/** Line of the brace that closes the block opened from `from`, or -1. */
function closeBrace(lines, from) {
  let depth = 0;
  let parens = 0; // braces inside parentheses (destructuring, object literal) do not open the body
  let opened = false;
  let inBlock = false;
  for (let i = from; i < lines.length && i < from + 20000; i++) {
    const s = lines[i];
    let quote = null;
    for (let k = 0; k < s.length; k++) {
      const c = s[k];
      const n = s[k + 1];
      if (inBlock) { if (c === '*' && n === '/') { inBlock = false; k++; } continue; }
      if (quote) { if (c === '\\') k++; else if (c === quote) quote = null; continue; }
      if (c === '/' && n === '/') break;
      if (c === '/' && n === '*') { inBlock = true; k++; continue; }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (!opened) {
        if (c === '(') { parens++; continue; }
        if (c === ')') { parens = Math.max(0, parens - 1); continue; }
        if (parens > 0) continue;
        if (c === ';') return -1;
      }
      if (c === '{') { depth++; opened = true; }
      else if (c === '}') { depth--; if (opened && depth === 0) return i; }
    }
    if (!opened && i - from > 6) return -1; // signature too long: not a declaration with a body
  }
  return -1;
}

/* ------------------------------ comum ------------------------------ */

/** Depth from range containment: method inside a class, etc. */
function nest(symbols) {
  const stack = [];
  for (const s of symbols) {
    while (stack.length && !(s.start >= stack[stack.length - 1].start && s.end <= stack[stack.length - 1].end)) stack.pop();
    s.depth = stack.length;
    s.parent = stack.length ? stack[stack.length - 1].name : null;
    stack.push(s);
  }
  return symbols;
}

function symbols(text, file) {
  const lang = langOf(file);
  if (!lang) return [];
  const lines = String(text).split('\n');
  return lang === 'python' ? pythonSymbols(lines) : braceSymbols(lines);
}

function signature(lines, s) {
  const raw = lines[s.line - 1].trim().replace(/\s*\{\s*$/, '');
  return raw.length > 110 ? `${raw.slice(0, 107)}…` : raw;
}

/** Map text, one line per symbol. */
function render(text, file, syms) {
  const lines = String(text).split('\n');
  const width = String(lines.length).length;
  return syms.map((s) => {
    const range = `L${String(s.start).padStart(width)}-${String(s.end).padEnd(width)}`;
    const doc = s.doc ? `  # ${s.doc.length > 70 ? `${s.doc.slice(0, 67)}…` : s.doc}` : '';
    return `${range}  ${'  '.repeat(s.depth)}${signature(lines, s)}${doc}`;
  }).join('\n');
}

/** Symbols with the given name; accepts "Class.method". */
function find(syms, name) {
  const [outer, inner] = String(name).includes('.') ? String(name).split('.', 2) : [null, String(name)];
  return syms.filter((s) => s.name === inner && (!outer || s.parent === outer));
}

module.exports = { symbols, render, find, langOf };
