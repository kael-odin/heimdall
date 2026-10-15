import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSitemapUrls } from '../src/crawler/sitemap-discovery.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

async function serverFor(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

function xmlResponse(res, body, compressed = false) {
  res.setHeader('content-type', 'application/xml');
  res.end(compressed ? gzipSync(body) : body);
}

test('robots directives, nested indexes, gzip, XML entities and CDATA discover only same-origin pages', async () => {
  const hits = [];
  let foreignHits = 0;
  const foreign = await serverFor((_req, res) => { foreignHits++; res.end('foreign'); });
  let origin;
  const site = await serverFor((req, res) => {
    hits.push(req.url);
    if (req.url === '/robots.txt') return res.end(`User-agent: *\nSitemap: /maps/top.xml\nSitemap: ${foreign.origin}/outside.xml\n`);
    if (req.url === '/maps/top.xml') return xmlResponse(res,
      `<?xml version="1.0"?><sm:sitemapindex xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9"><sm:sitemap><sm:loc>${origin}/maps/inner.xml</sm:loc></sm:sitemap></sm:sitemapindex>`);
    if (req.url === '/maps/inner.xml') return xmlResponse(res,
      `<sitemapindex><sitemap><loc>${origin}/maps/pages.xml.gz</loc></sitemap><sitemap><loc>${origin}/maps/cross-redirect.xml</loc></sitemap></sitemapindex>`);
    if (req.url === '/maps/pages.xml.gz') return xmlResponse(res,
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/deep?a=1&amp;b=2</loc></url><url><loc><![CDATA[${origin}/cdata]]></loc></url><url><loc>/relative</loc></url><url><loc>${foreign.origin}/evil</loc></url><url><loc>${origin}/deep?a=1&amp;b=2</loc></url></urlset>`, true);
    if (req.url === '/maps/cross-redirect.xml') { res.writeHead(302, { location: foreign.origin + '/redirect-target' }); return res.end(); }
    if (req.url === '/sitemap.xml') return xmlResponse(res, `<urlset><url><loc>${origin}/fallback</loc></url></urlset>`);
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const result = await discoverSitemapUrls(origin);
    assert.deepEqual(result.urls, [origin + '/deep?a=1&b=2', origin + '/cdata', origin + '/relative', origin + '/fallback']);
    assert.equal(result.stats.robotsSitemaps, 2);
    assert.equal(result.stats.offOriginSitemaps, 2);
    assert.equal(result.stats.offOriginPages, 1);
    assert.equal(result.stats.sitemapFilesRead, 4);
    assert.equal(foreignHits, 0, 'foreign sitemap and redirected origin must never be fetched');
    assert.ok(hits.includes('/maps/pages.xml.gz'));
    assert.deepEqual(result.stats.truncated, []);
  } finally {
    await Promise.all([site.close(), foreign.close()]);
  }
});

test('same-origin redirects, text sitemaps and UTF-16 XML are accepted', async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /jump.xml\nSitemap: /pages.txt\nSitemap: /utf16.xml');
    if (req.url === '/jump.xml') { res.writeHead(301, { location: '/real.xml' }); return res.end(); }
    if (req.url === '/real.xml') return xmlResponse(res, `<urlset><url><loc>${origin}/redirected</loc></url></urlset>`);
    if (req.url === '/pages.txt') {
      res.setHeader('content-type', 'text/plain');
      return res.end(`${origin}/plain\nhttps://other.example/outside\n`);
    }
    if (req.url === '/utf16.xml') {
      res.setHeader('content-type', 'application/xml');
      return res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`<urlset><url><loc>${origin}/utf16</loc></url></urlset>`, 'utf16le')]));
    }
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const result = await discoverSitemapUrls(origin);
    assert.deepEqual(result.urls, [origin + '/redirected', origin + '/plain', origin + '/utf16']);
    assert.equal(result.stats.offOriginPages, 1);
    assert.equal(result.stats.sitemapFilesRead, 3);
  } finally { await site.close(); }
});

