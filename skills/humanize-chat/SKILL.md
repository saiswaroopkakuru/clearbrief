---
name: humanize-chat
description: Summarize Claude or Codex chat transcripts in plain English with minimal tokens. Use when asked to read, recap, search, or explain sessions.
---

1. Never `Read` or `cat` `.jsonl` transcripts directly. Use `clearbrief` MCP tools:
   - `read_chat` (`target: "latest"` or id/path; pass `delta: true` on repeat checks to read only new turns).
   - `chats` (omit `q` to list recent chats; pass `q` to search across chat history).
   - `ui` (check active UI formatting rules once per session).
2. Lead with a 1-sentence plain-English outcome, translate errors into cause + fix, and match the active UI (flat bullets in CLI; callout + compact table in Desktop/App).
