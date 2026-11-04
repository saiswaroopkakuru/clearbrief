import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { compress, countTokens } from '../src/compress.js';
import { listSessions, readSession, resetDeltaCache, searchChats } from '../src/chats.js';
import { summarizeChat, summarizeOutput } from '../src/digest.js';
import { detectUI, renderDigest } from '../src/ui.js';
import { TOOLS } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_BIN = path.join(ROOT, 'src', 'server.js');
const HOOK_BIN = path.join(ROOT, 'scripts', 'session-start.js');
const GUARD_BIN = path.join(ROOT, 'scripts', 'pre-read-guard.js');

function setupFixture() {
  resetDeltaCache();
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

test('compress drops lockfile diffs, passing test walls, SVG/DOM bloat, JSON arrays, and library frames', () => {
  const items = Array.from({ length: 80 }, (_, i) => ({
    id: i + 1,
    status: 'ok',
    empty: null,
    payload: 'verbose-payload-'.repeat(8)
  }));

  const raw = [
    'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
    ...Array.from({ length: 60 }, (_, i) => `+  pkg-${i}: sha512-${'x'.repeat(50)}`),
    'diff --git a/src/config.ts b/src/config.ts',
    '+export const timeout = 5000;',
    ...Array.from({ length: 40 }, (_, i) => `  ✓ passing check ${i} (1ms)`),
    '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>',
    ...Array.from({ length: 25 }, () => '2026-11-04T10:00:01.123Z GET /api/poll 200 OK'),
    '```json',
    JSON.stringify({ total: 80, error: 'Shard 3 timeout', items }, null, 2),
    '```',
    'Error: ENOENT: no such file or directory, open "/app/config/prod.json"',
    ...Array.from({ length: 20 }, (_, i) => `    at Layer.handle (/app/node_modules/router/index.js:${100 + i}:12)`),
    '    at loadConfig (/app/src/config.ts:42:9)'
  ].join('\n');

  const res = compress(raw, 240);
  assert.ok(res.metrics.savedPercent >= 85, `expected >=85% saved, got ${res.metrics.savedPercent}%`);
  assert.ok(res.metrics.finalTokens <= 240, `expected <=240 tokens, got ${res.metrics.finalTokens}`);
  assert.ok(!res.text.includes('sha512-xxxx'));
  assert.ok(!res.text.includes('<path d='));
  assert.ok(res.text.includes('src/config.ts:42:9'));
});

test('chats + delta mode only parse newly appended turns on repeat reads', () => {
  const fx = setupFixture();
  try {
    const first = readSession({ sessionTarget: 'claude-001', delta: true, env: fx.env });
    const d1 = summarizeChat(first);
    assert.ok(d1.goals[0].includes('double-charging'));
    assert.ok(d1.metrics.savedPercent >= 85);

    // Second delta read with no file changes -> 0 new events (~10 tokens)
    const unchanged = summarizeChat(readSession({ sessionTarget: 'claude-001', delta: true, env: fx.env }));
    assert.equal(unchanged.headline, 'No new turns since last read.');
    assert.ok(unchanged.metrics.finalTokens <= 15);

    // Append a new turn and verify delta reads ONLY the new turn
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

    const matches = searchChats('idempotency', { env: fx.env });
    assert.equal(matches.length, 1);
  } finally {
    fx.cleanup();
  }
});

test('ui adapts skill triggers and PreToolUse guard blocks raw transcript Read calls', async () => {
  const codex = detectUI({ name: 'codex-cli', version: '0.42.0' }, {});
  const desktop = detectUI({ name: 'claude-ai', version: '1.0.0' }, {});

  const digest = summarizeOutput('TypeError: Cannot read properties of undefined (reading "email") at src/user.ts:18:4');
  assert.ok(!renderDigest(digest, codex).includes('<details>'));
  assert.ok(renderDigest(digest, desktop).includes('<details>'));

  // Guard blocks ~/.claude/.../*.jsonl with exit code 2
  const blocked = await new Promise((resolve) => {
    const p = spawn(process.execPath, [GUARD_BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString('utf8'); });
    p.on('close', (code) => resolve({ code, err }));
    p.stdin.end(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:/Users/Demo/.claude/projects/app/s1.jsonl' } }));
  });
  assert.equal(blocked.code, 2);
  assert.ok(blocked.err.includes('read_chat'));

  // Guard allows normal source files with exit code 0 and 0 output
  const allowed = await new Promise((resolve) => {
    const p = spawn(process.execPath, [GUARD_BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString('utf8'); });
    p.on('close', (code) => resolve({ code, out }));
    p.stdin.end(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'C:/Users/Demo/app/src/index.ts' } }));
  });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.out, '');
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

    const hookText = await new Promise((resolve, reject) => {
      const h = spawn(process.execPath, [HOOK_BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      h.stdout.on('data', (d) => { out += d.toString('utf8'); });
      h.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
      h.stdin.end('{}');
    });
    assert.ok(countTokens(hookText) <= 40, `expected <=40 hook tokens, got ${countTokens(hookText)}`);
  } finally {
    fx.cleanup();
  }
});
