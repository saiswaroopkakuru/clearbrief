import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { clearRepoConfigCache, compress, countTokens } from '../src/compress.js';
import { listSessions, readSession, resetDeltaCache, searchChats } from '../src/chats.js';
import { summarizeChat, summarizeOutput } from '../src/digest.js';
import { detectUI, renderDigest } from '../src/ui.js';
import { TOOLS } from '../src/server.js';
import { upsertRulesFile } from '../scripts/install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_BIN = path.join(ROOT, 'src', 'server.js');
const HOOK_BIN = path.join(ROOT, 'scripts', 'session-start.js');
const GUARD_BIN = path.join(ROOT, 'scripts', 'pre-read-guard.js');
const SLIM_BIN = path.join(ROOT, 'scripts', 'slim-cli.js');

function runBin(bin, args = [], stdinText = '', env = process.env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdinText);
  });
}

function setupFixture() {
  resetDeltaCache();
  clearRepoConfigCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearbrief-'));
  const claudeDir = path.join(dir, '.claude');
  const codexDir = path.join(dir, '.codex');
  const claudeProj = path.join(claudeDir, 'projects', 'c--Users-Demo-webapp');
  const codexDay = path.join(codexDir, 'sessions', '2026', '11', '04');

  fs.mkdirSync(claudeProj, { recursive: true });
  fs.mkdirSync(codexDay, { recursive: true });

  const claudeEvents = [
    {
      type: 'user',
      sessionId: 'claude-001',
      cwd: 'C:/Users/Demo/webapp',
      gitBranch: 'fix/checkout',
      timestamp: '2026-11-04T09:00:00.000Z',
      message: {
        role: 'user',
        content: '<system-reminder>internal harness note</system-reminder>\nFix double-charging on the checkout button and run tests.'
      }
    },
    {
      type: 'assistant',
      sessionId: 'claude-001',
      cwd: 'C:/Users/Demo/webapp',
      timestamp: '2026-11-04T09:00:04.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'internal reasoning '.repeat(140) },
          { type: 'text', text: 'I will inspect the checkout component first.' },
          { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: 'src/CheckoutButton.tsx' } },
          { type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: 'src/CheckoutButton.tsx' } },
          { type: 'tool_use', id: 'u3', name: 'Bash', input: { command: 'npm test' } }
        ]
      }
    },
    {
      type: 'user',
      sessionId: 'claude-001',
      timestamp: '2026-11-04T09:00:10.000Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'u1',
            content: `data:image/png;base64,${'A'.repeat(4000)}\n` + 'export function CheckoutButton() {}\n'.repeat(60)
          },
          { type: 'tool_result', tool_use_id: 'u3', content: 'PASS src/CheckoutButton.test.tsx (12 passed)' }
        ]
      }
    },
    {
      type: 'assistant',
      sessionId: 'claude-001',
      timestamp: '2026-11-04T09:00:15.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'text',
          text: 'Certainly! Let me delve into the fix. Disabled the submit button while payment is pending and added an idempotency key.\nNext steps:\n- Verify with slow network throttling\n- Deploy staging build'
        }]
      }
    }
  ];

  const claudeFile = path.join(claudeProj, 'claude-001.jsonl');
  fs.writeFileSync(claudeFile, claudeEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const older = new Date(Date.now() - 600_000);
  fs.utimesSync(claudeFile, older, older);

  const codexEvents = [
    {
      timestamp: '2026-11-04T09:30:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-999', cwd: 'C:/Users/Demo/webapp', git: { branch: 'feat/health' } }
    },
    {
      timestamp: '2026-11-04T09:30:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: `<environment_context>\n${'env line\n'.repeat(100)}</environment_context>\nAdd /healthz to server.ts and start dev.`
        }]
      }
    },
    {
      timestamp: '2026-11-04T09:30:05.000Z',
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'c1',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Update File: src/server.ts\n@@\n+app.get("/healthz", (_, res) => res.json({ ok: true }));\n*** End Patch'
      }
    },
    {
      timestamp: '2026-11-04T09:30:08.000Z',
      type: 'response_item',
      payload: { type: 'function_call', call_id: 'c2', name: 'exec_command', arguments: JSON.stringify({ cmd: 'npm run dev' }) }
    },
    {
      timestamp: '2026-11-04T09:30:09.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c2',
        output:
          'Error: listen EADDRINUSE: address already in use :::3000\n' +
          '    at Function.listen (C:/Users/Demo/webapp/node_modules/express/lib/application.js:635:24)\n'.repeat(18)
      }
    },
    {
      timestamp: '2026-11-04T09:30:12.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Added `/healthz` to `src/server.ts`, but port 3000 is already in use.' }]
      }
    }
  ];

  const codexFile = path.join(codexDay, 'rollout-2026-11-04-codex-999.jsonl');
  fs.writeFileSync(codexFile, codexEvents.map((e) => JSON.stringify(e)).join('\n') + '\n');

  return {
    dir,
    claudeFile,
    codexFile,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

test('MCP schema footprint stays compact (<300 tokens across all tools)', () => {
  const tokens = countTokens(JSON.stringify(TOOLS));
  assert.equal(TOOLS.length, 4);
  assert.ok(tokens < 300, `expected <300 schema tokens, got ${tokens}`);
});

test('compress drops lockfiles, passing tests, Docker/ORM/NextJS noise, and custom .clearbriefrc patterns', () => {
  const fx = setupFixture();
  try {
    fs.writeFileSync(
      path.join(fx.dir, '.clearbriefrc.json'),
      JSON.stringify({ stripPatterns: ['^\\[CUSTOM_NOISE\\].*$'] })
    );

    const items = Array.from({ length: 60 }, (_, i) => ({
      id: i + 1,
      status: 'ok',
      empty: null,
      payload: 'verbose-payload-'.repeat(6)
    }));

    const raw = [
      '[CUSTOM_NOISE] noisy internal telemetry line',
      'a1b2c3d4e5f6: Pulling fs layer',
      'a1b2c3d4e5f6: Download complete',
      `Built image sha256:${'f'.repeat(64)}`,
      'prisma:info Starting a postgresql pool with 9 connections.',
      `SELECT * FROM orders WHERE id IN (${Array.from({ length: 30 }, (_, i) => `$${i + 1}`).join(', ')}) params: [${Array.from({ length: 40 }, (_, i) => `"uuid-${i}-abcdef"`).join(', ')}]`,
      `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: items })}</script>`,
      'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
      ...Array.from({ length: 40 }, (_, i) => `+  pkg-${i}: sha512-${'x'.repeat(50)}`),
      ...Array.from({ length: 30 }, (_, i) => `  ✓ passing check ${i} (1ms)`),
      'Error: ENOENT: no such file or directory, open "/app/config/prod.json"',
      ...Array.from({ length: 15 }, (_, i) => `    at Layer.handle (/app/node_modules/router/index.js:${100 + i}:12)`),
      '    at loadConfig (/app/src/config.ts:42:9)'
    ].join('\n');

    const res = compress(raw, 240, fx.dir);
    assert.ok(res.metrics.savedPercent >= 85, `expected >=85% saved, got ${res.metrics.savedPercent}%`);
    assert.ok(res.metrics.finalTokens <= 240);
    assert.ok(!res.text.includes('CUSTOM_NOISE'));
    assert.ok(!res.text.includes('Pulling fs layer'));
    assert.ok(!res.text.includes('__NEXT_DATA__'));
    assert.ok(res.text.includes('IN (…items)'));
    assert.ok(res.text.includes('src/config.ts:42:9'));
  } finally {
    fx.cleanup();
  }
});

test('chats + delta mode only parse newly appended turns on repeat reads', () => {
  const fx = setupFixture();
  try {
    const d1 = summarizeChat(readSession({ sessionTarget: 'claude-001', delta: true, env: fx.env }));
    assert.ok(d1.goals[0].includes('double-charging'));
    assert.ok(d1.metrics.savedPercent >= 85);

    const unchanged = summarizeChat(readSession({ sessionTarget: 'claude-001', delta: true, env: fx.env }));
    assert.equal(unchanged.headline, 'No new turns since last read.');
    assert.ok(unchanged.metrics.finalTokens <= 15);

    fs.appendFileSync(
      fx.claudeFile,
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-001',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Deployed fix to staging and verified metrics.' }] }
      }) + '\n'
    );
    const updated = summarizeChat(readSession({ sessionTarget: 'claude-001', delta: true, env: fx.env }));
    assert.ok(updated.headline.includes('Deployed fix to staging'));
    assert.equal(updated.goals.length, 0);

    assert.equal(searchChats('idempotency', { env: fx.env }).length, 1);
    assert.equal(listSessions({ env: fx.env }).length, 2);
  } finally {
    fx.cleanup();
  }
});

