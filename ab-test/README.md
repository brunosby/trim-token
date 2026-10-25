# ab-test

A/B tests that measured the cost of headless Claude Code without (arm A) and with (arm B) the kit.

| File | What it is |
|---|---|
| [`RESULTS-trim-token.md`](RESULTS-trim-token.md) | Results for the trim-token plugin (3 versions, 96 sessions). |
| [`RESULTS.md`](RESULTS.md) | Results for the previous kit, based on `CLAUDE.md` and skills. |
| `abrun.py` | Runs the tasks in clean copies of the test repository and grades each session. |
| `analyze.py` | Summarizes a `results*.jsonl` by task and arm. |
| `regrade.py` | Re-grades sessions from the full answer saved in the transcript. |
| `repo-generator/` | Generates the synthetic Python repository the tasks run against. |
| `results*.jsonl` | Raw data: one line per session, with grade, cost, tokens, turns and final answer. |

## Reproduce

Requires Python 3, Claude Code on the PATH and an account with credits (a full run costs a few dollars).

```bash
python3 repo-generator/gen_repo.py ~/ab/template
python3 abrun.py results.jsonl all 2 --workers 4
python3 analyze.py results.jsonl
```

The task prompts and the generated repository are in Portuguese, exactly as they were measured.

`AB_HOME` (default `~/ab`) sets the working folder, which must contain `template/` and, for the
previous kit's arm, `kithome/CLAUDE.md` and `kithome/.claude/`. `TRIMTOKEN_DIR` points to the plugin
(default: the root of this repository). The scripts were written for Linux or macOS (they use `cp -al`).
