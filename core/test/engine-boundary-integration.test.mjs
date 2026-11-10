import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openJobStore } from '../src/jobs/store.mjs';
import { liveSnapshotPath } from '../src/live/live-path.mjs';

const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const CORE = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startEngine(dir, port, preload = '') {
  const args = [...(preload ? ['--import', 'data:text/javascript,' + encodeURIComponent(preload)] : []), ENGINE, String(port)];
  const proc = spawn(process.execPath, args, {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dir, HEIMDALL_TOKEN: 'test-token', HEIMDALL_HOST: '127.0.0.1' }, stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const result = await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'test-token' } });
      if (result.ok) return { proc, base };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  throw new Error('engine did not start on isolated port');
}

async function stopEngine(proc) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  await new Promise(resolve => proc.once('exit', resolve));
}

function requestWithHost(port, path, host, { method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, res => {
      const chunks = [];
      res.on('data', part => chunks.push(part));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
function getWithHost(port, path, host, headers = {}) {
  return requestWithHost(port, path, host, { headers });
}

function runNode(args, dir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dir, HEIMDALL_API: 'http://127.0.0.1:9' } });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('child timed out: ' + output)); }, 60_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('current page and agent results reject a real measurement after CSS changes', { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-current-verify-'));
  const fixture = createServer((req, res) => {
    res.writeHead(200, { 'content-type': req.url === '/style.css' ? 'text/css' : 'text/html' });
    res.end(req.url === '/style.css' ? 'body { background: red; }'
      : '<!doctype html><link rel="stylesheet" href="/style.css"><h1>Fixture</h1>');
  });
  let engine;
  try {
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    const page = join(dir, 'workspace', '127.0.0.1', 'pages', 'home');
    mkdirSync(join(page, 'clone'), { recursive: true });
    writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: origin + '/' }));
    writeFileSync(join(page, 'clone', 'index.html'), '<!doctype html><link rel="stylesheet" href="style.css"><h1>Fixture</h1>');
    const css = join(page, 'clone', 'style.css');
    writeFileSync(css, 'body { background: red; }');
    const verify = await runNode(['src/verify/verify.mjs', '127.0.0.1', '--all', '--no-interactions', '--viewports', '100x100'], dir);
    assert.equal(verify.code, 0, verify.output);
    const resultFile = join(dir, 'workspace', '127.0.0.1', 'verify', 'home', 'verify.json');
    assert.ok(JSON.parse(readFileSync(resultFile, 'utf8')).measurementProof);

    engine = await startEngine(dir, await freePort());
    const readPages = async () => (await (await fetch(engine.base + '/api/pages/127.0.0.1', {
      headers: { 'x-heimdall-token': 'test-token' },
    })).json()).pages[0];
    const runAgent = async args => {
      const result = await runNode(['src/cli.mjs', ...args, '--json'], dir);
      assert.equal(result.code, 0, result.output);
      return JSON.parse(result.output.trim().split('\n').findLast(line => line.startsWith('{'))).result;
    };
    const current = await readPages();
    assert.equal(current.verifyFresh, true);
    assert.equal(current.verifyDetails.viewports[0].score, 1);
    assert.equal((await runAgent(['site', '127.0.0.1', '--view', 'pages'])).pages[0].verify.measured, true);
    assert.equal((await runAgent(['site', '127.0.0.1', '--view', 'coverage'])).coverage.verified, 1);
    assert.equal((await runAgent(['clone', origin + '/'])).pages[0].verify.measured, true);

    const summaryFile = join(dir, 'workspace', '127.0.0.1', 'verify', 'verify-summary.json');
    const originalSummary = readFileSync(summaryFile, 'utf8');
    const summary = JSON.parse(originalSummary);
    const measuredAt = Date.parse(JSON.parse(readFileSync(resultFile, 'utf8')).generatedAt);
    writeFileSync(summaryFile, JSON.stringify({ ...summary, generatedAt: new Date(measuredAt + 1000).toISOString(),
      pages: [{ page: 'home', measured: false }] }));
    assert.equal((await readPages()).verifyFresh, false, 'a newer site failure invalidates a verified page');
    writeFileSync(summaryFile, JSON.stringify({ ...summary, generatedAt: new Date(measuredAt - 1000).toISOString(),
      pages: [{ page: 'home', measured: false }] }));
    assert.equal((await readPages()).verifyFresh, true, 'a later page measurement supersedes the site failure');
    writeFileSync(summaryFile, originalSummary);
    const upgradeArgs = ['src/crawler/responsive-upgrade.mjs', '127.0.0.1', '--threshold', '0.1'];
    assert.equal((await runNode(upgradeArgs, dir)).code, 0, 'a current baseline is accepted');
    writeFileSync(summaryFile, JSON.stringify({ ...summary, pages: summary.pages.map(row => ({ ...row,
      measuredAt: new Date(measuredAt - 1000).toISOString() })) }));
    const mismatchedUpgrade = await runNode(upgradeArgs, dir);
    assert.equal(mismatchedUpgrade.code, 1, 'a baseline from a different measurement is rejected');
    assert.match(mismatchedUpgrade.output, /summary or evidence is stale/);
    writeFileSync(summaryFile, originalSummary);

    const old = statSync(css);
    writeFileSync(css, 'body { background: blue; }');
    utimesSync(css, old.atime, old.mtime);
    const staleUpgrade = await runNode(upgradeArgs, dir);
    assert.equal(staleUpgrade.code, 1, 'a changed stylesheet invalidates the upgrade baseline');
    const stale = await readPages();
    assert.equal(stale.verifyDetails, null, 'detail must not receive an unchecked historical result');
    const siteVerify = (await runAgent(['site', '127.0.0.1', '--view', 'pages'])).pages[0].verify;
    const coverage = (await runAgent(['site', '127.0.0.1', '--view', 'coverage'])).coverage;
    const cloneVerify = (await runAgent(['clone', origin + '/'])).pages[0].verify;
    assert.deepEqual({ fresh: stale.verifyFresh, viewport: stale.minViewport, siteVerify,
      verified: coverage.verified, average: coverage.verifyAverage, cloneVerify },
    { fresh: false, viewport: null, siteVerify: null, verified: 0, average: null, cloneVerify: null });
  } finally {
    if (engine) await stopEngine(engine.proc);
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine protects workspace, revokes cookie and routes mirror hosts before engine API', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-engine-boundary-'));
  const host = 'fixture.test';
  const site = join(dir, 'workspace', host);
  mkdirSync(join(site, 'live', 'api', 'status'), { recursive: true });
  mkdirSync(join(site, 'live', 'static'), { recursive: true });
  for (const n of [1, 2]) {
    const file = join(site, 'live', liveSnapshotPath('/list', '?page=' + n));
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `<html>LIST PAGE ${n}</html>`);
  }
  mkdirSync(join(site, 'recon'), { recursive: true });
  mkdirSync(join(site, 'pages', 'legacy'), { recursive: true });
  mkdirSync(join(site, 'pages', 'verify-only'), { recursive: true });
  writeFileSync(join(site, 'live', 'api', 'status', 'index.html'), '<html>MIRROR API</html>');
  writeFileSync(join(site, 'live', 'static', 'asset.js'), 'MIRROR ASSET');
  writeFileSync(join(site, 'operation-plan.json'), '{"privateInput":"operation-secret"}');
  writeFileSync(join(site, 'operation-plan.json.bak'), '{"privateInput":"operation-backup-secret"}');
  writeFileSync(join(site, 'operation-discovery.json'), '{"privateInput":"discovery-secret"}');
  writeFileSync(join(site, 'operation-discovery (copy).json'), '{"privateInput":"discovery-copy-secret"}');
  writeFileSync(join(site, 'operation-review.json'), '{"privateInput":"review-secret"}');
  writeFileSync(join(site, 'operation-review.json.bak'), '{"privateInput":"review-backup-secret"}');
  writeFileSync(join(site, 'pages', 'legacy', 'manifest.json'), JSON.stringify({ target: `https://${host}/docs/deep?page=2` }));
  writeFileSync(join(site, 'pages', 'verify-only', 'manifest.json'), JSON.stringify({ target: `https://${host}/verify-only` }));
  writeFileSync(join(site, 'recon', 'atlas.json'), JSON.stringify({
    nodes: [
      { id: 'old', url: `https://${host}/docs/deep?page=2` },
      { id: 'keep', url: `https://${host}/docs/deep?page=3` },
    ],
    edges: [{ from: 'old', to: 'keep' }], meta: { pages: 2, edges: 1 },
  }));
  const port = await freePort();
  let engine;
  try {
    const upstreamProbe = `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (url, options) => String(url) === 'https://fixture.test/uncached'
        ? Promise.resolve(new Response(JSON.stringify(options.headers), { headers: { 'content-type': 'application/json' } }))
        : originalFetch(url, options);
    `;
    engine = await startEngine(dir, port, upstreamProbe);
    const { base } = engine;
    const staticUrl = base + `/static/${host}/recon/atlas.json`;
    assert.equal((await fetch(staticUrl)).status, 401);
    assert.equal((await fetch(base + `/${host}/recon/atlas.json`)).status, 401);

    const auth = await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'test-token' } });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.getSetCookie()[0].split(';')[0];
    assert.equal((await fetch(staticUrl, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + `/${host}/recon/atlas.json`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + `/static/${host}/operation-plan.json`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(base + `/static/${host}/operation-plan.json.bak`, { headers: { cookie } })).status, 403);
    assert.notEqual((await fetch(base + `/${host}/operation-plan.json`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + `/static/${host}/operation-discovery.json`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(base + `/static/${host}/operation-discovery%20(copy).json`, { headers: { cookie } })).status, 403);
    assert.notEqual((await fetch(base + `/${host}/operation-discovery.json`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(base + `/static/${host}/operation-review.json`, { headers: { cookie } })).status, 403);
    assert.equal((await fetch(base + `/static/${host}/operation-review.json.bak`, { headers: { cookie } })).status, 403);
    assert.notEqual((await fetch(base + `/${host}/operation-review.json`, { headers: { cookie } })).status, 200);
    const lmUrl = base + `/lm/${host}/api/status`;
    assert.equal((await fetch(lmUrl)).status, 401);
    assert.equal((await fetch(lmUrl + '?token=test-token')).status, 401, 'mirror token must not be accepted from a URL forwarded upstream');
    assert.equal((await fetch(lmUrl, { headers: { cookie } })).status, 410);
    for (const n of [1, 2]) {
      const page = await fetch(base + `/lm/${host}/list?page=${n}`, { headers: { cookie } });
      assert.equal(page.status, 410);
    }
    const mirrorReferer = base + `/lm/${host}/`;
    assert.equal((await fetch(base + '/assets/app.js', { headers: { referer: mirrorReferer } })).status, 404);

    const deletion = await fetch(base + `/api/sites/${host}/pages/legacy`, { method: 'DELETE', headers: { 'x-heimdall-token': 'test-token' } });
    assert.equal(deletion.status, 200);
    assert.equal((await deletion.json()).removedNode, true);
    const atlas = JSON.parse(readFileSync(join(site, 'recon', 'atlas.json'), 'utf8'));
    assert.deepEqual(atlas.nodes.map(node => node.id), ['keep']);

    const mirrorHost = `${host}.localhost:${port}`;
    assert.equal((await getWithHost(port, '/api/status', mirrorHost)).status, 401);
    assert.equal((await getWithHost(port, '/static/asset.js', mirrorHost)).status, 401);
    assert.equal((await getWithHost(port, '/api/status?token=test-token', mirrorHost)).status, 401);
    const mainHost = `127.0.0.1:${port}`;
    const artifactPath = `/static/${host}/recon/atlas.json`;
    const postArtifactTicket = (path, headers = {}) => fetch(base + '/api/artifact-ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ path }),
    });
    assert.equal((await postArtifactTicket(artifactPath)).status, 401);
    for (const path of ['https://evil.test/static/file', '//evil.test/static/file', '/api/status',
      '/static/fixture.test/../../api/status', '/static/fixture.test/file#fragment']) {
      const response = await postArtifactTicket(path, { 'x-heimdall-token': 'test-token' });
      assert.equal(response.status, 400, path);
    }
    const artifactIssued = await postArtifactTicket(artifactPath, { 'x-heimdall-token': 'test-token' });
    assert.equal(artifactIssued.status, 200);
    const artifactTicket = (await artifactIssued.json()).url;
    assert.match(artifactTicket, /^\/\.heimdall\/session\?ticket=/);
    assert.doesNotMatch(artifactTicket, /test-token/);
    assert.equal((await getWithHost(port, artifactTicket, `localhost:${port}`)).status, 401,
      'artifact ticket must be bound to the issuing engine host');
    assert.equal((await getWithHost(port, artifactTicket, mainHost)).status, 401,
      'a ticket presented on the wrong host is consumed');
    const validArtifactIssued = await postArtifactTicket(artifactPath, { 'x-heimdall-token': 'test-token' });
    const validArtifactTicket = (await validArtifactIssued.json()).url;
    const artifactExchange = await getWithHost(port, validArtifactTicket, mainHost);
    assert.equal(artifactExchange.status, 302);
    assert.equal(artifactExchange.headers.location, artifactPath);
    assert.equal(artifactExchange.headers['cache-control'], 'no-store');
    assert.equal(artifactExchange.headers['referrer-policy'], 'no-referrer');
    const artifactCookie = artifactExchange.headers['set-cookie'][0].split(';')[0];
    assert.match(artifactExchange.headers['set-cookie'][0], /HttpOnly; SameSite=None; Secure/,
      'sandboxed artifact subresources need a Secure cross-site session cookie');
    assert.equal((await getWithHost(port, artifactPath, mainHost, { cookie: artifactCookie })).status, 200);
    assert.equal((await getWithHost(port, validArtifactTicket, mainHost)).status, 401,
      'artifact ticket must reject replay');
    const launchPath = '/api/mirror-launch?url=' + encodeURIComponent(`https://${host}/list?page=2`);
    assert.equal((await getWithHost(port, launchPath, mainHost)).status, 401);
    assert.equal((await getWithHost(port, launchPath + '&token=test-token', mainHost)).status, 401,
      'launcher must not accept a Heimdall token in its URL');
    const postTicket = (url, mode = 'root', headers = {}) => fetch(base + '/api/mirror-ticket', {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ url, mode }),
    });
    assert.equal((await postTicket(`https://${host}/list?page=1`)).status, 401);
    assert.equal((await postTicket(`https://${host}/list?page=1`, 'prefix',
      { 'x-heimdall-token': 'test-token' })).status, 400);
    assert.equal((await postTicket(`https://${host}/`, 'external', { 'x-heimdall-token': 'test-token' })).status, 400);
    for (const target of ['http://fixture.test/', 'https://evil.example/',
      'https://user:pass@fixture.test/', 'https://fixture.test:8443/', 'https://fixture.test//evil.example']) {
      const response = await getWithHost(port, '/api/mirror-launch?url=' + encodeURIComponent(target), mainHost, { cookie });
      assert.ok([400, 403].includes(response.status), target + ': ' + response.body);
    }
    const mirrorLaunchResponse = await getWithHost(port, launchPath, mainHost, { cookie });
    assert.equal(mirrorLaunchResponse.status, 302);
    assert.equal(mirrorLaunchResponse.headers['cache-control'], 'no-store');
    const exchangeUrl = new URL(mirrorLaunchResponse.headers.location);
    assert.equal(exchangeUrl.hostname, `${host}.localhost`);
    assert.equal(exchangeUrl.pathname, '/.heimdall/session');
    assert.ok(exchangeUrl.searchParams.get('ticket'));
    assert.doesNotMatch(mirrorLaunchResponse.headers.location, /test-token/);
    const exchange = await getWithHost(port, exchangeUrl.pathname + exchangeUrl.search, mirrorHost);
    assert.equal(exchange.status, 302);
    assert.equal(exchange.headers.location, '/list?page=2');
    assert.equal(exchange.headers['referrer-policy'], 'no-referrer');
    assert.equal(exchange.headers['cache-control'], 'no-store');
    const exchangedCookie = exchange.headers['set-cookie'][0].split(';')[0];
    assert.match(exchange.headers['set-cookie'][0], /HttpOnly/);
    const opened = await getWithHost(port, exchange.headers.location, mirrorHost, { cookie: exchangedCookie });
    assert.match(opened.body, /LIST PAGE 2/);
    const upstream = await getWithHost(port, '/uncached', mirrorHost, {
      cookie: exchangedCookie + '; site_sid=123', 'x-heimdall-token': 'test-token',
    });
    assert.equal(upstream.status, 200, upstream.body);
    const upstreamHeaders = JSON.parse(upstream.body);
    assert.equal(upstreamHeaders.cookie, 'site_sid=123', 'engine session cookie must not reach the source site');
    assert.equal(upstreamHeaders['x-heimdall-token'], undefined, 'engine token must not reach the source site');
    assert.equal((await getWithHost(port, exchangeUrl.pathname + exchangeUrl.search, mirrorHost)).status, 401,
      'one-time ticket must reject replay');
    const wrongHostLaunch = await getWithHost(port, launchPath, mainHost, { cookie });
    const wrongHostPath = new URL(wrongHostLaunch.headers.location);
    assert.equal((await getWithHost(port, wrongHostPath.pathname + wrongHostPath.search, `other.test.localhost:${port}`)).status, 401);
    assert.equal((await getWithHost(port, wrongHostPath.pathname + wrongHostPath.search, mirrorHost)).status, 401,
      'a ticket presented on the wrong host is consumed');
    const mirrorApi = await getWithHost(port, '/api/status', mirrorHost, { 'x-heimdall-token': 'test-token' });
    assert.equal(mirrorApi.status, 200, mirrorApi.body);
    assert.match(mirrorApi.body, /MIRROR API/);
    const mirrorCookie = mirrorApi.headers['set-cookie'][0].split(';')[0];
    const mirrorAsset = await getWithHost(port, '/static/asset.js', mirrorHost, { cookie: mirrorCookie });
    assert.equal(mirrorAsset.status, 200, mirrorAsset.body);
    assert.equal(mirrorAsset.body, 'MIRROR ASSET');
    for (const n of [1, 2]) {
      const page = await getWithHost(port, `/list?page=${n}`, mirrorHost, { cookie: mirrorCookie });
      assert.equal(page.status, 200);
      assert.match(page.body, new RegExp('LIST PAGE ' + n));
    }

    const verify = async (body) => {
      const started = await fetch(base + '/api/verify', {
        method: 'POST', headers: { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(started.status, 200);
      const { taskId } = await started.json();
      const events = await fetch(base + '/api/events?task=' + encodeURIComponent(taskId), {
        headers: { 'x-heimdall-token': 'test-token' }, signal: AbortSignal.timeout(20_000),
      });
      const eventText = await events.text();
      assert.match(eventText, /"kind":"exit"/);
      const summaryPath = join(site, 'verify', 'verify-summary.json');
      assert.ok(existsSync(summaryPath), eventText);
      return JSON.parse(readFileSync(summaryPath, 'utf8'));
    };
    const full = await verify({ host });
    assert.equal(full.mode, 'all', 'omitting maxPages must request the whole site');
    assert.equal(full.selected, 1);
    const sample = await verify({ host, maxPages: 1 });
    assert.equal(sample.mode, 'sample', 'an explicit cap must remain a sample');

    const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie } });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=None; Secure; Max-Age=0/);
    assert.equal((await fetch(staticUrl, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(lmUrl, { headers: { cookie } })).status, 401);
    assert.equal((await fetch(base + '/assets/app.js', { headers: { cookie, referer: mirrorReferer } })).status, 404);

    const launch = async () => {
      const r = await fetch(base + '/api/storage/scan', { method: 'POST', headers: { 'x-heimdall-token': 'test-token' } });
      assert.equal(r.status, 202);
      return (await r.json()).taskId;
    };
    const firstId = await launch();
    await stopEngine(engine.proc);
    engine = await startEngine(dir, port);
    const second = await fetch(engine.base + '/api/storage/scan', { method: 'POST', headers: { 'x-heimdall-token': 'test-token' } });
    assert.equal(second.status, 202);
    const secondId = (await second.json()).taskId;
    assert.notEqual(secondId, firstId);
    await stopEngine(engine.proc);
    engine = null;
    const store = openJobStore(join(dir, 'jobs.db'));
    try {
      assert.ok(store.get(firstId));
      assert.ok(store.get(secondId));
      assert.equal(store.list({ limit: 10 }).filter(j => [firstId, secondId].includes(j.id)).length, 2);
    } finally { store.close(); }
  } finally {
    if (engine) await stopEngine(engine.proc);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('engine mirror forwards POST bodies, site cookies, redirects and logout', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-engine-post-'));
  mkdirSync(join(dir, 'workspace', 'fixture.test'), { recursive: true });
  const upstream = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts).toString('utf8');
    if (req.url === '/login' && req.method === 'POST') {
      res.writeHead(302, { Location: '/dashboard', 'Set-Cookie': 'sid=ok; Domain=fixture.test; Secure; HttpOnly; Path=/' });
      return res.end();
    }
    if (req.url === '/dashboard') {
      res.writeHead(req.headers.cookie?.includes('sid=ok') ? 200 : 401, { 'Content-Type': 'text/plain' });
      return res.end('dashboard');
    }
    if (req.url === '/api/echo' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ body, cookie: req.headers.cookie ?? '', token: req.headers['x-heimdall-token'] ?? '' }));
    }
    if (req.url === '/logout' && req.method === 'POST') {
      res.writeHead(302, { Location: '/login', 'Set-Cookie': 'sid=; Path=/; Max-Age=0' });
      return res.end();
    }
    res.writeHead(404); res.end('missing');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const port = await freePort();
  const preload = `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      const target = new URL(String(url));
      return target.hostname === 'fixture.test'
        ? originalFetch('http://127.0.0.1:${upstreamPort}' + target.pathname + target.search, options)
        : originalFetch(url, options);
    };
  `;
  let engine;
  try {
    engine = await startEngine(dir, port, preload);
    const mirrorHost = `fixture.test.localhost:${port}`;
    const authHeaders = { 'x-heimdall-token': 'test-token', 'content-type': 'application/x-www-form-urlencoded' };
    const login = await requestWithHost(port, '/login', mirrorHost,
      { method: 'POST', headers: authHeaders, body: 'user=alice' });
    assert.equal(login.status, 302, login.body);
    assert.equal(login.headers.location, '/dashboard');
    const cookies = login.headers['set-cookie'];
    assert.ok(cookies.some(c => c.startsWith('sid=ok')));
    assert.ok(cookies.some(c => c.startsWith('heimdall_session=')));
    assert.ok(cookies.filter(c => c.startsWith('sid=')).every(c => !/Domain=fixture\.test|; Secure/i.test(c)),
      'upstream site cookie must be scoped to the local mirror');
    assert.ok(cookies.filter(c => c.startsWith('heimdall_session='))
      .every(c => /HttpOnly; SameSite=None; Secure/.test(c)),
      'engine session cookie must authenticate sandboxed mirror resources');
    const cookie = cookies.map(c => c.split(';')[0]).join('; ');
    const dashboard = await getWithHost(port, '/dashboard', mirrorHost, { cookie });
    assert.equal(dashboard.status, 200);
    const echo = await requestWithHost(port, '/api/echo', mirrorHost,
      { method: 'POST', headers: { ...authHeaders, cookie }, body: 'message=hello' });
    assert.equal(echo.status, 200);
    assert.deepEqual(JSON.parse(echo.body), { body: 'message=hello', cookie: 'sid=ok', token: '' });
    const logout = await requestWithHost(port, '/logout', mirrorHost,
      { method: 'POST', headers: { ...authHeaders, cookie } });
    assert.equal(logout.status, 302);
    assert.equal(logout.headers.location, '/login');
    assert.ok(logout.headers['set-cookie'].some(c => c.startsWith('sid=;')));
  } finally {
    if (engine) await stopEngine(engine.proc);
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('site coverage distinguishes query pages and page API hides stale verify results', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-engine-query-'));
  const put = (host, rel, body) => {
    const file = join(dir, 'workspace', host, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
    return file;
  };
  for (const host of ['query-missing.test', 'query-matched.test']) {
    put(host, 'recon/atlas.json', JSON.stringify({ origin: `https://${host}`,
      nodes: [{ url: `https://${host}/list?page=1` }, { url: `https://${host}/list?page=2` }], edges: [] }));
  }
  put('query-missing.test', 'pages/third/clone/index.html', '<h1>third</h1>');
  put('query-missing.test', 'pages/third/manifest.json', JSON.stringify({ target: 'https://query-missing.test/list?page=3' }));
  for (const n of [1, 2]) {
    put('query-matched.test', `pages/part${n}/clone/index.html`, `<h1>${n}</h1>`);
    put('query-matched.test', `pages/part${n}/manifest.json`, JSON.stringify({ target: `https://query-matched.test/list?page=${n}` }));
  }
  const clone = put('fresh.test', 'pages/home/clone/index.html', '<h1>fresh</h1>');
  put('fresh.test', 'pages/home/manifest.json', JSON.stringify({ target: 'https://fresh.test/' }));
  const now = Date.now();
  const verify = put('fresh.test', 'verify/home/verify.json', JSON.stringify({
    generatedAt: new Date(now - 10_000).toISOString(), scoreVersion: 2, measured: true,
    minViewport: { name: 'mobile', score: 0.94 }, functional: { passed: 2, total: 2 },
  }));
  utimesSync(verify, new Date(now - 10_000), new Date(now - 10_000));
  utimesSync(clone, new Date(now - 5_000), new Date(now - 5_000));
  const port = await freePort();
  let engine;
  try {
    engine = await startEngine(dir, port);
    const headers = { 'x-heimdall-token': 'test-token' };
    const sites = (await (await fetch(engine.base + '/api/sites', { headers })).json()).sites;
    assert.equal(sites.find(s => s.host === 'query-missing.test').clonedInAtlas, 0);
    assert.equal(sites.find(s => s.host === 'query-matched.test').clonedInAtlas, 2);
    const pageUrl = engine.base + '/api/pages/fresh.test';
    const stale = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(stale.verifyFresh, false);
    assert.equal(stale.verifyMeasured, null);
    assert.equal(stale.minViewport, null);
    assert.equal(stale.interactions, null);
    assert.deepEqual(stale.artifacts, {
      verify: true, fixup: false, cloneGaps: false, linker: false, assetGaps: false,
    }, 'page API should expose optional quality artifacts so the console can skip known 404s');
    put('fresh.test', 'pages/home/fixup-history.json', JSON.stringify({ rounds: [] }));
    put('fresh.test', 'pages/home/clone-gaps.json', JSON.stringify({ gaps: [] }));
    put('fresh.test', 'linker-report.json', JSON.stringify({ host: 'fresh.test', pages: [] }));
    put('fresh.test', 'audit/asset-gaps.json', JSON.stringify({ pages: [] }));
    const artifactFlags = (await (await fetch(pageUrl, { headers })).json()).pages[0].artifacts;
    assert.deepEqual(artifactFlags, {
      verify: true, fixup: true, cloneGaps: true, linker: true, assetGaps: true,
    });
    utimesSync(verify, new Date(now + 5_000), new Date(now + 5_000));
    const fresh = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(fresh.verifyFresh, false, 'a newer timestamp is not measurement proof');
    assert.equal(fresh.verifyStatus, 'stale');
    assert.equal(fresh.minViewport, null);
    assert.equal(fresh.interactions, null);
    const summaryPath = put('fresh.test', 'verify/verify-summary.json', JSON.stringify({
      generatedAt: new Date(now).toISOString(), mode: 'all', pages: [{ page: 'home', measured: false }],
    }));
    const invalidated = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(invalidated.verifyFresh, false, 'site summary must veto a still-green page verify file');
    assert.equal(invalidated.verifyMeasured, null);
    assert.equal(invalidated.minViewport, null);
    assert.equal(invalidated.interactions, null);
    writeFileSync(verify, JSON.stringify({ generatedAt: new Date(now + 1000).toISOString(),
      scoreVersion: 2, measured: true, minViewport: { name: 'mobile', score: 0.96 },
      functional: { passed: 3, total: 3 } }));
    const reverified = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(reverified.verifyFresh, false, 'a fabricated later record still has no proof');
    assert.equal(reverified.minViewport, null);
    writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date(now + 2000).toISOString(),
      mode: 'all', pages: [{ page: 'home', measured: true,
      invalidated: { reason: 'postprocess changed clone' } }] }));
    const explicitlyInvalidated = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(explicitlyInvalidated.verifyFresh, false, 'invalidated marker also vetoes a stale green file');
    writeFileSync(summaryPath, JSON.stringify({ generatedAt: new Date(now + 2000).toISOString(),
      mode: 'all', pages: [{ page: 'home', measured: true }] }));
    const approved = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(approved.verifyFresh, false);
    assert.equal(approved.minViewport, null);
    writeFileSync(verify, JSON.stringify({ scoreVersion: 2, measured: false,
      minViewport: { name: 'desktop', score: 1 }, viewports: [{ name: 'desktop', score: 1 }] }));
    const partial = (await (await fetch(pageUrl, { headers })).json()).pages[0];
    assert.equal(partial.verifyFresh, false);
    assert.equal(partial.verifyMeasured, false);
    assert.equal(partial.verifyStatus, 'incomplete');
    assert.equal(partial.minViewport, null, 'partial evidence cannot be shown as a complete current result');
  } finally {
    if (engine) await stopEngine(engine.proc);
    rmSync(dir, { recursive: true, force: true });
  }
});
