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
| `contract` | session start and after `/compact` | context discipline (locate before reading, extract with a script, bound output) and an output contract, in 5 lines. Like every text this plugin adds for the model, it is written as how the project works, not as an order: injected orders can be taken for prompt injection |
| `outputs` | after `/compact` | lists the full outputs this session saved in `.trimtoken/out/`, with the command that produced each, so they are searched instead of re-run |
| `shell` | after Bash | strips ANSI codes, progress redraws, repeated lines and blank runs; log lines that differ only in a time, id, hash or duration become first line, `[×N more like: …]`, last line, and the original output is saved in `.trimtoken/out/` with its path at the end. Error lines and data rows are never grouped |
| `cap` | after Bash, Grep, MCP | above 16k characters (Bash) or 25k (others), cuts while keeping the start, the end, error lines and then `path:line` and test verdicts; the full text goes to `.trimtoken/out/`. Output that was already cut or moved to a file is left alone |
| `noiseGuard` | before Grep, Glob, Bash, PowerShell | a search or listing that walks into a dependency or build folder from the `noise` list is denied, and the denial carries the same command without that folder (`--exclude-dir=node_modules`, `-prune`, `-g '!node_modules'`, `tree -I`, `| Where-Object FullName -notmatch`, `| findstr /v`); in a git repository the corrected `grep -r` and `find` also leave out `.git`, which they would otherwise read (it never causes a denial by itself). Covered: `find`, `grep -r`, `rg` (when `.gitignore` does not already leave the folder out, or with `--no-ignore`/`-u`), `ls -R`, `tree`, `dir /s`, `Get-ChildItem -Recurse`, a Grep or Glob whose path or pattern is inside the folder, and a Grep over a folder whose `.gitignore` does not list it. Passes: reading one file there, a command that already names the folder (an exclusion or `| grep -v`), and any call once your prompt names the folder or the package. `node_modules`, `.venv`, `venv` and `site-packages` count wherever they are; the other names (`dist`, `build`, `bin`…) only where `.gitignore` lists them. `"noiseGuard": "warn"` only adds a note; `false` turns it off |
| `reread` | after Read | a full re-read of a file that changed since the last full read shows only the changed lines (Claude Code itself already answers an identical re-read with "file unchanged") |
| `json` | after MCP | indented JSON is minified (lossless) |
| `subagent` | subagent start | the subagent answers with data, not narrative |
| `watch` | every prompt | warns you (not the model) about a heavy context and a cold prompt cache, and when a prompt shares almost no words with the last ones (a new topic) while the context holds 40k tokens or more. The suggestions are Claude Code's own commands: `/clear`, `/compact <what to keep>`, `/rewind` (summarize from a chosen point, keeps the cache). When the conversation was compacted after the last response (by `/compact`, or by Claude Code itself when a conversation sits idle shortly before a 1-hour cache expires), it stays quiet: the last usage no longer describes the context |
| `resume` | resuming a session | when Claude Code (2.1.251+) reports that the prompt cache has likely expired and the context holds 30k tokens or more, warns you before the first prompt with the size and Claude Code's own cost estimate (`estimated_cache_write_usd`, at API prices), and suggests `/compact <what to keep>` or `/clear`. Nothing goes to the model |
| `resumeHold` | first prompt after such a resume | **off by default** (`"on": ["resumeHold"]`). Holds that first prompt once so you can choose `/compact` or `/clear` first; sending it again goes through, and a command is never held |
| `warm` | when a turn ends | with the 5-minute prompt cache and a context of 50k tokens or more, sends up to 3 one-word turns on a fork of the session (never saved, hooks off), 4.5 minutes apart, so the cache is still warm when you come back. The next prompt or the end of the session stops it. Does nothing with the 1-hour cache, which Claude Code uses by default on a Claude subscription; it matters with an API key, Bedrock or Vertex. Each ping is a real request: it uses your plan or API budget. It finds the Claude Code that runs the session (no PATH setup); `TRIMTOKEN_CLAUDE` sets the path by hand |
| `direct` | `/trim-token:savings`, `/trim-token:audit` | answered by the hook itself, with no model turn (0 tokens) |

