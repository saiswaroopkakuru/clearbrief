#!/usr/bin/env node
import { detectUI } from '../src/ui.js';

async function main() {
  if (!process.stdin.isTTY) {
    await Promise.race([
      new Promise((resolve) => {
        process.stdin.resume();
        process.stdin.on('end', resolve);
        process.stdin.on('error', resolve);
      }),
      new Promise((resolve) => setTimeout(resolve, 100))
    ]);
  }

  const ui = detectUI({ name: 'claude-code' }, process.env);
  const trigger = ui.skills[0]?.trigger || 'humanize-chat';
  process.stdout.write(
    `[ClearBrief:${ui.id}] Plain English, short bullets; use read_chat & slim (${trigger}).\n`
  );
}

main().catch(() => process.exit(0));
