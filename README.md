# trim-token

A Claude Code plugin that spends fewer tokens without losing quality. It acts where cost grows:
in tool output and in file re-reads, which stay in the context and are re-read on every turn.

Measured on a real TypeScript project (`claude -p`, 10 runs with and 10 without the plugin per task,
same pass rate in both): −23% cost on a session of three chained requests (p = 0.008) and −12% on
explaining a flow across several files (p = 0.01). A build fix showed no significant difference
(+7%, p = 0.46). The keep-warm component (`warm`) only acts with the 5-minute prompt cache, so it
does nothing on a Claude subscription, which uses the 1-hour cache.

## What it does

| Component | When | What it does |
|---|---|---|
| `contract` | session start and after `/compact` | context discipline (locate before reading, extract with a script, bound output) and an output contract, in 5 lines |
| `outputs` | after `/compact` | lists the full outputs this session saved in `.trimtoken/out/`, with the command that produced each, so they are searched instead of re-run |
| `shell` | after Bash | strips ANSI codes, progress redraws, repeated lines and blank runs; log lines that differ only in a time, id, hash or duration become first line, `[×N more like: …]`, last line, and the original output is saved in `.trimtoken/out/` with its path at the end. Error lines and data rows are never grouped |
| `cap` | after Bash, Grep, MCP | above 16k characters (Bash) or 25k (others), cuts while keeping the start, the end, error lines and then `path:line` and test verdicts; the full text goes to `.trimtoken/out/`. Output that was already cut or moved to a file is left alone |
| `reread` | after Read | a full re-read of a file that changed since the last full read shows only the changed lines (Claude Code itself already answers an identical re-read with "file unchanged") |
| `json` | after MCP | indented JSON is minified (lossless) |
| `subagent` | subagent start | the subagent answers with data, not narrative |
| `watch` | every prompt | warns you (not the model) about a heavy context and a cold prompt cache; with the cache cold and the context over 30% of the window, it suggests a handoff brief and `/clear`; it suggests the same when a prompt shares almost no words with the last ones (a new topic) and the context holds 40k tokens or more |
| `warm` | when a turn ends | with the 5-minute prompt cache and a context of 50k tokens or more, sends up to 3 one-word turns on a fork of the session (never saved, hooks off), 4.5 minutes apart, so the cache is still warm when you come back. The next prompt or the end of the session stops it. Does nothing with the 1-hour cache, which Claude Code uses by default on a Claude subscription; it matters with an API key, Bedrock or Vertex. Each ping is a real request: it uses your plan or API budget. It finds the Claude Code that runs the session (no PATH setup); `TRIMTOKEN_CLAUDE` sets the path by hand |
| `direct` | `/trim-token:savings`, `/trim-token:audit` | answered by the hook itself, with no model turn (0 tokens) |

Also included: the `handoff` skill and two commands:

- `/trim-token:savings`: what each mechanism saved, and this session's tokens by kind (cache read, cache write, uncached input, output), read from its transcript,
  and the billed cost in input-token equivalents with the share of each kind and the cost per model call.
  Typed only: Claude does not see it in its skill list.
- `/trim-token:audit`: MCP servers, plugins and skills enabled but unused in the last 30 days, and
  hooks from different sources on the same tools. Read-only. Typed only.

### Left to Claude Code

Earlier versions also blocked unfiltered listings (`scan`), blocked a command that failed twice in a row
(`retry`), answered identical re-reads, and shipped the `scout` and `runner` agents, the `lean-reading`
skill and `bin/sym.cjs`. They were removed: Claude Code already caps Glob results and moves Bash output
over 30,000 characters to a file, answers an identical re-read itself, and has the Explore agent; in
the tests the guards never fired and the agents and skill were never picked.

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
  "off": ["warm"],
  "limits": { "shellCap": 16000, "cap": 25000, "contextWindow": 200000, "coldHandoffPct": 30, "topicMinTokens": 40000, "warmPings": 3, "warmMinTokens": 50000 },
  "noise": ["generated"]
}
```

State lives in `<project>/.trimtoken/`, which the plugin adds to `.git/info/exclude`.

## Tests

```bash
node --test test/*.test.cjs
```

Scripts and raw data of an earlier A/B test are in [`ab-test/`](ab-test/); its numbers were measured on an older version.

## Tips worth more than any plugin

From the [Claude Code cost documentation](https://code.claude.com/docs/en/costs): `/clear` when you
switch tasks, Sonnet as the default (Opus only when the task needs it), a lower `/effort` on simple
tasks, and avoid pauses longer than the cache TTL in a large session. trim-token warns you when the
context gets heavy or the cache goes cold, and keeps a large session's 5-minute cache warm through a
short pause (`"off": ["warm"]` turns that off). With it installed, don't repeat the context discipline in
your projects' `CLAUDE.md`: the plugin already injects it at the start of every session.

## License

[MIT](LICENSE)
