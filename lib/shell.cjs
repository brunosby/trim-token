'use strict';
/**
 * Terminal-output cleanup that does not change what it says: ANSI sequences, progress-bar
 * redraws with \r, trailing spaces, identical consecutive lines (they become "line  [×N]")
 * and runs of blank lines.
 *
 * Runs of log lines that differ only in a time, an id, a hash or a duration are grouped:
 * the first and the last are kept, and one line in between says how many were alike.
 * Lines that look like an error are never grouped, so an id that matters stays visible.
 */

const ESCAPES = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,   // OSC (title, hyperlink)
  /\x1b\[[0-9;?]*[ -/]*[@-~]/g,           // CSI (cor, cursor)
  /\x1b[@-Z\\-_]/g,                       // other 2-byte escapes
];
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MIN_RUN = 3;
const MIN_SIMILAR = 4;
const ERRORISH = /(?:\berror\b|\bfail|\bfatal\b|\bpanic\b|exception|traceback|\bwarn(?:ing)?\b|^\s*not ok\b|^\s*E\s{2,})/i;
// Only log lines are grouped: a time, a log level or a duration. A table of query results is
// data and passes whole.
const LOGLIKE = /(?:\b\d{1,2}:\d{2}(?::\d{2})?\b|\b(?:INFO|DEBUG|TRACE|NOTICE|VERBOSE)\b|\b\d+(?:\.\d+)?\s?(?:ms|s|µs|us|ns)\b)/;
// What varies between otherwise equal log lines.
const VARIABLE = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,  // uuid
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi,               // hash
  /\d+(?:[.,:]\d+)*/g,                                                // times, dates, ids, durations
];

/** Lines as the terminal would show them. */
function screenLines(text) {
  let s = String(text).replace(/\r\n/g, '\n');
  for (const re of ESCAPES) s = s.replace(re, '');
  return s.split('\n').map((line) => {
    const cr = line.lastIndexOf('\r');
    return (cr >= 0 ? line.slice(cr + 1) : line).replace(CONTROL, '').replace(/[ \t]+$/, '');
  });
}

/**
 * The line with what varies replaced by #, or null if nothing varies or it is not a log line.
 */
function template(line) {
  let t = line;
  for (const re of VARIABLE) t = t.replace(re, '#');
  return t === line || !/[A-Za-z]{3,}/.test(t) || !LOGLIKE.test(line) ? null : t;
}

// A table row: cells between pipes, or columns that line up under a header with no numbers in it.
const PIPE_ROW = /^\s*\|.*\|\s*$|\|.*\|.*\|/;
const RULE_ROW = /^\s*[|+]?\s*:?-{3,}:?\s*(?:[|+]\s*:?-{3,}:?\s*)*[|+]?\s*$|^\s*(?:={3,}\s*)+$|^\s*(?:-{3,}\s+){1,}-{3,}\s*$/;

/** Where each column after the first starts (a non-space after two or more spaces). */
function columnStarts(line) {
  const out = [];
  for (const m of String(line).matchAll(/ {2,}(?=\S)/g)) out.push(m.index + m[0].length);
  return out;
}

/** True when `row` sits under `header` as a table row: the header has no digits and at least two of its columns line up with the row's. */
function underHeader(header, row) {
  if (!header || /\d/.test(header) || !/[A-Za-z]/.test(header)) return false;
  const h = columnStarts(header);
  if (h.length < 2) return false;
  const r = new Set(columnStarts(row));
  return h.filter((x) => r.has(x)).length >= 2;
}

/** For each line, whether it belongs to a table (and so is data, never grouped). */
function tableLines(lines) {
  const inTable = lines.map((l) => PIPE_ROW.test(l) || RULE_ROW.test(l));
  for (let i = 1; i < lines.length; i++) {
    // The header is the line just above the first row, or above a ruler line under it.
    const header = RULE_ROW.test(lines[i - 1]) && i >= 2 ? lines[i - 2] : lines[i - 1];
    if (!lines[i] || !(underHeader(header, lines[i]) || (inTable[i - 1] && !RULE_ROW.test(lines[i - 1]) && underHeader(lines[i - 1], lines[i])))) continue;
    // Every row below that lines up with the same header is part of the table.
    let j = i;
    while (j < lines.length && lines[j] && underHeader(header, lines[j])) inTable[j++] = true;
    i = j - 1;
  }
  return inTable;
}

function groupSimilar(lines) {
  const out = [];
  const table = tableLines(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line && !ERRORISH.test(line) && !table[i] ? template(line) : null;
    let j = i + 1;
    if (t) while (j < lines.length && lines[j] && !ERRORISH.test(lines[j]) && !table[j] && template(lines[j]) === t) j++;
    if (t && j - i >= MIN_SIMILAR) {
      out.push(line, `  [×${j - i - 2} more like: ${t}]`, lines[j - 1]);
      i = j - 1;
    } else {
      out.push(line);
    }
  }
  return out;
}

function clean(text) {
  const lines = screenLines(text);
  const out = [];
  let blanks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') {
      if (++blanks === 1) out.push('');
      continue;
    }
    blanks = 0;
    let j = i + 1;
    while (j < lines.length && lines[j] === line) j++;
    if (j - i >= MIN_RUN) {
      out.push(`${line}  [×${j - i}]`);
      i = j - 1;
    } else {
      out.push(line);
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return groupSimilar(out).join('\n');
}

/**
 * @returns {string|null} cleaned text, or null when swapping is not worth it
 * (too short, or savings below minRatio).
 */
function compact(text, { minChars = 1500, minRatio = 0.12 } = {}) {
  if (typeof text !== 'string' || text.length < minChars) return null;
  const out = clean(text);
  return text.length - out.length >= text.length * minRatio ? out : null;
}

// The marker groupSimilar writes; its presence means lines were left out.
const GROUP_LINE = /\[×\d+ more like: /;

module.exports = { compact, clean, screenLines, template, tableLines, GROUP_LINE };
