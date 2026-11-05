import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeApi, selfTestEnv, serverLaunch, stripCodexServer, withCodexServer, withServer,
} from '../src/agent/commands/connect.mjs';

test('connect: Codex TOML adds, replaces and removes only the Heimdall tables', () => {
  const original = [
    '[mcp_servers.node_repl]',
    'command = "node-repl.exe"',
    '',
    '[features]',
    'web_search = true',
    '',
  ].join('\n');
  const options = {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    server: 'D:\\Github-Star\\heimdall\\packages\\mcp\\bin\\heimdall-mcp.mjs',
    api: 'http://127.0.0.1:8900',
  };
  const once = withCodexServer(original, true, options);
  assert.match(once, /\[mcp_servers\.node_repl\]/);
  assert.match(once, /\[features\]/);
  assert.match(once, /\[mcp_servers\.heimdall\]/);
  assert.match(once, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);
  assert.match(once, /args = \["D:\/Github-Star\/heimdall\/packages\/mcp\/bin\/heimdall-mcp\.mjs"\]/);
  assert.match(once, /HEIMDALL_API = "http:\/\/127\.0\.0\.1:8900"/);

  const twice = withCodexServer(once, true, options);
  assert.equal(twice, once, 'the same Codex config must be idempotent');
  assert.equal((twice.match(/^\[mcp_servers\.heimdall\]$/gm) ?? []).length, 1);

  const removed = withCodexServer(twice, false);
  assert.doesNotMatch(removed, /mcp_servers\.heimdall/);
  assert.match(removed, /\[mcp_servers\.node_repl\]/);
  assert.match(removed, /\[features\]/);
  assert.equal(stripCodexServer(removed), removed.trimEnd());
});

test('connect: JSON clients retain unrelated MCP servers', () => {
  const before = { mcpServers: { other: { command: 'other.exe' } }, theme: 'dark' };
  const options = {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    server: 'D:\\Github-Star\\heimdall\\packages\\mcp\\bin\\heimdall-mcp.mjs',
    api: 'http://127.0.0.1:8912',
  };
  const after = withServer('claude-desktop', before, true, options);
  assert.equal(after.mcpServers.other.command, 'other.exe');
  assert.deepEqual(after.mcpServers.heimdall, serverLaunch(options));
  assert.equal(after.mcpServers.heimdall.env.HEIMDALL_API, 'http://127.0.0.1:8912');
  assert.equal(after.theme, 'dark');
  const removed = withServer('claude-desktop', after, false);
  assert.deepEqual(removed, before);
});

test('connect: every client writes and self-tests the exact same engine URL', () => {
  const options = {
    node: 'C:\\Program Files\\nodejs\\node.exe',
    server: 'D:\\Github-Star\\heimdall\\packages\\mcp\\bin\\heimdall-mcp.mjs',
    api: 'http://127.0.0.1:8912/',
  };
  assert.equal(normalizeApi(options.api), 'http://127.0.0.1:8912');
  assert.equal(serverLaunch(options).env.HEIMDALL_API, 'http://127.0.0.1:8912');
  const vscode = withServer('vscode', {}, true, options).servers.heimdall;
  assert.deepEqual(vscode, { type: 'stdio', ...serverLaunch(options) });
  const codex = withCodexServer('', true, options);
  assert.match(codex, /HEIMDALL_API = "http:\/\/127\.0\.0\.1:8912"/);
  assert.match(codex, /command = "C:\\\\Program Files\\\\nodejs\\\\node\.exe"/);

  const env = selfTestEnv(options.api, { PATH: 'C:\\Windows', HEIMDALL_API: 'http://127.0.0.1:9' });
  assert.equal(env.HEIMDALL_API, 'http://127.0.0.1:8912');
  assert.equal(env.HEIMDALL_CAPS_TIMEOUT_MS, '3000');
  assert.equal(env.PATH, 'C:\\Windows');
});
