/**
 * SEO 对标矩阵单测（纯函数）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { categorize, siteAggregate, buildMatrix, renderMatrixHtml, renderMatrixCsv } from '../src/seo/matrix-core.mjs';
import { resolveMatrixTarget } from '../src/seo/matrix-target.mjs';
import { siteIdForOrigin } from '../src/site-origin.mjs';
import { SEO_SCORE_METHOD_VERSION, SEO_MEASUREMENT_VERSION } from '../src/seo/method.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));

const audit = (host, specs) => ({
  host, score: 80, scoreMethodVersion: 2, measurementVersion: 3,
  summary: { issues: specs.length * 3, baselineEligible: true, sitemapCoverage: 'complete', bySeverity: { high: 1, medium: 1, low: 1, info: 0 } },
  pages: specs.map(s => ({
    url: `https://${host}${s.path}`, status: 200,
    titleLength: s.titleLen ?? 40, descriptionLength: s.descLen ?? 90,
    h1: ['H'], jsonld: s.jsonld === false ? [] : [{ ok: true, types: ['WebSite'] }],
    wordCount: s.words ?? 600, vitals: { lcp: s.lcp ?? 2000 },
    issues: [{ id: 'content-img-alt' }, { id: 'perf-cls-warn' }],
  })),
  siteIssues: [],
});

test('matrix: categorize common URL shapes', () => {
  assert.equal(categorize('https://x.test/'), 'home');
  assert.equal(categorize('https://x.test/pricing'), 'pricing');
  assert.equal(categorize('https://x.test/docs/getting-started'), 'docs');
  assert.equal(categorize('https://x.test/blog/post-1'), 'blog');
  assert.equal(categorize('https://x.test/use-cases/ai'), 'product');
  assert.equal(categorize('https://x.test/about'), 'company');
});

test('matrix: site aggregates compute rates and averages', () => {
  const a = audit('a.test', [{ path: '/', lcp: 1000, words: 400 }, { path: '/pricing', lcp: 3000, words: 800, descLen: 0 }]);
  const agg = siteAggregate(a);
  assert.equal(agg.pages, 2);
  assert.equal(agg.avgLcp, 2000);
  assert.equal(agg.avgWords, 600);
  assert.equal(agg.descRate, 50);
  assert.equal(agg.issuesPerPage, 3);
});

test('matrix: buildMatrix groups page types and top issues', () => {
  const m = buildMatrix([
    audit('a.test', [{ path: '/' }, { path: '/pricing' }]),
    audit('b.test', [{ path: '/' }, { path: '/docs/x', jsonld: false }]),
  ]);
  assert.equal(m.sites.length, 2);
  const home = m.rows.find(r => r.type === 'home');
  assert.ok(home && home.cells.every(c => c.pages === 1));
  const docs = m.rows.find(r => r.type === 'docs');
  assert.ok(docs && docs.cells[1].pages === 1);
  assert.ok(m.topIssues[0].top.some(t => t.id === 'content-img-alt'));
});

test('matrix: html and csv render all sites', () => {
  const m = buildMatrix([audit('a.test', [{ path: '/' }]), audit('b.test', [{ path: '/' }])]);
  const html = renderMatrixHtml(m);
  assert.ok(html.includes('a.test') && html.includes('b.test'));
  assert.ok(html.includes('站点分'));
  const csv = renderMatrixCsv(m);
  assert.ok(csv.includes('site_score'));
  assert.ok(csv.includes('a.test'));
});

test('matrix: incomplete and legacy audits do not compete using unverified scores', () => {
  const complete = audit('complete.test', [{ path: '/' }]);
  complete.pages[0].score = 90;
  const partial = audit('partial.test', [{ path: '/' }]);
  partial.summary.sitemapCoverage = 'partial';
  partial.summary.baselineEligible = false;
  const legacy = audit('legacy.test', [{ path: '/' }]);
  delete legacy.summary.baselineEligible;
  delete legacy.summary.sitemapCoverage;
  const matrix = buildMatrix([complete, partial, legacy]);
  assert.deepEqual(matrix.sites.map(site => site.aggregate.score), [null, null, null]);
  assert.deepEqual(matrix.sites.map(site => site.aggregate.issuesPerPage), [null, null, null]);
  assert.deepEqual(matrix.rows[0].cells.map(cell => cell.avgScore), [null, null, null]);
  assert.equal(matrix.scoreComparison.reason, 'insufficient-eligible-audits');
  assert.match(renderMatrixHtml(matrix), /旧报告未记录采集状态/);
  assert.match(renderMatrixCsv(matrix), /sitemap_coverage/);
});

test('matrix: CLI and API keep same-host HTTP and HTTPS origins separate', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-matrix-origin-'));
  const workspace = join(root, 'workspace');
  const origins = ['http://example.com:8080', 'https://example.com'];
  let engine;
  try {
    const siteIds = origins.map((origin, index) => {
      const siteId = siteIdForOrigin(workspace, origin);
      const dir = join(workspace, siteId);
      mkdirSync(join(dir, 'seo'), { recursive: true });
      writeFileSync(join(dir, 'site-origin.json'), JSON.stringify({ origin }));
      writeFileSync(join(dir, 'seo', 'seo.json'), JSON.stringify({
        host: 'example.com', origin, score: 90 - index * 10, scoreMethodVersion: 2,
        pages: [], siteIssues: [], summary: { issues: 0, baselineEligible: true, sitemapCoverage: 'complete' },
      }));
      return siteId;
    });
    assert.notEqual(siteIds[0], siteIds[1]);
    assert.equal(resolveMatrixTarget(siteIds[1], { workspace }).origin, origins[1]);

    const run = spawnSync(process.execPath, ['src/seo/matrix.mjs', origins[0], siteIds[1], '--max', '1'], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 10_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const outputDir = join(workspace, '_matrix', readdirSync(join(workspace, '_matrix'))[0]);
    const matrix = JSON.parse(readFileSync(join(outputDir, 'matrix.json'), 'utf8'));
    assert.deepEqual(matrix.sites.map(site => site.host), origins);
    assert.deepEqual(matrix.sites.map(site => site.aggregate.score), [90, 80]);

    const portServer = createServer();
    await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
    const port = portServer.address().port;
    await new Promise(resolve => portServer.close(resolve));
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'x-heimdall-token': 'test-token' };
    engine = spawn(process.execPath, [ENGINE, String(port)], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_TOKEN: 'test-token', HEIMDALL_HOST: '127.0.0.1' },
      stdio: 'ignore',
    });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base + '/api/status', { headers })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'engine did not start');
    const response = await fetch(base + '/api/matrix', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ sites: siteIds, maxPages: 1 }),
    });
    const submitted = await response.json();
    assert.equal(response.status, 200, JSON.stringify(submitted));
    assert.deepEqual(submitted.sites, origins);
    let status = 'running';
    for (let i = 0; i < 100; i++) {
      const jobs = await (await fetch(base + '/api/jobs', { headers })).json();
      status = jobs.jobs.find(job => job.id === submitted.taskId)?.status;
      if (status !== 'running') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(status, 'done');
  } finally {
    if (engine && engine.exitCode === null && engine.signalCode === null) {
      engine.kill();
      await new Promise(resolve => engine.once('exit', resolve));
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('matrix: different or unknown scoring methods cannot be compared', () => {
  const current = audit('current.test', [{ path: '/' }]);
  current.pages[0].score = 90;
  const old = audit('old.test', [{ path: '/' }]);
  old.pages[0].score = 88;
  for (const version of [null, 1]) {
    old.scoreMethodVersion = version;
    const matrix = buildMatrix([current, old]);
    assert.equal(matrix.scoreComparison.comparable, false);
    assert.deepEqual(matrix.sites.map(s => s.aggregate.score), [null, null]);
    assert.deepEqual(matrix.sites.map(s => s.aggregate.issuesPerPage), [null, null]);
    assert.deepEqual(matrix.rows[0].cells.map(c => c.avgScore), [null, null]);
    assert.match(renderMatrixHtml(matrix), /评分口径缺失或不一致/);
  }
  old.scoreMethodVersion = 2;
  const comparable = buildMatrix([current, old]);
  assert.equal(comparable.scoreComparison.comparable, true);
  assert.deepEqual(comparable.sites.map(s => s.aggregate.score), [80, 80]);
  assert.deepEqual(comparable.rows[0].cells.map(c => c.avgScore), [90, 88]);
  current.summary.baselineEligible = false;
  old.summary.baselineEligible = false;
  const incomplete = buildMatrix([current, old]);
  assert.equal(incomplete.scoreComparison.reason, 'insufficient-eligible-audits');
  assert.match(renderMatrixHtml(incomplete), /完整审计不足两份/);
});

test('matrix: JSON-LD coverage is hidden when measurement methods are old, unknown or mixed', () => {
  const current = audit('current.test', [{ path: '/' }]);
  const other = audit('other.test', [{ path: '/', jsonld: false }]);
  for (const version of [null, 2, 4]) {
    other.measurementVersion = version;
    const matrix = buildMatrix([current, other]);
    assert.equal(matrix.scoreComparison.comparable, true);
    assert.equal(matrix.jsonldComparison.comparable, false);
    assert.deepEqual(matrix.sites.map(s => s.aggregate.jsonldRate), [null, null]);
    assert.deepEqual(matrix.sites.map(s => s.aggregate.issuesPerPage), [null, null]);
    assert.ok(matrix.topIssues.every(site => site.top.length === 0));
    assert.match(renderMatrixHtml(matrix), /JSON-LD 测量口径缺失/);
  }
  other.measurementVersion = 3;
  const matrix = buildMatrix([current, other]);
  assert.equal(matrix.jsonldComparison.comparable, true);
  assert.deepEqual(matrix.sites.map(s => s.aggregate.jsonldRate), [100, 0]);
  assert.match(renderMatrixHtml(matrix), /不包括 microdata 或 RDFa/);
  current.pages[0].jsonld = [{ ok: true, types: [], semanticStatus: 'unknown' }];
  const unknown = buildMatrix([current, other]);
  assert.equal(unknown.sites[0].aggregate.jsonldRate, null);
  assert.equal(unknown.sites[0].aggregate.jsonldUnknownPages, 1);
  assert.match(renderMatrixHtml(unknown), /语义未核实/);
  assert.match(renderMatrixCsv(unknown), /jsonld_unknown_pages/);
});

test('matrix: the current resource-classification method is not compared with version 3', () => {
  const current = audit('current.test', [{ path: '/' }]);
  const previous = audit('previous.test', [{ path: '/' }]);
  current.scoreMethodVersion = SEO_SCORE_METHOD_VERSION;
  current.measurementVersion = SEO_MEASUREMENT_VERSION;
  previous.scoreMethodVersion = SEO_SCORE_METHOD_VERSION - 1;
  previous.measurementVersion = SEO_MEASUREMENT_VERSION - 1;
  const mixed = buildMatrix([current, previous]);
  assert.equal(mixed.scoreComparison.comparable, false);
  assert.equal(mixed.jsonldComparison.comparable, false);
  assert.deepEqual(mixed.sites.map(s => s.aggregate.score), [null, null]);
  previous.scoreMethodVersion = SEO_SCORE_METHOD_VERSION;
  previous.measurementVersion = SEO_MEASUREMENT_VERSION;
  const same = buildMatrix([current, previous]);
  assert.equal(same.scoreComparison.comparable, true);
  assert.equal(same.jsonldComparison.comparable, true);
});
