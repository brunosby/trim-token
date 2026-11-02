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

function groupSimilar(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line && !ERRORISH.test(line) ? template(line) : null;
    let j = i + 1;
    if (t) while (j < lines.length && lines[j] && !ERRORISH.test(lines[j]) && template(lines[j]) === t) j++;
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

module.exports = { compact, clean, screenLines, template, GROUP_LINE };
