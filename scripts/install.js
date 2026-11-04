#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_FILE = path.join(ROOT, 'src', 'server.js');

const REQUIRED = [
  '.claude-plugin/plugin.json',
  '.codex-plugin/plugin.json',
  '.mcp.json',
  '.mcp.codex.json',
  'hooks/hooks.json',
  'src/server.js',
  'scripts/session-start.js',
  'scripts/pre-read-guard.js',
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

const flags = new Set(process.argv.slice(2));
if (!flags.size || flags.has('--check')) check();
if (flags.has('--codex') || flags.has('--all')) installCodex();
if (flags.has('--claude') || flags.has('--all')) printClaudeSetup();
