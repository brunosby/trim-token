# A/B test — trim-token plugin × Claude Code without a plugin

> The plugin was called *enxuto* during the test; it was renamed to trim-token with no code change. The hooks still tag their messages with `[trimtoken]`.

Run on 2026-10-24 with headless Claude Code 2.1.310 and `claude-sonnet-5-5`, on the same 8 tasks
and the same test repository as the previous kit (`RESULTS.md`). Each plugin version had 2
sessions per task; the no-plugin arm ran alongside each version, for 6 sessions per task in total.
Altogether there were 96 sessions, all with an automatic grader.

**Result: version 3 (published as 1.0.0) cost 13% less than Claude Code without a plugin, with
16/16 passes. On the heavy tasks, −20%; on the short ones, −7%.**

## Versions tested

| Version | What changed | Short | Heavy | Total | Passes |
|---|---|---|---|---|---|
| no plugin (6 sessions/task) | — | baseline | baseline | baseline | 47/48 |
| v1 | original specification | +14% | +14% | +14% | 16/16 |
| v2 | no blocking of `grep -r`; map on a Read denied for size | −6% | +14% | +3% | 16/16 |
| **v3 = 1.0.0** | map off by default; context discipline at session start | **−7%** | **−20%** | **−13%** | **16/16** |

Cost = Claude Code's `total_cost_usd`, average per task summed over the group. Tokens stayed
about the same in every version (−2% to +16%). v3's cost drop comes from less output and fewer
cache writes.

## Per task (v3 against the average of 6 no-plugin sessions)

| Task | No plugin (US$) | v3 (US$) | Difference |
|---|---|---|---|
| qa | 0.0438 | 0.0377 | −14% |
| inventory | 0.0379 | 0.0398 | +5% |
| triage | 0.0537 | 0.0456 | −15% |
| bugfix | 0.0456 | 0.0446 | −2% |
| feature | 0.0520 | 0.0437 | −16% |
| rename | 0.0452 | 0.0461 | +2% |
| audit | 0.1703 | 0.1292 | −24% |
| logdiff | 0.0647 | 0.0575 | −11% |

## What each test taught

- **Blocking `grep -r`/`rg` makes things worse (v1):** in the rename task, the search was legitimate
  and small. The denial only added turns (+19% on that task). It was removed; the guard now covers
  only tree listings.
- **The symbol map did not help:** Claude Code's Read refuses files above 25k tokens, and an agent
  that needs the whole file asks for it with `limit` or `allow_large`. The attempt to send the map
  in that refusal (v2) was undone. The map on Read is off by default, and the `sym` CLI is still
  available.
- **The output cap and cleanup barely fired:** from 30k characters on, Claude Code itself writes the
  output to a file and shows 2 KB to the model.
- **Context discipline at session start worked (v3):** the agent started extracting what it needed
  with scripts instead of reading whole files. This was the change that turned +3% into −13%.

This matches the study [Token Reduction Is Not Cost Reduction](https://arxiv.org/html/2607.12161v5):
2,908 Claude Code sessions, tool output at ~3% of cost, cache writes and reads at ~87%, and
aggressive compression raising cost through extra turns.

## Limits

- 2 sessions per version and task. Differences of ±10% on a single task are within noise; between
  batches, the no-plugin arm varied by about 10%. The group numbers are more reliable.
- One model and one synthetic repository. Single-prompt sessions: re-reads as diffs and
  re-injection after `/compact` were not exercised.
- In a real repository, run `/trim-token:savings` after a few sessions to see what acted.

Data: `results-e1.jsonl`, `results-e2.jsonl`, `results-e3.jsonl` (arm A = no plugin,
arm E = trim-token, then called enxuto). Script: `abrun.py` (arm E loads the plugin with `--plugin-dir`).
