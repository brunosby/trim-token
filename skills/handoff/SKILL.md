---
name: handoff
description: Use when work moves to a context that starts empty - another session tomorrow, a subagent, or the first prompt after /clear - to write the brief it needs (goal, known facts with path:line, scope, expected answer, when to stop). For staying in the same session, Claude Code covers it with /compact <focus> or /rewind. Not for a summary the user reads here.
when_to_use: The user will continue later or elsewhere, or work is delegated. Phrases like "vou continuar amanhã", "continuo em outra sessão", "antes do /clear", "prepare um resumo para passar adiante", "passe isso para um subagente", "I will pick this up tomorrow", "write a handoff", "before I clear", "brief a subagent".
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

Staying in this session needs no brief: Claude Code keeps the work with `/compact <focus>`, or with `/rewind` (summarize from a chosen point, which keeps the prompt cache). Before `/compact`, the same skeleton works as the focus:
`/compact Keep: goal, decisions taken, files changed and why, open items, next step. Drop: dead ends and full tool outputs.`

After `/clear`, the brief is the first prompt. Decisions that must outlive sessions go into the
repository (README, ADR, CLAUDE.md), not into the brief.
