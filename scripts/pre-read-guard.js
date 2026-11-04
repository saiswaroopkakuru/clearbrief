#!/usr/bin/env node
import fs from 'node:fs';
import { loadRepoConfig } from '../src/compress.js';

const TRANSCRIPT_RE = /(?:^|[\\/])\.(?:claude|codex)[\\/].+\.jsonl$/i;
const BUILD_DIR_RE = /(?:^|[\\/])(?:dist|build|\.next|out|\.nuxt|\.svelte-kit|\.turbo|coverage|\.nyc_output)[\\/]/i;
const GENERATED_EXT_RE = /(?:\.min\.(?:js|css)|\.map|(?:^|[\\/])lcov\.info)$/i;
const LOCKFILE_RE = /(?:^|[\\/])(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum)$/i;
const DATA_DUMP_RE = /\.(?:sql|csv|tsv|jsonl|ndjson|log|xml|json)$/i;

function deny(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw || '{}');
    const input = payload.tool_input || {};
    const filePath = String(input.file_path || input.path || '');
    if (!filePath) process.exit(0);

    const limit = Number(input.limit) || 0;
    const cwd = payload.cwd || process.cwd();

    if (TRANSCRIPT_RE.test(filePath)) {
      deny(`Blocked raw Read on chat transcript. Call mcp__clearbrief__read_chat(target="${filePath}") instead.`);
    }

    const repoCfg = loadRepoConfig(cwd);
    if (repoCfg.ignoreGlobs.some((pat) => filePath.replace(/\\/g, '/').includes(pat)) && (!limit || limit > 80)) {
      deny(`Blocked Read on ignored path (${filePath}). Use Grep or pass limit<=80.`);
    }

    if (GENERATED_EXT_RE.test(filePath) && (!limit || limit > 60)) {
      deny('Blocked Read on sourcemap/minified/coverage artifact. Inspect original source files or use Grep.');
    }

    if (BUILD_DIR_RE.test(filePath) && (!limit || limit > 80)) {
      deny('Blocked full Read inside build/coverage output directory. Read source files instead, or pass limit<=80.');
    }

    let size = 0;
    try {
      if (fs.existsSync(filePath)) size = fs.statSync(filePath).size;
    } catch {}

    if (/\.svg$/i.test(filePath) && size > 8_192 && (!limit || limit > 60)) {
      deny('Blocked full Read on large SVG asset (>8KB). Pass limit<=60 if inspecting header attributes.');
    }

    if (LOCKFILE_RE.test(filePath) && size > 20_480 && !limit) {
      deny('Blocked full lockfile Read (>20KB). Use Grep to check a package version, or pass offset/limit.');
    }

    if (DATA_DUMP_RE.test(filePath) && size > 24_576 && (!limit || limit > 100)) {
      deny(
        `Blocked full Read on ${(size / 1024).toFixed(0)}KB data/log file. Pass offset + limit<=100 to sample schema/rows, or pipe through clearbrief-slim.`
      );
    }
  } catch {
    // Fail open on malformed hook stdin.
  }
  process.exit(0);
});