Also included: the `handoff` skill and two commands:

The `handoff` skill is for a brief that goes to a context that starts empty (another session, a subagent, the first prompt after `/clear`). Staying in the same session needs no skill: `/compact <focus>` or `/rewind`.

- `/trim-token:savings`: what each mechanism saved, and this session's tokens by kind (cache read, cache write, uncached input, output), read from its transcript,
  and the billed cost in input-token equivalents with the share of each kind and the cost per model call.
  Typed only: Claude does not see it in its skill list.
- `/trim-token:audit`: MCP servers, plugins and skills enabled but unused in the last 30 days, and
  hooks from different sources on the same tools. Read-only. Typed only. For token and cache numbers it points to what Claude Code measures: `claude plugin details <name>` for a plugin's fixed tokens, and the "Prompt cache (main)" line of `/usage` for the hit rate and the likely cause of the last miss.

### Left to Claude Code

Earlier versions also blocked every unfiltered listing (`scan`; `noiseGuard` covers only dependency and build folders), blocked a command that failed twice in a row
(`retry`), answered identical re-reads, and shipped the `scout` and `runner` agents, the `lean-reading`
skill and `bin/sym.cjs`. They were removed: Claude Code already caps Glob results and moves Bash output
over 30,000 characters to a file, answers an identical re-read itself, and has the Explore agent; in
the tests the guards never fired and the agents and skill were never picked.

Also left out on purpose:

- Hiding old tool outputs (observation masking) would cut up to half the cost in long sessions, but a hook can only replace the output of the current call, not earlier ones. Claude Code's compaction is what does that today.
- The cut keeps the start, the end and the error lines, and saves the original. It does not try harder to make the cut part recoverable: in published measurements, recoverable cut content was rarely used and did not improve results.

### Checking the handoff skill

- Free: `/context` or `claude --debug` in a normal session shows whether `handoff` is listed with its description or only its name (when the skill list goes over its budget, the least used skills lose their description first). `claude plugin details trim-token` shows the fixed tokens before and after a description change.
- Uses the plan's limit: `evals/` has 8 cases (4 that should load `handoff`, 4 that should not), graded only with `tool_used`, which calls no judge. Run a few after a limit reset: `claude plugin eval . --ablation none --runs 1 --case "fires-*"`. `--max-cost-usd` caps the estimated price, not the subscription's usage.

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
  "on": ["resumeHold"],
  "limits": { "shellCap": 16000, "cap": 25000, "keep": 8000, "shellMinChars": 1500, "rereadMinChars": 2000, "jsonMinChars": 2000,
              "watchFirst": 120000, "watchStep": 60000, "coldMinTokens": 30000, "contextWindow": 200000, "coldHandoffPct": 30,
              "topicMinTokens": 40000, "warmPings": 3, "warmMinTokens": 50000, "warmEveryMs": 270000 },
  "noise": ["generated"],
  "noiseGuard": "block"
}
```

`noise` adds folder names to the list `noiseGuard` uses; a name added there counts wherever it is. `noiseGuard` is `"block"` (default), `"warn"` or `false`.
`noiseGuard` reads the command line only: a script or tool that walks the folder by itself passes, and so does a command it cannot parse. An error in the check lets the call through.

`off` turns components off and `on` turns them back on; `resumeHold` is the only one that starts off.

State lives in `<project>/.trimtoken/`, which the plugin adds to `.git/info/exclude`.

## Tests

```bash
node --test test/*.test.cjs
```

All 61 tests pass on 1.7.1 (run on 2026-11-03), including the resume warning, `resumeHold`, the compaction check and `noiseGuard`.

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
