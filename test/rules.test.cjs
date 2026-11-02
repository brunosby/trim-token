'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, tmpRoot } = require('./helpers.cjs');
const CFG = require('../lib/config.cjs');
const { cut, alreadyCut } = require('../lib/cap.cjs');
const SH = require('../lib/shell.cjs');

test('config: every component is on by default; off and on lists are honored', () => {
  const root = tmpRoot();
  assert.strictEqual(CFG.mode(CFG.load(root, tmpRoot()), 'shell'), 'on');
  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ off: ['warm'], shadow: ['shell'] }));
  const cfg = CFG.load(root, tmpRoot());
  assert.strictEqual(CFG.mode(cfg, 'warm'), 'off');
  assert.strictEqual(CFG.mode(cfg, 'shell'), 'on'); // there is no shadow mode any more; the key is ignored
  assert.strictEqual(cfg.shadow, undefined);
  const home = tmpRoot();
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'trimtoken.json'), JSON.stringify({ off: ['shell'] }));
  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ on: ['shell'] }));
  assert.strictEqual(CFG.mode(CFG.load(root, home), 'shell'), 'on');
});

test('cut keeps error lines first, then path:line and test verdicts from the middle', () => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(`noise line ${i} with filler text to make it long enough`);
  lines[1500] = 'Error: connection refused';
  lines[1600] = '    at Object.<anonymous> (src/server/db.js:42:7)';
  lines[1700] = 'Tests: 3 failed, 120 passed';
  const c = cut(lines.join('\n'), 8000);
  assert.match(c.text, /Error: connection refused/);
  assert.match(c.text, /src\/server\/db\.js:42/);
  assert.match(c.text, /3 failed, 120 passed/);
  assert.ok(c.text.length < 9000);
});

test('cut is idempotent: text that already went through a cut or a file move is not cut again', () => {
  const big = 'x'.repeat(40000);
  const once = cut(big.split('').join(''), 8000).text + '\n[trimtoken] Output was 40000 chars; this is a cut. Full text: /tmp/f.txt';
  assert.ok(alreadyCut(once));
  assert.ok(alreadyCut('<persisted-output>\nOutput too large (50KB). Full output saved to: /x\n</persisted-output>'));
  assert.ok(!alreadyCut('plain output'));
  const root = tmpRoot();
  const stdout = `${'y'.repeat(20000)}\n… [500 lines omitted]\n${'z'.repeat(20000)}`;
  const r = runHook('post', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: 'cat big.log' }, tool_response: { stdout, stderr: '' } });
  assert.strictEqual(r.raw, '');
});

test('shell: log lines that differ only in time, id or duration are grouped; errors and data rows are not', () => {
  const log = [];
  for (let i = 0; i < 30; i++) log.push(`2026-10-27 10:00:${String(i).padStart(2, '0')} INFO GET /api/items/${100 + i} 200 ${i + 3}ms`);
  log.push('2026-10-27 10:00:31 ERROR GET /api/items/7 500 12ms');
  log.push('2026-10-27 10:00:32 ERROR GET /api/items/8 500 13ms');
  log.push('2026-10-27 10:00:33 ERROR GET /api/items/9 500 14ms');
  log.push('2026-10-27 10:00:34 ERROR GET /api/items/10 500 15ms');
  const out = SH.clean(log.join('\n')).split('\n');
  assert.strictEqual(out[0], log[0]);
  assert.match(out[1], /\[×28 more like: .*INFO GET \/api\/items\/# # #ms\]/);
  assert.strictEqual(out[2], log[29]);
  assert.strictEqual(out.filter((l) => /ERROR/.test(l)).length, 4);
  const rows = Array.from({ length: 10 }, (_, i) => ` ${i} | active | 2026-01-0${i}`);
  assert.deepStrictEqual(SH.clean(rows.join('\n')).split('\n'), rows);
});

test('after /compact the session start lists the full outputs saved in this session', () => {
  const root = tmpRoot();
  const big = Array.from({ length: 4000 }, (_, i) => `row ${i} some content here`).join('\n');
  runHook('post', { cwd: root, session_id: 'sx', tool_name: 'Bash', tool_input: { command: 'cat huge.csv' }, tool_response: { stdout: big, stderr: '' } });
  const fresh = runHook('session-start', { cwd: root, session_id: 'sx', source: 'startup' });
  assert.doesNotMatch(fresh.out.hookSpecificOutput.additionalContext, /Full outputs saved/);
  const after = runHook('session-start', { cwd: root, session_id: 'sx', source: 'compact' });
  const ctx = after.out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /Full outputs saved earlier in this session/);
  assert.match(ctx, /from: cat huge\.csv/);
  const other = runHook('session-start', { cwd: root, session_id: 'other', source: 'compact' });
  assert.doesNotMatch(other.out.hookSpecificOutput.additionalContext, /Full outputs saved/);
});

test('/trim-token:savings is answered by the hook (no model turn), with cache use from the transcript', () => {
  const root = tmpRoot();
  const home = tmpRoot('enx-home-');
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const u = (id, r, w) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: r, cache_creation_input_tokens: w } } });
  fs.writeFileSync(path.join(proj, 'sess9.jsonl'), [u('a', 1000, 200), u('a', 1000, 200), u('b', 3000, 100)].join('\n'));
  const r = runHook('expand', { cwd: root, session_id: 'sess9', command_name: 'trim-token:savings' }, { HOME: home, USERPROFILE: home });
  assert.strictEqual(r.out.decision, 'block');
  assert.match(r.out.reason, /cache read\s+4,000/);
  assert.match(r.out.reason, /cache write\s+300/);
  assert.match(r.out.reason, /model calls\s+2/);
  assert.strictEqual(runHook('expand', { cwd: root, session_id: 's', command_name: 'other:thing' }).raw, '');
  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ off: ['direct'] }));
  assert.strictEqual(runHook('expand', { cwd: root, session_id: 's', command_name: 'trim-token:savings' }).raw, '');
});

