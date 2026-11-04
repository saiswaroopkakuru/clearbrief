#!/usr/bin/env node
import { countTokens } from '../src/compress.js';
import { readSession } from '../src/chats.js';
import { summarizeChat, summarizeOutput } from '../src/digest.js';
import { PROFILES, renderDigest } from '../src/ui.js';
import { TOOLS } from '../src/server.js';

const ui = PROFILES['claude-cli'];

// 1. Multi-turn Claude session transcript (~14k tokens raw)
const claudeTranscript = Array.from({ length: 18 }, (_, i) => [
  JSON.stringify({
    type: 'user',
    sessionId: 'bench-claude',
    cwd: '/repo/payments-api',
    message: {
      role: 'user',
      content: i === 0
        ? '<system-reminder>' + 'policy note '.repeat(120) + '</system-reminder>\nFix duplicate webhook retries in Stripe handler and run unit tests.'
        : 'Also verify signature check and clean up error status.'
    }
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 'bench-claude',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'checking webhook idempotency store '.repeat(90) },
        { type: 'tool_use', id: `t_${i}`, name: i % 3 === 0 ? 'Edit' : 'Read', input: { file_path: `src/webhooks/stripe_${i % 3}.ts` } },
        { type: 'text', text: i === 17 ? 'Added Redis event ID deduplication with a 24h TTL and verified all 42 webhook tests pass.\nNext steps:\n- Set STRIPE_WEBHOOK_SECRET in staging' : 'I will check the handler file next.' }
      ]
    }
  }),
  JSON.stringify({
    type: 'user',
    sessionId: 'bench-claude',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t_${i}`, content: 'export async function handleStripe() { return true; }\n'.repeat(35) }]
    }
  })
]).flat().join('\n');

// 2. Git diff with huge lockfile + small real source change
const gitDiffWithLock = [
  'diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml',
  'index 1122334..9988776 100644',
  '--- a/pnpm-lock.yaml',
  '+++ b/pnpm-lock.yaml',
  ...Array.from({ length: 450 }, (_, i) => `+  /pkg-${i}@1.2.${i}: { resolution: { integrity: sha512-${'a'.repeat(64)} } }`),
  'diff --git a/src/auth.ts b/src/auth.ts',
  'index 4455667..7788990 100644',
  '--- a/src/auth.ts',
  '+++ b/src/auth.ts',
  '@@ -12,3 +12,4 @@',
  '-  return token;',
  '+  if (isExpired(token)) throw new Error("Token expired");',
  '+  return token;'
].join('\n');

// 3. Test suite with 180 passing tests and 1 failure + Express stack trace
const testRunLog = [
  ...Array.from({ length: 180 }, (_, i) => `  ✓ should validate schema case #${i + 1} (2ms)`),
  '  ✖ should reject expired JWT on /api/orders (11ms)',
  '    TypeError: Cannot read properties of undefined (reading "exp")',
  '      at verifyJwt (/repo/src/middleware/jwt.ts:29:14)',
  ...Array.from({ length: 24 }, (_, i) => `      at Layer.handle (/repo/node_modules/express/lib/router/layer.js:${80 + i}:5)`)
].join('\n');

// 4. Bloated API JSON + SVG/Tailwind HTML dump
const apiAndDomDump = JSON.stringify({
  ok: false,
  code: 401,
  error: '401 Unauthorized: invalid_api_key',
  records: Array.from({ length: 120 }, (_, i) => ({
    id: `rec_${i}`,
    html: `<div class="${'flex items-center justify-between px-4 py-2 text-sm font-medium '.repeat(4)}"><svg viewBox="0 0 24 24">${'<path d="M0 0h24v24H0z"/>'.repeat(20)}</svg>Item ${i}</div>`,
    nullCol: null
  }))
}, null, 2);

const cases = [
  {
    name: '18-turn Claude .jsonl session (read_chat)',
    raw: claudeTranscript,
    out: renderDigest(summarizeChat(readSession({ rawChatText: claudeTranscript })), ui)
  },
  {
    name: 'Cross-agent handoff brief (handoff:true)',
    raw: claudeTranscript,
    out: renderDigest(summarizeChat(readSession({ rawChatText: claudeTranscript }), { maxTokens: 160, audience: 'developer' }), ui)
  },
  {
    name: 'Git diff w/ pnpm-lock.yaml + code (slim)',
    raw: gitDiffWithLock,
    out: renderDigest(summarizeOutput(gitDiffWithLock), ui)
  },
  {
    name: '180 passing tests + 1 failure stack (slim)',
    raw: testRunLog,
    out: renderDigest(summarizeOutput(testRunLog), ui)
  },
  {
    name: '120-row JSON + SVG/Tailwind DOM dump (slim)',
    raw: apiAndDomDump,
    out: renderDigest(summarizeOutput(apiAndDomDump), ui)
  }
];

const schemaTokens = countTokens(JSON.stringify(TOOLS));
console.log(`MCP tools/list schema footprint: ${schemaTokens} tokens (${TOOLS.length} tools)\n`);

let totalRaw = 0;
let totalOut = 0;

for (const c of cases) {
  const before = countTokens(c.raw);
  const after = countTokens(c.out);
  const pct = (((before - after) / before) * 100).toFixed(1);
  totalRaw += before;
  totalOut += after;
  console.log(`${c.name.padEnd(44)} ${String(before).padStart(7)} -> ${String(after).padStart(4)} tok  (-${pct}%)`);
}

const totalPct = (((totalRaw - totalOut) / totalRaw) * 100).toFixed(1);
console.log('-'.repeat(72));
console.log(`${'TOTAL ACROSS ALL 5 WORKLOADS'.padEnd(44)} ${String(totalRaw).padStart(7)} -> ${String(totalOut).padStart(4)} tok  (-${totalPct}%)`);
