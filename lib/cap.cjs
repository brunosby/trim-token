'use strict';
/**
 * Large-output cut: keeps the start, the end and the lines in the middle that signal an
 * error, which is where the failure in a long log usually is.
 */

const SIGNAL = /(?:^\s*not ok\b|^\s*(?:FAIL|FAILED|ERROR|FATAL|PANIC)\b|\b(?:Error|Exception)\b[:(]|Traceback \(most recent|^\s*E\s{2,}\S|\bpanic:|\bfatal:|error(?:\[\w+\])?:|\bAssertionError\b|\bfailed\b|\bfailing\b)/i;
const SIGNAL_MAX = 300;

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

  const middle = text.slice(headEnd, tailStart);
  const parts = [text.slice(0, headEnd)];
  let gap = 0;
  let signals = 0;
  let dropped = 0;
  for (const line of middle.split('\n')) {
    if (SIGNAL.test(line)) {
      const shown = line.length > SIGNAL_MAX ? `${line.slice(0, SIGNAL_MAX)}…` : line;
      if (shown.length + 1 <= budget) {
        if (gap) parts.push(`… [${gap} lines omitted]`);
        parts.push(shown);
        budget -= shown.length + 1;
        signals++;
        gap = 0;
        continue;
      }
      dropped++;
    }
    gap++;
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

module.exports = { cut, footer, SIGNAL };