test('cold cache with a large context suggests a handoff and /clear', () => {
  const root = tmpRoot();
  const t = path.join(root, 't.jsonl');
  const old = new Date(Date.now() - 2 * 3600000).toISOString();
  fs.writeFileSync(t, `${JSON.stringify({ type: 'assistant', timestamp: old, message: { usage: { input_tokens: 10, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 5 } } } })}\n`);
  const r = runHook('prompt', { cwd: root, session_id: 's', transcript_path: t });
  assert.match(r.out.systemMessage, /handoff brief/);
});

test('audit: hooks of two sources on the same tool are reported', () => {
  const A = require('../scripts/audit.cjs');
  assert.ok(A.overlaps(['Bash', 'Glob'], ['Read', 'Bash']));
  assert.ok(A.overlaps(['mcp__.*'], ['mcp__github__x']));
  assert.ok(!A.overlaps(['Read'], ['Bash']));
  const home = tmpRoot('enx-home-');
  const mk = (name, hooks) => {
    const dir = path.join(home, 'plugins', name);
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify({ hooks }));
    return dir;
  };
  const a = mk('alpha', { PostToolUse: [{ matcher: 'Bash|Read', hooks: [] }] });
  const b = mk('beta', { PostToolUse: [{ matcher: 'Bash', hooks: [] }], SessionStart: [{ hooks: [] }] });
  const c = A.hookConflicts(home, tmpRoot(), [{ name: 'alpha', dir: a }, { name: 'beta', dir: b }]);
  assert.deepStrictEqual(c, ['PostToolUse: alpha (Bash|Read) and beta (Bash)']);
});

test('contract: injected texts fit Claude Code limits and every hook names a known event and handler', () => {
  const T = require('../lib/texts.cjs');
  for (const t of [T.CONTRACT, T.SUBAGENT]) assert.ok(t.length < 10000);
  const { HANDLERS } = require('../scripts/hook.cjs');
  const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
  const known = ['SessionStart', 'UserPromptSubmit', 'UserPromptExpansion', 'PostToolUse', 'SubagentStart', 'Stop', 'SessionEnd'];
  for (const [event, groups] of Object.entries(hooks)) {
    assert.ok(known.includes(event), event);
    for (const g of groups) for (const h of g.hooks) assert.ok(HANDLERS[h.command.split(' ').pop()], h.command);
  }
});

// Names of other plugins, kept as hashes so that this test does not name them either.
const OTHER_NAMES = new Set(['2703d31ad261', 'faf848892c89', 'aab04e0cf959', 'f74d2639df5a', 'c1a30243f15b', '60585c53f3e6', '51a4d27606d8', '1647b54d3c91', '007389a60631', 'c7b4c3dd9b99', '9d999baf12a8', '02e3041a0173', 'ed0d96b0c49e', '23675ff78c2f']);
const sha12 = (s) => require('crypto').createHash('sha1').update(s).digest('hex').slice(0, 12);
function namesOtherPlugin(text) {
  const words = String(text).toLowerCase().match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g) || [];
  return words.some((w, i) => OTHER_NAMES.has(sha12(w)) || (words[i + 1] && (OTHER_NAMES.has(sha12(`${w}-${words[i + 1]}`)) || OTHER_NAMES.has(sha12(w + words[i + 1])))));
}

test('no other plugin is named anywhere in this plugin', () => {
  const ROOT = path.join(__dirname, '..');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (['.git', 'node_modules'].includes(e.name) ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(ROOT)) assert.ok(!namesOtherPlugin(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f));
});

test('package: no bin/ folder (it would go on the Bash PATH and block install in claude.ai); every reference points to scripts/', () => {
  const ROOT = path.join(__dirname, '..');
  assert.ok(!fs.existsSync(path.join(ROOT, 'bin')));
  const refs = [fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'),
    ...fs.readdirSync(path.join(ROOT, 'commands')).map((f) => fs.readFileSync(path.join(ROOT, 'commands', f), 'utf8'))].join('\n');
  const paths = [...refs.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w/.-]+)/g)].map((m) => m[1]);
  assert.ok(paths.length >= 9, String(paths.length));
  for (const p of paths) {
    assert.match(p, /^scripts\//, p);
    assert.ok(fs.existsSync(path.join(ROOT, p)), p);
  }
});
