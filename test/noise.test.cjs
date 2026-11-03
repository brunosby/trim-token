'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, tmpRoot } = require('./helpers.cjs');
const G = require('../lib/noise.cjs');
const CFG = require('../lib/config.cjs');

/** A project with node_modules/react, src/, and whatever `extra` adds. */
function project(extra = {}) {
  const root = tmpRoot('enx-noise-');
  for (const d of ['node_modules/react', 'node_modules/@scope/pkg', 'src', 'bin', 'dist']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/react/index.js'), 'x');
  fs.writeFileSync(path.join(root, 'src/app.js'), 'x');
  for (const [f, text] of Object.entries(extra)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

const cfg = (layer) => {
  const root = tmpRoot('enx-cfg-');
  if (layer) fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify(layer));
  return CFG.load(root, tmpRoot('enx-home-'));
};

function check(root, tool, input, prompt = '', c = cfg()) {
  return G.check({ tool, input, root, cfg: c, prompt: prompt.toLowerCase() });
}
const bash = (root, command, prompt) => check(root, 'Bash', { command }, prompt);
const ps = (root, command, prompt) => check(root, 'PowerShell', { command }, prompt);

test('shell scans of the project that walk into node_modules are denied, with the command that leaves it out', () => {
  const root = project();
  const cases = [
    ['find . -name "*.js"', /find \. -name node_modules -prune -o -name '\*\.js' -print/],
    ['grep -rn useState .', /grep --exclude-dir=node_modules -rn useState \./],
    ['grep -R foo', /grep --exclude-dir=node_modules -R foo/],
    ['ls -R', /ls --ignore=node_modules -R/],
    ['tree', /tree -I node_modules/],
    ['rg --no-ignore foo', /rg -g '!node_modules' --no-ignore foo/],
    ['rg -uu foo src .', /rg -g '!node_modules' -uu foo src \./],
  ];
  for (const [cmd, fix] of cases) {
    const hit = bash(root, cmd);
    assert.ok(hit, cmd);
    assert.deepStrictEqual(hit.names, ['node_modules'], cmd);
    assert.match(hit.fix, fix, cmd);
    assert.match(G.message(hit), /walks into `node_modules`/);
  }
});

test('a pipeline keeps its other stages in the corrected command', () => {
  const hit = bash(project(), 'find . -type f | head -50');
  assert.strictEqual(hit.fix, 'find . -name node_modules -prune -o -type f -print | head -50');
});

test('commands that already leave the folder out, or do not recurse, pass', () => {
  const root = project();
  for (const cmd of [
    'grep -rn foo --exclude-dir=node_modules .',
    'find . -path ./node_modules -prune -o -name "*.js" -print',
    'find . -type f | grep -v node_modules',
    "rg -g '!node_modules' --no-ignore foo",
    'grep -n foo src/app.js',
    'ls node_modules',
    'cat node_modules/react/index.js',
    'grep -rn foo src',
    'find src -name "*.js"',
    'tree -I node_modules',
    'git grep foo',
  ]) assert.strictEqual(bash(root, cmd), null, cmd);
});

test('rg follows .gitignore in a git repository: plain rg passes there, and is denied without one', () => {
  const ignored = project({ '.gitignore': 'node_modules/\n', '.git/HEAD': 'ref' });
  assert.strictEqual(bash(ignored, 'rg foo'), null);
  assert.ok(bash(ignored, 'rg --no-ignore foo'));
  assert.ok(bash(project(), 'rg foo'));
});

test('naming the folder as the target is denied; one file inside it passes', () => {
  const root = project();
  const hit = bash(root, 'grep -rn createElement node_modules/react');
  assert.deepStrictEqual(hit.where, ['node_modules']);
  assert.strictEqual(hit.fix, null);
  assert.match(G.message(hit), /searches inside `node_modules`/);
  assert.strictEqual(bash(root, 'grep -rn createElement node_modules/react/index.js'), null);
  assert.ok(bash(root, 'find node_modules -name package.json'));
});

test('a prompt that names the folder or the package lets the call through', () => {
  const root = project();
  assert.strictEqual(bash(root, 'grep -rn createElement node_modules/react', 'Why does React call createElement twice?'), null);
  assert.strictEqual(bash(root, 'find node_modules/@scope/pkg -name "*.js"', 'look at @scope/pkg'), null);
  assert.strictEqual(bash(root, 'find . -name "*.js"', 'search node_modules for the polyfill'), null);
  assert.ok(bash(root, 'grep -rn createElement node_modules/react', 'why does the build fail?'));
  // A word that only contains the name is not the name.
  assert.ok(bash(root, 'grep -rn x node_modules/react', 'reactive state'));
});

test('generic names (bin, dist, build) count only where .gitignore lists them', () => {
  const plain = project();
  fs.rmSync(path.join(plain, 'node_modules'), { recursive: true });
  assert.strictEqual(bash(plain, 'grep -rn foo .'), null);
  const listed = project({ '.gitignore': '/dist\n' });
  fs.rmSync(path.join(listed, 'node_modules'), { recursive: true });
  const hit = bash(listed, 'grep -rn foo .');
  assert.deepStrictEqual(hit.names, ['dist']);
});

test('nested node_modules (a monorepo) are found, and every noise name goes into one fix', () => {
  const root = project({ 'packages/a/node_modules/x/i.js': 'x', '.gitignore': 'dist\n' });
  const hit = bash(root, 'grep -r foo .');
  assert.deepStrictEqual(hit.names.sort(), ['dist', 'node_modules']);
  assert.match(hit.fix, /--exclude-dir=node_modules/);
  assert.match(hit.fix, /--exclude-dir=dist/);
});

test('cd earlier in the command moves where the scan starts', () => {
  const root = project();
  assert.strictEqual(bash(root, 'cd src && grep -rn foo .'), null);
  assert.ok(bash(root, 'cd src; cd .. ; grep -rn foo .'));
});

test('Windows and PowerShell forms', () => {
  const root = project();
  const gci = ps(root, 'Get-ChildItem -Recurse -Filter *.js');
  assert.match(gci.fix, /Get-ChildItem -Recurse -Filter '\*\.js' \| Where-Object FullName -notmatch '\[\\\\\/\]\(node_modules\)/);
  assert.ok(ps(root, 'gci . -r'));
  assert.ok(ps(root, 'ls -Recurse | Select-String foo'));
  assert.strictEqual(ps(root, 'Get-ChildItem -Recurse src'), null);
  assert.strictEqual(ps(root, "Get-ChildItem -Recurse | Where-Object FullName -notmatch 'node_modules'"), null);
  assert.strictEqual(ps(root, 'Get-ChildItem node_modules'), null);
  const dir = bash(root, 'cmd /c dir /s /b');
  assert.match(dir.fix, /dir \/s \/b \| findstr \/v \/i "\\\\node_modules\\\\"/);
  assert.ok(bash(root, 'grep -rn foo .\\node_modules\\react'));
  const drive = root.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
  if (process.platform === 'win32') assert.ok(bash(root, `grep -rn foo ${drive}`));
});

test('Grep: a path or glob inside the folder is denied; one file and the project root behind .gitignore pass', () => {
  const root = project({ '.gitignore': 'node_modules\n', '.git/HEAD': 'ref' });
  assert.ok(check(root, 'Grep', { pattern: 'x', path: 'node_modules/react' }));
  assert.ok(check(root, 'Grep', { pattern: 'x', glob: 'node_modules/**/*.js' }));
  assert.strictEqual(check(root, 'Grep', { pattern: 'x', path: 'node_modules/react/index.js' }), null);
  assert.strictEqual(check(root, 'Grep', { pattern: 'x' }), null);
  assert.strictEqual(check(root, 'Grep', { pattern: 'x', glob: '*.js' }), null);
  assert.strictEqual(check(root, 'Grep', { pattern: 'x', path: 'node_modules/react' }, 'check react'), null);
});

test('Grep over a project whose .gitignore does not list node_modules is denied, with the way around it', () => {
  const root = project({ '.git/HEAD': 'ref' });
  const hit = check(root, 'Grep', { pattern: 'x' });
  assert.ok(hit.parent);
  assert.match(G.message(hit), /`path` set to a source folder/);
  assert.strictEqual(check(root, 'Grep', { pattern: 'x', path: 'src' }), null);
});

test('Glob: a pattern inside the folder is denied; one file by name passes', () => {
  const root = project();
  assert.ok(check(root, 'Glob', { pattern: 'node_modules/**/*.d.ts' }));
  assert.ok(check(root, 'Glob', { pattern: '**/*.js', path: 'node_modules' }));
  assert.ok(check(root, 'Glob', { pattern: '**/node_modules/**/package.json' }));
  assert.strictEqual(check(root, 'Glob', { pattern: 'node_modules/react/package.json' }), null);
  assert.strictEqual(check(root, 'Glob', { pattern: 'src/**/*.js' }), null);
  assert.strictEqual(check(root, 'Glob', { pattern: 'node_modules/react/**' }, 'what does react export?'), null);
});

test('Read is never checked', () => {
  assert.strictEqual(check(project(), 'Read', { file_path: 'node_modules/react/index.js' }), null);
});

test('a name added to "noise" counts everywhere', () => {
  const root = project();
  fs.mkdirSync(path.join(root, 'generated'));
  const hit = check(root, 'Bash', { command: 'grep -rn foo src generated' }, '', cfg({ noise: ['generated'] }));
  assert.deepStrictEqual(hit.where, ['generated']);
});

test('mode: block by default, "warn", false and "off" in the off list', () => {
  assert.strictEqual(G.mode(cfg()), 'block');
  assert.strictEqual(G.mode(cfg({ noiseGuard: 'warn' })), 'warn');
  assert.strictEqual(G.mode(cfg({ noiseGuard: false })), 'off');
  assert.strictEqual(G.mode(cfg({ off: ['noiseGuard'] })), 'off');
  assert.strictEqual(G.mode(cfg({ noiseGuard: 'nonsense' })), 'block');
});

test('hook: deny in block mode, additionalContext in warn mode, silence when off', () => {
  const root = project();
  const p = { cwd: root, session_id: 'ng', tool_name: 'Bash', tool_input: { command: 'grep -rn foo .' } };
  const deny = runHook('pre', p).out.hookSpecificOutput;
  assert.strictEqual(deny.permissionDecision, 'deny');
  assert.match(deny.permissionDecisionReason, /--exclude-dir=node_modules/);
  assert.doesNotMatch(deny.permissionDecisionReason, /\b(must|never|do not|don't)\b/i);

  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ noiseGuard: 'warn' }));
  const warn = runHook('pre', p).out.hookSpecificOutput;
  assert.strictEqual(warn.permissionDecision, undefined);
  assert.match(warn.additionalContext, /walks into `node_modules`/);

  fs.writeFileSync(path.join(root, '.trimtoken.json'), JSON.stringify({ noiseGuard: false }));
  assert.strictEqual(runHook('pre', p).raw, '');
  assert.strictEqual(runHook('pre', p, { TRIMTOKEN: 'off' }).raw, '');
});

test('hook: the prompt is kept for the session and lets a named package through', () => {
  const root = project();
  const p = { cwd: root, session_id: 'np', tool_name: 'Grep', tool_input: { pattern: 'x', path: 'node_modules/react' } };
  assert.strictEqual(runHook('pre', p).out.hookSpecificOutput.permissionDecision, 'deny');
  runHook('prompt', { cwd: root, session_id: 'np', prompt: 'Why is React rendering twice?' });
  assert.strictEqual(runHook('pre', p).raw, '');
  runHook('prompt', { cwd: root, session_id: 'np', prompt: 'now fix the bug' });
  assert.strictEqual(runHook('pre', p).out.hookSpecificOutput.permissionDecision, 'deny');
  // Another session does not see this one's prompt.
  runHook('prompt', { cwd: root, session_id: 'np', prompt: 'react' });
  assert.strictEqual(runHook('pre', { ...p, session_id: 'other' }).out.hookSpecificOutput.permissionDecision, 'deny');
});

test('hook: an error inside the check lets the call through', () => {
  const root = project();
  const r = runHook('pre', { cwd: root, session_id: 's', tool_name: 'Bash', tool_input: { command: { not: 'a string' } } });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(runHook('pre', { cwd: path.join(root, 'missing'), session_id: 's', tool_name: 'Grep', tool_input: {} }).raw, '');
});

test('in a git repository, the corrected grep -r and find also leave out .git; it never causes a denial by itself', () => {
  const root = project({ '.git/HEAD': 'ref' });
  assert.match(bash(root, 'grep -rn foo .').fix, /^grep --exclude-dir=node_modules --exclude-dir=\.git -rn foo \.$/);
  assert.match(bash(root, 'find . -name "*.js"').fix, /'\(' -name node_modules -o -name \.git '\)' -prune/);
  assert.match(bash(root, 'grep -rn foo . --exclude-dir=.git').fix, /^grep --exclude-dir=node_modules -rn/);
  assert.doesNotMatch(bash(root, 'tree').fix, /\.git/);
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  assert.strictEqual(bash(root, 'grep -rn foo .'), null);
});
