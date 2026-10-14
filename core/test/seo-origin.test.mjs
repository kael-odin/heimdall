import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverTargets } from '../src/seo/collect.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

function listen(server, port) {
  return new Promise(resolve => {
    const onError = () => resolve(false);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      resolve(true);
    });
  });
}

async function startPrefixCollisionSites() {
  let lookalikeOrigin = '';
  let evilHits = 0;
  for (let port = 3400; port <= 6000; port++) {
    const site = createServer((req, res) => {
      if (req.url === '/' || req.url === '/ok') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<html lang="en"><head><title>Fixture</title></head><body><h1>Fixture</h1><a href="/ok">OK</a><a href="${lookalikeOrigin}/evil">Other origin</a></body></html>`);
      } else { res.writeHead(404); res.end(); }
    });
    if (!await listen(site, port)) continue;
    const lookalike = createServer((req, res) => {
      if (req.url === '/evil') evilHits++;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<html lang="en"><head><title>Other</title></head><body><h1>Other</h1></body></html>');
    });
    const lookalikePort = port * 10 + 1;
    if (await listen(lookalike, lookalikePort)) {
      lookalikeOrigin = `http://127.0.0.1:${lookalikePort}`;
      return {
        origin: `http://127.0.0.1:${port}`,
        lookalikeOrigin,
        evilHits: () => evilHits,
        close: async () => {
          await Promise.all([site, lookalike].map(server => new Promise(resolve => server.close(resolve))));
        },
      };
    }
    await new Promise(resolve => site.close(resolve));
  }
  throw new Error('no available prefix-collision port pair');
}

function runCli(script, args, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_PSI_KEY: '', HEIMDALL_LLM: '0' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

test('SEO sitemap discovery rejects lookalike and foreign origins', async () => {
  const urls = new Set([
    'https://example.com/docs',
    'https://example.com.evil/docs',
    'https://other.example/docs',
  ]);
  const targets = await discoverTargets(null, 'https://example.com', { sitemapUrls: urls });
  assert.deepEqual(targets.map(t => t.url), ['https://example.com/docs']);
});

test('recon BFS and SEO atlas reuse reject a URL that only shares the origin prefix', { timeout: 120_000 }, async () => {
  const sites = await startPrefixCollisionSites();
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-origin-'));
  try {
    assert.ok(sites.lookalikeOrigin.startsWith(sites.origin));
    const recon = await runCli('src/crawler/recon.mjs', [sites.origin, '5', '1'], dataDir);
    assert.equal(recon.code, 0, recon.output);
    const atlasPath = join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json');
    const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
    assert.deepEqual(atlas.nodes.map(node => node.url), [sites.origin + '/', sites.origin + '/ok']);
    assert.equal(sites.evilHits(), 0, 'recon must not request the lookalike origin');

    atlas.nodes.unshift({ id: 'lookalike', url: sites.lookalikeOrigin + '/evil', path: '/evil', type: 'page', depth: 1 });
    writeFileSync(atlasPath, JSON.stringify(atlas));
    const audit = await runCli('src/seo/audit.mjs', [sites.origin, '--max', '2'], dataDir);
    assert.equal(audit.code, 0, audit.output);
    const report = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
    assert.equal(report.config.source, 'atlas');
    assert.deepEqual(report.pages.map(page => page.url), [sites.origin + '/', sites.origin + '/ok']);
    assert.equal(sites.evilHits(), 0, 'audit must not request the lookalike origin from an old atlas');
  } finally {
    await sites.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
