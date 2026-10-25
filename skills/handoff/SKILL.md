---
name: handoff
description: Write the brief that carries work into a fresh context — a subagent prompt, /compact instructions, or the first prompt after /clear. Use when delegating to scout, runner or any subagent, or before compacting or clearing.
---

# Handing work to a fresh context

The receiver knows only what the brief says. Too little and it re-discovers the repository;
too much and it pays for history it does not need.

```text
GOAL      one sentence: the question to answer or the change to make
KNOWN     established facts, each with path:line, so nobody searches for them again
          hypotheses already ruled out, one line each
SCOPE     where to look, and what not to touch
RETURN    the exact shape wanted: verdict + path:line list | failing test ids | summary of the diff
STOP WHEN the condition that ends the work
```

- One goal per brief. A second goal is a second brief, or a second subagent in parallel.
- Pass locations, not content: `src/p.py:88` costs one line; pasting the function costs it twice.
- For logs, pass the command and the failing lines, not the run.

Before `/compact`, give the same skeleton as the focus:
`/compact Keep: goal, decisions taken, files changed and why, open items, next step. Drop: dead ends and full tool outputs.`

After `/clear`, the brief is the first prompt. Decisions that must outlive sessions go into the
repository (README, ADR, CLAUDE.md), not into the brief.
