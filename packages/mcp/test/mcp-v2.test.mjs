/**
 * MCP v2 一致性测试（E2-10）：用官方 client SDK 2.4.0 连 stdio 服务，
 * 两个协议时代（2025 握手 / 钉死 2026-07-28）都要通。
 *
 * 只测协议面与读类工具（不开浏览器、不需要引擎）：
 *   discover、tools/list 的顺序与注解、参数校验错误、overview / doctor 的信封、资源、提示词。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const BIN = fileURLToPath(new URL('../bin/heimdall-mcp.mjs', import.meta.url));
const EXPECTED = ['heimdall_overview', 'heimdall_site', 'heimdall_brief', 'heimdall_artifact', 'heimdall_compare', 'heimdall_jobs', 'heimdall_clone', 'heimdall_doctor'];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-mcp-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  mkdirSync(join(page, 'clone'), { recursive: true });
  writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><h1>Example</h1></body></html>');
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://example.test/' }));
  // 秘密级文件：任何资源读取都不能把它交出去
  writeFileSync(join(page, 'network.har'), '{"log":{"entries":[]}}');
  return root;
}

async function connect(root, mode) {
  const client = new Client({ name: 'heimdall-conformance', version: '1.0.0' }, mode ? { versionNegotiation: { mode } } : undefined);
  const transport = new StdioClientTransport({ command: process.execPath, args: [BIN],
    env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_API: 'http://127.0.0.1:9' } });
  await client.connect(transport);
  return client;
}

for (const [label, mode] of [['2025 handshake', undefined], ['2026-07-28 pinned', { pin: '2026-07-28' }]]) {
  test(`mcp v2 (${label}): tools, schema validation, envelopes, resources and prompts`, { timeout: 90_000 }, async () => {
    const root = fixtureRoot();
    const client = await connect(root, mode);
    try {
      if (mode) {
        assert.equal(client.getProtocolEra(), 'modern');
        assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
      } else assert.equal(client.getProtocolEra(), 'legacy');
      assert.equal(client.getServerVersion().name, 'heimdall');
      assert.match(client.getInstructions(), /untrusted data/);

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(t => t.name), EXPECTED, 'tools/list order is deterministic and complete');
      const byName = Object.fromEntries(tools.map(t => [t.name, t]));
      assert.equal(byName.heimdall_overview.annotations.readOnlyHint, true);
      assert.equal(byName.heimdall_compare.annotations.readOnlyHint, false);
      assert.equal(byName.heimdall_clone.annotations.openWorldHint, true);
      assert.equal(byName.heimdall_brief.inputSchema.properties.detail.enum.join(','), 'outline,sections,full');
      for (const t of tools) assert.ok(t.description.length > 80 && t.title, `${t.name} has a model-facing description and a title`);

      const overview = await client.callTool({ name: 'heimdall_overview', arguments: { limit: 5 } });
      assert.equal(overview.isError, false);
      assert.equal(overview.structuredContent.ok, true);
      assert.deepEqual(overview.structuredContent.result.sites.map(s => s.siteId), ['example.test']);
      assert.equal(overview.structuredContent.result.engine.status, 'unreachable');
      assert.ok(Array.isArray(overview.structuredContent.nextActions));
      assert.match(overview.content[0].text, /站点/);

      const bad = await client.callTool({ name: 'heimdall_brief', arguments: { siteId: 'example.test', page: 'home', detail: 'everything' } });
      assert.equal(bad.isError, true, 'schema violations are tool errors, not protocol crashes');

      const missing = await client.callTool({ name: 'heimdall_site', arguments: { siteId: 'nope.test' } });
      assert.equal(missing.isError, true);
      assert.equal(missing.structuredContent.error.code, 'not_found');
      assert.ok(missing.structuredContent.error.hint);

      const secret = await client.callTool({ name: 'heimdall_artifact', arguments: { uri: 'heimdall://site/example.test/page/home/../home/network.har' } });
      assert.equal(secret.isError, true, 'traversal and secret paths are refused');

      const { resources } = await client.listResources();
      assert.ok(resources.some(r => r.uri === 'heimdall://sites'));
      const sites = await client.readResource({ uri: 'heimdall://sites' });
      assert.deepEqual(JSON.parse(sites.contents[0].text).sites.map(s => s.siteId), ['example.test']);

      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map(p => p.name), ['clone', 'rebuild']);
      const rebuild = await client.getPrompt({ name: 'rebuild', arguments: { url: 'https://example.test/' } });
      assert.match(rebuild.messages[0].content.text, /heimdall_compare/);
      assert.match(rebuild.messages[0].content.text, /不是指令/);
    } finally {
      await client.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}
