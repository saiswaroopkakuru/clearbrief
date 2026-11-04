import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countTokens, stripNoise } from './compress.js';

const WRAPPER_TAG_RE =
  /<(?:environment_context|permissions instructions|user_instructions|system-reminder|command-message)>[\s\S]*?<\/(?:environment_context|permissions instructions|user_instructions|system-reminder|command-message)>/gi;

// Tracks byte offsets per transcript path so delta reads only parse newly appended lines.
const deltaOffsets = new Map();

export function resetDeltaCache() {
  deltaOffsets.clear();
}

export function cleanTurnText(text) {
  if (!text) return '';
  return stripNoise(String(text).replace(WRAPPER_TAG_RE, '')).trim();
}

function normPath(p) {
  return p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : '';
}

function findJsonlFiles(dir, maxDepth = 5, depth = 0) {
  if (!dir || depth > maxDepth) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findJsonlFiles(full, maxDepth, depth + 1));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== 'history.jsonl') {
      try {
        const st = fs.statSync(full);
        if (st.size > 0) {
          found.push({
            filePath: full,
            sizeBytes: st.size,
            mtimeMs: st.mtimeMs,
            updatedAt: new Date(st.mtimeMs).toISOString()
          });
        }
      } catch {}
    }
  }
  return found;
}

export function storageDirs(env = process.env) {
  const home = os.homedir();
  const claudeRoot = env?.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const codexRoot = env?.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const extra = (env?.CLEARBRIEF_EXTRA_CHAT_DIRS || '')
    .split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean);

  return {
    claude: path.join(claudeRoot, 'projects'),
    codexSessions: path.join(codexRoot, 'sessions'),
    codexArchive: path.join(codexRoot, 'archived_sessions'),
    extra
  };
}

function readHead(filePath, maxBytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const chunk = buf.toString('utf8', 0, n);
    if (n === maxBytes) {
      const nl = chunk.lastIndexOf('\n');
      if (nl > 0) return chunk.slice(0, nl);
    }
    return chunk;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function parseCodexRecord(rec, ts) {
  const p = rec.payload;
  if (!p) return [];

  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    let raw = '';
    if (typeof p.content === 'string') {
      raw = p.content;
    } else if (Array.isArray(p.content)) {
      raw = p.content.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
    }
    const text = cleanTurnText(raw);
    return text ? [{ kind: p.role, text, timestamp: ts }] : [];
  }

  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    let input = p.arguments ?? p.input ?? {};
    if (typeof input === 'string') {
      try { input = JSON.parse(input); } catch { input = { raw: input }; }
    }
    return [{ kind: 'tool_call', name: p.name || 'tool', input, callId: p.call_id || p.id || '', timestamp: ts }];
  }

  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const rawOut = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '');
    const sample = rawOut.slice(0, 1000);
    return [{
      kind: 'tool_result',
      callId: p.call_id || '',
      output: sample,
      isError: /\b(?:error|exception|failed|exit code [1-9])\b/i.test(sample),
      timestamp: ts
    }];
  }

  return [];
}

function parseClaudeRecord(msg, ts) {
  if (typeof msg.content === 'string') {
    const text = cleanTurnText(msg.content);
    return text ? [{ kind: msg.role, text, timestamp: ts }] : [];
  }
  if (!Array.isArray(msg.content)) return [];

  const events = [];
  const texts = [];

  for (const b of msg.content) {
    if (!b || typeof b !== 'object') continue;
    if ((b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') && b.text) {
      texts.push(b.text);
    } else if (b.type === 'tool_use') {
      events.push({ kind: 'tool_call', name: b.name || 'tool', input: b.input || {}, callId: b.id || '', timestamp: ts });
    } else if (b.type === 'tool_result') {
      const rawOut = typeof b.content === 'string'
        ? b.content
        : Array.isArray(b.content)
          ? b.content.map((c) => c?.text || JSON.stringify(c)).join('\n')
          : JSON.stringify(b.content ?? '');
      const sample = rawOut.slice(0, 1000);
      events.push({
        kind: 'tool_result',
        callId: b.tool_use_id || '',
        output: sample,
        isError: Boolean(b.is_error) || /\b(?:error|exception|failed|ENOENT|EACCES)\b/i.test(sample),
        timestamp: ts
      });
    }
  }

  const text = cleanTurnText(texts.join('\n'));
  if (text) events.push({ kind: msg.role, text, timestamp: ts });
  return events;
}

export function parseRecord(rec, allowLegacyCodexEvents = false) {
  if (!rec || typeof rec !== 'object') return [];
  const ts = rec.timestamp || rec.created_at || null;

  if (rec.type === 'response_item') return parseCodexRecord(rec, ts);

  if (allowLegacyCodexEvents && rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
    const text = cleanTurnText(rec.payload.message);
    return text ? [{ kind: 'user', text, timestamp: ts }] : [];
  }

  const msg = rec.message || (rec.role && rec.content !== undefined ? rec : null);
  if (msg && (msg.role === 'user' || msg.role === 'assistant')) {
    return parseClaudeRecord(msg, ts);
  }

  if (rec.type === 'summary' && rec.summary) {
    return [{ kind: 'assistant', text: `[Prior summary] ${cleanTurnText(rec.summary)}`, timestamp: ts }];
  }

  return [];
}

function peekSession(filePath) {
  const head = readHead(filePath);
  let sessionId = '';
  let cwd = '';
  let gitBranch = '';
  let firstPrompt = '';
  let turns = 0;

  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    sessionId ||= rec.sessionId || rec.payload?.id || rec.id || '';
    cwd ||= rec.cwd || rec.payload?.cwd || '';
    gitBranch ||= rec.gitBranch || rec.payload?.git?.branch || '';

    for (const ev of parseRecord(rec)) {
      if (ev.kind === 'user' || ev.kind === 'assistant') turns++;
      if (!firstPrompt && ev.kind === 'user' && ev.text) {
        firstPrompt = ev.text.replace(/\s+/g, ' ').slice(0, 110);
      }
    }
  }

  return {
    sessionId: sessionId || path.basename(filePath, '.jsonl'),
    cwd,
    gitBranch,
    firstPrompt,
    turns
  };
}

