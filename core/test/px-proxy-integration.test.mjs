import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const CORE = fileURLToPath(new URL('..', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('/px follows only same-origin redirects and never returns upstream Set-Cookie', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-px-proxy-'));
  const sinkHits = [];
  const sink = createServer((req, res) => {
    sinkHits.push(req.url);
    res.writeHead(200, { 'set-cookie': 'sink_cookie=secret; HttpOnly', 'content-type': 'text/plain' });
    res.end('sink');
  });
  await new Promise(resolve => sink.listen(0, '127.0.0.1', resolve));
  const sinkPort = sink.address().port;
  const upstream = createServer((req, res) => {
    if (req.url === '/blocked') {
      res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/landed` });
      res.end();
      return;
    }
    if (req.url === '/same') {
      res.writeHead(302, { location: '/final', 'set-cookie': 'first=secret; HttpOnly' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'final=secret; HttpOnly' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;
  const port = await freePort();
  mkdirSync(join(dir, 'workspace', 'fixture.test'), { recursive: true });
  writeFileSync(join(dir, 'workspace', 'fixture.test', 'site-origin.json'), JSON.stringify({ origin: 'https://fixture.test' }));
  const preload = `
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (url, options) => {
      const target = new URL(String(url));
      return target.origin === 'https://fixture.test'
        ? originalFetch('http://127.0.0.1:${upstreamPort}' + target.pathname + target.search, options)
        : originalFetch(url, options);
    };
  `;
  const engine = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(preload), ENGINE, String(port)], {
    cwd: CORE,
    env: {
      ...process.env,
      HEIMDALL_DATA_DIR: dir,
      HEIMDALL_TOKEN: 'px-token',
      HEIMDALL_HOST: '127.0.0.1',
      HEIMDALL_ALLOWED_HOSTS: 'fixture.test',
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'px-token' } })).ok) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const blocked = await fetch(base + '/px/fixture.test/blocked', { headers: { 'x-heimdall-token': 'px-token' } });
    assert.equal(blocked.status, 502);
    assert.equal(blocked.headers.getSetCookie().some(value => /sink_cookie|secret/.test(value)), false);
    assert.deepEqual(sinkHits, []);

    const same = await fetch(base + '/px/fixture.test/same', { headers: { 'x-heimdall-token': 'px-token' } });
    assert.equal(same.status, 200);
    assert.deepEqual(await same.json(), { ok: true });
    assert.equal(same.headers.getSetCookie().some(value => /first=|final=|secret/.test(value)), false);
  } finally {
    engine.kill();
    await new Promise(resolve => engine.once('exit', resolve));
    await Promise.all([upstream, sink].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dir, { recursive: true, force: true });
  }
});
