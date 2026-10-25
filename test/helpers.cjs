'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'hook.cjs');

function tmpRoot(prefix = 'enx-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Runs the hook the way Claude Code runs it: JSON on stdin, response on stdout. */
function runHook(event, payload, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, event], {
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
