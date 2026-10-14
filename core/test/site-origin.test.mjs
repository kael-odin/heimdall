import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSiteOrigin, findSiteIdentity, readSiteIdentity, siteIdForOrigin } from '../src/site-origin.mjs';
import { planFullshots } from '../src/crawler/fullshot.mjs';
import { planCssRefRepair } from '../src/crawler/repair-css-refs.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

function runCli(script, args, dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_LLM: '0' },
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('legacy atlas and manifests retain their origin and reject a different port', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-'));
  const site = join(dataDir, 'workspace', 'fixture.test');
  const atlas = join(site, 'recon', 'atlas.json');
  const manifest = join(site, 'pages', 'home', 'manifest.json');
  try {
    mkdirSync(join(site, 'recon'), { recursive: true });
    mkdirSync(join(site, 'pages', 'home'), { recursive: true });
    writeFileSync(atlas, JSON.stringify({ nodes: [{ url: 'https://fixture.test:8443/' }] }));
    writeFileSync(manifest, JSON.stringify({ target: 'https://fixture.test:8443/' }));
    assert.equal(assertSiteOrigin(site, 'https://FIXTURE.TEST:8443/other', { claim: true }), 'https://fixture.test:8443');
    assert.equal(JSON.parse(readFileSync(join(site, 'site-origin.json'), 'utf8')).origin, 'https://fixture.test:8443');
    assert.throws(() => assertSiteOrigin(site, 'https://fixture.test:9443/'),
      error => error.code === 'origin-conflict' && /8443/.test(error.message) && /9443/.test(error.message));

    writeFileSync(manifest, JSON.stringify({ target: 'https://fixture.test:9443/' }));
    assert.throws(() => assertSiteOrigin(site, 'https://fixture.test:8443/', { pageName: 'home' }),
      error => error.code === 'origin-conflict' && /pages\/home\/manifest.json/.test(error.message));
    rmSync(join(site, 'site-origin.json'));
    assert.throws(() => assertSiteOrigin(site, 'https://fixture.test:8443/'),
      error => error.code === 'origin-conflict' && /pages\/home\/manifest.json/.test(error.message));
    assert.equal(existsSync(join(site, 'site-origin.json')), false, 'mixed legacy directory must remain unclaimed');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('same hostname origins get deterministic sibling site ids without changing the legacy directory', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-siblings-'));
  const legacy = join(dataDir, 'workspace', 'fixture.test');
  try {
    mkdirSync(join(legacy, 'recon'), { recursive: true });
    writeFileSync(join(legacy, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://fixture.test:8443', nodes: [] }));
    const a = siteIdForOrigin(join(dataDir, 'workspace'), 'https://fixture.test:8443/');
    const b = siteIdForOrigin(join(dataDir, 'workspace'), 'https://fixture.test:9443/');
    assert.equal(a, 'fixture.test');
    assert.match(b, /^fixture\.test--origin-[0-9a-f]{16}$/);
    assert.equal(siteIdForOrigin(join(dataDir, 'workspace'), 'https://fixture.test:9443/'), b);
    assert.equal(siteIdForOrigin(join(dataDir, 'workspace'), new URL('https://fixture.test:9443/')), b);
    assert.equal(existsSync(join(dataDir, 'workspace', b)), false, 'resolution must not create data');
    assert.equal(JSON.parse(readFileSync(join(legacy, 'recon', 'atlas.json'), 'utf8')).origin,
      'https://fixture.test:8443');
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('IPv6 origins use Windows-safe scoped IDs across identity and maintenance tools', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-ipv6-'));
  const workspace = join(dataDir, 'workspace');
  const origins = ['http://[::1]:8080', 'http://[::1]:9090', 'https://[::1]:8080'];
  try {
    const ids = origins.map(origin => siteIdForOrigin(workspace, origin));
    assert.equal(new Set(ids).size, origins.length);
    for (let i = 0; i < ids.length; i++) {
      assert.match(ids[i], /^ipv6-[0-9a-f]{16}--origin-[0-9a-f]{16}$/);
      assert.equal(ids[i].includes(':'), false);
      assert.equal(siteIdForOrigin(workspace, origins[i]), ids[i]);
    }
    const site = join(workspace, ids[0]);
    const page = join(site, 'pages', 'home');
    mkdirSync(page, { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: origins[0] + '/' }));
    assert.equal(assertSiteOrigin(site, origins[0], { claim: true }), origins[0]);
    assert.equal(readSiteIdentity(workspace, ids[0])?.origin, origins[0]);
    assert.equal(findSiteIdentity(workspace, origins[0])?.siteId, ids[0]);
    assert.deepEqual(planFullshots({ workspace, host: ids[0] }).targets.map(item => item.name), ['home']);
    assert.equal(planCssRefRepair({ workspace, host: ids[0] }).files.length, 0);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('pipeline and direct capture never write a colliding origin into the legacy site', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-cli-'));
  const site = join(dataDir, 'workspace', '127.0.0.1');
  const atlas = join(site, 'recon', 'atlas.json');
  try {
    mkdirSync(join(site, 'recon'), { recursive: true });
    const before = JSON.stringify({ origin: 'http://127.0.0.1:3001', nodes: [] });
    writeFileSync(atlas, before);
    const target = 'http://127.0.0.1:3002/';
    for (const [script, args] of [
      ['src/pipeline.mjs', [target, 'home']],
      ['src/crawler/capture.mjs', [target, join(site, 'pages', 'home')]],
    ]) {
      const result = await runCli(script, args, dataDir);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /3002|目标站点 127\.0\.0\.1--origin-/, result.output);
      assert.equal(existsSync(join(site, 'pages', 'home')), false, script);
      assert.equal(readFileSync(atlas, 'utf8'), before, script);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('capture rejects landed redirects across ports or hosts before changing page artifacts', { timeout: 120_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-capture-redirect-'));
  const site = join(dataDir, 'workspace', '127.0.0.1');
  const pageDir = join(site, 'pages', 'home');
  const landing = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body>OTHER ORIGIN</body></html>');
  });
  await new Promise(resolve => landing.listen(0, '127.0.0.1', resolve));
  let origin;
  const source = createServer((req, res) => {
    if (req.url === '/cross-port') {
      res.writeHead(302, { location: `http://127.0.0.1:${landing.address().port}/` });
      return res.end();
    }
    if (req.url === '/cross-host') {
      res.writeHead(302, { location: `http://localhost:${source.address().port}/landed` });
      return res.end();
    }
    if (req.url === '/same-origin') {
      res.writeHead(302, { location: '/landed' });
      return res.end();
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><body>SAME ORIGIN LANDING</body></html>');
  });
  await new Promise(resolve => source.listen(0, resolve));
  origin = `http://127.0.0.1:${source.address().port}`;
  try {
    mkdirSync(dirname(join(site, 'recon', 'atlas.json')), { recursive: true });
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({ origin, nodes: [] }));
    const oldManifest = JSON.stringify({ target: origin + '/old' });
    writeFileSync(join(pageDir, 'manifest.json'), oldManifest);
    writeFileSync(join(pageDir, 'dom.html'), 'OLD DOM');

    for (const path of ['/cross-port', '/cross-host']) {
      const result = await runCli('src/crawler/capture.mjs', [origin + path, pageDir], dataDir);
      assert.notEqual(result.code, 0, result.output);
      assert.match(result.output, /捕获重定向跨 origin[\s\S]*已拒绝写入/, result.output);
      assert.equal(readFileSync(join(pageDir, 'manifest.json'), 'utf8'), oldManifest, path);
      assert.equal(readFileSync(join(pageDir, 'dom.html'), 'utf8'), 'OLD DOM', path);
      for (const name of ['network.har', 'motion.json', 'styles', 'assets']) {
        assert.equal(existsSync(join(pageDir, name)), false, `${path}: ${name} was written`);
      }
      assert.equal(existsSync(join(site, 'site-origin.json')), false, path);
    }

    const pipeline = await runCli('src/pipeline.mjs', [origin + '/cross-port', 'new-page'], dataDir);
    assert.notEqual(pipeline.code, 0, pipeline.output);
    assert.equal(existsSync(join(site, 'pages', 'new-page')), false, 'pipeline must not precreate a failed page');

    const sameDir = join(site, 'pages', 'same-origin');
    const same = await runCli('src/crawler/capture.mjs', [origin + '/same-origin', sameDir], dataDir);
    assert.equal(same.code, 0, same.output);
    assert.match(readFileSync(join(sameDir, 'dom.html'), 'utf8'), /SAME ORIGIN LANDING/);
    assert.equal(JSON.parse(readFileSync(join(sameDir, 'manifest.json'), 'utf8')).target, origin + '/same-origin');
    assert.equal(JSON.parse(readFileSync(join(site, 'site-origin.json'), 'utf8')).origin, origin);
  } finally {
    await Promise.all([source, landing].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('explicit CLI page names reject directory traversal before writing files', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-page-name-cli-'));
  const site = join(dataDir, 'workspace', 'fixture.test');
  const sentinel = join(site, 'escape', 'keep.txt');
  try {
    mkdirSync(dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'keep');
    for (const [script, args] of [
      ['src/pipeline.mjs', ['https://fixture.test/', '../escape']],
      ['src/crawler/multi-snapshot.mjs', ['fixture.test', '..\\escape']],
      ['src/verify/verify.mjs', ['fixture.test', '..', '--page-dir', join(site, 'pages', 'home')]],
      ['src/sandbox/serve.mjs', ['fixture.test', '../escape']],
      ['src/crawler/build_live.mjs', ['fixture.test', '../escape']],
      ['src/extract/extract-tokens.mjs', ['fixture.test', '--page', '../escape']],
    ]) {
      const result = await runCli(script, args, dataDir);
      assert.notEqual(result.code, 0, script + ': ' + result.output);
      assert.match(result.output, /页名无效/, script + ': ' + result.output);
      assert.equal(readFileSync(sentinel, 'utf8'), 'keep', script);
      assert.equal(existsSync(join(site, 'site-origin.json')), false, script);
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recon writes a colliding landed origin to a sibling without replacing legacy atlas or thumbnails', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-recon-'));
  const site = join(dataDir, 'workspace', '127.0.0.1');
  const atlas = join(site, 'recon', 'atlas.json');
  const source = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Other site</title></head><body>Other site</body></html>');
  });
  await new Promise(resolve => source.listen(0, '127.0.0.1', resolve));
  try {
    const port = source.address().port;
    mkdirSync(join(site, 'recon'), { recursive: true });
    const before = JSON.stringify({ origin: `http://127.0.0.1:${port + 1}`, nodes: [] });
    writeFileSync(atlas, before);
    const result = await runCli('src/crawler/recon.mjs', [`http://127.0.0.1:${port}/`, '5', '1'], dataDir);
    assert.equal(result.code, 0, result.output);
    const sibling = siteIdForOrigin(join(dataDir, 'workspace'), `http://127.0.0.1:${port}/`);
    assert.match(sibling, /^127\.0\.0\.1--origin-[0-9a-f]{16}$/);
    assert.equal(JSON.parse(readFileSync(join(dataDir, 'workspace', sibling, 'recon', 'atlas.json'), 'utf8')).origin,
      `http://127.0.0.1:${port}`);
    assert.equal(readFileSync(atlas, 'utf8'), before);
    assert.equal(existsSync(join(site, 'recon', 'thumbs')), false);
  } finally {
    await new Promise(resolve => source.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recon accepts a redirect that lands on the workspace origin', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-redirect-'));
  const site = join(dataDir, 'workspace', '127.0.0.1');
  const atlas = join(site, 'recon', 'atlas.json');
  const landing = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<html><head><title>Landing</title></head><body>Landing</body></html>');
  });
  await new Promise(resolve => landing.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${landing.address().port}`;
  const redirect = createServer((req, res) => {
    res.writeHead(302, { location: origin + '/' });
    res.end();
  });
  await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve));
  try {
    mkdirSync(join(site, 'recon'), { recursive: true });
    writeFileSync(atlas, JSON.stringify({ origin, nodes: [{ url: origin + '/' }] }));
    const result = await runCli('src/crawler/recon.mjs',
      [`http://127.0.0.1:${redirect.address().port}/`, '5', '1'], dataDir);
    assert.equal(result.code, 0, result.output);
    assert.equal(JSON.parse(readFileSync(atlas, 'utf8')).origin, origin);
    assert.equal(JSON.parse(readFileSync(join(site, 'site-origin.json'), 'utf8')).origin, origin);
  } finally {
    await Promise.all([landing, redirect].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('two live ports remain separate through recon, site/page APIs and static atlas reads', { timeout: 90_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-two-origins-'));
  const sources = [0, 1].map(i => createServer((_req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<html><head><title>Origin ${i}</title></head><body>Origin ${i}</body></html>`);
  }));
  for (const server of sources) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origins = sources.map(server => `http://127.0.0.1:${server.address().port}`);
  const enginePort = await freePort();
  let engine;
  try {
    const ids = [];
    for (const origin of origins) {
      const result = await runCli('src/crawler/recon.mjs', [origin + '/', '2', '0'], dataDir);
      assert.equal(result.code, 0, result.output);
      ids.push(siteIdForOrigin(join(dataDir, 'workspace'), origin));
    }
    assert.notEqual(ids[0], ids[1]);
    for (let i = 0; i < ids.length; i++) {
      const page = join(dataDir, 'workspace', ids[i], 'pages', 'home');
      mkdirSync(join(page, 'clone'), { recursive: true });
      writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: origins[i] + '/' }));
      writeFileSync(join(page, 'clone', 'index.html'), `<html>Origin ${i}</html>`);
    }
    engine = spawn(process.execPath, ['src/engine-server.mjs', String(enginePort)], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_TOKEN: 'origin-test', HEIMDALL_HOST: '127.0.0.1' },
      stdio: 'ignore',
    });
    const base = `http://127.0.0.1:${enginePort}`;
    const headers = { 'x-heimdall-token': 'origin-test' };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ready = (await fetch(base + '/api/status', { headers })).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'engine did not start');
    const sites = (await (await fetch(base + '/api/sites', { headers })).json()).sites;
    for (let i = 0; i < ids.length; i++) {
      assert.equal(sites.find(site => site.host === ids[i])?.origin, origins[i]);
      const pages = await (await fetch(base + `/api/pages/${ids[i]}`, { headers })).json();
      assert.equal(pages.pages.length, 1);
      assert.equal(pages.pages[0].target, origins[i] + '/');
      const atlas = await (await fetch(base + `/static/${ids[i]}/recon/atlas.json`, { headers })).json();
      assert.equal(atlas.origin, origins[i]);
    }
  } finally {
    if (engine && engine.exitCode === null && engine.signalCode === null) {
      engine.kill();
      await new Promise(resolve => engine.once('exit', resolve));
    }
    await Promise.all(sources.map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('engine API isolates same-host forge origins, encoded page traversal and unconfirmed site deletion', { timeout: 30_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-site-origin-api-'));
  const atlas = join(dataDir, 'workspace', 'fixture.test', 'recon', 'atlas.json');
  mkdirSync(dirname(atlas), { recursive: true });
  writeFileSync(atlas, JSON.stringify({ origin: 'https://fixture.test', nodes: [] }));
  const port = await freePort();
  const engine = spawn(process.execPath, ['src/engine-server.mjs', String(port)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_TOKEN: 'test-token', HEIMDALL_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { ready = (await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'test-token' } })).ok; }
      catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'engine did not start');
    const response = await fetch(base + '/api/forge', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-heimdall-token': 'test-token' },
      body: JSON.stringify({ url: 'http://fixture.test/' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.siteId, /^fixture\.test--origin-[0-9a-f]{16}$/);
    assert.equal(existsSync(join(dataDir, 'workspace', body.siteId, 'pages')), false);
    assert.equal(existsSync(join(dataDir, 'workspace', 'fixture.test', 'site-origin.json')), false);
    await fetch(base + '/api/jobs/' + encodeURIComponent(body.taskId) + '/cancel', {
      method: 'POST', headers: { 'x-heimdall-token': 'test-token' },
    });

    const deleted = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, method: 'DELETE',
        path: '/api/sites/fixture.test/pages/%2e%2e', headers: { 'x-heimdall-token': 'test-token' } }, res => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.once('error', reject);
      req.end();
    });
    assert.equal(deleted, 400);
    assert.equal(existsSync(atlas), true, 'encoded .. must not become a whole-site deletion');

    const deleteSite = (body) => fetch(base + '/api/sites/fixture.test', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'x-heimdall-token': 'test-token' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal((await deleteSite()).status, 400);
    assert.equal(existsSync(atlas), true, 'site must survive a missing confirmation');
    assert.equal((await deleteSite({ confirmHost: 'other.test' })).status, 400);
    assert.equal(existsSync(atlas), true, 'site must survive a wrong confirmation');
    const confirmed = await deleteSite({ confirmHost: 'fixture.test' });
    assert.equal(confirmed.status, 200);
    assert.equal((await confirmed.json()).removed, 'site');
    assert.equal(existsSync(join(dataDir, 'workspace', 'fixture.test')), false);
  } finally {
    if (engine.exitCode === null && engine.signalCode === null) {
      engine.kill();
      await new Promise(resolve => engine.once('exit', resolve));
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});
