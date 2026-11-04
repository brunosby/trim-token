'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'scripts', 'hook.cjs');

// Every folder the tests create lives under one base, removed when the run ends.
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'trimtoken-test-'));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* already gone */ } });

function tmpRoot(prefix = 'enx-') {
  return fs.mkdtempSync(path.join(BASE, prefix));
}

/** Runs the hook the way Claude Code runs it: JSON on stdin, response on stdout. */
function runHook(event, payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, event], { windowsHide: true,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, HOME: tmpRoot('enx-home-'), USERPROFILE: tmpRoot('enx-home-'), ...env },
    timeout: 20000,
  });
  return { status: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, raw: r.stdout, err: r.stderr };
}

function filesIn(dir, n) {
  for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), 'x');
}

module.exports = { tmpRoot, runHook, filesIn, HOOK };
