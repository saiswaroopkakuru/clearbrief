#!/usr/bin/env node
import { compress } from '../src/compress.js';
import { summarizeOutput } from '../src/digest.js';
import { detectUI, renderDigest } from '../src/ui.js';

const args = process.argv.slice(2);
const rawMode = args.includes('--raw');
const idx = args.indexOf('--max-tokens');
const maxTokens = idx !== -1 && Number(args[idx + 1]) ? Number(args[idx + 1]) : 220;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.trim()) process.exit(0);

  if (rawMode) {
    const res = compress(input, maxTokens);
    process.stdout.write(`${res.text}\n[${res.metrics.rawTokens}->${res.metrics.finalTokens} tok, -${res.metrics.savedPercent}%]\n`);
    return;
  }

  const ui = detectUI(null, process.env);
  const digest = summarizeOutput(input, { maxTokens });
  process.stdout.write(`${renderDigest(digest, ui)}\n`);
});
