#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSessions, readSession, searchChats } from './chats.js';
import { countTokens, fitBudget } from './compress.js';
import { summarizeChat, summarizeOutput } from './digest.js';
import { detectUI, renderDigest } from './ui.js';

const SERVER = { name: 'clearbrief', version: '1.1.0' };
const PROTOCOLS = new Set(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

// Kept under 300 tokens total because MCP hosts send tool schemas on every turn.
export const TOOLS = [
  {
    name: 'chats',
    description: 'List or search (`q`) chats.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        src: { type: 'string' },
        n: { type: 'number' }
      }
    }
  },
  {
    name: 'read_chat',
    description: 'Human chat recap (`delta`, `handoff`).',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        delta: { type: 'boolean' },
        handoff: { type: 'boolean' },
        maxTokens: { type: 'number' }
      }
    }
  },
  {
    name: 'slim',
    description: 'Compress logs, diffs, tests, or JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        maxTokens: { type: 'number' }
      },
      required: ['text']
    }
  },
  {
    name: 'ui',
    description: 'Active UI rules and skills.',
    inputSchema: { type: 'object', properties: {} }
  }
];

const clamp = (n, min, max, fallback) => Math.min(max, Math.max(min, Number(n) || fallback));
const textResult = (text, isError = false) => ({
  content: [{ type: 'text', text }],
  ...(isError ? { isError: true } : {})
});

export function createServer(opts = {}) {
  const env = opts.env || process.env;
  let clientInfo = null;

  const activeUI = (mode = 'auto') => detectUI(clientInfo, env, mode === 'auto' ? '' : mode);

  const handlers = {
    chats(args = {}) {
      const q = (args.q ?? args.query ?? '').trim();
      const source = args.src || args.source || 'all';
      const workspace = args.dir || args.workspace || '';
      const limit = clamp(args.n ?? args.limit ?? args.maxResults, 1, 25, 8);

      if (q) {
        const hits = searchChats(q, { source, workspace, maxResults: limit, env });
        if (!hits.length) return textResult(`No matches for "${q}".`);
        const lines = [`Matches (${hits.length}) for "${q}":`];
        for (const h of hits) {
          const proj = h.cwd ? path.basename(h.cwd) : h.platform;
          lines.push(`- [${h.platform}:${proj}:${h.sessionId.slice(0, 10)}] ${h.speaker}: ${h.snippet}`);
        }
        return textResult(lines.join('\n'));
      }

      const sessions = listSessions({ source, workspace, limit, env });
      if (!sessions.length) return textResult('No local Claude or Codex chats found.');

      const lines = [`Chats (${sessions.length}):`];
      for (const s of sessions) {
        const kb = Math.max(1, Math.round(s.sizeBytes / 1024));
        const proj = s.cwd ? path.basename(s.cwd) : 'general';
        lines.push(`- ${s.platform} \`${s.sessionId.slice(0, 14)}\` (${proj}, ${kb}KB) "${s.firstUserPrompt}"`);
      }
      return textResult(lines.join('\n'));
    },

    read_chat(args = {}) {
      const isHandoff = Boolean(args.handoff);
      const ui = activeUI(args.ui || args.interfaceMode);
      const chat = readSession({
        sessionTarget: args.target || args.sessionTarget || 'latest',
        rawChatText: args.raw || args.rawChatText || '',
        source: args.src || args.source || args.fromSource || 'all',
        workspace: args.dir || args.workspace || '',
        delta: Boolean(args.delta),
        env
      });

      const ceiling = isHandoff ? 180 : clamp(args.maxTokens, 90, 1500, 260);
      const digest = summarizeChat(chat, {
        maxTokens: ceiling,
        audience: args.tone || args.audience || (isHandoff ? 'developer' : 'everyday'),
        focusQuery: args.focus || args.focusQuery || ''
      });
      if (isHandoff) digest.title = `Handoff (${chat.platform || 'none'}->${ui.id})`;

      const rendered = renderDigest(digest, ui, { showMetrics: true, showSkills: Boolean(args.showSkills) });
      return textResult(isHandoff ? fitBudget(rendered, 180) : rendered);
    },

    slim(args = {}) {
      const raw = args.text ?? args.rawText;
      if (raw === undefined || raw === null) return textResult('`text` is required.', true);

      const ui = activeUI(args.ui || args.interfaceMode);
      const digest = summarizeOutput(String(raw), {
        maxTokens: clamp(args.maxTokens, 70, 1500, 220),
        audience: args.tone || args.audience || 'everyday'
      });
      return textResult(renderDigest(digest, ui, { showMetrics: true }));
    },

    ui(args = {}) {
      const p = activeUI(args.mode || args.interfaceMode);
      return textResult([
        `UI: ${p.label} (\`${p.id}\`, ${p.width} cols)`,
        `Skills: ${p.skills.map((s) => `\`${s.trigger}\``).join(', ')}`,
        ...p.rules.map((r) => `- ${r}`)
      ].join('\n'));
    }
  };

  // Backward-compatible aliases so existing prompts/skills work with zero extra schema cost.
  handlers.list_chat_sessions = (a) => handlers.chats(a);
  handlers.search_chat_memory = (a = {}) => {
    if (!String(a.q ?? a.query ?? '').trim()) return textResult('`query` is required.', true);
    return handlers.chats(a);
  };
  handlers.read_and_humanize_chat = (a) => handlers.read_chat({ ...a, showSkills: true });
  handlers.session_handoff_brief = (a) => handlers.read_chat({ ...a, handoff: true });
  handlers.compress_and_humanize_output = (a) => handlers.slim(a);
  handlers.get_interface_skill_profile = (a) => handlers.ui(a);

  function callTool(name, args = {}) {
    const fn = handlers[name];
    return fn ? fn(args) : textResult(`Unknown tool: ${name}`, true);
  }

  const rpcMethods = {
    initialize(params = {}) {
      clientInfo = params.clientInfo || null;
      const requested = params.protocolVersion || '2024-11-05';
      const p = activeUI();
      return {
        protocolVersion: PROTOCOLS.has(requested) ? requested : '2024-11-05',
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false }
        },
        serverInfo: SERVER,
        instructions: `ClearBrief (${p.label}): reply in plain English; use read_chat & slim to cut tokens.`
      };
    },

    ping: () => ({}),
    'tools/list': () => ({ tools: TOOLS }),
    'tools/call': (params = {}) => callTool(params.name, params.arguments || {}),

    'resources/list': () => ({
      resources: [
        { uri: 'clearbrief://ui', name: 'Active UI Profile', mimeType: 'application/json' },
        { uri: 'clearbrief://latest', name: 'Latest Chat Summary', mimeType: 'text/markdown' }
      ]
    }),

    'resources/read'(params = {}) {
      const p = activeUI();
      if (params.uri === 'clearbrief://ui' || params.uri === 'clearbrief://interface/profile') {
        return { contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(p) }] };
      }
      if (params.uri === 'clearbrief://latest' || params.uri === 'clearbrief://chats/latest-digest') {
        const chat = readSession({ sessionTarget: 'latest', env });
        const text = renderDigest(summarizeChat(chat, { maxTokens: 240 }), p);
        return { contents: [{ uri: params.uri, mimeType: 'text/markdown', text }] };
      }
      const err = new Error(`Unknown resource: ${params.uri}`);
      err.code = -32602;
      throw err;
    },

    'prompts/list'() {
      const p = activeUI();
      return {
        prompts: [
          { name: 'humanize-chat', description: `Plain-English recap of latest chat (${p.label}).` },
          { name: 'token-diet', description: `Low-token plain-English mode (${p.label}).` }
        ]
      };
    },

    'prompts/get'(params = {}) {
      const p = activeUI();
      if (params.name === 'humanize-chat' || params.name === 'humanize-latest-chat') {
        return {
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Call read_chat (target="latest") and explain it briefly for ${p.label}.` }
          }]
        };
      }
      if (params.name === 'token-diet' || params.name === 'token-diet-mode') {
        return {
          messages: [{
            role: 'user',
            content: { type: 'text', text: `Enable Token Diet (${p.label}): pass noisy outputs through slim; ${p.rules.join(' ')}` }
          }]
        };
      }
      const err = new Error(`Unknown prompt: ${params.name}`);
      err.code = -32602;
      throw err;
    }
  };

  function handleRpc(msg) {
    if (!msg || typeof msg !== 'object') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }

    const { id, method, params } = msg;
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;

    const handler = rpcMethods[method];
    if (!handler) {
      return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    }

    try {
      const result = handler(params);
      return id === undefined ? null : { jsonrpc: '2.0', id, result };
    } catch (err) {
      return id === undefined ? null : {
        jsonrpc: '2.0',
        id,
        error: { code: err.code || -32603, message: err instanceof Error ? err.message : String(err) }
      };
    }
  }

  return { handleRpc, callTool, activeUI, countTokens };
}

