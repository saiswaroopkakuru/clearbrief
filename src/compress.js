import fs from 'node:fs';
import path from 'node:path';

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const THINKING_RE = /<(?:thinking|antml:thinking|reasoning)>[\s\S]*?<\/(?:thinking|antml:thinking|reasoning)>/gi;
const DATA_URI_RE = /data:[a-zA-Z0-9/+.-]+;base64,[A-Za-z0-9+/=]{100,}/g;
const BASE64_RE = /\b[A-Za-z0-9+/]{180,}={0,2}\b/g;
const PROGRESS_RE = /^.*(?:\[[#= >-]{6,}\]|[█▉▊▋▌▍▎▏░▒▓]{5,})\s*\d{1,3}%.*$/gm;

// Web / component framework noise
const NEXT_DATA_RE = /<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>[\s\S]*?<\/script>/gi;
const SSR_STREAM_RE = /(?:self\.__next_f\.push|window\.__INITIAL_STATE__\s*=)\s*\(?[\s\S]{180,}?\)?(?:;|\n|$)/g;
const SVG_STYLE_RE = /<(svg|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LONG_ATTR_RE = /\b(class|className|style|d)=(["'])([^"']{80,})\2/gi;
const SCOPED_ATTR_RE = /\s+data-v-[0-9a-f]{6,}(?:="[^"]*")?/gi;

// Docker / BuildKit & package manager chatter
const DOCKER_LAYER_RE = /^\s*[0-9a-f]{8,16}:\s*(?:Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete|Already exists)\s*$/gim;
const SHA256_RE = /\bsha256:[0-9a-f]{64}\b/gi;
const NPM_WARN_RE = /^\s*(?:npm\s+(?:warn|notice)|warning\s+[^:\n]+:\s+deprecated)\b.*$/gim;

// ORM / SQL pool notices & huge bound parameter lists
const ORM_POOL_RE = /^\s*(?:prisma:info|sqlalchemy\.pool|hikari|pg-pool)\b.*(?:connection pool|acquired|idle|starting).*$/gim;
const SQL_PARAMS_RE = /\b(params|parameters|bindings)\s*[:=]\s*\[[^\]]{140,}\]/gi;
const SQL_IN_LIST_RE = /\bIN\s*\((?:\s*(?:\$\d+|\?|'[^']*'|\d+)\s*,){12,}\s*(?:\$\d+|\?|'[^']*'|\d+)\s*\)/gi;

const RULE_LINE_RE = /^\s*(?:[-=_─━═┄┈|+┼┬┴├┤╭╮╰╯]{8,})\s*$/gm;
const LIB_FRAME_RE = /^\s*at\s+.*(?:\bnode_modules\b|\bnode:internal\b|\binternal\/process\b|\bsite-packages\b|<anonymous>:\d+:\d+)/;
const PASS_LINE_RE = /^\s*(?:[✓✔]|PASS\b|ok\s+\d+\s+-)\s+.+$/;
const DIFF_HEADER_RE = /^diff --git a\/(\S+) b\/(\S+)/;
const GENERATED_DIFF_RE =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|composer\.lock|go\.sum|dist\/|build\/|\.next\/|coverage\/|[^/]+\.min\.(?:js|css)|[^/]+\.map|[^/]+\.snap|[^/]+\.svg)$/i;

const PRIORITY_KEYS = new Set([
  'id', 'name', 'title', 'type', 'role', 'status', 'code', 'ok',
  'error', 'errors', 'message', 'summary', 'reason', 'path', 'file',
  'line', 'command', 'exitCode', 'result', 'count', 'total'
]);

const rcCache = new Map();

export function loadRepoConfig(cwd = process.cwd()) {
  const key = path.resolve(cwd);
  if (rcCache.has(key)) return rcCache.get(key);

  let cfg = { regexes: [], ignoreGlobs: [], maxTokens: null };
  try {
    const rcPath = path.join(key, '.clearbriefrc.json');
    if (fs.existsSync(rcPath)) {
      const parsed = JSON.parse(fs.readFileSync(rcPath, 'utf8'));
      const regexes = Array.isArray(parsed.stripPatterns)
        ? parsed.stripPatterns.map((p) => new RegExp(p, 'gm'))
        : [];
      cfg = {
        regexes,
        ignoreGlobs: Array.isArray(parsed.ignorePaths) ? parsed.ignorePaths : [],
        maxTokens: Number(parsed.maxTokens) || null
      };
    }
  } catch {
    // Ignore malformed .clearbriefrc.json rather than breaking compression.
  }

  rcCache.set(key, cfg);
  return cfg;
}

export function clearRepoConfigCache() {
  rcCache.clear();
}

export function countTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let tokens = 0;
  let wordRun = 0;
  let punctRun = 0;

  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isWord =
      (c >= 48 && c <= 57) ||
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122);

    if (isWord) {
      if (punctRun > 0) {
        tokens += Math.ceil(punctRun / 2.2);
        punctRun = 0;
      }
      wordRun++;
    } else {
      if (wordRun > 0) {
        tokens += wordRun <= 4 ? 1 : Math.ceil(wordRun / 4.2);
        wordRun = 0;
      }
      if (c > 32) {
        punctRun++;
      } else if (punctRun > 0) {
        tokens += Math.ceil(punctRun / 2.2);
        punctRun = 0;
      }
    }
  }
  if (wordRun > 0) tokens += wordRun <= 4 ? 1 : Math.ceil(wordRun / 4.2);
  if (punctRun > 0) tokens += Math.ceil(punctRun / 2.2);
  return Math.max(1, tokens);
}

const DIFF_META_RE = /^(?:index |--- |\+\+\+ |(?:old|new) mode|(?:new|deleted) file mode|similarity index|rename (?:from|to)|Binary files )/;

export function slimDiff(text) {
  if (!text.includes('diff --git ')) return text;

  const lines = text.split('\n');
  const out = [];
  let skipFile = false;
  let inHunk = false;

  for (const line of lines) {
    const m = line.match(DIFF_HEADER_RE);
    if (m) {
      const target = m[2];
      inHunk = false;
      if (GENERATED_DIFF_RE.test(target)) {
        skipFile = true;
        out.push(`[diff omitted: ${target}]`);
        continue;
      }
      skipFile = false;
      out.push(line);
      continue;
    }
    if (skipFile) {
      if (line.startsWith('@@ ')) {
        inHunk = true;
        continue;
      }
      if (DIFF_META_RE.test(line) || line.startsWith('+') || line.startsWith('-') || line.startsWith('\\ ')) {
        continue;
      }
      if (inHunk && line.startsWith(' ')) continue;
      skipFile = false;
      inHunk = false;
    }
    if (/^(?:index [0-9a-f]{6,}\.\.[0-9a-f]{6,}|similarity index \d+%)/i.test(line)) continue;
    out.push(line);
  }
  return out.join('\n');
}

export function slimTests(text) {
  const lines = text.split('\n');
  const out = [];
  let passed = 0;

  for (const line of lines) {
    if (PASS_LINE_RE.test(line) && !/\b(?:fail|failed|error)\b/i.test(line)) {
      passed++;
      continue;
    }
    if (passed >= 3) {
      out.push(`[${passed} passing test lines omitted]`);
      passed = 0;
    } else if (passed > 0) {
      out.push(`PASS (${passed} check${passed === 1 ? '' : 's'})`);
      passed = 0;
    }
    out.push(line);
  }
  if (passed >= 3) out.push(`[${passed} passing test lines omitted]`);
  else if (passed > 0) out.push(`PASS (${passed} check${passed === 1 ? '' : 's'})`);

  return out.join('\n');
}

export function stripNoise(raw, cwd = process.cwd()) {
  if (!raw) return '';
  let text = String(raw).replace(/\r\n/g, '\n');

  if (text.includes('\r')) {
    text = text
      .split('\n')
      .map((l) => (l.includes('\r') ? l.slice(l.lastIndexOf('\r') + 1) : l))
      .join('\n');
  }

  text = text
    .replace(ANSI_RE, '')
    .replace(THINKING_RE, '')
    .replace(NEXT_DATA_RE, '[SSR state omitted]')
    .replace(SSR_STREAM_RE, '[SSR payload omitted]\n')
    .replace(SVG_STYLE_RE, (_, tag) => `[<${tag}> omitted]`)
    .replace(LONG_ATTR_RE, (_, attr) => `${attr}="..."`)
    .replace(SCOPED_ATTR_RE, '')
    .replace(DATA_URI_RE, (m) => `[data-uri ${(m.length / 1024).toFixed(1)}KB omitted]`)
    .replace(BASE64_RE, (m) => `[blob ${(m.length / 1024).toFixed(1)}KB omitted]`)
    .replace(DOCKER_LAYER_RE, '')
    .replace(SHA256_RE, 'sha256:…')
    .replace(ORM_POOL_RE, '')
    .replace(SQL_PARAMS_RE, (_, label) => `${label}: […truncated]`)
    .replace(SQL_IN_LIST_RE, 'IN (…items)')
    .replace(PROGRESS_RE, '')
    .replace(NPM_WARN_RE, '')
    .replace(RULE_LINE_RE, '');

  const repoCfg = loadRepoConfig(cwd);
  for (const rx of repoCfg.regexes) {
    text = text.replace(rx, '');
  }

  text = slimDiff(text);
  text = slimTests(text);

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 600) {
      let spaces = 0;
      for (let j = 0; j < line.length; j++) if (line.charCodeAt(j) === 32) spaces++;
      if (spaces / line.length < 0.04) {
        lines[i] = `${line.slice(0, 110)} ... [${line.length} chars]`;
      }
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function slimJson(val, depth = 0) {
  if (val === null || val === undefined || val === '') return undefined;
  if (typeof val === 'boolean' || typeof val === 'number') return val;

  if (typeof val === 'string') {
    const s = stripNoise(val);
    if (!s) return undefined;
    return s.length > 140 ? `${s.slice(0, 140)}…(+${s.length - 140})` : s;
  }
  if (typeof val !== 'object') return val;

  if (depth >= 3) {
    return Array.isArray(val) ? `[${val.length} items]` : `{${Object.keys(val).length} keys}`;
  }

  if (Array.isArray(val)) {
    if (!val.length) return undefined;
    const head = val.slice(0, 2).map((v) => slimJson(v, depth + 1)).filter((v) => v !== undefined);
    if (val.length > 2) head.push(`…+${val.length - 2} more (n=${val.length})`);
    return head;
  }

  const keys = Object.keys(val)
    .filter((k) => val[k] !== null && val[k] !== undefined && val[k] !== '')
    .sort((a, b) => Number(PRIORITY_KEYS.has(b)) - Number(PRIORITY_KEYS.has(a)));

  const out = {};
  let kept = 0;
  for (const k of keys) {
    if (kept >= 12) {
      out._moreKeys = keys.length - kept;
      break;
    }
    const v = slimJson(val[k], depth + 1);
    if (v !== undefined) {
      out[k] = v;
      kept++;
    }
  }
  return kept ? out : undefined;
}

export function compressJson(text) {
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.stringify(slimJson(JSON.parse(t)) ?? {});
    } catch {}
  }

  return text.replace(/```(?:json|jsonl)?\s*\n([\s\S]{160,}?)```/gi, (block, body) => {
    try {
      return '```json\n' + JSON.stringify(slimJson(JSON.parse(body.trim())) ?? {}) + '\n```';
    } catch {
      return block;
    }
  });
}

function logSignature(line) {
  return line
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, '<t>')
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<t>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/^#\d+\s+\[[^\]]+\]\s*/g, '<step> ')
    .trim();
}

