#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_FILE = path.join(ROOT, 'src', 'server.js');
const RULES_TEMPLATE = path.join(ROOT, 'templates', 'RULES.md');

const REQUIRED = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.mcp.json',
  '.mcp.codex.json',
  'hooks/hooks.json',
  'src/server.js',
  'scripts/session-start.js',
  'scripts/pre-read-guard.js',
  'scripts/slim-cli.js',
  'templates/RULES.md',
  'skills/humanize-chat/SKILL.md',
  'skills/token-diet/SKILL.md',
  'skills/cross-chat-handoff/SKILL.md',
  'agents/human-translator.md'
];

function check() {
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('Missing files:', missing.join(', '));
    process.exit(1);
  }

  for (const f of REQUIRED.filter((p) => p.endsWith('.json'))) {
    JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  }

  const srv = createServer();
  const init = srv.handleRpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '1.0.0' } }
  });
  const list = srv.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

  console.log(`ok  ${init.result.serverInfo.name}@${init.result.serverInfo.version} (${ROOT})`);
  console.log(`    tools: ${list.result.tools.map((t) => t.name).join(', ')}`);
}

export function upsertRulesFile(targetFile) {
  const snippet = fs.readFileSync(RULES_TEMPLATE, 'utf8').trim();
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });

  if (!fs.existsSync(targetFile)) {
    fs.writeFileSync(targetFile, `${snippet}\n`, 'utf8');
    return 'created';
  }

  const existing = fs.readFileSync(targetFile, 'utf8');
  const markerRe = /<!-- clearbrief:start -->[\s\S]*?<!-- clearbrief:end -->/;
  if (markerRe.test(existing)) {
    fs.writeFileSync(targetFile, existing.replace(markerRe, snippet), 'utf8');
    return 'updated';
  }

  fs.writeFileSync(targetFile, `${existing.trimEnd()}\n\n${snippet}\n`, 'utf8');
  return 'appended';
}

function installRules(targetDir) {
  const dir = path.resolve(targetDir || process.cwd());
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const file = path.join(dir, name);
    const status = upsertRulesFile(file);
    console.log(`${status} ${file}`);
  }
}

function installGlobalRules() {
  const home = os.homedir();
  const claudeMd = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'CLAUDE.md');
  const codexMd = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'AGENTS.md');
  console.log(`${upsertRulesFile(claudeMd)} ${claudeMd}`);
  console.log(`${upsertRulesFile(codexMd)} ${codexMd}`);
}

function installGitAlias() {
  execFileSync('git', [
    'config',
    '--global',
    'alias.sdiff',
    'diff -- . ":(exclude)*lock*" ":(exclude)*.map" ":(exclude)dist/*" ":(exclude).next/*"'
  ]);
  console.log('configured global `git sdiff` alias (excludes lockfiles, sourcemaps, dist/, .next/)');
}

function installCodex() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const skillsDest = path.join(os.homedir(), '.agents', 'skills');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(skillsDest, { recursive: true });

  const tomlFile = path.join(codexHome, 'config.toml');
  const existing = fs.existsSync(tomlFile) ? fs.readFileSync(tomlFile, 'utf8') : '';

  if (!existing.includes('[mcp_servers.clearbrief]')) {
    const block = `\n[mcp_servers.clearbrief]\ncommand = "node"\nargs = ["${SERVER_FILE.replace(/\\/g, '/')}"]\n`;
    fs.writeFileSync(tomlFile, `${existing.trimEnd()}\n${block}`, 'utf8');
    console.log(`wrote [mcp_servers.clearbrief] -> ${tomlFile}`);
  } else {
    console.log(`[mcp_servers.clearbrief] already in ${tomlFile}`);
  }

  const skillsSrc = path.join(ROOT, 'skills');
  for (const entry of fs.readdirSync(skillsSrc, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dest = path.join(skillsDest, entry.name);
    fs.cpSync(path.join(skillsSrc, entry.name), dest, { recursive: true });
    console.log(`synced $${entry.name} -> ${dest}`);
  }
}

function printClaudeSetup() {
  console.log('\nClaude Code (plugin mode):');
  console.log(`  claude --plugin-dir "${ROOT}"`);
  console.log('\nClaude Code (global MCP):');
  console.log(`  claude mcp add --scope user clearbrief -- node "${SERVER_FILE}"`);
  console.log('\nClaude Desktop (claude_desktop_config.json):');
  console.log(JSON.stringify({ mcpServers: { clearbrief: { command: 'node', args: [SERVER_FILE] } } }, null, 2));
}

const selfPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(selfPath)) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv);
  if (!argv.length || flags.has('--check')) check();
  if (flags.has('--codex') || flags.has('--all')) installCodex();
  if (flags.has('--claude') || flags.has('--all')) printClaudeSetup();
  if (flags.has('--rules')) {
    const idx = argv.indexOf('--rules');
    const next = argv[idx + 1];
    installRules(next && !next.startsWith('--') ? next : process.cwd());
  }
  if (flags.has('--global-rules')) installGlobalRules();
  if (flags.has('--git-alias')) installGitAlias();
}