test('cyclic sitemap indexes terminate and report depth, URL and document byte limits', async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /index.xml');
    if (req.url === '/index.xml') return xmlResponse(res,
      `<sitemapindex><sitemap><loc>${origin}/index.xml</loc></sitemap><sitemap><loc>${origin}/child.xml</loc></sitemap></sitemapindex>`);
    if (req.url === '/child.xml') return xmlResponse(res,
      `<urlset><url><loc>${origin}/one</loc></url><url><loc>${origin}/two</loc></url></urlset>`);
    if (req.url === '/sitemap.xml') return xmlResponse(res, `<urlset><url><loc>${origin}/oversize</loc></url>${' '.repeat(500)}</urlset>`);
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const limited = await discoverSitemapUrls(origin, { limits: { maxDepth: 0, maxDocumentBytes: 200 } });
    assert.deepEqual(limited.urls, []);
    assert.ok(limited.stats.truncated.includes('depth-limit'));
    assert.ok(limited.stats.truncated.includes('document-byte-limit'));
    assert.equal(limited.stats.sitemapFilesRead, 1);

    const urlLimited = await discoverSitemapUrls(origin, { limits: { maxUrls: 1 } });
    assert.deepEqual(urlLimited.urls, [origin + '/one']);
    assert.ok(urlLimited.stats.truncated.includes('url-limit'));
    assert.ok(urlLimited.stats.sitemapFilesAttempted < 10, 'index cycle must not recurse forever');
  } finally { await site.close(); }
});

test('sitemap file and total byte budgets leave explicit truncation evidence', async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /index.xml');
    if (req.url === '/index.xml') return xmlResponse(res,
      `<sitemapindex><sitemap><loc>${origin}/a.xml</loc></sitemap><sitemap><loc>${origin}/b.xml</loc></sitemap></sitemapindex>`);
    if (req.url === '/a.xml') return xmlResponse(res, `<urlset><url><loc>${origin}/a</loc></url></urlset>`);
    if (req.url === '/b.xml') return xmlResponse(res, `<urlset><url><loc>${origin}/b</loc></url></urlset>`);
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const files = await discoverSitemapUrls(origin, { limits: { maxFiles: 2 } });
    assert.deepEqual(files.urls, [origin + '/a']);
    assert.equal(files.stats.sitemapFilesAttempted, 2);
    assert.ok(files.stats.truncated.includes('file-limit'));

    const bytes = await discoverSitemapUrls(origin, { limits: { maxTotalBytes: 60 } });
    assert.deepEqual(bytes.urls, []);
    assert.ok(bytes.stats.truncated.includes('total-byte-limit'));
    assert.ok(bytes.stats.bytesRead > 60);
  } finally { await site.close(); }
});

test('compressed sitemap expansion respects the decoded document limit', async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /large.xml.gz');
    if (req.url === '/large.xml.gz') return xmlResponse(res,
      `<urlset>${`<url><loc>${origin}/a</loc></url>`.repeat(20)}</urlset>`, true);
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  try {
    const result = await discoverSitemapUrls(origin, { limits: { maxDocumentBytes: 100 } });
    assert.deepEqual(result.urls, []);
    assert.ok(result.stats.truncated.includes('document-byte-limit'));
  } finally { await site.close(); }
});

test('a robots-declared sitemap HTTP failure is recorded separately from optional fallback absence', async () => {
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /required.xml');
    if (req.url === '/required.xml') { res.writeHead(503); return res.end(); }
    res.writeHead(404); res.end();
  });
  try {
    const result = await discoverSitemapUrls(site.origin);
    assert.equal(result.stats.declaredSitemapFailures, 1);
    assert.equal(result.stats.sitemapFilesFailed, 1);
  } finally { await site.close(); }
});

