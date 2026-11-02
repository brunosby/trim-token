'use strict';
/**
 * Keeps the prompt cache warm while the user is away.
 *
 * With the 5-minute cache, a prompt sent after a longer pause rewrites the whole context at
 * 1.25x the input price instead of reading it at 0.05x. A one-word turn on a fork of the
 * session (same prefix, never saved) refreshes the cache for a fraction of that. Measured on
 * Sonnet 5.5, interactive sessions, 12-minute pause: two pings plus the next prompt cost 37%
 * less than the next prompt alone at a 41k-token context and 69% less at 63k. Pings nobody
 * comes back for are wasted, so they stop after ~18 minutes and only run for large contexts.
 *
 * Stop schedules a worker; the next prompt, the end of the session or a newer Stop cancel it.
 * Nothing runs with the 1-hour cache (it outlives a normal pause) or with a small context
 * (rewriting it is cheap).
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const S = require('./state.cjs');

function fileOf(root, sessionId) {
  return path.join(S.windowDir(root, sessionId, null), 'warm.json');
}

/** Model of the last main-conversation response, so the ping hits the same cache. */
function lastModel(transcriptPath) {
  try {
    const size = fs.statSync(transcriptPath).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].indexOf('"model"') < 0) continue;
      try {
        const o = JSON.parse(lines[i]);
        if (o.type === 'assistant' && !o.isSidechain && o.message && o.message.model && !/synthetic/.test(o.message.model)) return o.message.model;
      } catch { /* partial line */ }
    }
  } catch { /* no transcript */ }
  return null;
}

/**
 * The Claude Code executable that is running this session, so a ping works without `claude` on
 * the PATH (the desktop app ships its own copy). Order: TRIMTOKEN_CLAUDE, the path Claude Code
 * exports, the executable of the process in CLAUDE_PID. Null means: try `claude` on the PATH.
 */
function claudeCommand(env = process.env, platform = process.platform) {
  const usable = (p) => { try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; } };
  if (usable(env.TRIMTOKEN_CLAUDE)) return env.TRIMTOKEN_CLAUDE;
  if (usable(env.CLAUDE_CODE_EXECPATH)) return env.CLAUDE_CODE_EXECPATH;
  const pid = Number(env.CLAUDE_PID);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  let exe = null;
  try {
    if (platform === 'linux') exe = fs.readlinkSync(`/proc/${pid}/exe`);
    else if (platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ExecutablePath`], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      exe = String(r.stdout || '').trim();
    } else {
      const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
      exe = String(r.stdout || '').trim();
    }
  } catch { return null; }
  // A Claude Code run by Node (npm install) would need its script as well: leave that to the PATH.
  if (!exe || !path.isAbsolute(exe) || /^node(\.exe)?$/i.test(path.basename(exe)) || !usable(exe)) return null;
  return exe;
}

/** Stop: start a worker for this session, replacing any earlier one. Returns the plan or null. */
function schedule({ root, sessionId, transcriptPath, cfg, lastUsage }) {
  if (process.env.TRIMTOKEN_PING || !sessionId || !transcriptPath) return null;
  const u = lastUsage(transcriptPath);
  // Claude Code writes the turn's last response after Stop, so the size is checked again by the worker.
  if (!u || u.ttlMs !== 300000) return null;
  const model = lastModel(transcriptPath);
  const gen = `${Date.now()}-${process.pid}`;
  S.writeJson(fileOf(root, sessionId), { gen, at: Date.now(), tokens: u.tokens, cmd: claudeCommand() });
  const worker = path.join(__dirname, '..', 'scripts', 'warm.cjs');
  const args = [worker, root, sessionId, transcriptPath, gen, model || '', String(cfg.limits.warmPings), String(cfg.limits.warmEveryMs), String(cfg.limits.warmMinTokens)];
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, cwd: root });
  child.unref();
  return { gen, model, tokens: u.tokens };
}

/** Next prompt or end of session: the worker stops at its next check. */
function cancel(root, sessionId) {
  try { fs.rmSync(fileOf(root, sessionId), { force: true }); } catch { /* nothing scheduled */ }
}

function current(root, sessionId) {
  return S.readJson(fileOf(root, sessionId), null);
}

/** Time of the last ping of this session, so the cold-cache warning does not fire after one. */
function lastPingAt(root, sessionId) {
  const st = current(root, sessionId);
  return st && st.pingAt ? st.pingAt : 0;
}

function cleanEnv() {
  const env = { ...process.env, TRIMTOKEN_PING: '1' };
  // A child inherits the parent's session id and would write into that session.
  for (const k of Object.keys(env)) if (/^CLAUDE_CODE_(SESSION|ENTRYPOINT)|^CLAUDECODE$/.test(k)) delete env[k];
  return env;
}

/** One ping: a fork of the session that is never saved, with hooks off. Returns the result JSON or null. */
function ping({ root, sessionId, model, cmd }) {
  const settings = path.join(S.baseDir(root), 'warm-settings.json');
  if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ disableAllHooks: true }));
  const win = process.platform === 'win32';
  // Through a shell only when relying on the PATH (Windows finds claude.exe or claude.cmd there).
  const viaShell = win && !cmd;
  const q = (s) => (viaShell ? `"${s}"` : s);
  const args = ['-p', 'ok', '--resume', sessionId, '--fork-session', '--no-session-persistence', '--max-turns', '1',
    '--output-format', 'json', '--settings', q(settings)];
  if (model) args.push('--model', model);
  try { args.push(...JSON.parse(process.env.TRIMTOKEN_PING_ARGS || '[]').map(String)); } catch { /* ignore a bad value */ }
  const r = spawnSync(cmd || 'claude', args, { cwd: root, env: cleanEnv(), encoding: 'utf8', timeout: 120000, windowsHide: true, shell: viaShell });
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** Worker loop. `sleep` and `doPing` are parameters so the tests run it without waiting or calling the CLI. */
async function run({ root, sessionId, transcriptPath, gen, model, pings, everyMs, minTokens = 0, sleep, doPing = ping, usage = null }) {
  const sizeOf = usage || ((t) => require('./watch.cjs').lastUsage(t));
  let done = 0;
  for (let i = 0; i < pings; i++) {
    await sleep(everyMs);
    const st = current(root, sessionId);
    if (!st || st.gen !== gen) break;  // the user came back, the session ended or a newer turn took over
    const u = transcriptPath ? sizeOf(transcriptPath) : null;
    if (minTokens && (!u || u.tokens < minTokens)) break;  // a small context is cheap to rewrite
    const res = doPing({ root, sessionId, model, cmd: st.cmd || null });
    done++;
    try { S.writeJson(fileOf(root, sessionId), { ...st, pingAt: Date.now(), pings: done }); } catch { /* next check stops */ }
    const usage = (res && res.usage) || {};
    try {
      fs.appendFileSync(path.join(S.baseDir(root), 'warm.jsonl'), `${JSON.stringify({
        t: Date.now(), s: sessionId, ok: Boolean(res && !res.is_error), model,
        output: usage.output_tokens || 0, read: usage.cache_read_input_tokens || 0, write: usage.cache_creation_input_tokens || 0,
      })}\n`);
    } catch { /* the record only feeds the savings report */ }
    if (!res || res.is_error) break;
  }
  return done;
}

module.exports = { claudeCommand, schedule, cancel, current, lastPingAt, lastModel, run, ping };
