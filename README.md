# clearbrief

Low-token MCP plugin for Claude Code, Claude Desktop, and OpenAI Codex. Reads local `~/.claude` and `~/.codex` transcripts, strips noise (lockfile diffs, passing test walls, `<thinking>`, SVG/DOM bloat, stack internals, pretty-JSON whitespace), rewrites output in plain English, and matches skills and layout to the active UI.

Requires Node.js 18+. Zero dependencies, zero external API keys.

## Install

Clone the repo anywhere on your machine:

```bash
git clone https://github.com/saiswaroopkakuru/clearbrief.git
cd clearbrief
```

### Claude Code

Run as a full plugin (loads MCP server, skills, subagent, and hooks):

```bash
claude --plugin-dir ./clearbrief
```

Or register the MCP server globally:

```bash
claude mcp add --scope user clearbrief -- node /path/to/clearbrief/src/server.js
```

### OpenAI Codex

Adds `[mcp_servers.clearbrief]` to `~/.codex/config.toml` and syncs skills into `~/.agents/skills/`:

```bash
node ./scripts/install.js --codex
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clearbrief": {
      "command": "node",
      "args": ["/path/to/clearbrief/src/server.js"]
    }
  }
}
```

## Tools (4 compact schemas, ~280 tokens total)

- `chats` — list recent Claude/Codex sessions, or pass `q` to search past chats.
- `read_chat` — plain-English session summary (`delta: true` reads only newly appended turns; `handoff: true` caps output to `<180` tokens).
- `slim` — compress noisy logs, git diffs, test output, HTML/DOM, or JSON to a strict token budget.
- `ui` — inspect active host UI (`claude-cli`, `claude-desktop`, `codex-cli`, `codex-app`), style rules, and skill triggers.

*(Legacy tool names `list_chat_sessions`, `read_and_humanize_chat`, `search_chat_memory`, `compress_and_humanize_output`, `get_interface_skill_profile`, and `session_handoff_brief` remain supported as zero-cost aliases.)*

## Hooks

- `SessionStart` (`scripts/session-start.js`): ~25-token UI-matched plain-English directive.
- `PreToolUse` on `Read` (`scripts/pre-read-guard.js`): blocks raw `Read` calls on `.claude`/`.codex` `.jsonl` transcripts and un-windowed >20 KB lockfiles so accidental reads never dump 50k+ tokens into context.

## Verify & Benchmark

```bash
npm run check
npm test
npm run bench
```

## License

MIT
