---
disable-model-invocation: true
description: Lists MCP servers, plugins and skills that are enabled but unused in the last 30 days, and hooks that act on the same tools
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/audit.cjs" "$PWD" 30`

Present the audit above briefly. Do not disable anything; the user decides.