export function listSessions(opts = {}) {
  const { source = 'all', workspace = '', limit = 15, env = process.env } = opts;
  const dirs = storageDirs(env);
  const files = [];

  if (source === 'all' || source === 'claude') {
    for (const f of findJsonlFiles(dirs.claude, 4)) files.push({ ...f, platform: 'claude' });
  }
  if (source === 'all' || source === 'codex') {
    for (const f of findJsonlFiles(dirs.codexSessions, 5)) files.push({ ...f, platform: 'codex' });
    for (const f of findJsonlFiles(dirs.codexArchive, 3)) files.push({ ...f, platform: 'codex' });
  }
  for (const dir of dirs.extra) {
    for (const f of findJsonlFiles(dir, 4)) files.push({ ...f, platform: 'custom' });
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const wsFilter = normPath(workspace);
  const out = [];

  for (const f of files) {
    const meta = peekSession(f.filePath);
    if (wsFilter) {
      const c = normPath(meta.cwd);
      if (!c || (!c.includes(wsFilter) && !wsFilter.includes(c))) continue;
    }
    out.push({
      sessionId: meta.sessionId,
      platform: f.platform,
      filePath: f.filePath,
      cwd: meta.cwd || null,
      gitBranch: meta.gitBranch || null,
      updatedAt: f.updatedAt,
      sizeBytes: f.sizeBytes,
      firstUserPrompt: meta.firstPrompt || '(no prompt)',
      turns: meta.turns
    });
    if (out.length >= limit) break;
  }

  return out;
}

function parsePlainChat(raw) {
  const speakerRe = /^(?:###?\s*)?(User|Human|You|Assistant|Claude|Codex|Agent)\s*:\s*/gim;
  const matches = [...raw.matchAll(speakerRe)];
  if (!matches.length) {
    const text = cleanTurnText(raw);
    return text ? [{ kind: 'assistant', text, timestamp: null }] : [];
  }

  const events = [];
  for (let i = 0; i < matches.length; i++) {
    const who = matches[i][1].toLowerCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    const text = cleanTurnText(raw.slice(start, end));
    if (!text) continue;
    const kind = who === 'user' || who === 'human' || who === 'you' ? 'user' : 'assistant';
    events.push({ kind, text, timestamp: null });
  }
  return events;
}

function parseChatBuffer(raw, meta) {
  const rawTokens = meta.fullRawTokens ?? countTokens(raw);
  const trimmed = raw.trim();
  let cwd = meta.cwd || null;
  let gitBranch = meta.gitBranch || null;
  let sessionId = meta.sessionId || 'chat-session';

  if (!trimmed) {
    return {
      found: true,
      noNewTurns: Boolean(meta.isDelta),
      sessionId,
      platform: meta.platform || 'custom',
      filePath: meta.filePath || null,
      cwd,
      gitBranch,
      rawTokens,
      events: []
    };
  }

  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && !trimmed.includes('\n{'))) {
    try {
      const data = JSON.parse(trimmed);
      const list = Array.isArray(data) ? data : data.messages || [data];
      const events = list.flatMap((r) => parseRecord(r));
      if (events.length) {
        return { found: true, sessionId, platform: meta.platform || 'json', filePath: meta.filePath || null, cwd, gitBranch, rawTokens, events };
      }
    } catch {}
  }

  const lines = trimmed.split('\n');
  let jsonCount = 0;
  let events = [];

  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const rec = JSON.parse(l);
      jsonCount++;
      cwd ||= rec.cwd || rec.payload?.cwd || null;
      gitBranch ||= rec.gitBranch || rec.payload?.git?.branch || null;
      if (sessionId === 'chat-session') sessionId = rec.sessionId || rec.payload?.id || sessionId;
      events.push(...parseRecord(rec));
    } catch {}
  }

  if (jsonCount > 0 && !events.length) {
    for (const line of lines) {
      try { events.push(...parseRecord(JSON.parse(line.trim()), true)); } catch {}
    }
  } else if (jsonCount === 0) {
    events = parsePlainChat(raw);
  }

  return {
    found: true,
    isDelta: Boolean(meta.isDelta),
    sessionId,
    platform: meta.platform || 'custom',
    filePath: meta.filePath || null,
    cwd,
    gitBranch,
    rawTokens,
    events
  };
}

