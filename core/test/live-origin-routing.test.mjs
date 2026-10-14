import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { siteIdForOrigin } from '../src/site-origin.mjs';

function mirrorRequest(port, path, host, cookie = '') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { host, cookie } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }); req.on('error', reject); req.end();
  });
}

const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));
const CORE = fileURLToPath(new URL('..', import.meta.url));
function cli(script, args, root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(CORE, 'src', script), ...args], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_SELF_URL: 'http://127.0.0.1:1' },
    });
    let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
  });
}
async function startBundle(out) {
  const child = spawn(process.execPath, [join(out, 'serve.mjs'), '--port', '0', '--host', '127.0.0.1'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => reject(new Error('bundle exited: ' + code)));
    child.on('message', m => { if (m?.kind === 'heimdall-live-ready') resolve(m.port); });
  });
  return { child, base: `http://127.0.0.1:${port}` };
}
const free = () => new Promise(resolve => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const startEngine = async (root) => {
  const p = await free();
  const child = spawn(process.execPath, [ENGINE, String(p)], { cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, HEIMDALL_DATA_DIR: root, HEIMDALL_TOKEN: 'test-token', HEIMDALL_HOST: '127.0.0.1' }, stdio: 'ignore' });
  const base = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'test-token' } })).ok) return { child, base, p }; } catch {} await new Promise(r => setTimeout(r, 30)); }
  child.kill(); throw new Error('engine did not start');
};

