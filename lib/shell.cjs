'use strict';
/**
 * Terminal-output cleanup that does not change what it says: ANSI sequences, progress-bar
 * redraws with \r, trailing spaces, identical consecutive lines (they become "line  [×N]")
 * and runs of blank lines. No distinct line is removed.
 */

const ESCAPES = [
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,   // OSC (title, hyperlink)
  /\x1b\[[0-9;?]*[ -/]*[@-~]/g,           // CSI (cor, cursor)
  /\x1b[@-Z\\-_]/g,                       // other 2-byte escapes
];
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const MIN_RUN = 3;

/** Lines as the terminal would show them. */
function screenLines(text) {
  let s = String(text).replace(/\r\n/g, '\n');
  for (const re of ESCAPES) s = s.replace(re, '');
  return s.split('\n').map((line) => {
    const cr = line.lastIndexOf('\r');
    return (cr >= 0 ? line.slice(cr + 1) : line).replace(CONTROL, '').replace(/[ \t]+$/, '');
  });
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
  return out.join('\n');
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

module.exports = { compact, clean, screenLines };