export function runStdio() {
  const server = createServer();
  let buf = Buffer.alloc(0);
  let framed = false;

  function send(payload) {
    if (!payload) return;
    const json = JSON.stringify(payload);
    if (framed) {
      process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      process.stdout.write(`${json}\n`);
    }
  }

  function dispatch(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    if (Array.isArray(parsed)) {
      const replies = parsed.map((m) => server.handleRpc(m)).filter(Boolean);
      if (replies.length) send(replies);
    } else {
      send(server.handleRpc(parsed));
    }
  }

  function drain() {
    while (buf.length > 0) {
      if (/^Content-Length:/i.test(buf.subarray(0, Math.min(buf.length, 32)).toString('utf8'))) {
        framed = true;
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const m = buf.subarray(0, end).toString('utf8').match(/Content-Length:\s*(\d+)/i);
        if (!m) {
          buf = buf.subarray(end + 4);
          continue;
        }
        const len = Number(m[1]);
        if (buf.length < end + 4 + len) return;
        const body = buf.subarray(end + 4, end + 4 + len).toString('utf8');
        buf = buf.subarray(end + 4 + len);
        dispatch(body);
        continue;
      }

      const nl = buf.indexOf(0x0a);
      if (nl === -1) return;
      const line = buf.subarray(0, nl).toString('utf8').trim();
      buf = buf.subarray(nl + 1);
      if (line) dispatch(line);
    }
  }

  process.stdin.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    drain();
  });

  process.stdin.on('error', (err) => {
    process.stderr.write(`[clearbrief] stdin error: ${err.message}\n`);
  });
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  runStdio();
}