test('build, mirror tickets and exported bundles isolate two real origins sharing a hostname', { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-origin-routing-'));
  const upstream = [];
  const bundles = [];
  let engine;
  try {
    for (const label of ['A', 'B']) {
      const server = createServer((req, res) => {
        if (req.url === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/remote` }); return res.end(); }
        if (req.url === '/cross') { res.writeHead(302, { location: `http://127.0.0.1:${upstream[label === 'A' ? 1 : 0].address().port}/remote` }); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end(label);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      upstream.push(server);
    }
    const ports = upstream.map(s => s.address().port);
    const workspace = join(root, 'workspace'); mkdirSync(workspace, { recursive: true });
    const sites = ports.map((port, i) => {
      const origin = `http://127.0.0.1:${port}`;
      const id = siteIdForOrigin(workspace, origin);
      const dir = join(workspace, id); mkdirSync(join(dir, 'live', 'local'), { recursive: true });
      // A is a legacy hostname directory (no site-origin.json); B is scoped.
      if (i) writeFileSync(join(dir, 'site-origin.json'), JSON.stringify({ origin }));
      const page = join(dir, 'pages', 'home');
      mkdirSync(join(page, 'clone', 'styles'), { recursive: true });
      writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: origin + '/' }));
      writeFileSync(join(page, 'clone', 'index.html'), `<html>CLONE-${i}</html>`);
      writeFileSync(join(page, 'clone', 'styles', 'cssom.css'), `body{--site:${i}}`);
      const other = `http://127.0.0.1:${ports[1 - i]}`;
      writeFileSync(join(page, 'dom.html'), `<html><head></head><body>LOCAL-${i}<img src="${origin}/asset.svg"><a href="${other}/remote">other port</a></body></html>`);
      writeFileSync(join(page, 'network.har'), JSON.stringify({ log: { entries: [{
        request: { method: 'GET', url: origin + '/asset.svg', headers: [] }, response: { status: 200, headers: [],
          content: { mimeType: 'image/svg+xml', text: `<svg xmlns="http://www.w3.org/2000/svg"><text>ASSET-${i}</text></svg>` } },
      }] } }));
      writeFileSync(join(dir, 'live', 'local', 'index.html'), `LOCAL-${i}`);
      return { origin, id };
    });
    assert.notEqual(sites[0].id, sites[1].id);
    engine = await startEngine(root);
    for (const [i, site] of sites.entries()) {
      const built = await cli('crawler/build_live.mjs', [site.id], root);
      assert.equal(built.code, 0, built.output);
      const html = readFileSync(join(workspace, site.id, 'live', 'index.html'), 'utf8');
      assert.ok(html.includes(`/lm/${site.id}/asset.svg`));
      assert.ok(html.includes(sites[1 - i].origin + '/remote'), 'cross-port links must retain their original origin');
      const ticket = await fetch(engine.base + '/api/mirror-ticket', { method: 'POST', headers: { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' }, body: JSON.stringify({ url: site.origin + '/remote' }) });
      assert.equal(ticket.status, 200);
      const body = await ticket.json();
      assert.equal(body.siteId, site.id); assert.equal(body.origin, site.origin);
      const host = `${site.id}.localhost:${engine.p}`;
      const exchange = await mirrorRequest(engine.p, '/.heimdall/session?ticket=' + encodeURIComponent(new URL(body.url).searchParams.get('ticket')), host);
      assert.equal(exchange.status, 302);
      const cookie = exchange.headers['set-cookie'][0].split(';')[0];
      const remote = await mirrorRequest(engine.p, '/remote', host, cookie);
      assert.equal(remote.body, String.fromCharCode(65 + i));
      assert.equal((await mirrorRequest(engine.p, '/', host, cookie)).body.includes(`LOCAL-${i}`), true);
      assert.equal((await mirrorRequest(engine.p, `/static/${site.id}/pages/home/clone/styles/cssom.css`, host, cookie)).body, `body{--site:${i}}`);
      assert.equal((await mirrorRequest(engine.p, '/remote', `${sites[1 - i].id}.localhost:${engine.p}`, cookie)).status, 401, 'sessions cannot authenticate a different origin');
      assert.equal((await mirrorRequest(engine.p, '/redirect', host, cookie)).headers.location, '/remote');
      assert.equal((await mirrorRequest(engine.p, '/cross', host, cookie)).headers.location, sites[1 - i].origin + '/remote');
      assert.equal((await mirrorRequest(engine.p, '/.heimdall/session?ticket=' + new URL(body.url).searchParams.get('ticket'), host)).status, 401);

      const out = join(root, 'deliverable', site.id);
      const indexed = await cli('crawler/index-page.mjs', [site.id], root);
      assert.equal(indexed.code, 0, indexed.output);
      const report = readFileSync(join(workspace, site.id, 'compare.html'), 'utf8');
      assert.ok(report.includes('/api/mirror-launch?url='));
      assert.ok(report.includes(site.id));
      const exported = await cli('live/export.mjs', [site.id, '--root', 'mirror', '--out', out], root);
      assert.equal(exported.code, 0, exported.output);
      const cfg = JSON.parse(readFileSync(join(out, 'heimdall-live.json'), 'utf8'));
      assert.equal(cfg.siteId, site.id); assert.equal(cfg.origin, site.origin);
      assert.equal(cfg.offline, false, 'online origin routing requires the source proxy');
      assert.ok(readFileSync(join(out, 'site', 'static', site.id, 'compare.html'), 'utf8')
        .includes(`document.getElementById('inter').href = '/lm/${site.id}' + t.pathname + t.search;`));
      const bundle = await startBundle(out); bundles.push(bundle);
      const exportedHtml = await (await fetch(bundle.base + '/')).text();
      assert.ok(exportedHtml.includes(`LOCAL-${i}`));
      assert.ok(exportedHtml.includes(sites[1 - i].origin + '/remote'));
      assert.equal(await (await fetch(bundle.base + '/remote')).text(), String.fromCharCode(65 + i));
      assert.match(await (await fetch(bundle.base + '/asset.svg')).text(), new RegExp(`ASSET-${i}`));
      assert.equal(await (await fetch(bundle.base + `/static/${site.id}/pages/home/clone/styles/cssom.css`)).text(), `body{--site:${i}}`);
      assert.equal((await fetch(bundle.base + `/lm/${sites[1 - i].id}/`)).status, 403);
    }
  } finally {
    for (const { child } of bundles) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    for (const s of upstream) await new Promise(r => s.close(r));
    if (engine) { engine.child.kill(); await new Promise(resolve => engine.child.once('exit', resolve)); }
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
});
