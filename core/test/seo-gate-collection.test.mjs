import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    assert.equal(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'history.json')), false);
    const thresholdRun = await runAudit(origin, baseline, dataDir, ['--threshold', '1']);
    assert.equal(thresholdRun.code, 1, thresholdRun.output);
    assert.match(thresholdRun.output, /未从目标来源成功采集/);
    assert.equal(existsSync(baseline), false);
    const initial = JSON.stringify({ version: 1, scoreMethodVersion: 2, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
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
      version: 1, scoreMethodVersion: 2, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
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
      version: 1, scoreMethodVersion: 2, host: '127.0.0.1', origin, score: 88, stable: 88,
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
    const initial = JSON.stringify({ version: 1, scoreMethodVersion: 2, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
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
    const original = JSON.stringify({ version: 1, host: '127.0.0.1', origin, score: 88, stable: 88,
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
    assert.equal(report.scoreMethodVersion, 2);
    assert.equal(report.measurementVersion, 2);
    assert.equal(report.summary.baselineMethodMismatch, true);
    assert.equal(report.summary.baselineCompared, false);
    assert.match(readFileSync(join(directory, 'seo.html'), 'utf8'), /评分口径缺失或不兼容/);
    const fresh = join(dataDir, 'current.json');
    const created = await runAudit(origin, fresh, dataDir, ['--update-baseline']);
    assert.equal(created.code, 0, created.output);
    assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).scoreMethodVersion, 2);
    const compared = await runAudit(origin, fresh, dataDir, ['--fail-on-regression', '--tolerance', '1']);
    assert.equal(compared.code, 0, compared.output);
    assert.match(compared.output, /audit-regression/);
    assert.equal(readFileSync(baseline, 'utf8'), original);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
