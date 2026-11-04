#!/usr/bin/env node
'use strict';
/** Background worker started by the Stop hook: `node warm.cjs <root> <session> <transcript> <gen> <model> <pings> <everyMs> <minTokens> <dailyMax>`. */

const W = require('../lib/warm.cjs');

const [root, sessionId, transcriptPath, gen, model, pings, everyMs, minTokens, dailyMax] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
W.run({ root, sessionId, transcriptPath, gen, minTokens: Number(minTokens) || 0, dailyMax: Number(dailyMax) || 0, model: model || null, pings: Number(pings) || 0, everyMs: Number(everyMs) || 270000, sleep })
  .catch(() => {})
  .finally(() => process.exit(0));