test('recon atlas records sitemap discovery limits and visits pages reached through nested indexes', { timeout: 60_000 }, async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /top.xml');
    if (req.url === '/top.xml') return xmlResponse(res, `<sitemapindex><sitemap><loc>${origin}/nested.xml</loc></sitemap></sitemapindex>`);
    if (req.url === '/nested.xml') return xmlResponse(res,
      `<urlset><url><loc>${origin}/unlinked</loc></url><url><loc>https://foreign.invalid/ignored</loc></url></urlset>`);
    if (req.url === '/' || req.url === '/unlinked') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(`<html><head><title>${req.url}</title></head><body>Page</body></html>`);
    }
    res.writeHead(404); res.end();
  });
  origin = site.origin;
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-sitemap-recon-'));
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/crawler/recon.mjs', origin, '3', '0'], {
        cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
      });
      let output = '';
      child.stdout.on('data', part => { output += part; });
      child.stderr.on('data', part => { output += part; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(run.code, 0, run.output);
    const atlas = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json'), 'utf8'));
    assert.deepEqual(atlas.nodes.map(node => node.url), [origin + '/', origin + '/unlinked']);
    assert.equal(atlas.meta.sitemapUrls, 1);
    assert.equal(atlas.meta.sitemap.sitemapFilesRead, 2);
    assert.equal(atlas.meta.sitemap.offOriginPages, 1);
    assert.deepEqual(atlas.meta.sitemap.truncated, []);
    assert.equal(atlas.meta.depthLimitReached, false);
  } finally {
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recon records same-origin links left unexplored by the BFS depth bound', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end('<html><head><title>Home</title></head><body><a href="/deeper">Deeper</a></body></html>');
    }
    if (req.url === '/deeper') return res.end('<html><body>Deeper</body></html>');
    res.writeHead(404); res.end();
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-sitemap-depth-'));
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/crawler/recon.mjs', site.origin, '3', '0'], {
        cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
      });
      let output = '';
      child.stdout.on('data', part => { output += part; });
      child.stderr.on('data', part => { output += part; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(run.code, 0, run.output);
    const atlas = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json'), 'utf8'));
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/']);
    assert.equal(atlas.meta.depthLimitReached, true);
    assert.equal(atlas.meta.depthLimitUrls, 1);
  } finally {
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recon counts in-flight visits against the page budget', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/') {
      return res.end('<html><body>' + Array.from({ length: 8 }, (_, i) =>
        `<a href="/page-${i}">Page ${i}</a>`).join('') + '</body></html>');
    }
    res.end('<html><body>Page</body></html>');
  });
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-recon-budget-'));
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/crawler/recon.mjs', site.origin, '3', '1'], {
        cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
      });
      let output = '';
      child.stdout.on('data', part => { output += part; });
      child.stderr.on('data', part => { output += part; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(run.code, 0, run.output);
    const atlas = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json'), 'utf8'));
    assert.equal(atlas.meta.maxPages, 3);
    assert.equal(atlas.nodes.length, 3);
  } finally {
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recon gives discovered nearby links priority over unrelated sitemap pages', { timeout: 60_000 }, async () => {
  let origin;
  const site = await serverFor((req, res) => {
    if (req.url === '/robots.txt') return res.end('Sitemap: /sitemap.xml');
    if (req.url === '/sitemap.xml') return xmlResponse(res,
      `<urlset><url><loc>${origin}/unrelated-one</loc></url><url><loc>${origin}/unrelated-two</loc></url></urlset>`);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url === '/section' || req.url === '/section/') {
      return res.end('<html><body><a href="/section/walk">Walk</a><a href="/section/about">About</a></body></html>');
    }
    return res.end('<html><body>Page</body></html>');
  });
  origin = site.origin;
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-recon-bfs-priority-'));
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/crawler/recon.mjs', origin + '/section/', '3', '1'], {
        cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
      });
      let output = '';
      child.stdout.on('data', part => { output += part; });
      child.stderr.on('data', part => { output += part; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(run.code, 0, run.output);
    const atlas = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json'), 'utf8'));
    assert.deepEqual(atlas.nodes.map(node => node.url),
      [origin + '/section', origin + '/section/about', origin + '/section/walk']);
    assert.equal(atlas.meta.sitemapUrls, 2);
  } finally {
    await site.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