export function readSession(opts = {}) {
  const {
    sessionTarget = 'latest',
    rawChatText = '',
    source = 'all',
    workspace = '',
    delta = false,
    env = process.env
  } = opts;

  if (rawChatText?.trim()) {
    return parseChatBuffer(rawChatText, {
      sessionId: 'inline-chat',
      platform: source === 'all' ? 'inline' : source,
      filePath: null
    });
  }

  let target = null;
  if (sessionTarget && sessionTarget !== 'latest' && fs.existsSync(sessionTarget)) {
    const platform = sessionTarget.includes('.codex') ? 'codex' : sessionTarget.includes('.claude') ? 'claude' : 'custom';
    target = {
      sessionId: path.basename(sessionTarget, path.extname(sessionTarget)),
      platform,
      filePath: path.resolve(sessionTarget)
    };
  } else {
    const sessions = listSessions({ source, workspace, limit: 50, env });
    if (!sessions.length) {
      return { found: false, reason: 'No local Claude or Codex chat transcripts found.', events: [], rawTokens: 0 };
    }
    if (!sessionTarget || sessionTarget === 'latest') {
      target = sessions[0];
    } else {
      const q = sessionTarget.toLowerCase();
      target =
        sessions.find((s) => s.sessionId.toLowerCase() === q) ||
        sessions.find((s) => s.sessionId.toLowerCase().includes(q) || s.filePath.toLowerCase().includes(q));
      if (!target) {
        return { found: false, reason: `No session matched "${sessionTarget}".`, events: [], rawTokens: 0 };
      }
    }
  }

  const stat = fs.statSync(target.filePath);
  const prevOffset = delta ? (deltaOffsets.get(target.filePath) || 0) : 0;

  if (delta && prevOffset >= stat.size) {
    return {
      found: true,
      noNewTurns: true,
      isDelta: true,
      sessionId: target.sessionId,
      platform: target.platform,
      filePath: target.filePath,
      cwd: target.cwd || null,
      gitBranch: target.gitBranch || null,
      rawTokens: Math.ceil(stat.size / 4),
      events: []
    };
  }

  let sliceText;
  if (delta && prevOffset > 0 && prevOffset < stat.size) {
    const fd = fs.openSync(target.filePath, 'r');
    const len = stat.size - prevOffset;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, prevOffset);
    fs.closeSync(fd);
    sliceText = buf.toString('utf8');
  } else {
    sliceText = fs.readFileSync(target.filePath, 'utf8');
  }

  deltaOffsets.set(target.filePath, stat.size);

  return parseChatBuffer(sliceText, {
    ...target,
    isDelta: delta && prevOffset > 0,
    fullRawTokens: Math.ceil(stat.size / 4)
  });
}

export function searchChats(query, opts = {}) {
  const { source = 'all', workspace = '', maxResults = 6, env = process.env } = opts;
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return [];

  const sessions = listSessions({ source, workspace, limit: 35, env });
  const hits = [];

  for (const s of sessions) {
    const chat = readSession({ sessionTarget: s.filePath, env });
    if (!chat.found) continue;

    for (const ev of chat.events) {
      if (ev.kind !== 'user' && ev.kind !== 'assistant') continue;
      const idx = ev.text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;

      const start = Math.max(0, idx - 60);
      const end = Math.min(ev.text.length, idx + needle.length + 100);
      const snippet =
        (start > 0 ? '…' : '') +
        ev.text.slice(start, end).replace(/\s+/g, ' ').trim() +
        (end < ev.text.length ? '…' : '');

      hits.push({
        sessionId: s.sessionId,
        platform: s.platform,
        updatedAt: s.updatedAt,
        cwd: s.cwd,
        speaker: ev.kind === 'user' ? 'You' : 'Agent',
        snippet
      });

      if (hits.length >= maxResults) return hits;
      break;
    }
  }

  return hits;
}
