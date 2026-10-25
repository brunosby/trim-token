'use strict';
/**
 * linediff.cjs — small dependency-free line diff, used by re-reads (reread).
 *
 * Trims the common prefix and suffix and runs LCS only on the middle. Agent edits usually touch
 * a few contiguous lines, so the middle is small; when it is not (a rewritten file), the cost
 * goes over the ceiling and the function gives up — a full re-read is the right answer then.
 */

const MAX_CELLS = 2500000;

/**
 * @param {string[]} a  linhas antigas
 * @param {string[]} b  linhas novas
 * @returns {null | Array<{op:' '|'-'|'+', line:string, newNo:number|null}>} null = miolo grande demais
 */
function diffLines(a, b) {
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre &&
         a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf += 1;

  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;

  // dp[i][j] = LCS of am[i..] and bm[j..], in a flattened matrix.
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = am[i] === bm[j] ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const ops = [];
  for (let k = 0; k < pre; k++) ops.push({ op: ' ', line: b[k], newNo: k + 1 });
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && am[i] === bm[j]) {
      ops.push({ op: ' ', line: bm[j], newNo: pre + j + 1 }); i++; j++;
    } else if (i < n && (j === m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
      ops.push({ op: '-', line: am[i], newNo: null }); i++;
    } else {
      ops.push({ op: '+', line: bm[j], newNo: pre + j + 1 }); j++;
    }
  }
  for (let k = 0; k < suf; k++) {
    const no = b.length - suf + k;
    ops.push({ op: ' ', line: b[no], newNo: no + 1 });
  }
  return ops;
}

/**
 * Hunks with `context` lines of context, numbered by the NEW file.
 * @returns {null | {text:string, changed:number}} null = no difference or diff too large
 */
function renderHunks(oldText, newText, { context = 2 } = {}) {
  const ops = diffLines(oldText.split('\n'), newText.split('\n'));
  if (!ops) return null;
  const changedIdx = [];
  ops.forEach((o, k) => { if (o.op !== ' ') changedIdx.push(k); });
  if (!changedIdx.length) return null;

  const keep = new Uint8Array(ops.length);
  for (const k of changedIdx) {
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) keep[d] = 1;
  }

  const width = String(newText.split('\n').length).length;
  const out = [];
  let inHunk = false;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) { inHunk = false; continue; }
    const o = ops[k];
    if (!inHunk) {
      const first = ops.slice(k).find((x) => x.newNo != null);
      out.push(`@@ near line ${first ? first.newNo : '?'} @@`);
      inHunk = true;
    }
    const no = o.newNo == null ? ' '.repeat(width) : String(o.newNo).padStart(width);
    out.push(`${o.op} ${no}| ${o.line}`);
  }
  return { text: out.join('\n'), changed: changedIdx.length };
}

module.exports = { diffLines, renderHunks, MAX_CELLS };
