import { countTokens } from './compress.js';

const SKILLS = [
  {
    name: 'humanize-chat',
    prompt: 'Summarize my latest chat in plain English',
    purpose: 'Read chats and explain what happened in plain language'
  },
  {
    name: 'token-diet',
    prompt: 'Keep replies brief and low-token',
    purpose: 'Trim verbose logs and reply with short bullets'
  },
  {
    name: 'cross-chat-handoff',
    prompt: 'Catch up from my last coding session',
    purpose: 'Carry context between Claude and Codex in <180 tokens'
  }
];

function buildSkills(prefix) {
  return SKILLS.map((s) => ({
    name: s.name,
    trigger: prefix ? `${prefix}${s.name}` : `"${s.prompt}"`,
    purpose: s.purpose
  }));
}

export const PROFILES = {
  'claude-cli': {
    id: 'claude-cli',
    label: 'Claude Code CLI',
    terminal: true,
    width: 88,
    skills: buildSkills('/clearbrief:'),
    rules: [
      'Lead with a 1-sentence plain-English outcome.',
      'Use flat single-line bullets; skip wide tables.',
      'Cite files as `path/file:line`; never paste raw JSON or stack traces.'
    ]
  },
  'claude-desktop': {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    terminal: false,
    width: 120,
    skills: buildSkills(''),
    rules: [
      'Open with `> **In plain words:**` in everyday English.',
      'Use a 2-column table when listing multiple changed files.',
      'Tuck optional metadata inside `<details>`.'
    ]
  },
  'codex-cli': {
    id: 'codex-cli',
    label: 'Codex CLI',
    terminal: true,
    width: 88,
    skills: buildSkills('$'),
    rules: [
      'Use flat sections (`Asked`, `Done`, `Next`) with short bullets.',
      'Avoid HTML tags and wide markdown tables.',
      'Summarize commands and patches by intent, not raw output.'
    ]
  },
  'codex-app': {
    id: 'codex-app',
    label: 'Codex App',
    terminal: false,
    width: 115,
    skills: buildSkills('$'),
    rules: [
      'Lead with a clear status headline.',
      'Group touched files concisely and cap follow-ups at 3 items.'
    ]
  },
  universal: {
    id: 'universal',
    label: 'MCP Host',
    terminal: true,
    width: 100,
    skills: SKILLS.map((s) => ({ name: s.name, trigger: s.name, purpose: s.purpose })),
    rules: [
      'Lead with a 1-2 sentence plain-English summary.',
      'Use short bullets instead of paragraphs or raw logs.'
    ]
  }
};

export function detectUI(clientInfo = null, env = process.env, override = '') {
  const forced = (override || env?.CLEARBRIEF_UI || '').trim().toLowerCase();
  if (forced && forced !== 'auto' && PROFILES[forced]) return PROFILES[forced];

  const name = (clientInfo?.name || '').toLowerCase();
  if (name.includes('claude-code') || name === 'claudecode' || name.includes('claude_code')) {
    return PROFILES['claude-cli'];
  }
  if (name.includes('claude')) return PROFILES['claude-desktop'];
  if (name.includes('codex-app') || name.includes('codex desktop') || name.includes('codex-ide')) {
    return PROFILES['codex-app'];
  }
  if (name.includes('codex')) return PROFILES['codex-cli'];

  if (env?.CLAUDECODE || env?.CLAUDE_CODE || env?.CLAUDE_PLUGIN_ROOT) return PROFILES['claude-cli'];
  if (env?.CODEX_APP || env?.CODEX_GUI) return PROFILES['codex-app'];
  if (env?.CODEX_CI || env?.CODEX_SANDBOX || env?.CODEX_HOME || env?.CODEX_THREAD_ID) {
    return PROFILES['codex-cli'];
  }

  return PROFILES.universal;
}

export function renderDigest(digest, ui = PROFILES.universal, opts = {}) {
  const { showMetrics = true, showSkills = false } = opts;
  const out = [];

  if (ui.terminal) {
    out.push(`[${digest.title || 'Summary'}] ${digest.headline || ''}`.trim());
  } else {
    out.push(`### ${digest.title || 'Summary'}`);
    if (digest.headline) out.push(`> **In plain words:** ${digest.headline}`);
  }

  const addList = (heading, items) => {
    if (!items?.length) return;
    if (!ui.terminal) out.push('');
    out.push(ui.terminal ? `${heading}:` : `#### ${heading}`);
    for (const item of items) out.push(`- ${item}`);
  };

  addList('Asked', digest.goals);
  addList('Done', digest.bullets);

  if (digest.files?.length) {
    if (!ui.terminal && digest.files.length >= 2) {
      out.push('', '#### Files', '| File | Change |', '| :--- | :--- |');
      for (const f of digest.files) out.push(`| \`${f.file}\` | ${f.action} |`);
    } else {
      out.push(`Files: ${digest.files.map((f) => `${f.file} (${f.action.toLowerCase()})`).join(', ')}`);
    }
  }

  addList('Issues', digest.issues);
  addList('Next', digest.next);

  if (!ui.terminal && digest.metaNote) {
    out.push('', '<details><summary>Details</summary>', '', digest.metaNote, '</details>');
  }

  if (showSkills && ui.skills?.length) {
    out.push(`Skills: ${ui.skills.map((s) => `\`${s.trigger}\``).join(', ')}`);
  }

  const body = out.join('\n').trim();
  if (!showMetrics || !digest.metrics) return body;

  const rawTokens = digest.metrics.rawTokens || 0;
  const finalTokens = countTokens(body) + 8;
  const saved = rawTokens > finalTokens ? Number((((rawTokens - finalTokens) / rawTokens) * 100).toFixed(1)) : 0;

  return `${body}\n[${rawTokens}->${finalTokens} tok, -${saved}%]`;
}
