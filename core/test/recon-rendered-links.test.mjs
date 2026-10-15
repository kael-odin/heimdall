import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));

async function serverFor(handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function runRecon(origin, maxPages, maxDepth) {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-recon-rendered-'));
  try {
    const run = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['src/crawler/recon.mjs', origin, String(maxPages), String(maxDepth)], {
        cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir },
      });
      let output = '';
      child.stdout.on('data', part => { output += part; });
      child.stderr.on('data', part => { output += part; });
      child.once('error', reject);
      child.once('close', code => resolve({ code, output }));
    });
    assert.equal(run.code, 0, run.output);
    return JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json'), 'utf8'));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test('recon discovers a query page linked after client hydration within its observation budget', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<!doctype html><title>Home</title><body><script>
        setTimeout(() => {
          const link = document.createElement('a');
          link.href = '/list?page=2';
          link.textContent = 'Next';
          document.body.append(link);
        }, 850);
      </script></body>`);
    }
    if (req.url === '/list?page=2') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><title>Page 2</title><body>Page 2</body>');
    }
    res.writeHead(404); res.end();
  });
  try {
    const atlas = await runRecon(site.origin, 2, 1);
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/', site.origin + '/list?page=2']);
    assert.equal(atlas.meta.pages, 2);
    assert.equal(atlas.meta.renderedLinks.observedPages, 2);
    assert.equal(atlas.meta.renderedLinks.timedOutPages, 0);
  } finally { await site.close(); }
});

test('recon records a client-side replacement route after the observation window', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    if (req.url === '/' || req.url === '/landing') {
      res.setHeader('content-type', 'text/html');
      return res.end(`<!doctype html><title>Home</title><body><script>
        setTimeout(() => history.replaceState(null, '', '/landing'), 800);
      </script></body>`);
    }
    res.writeHead(404); res.end();
  });
  try {
    const atlas = await runRecon(site.origin, 2, 0);
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/landing']);
    assert.equal(atlas.nodes[0].directNavigation, 'unverified-client-route');
    assert.equal(atlas.meta.clientRouteUnverifiedPages, 1);
    assert.equal(atlas.meta.renderedLinks.timedOutPages, 0);
  } finally { await site.close(); }
});

test('recon keeps each navigation edge at its observed destination when redirects form a chain', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') return res.end('<!doctype html><title>Home</title><body><a href="/a">A</a><a href="/b">B</a></body>');
    if (req.url === '/a') return res.end(`<!doctype html><title>A</title><body><script>
      setTimeout(() => history.replaceState(null, '', '/b'), 800);
    </script></body>`);
    if (req.url === '/b') return res.end(`<!doctype html><title>B</title><body><script>
      setTimeout(() => history.replaceState(null, '', '/c'), 800);
    </script></body>`);
    if (req.url === '/c') return res.end('<!doctype html><title>C</title><body>C</body>');
    res.writeHead(404); res.end();
  });
  try {
    const atlas = await runRecon(site.origin, 3, 1);
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/', site.origin + '/b', site.origin + '/c']);
    const [home, b, c] = atlas.nodes;
    assert.equal(atlas.edges.length, 2);
    assert.ok(atlas.edges.every(edge => edge.from === home.id));
    assert.deepEqual(new Set(atlas.edges.map(edge => edge.to)), new Set([b.id, c.id]));
    assert.equal(b.directNavigation, undefined);
    assert.equal(c.directNavigation, 'unverified-client-route');
  } finally { await site.close(); }
});

test('recon upgrades a client route after a later direct HTML visit', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/') return res.end('<!doctype html><title>Home</title><body><a href="/a">A</a><a href="/b">B</a></body>');
    if (req.url === '/a') return res.end(`<!doctype html><title>A</title><body><script>
      setTimeout(() => history.replaceState(null, '', '/b'), 800);
    </script></body>`);
    if (req.url === '/b') return setTimeout(() => res.end('<!doctype html><title>B</title><body>B</body>'), 2_000);
    res.writeHead(404); res.end();
  });
  try {
    const atlas = await runRecon(site.origin, 3, 1);
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/', site.origin + '/b']);
    assert.equal(atlas.nodes[1].directNavigation, undefined);
    assert.equal(atlas.meta.clientRouteUnverifiedPages, 0);
  } finally { await site.close(); }
});

test('recon rejects a 200 JSON document and records HTML inferred without a MIME header', { timeout: 60_000 }, async () => {
  const site = await serverFor((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><title>Home</title><body><a href="/data">Data</a><a href="/without-type">HTML</a></body>');
    }
    if (req.url === '/data') {
      res.setHeader('content-type', 'application/json');
      return res.end('{"page":"not HTML"}');
    }
    if (req.url === '/without-type') return res.end('<!doctype html><title>HTML</title><body>HTML</body>');
    res.writeHead(404); res.end();
  });
  try {
    const atlas = await runRecon(site.origin, 3, 1);
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/', site.origin + '/without-type']);
    assert.ok(atlas.failures.some(row => row.url === site.origin + '/data' && row.reason.includes('non-HTML')));
    assert.equal(atlas.meta.documentMimeInferredPages, 1);
  } finally { await site.close(); }
});

test('recon omits HTTP errors and uses the final same-origin redirect URL in nodes and edges', { timeout: 60_000 }, async () => {
  const foreign = await serverFor((_req, res) => { res.end('foreign'); });
  const site = await serverFor((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><title>Home</title><body><a href="/missing">Missing</a><a href="/old">Old</a><a href="/foreign">Foreign</a></body>');
    }
    if (req.url === '/old') { res.writeHead(302, { location: '/new' }); return res.end(); }
    if (req.url === '/foreign') { res.writeHead(302, { location: foreign.origin + '/outside' }); return res.end(); }
    if (req.url === '/new') {
      res.setHeader('content-type', 'text/html');
      return res.end('<!doctype html><title>New</title><body>New</body>');
    }
    res.writeHead(404); res.end();
  });
  try {
    const atlas = await runRecon(site.origin, 4, 1);
    assert.deepEqual(atlas.nodes.map(node => node.url), [site.origin + '/', site.origin + '/new']);
    assert.deepEqual(atlas.edges, [{ from: atlas.nodes[0].id, to: atlas.nodes[1].id }]);
    assert.ok(atlas.failures.some(row => row.url === site.origin + '/missing' && row.reason.includes('HTTP 404')));
    assert.ok(atlas.failures.some(row => row.url === site.origin + '/foreign'));
  } finally {
    await Promise.all([site.close(), foreign.close()]);
  }
});