test('PreToolUse guard blocks transcripts, build dirs, sourcemaps, and large SQL dumps without limit', async () => {
  const fx = setupFixture();
  try {
    const bigSql = path.join(fx.dir, 'seed.sql');
    fs.writeFileSync(bigSql, 'INSERT INTO users VALUES (1, "demo");\n'.repeat(1000));

    const r1 = await runBin(GUARD_BIN, [], JSON.stringify({ tool_input: { file_path: fx.claudeFile } }));
    assert.equal(r1.code, 2);
    assert.ok(r1.err.includes('read_chat'));

    const r2 = await runBin(GUARD_BIN, [], JSON.stringify({ tool_input: { file_path: 'C:/repo/.next/server/app.js' } }));
    assert.equal(r2.code, 2);

    const r3 = await runBin(GUARD_BIN, [], JSON.stringify({ tool_input: { file_path: 'C:/repo/public/bundle.js.map' } }));
    assert.equal(r3.code, 2);

    const r4 = await runBin(GUARD_BIN, [], JSON.stringify({ tool_input: { file_path: bigSql } }));
    assert.equal(r4.code, 2);
    assert.ok(r4.err.includes('limit<=100'));

    // Windowed sample slice on large SQL dump is allowed!
    const r5 = await runBin(GUARD_BIN, [], JSON.stringify({ tool_input: { file_path: bigSql, limit: 40 } }));
    assert.equal(r5.code, 0);

    // Normal source file is allowed with zero output
    const r6 = await runBin(GUARD_BIN, [], JSON.stringify({ tool_input: { file_path: 'C:/repo/src/index.ts' } }));
    assert.equal(r6.code, 0);
    assert.equal(r6.out, '');
  } finally {
    fx.cleanup();
  }
});

