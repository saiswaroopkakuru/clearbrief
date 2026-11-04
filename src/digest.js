import path from 'node:path';
import { compress, countTokens, fitBudget } from './compress.js';

const FILLER_RE = [
  /^(?:certainly|absolutely|of course|sure thing|great question)[!,.]\s*/gim,
  /\b(?:let(?:'s| me) delve into|in order to accomplish this task|it is important to note that|as an ai language model)\b[:,]?\s*/gi,
  /^(?:i will now proceed to|i am going to go ahead and)\s+/gim,
  /\b(?:please let me know if you have any further questions or need additional assistance\.?)\s*$/gim
];

const ERROR_HINTS = [
  [/EADDRINUSE(?:.*?:(\d{2,5}))?/i, (m) => `Port ${m[1] || 'for server'} is already in use — stop the other process or switch ports.`],
  [/ENOENT:\s*no such file or directory,?\s*(?:open|stat|scandir|access)?\s*['"]?([^'"\n]+)['"]?/i, (m) => `Missing path: "${shortPath(m[1])}".`],
  [/EACCES|EPERM:\s*operation not permitted/i, () => 'Permission blocked by OS or sandbox (locked file or missing access).'],
  [/MODULE_NOT_FOUND|Cannot find module\s+['"]([^'"]+)['"]|ModuleNotFoundError:\s*No module named\s+['"]([^'"]+)['"]/i, (m) => `Missing package "${m[1] || m[2] || 'dependency'}" — install dependencies or check imports.`],
  [/SyntaxError:\s*([^\n]+)/i, (m) => `Syntax error: ${m[1].trim()}.`],
  [/TypeError:\s*Cannot read propert(?:y|ies) of (undefined|null)\s*\(reading ['"]([^'"]+)['"]\)/i, (m) => `Tried to read ".${m[2]}" on ${m[1]}.`],
  [/TS(\d{4}):\s*([^\n]+)/, (m) => `TS${m[1]}: ${m[2].trim()}`],
  [/CORS policy|Access-Control-Allow-Origin/i, () => 'Blocked by CORS — allow frontend origin on backend.'],
  [/401\s+Unauthorized|invalid_api_key|authentication failed/i, () => 'Auth failed (401) — check API key or token.'],
  [/429\s+Too Many Requests|rate[ _-]?limit/i, () => 'Rate limited (429) — back off and retry.']
];

function shortPath(p) {
  if (!p) return '';
  const segs = String(p).trim().replace(/\\/g, '/').split('/').filter(Boolean);
  return segs.length <= 2 ? segs.join('/') : segs.slice(-2).join('/');
}

export function stripFiller(text) {
  if (!text) return '';
  let out = String(text);
  for (const re of FILLER_RE) out = out.replace(re, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export function explainErrors(text) {
  if (!text) return [];
  const out = [];
  const seen = new Set();

  for (const [re, format] of ERROR_HINTS) {
    const m = text.match(re);
    if (!m) continue;
    const msg = format(m);
    if (!seen.has(msg)) {
      seen.add(msg);
      out.push(msg);
    }
  }

  if (!out.length) {
    const fail = text.split('\n').map((l) => l.trim()).find((l) => /^(?:FAIL|ERROR|Exception|Fatal)\b[:\s]/i.test(l));
    if (fail) out.push(fail.slice(0, 130));
  }
  return out;
}

function inspectTool(call) {
  const name = (call.name || '').toLowerCase();
  const input = call.input || {};

  if (name === 'apply_patch') {
    const raw = typeof input === 'string' ? input : input.patch || input.raw || JSON.stringify(input);
    const files = [];
    for (const m of raw.matchAll(/\*\*\*\s+(Add|Update|Delete)\s+File:\s*([^\r\n]+)/gi)) {
      const verb = m[1].toLowerCase();
      files.push({
        file: shortPath(m[2]),
        action: verb === 'add' ? 'added' : verb === 'delete' ? 'deleted' : 'updated'
      });
    }
    return { type: 'edit', files };
  }

  const file = shortPath(input.file_path || input.path || input.filepath || input.target_file || input.notebook_path || '');
  if (['write', 'write_file', 'create_file'].includes(name)) {
    return { type: 'edit', files: file ? [{ file, action: 'wrote' }] : [] };
  }
  if (['edit', 'multiedit', 'edit_file', 'replace_in_file', 'notebookedit'].includes(name)) {
    return { type: 'edit', files: file ? [{ file, action: 'edited' }] : [] };
  }
  if (['read', 'view', 'read_file', 'cat', 'glob', 'globtool', 'grep', 'greptool', 'ls', 'list_dir'].includes(name)) {
    return { type: 'read', file };
  }
  if (['bash', 'shell', 'exec_command', 'run_command', 'terminal'].includes(name)) {
    const cmd = Array.isArray(input.command) ? input.command.join(' ') : input.command || input.cmd || input.raw || '';
    return { type: 'cmd', cmd: String(cmd).trim() };
  }
  return { type: 'other' };
}

function summarizeCommands(cmds) {
  if (!cmds.length) return '';
  const tags = new Set();
  for (const c of cmds) {
    if (/\b(?:test|pytest|vitest|jest|cargo test|go test|node --test)\b/i.test(c)) tags.add('tests');
    else if (/\b(?:npm|pnpm|yarn|bun|pip|uv|cargo)\s+(?:install|add|i)\b/i.test(c)) tags.add('install');
    else if (/\b(?:build|tsc|vite build|next build|cargo build)\b/i.test(c)) tags.add('build');
    else if (/\bgit\s+(?:status|diff|log|commit|branch|checkout)\b/i.test(c)) tags.add('git');
    else if (/\b(?:lint|eslint|prettier|ruff)\b/i.test(c)) tags.add('lint');
    else tags.add('shell');
  }
  return `Ran ${cmds.length} cmd${cmds.length === 1 ? '' : 's'} (${[...tags].join(', ')}).`;
}

function pickSummaryLine(text, maxLen = 165) {
  const clean = stripFiller(text).replace(/```[\s\S]*?```/g, '').replace(/^#{1,6}\s+/gm, '').trim();
  if (!clean) return '';

  const lines = clean
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter((l) => l.length > 15 && !/^(?:i(?:'ll| will) (?:check|read|look|inspect|open|search))\b/i.test(l));

  const line = (lines[0] || clean.split('\n')[0] || '').replace(/\s+/g, ' ').trim();
  return line.length <= maxLen ? line : `${line.slice(0, maxLen - 1).trimEnd()}…`;
}

export function summarizeChat(chat, opts = {}) {
  const { maxTokens = 260, audience = 'everyday', focusQuery = '' } = opts;

  if (!chat?.found) {
    return {
      title: 'No Chat',
      headline: chat?.reason || 'No matching transcript.',
      goals: [],
      bullets: [],
      files: [],
      issues: [],
      next: [],
      metrics: { rawTokens: 0, finalTokens: 12, savedTokens: 0, savedPercent: 0 }
    };
  }

  if (chat.noNewTurns) {
    return {
      title: `Delta — ${chat.sessionId}`,
      headline: 'No new turns since last read.',
      goals: [],
      bullets: [],
      files: [],
      issues: [],
      next: [],
      metrics: { rawTokens: chat.rawTokens || 0, finalTokens: 10, savedTokens: Math.max(0, (chat.rawTokens || 0) - 10), savedPercent: 99.5 }
    };
  }

  const prompts = [];
  const replies = [];
  const edited = new Map();
  const cmds = [];
  const errorBlobs = [];
  let reads = 0;
  let openErrors = 0;

  for (const ev of chat.events) {
    if (ev.kind === 'user') {
      const t = ev.text.replace(/\s+/g, ' ').trim();
      if (t) prompts.push(t.length > 120 ? `${t.slice(0, 119)}…` : t);
    } else if (ev.kind === 'assistant') {
      replies.push(ev.text);
      if (/\b(?:all tests pass|fixed|resolved|working now|build succeeded|0 errors)\b/i.test(ev.text)) {
        openErrors = 0;
      }
    } else if (ev.kind === 'tool_call') {
      const info = inspectTool(ev);
      if (info.type === 'edit') {
        for (const f of info.files) edited.set(f.file, f.action);
      } else if (info.type === 'read') {
        reads++;
      } else if (info.type === 'cmd' && info.cmd) {
        cmds.push(info.cmd);
      }
    } else if (ev.kind === 'tool_result' && ev.isError) {
      openErrors++;
      errorBlobs.push(ev.output.slice(0, 600));
    }
  }

  const goals = [];
  if (prompts.length) goals.push(prompts[0]);
  if (prompts.length > 1 && prompts.at(-1) !== prompts[0]) {
    goals.push(prompts.length > 2 ? `(+${prompts.length - 2} turns) Latest: ${prompts.at(-1)}` : `Latest: ${prompts.at(-1)}`);
  }

  const lastReply = replies.at(-1) || '';
  const headline =
    pickSummaryLine(lastReply, 155) ||
    (edited.size
      ? `Updated ${edited.size} file(s) for "${prompts[0] || 'session'}".`
      : `Summarized ${chat.events.length} events (${chat.platform}).`);

  const bullets = [];
  const activity = [
    reads ? `read ${reads} file${reads === 1 ? '' : 's'}` : '',
    summarizeCommands(cmds)
  ].filter(Boolean).join('; ');
  if (activity) bullets.push(activity.replace(/^./, (c) => c.toUpperCase()));

  const pool = focusQuery
    ? replies.filter((r) => r.toLowerCase().includes(focusQuery.toLowerCase()))
    : replies.slice(0, -1); // Exclude lastReply since it already powers `headline`.

  for (const r of pool.slice(-2)) {
    const line = pickSummaryLine(r, audience === 'executive' ? 120 : 150);
    if (line && line !== headline && !bullets.includes(line)) bullets.push(line);
  }

  const issues = errorBlobs.length
    ? explainErrors(errorBlobs.join('\n')).slice(0, 2).map((m) => `${openErrors > 0 ? '[Open]' : '[Fixed]'} ${m}`)
    : [];

  const next = [];
  const nextMatch = lastReply.match(/(?:next steps?|to test|try running|you can now)[:\s]*([\s\S]{10,360})/i);
  if (nextMatch) {
    next.push(
      ...nextMatch[1]
        .split('\n')
        .map((l) => l.replace(/^[-*•\d.)\s]+/, '').trim())
        .filter((l) => l.length > 8 && l.length < 120)
        .slice(0, 2)
    );
  } else if (openErrors > 0) {
    next.push('Resolve open issue above and re-test.');
  }

  const files = [...edited.entries()].slice(0, 8).map(([file, action]) => ({ file, action }));
  const project = chat.cwd ? path.basename(chat.cwd) : chat.platform;
  const metaNote = [
    `${chat.sessionId} (${chat.platform})`,
    chat.gitBranch ? `branch:${chat.gitBranch}` : ''
  ].filter(Boolean).join(' · ');

  const draft = [headline, ...goals, ...bullets, ...issues, ...next].join('\n');
  const finalTokens = Math.min(maxTokens, countTokens(fitBudget(draft, maxTokens)) + 20);
  const rawTokens = Math.max(finalTokens, chat.rawTokens || countTokens(draft));
  const savedTokens = Math.max(0, rawTokens - finalTokens);
  const savedPercent = rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(1)) : 0;

  return {
    title: `${chat.isDelta ? 'Delta' : 'Chat'} — ${project}`,
    headline,
    goals,
    bullets: bullets.slice(0, 4),
    files,
    issues,
    next,
    metaNote,
    metrics: { rawTokens, finalTokens, savedTokens, savedPercent }
  };
}

export function summarizeOutput(rawText, opts = {}) {
  const { maxTokens = 220, audience = 'everyday' } = opts;
  const raw = String(rawText || '');
  const packed = compress(stripFiller(raw), Math.max(80, maxTokens - 50));
  const errors = explainErrors(raw);

  const lines = packed.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const headline =
    errors[0] ||
    lines.find((l) => !l.startsWith('{') && !l.startsWith('[') && l.length > 10)?.slice(0, 155) ||
    lines[0]?.slice(0, 155) ||
    'Empty output.';

  const refs = [
    ...new Set((raw.match(/(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,6}(?::\d+)?/g) || []).map(shortPath))
  ].slice(0, 5);

  const bullets = audience === 'executive'
    ? []
    : fitBudget(packed.text, Math.max(60, maxTokens - 80))
        .split('\n')
        .map((l) => l.replace(/^[-*•]\s*/, '').trim())
        .filter((l) => l && l !== headline)
        .slice(0, 5);

  // Avoid printing the identical error string in both headline and Issues list.
  const extraIssues = errors.filter((e) => e !== headline);

  const finalTokens = Math.min(maxTokens, packed.metrics.finalTokens + 16);
  const rawTokens = packed.metrics.rawTokens;
  const savedTokens = Math.max(0, rawTokens - finalTokens);
  const savedPercent = rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(1)) : 0;

  return {
    title: errors.length ? 'Error Summary' : 'Slim Output',
    headline,
    goals: [],
    bullets,
    files: refs.map((file) => ({ file, action: 'ref' })),
    issues: extraIssues,
    next: errors.length ? ['Fix error above and re-run.'] : [],
    metaNote: packed.text.slice(0, 320),
    metrics: { rawTokens, finalTokens, savedTokens, savedPercent }
  };
}
