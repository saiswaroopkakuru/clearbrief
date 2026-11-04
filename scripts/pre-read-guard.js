#!/usr/bin/env node
import fs from 'node:fs';

const LOCKFILE_RE = /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock)$/i;
const TRANSCRIPT_RE = /(?:^|[\\/])\.(?:claude|codex)[\\/].+\.jsonl$/i;

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}');
    const input = payload.tool_input || {};
    const filePath = String(input.file_path || input.path || '');
    if (!filePath) process.exit(0);

    if (TRANSCRIPT_RE.test(filePath)) {
      process.stderr.write(
        `Blocked raw Read on session transcript. Call mcp__clearbrief__read_chat with target="${filePath}" instead to save ~98% tokens.\n`
      );
      process.exit(2);
    }

    if (LOCKFILE_RE.test(filePath) && !input.limit) {
      const size = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
      if (size > 20_480) {
        process.stderr.write(
          'Blocked full lockfile Read (>20KB). Pass `limit`/`offset` or use Grep to avoid burning context tokens.\n'
        );
        process.exit(2);
      }
    }
  } catch {
    // Fail open on malformed hook stdin so normal work is never disrupted.
  }
  process.exit(0);
});
