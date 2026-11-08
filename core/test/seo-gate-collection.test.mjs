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
      version: 1, host: '127.0.0.1', origin, score: 88, stable: 88, siteIssues: {},
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
