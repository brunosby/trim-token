# trim-token

A Claude Code plugin that spends fewer tokens without losing quality. It acts where cost grows:
in tool output and in file re-reads, which stay in the context and are re-read on every turn.

A/B test (Claude Code 2.1.310, Sonnet 5.5, 8 tasks): −13% cost overall, −20% on tasks with a large
file or log and −7% on short ones, with 16/16 passes. Method, data and limits in
[`ab-test/RESULTS-trim-token.md`](ab-test/RESULTS-trim-token.md).

## What it does

| Component | When | What it does |
|---|---|---|
| `contract` | session start and after `/compact` | context discipline (locate before reading, extract with a script, bound output) and an output contract, in 5 lines |
| `scan` | before Bash and Glob | blocks unfiltered `find .`, `ls -R`, `tree` without a depth and Glob `**/*`; the denial carries the rewritten command. Content search stays free |
| `shell` | after Bash | strips ANSI codes, progress redraws, repeated lines and blank runs |
| `cap` | after Bash, Grep, MCP | above 16k characters (Bash) or 25k (others), cuts while keeping the start, the end and error lines; the full text goes to `.trimtoken/out/` |
| `reread` | after Read | an identical re-read becomes a short notice; a changed file shows only the changed lines |
| `outline` | after Read | **off by default**: the first full read of a code file over 50 KB becomes a symbol map; asking again returns the whole file |
| `json` | after MCP | indented JSON is minified (lossless) |
| `subagent` | subagent start | the subagent answers with data, not narrative |
| `watch` | every prompt | warns you (not the model) about a heavy context and a cold prompt cache |

Also included: `bin/sym.cjs` (symbol map and per-symbol excerpts, no MCP needed), the `scout` and
`runner` agents, the `lean-reading` and `handoff` skills, and the
`/trim-token:savings` command, which shows what the plugin saved.

## Install

```text
/plugin marketplace add brunosby/trim-token
/plugin install trim-token@trim-token
```

Requires Node.js 16 or later on the PATH and Claude Code 2.1.121 or later (to replace tool output).

Restart the session and check it with `/trim-token:savings`. To try it without installing, from a
clone: `claude --plugin-dir <path-to-clone>`.

## Configure

`TRIMTOKEN=off` turns everything off. To tune it, create `.trimtoken.json` in the project or
`~/.claude/trimtoken.json`:

```json
{
  "off": ["scan"],
  "on": ["outline"],
  "limits": { "shellCap": 16000, "cap": 25000, "outlineBytes": 51200, "scanMinFiles": 300 },
  "noise": ["generated"]
}
```

State lives in `<project>/.trimtoken/`, which the plugin adds to `.git/info/exclude`.

## Tests

```bash
node --test test/*.test.cjs
```

The A/B test that measures the savings is in [`ab-test/`](ab-test/), with scripts and raw data.

## Tips worth more than any plugin

From the [Claude Code cost documentation](https://code.claude.com/docs/en/costs): `/clear` when you
switch tasks, Sonnet as the default (Opus only when the task needs it), a lower `/effort` on simple
tasks, and avoid pauses longer than the cache TTL in a large session. trim-token warns you when the
context gets heavy or the cache goes cold. With it installed, don't repeat the context discipline in
your projects' `CLAUDE.md`: the plugin already injects it at the start of every session.

## License

[MIT](LICENSE)
