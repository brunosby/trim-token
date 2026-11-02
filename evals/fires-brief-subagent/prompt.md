---
description: should use the handoff skill
tags: [handoff, fires]
runs: 1
max_turns: 5
allowed_tools: [Read, Glob, Grep, Skill]
---

Write the brief I should give a subagent to find why the login test fails only on CI. We know the token expiry is set in config/auth.ts:12 and the failure is a 401 in test/login.spec.ts.
