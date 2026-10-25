'use strict';
/**
 * Three-layer configuration: defaults < ~/.claude/trimtoken.json < <project>/.trimtoken.json.
 * A missing or invalid value falls back to the default; never throws.
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
    outlineBytes: 51200,    // a first code read above this becomes a symbol map
    rereadMinChars: 2000,   // a re-read below this passes untouched
    scanMinFiles: 300,      // smaller directories are exempt from the scan guard
    jsonMinChars: 2000,
    watchFirst: 120000,     // context tokens for the first warning
    watchStep: 60000,
    coldMinTokens: 30000,
  }),
  noise: Object.freeze([
    'node_modules', '.venv', 'venv', 'env', '__pycache__', '.git', 'dist', 'build', 'out', 'target',
    'coverage', '.next', '.nuxt', '.turbo', '.cache', 'vendor', 'bin', 'obj', '.gradle', '.idea',
    '.pytest_cache', '.mypy_cache', '.tox', 'site-packages', '.trimtoken',
  ]),
  // On only with "on": ["outline"]. In the A/B test, an agent that asks for the whole file needs
  // all of it, and the map would only add a turn.
  off: Object.freeze(['outline']),
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
  const merged = [...new Set([...base.off, ...off])].filter((x) => !turnOn.includes(x));
  return { limits, noise: [...new Set([...base.noise, ...extraNoise])], off: merged };
}

function load(cwd, home = os.homedir()) {
  let cfg = { limits: { ...DEFAULTS.limits }, noise: [...DEFAULTS.noise], off: [...DEFAULTS.off] };
  cfg = merge(cfg, readJson(path.join(home, '.claude', 'trimtoken.json')));
  if (cwd) cfg = merge(cfg, readJson(path.join(cwd, '.trimtoken.json')));
  cfg.disabled = /^(off|0|false)$/i.test(process.env.TRIMTOKEN || '');
  return cfg;
}

/** Is component `id` enabled in this configuration? */
function on(cfg, id) {
  return !cfg.disabled && !cfg.off.includes(id);
}

module.exports = { load, on, DEFAULTS };
