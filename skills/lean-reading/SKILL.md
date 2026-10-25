---
name: lean-reading
description: How to search and read with little context in large repos, logs and API results, and how to react when the trim-token plugin blocks or reshapes a tool result. Use before exploring unfamiliar code or when a result starts with [trimtoken].
---

# Reading cheaply

Tool output is what fills the context, and every result is re-read on each later turn.

## Locate, then read

1. Find where: Grep with `output_mode: "files_with_matches"` (or `grep -rl ... | head -20`).
2. Read 40-120 lines around the hit with `offset`/`limit`.
3. In a large code file, list its symbols first:
   `node "${CLAUDE_PLUGIN_ROOT}/bin/sym.cjs" outline <file>`, then
   `node "${CLAUDE_PLUGIN_ROOT}/bin/sym.cjs" show <file> <name>` prints one function or class (`Class.method` works).
4. When the task needs many small facts from one big file, write a short script that extracts
   them and prints only the result.

## Bound every call

- Shell: filter and cap (`| head -50`, `grep -n ERROR file | head -40`). Long output → a file, then search it.
- Tests and builds with hundreds of lines of output → the `runner` subagent.
- APIs and MCP tools: ask for 10-20 items and only the fields you need; open details for 1-3.
- Generated paths (`node_modules`, `.venv`, `dist`, `build`, lockfiles) only when the question is about them.

## When a result starts with [trimtoken]

- **Blocked**: the message carries a bounded command. Run it.
- **Output was N chars; this is a cut**: the full text is in the file named there. Grep that file
  instead of running the command again.
- **unchanged / changed since your last full read**: the earlier read is above in this conversation;
  a change shows only the edited lines, numbered by the current file.
- **symbol map**: read the range you need. If you really need the whole file, Read it again
  without `offset`/`limit` and it comes through in full.
