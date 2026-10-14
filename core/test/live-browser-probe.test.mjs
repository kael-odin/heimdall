import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeOfflineBrowserBundle } from '../src/live/probe.mjs';

const SOURCE = fileURLToPath(new URL('../src/live/', import.meta.url));

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
    assert.deepEqual(report.failures[0], {
      pageIndex: 101, page: '/page-101/', kind: 'pageError', error: 'Error',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
