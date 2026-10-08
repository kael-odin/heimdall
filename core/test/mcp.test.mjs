/**
 * MCP 服务器单测：initialize / tools/list / tools/call（stdio JSON-RPC）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');

function startServer() {
  const p = spawn(process.execPath, ['src/mcp/server.mjs'], { cwd: CORE, stdio: ['pipe', 'pipe', 'pipe'] });
  const rl = createInterface({ input: p.stdout });
  const pending = new Map();
  let seq = 0;
  rl.on('line', (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + method)); }, 20_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { p, request, close: () => { try { p.kill('SIGTERM'); } catch {} } };
}

test('mcp: initialize, tools/list and tools/call respond over stdio', async () => {
  const { request, close } = startServer();
  try {
    const init = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.result.serverInfo.name, 'heimdall');
    assert.ok(init.result.capabilities.tools);
    assert.equal(init.result.protocolVersion, '2025-03-26');

    const tools = await request('tools/list');
    assert.ok(tools.result.tools.length >= 10, 'tool count: ' + tools.result.tools.length);
    for (const name of ['heimdall_recon', 'heimdall_forge', 'heimdall_audit', 'heimdall_watch', 'heimdall_assets', 'heimdall_verify', 'heimdall_tokens', 'heimdall_matrix', 'heimdall_live_export']) {
      assert.ok(tools.result.tools.some(t => t.name === name), 'missing tool: ' + name);
    }

    const call = await request('tools/call', { name: 'heimdall_status', arguments: {} });
    assert.ok(call.result.content?.[0]?.text, 'tool call must return text content');

    const unknown = await request('tools/call', { name: 'nope', arguments: {} });
    assert.ok(unknown.result.isError, 'unknown tool should be an error result');
  } finally { close(); }
});
