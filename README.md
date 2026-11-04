# clearbrief

Proactive low-token MCP plugin and CLI filter for Claude Code, Claude Desktop, and OpenAI Codex. Reads local `~/.claude` and `~/.codex` transcripts, strips stack/diff/test/Docker/ORM/DOM bloat (94%–99.6% fewer context tokens), rewrites output in plain English, and matches skills and layout to the active UI.

Requires Node.js 18+. Zero dependencies, zero external API keys.

## Install

```bash
git clone https://github.com/saiswaroopkakuru/clearbrief.git
cd clearbrief
```

### Claude Code

```bash
claude --plugin-dir ./clearbrief
```

Or from inside Claude Code via GitHub marketplace:

```text
/plugin marketplace add saiswaroopkakuru/clearbrief
/plugin install clearbrief@clearbrief-local
```

Or register the MCP server globally:

```bash
claude mcp add --scope user clearbrief -- node /path/to/clearbrief/src/server.js
```

### OpenAI Codex

```bash
node ./scripts/install.js --codex
```

### Claude Desktop

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

## Proactive Context Filtering (Beyond Passive MCP Calls)

### 1. Inject `CLAUDE.md` & `AGENTS.md` Enforcement Rules

Ensure Claude and Codex automatically compress >30-line command outputs and emit `<180`-token session handoffs:

```bash
# Add/update rules in a project directory
node ./scripts/install.js --rules /path/to/your-repo

# Or install globally into ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md
node ./scripts/install.js --global-rules
```

### 2. Pipe CLI & Shell Aliases (`clearbrief-slim`)

Compress command output directly in the shell before it ever reaches the LLM context window (zero extra MCP tool round-trip):

```bash
npm test 2>&1 | node /path/to/clearbrief/scripts/slim-cli.js --raw
git diff | node /path/to/clearbrief/scripts/slim-cli.js --max-tokens 250
```

Optional shell & git aliases:

```bash
# Bash / Zsh
source /path/to/clearbrief/scripts/aliases.sh

# PowerShell
. C:\path\to\clearbrief\scripts\aliases.ps1

# Global git `sdiff` alias (excludes lockfiles, sourcemaps, dist/, .next/)
node ./scripts/install.js --git-alias
```

### 3. Expanded `PreToolUse` Read Guard (`scripts/pre-read-guard.js`)

Automatically blocks context-blowing `Read` calls before they execute:
- `~/.claude` & `~/.codex` `.jsonl` chat transcripts → redirects to `read_chat`
- Build & coverage folders (`dist/`, `build/`, `.next/`, `out/`, `.nuxt/`, `.turbo/`, `coverage/`)
- Sourcemaps (`*.map`), minified bundles (`*.min.js`/`.css`), `lcov.info`, and SVG dumps (>8 KB)
- Lockfiles (>20 KB) and large data/log dumps (`*.sql`, `*.csv`, `*.tsv`, `*.jsonl`, `*.log`, `*.json` >24 KB) when called without `offset`/`limit`

### 4. Custom Per-Repo Rules (`.clearbriefrc.json`)

Drop an optional `.clearbriefrc.json` in your repo root to add stack-specific regex filters, blocked read paths, or a stricter default token ceiling:

```json
{
  "maxTokens": 200,
  "stripPatterns": ["^\\[webpack\\.Progress\\].*$"],
  "ignorePaths": ["fixtures/huge-seed", "generated/graphql.ts"]
}
```

### 5. Complementary Context Optimizers

ClearBrief pairs cleanly with:
- **[Caveman](https://github.com/juliusbrussee/caveman)** — strips polite conversational filler to cut billable output tokens further.
- **[Graphify](https://github.com/Graphify-Labs/graphify)** — indexes codebase dependency graphs so the agent queries relationships instead of reading whole files.

## MCP Tools (4 schemas, ~280 tokens total)

- `chats` — list recent Claude/Codex sessions, or pass `q` to search past chats.
- `read_chat` — plain-English session recap (`delta: true` reads only newly appended turns; `handoff: true` caps output to `<180` tokens).
- `slim` — compress noisy logs, diffs, test runs, Docker/ORM output, HTML/SSR dumps, or JSON.
- `ui` — inspect active host UI (`claude-cli`, `claude-desktop`, `codex-cli`, `codex-app`), style rules, and skill triggers.

## Verify & Benchmark

```bash
npm run check
npm test
npm run bench
```

## License

MIT
