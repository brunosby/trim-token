# A/B test — previous kit × Claude Code without a kit

Run on 2026-10-24 with headless Claude Code 2.1.310 (`claude -p`) and the `claude-sonnet-5-5` model.
There were 8 tasks, 2 arms and 2 repetitions: 32 sessions in total, each in a clean copy of the
test repository. Each session's grade comes from an automatic grader (tests, a hidden test and a
check of the answer).

**Result: quality held (16/16 in both arms). On tasks with large input, the kit cut cost by 33%
and tokens by 28%. On short tasks, it cost 8% more.** Overall, cost fell 12% and tokens stayed
about the same (+2%).

## By group

| Group | Sessions A / B | Passes A / B | Cost A → B | Tokens A → B | Output A → B |
|---|---|---|---|---|---|
| Short (6 tasks) | 12 / 12 | 12 / 12 | US$ 0.609 → 0.655 (**+8%**) | 861k → 1,101k (+28%) | 12.0k → 13.5k (+12%) |
| Heavy (2 tasks) | 4 / 4 | 4 / 4 | US$ 0.580 → 0.388 (**−33%**) | 712k → 509k (−28%) | 10.4k → 10.2k (−2%) |
| All | 16 / 16 | 16 / 16 | US$ 1.189 → 1.042 (**−12%**) | 1,573k → 1,610k (+2%) | 22.4k → 23.7k (+6%) |

"Tokens" sums input, cache reads, cache writes and output from every model in the session,
subagents included. "Cost" is the `total_cost_usd` reported by Claude Code.

## Per task (average of 2 sessions)

| Task | What it asks | Passes A / B | Cost A → B (US$) | Tokens A → B |
|---|---|---|---|---|
| qa | two config values with file:line | 2/2 · 2/2 | 0.047 → 0.047 | 56k → 68k |
| inventory | every subclass of `BaseRule` | 2/2 · 2/2 | 0.047 → 0.049 | 56k → 58k |
| triage | cause of the failure in a 790 KB CI log | 2/2 · 2/2 | 0.055 → 0.059 | 96k → 112k |
| bugfix | find and fix a bug with the suite failing | 2/2 · 2/2 | 0.049 → 0.055 | 77k → 109k |
| feature | new function + test, validated by a hidden test | 2/2 · 2/2 | 0.058 → 0.057 | 68k → 80k |
| rename | rename a function used in 4 files (56 occurrences) | 2/2 · 2/2 | 0.048 → 0.061 | 77k → 124k |
| **audit** | check 45 readers (a 73 KB file) against the docstring; 3 planted defects | 2/2 · 2/2 | **0.207 → 0.133** | **215k → 165k** |
| **logdiff** | compare two 790 KB CI logs | 2/2 · 2/2 | **0.083 → 0.061** | **141k → 89k** |

## What explains the difference

- **Heavy:** in arm A, the agent read the whole 73 KB file (once or twice) and pulled in long
  `diff`/`grep` output. In B, the shell output cap (16 KB, keeping the error lines) cut the output
  in `audit`, and the agent started extracting only what it needed with scripts. No answer missed a
  planted defect.
- **Short:** the model already solves these tasks with 2 to 7 tool calls, almost all of them
  well-bounded `grep`s. The kit's blocks never fired. What remains is the fixed cost: the injected
  output contract (~0.7 to 2k characters), `CLAUDE.md`, skill and agent descriptions, and two
  delegations to the `runner` subagent (bugfix and rename, once each) that cost more than running
  the suite directly.
- **Fix made after the test and not measured:** `CLAUDE.md` now sends only suites and builds with
  hundreds of lines of output to the `runner`.

## Limits of this measurement

- 2 repetitions per cell: it detects large differences, like those on the heavy tasks. The ±10%
  differences on the short tasks are within noise.
- One model (Sonnet 5.5) and a synthetic repository written for the test: a Python package of
  ~2.6k lines with `node_modules`, `.venv` and logs as noise. The environment did not allow running
  third-party code.
- Single-prompt sessions. Re-reading an edited file and re-injecting the contract after compaction
  only show up in long sessions, and were not exercised.
- The `audit` grader had a regex bug: `\bneon\b` does not match inside `parse_line_neon`, and that
  failed both B sessions. It was fixed and the four `audit` sessions were re-graded from the full
  answer saved in the transcript (`regrade.py`). Both B answers find all three defects.

## Reproduce

```bash
python3 repo-generator/gen_repo.py ~/ab/template        # then add node_modules/ and .venv/ as noise
python3 abrun.py results.jsonl all 2 --workers 4         # AB_HOME (default ~/ab) and TRIMTOKEN_DIR change the paths
python3 analyze.py results.jsonl
```

`results.jsonl` has one line per session: grade, grader details, cost, tokens by type, turns,
tools used and the final answer.
