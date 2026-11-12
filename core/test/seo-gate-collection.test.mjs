import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEO_SCORE_METHOD_VERSION, SEO_MEASUREMENT_VERSION, GEO_METHOD_VERSION } from '../src/seo/method.mjs';

const AUDIT = fileURLToPath(new URL('../src/seo/audit.mjs', import.meta.url));

function runAudit(origin, baseline, dataDir, flags = ['--update-baseline']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDIT, origin, '--max', '1', '--baseline', baseline, ...flags], {
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_PSI_KEY: '' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

test('seo gate: unresolved JSON-LD is unknown, never fetched or saved as a baseline', { timeout: 60_000 }, async () => {
  let origin, unknown = false, contextHits = 0;
  const server = createServer((req, res) => {
    if (req.url === '/context') { contextHits++; return res.end('{}'); }
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      const ld = unknown ? { '@context': `${origin}/context`, '@type': 'Article' }
        : { '@context': 'https://schema.org', type: 'Article', headline: 'Fixture', datePublished: '2026-11-13' };
      return res.end(`<!doctype html><title>Semantic fixture</title><h1>Fixture</h1><script type="application/ld+json">${JSON.stringify(ld)}</script>`);
    }
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-jsonld-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const initial = await runAudit(origin, baseline, dataDir);
    assert.equal(initial.code, 0, initial.output);
    const original = readFileSync(baseline, 'utf8');
    unknown = true;
    const blocked = await runAudit(origin, baseline, dataDir);
    assert.equal(blocked.code, 1, blocked.output);
    assert.match(blocked.output, /structured-data-unchecked/);
    assert.equal(readFileSync(baseline, 'utf8'), original);
    assert.equal(contextHits, 0, 'processor must never fetch arbitrary context URLs');
    const directory = join(dataDir, 'workspace', '127.0.0.1', 'seo');
    const report = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    assert.equal(report.summary.baselineEligible, false);
    assert.equal(report.summary.structuredUnchecked, 1);
    assert.ok(report.pages[0].issues.some(i => i.id === 'structured-unchecked'));
    assert.ok(!report.pages[0].issues.some(i => i.id === 'structured-none'));
    assert.ok(report.geo.pages[0].unknown.some(i => i.id === 'geo-entity-type'));
    assert.ok(!report.geo.actionPlan.some(i => i.id === 'geo-entity-type'));
    assert.match(readFileSync(join(directory, 'seo.html'), 'utf8'), /未自动访问其他远程上下文/);
    assert.match(readFileSync(join(directory, 'seo.csv'), 'utf8'), /"info","structured-unchecked"/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo audit: optional robots and sitemap observations do not lower the site score', { timeout: 60_000 }, async () => {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html lang="en"><head><title>Example page</title></head><body><h1>Example page</h1></body></html>');
    }
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-optional-files-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const run = await runAudit(origin, baseline, dataDir);
    assert.equal(run.code, 0, run.output);
    const directory = join(dataDir, 'workspace', '127.0.0.1', 'seo');
    const report = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    assert.equal(report.scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
    assert.equal(report.geo.methodVersion, GEO_METHOD_VERSION);
    assert.equal(typeof report.geo.score, 'number');
    assert.equal(typeof report.geo.dimensions.answerability.score, 'number');
    assert.equal(report.summary.sitemapCoverage, 'not_found');
    assert.equal(report.summary.baselineEligible, true);
    assert.deepEqual(report.siteIssues.map(issue => [issue.id, issue.severity]), [
      ['index-robots-missing', 'info'], ['index-sitemap-missing', 'info'],
    ]);
    assert.equal(report.score, report.pages[0].score);
    const html = readFileSync(join(directory, 'seo.html'), 'utf8');
    assert.match(html, /待核查提示，不单独扣分/);
    assert.match(html, /hreflang.*x-default.*不扣分/);
    assert.match(html, /GEO 准备度/);
    assert.match(html, /AI 可回答与可引用准备度/);
    assert.match(html, /GEO 行动计划/);
    assert.match(html, /预计成本/);
    assert.match(html, /不是搜索排名或模型引用概率预测/);
    const saved = JSON.parse(readFileSync(baseline, 'utf8'));
    assert.equal(saved.scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
    assert.equal(saved.siteIssues['index-robots-missing'], 'info');
    assert.equal(saved.siteIssues['index-sitemap-missing'], 'info');
    const compared = await runAudit(origin, baseline, dataDir, ['--fail-on-regression']);
    assert.equal(compared.code, 0, compared.output);
    assert.match(compared.output, /audit-regression/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo audit: misleading resource names do not pollute the report or baseline', { timeout: 60_000 }, async () => {
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aX8AAAAASUVORK5CYII=', 'base64');
  const largeImage = Buffer.concat([pixel, Buffer.alloc(1_100_000)]);
  const largeScript = `/*${'x'.repeat(1_100_000)}*/window.fixtureLoaded = true;`;
  let useScript = false;
  const server = createServer((req, res) => {
    if (req.url === '/image.js') {
      res.setHeader('content-type', 'image/png');
      return res.end(largeImage);
    }
    if (req.url === '/script.png') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(largeScript);
    }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const resource = useScript ? '<script src="/script.png"></script>' : '<img src="/image.js" alt="fixture">';
      return res.end(`<!doctype html><html lang="en"><head><title>Resource fixture</title><link rel="icon" href="data:,"></head><body><h1>Fixture</h1>${resource}</body></html>`);
    }
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-resources-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const first = await runAudit(origin, baseline, dataDir);
    assert.equal(first.code, 0, first.output);
    const directory = join(dataDir, 'workspace', '127.0.0.1', 'seo');
    const imageReport = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    const original = readFileSync(baseline, 'utf8');
    const saved = JSON.parse(original);
    assert.equal(imageReport.scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
    assert.equal(imageReport.measurementVersion, SEO_MEASUREMENT_VERSION);
    assert.ok(imageReport.pages[0].resources.imgBytes > 1_048_576);
    assert.equal(imageReport.pages[0].resources.jsBytes, 0);
    assert.ok(!imageReport.pages[0].issues.some(issue => issue.id === 'perf-js-large'));
    assert.ok(!Object.values(saved.pages)[0].issues['perf-js-large']);
    const html = readFileSync(join(directory, 'seo.html'), 'utf8');
    assert.match(html, /未分类、缓存及跨源限制/);
    assert.match(html, /文本\/DOM 比例仅供观察/);
    assert.match(html, /结构化数据提示仅检查 JSON-LD 顶层及 @graph 类型/);
    assert.doesNotMatch(html, /历史或未知测量口径可能遗漏 @graph/);
    assert.match(html, /常见字段仅作不扣分的待核查提示/);
    assert.match(html, /文本\/DOM 比例仅供观察，不扣分/);
    assert.match(html, /robots\.txt 返回 404\/410/);

    useScript = true;
    const second = await runAudit(origin, baseline, dataDir, []);
    assert.equal(second.code, 0, second.output);
    const scriptReport = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    assert.ok(scriptReport.pages[0].resources.jsBytes > 1_048_576);
    assert.equal(scriptReport.pages[0].resources.imgBytes, 0);
    assert.ok(scriptReport.pages[0].issues.some(issue => issue.id === 'perf-js-large'));
    assert.equal(readFileSync(baseline, 'utf8'), original, 'ordinary audits must not overwrite the baseline');
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: an HTTP error page cannot become a baseline', { timeout: 60_000 }, async () => {
  let origin;
  const server = createServer((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      res.end(`<urlset><url><loc>${origin}/bad</loc></url></urlset>`);
    } else if (req.url === '/bad') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><title>Temporarily unavailable</title></head><body>Unavailable</body></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-gate-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const run = await runAudit(origin, baseline, dataDir);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /未从目标来源成功采集/);
    assert.equal(existsSync(baseline), false);
    const report = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
    assert.equal(report.pages[0].status, 503);
    assert.equal(report.geo.score, null);
    assert.equal(report.geo.status, 'unavailable');
    assert.equal(report.geo.coverage.pagesScored, 0);
    assert.deepEqual(report.geo.actionPlan, []);
    const html = readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.html'), 'utf8');
    assert.match(html, /证据状态 不可用/);
    assert.match(html, /检查权重覆盖 0\/100/);
    assert.equal(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'history.json')), false);
    const thresholdRun = await runAudit(origin, baseline, dataDir, ['--threshold', '1']);
    assert.equal(thresholdRun.code, 1, thresholdRun.output);
    assert.match(thresholdRun.output, /未从目标来源成功采集/);
    assert.equal(existsSync(baseline), false);
    const initial = JSON.stringify({ version: 1, scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
      collection: { version: 1, sitemapCoverage: 'complete' },
      pages: { [`${origin}/bad`]: { score: 88, stable: 88, issues: { 'index-noindex': 'high' } } } });
    writeFileSync(baseline, initial);
    const ordinary = await runAudit(origin, baseline, dataDir, []);
    assert.equal(ordinary.code, 0, ordinary.output);
    assert.match(ordinary.output, /page-unavailable/);
    assert.doesNotMatch(ordinary.output, /audit-regression/);
    assert.equal(readFileSync(baseline, 'utf8'), initial);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: unavailable initial HTML cannot resolve findings or overwrite a baseline', { timeout: 90_000 }, async () => {
  let origin;
  const server = createServer((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      res.end(`<urlset><url><loc>${origin}/spa</loc></url></urlset>`);
    } else if (req.url === '/spa') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta name="robots" content="noindex"><title>SPA</title><script>document.querySelector("meta[name=robots]").remove(); history.replaceState(null,"","/different")</script>');
    } else if (req.url === '/different') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><title>Refetched page</title>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-incomplete-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const initial = JSON.stringify({
      version: 1, scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
      collection: { version: 1, sitemapCoverage: 'complete' },
      pages: { [`${origin}/spa`]: { score: 88, stable: 88, issues: { 'index-noindex': 'high' } } },
    });
    writeFileSync(baseline, initial);

    for (const [flags, code] of [[[], 0], [['--fail-on-regression'], 1], [['--update-baseline'], 1], [['--threshold', '1'], 1]]) {
      const run = await runAudit(origin, baseline, dataDir, flags);
      assert.equal(run.code, code, run.output);
      assert.match(run.output, /initial-html-unavailable/);
      assert.doesNotMatch(run.output, /audit-regression/);
      assert.equal(readFileSync(baseline, 'utf8'), initial);
      const report = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
      assert.equal(report.summary.initialHtmlUnchecked, 1);
      assert.equal(report.pages[0].robotsEvidence.initialHtml, 'unavailable');
      assert.equal(report.geo.status, 'partial');
      assert.equal(report.geo.dimensions.answerability.status, 'partial');
      assert.equal(report.geo.pages[0].dimensions.answerability.checks.find(item => item.id === 'geo-answer-server-visible').status, 'unknown');
      assert.equal(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'history.json')), false);
    }

    const missing = join(dataDir, 'not-created.json');
    const firstRun = await runAudit(origin, missing, dataDir, []);
    assert.equal(firstRun.code, 0, firstRun.output);
    assert.equal(existsSync(missing), false);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: cross-origin redirect with HTTP 200 cannot become a baseline', { timeout: 60_000 }, async () => {
  let origin;
  let redirectOrigin;
  const landing = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Sign in</title></head><body><h1>Sign in</h1></body></html>');
  });
  const site = createServer((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      res.end(`<urlset><url><loc>${origin}/redirect</loc></url></urlset>`);
    } else if (req.url === '/redirect') {
      res.writeHead(302, { Location: redirectOrigin + '/landing' });
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-redirect-'));
  try {
    await new Promise(resolve => landing.listen(0, '127.0.0.1', resolve));
    redirectOrigin = `http://127.0.0.1:${landing.address().port}`;
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${site.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const run = await runAudit(origin, baseline, dataDir);
    assert.equal(run.code, 1, run.output);
    assert.match(run.output, /未从目标来源成功采集/);
    assert.match(run.output, /-> http:\/\/127\.0\.0\.1:/);
    assert.equal(existsSync(baseline), false);
    const report = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
    assert.equal(report.pages[0].status, 200);
    assert.equal(new URL(report.pages[0].finalUrl).origin, redirectOrigin);
  } finally {
    await Promise.all([site, landing].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: incomplete sitemap cannot resolve issues or overwrite history and baseline', { timeout: 90_000 }, async () => {
  let origin;
  const server = createServer((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /good.xml\nSitemap: /failed.xml');
    if (req.url === '/good.xml') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<urlset><url><loc>${origin}/page</loc></url></urlset>`);
    }
    if (req.url === '/failed.xml') { res.writeHead(503); return res.end(); }
    if (req.url === '/page') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><title>Page</title><h1>Page</h1>');
    }
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-sitemap-incomplete-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const initial = JSON.stringify({
      version: 1, scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION, host: '127.0.0.1', origin, score: 88, stable: 88,
      collection: { version: 1, sitemapCoverage: 'complete' },
      siteIssues: { 'index-sitemap-missing-page': 'low' },
      pages: { [`${origin}/page`]: { score: 88, stable: 88, issues: {} } },
    });
    writeFileSync(baseline, initial);
    for (const [flags, expectedCode] of [[[], 0], [['--update-baseline'], 1], [['--fail-on-regression'], 1], [['--threshold', '1'], 1]]) {
      const run = await runAudit(origin, baseline, dataDir, flags);
      assert.equal(run.code, expectedCode, run.output);
      assert.match(run.output, /sitemap-incomplete/);
      assert.doesNotMatch(run.output, /audit-regression/);
      assert.equal(readFileSync(baseline, 'utf8'), initial);
      const directory = join(dataDir, 'workspace', '127.0.0.1', 'seo');
      const report = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
      assert.equal(report.summary.initialHtmlUnchecked, 0);
      assert.equal(report.summary.sitemapCoverage, 'partial');
      assert.ok(report.sitemap.reasons.includes('sitemap-request-failed'));
      assert.ok(!report.siteIssues.some(issue => issue.id === 'index-sitemap-missing-page'));
      assert.match(readFileSync(join(directory, 'seo.html'), 'utf8'), /sitemap.*不完整/i);
      assert.equal(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'history.json')), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: preserve legacy baselines and establish verified provenance only at a new path', { timeout: 60_000 }, async () => {
  let origin, hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<urlset><url><loc>${origin}/page</loc></url></urlset>`);
    }
    if (req.url === '/page') return res.end('<!doctype html><title>Page</title><h1>Page</h1>');
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-legacy-baseline-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'legacy.json');
    const initial = JSON.stringify({ version: 1, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
      pages: { [`${origin}/page`]: { score: 88, stable: 88, issues: {} } } });
    writeFileSync(baseline, initial);
    for (const flags of [['--require-baseline'], ['--fail-on-regression'], ['--update-baseline']]) {
      const run = await runAudit(origin, baseline, dataDir, flags);
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, /旧基线未记录采集完整性/);
      assert.equal(hits, 0, 'reject legacy baseline before source access');
      assert.equal(readFileSync(baseline, 'utf8'), initial);
    }
    const ordinary = await runAudit(origin, baseline, dataDir, []);
    assert.equal(ordinary.code, 0, ordinary.output);
    assert.match(ordinary.output, /legacy-baseline-unverified/);
    assert.doesNotMatch(ordinary.output, /audit-regression/);
    assert.equal(readFileSync(baseline, 'utf8'), initial);
    const directory = join(dataDir, 'workspace', '127.0.0.1', 'seo');
    const report = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    assert.equal(report.summary.legacyBaseline, true);
    assert.equal(report.summary.baselineCompared, false);
    const fresh = join(dataDir, 'new-baseline.json');
    const freshRun = await runAudit(origin, fresh, dataDir, ['--update-baseline']);
    assert.equal(freshRun.code, 0, freshRun.output);
    assert.deepEqual(JSON.parse(readFileSync(fresh, 'utf8')).collection, { version: 1, sitemapCoverage: 'complete' });
    assert.equal(readFileSync(baseline, 'utf8'), initial);
    const compared = await runAudit(origin, fresh, dataDir, ['--fail-on-regression']);
    assert.equal(compared.code, 0, compared.output);
    assert.match(compared.output, /audit-regression/);
    const comparedReport = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    assert.equal(comparedReport.summary.baselineCompared, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: a baseline page omitted by the page limit is unchecked, not removed', { timeout: 60_000 }, async () => {
  let origin;
  const server = createServer((req, res) => {
    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<urlset><url><loc>${origin}/page</loc></url></urlset>`);
    }
    if (req.url === '/page') return res.end('<!doctype html><title>Page</title><h1>Page</h1>');
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-page-limit-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'baseline.json');
    const page = { score: 88, stable: 88, issues: {} };
    const initial = JSON.stringify({ version: 1, scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
      collection: { version: 1, sitemapCoverage: 'complete' }, pages: { [`${origin}/page`]: page, [`${origin}/other`]: page } });
    writeFileSync(baseline, initial);
    for (const [flags, expected] of [[[], 0], [['--fail-on-regression'], 1], [['--update-baseline'], 1]]) {
      const run = await runAudit(origin, baseline, dataDir, flags);
      assert.equal(run.code, expected, run.output);
      assert.match(run.output, /baseline-pages-unchecked/);
      assert.doesNotMatch(run.output, /audit-regression/);
      assert.equal(readFileSync(baseline, 'utf8'), initial);
      const report = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
      assert.equal(report.summary.baselinePagesUnchecked, 1);
      assert.equal(report.summary.baselineEligible, false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('seo gate: a legacy score method is preserved, never compared or overwritten', { timeout: 60_000 }, async () => {
  let origin, hits = 0;
  const server = createServer((req, res) => {
    hits++;
    if (req.url === '/sitemap.xml') {
      res.setHeader('Content-Type', 'application/xml');
      return res.end(`<urlset><url><loc>${origin}/page</loc></url></urlset>`);
    }
    if (req.url === '/page') return res.end('<!doctype html><title>Page</title><h1>Page</h1>');
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-seo-method-'));
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const baseline = join(dataDir, 'legacy.json');
    const original = JSON.stringify({ version: 1, scoreMethodVersion: SEO_SCORE_METHOD_VERSION - 1, measurementVersion: SEO_MEASUREMENT_VERSION, host: '127.0.0.1', origin, score: 88, stable: 88,
      collection: { version: 1, sitemapCoverage: 'complete' }, siteIssues: {},
      pages: { [`${origin}/page`]: { score: 88, stable: 88, issues: { 'content-text-ratio': 'low' } } } });
    writeFileSync(baseline, original);
    for (const flags of [['--require-baseline'], ['--fail-on-regression'], ['--update-baseline']]) {
      const run = await runAudit(origin, baseline, dataDir, flags);
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, /评分口径缺失或不兼容/);
      assert.equal(hits, 0);
      assert.equal(readFileSync(baseline, 'utf8'), original);
    }
    const ordinary = await runAudit(origin, baseline, dataDir, []);
    assert.equal(ordinary.code, 0, ordinary.output);
    assert.match(ordinary.output, /baseline-score-method-mismatch/);
    assert.doesNotMatch(ordinary.output, /audit-regression/);
    assert.equal(readFileSync(baseline, 'utf8'), original);
    const directory = join(dataDir, 'workspace', '127.0.0.1', 'seo');
    const report = JSON.parse(readFileSync(join(directory, 'seo.json'), 'utf8'));
    assert.equal(report.scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
    assert.equal(report.measurementVersion, SEO_MEASUREMENT_VERSION);
    assert.equal(report.summary.baselineMethodMismatch, true);
    assert.equal(report.summary.baselineCompared, false);
    assert.match(readFileSync(join(directory, 'seo.html'), 'utf8'), /评分或测量口径缺失或不兼容/);

    const legacyMeasurement = join(dataDir, 'legacy-measurement.json');
    const measurementOriginal = JSON.stringify({
      version: 1, scoreMethodVersion: SEO_SCORE_METHOD_VERSION, measurementVersion: SEO_MEASUREMENT_VERSION - 1, host: '127.0.0.1', origin, score: 88, stable: 88,
      collection: { version: 1, sitemapCoverage: 'complete' }, siteIssues: {},
      pages: { [`${origin}/page`]: { score: 88, stable: 88, issues: { 'structured-none': 'info' } } },
    });
    writeFileSync(legacyMeasurement, measurementOriginal);
    hits = 0;
    for (const flags of [['--require-baseline'], ['--fail-on-regression'], ['--update-baseline']]) {
      const run = await runAudit(origin, legacyMeasurement, dataDir, flags);
      assert.equal(run.code, 1, run.output);
      assert.match(run.output, /测量口径缺失或不兼容/);
      assert.equal(hits, 0);
      assert.equal(readFileSync(legacyMeasurement, 'utf8'), measurementOriginal);
    }
    const measurementAudit = await runAudit(origin, legacyMeasurement, dataDir, []);
    assert.equal(measurementAudit.code, 0, measurementAudit.output);
    assert.match(measurementAudit.output, /baseline-measurement-method-mismatch/);
    assert.doesNotMatch(measurementAudit.output, /audit-regression/);
    assert.equal(readFileSync(legacyMeasurement, 'utf8'), measurementOriginal);

    const fresh = join(dataDir, 'current.json');
    const created = await runAudit(origin, fresh, dataDir, ['--update-baseline']);
    assert.equal(created.code, 0, created.output);
    assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).scoreMethodVersion, SEO_SCORE_METHOD_VERSION);
    assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).measurementVersion, SEO_MEASUREMENT_VERSION);
    const compared = await runAudit(origin, fresh, dataDir, ['--fail-on-regression', '--tolerance', '1']);
    assert.equal(compared.code, 0, compared.output);
    assert.match(compared.output, /audit-regression/);
    assert.equal(readFileSync(baseline, 'utf8'), original);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
