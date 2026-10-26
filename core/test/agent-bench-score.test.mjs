/**
 * Bench 测量核心（E14-01）：同一候选量两次，分数一致；**测量不改候选**
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'heimdall-bench-'));
process.env.HEIMDALL_DATA_DIR = root;

let score, browser, launchBrowser, startBaselineServer, server;
const SITE = 'bench.test';
const HTML = '<!doctype html><html><head><link rel="stylesheet" href="s.css"></head><body><h1>Bench fixture page</h1><p>Some copy for the text coverage check.</p></body></html>';

before(async () => {
  mkdirSync(join(root, 'workspace', SITE, 'pages', 'home', 'clone'), { recursive: true });
  writeFileSync(join(root, 'workspace', SITE, 'pages', 'home', 'clone', 'index.html'), HTML);
  writeFileSync(join(root, 'workspace', SITE, 'pages', 'home', 'clone', 's.css'), 'h1{color:#123456}');
  ({ scoreCandidate: score } = await import('../src/agent/bench/score.mjs'));
  ({ launchBrowser } = await import('../src/agent/evidence/capture.mjs'));
  ({ startBaselineServer } = await import('../src/agent/gate/baseline.mjs'));
  browser = await launchBrowser();

  const project = join(root, 'candidate');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'index.html'), HTML);
  writeFileSync(join(project, 's.css'), 'h1{color:#123456}');
  server = await startBaselineServer(project);
  writeFileSync(join(project, 'heimdall.config.json'), JSON.stringify({
    schema: 'heimdall.config/1', siteId: SITE, pages: [{ name: 'home', route: '/' }], viewports: [1440],
    devServer: { url: server.origin + '/' }, gate: { level: 'bronze' },
  }));
  globalThis.__project = project;
});

after(async () => {
  await server?.close().catch(() => {});
  await browser?.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

test('bench: scoring is repeatable and leaves the candidate untouched', { timeout: 120_000 }, async () => {
  const project = globalThis.__project;
  const a = await score({ siteId: SITE, page: 'home', candidateDir: project, level: 'bronze', viewports: [1440], browser });
  const b = await score({ siteId: SITE, page: 'home', candidateDir: project, level: 'bronze', viewports: [1440], browser });
  assert.equal(a.pixel[1440], 1, JSON.stringify(a.pixel));
  assert.deepEqual(a.pixel, b.pixel, 'the same candidate scores the same twice');
  assert.equal(a.iterations, 0, 'no iterations of its own');
  assert.equal(existsSync(join(project, '.heimdall', 'ledger.jsonl')), false, 'measuring must not write into the candidate ledger');
  assert.ok(a.compareMs > 0);
});
