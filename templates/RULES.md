<!-- clearbrief:start -->
## Context & Token Discipline (ClearBrief)

- **Compress noisy command output**: Pipe test runs, package installs, Docker builds, and large diffs (>30 lines) through `clearbrief-slim` (or pass output to the `slim` MCP tool) instead of dumping raw logs into context.
- **Exclude generated bloat in diffs**: Prefer `git diff -- . ":(exclude)*lock*" ":(exclude)*.map" ":(exclude)dist/*" ":(exclude).next/*"`.
- **Never read raw transcripts or dumps**: Use `read_chat` (`delta: true` on follow-ups) for `.claude`/`.codex` history, and pass `offset` + `limit<=80` when sampling `.sql`, `.csv`, or large `.json` files.
- **Session & subagent handoffs**: Before ending a long session or delegating to a subagent, run `read_chat(handoff: true)` for a `<180`-token checkpoint.
- **Plain human brevity**: Skip conversational filler; lead with a 1-sentence outcome and plain cause-and-fix explanations.
<!-- clearbrief:end -->
