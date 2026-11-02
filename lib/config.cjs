'use strict';
/**
 * Three-layer configuration: defaults < ~/.claude/trimtoken.json < <project>/.trimtoken.json.
 * A missing or invalid value falls back to the default; never throws.
 *
 * Each component is on or off ("off" lists turn one off; "on" in a later layer turns it back on).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = Object.freeze({
  limits: Object.freeze({
    shellCap: 16000,        // Bash output above this is cut
    cap: 25000,             // other tools (Grep, MCP)
    keep: 8000,             // how much survives the cut
    shellMinChars: 1500,    // below this the shell cleanup does not run
    rereadMinChars: 2000,   // a re-read below this passes untouched
    jsonMinChars: 2000,
    watchFirst: 120000,     // context tokens for the first warning
    watchStep: 60000,
    coldMinTokens: 30000,
    contextWindow: 200000,  // used to tell how full the context is
    coldHandoffPct: 30,     // cold cache above this share of the window: suggest a handoff and /clear
    topicMinTokens: 40000,  // below this, a topic change is not worth a /clear
    warmPings: 3,           // keep-warm pings after a turn ends (5-minute cache only); together they cover ~18 min away
    warmMinTokens: 50000,   // below this, a cold restart costs about as much as the pings it would take
    warmEveryMs: 270000,    // 4.5 min: inside the 5-minute cache life
  }),
  noise: Object.freeze([
    'node_modules', '.venv', 'venv', 'env', '__pycache__', '.git', 'dist', 'build', 'out', 'target',
    'coverage', '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'bin', 'obj', '.gradle', '.idea',
    '.pytest_cache', '.mypy_cache', '.tox', 'site-packages', '.trimtoken',
  ]),
  off: Object.freeze([]),
});

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function merge(base, layer) {
  if (!layer) return base;
  const limits = { ...base.limits };
  for (const k of Object.keys(DEFAULTS.limits)) {
    const v = layer.limits && positive(layer.limits[k]);
    if (v !== undefined) limits[k] = v;
  }
  const extraNoise = Array.isArray(layer.noise) ? layer.noise.filter((x) => typeof x === 'string' && x) : [];
  const off = Array.isArray(layer.off) ? layer.off.filter((x) => typeof x === 'string') : [];
  const turnOn = Array.isArray(layer.on) ? layer.on.filter((x) => typeof x === 'string') : [];
  // Within one layer, off wins over on.
  const mergedOff = [...new Set([...base.off.filter((x) => !turnOn.includes(x)), ...off])];
  return { limits, noise: [...new Set([...base.noise, ...extraNoise])], off: mergedOff };
}

function load(cwd, home = os.homedir()) {
  let cfg = { limits: { ...DEFAULTS.limits }, noise: [...DEFAULTS.noise], off: [...DEFAULTS.off] };
  cfg = merge(cfg, readJson(path.join(home, '.claude', 'trimtoken.json')));
  if (cwd) cfg = merge(cfg, readJson(path.join(cwd, '.trimtoken.json')));
  cfg.disabled = /^(off|0|false)$/i.test(process.env.TRIMTOKEN || '');
  return cfg;
}

/** 'on' or 'off' for component `id`. */
function mode(cfg, id) {
  return cfg.disabled || cfg.off.includes(id) ? 'off' : 'on';
}

/** Does component `id` act in this configuration? */
function on(cfg, id) {
  return mode(cfg, id) === 'on';
}

module.exports = { load, on, mode, DEFAULTS };
