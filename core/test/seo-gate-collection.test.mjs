import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AUDIT = fileURLToPath(new URL('../src/seo/audit.mjs', import.meta.url));

function runAudit(origin, baseline, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AUDIT, origin, '--max', '1', '--baseline', baseline, '--update-baseline'], {
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
