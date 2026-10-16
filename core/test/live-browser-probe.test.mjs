import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserObservationState, probeOfflineBrowserBundle } from '../src/live/probe.mjs';

const SOURCE = fileURLToPath(new URL('../src/live/', import.meta.url));

test('browser observation deadline takes priority over late stability', () => {
  const sample = { pendingRequests: 0, idleMs: 500, settleMs: 100, maxObservationMs: 350, quietMs: 50 };
  assert.equal(browserObservationState({ ...sample, elapsedMs: 99 }), 'waiting');
  assert.equal(browserObservationState({ ...sample, elapsedMs: 349 }), 'stable');
  assert.equal(browserObservationState({ ...sample, elapsedMs: 350 }), 'deadline');
  assert.equal(browserObservationState({ ...sample, elapsedMs: 500 }), 'deadline');
});

test('browser probe executes local JS and reports uncovered pages', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-browser-probe-'));
  try {
    mkdirSync(join(dir, 'site', 'live', 'good'), { recursive: true });
    mkdirSync(join(dir, 'site', 'live', 'api'), { recursive: true });
    writeFileSync(join(dir, 'site', 'live', 'good', 'index.html'), '<!doctype html><script src="/app.js"></script>');
    writeFileSync(join(dir, 'site', 'live', 'app.js'), "fetch('/api/data').then(r => { if (!r.ok) throw Error('local data unavailable'); });");
    writeFileSync(join(dir, 'site', 'live', 'api', 'data'), 'ok');
    writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({ host: 'fixture.test', origin: 'https://fixture.test', root: 'mirror', offline: true }));
    writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [] }));
    for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs']) copyFileSync(join(SOURCE, name), join(dir, name));

    const report = await probeOfflineBrowserBundle(dir, ['/good/', '/unvisited/'], { maxPages: 1, settleMs: 150 });
    assert.equal(report.checked, 1);
    assert.equal(report.failed, 0, JSON.stringify(report));
    assert.equal(report.observation.observedPages, 1);
    assert.equal(report.observation.deadlinePages, 0);
    assert.ok(report.observation.pages[0].requests >= 3, 'document, script and short local fetch finish before release');
    assert.equal(report.observation.pages[0].stable, true);
    assert.equal(report.totalPages, 2);
    assert.equal(report.untested, 1);
    assert.equal(report.truncated, true);

    mkdirSync(join(dir, 'site', 'live', 'bad'), { recursive: true });
    writeFileSync(join(dir, 'site', 'live', 'bad', 'index.html'), `<!doctype html><script>
      fetch('/api/missing?token=local-secret').catch(() => {});
      fetch('https://example.invalid/private?token=external-secret').catch(() => {});
      const socket = new WebSocket('wss://example.invalid/socket?token=socket-secret');
      socket.onerror = () => {};
      setTimeout(() => {
        const error = Error('broken https://example.invalid/path?token=error-secret');
        error.name = 'private-name-secret';
        throw error;
      }, 0);
    </script>`);
    const bad = await probeOfflineBrowserBundle(dir, ['/bad/'], { settleMs: 200 });
    assert.equal(bad.checked, 1);
    assert.equal(bad.failed, 1, JSON.stringify(bad));
    assert.equal(bad.untested, 0);
    assert.ok(bad.failures.some(f => f.kind === 'http' && f.status === 404 && f.target === '/api/missing'));
    assert.ok(bad.failures.some(f => f.kind === 'externalRequest' && f.target === 'https://example.invalid'));
    assert.ok(bad.failures.some(f => f.kind === 'websocketUnsupported' && f.target === 'wss://example.invalid'));
    assert.ok(bad.failures.some(f => f.kind === 'pageError' && f.error === 'Error'));
    assert.deepEqual(bad.runtimeOrigins, [{ origin: 'https://example.invalid', requests: 1, pages: ['/bad/'] }]);
    assert.doesNotMatch(JSON.stringify(bad), /local-secret|external-secret|socket-secret|error-secret|private-name-secret|token=/);

    const privateRoute = await probeOfflineBrowserBundle(dir, ['/users/alice@example.com?token=route-secret'], { settleMs: 0 });
    assert.equal(privateRoute.failed, 1);
    assert.ok(privateRoute.failures.some(f => f.page === '/users/[redacted]' && f.kind === 'http'));
    assert.doesNotMatch(JSON.stringify(privateRoute), /alice@example.com|route-secret|token=/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser probe checks every declared page beyond the former 100-page limit', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-browser-probe-all-'));
  try {
    const routes = Array.from({ length: 102 }, (_, i) => `/page-${i}/`);
    for (let i = 0; i < routes.length; i++) {
      const pageDir = join(dir, 'site', 'live', `page-${i}`);
      mkdirSync(pageDir, { recursive: true });
      writeFileSync(join(pageDir, 'index.html'), i === 101
        ? '<!doctype html><script>throw Error("late failure")</script>'
        : '<!doctype html><title>offline page</title>');
    }
    writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({
      host: 'fixture.test', origin: 'https://fixture.test', root: 'mirror', offline: true,
    }));
    writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [] }));
    for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs']) copyFileSync(join(SOURCE, name), join(dir, name));

    const report = await probeOfflineBrowserBundle(dir, routes, { settleMs: 0 });
    assert.equal(report.totalPages, 102);
    assert.equal(report.checked, 102);
    assert.equal(report.untested, 0);
    assert.equal(report.truncated, false);
    assert.equal(report.failed, 1, JSON.stringify(report));
    assert.equal(report.failureCount, 1);
    assert.equal(report.observation.observedPages, 102);
    assert.deepEqual(report.observation.pages.map(item => item.pageIndex),
      Array.from({ length: 102 }, (_, i) => i));
    assert.deepEqual(report.failures[0], {
      pageIndex: 101, page: '/page-101/', kind: 'pageError', error: 'Error',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser probe observes requests scheduled two seconds after the former 500ms window', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-browser-delayed-'));
  try {
    mkdirSync(join(dir, 'site', 'live'), { recursive: true });
    writeFileSync(join(dir, 'site', 'live', 'index.html'), `<!doctype html><script>
      setTimeout(() => fetch('/api/late?token=private-value').catch(() => {}), 2_000);
    </script>`);
    writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({
      host: 'fixture.test', origin: 'https://fixture.test', root: 'mirror', offline: true,
    }));
    writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [] }));
    for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs']) copyFileSync(join(SOURCE, name), join(dir, name));

    const report = await probeOfflineBrowserBundle(dir, ['/']);
    assert.equal(report.failed, 1, JSON.stringify(report));
    assert.ok(report.failures.some(f => f.kind === 'http' && f.status === 404 && f.target === '/api/late'));
    assert.deepEqual({ minimumMs: report.observation.minimumMs, maximumMs: report.observation.maximumMs,
      quietMs: report.observation.quietMs, observedPages: report.observation.observedPages },
    { minimumMs: 3_000, maximumMs: 8_000, quietMs: 500, observedPages: 1 });
    assert.ok(report.observation.pages[0].elapsedMs >= 3_000);
    assert.equal(report.observation.pages[0].stable, true);
    assert.doesNotMatch(JSON.stringify(report), /private-value|token=/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('browser probe fails closed when a local request remains pending at the observation deadline', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-browser-pending-'));
  try {
    writeFileSync(join(dir, 'serve.mjs'), `
      import { createServer } from 'node:http';
      const server = createServer((request, response) => {
        if (request.url === '/') {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><script>fetch("/slow").catch(() => {})</script>');
        } else if (request.url === '/slow') {
          setTimeout(() => response.end('late'), 2_000);
        } else { response.writeHead(404); response.end(); }
      });
      server.listen(0, '127.0.0.1', () => process.send?.({ kind: 'heimdall-live-ready', port: server.address().port }));
    `);
    const report = await probeOfflineBrowserBundle(dir, ['/'], {
      settleMs: 100, maxObservationMs: 350, quietMs: 50,
    });
    assert.equal(report.failed, 1, JSON.stringify(report));
    assert.equal(report.observation.deadlinePages, 1);
    assert.ok(report.failures.some(f => f.kind === 'observationDeadline' && f.pendingRequests === 1));
    assert.equal(report.observation.pages[0].stable, false);
    assert.equal(report.observation.pages[0].pendingAtEnd, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('browser probe does not wait for intentionally open local media streams', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-browser-media-'));
  try {
    writeFileSync(join(dir, 'serve.mjs'), `
      import { createServer } from 'node:http';
      const server = createServer((request, response) => {
        if (request.url === '/') {
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><video preload="auto"><source src="/movie.webm" type="video/webm"></video>');
          return;
        }
        if (request.url === '/movie.webm') {
          response.setHeader('Content-Type', 'video/webm');
          response.write(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
          return;
        }
        response.writeHead(404);
        response.end();
      });
      server.listen(0, '127.0.0.1', () => process.send?.({ kind: 'heimdall-live-ready', port: server.address().port }));
    `);
    const report = await probeOfflineBrowserBundle(dir, ['/'], {
      settleMs: 100, maxObservationMs: 350, quietMs: 50,
    });
    assert.equal(report.failed, 0, JSON.stringify(report));
    assert.equal(report.observation.deadlinePages, 0);
    assert.equal(report.observation.pages[0].stable, true);
    assert.equal(report.observation.pages[0].pendingAtEnd, 0);
    assert.ok(report.observation.pages[0].requests >= 2, 'the page and media request are observed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('parallel browser probe keeps bounded failure evidence in declared page order', { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-browser-failure-order-'));
  try {
    mkdirSync(join(dir, 'site', 'live', 'first'), { recursive: true });
    mkdirSync(join(dir, 'site', 'live', 'second'), { recursive: true });
    writeFileSync(join(dir, 'site', 'live', 'first', 'index.html'),
      '<!doctype html><script>setTimeout(() => fetch("/first-missing").catch(() => {}), 500)</script>');
    writeFileSync(join(dir, 'site', 'live', 'second', 'index.html'),
      '<!doctype html><script>fetch("/second-missing").catch(() => {})</script>');
    writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({
      host: 'fixture.test', origin: 'https://fixture.test', root: 'mirror', offline: true,
    }));
    writeFileSync(join(dir, 'har.json'), JSON.stringify({ entries: [] }));
    for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs']) copyFileSync(join(SOURCE, name), join(dir, name));

    const report = await probeOfflineBrowserBundle(dir, ['/first/', '/second/'], {
      settleMs: 800, maxObservationMs: 2_000, maxFailures: 1,
    });
    assert.equal(report.checked, 2);
    assert.equal(report.failed, 2);
    assert.equal(report.failureCount, 2);
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0].pageIndex, 0);
    assert.equal(report.failures[0].target, '/first-missing');
    assert.deepEqual(report.observation.pages.map(item => item.pageIndex), [0, 1]);
    assert.equal(report.truncated, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