export function collapseLogs(text) {
  const rawLines = text.split('\n');
  const lines = [];
  let skippedFrames = 0;

  for (const line of rawLines) {
    if (LIB_FRAME_RE.test(line)) {
      skippedFrames++;
      continue;
    }
    if (skippedFrames) {
      lines.push(`  [${skippedFrames} library frames omitted]`);
      skippedFrames = 0;
    }
    lines.push(line);
  }
  if (skippedFrames) lines.push(`  [${skippedFrames} library frames omitted]`);

  const out = [];
  let prevSig = null;
  let prevLine = '';
  let count = 0;

  const flush = () => {
    if (prevSig === null) return;
    out.push(count > 1 && prevSig ? `[x${count}] ${prevLine.trim()}` : prevLine);
  };

  for (const line of lines) {
    const sig = logSignature(line);
    if (sig && sig === prevSig) {
      count++;
    } else {
      flush();
      prevSig = sig;
      prevLine = line;
      count = 1;
    }
  }
  flush();

  return out.join('\n');
}

function lineSalience(line, idx, total) {
  const t = line.trim();
  if (!t) return 0.05;
  let s = 1;
  if (idx < 3 || idx >= total - 4) s += 3;
  if (/^(?:#{1,4}\s|[-*]\s|\d+\.\s|TL;DR:)/i.test(t)) s += 2.5;
  if (/\b(?:error|exception|fail|failed|fatal|panic|denied|timeout|fix|resolved|pass|passed)\b/i.test(t)) s += 4.5;
  if (/(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z0-9]{1,6}(?::\d+)?/.test(t)) s += 2.5;
  if (t.length > 300) s -= 0.5;
  return s;
}

export function fitBudget(text, maxTokens = 400) {
  if (!text) return '';
  if (countTokens(text) <= maxTokens) return text;

  const lines = text.split('\n');
  if (lines.length <= 2) {
    let hi = text.length;
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (countTokens(`${text.slice(0, mid)}…`) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    return `${text.slice(0, Math.max(20, lo))}…`;
  }

  const ranked = lines
    .map((line, idx) => ({
      idx,
      tokens: countTokens(line) + 1,
      score: lineSalience(line, idx, lines.length)
    }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  const keep = new Uint8Array(lines.length);
  const chosen = [];
  const gapCost = 6;
  let budget = Math.max(16, maxTokens - 12);

  for (const item of ranked) {
    const left = item.idx > 0 && keep[item.idx - 1];
    const right = item.idx + 1 < lines.length && keep[item.idx + 1];
    const extra = !left && !right ? gapCost : 0;

    if (item.tokens + extra <= budget) {
      keep[item.idx] = 1;
      chosen.push(item.idx);
      budget -= item.tokens + extra;
    }
  }

  const buildOut = () => {
    const rows = [];
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (!keep[i]) continue;
      if (last !== -1 && i - last > 2) {
        rows.push(`…[${i - last - 1} lines]`);
      } else if (last !== -1 && i - last === 2) {
        rows.push(lines[i - 1]);
      }
      rows.push(lines[i]);
      last = i;
    }
    return rows.join('\n').trim();
  };

  let joined = buildOut();
  while (chosen.length > 1 && countTokens(joined) > maxTokens) {
    keep[chosen.pop()] = 0;
    joined = buildOut();
  }
  if (countTokens(joined) > maxTokens) {
    let hi = joined.length;
    let lo = 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (countTokens(`${joined.slice(0, mid)}…`) <= maxTokens) lo = mid;
      else hi = mid - 1;
    }
    return `${joined.slice(0, Math.max(20, lo))}…`;
  }
  return joined;
}

export function compress(raw, maxTokens = 300, cwd = process.cwd()) {
  const input = String(raw || '');
  const rawTokens = countTokens(input);
  const repoCfg = loadRepoConfig(cwd);
  const ceiling = repoCfg.maxTokens ? Math.min(maxTokens, repoCfg.maxTokens) : maxTokens;

  let text = stripNoise(input, cwd);
  text = compressJson(text);
  text = collapseLogs(text);
  text = fitBudget(text, ceiling);

  const finalTokens = countTokens(text);
  const savedTokens = Math.max(0, rawTokens - finalTokens);
  const savedPercent = rawTokens > 0 ? Number(((savedTokens / rawTokens) * 100).toFixed(1)) : 0;

  return {
    text,
    metrics: { rawTokens, finalTokens, savedTokens, savedPercent }
  };
}
