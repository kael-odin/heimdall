import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConsoleRoutes, extractApiPaths } from '../scripts/check-console-routes.mjs';

test('console route guard extracts literal API paths and concretizes templates only for probing', () => {
  const source = [
    "fetch('/api/status')",
    'fetch(`/api/projects/${projectId}`)',
    'fetch("/api/items/:id")',
    'fetch("/not-api")',
  ].join('\n');
  assert.deepEqual(extractApiPaths(source), ['/api/status', '/api/projects/${projectId}', '/api/items/:id']);
});

test('console route guard reports only 404 responses that mean an unknown route', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'heimdall-routes-'));
  try {
    mkdirSync(join(dist, 'assets'), { recursive: true });
    writeFileSync(join(dist, 'assets', 'app.js'), 'fetch("/api/missing");fetch("/api/ok")');
    const requested = [];
    const result = await checkConsoleRoutes({
      dist,
      fetcher: async url => {
        requested.push(url);
        return url.endsWith('/api/missing')
          ? { status: 404, text: async () => '{"error":"unknown route"}' }
          : { status: 200, text: async () => '{}' };
      },
    });
    assert.equal(result.checked, 2);
    assert.deepEqual(result.bad, ['/api/missing']);
    assert.equal(requested.length, 2);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});
