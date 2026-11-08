import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchRobotsAndSitemaps } from '../src/seo/collect.mjs';
import { evaluateSite } from '../src/seo/rules.mjs';

async function serverFor(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function xml(res, body) {
  res.setHeader('content-type', 'application/xml');
  res.end(body);
}

function siteIssues(result, url) {
  return evaluateSite({
    pages: [{ url, finalUrl: url, status: 200, meta: { noindex: false } }],
    sitemapUrls: result.sitemapUrls,
    sitemapCoverage: result.coverage,
    robots: result.robots,
  }).map(issue => issue.id);
}

test('SEO sitemap follows all local index children but never requests foreign declarations or redirects', async () => {
  let foreignHits = 0;
  const foreign = await serverFor((_req, res) => { foreignHits++; res.end('foreign'); });
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end(`Sitemap: /index.xml\nSitemap: ${foreign.origin}/map.xml`);
    if (req.url === '/index.xml') return xml(res, `<sitemapindex>${Array.from({ length: 6 }, (_, i) =>
      `<sitemap><loc>${origin}/child-${i}.xml</loc></sitemap>`).join('')}<sitemap><loc>${origin}/redirect.xml</loc></sitemap></sitemapindex>`);
    if (req.url.startsWith('/child-')) return xml(res, `<urlset><url><loc>${origin}/page-${req.url.match(/\d+/)[0]}</loc></url></urlset>`);
    if (req.url === '/redirect.xml') { res.writeHead(302, { location: foreign.origin + '/redirected' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const result = await fetchRobotsAndSitemaps(origin);
    assert.equal(foreignHits, 0);
    assert.equal(result.sitemapUrls.size, 6);
    assert.ok(result.sitemapUrls.has(origin + '/page-5'));
    assert.equal(result.coverage, 'partial');
    assert.ok(result.stats.offOriginSitemaps >= 2);
    assert.ok(result.reasons.includes('cross-origin-sitemap'));
    assert.ok(!siteIssues(result, origin + '/other').includes('index-sitemap-missing-page'));
  } finally { await site.close(); await foreign.close(); }
});

test('a failed declared child makes sitemap membership unknown, not a missing-page finding', async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /good.xml\nSitemap: /bad.xml');
    if (req.url === '/good.xml') return xml(res, `<urlset><url><loc>${origin}/known</loc></url></urlset>`);
    if (req.url === '/bad.xml') { res.writeHead(503); return res.end(); }
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const result = await fetchRobotsAndSitemaps(origin);
    assert.equal(result.coverage, 'partial');
    assert.ok(result.reasons.includes('sitemap-request-failed'));
    assert.ok(!siteIssues(result, origin + '/unknown').includes('index-sitemap-missing-page'));
    assert.ok(!siteIssues(result, origin + '/unknown').includes('index-sitemap-missing'));
  } finally { await site.close(); }
});

test('absent, inaccessible, malformed and empty sitemaps have distinct evidence states', async () => {
  let mode = 'absent';
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') {
      if (mode === 'inaccessible') { res.writeHead(503); return res.end(); }
      if (mode === 'html-robots') return res.end('<!doctype html><html><body>Not robots</body></html>');
      return res.end(['absent', 'fallback-failed'].includes(mode) ? '' : 'Sitemap: /map.xml');
    }
    if (req.url === '/sitemap.xml' && mode === 'fallback-failed') { res.writeHead(503); return res.end(); }
    if (req.url === '/map.xml' && mode === 'malformed') return xml(res, '<urlset><url><loc>broken</urlset>');
    if (req.url === '/map.xml' && mode === 'wrong-structure') return xml(res, '<urlset><not-a-url/></urlset>');
    if (req.url === '/map.xml' && mode === 'wrong-text') { res.setHeader('content-type', 'text/plain'); return res.end('Not Found'); }
    if (req.url === '/map.xml' && mode === 'empty') return xml(res, '<urlset></urlset>');
    res.writeHead(404); res.end();
  });
  try {
    const url = site.origin + '/page';
    let result = await fetchRobotsAndSitemaps(site.origin);
    assert.equal(result.coverage, 'not_found');
    assert.ok(siteIssues(result, url).includes('index-sitemap-missing'));
    mode = 'inaccessible';
    result = await fetchRobotsAndSitemaps(site.origin);
    assert.equal(result.coverage, 'unavailable');
    assert.ok(!siteIssues(result, url).includes('index-sitemap-missing'));
    mode = 'fallback-failed';
    result = await fetchRobotsAndSitemaps(site.origin);
    assert.equal(result.coverage, 'unavailable');
    assert.ok(result.reasons.includes('sitemap-request-failed'));
    assert.ok(!siteIssues(result, url).includes('index-sitemap-missing'));
    mode = 'html-robots';
    result = await fetchRobotsAndSitemaps(site.origin);
    assert.equal(result.coverage, 'unavailable');
    mode = 'malformed';
    result = await fetchRobotsAndSitemaps(site.origin);
    assert.equal(result.coverage, 'unavailable');
    assert.ok(result.reasons.includes('unknown-sitemap-format'));
    assert.ok(!siteIssues(result, url).includes('index-sitemap-missing'));
    for (mode of ['wrong-structure', 'wrong-text']) {
      result = await fetchRobotsAndSitemaps(site.origin);
      assert.equal(result.coverage, 'unavailable');
      assert.ok(result.reasons.includes('unknown-sitemap-format'));
    }
    mode = 'empty';
    result = await fetchRobotsAndSitemaps(site.origin);
    assert.equal(result.coverage, 'complete');
    assert.ok(!siteIssues(result, url).includes('index-sitemap-missing'));
    assert.ok(siteIssues(result, url).includes('index-sitemap-missing-page'));
  } finally { await site.close(); }
});

test('sitemap page membership uses the same URL normalization as discovery', () => {
  const result = { coverage: 'complete', sitemapUrls: new Set(['https://example.test/path?a=1']), robots: { status: 200 } };
  assert.ok(!siteIssues(result, 'https://example.test/path/?a=1').includes('index-sitemap-missing-page'));
});

test('watch refuses comparison and baseline update when sitemap discovery is incomplete', { timeout: 30_000 }, async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /good.xml\nSitemap: /bad.xml');
    if (req.url === '/good.xml') return xml(res, `<urlset><url><loc>${origin}/page</loc></url></urlset>`);
    if (req.url === '/bad.xml') { res.writeHead(503); return res.end(); }
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-watch-sitemap-'));
  const directory = join(root, 'workspace', '127.0.0.1', 'watch');
  mkdirSync(directory, { recursive: true });
  const original = JSON.stringify({ host: '127.0.0.1', pages: { [origin + '/old']: {} } });
  const baseline = join(directory, 'baseline.json');
  writeFileSync(baseline, original);
  try {
    const script = fileURLToPath(new URL('../src/watch/watch.mjs', import.meta.url));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, origin, '--max', '1', '--accept', '--no-stability'], {
        env: { ...process.env, HEIMDALL_DATA_DIR: root },
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /sitemap discovery incomplete/);
    assert.equal(readFileSync(baseline, 'utf8'), original);
    assert.equal(existsSync(join(directory, 'watch.json')), false);
  } finally { await site.close(); rmSync(root, { recursive: true, force: true }); }
});
