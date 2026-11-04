---
name: cross-chat-handoff
description: Carry context between Claude Code and Codex in under 180 tokens. Use when switching agents or resuming work.
---

1. Call `read_chat` with `handoff: true` (`src: "codex"` when entering Claude, `"claude"` when entering Codex, or `"all"` for latest).
2. Give a 3-line catch-up: where the last session stopped, files changed, and next step.