test('slim-cli pipe binary and CLAUDE.md/AGENTS.md rule injector work end-to-end', async () => {
  const fx = setupFixture();
  try {
    const noisy = Array.from({ length: 50 }, (_, i) => `  ✓ test ${i} passed`).join('\n') +
      '\nError: listen EADDRINUSE: address already in use :::4000\n';

    const piped = await runBin(SLIM_BIN, ['--max-tokens', '160'], noisy);
    assert.equal(piped.code, 0);
    assert.ok(piped.out.includes('Port 4000 is already in use'));

    const claudeMd = path.join(fx.dir, 'CLAUDE.md');
    assert.equal(upsertRulesFile(claudeMd), 'created');
    assert.equal(upsertRulesFile(claudeMd), 'updated');
    const content = fs.readFileSync(claudeMd, 'utf8');
    assert.equal((content.match(/<!-- clearbrief:start -->/g) || []).length, 1);
  } finally {
    fx.cleanup();
  }
});

test('stdio server supports compact tools, legacy aliases, and low-token handoff', async () => {
  const fx = setupFixture();
  try {
    const proc = spawn(process.execPath, [SERVER_BIN], { env: fx.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = [];
    let buf = '';

    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('stdio timeout')), 5000);
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          replies.push(JSON.parse(line));
          if (replies.length === 4) {
            clearTimeout(t);
            resolve();
          }
        }
      });
      proc.on('error', reject);
    });

    const msgs = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'codex-cli', version: '1.0.0' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_chat', arguments: { target: 'latest' } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read_chat', arguments: { src: 'claude', handoff: true } } }
    ];

    for (const m of msgs) proc.stdin.write(JSON.stringify(m) + '\n');
    await done;
    proc.kill();

    assert.equal(replies[1].result.tools.length, 4);
    assert.ok(replies[2].result.content[0].text.includes('Port 3000 is already in use'));
    assert.ok(countTokens(replies[3].result.content[0].text) <= 180);

    const hook = await runBin(HOOK_BIN, [], '{}');
    assert.equal(hook.code, 0);
    assert.ok(countTokens(hook.out) <= 40);

    const codex = detectUI({ name: 'codex-cli', version: '0.42.0' }, {});
    const desktop = detectUI({ name: 'claude-ai', version: '1.0.0' }, {});
    const sample = summarizeOutput('SyntaxError: Unexpected token }');
    assert.ok(!renderDigest(sample, codex).includes('<details>'));
    assert.ok(renderDigest(sample, desktop).includes('<details>'));
  } finally {
    fx.cleanup();
  }
});
