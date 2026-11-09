import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const MCP = fileURLToPath(new URL('../bin/heimdall-mcp.mjs', import.meta.url));
const ENGINE = fileURLToPath(new URL('../../../core/src/engine-server.mjs', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('fresh MCP exposes incomplete collection and incompatible score methods without a stale diff', { timeout: 90_000 }, async () => {
  let origin, partial = true;
  const fixture = createServer((req, res) => {
    if (req.url === '/robots.txt') return res.end(partial ? 'Sitemap: /good.xml\nSitemap: /failed.xml' : 'Sitemap: /good.xml');
    if (req.url === '/good.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(`<urlset><url><loc>${origin}/page</loc></url></urlset>`);
    }
    if (req.url === '/failed.xml') { res.writeHead(503); return res.end(); }
    if (req.url === '/page') return res.end('<!doctype html><title>Page</title><h1>Page</h1>');
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${fixture.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-mcp-sitemap-'));
  const seoDir = join(root, 'workspace', '127.0.0.1', 'seo');
  mkdirSync(seoDir, { recursive: true });
  writeFileSync(join(root, 'workspace', '127.0.0.1', 'site-origin.json'), JSON.stringify({ origin }));
  writeFileSync(join(seoDir, 'diff.md'), 'old comparison');
  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_API: api, HEIMDALL_HOST: '127.0.0.1',
    HEIMDALL_TOKEN: '', HEIMDALL_PSI_KEY: '', HEIMDALL_JOBS_DB: join(root, 'jobs.db') };
  const engine = spawn(process.execPath, [ENGINE, String(port)], { env, stdio: 'ignore', windowsHide: true });
  let client;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (engine.exitCode !== null) throw new Error(`engine exited: ${engine.exitCode}`);
      try { ready = (await fetch(api + '/api/status', { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready, true, 'isolated engine should start');
    client = new Client({ name: 'heimdall-seo-sitemap', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP], env }));
    const result = await client.callTool({ name: 'heimdall_seo_audit', arguments: { url: origin, maxPages: 1, waitMs: 60_000 } });
    assert.equal(result.isError, false, JSON.stringify(result.structuredContent));
    assert.match(result.structuredContent.summary, /sitemap 采集不完整/);
    const audit = result.structuredContent.result.result;
    assert.equal(audit.summary.sitemapCoverage, 'partial');
    assert.equal(audit.summary.baselineEligible, false);
    assert.equal(audit.grade, null);
    assert.equal(audit.reports.diff, null);
    assert.equal(readFileSync(join(seoDir, 'diff.md'), 'utf8'), 'old comparison');
    assert.equal(existsSync(join(seoDir, 'baseline.json')), false);

    partial = false;
    const baseline = join(seoDir, 'baseline.json');
    const old = JSON.stringify({ version: 1, host: '127.0.0.1', origin, score: 88, stable: 88,
      collection: { version: 1, sitemapCoverage: 'complete' }, siteIssues: {},
      pages: { [`${origin}/page`]: { score: 88, stable: 88, issues: { 'content-text-ratio': 'low' } } } });
    writeFileSync(baseline, old);
    const second = await client.callTool({ name: 'heimdall_seo_audit', arguments: { url: origin, maxPages: 1, waitMs: 60_000 } });
    assert.equal(second.isError, false, JSON.stringify(second.structuredContent));
    assert.match(second.structuredContent.summary, /评分口径不兼容/);
    const incompatible = second.structuredContent.result.result;
    assert.equal(incompatible.scoreMethodVersion, 2);
    assert.equal(incompatible.measurementVersion, 2);
    assert.equal(incompatible.summary.baselineMethodMismatch, true);
    assert.equal(incompatible.reports.diff, null);
    assert.equal(readFileSync(baseline, 'utf8'), old);
    assert.equal(readFileSync(join(seoDir, 'diff.md'), 'utf8'), 'old comparison');
  } finally {
    await client?.close().catch(() => {});
    if (engine.exitCode === null && engine.signalCode === null) {
      const stopped = once(engine, 'exit');
      engine.kill();
      await stopped;
    }
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
