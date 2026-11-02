'use strict';
/**
 * Large-output cut: keeps the start, the end and the lines in the middle that matter most.
 * Error lines come first; with the budget that is left, lines that point to a place
 * (path:line) or state a test verdict. Everything else in the middle is counted, not shown.
 */

const SIGNAL = /(?:^\s*not ok\b|^\s*(?:FAIL|FAILED|ERROR|FATAL|PANIC)\b|\b(?:Error|Exception)\b[:(]|Traceback \(most recent|^\s*E\s{2,}\S|\bpanic:|\bfatal:|error(?:\[\w+\])?:|\bAssertionError\b|\bfailed\b|\bfailing\b)/i;
// A file location (src/a.py:12, a.ts(3,5)) or a test verdict (ok 3, PASS x, 12 passed).
const PLACE = /(?:[\w./\\-]+\.[A-Za-z]{1,8}(?::\d+|\(\d+,\d+\))|^\s*(?:ok\s+\d+|PASS|PASSED|SKIP(?:PED)?)\b|\b\d+\s+(?:passed|failed|errors?|skipped|tests?)\b)/;
const LINE_MAX = 300;

// Text that some earlier step already cut or moved to a file. Cutting it again would only lose
// the pointer to the full version.
const ALREADY_CUT = [
  /\[trimtoken\] Output was \d+ chars/,
  /<persisted-output>/,
  /Output too large\b.*(?:saved|written) to/i,
  /\[\d+ (?:lines|chars|characters|bytes) (?:omitted|truncated)\]/i,
  /\.\.\. \[\d+ (?:more )?(?:lines|chars) (?:omitted|truncated)/i,
];

function alreadyCut(text) {
  return ALREADY_CUT.some((re) => re.test(text));
}

/**
 * @param {string} text
 * @param {number} keep  character budget for the result (approximate)
 * @returns {{text:string, omitted:number, signals:number}}
 */
function cut(text, keep) {
  if (text.length <= keep) return { text, omitted: 0, signals: 0 };
  const headLen = Math.floor(keep * 0.3);
  const tailLen = Math.floor(keep * 0.25);
  let budget = keep - headLen - tailLen;

  // Cut at a line boundary so no line is split in half.
  let headEnd = text.lastIndexOf('\n', headLen);
  if (headEnd < headLen * 0.5) headEnd = headLen;
  let tailStart = text.indexOf('\n', text.length - tailLen);
  if (tailStart < 0 || tailStart > text.length - tailLen * 0.5) tailStart = text.length - tailLen;

  const lines = text.slice(headEnd, tailStart).split('\n');
  const shown = (l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l);
  const keepIdx = new Set();
  let signals = 0;
  let dropped = 0;
  for (const tier of [SIGNAL, PLACE]) {
    for (let i = 0; i < lines.length; i++) {
      if (keepIdx.has(i) || !tier.test(lines[i])) continue;
      const cost = shown(lines[i]).length + 1;
      if (cost <= budget) {
        keepIdx.add(i);
        budget -= cost;
        if (tier === SIGNAL) signals++;
      } else if (tier === SIGNAL) {
        dropped++;
      }
    }
  }

  const parts = [text.slice(0, headEnd)];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!keepIdx.has(i)) { gap++; continue; }
    if (gap) parts.push(`… [${gap} lines omitted]`);
    parts.push(shown(lines[i]));
    gap = 0;
  }
  if (gap) parts.push(`… [${gap} lines omitted]`);
  if (dropped) parts.push(`… [${dropped} more error lines did not fit]`);
  parts.push(text.slice(tailStart).replace(/^\n/, ''));
  const out = parts.join('\n');
  return { text: out, omitted: text.length - out.length, signals };
}

/** Closing line that tells the agent where the full text is and how to use it. */
function footer(fullChars, file, kept) {
  const note = kept ? ' (error lines from the middle were kept)' : '';
  return `\n[trimtoken] Output was ${fullChars} chars; this is a cut${note}. Full text: ${file} — Grep that file instead of re-running the command.`;
}

module.exports = { cut, footer, alreadyCut, SIGNAL, PLACE };
