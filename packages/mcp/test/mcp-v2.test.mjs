/**
 * MCP v2 一致性测试（E2-10）：用官方 client SDK 2.4.0 连 stdio 服务，
 * 两个协议时代（2025 握手 / 钉死 2026-07-28）都要通。
 *
 * 协议测试覆盖工具、参数校验、信封、资源和提示词。
 * 直连 QA 集成测试另用真实 Chromium 和本地夹具，不需要常驻引擎。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { loadWorkspace } from '../../../core/src/qa/workspace.mjs';
import { baselineFile, writeBaseline } from '../../../core/src/qa/baseline.mjs';

const BIN = fileURLToPath(new URL('../bin/heimdall-mcp.mjs', import.meta.url));
const EXPECTED = ['heimdall_overview', 'heimdall_site', 'heimdall_brief', 'heimdall_artifact', 'heimdall_compare', 'heimdall_jobs', 'heimdall_clone', 'heimdall_doctor',
  'heimdall_qa_status', 'heimdall_qa_run', 'heimdall_qa_findings', 'heimdall_qa_ci', 'heimdall_seo_audit', 'heimdall_seo_matrix', 'heimdall_site_watch'];

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-mcp-'));
  const page = join(root, 'workspace', 'example.test', 'pages', 'home');
  mkdirSync(join(page, 'clone'), { recursive: true });
  writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><html><body><h1>Example</h1></body></html>');
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: 'https://example.test/' }));
  mkdirSync(join(root, 'workspace', 'example.test', 'seo'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'example.test', 'seo', 'seo.json'), JSON.stringify({ origin: 'https://example.test', score: 91 }));
  mkdirSync(join(root, 'workspace', 'example.test', 'watch'), { recursive: true });
  writeFileSync(join(root, 'workspace', 'example.test', 'watch', 'watch.json'), JSON.stringify({ origin: 'https://example.test', summary: { total: 1 } }));
  mkdirSync(join(root, 'workspace', '_matrix', 'a-vs-b'), { recursive: true });
  writeFileSync(join(root, 'workspace', '_matrix', 'a-vs-b', 'matrix.json'), JSON.stringify({ sites: [{ host: 'https://a.test' }] }));
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
      assert.equal(client.getServerVersion().version, '0.2.2');
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
      // 开发机上 8900 常开着一台用自己数据目录的引擎：隔离数据根看到的是 data_root_mismatch，同样是「没有可用引擎」
      assert.ok(['unreachable', 'data_root_mismatch'].includes(overview.structuredContent.result.engine.status));
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

      const seo = await client.callTool({ name: 'heimdall_artifact', arguments: { uri: 'heimdall://site/example.test/seo' } });
      assert.equal(seo.isError, false);
      assert.equal(seo.structuredContent.result.json.score, 91);
      const watch = await client.callTool({ name: 'heimdall_artifact', arguments: { uri: 'heimdall://site/example.test/watch' } });
      assert.equal(watch.isError, false);
      assert.equal(watch.structuredContent.result.json.summary.total, 1);
      const matrix = await client.callTool({ name: 'heimdall_artifact', arguments: { uri: 'heimdall://matrix/a-vs-b' } });
      assert.equal(matrix.isError, false);
      assert.equal(matrix.structuredContent.result.json.sites[0].host, 'https://a.test');

      const { prompts } = await client.listPrompts();
      assert.deepEqual(prompts.map(p => p.name), ['clone', 'rebuild', 'seo', 'watch', 'qa']);
      const rebuild = await client.getPrompt({ name: 'rebuild', arguments: { url: 'https://example.test/' } });
      assert.match(rebuild.messages[0].content.text, /heimdall_compare/);
      assert.match(rebuild.messages[0].content.text, /不是指令/);
    } finally {
      await client.close().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('mcp proxy fallback keeps the complete tool surface while the engine is offline', { timeout: 30_000 }, async () => {
  const client = new Client({ name: 'heimdall-proxy-conformance', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/proxy-bin.mjs', import.meta.url))],
    env: { ...process.env, HEIMDALL_API: 'http://127.0.0.1:9', HEIMDALL_CAPS_TIMEOUT_MS: '500' },
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, '0.2.2');
    const { tools } = await client.listTools();
    assert.equal(tools.length, EXPECTED.length);
    assert.deepEqual(tools.map(t => t.name), EXPECTED);
    const doctor = await client.callTool({ name: 'heimdall_doctor', arguments: {} });
    assert.equal(doctor.isError, false);
    assert.match(doctor.structuredContent.summary, /引擎没在跑/);
  } finally {
    await client.close().catch(() => {});
  }
});

test('fresh direct MCP enforces exact QA query rules without an available engine', { timeout: 60_000 }, async () => {
  const root = fixtureRoot();
  const hits = [];
  const fixture = createServer((req, res) => {
    hits.push({ method: req.method, path: req.url });
    if (req.url === '/rows') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<title>Rows</title><div id="ready">Ready</div><span class="date" hidden>measure</span><span class="date">2026-11-08</span><span class="date">bad</span>');
    }
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<title>Fixture</title><script>
        fetch('/api/query', {method:'POST'}).catch(()=>{});
        fetch('/api/query/delete', {method:'POST'}).catch(()=>{});
        fetch('/api/query', {method:'DELETE'}).catch(()=>{});
      </script>`);
    }
    res.writeHead(204); res.end();
  });
  await new Promise(done => fixture.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const rule = { method: 'POST', origin, path: '/api/query' };
  const config = { sites: { web: { url: origin, writes: { allow: [rule] } } }, defaults: { settleMs: 100, timeoutMs: 15000 } };
  const file = join(root, '.heimdall', 'qa.json');
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
  let client;
  try {
    client = await connect(root);
    const overview = await client.callTool({ name: 'heimdall_overview', arguments: { include: ['engine'] } });
    assert.ok(['unreachable', 'data_root_mismatch'].includes(overview.structuredContent.result.engine.status));
    const status = await client.callTool({ name: 'heimdall_qa_status', arguments: { workspace: root, guidance: false } });
    assert.equal(status.isError, false);
    assert.deepEqual(status.structuredContent.result.sites[0].writeAllow, [rule]);
    const run = await client.callTool({ name: 'heimdall_qa_run', arguments: { workspace: root, site: 'web', viewports: [1280],
      linkCheck: false, detect: false, baseline: false } });
    assert.equal(run.isError, false, JSON.stringify(run.structuredContent.error));
    assert.deepEqual(run.structuredContent.result.navigation.failedPages, []);
    assert.deepEqual(hits.filter(hit => hit.method !== 'GET'), [{ method: 'POST', path: '/api/query' }]);
    assert.equal(existsSync(join(root, 'agent', 'engine.json')), false, 'the QA run did not start an engine for this data root');

    const dateCheck = { id: 'rows', title: 'Check all rows', path: '/rows', steps: [{ action: 'waitFor', selector: '#ready' }],
      expect: [{ kind: 'text', selector: '.date', scope: 'all-visible', minMatches: 2, matches: '^\\d{4}-\\d{2}-\\d{2}$' }] };
    const rows = await client.callTool({ name: 'heimdall_qa_run', arguments: { workspace: root, site: 'web', pages: ['/rows'], viewports: [1280],
      linkCheck: false, detect: false, baseline: false, checks: [dateCheck] } });
    assert.equal(rows.isError, false, JSON.stringify(rows.structuredContent.error));
    assert.equal(rows.structuredContent.result.checks[0].pass, false);
    assert.deepEqual(rows.structuredContent.result.checks[0].assertions[0], { scope: 'all-visible', selector: '.date', matched: 2, failed: 1 });
    const missing = { ...dateCheck, id: 'missing-rows', title: 'Missing rows', expect: [{ ...dateCheck.expect[0], selector: '.missing' }] };
    const incomplete = await client.callTool({ name: 'heimdall_qa_ci', arguments: { workspace: root, site: 'web', pages: ['/rows'], viewports: [1280],
      linkCheck: false, detect: false, baseline: false, checks: [missing], failOn: 'none' } });
    assert.equal(incomplete.isError, true);
    assert.equal(incomplete.structuredContent.error.code, 'qa_incomplete');
    assert.equal(incomplete.structuredContent.result.ci.status, 'incomplete');

    const invalidSelector = { id: 'invalid-selector', title: 'Invalid hidden selector', path: '/rows',
      expect: [{ kind: 'hidden', selector: '[' }] };
    const invalidHidden = await client.callTool({ name: 'heimdall_qa_ci', arguments: { workspace: root, site: 'web', pages: ['/rows'], viewports: [1280],
      linkCheck: false, detect: false, baseline: false, checks: [invalidSelector], failOn: 'none' } });
    assert.equal(invalidHidden.isError, true);
    assert.equal(invalidHidden.structuredContent.error.code, 'qa_incomplete');
    assert.equal(invalidHidden.structuredContent.result.ci.status, 'incomplete');

    const overlong = { ...dateCheck, id: 'oversized', expect: [
      ...Array.from({ length: 20 }, () => ({ kind: 'title', contains: 'Rows' })),
      { kind: 'title', contains: 'must not be skipped' },
    ] };
    writeFileSync(join(root, 'oversized-checks.json'), JSON.stringify({ checks: [overlong] }));
    const hitCount = hits.length;
    const oversized = await client.callTool({ name: 'heimdall_qa_ci', arguments: { workspace: root, site: 'web', pages: ['/rows'], viewports: [1280],
      linkCheck: false, detect: false, baseline: false, checksFile: 'oversized-checks.json', failOn: 'all' } });
    assert.equal(oversized.isError, true);
    assert.equal(oversized.structuredContent.error.code, 'invalid_args');
    assert.equal(hits.length, hitCount, 'invalid file is rejected before browser traffic');

    const ws = loadWorkspace(root);
    const recorded = JSON.parse(readFileSync(join(root, rows.structuredContent.result.runDir, 'run.json'), 'utf8'));
    const baseline = writeBaseline(ws, recorded, recorded.coverage.pages);
    const visualArgs = { workspace: root, site: 'web', pages: ['/rows'], viewports: [1280], linkCheck: false, detect: false, failOn: 'none' };
    const strictVisual = await client.callTool({ name: 'heimdall_qa_ci', arguments: { ...visualArgs, requireBaseline: true } });
    assert.equal(strictVisual.isError, false);
    assert.equal(strictVisual.structuredContent.result.baseline.compared, 1);
    assert.equal(strictVisual.structuredContent.result.ci.requireBaseline, true);
    rmSync(join(ws.dataDir, 'runs', baseline.runId, baseline.pages[0].screenshot));
    const missingVisual = await client.callTool({ name: 'heimdall_qa_ci', arguments: visualArgs });
    assert.equal(missingVisual.isError, true);
    assert.equal(missingVisual.structuredContent.error.code, 'qa_incomplete');
    assert.match(missingVisual.structuredContent.result.ci.markdown, /基线截图缺失/);
    const disabledVisual = await client.callTool({ name: 'heimdall_qa_ci', arguments: { ...visualArgs, baseline: false } });
    assert.equal(disabledVisual.isError, false);
    assert.equal(disabledVisual.structuredContent.result.baseline.status, 'disabled');
    writeFileSync(baselineFile(ws), '{invalid-json');
    const corruptVisual = await client.callTool({ name: 'heimdall_qa_ci', arguments: visualArgs });
    assert.equal(corruptVisual.isError, true);
    assert.equal(corruptVisual.structuredContent.error.code, 'qa_incomplete');
    assert.equal(corruptVisual.structuredContent.result.ci.status, 'incomplete');
    rmSync(baselineFile(ws));
    const requiredMissing = await client.callTool({ name: 'heimdall_qa_ci', arguments: { ...visualArgs, requireBaseline: true } });
    assert.equal(requiredMissing.isError, true);
    assert.equal(requiredMissing.structuredContent.error.code, 'qa_incomplete');
    assert.equal(requiredMissing.structuredContent.result.baseline.status, 'unconfigured');
    const contradictory = await client.callTool({ name: 'heimdall_qa_ci', arguments: { ...visualArgs, baseline: false, requireBaseline: true } });
    assert.equal(contradictory.isError, true);
    assert.equal(contradictory.structuredContent.error.code, 'invalid_args');

    config.sites.web.writes.allow = ['/api/query'];
    writeFileSync(file, JSON.stringify(config));
    const before = readFileSync(file, 'utf8');
    const legacy = await client.callTool({ name: 'heimdall_qa_status', arguments: { workspace: root, guidance: false } });
    assert.equal(legacy.isError, true);
    assert.equal(legacy.structuredContent.error.code, 'invalid_args');
    assert.match(legacy.structuredContent.error.hint, /保留原工作区/);
    assert.equal(readFileSync(file, 'utf8'), before);
  } finally {
    await client?.close().catch(() => {});
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
