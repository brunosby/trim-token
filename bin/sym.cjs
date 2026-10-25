#!/usr/bin/env node
'use strict';
/**
 * Symbol map and excerpt by name, to read large code without opening the whole file.
 *
 *   node sym.cjs outline <file>             classes, functions and methods with line ranges
 *   node sym.cjs show <file> <name>         only the symbol's excerpt (accepts Class.method)
 */

const fs = require('fs');
const O = require('../lib/outline.cjs');

const MAX_MATCHES = 5;

function usage() {
  process.stderr.write('usage: sym.cjs outline <file> | sym.cjs show <file> <name>\n');
  process.exit(2);
}

const [cmd, file, name] = process.argv.slice(2);
if (!cmd || !file || (cmd === 'show' && !name)) usage();
let text;
try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
  process.stderr.write(`sym: could not read ${file}: ${e.message}\n`);
  process.exit(1);
}
if (!O.langOf(file)) {
  process.stderr.write(`sym: unsupported extension (${file}). Use Grep -n and Read with offset/limit.\n`);
  process.exit(1);
}
const syms = O.symbols(text, file);

if (cmd === 'outline') {
  process.stdout.write(syms.length ? `${O.render(text, file, syms)}\n` : 'no symbols found\n');
} else if (cmd === 'show') {
  const hits = O.find(syms, name);
  if (!hits.length) {
    const near = syms.filter((s) => s.name.toLowerCase().includes(String(name).toLowerCase())).slice(0, 10).map((s) => s.name);
    process.stdout.write(`symbol "${name}" not found${near.length ? `; similar: ${near.join(', ')}` : ''}\n`);
    process.exit(1);
  }
  const lines = text.split('\n');
  const width = String(lines.length).length;
  for (const s of hits.slice(0, MAX_MATCHES)) {
    process.stdout.write(`${file}:${s.start}-${s.end}\n`);
    for (let i = s.start; i <= s.end; i++) process.stdout.write(`${String(i).padStart(width)}\t${lines[i - 1]}\n`);
  }
  if (hits.length > MAX_MATCHES) process.stdout.write(`… ${hits.length - MAX_MATCHES} more with the same name; use Class.method\n`);
} else {
  usage();
}
