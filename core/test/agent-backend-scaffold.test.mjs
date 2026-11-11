import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'bin', 'heimdall.mjs');

function put(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function ready(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('backend scaffold server did not start')), 10_000);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/HEIMDALL_BACKEND_READY (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stop(child) {
  if (!child) return;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => child.once('close', resolve));
}

test('backend scaffold generates and starts a B3 service from sanitized contract and adapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-scaffold-'));
  const site = join(root, 'workspace', 'example.test');
  const adapter = join(site, 'runtime-adapter');
  let child;
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      siteId: 'example.test',
      openapi: {
        servers: [{ url: 'https://example.test', 'x-heimdall-provenance': 'observed' }],
        paths: {
          '/api/items': {
            get: {
              'x-heimdall-observations': { samples: 2, queryParams: [], authSchemes: ['bearer'] },
              responses: { 200: { 'x-heimdall-samples': 2, content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
            },
          },
        },
      },
      observations: [{ op: 'GET /api/items', samples: 2, statusCodes: [200], withResponseSchema: true, withRequestSchema: false, authSchemes: ['bearer'], errorSamples: 0 }],
      unknowns: [{ kind: 'auth-unknown', detail: 'super-secret must not be copied' }],
      secret: 'super-secret',
    });
    put(join(adapter, 'manifest.json'), { version: 1, routes: [{ method: 'GET', path: '/api/items' }] });
    put(join(adapter, 'index.mjs'), [
      "export const __heimdallAdapter = { routes: [{ method: 'GET', path: '/api/items', queryParams: [], responseBody: 'observed', writeVerification: 'not_applicable' }] };",
      "export async function handle() { return Response.json({ ok: true }); }",
      '',
    ].join('\n'));

    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'example.test', '--json'], {
      cwd: root,
      env: { ...process.env, HEIMDALL_DATA_DIR: root },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const envelope = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.level, 'B3-scaffold');
    assert.equal(envelope.result.contract.observedRoutes, 1);
    assert.equal(envelope.result.adapter.present, true);

    const out = envelope.result.outDir;
    for (const file of ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json', 'Dockerfile', 'README.md', 'runtime-adapter/index.mjs', 'runtime-adapter/manifest.json']) {
      assert.equal(existsSync(join(out, file)), true, file);
    }
    const projected = JSON.parse(readFileSync(join(out, 'api-contract.json'), 'utf8'));
    assert.equal(projected.secret, undefined);
    assert.doesNotMatch(readFileSync(join(out, 'README.md'), 'utf8'), /super-secret/);

    child = spawn(process.execPath, [join(out, 'server.mjs'), '--port', '0'], {
      cwd: out,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const base = await ready(child);
    const health = await fetch(base + '/__heimdall/health');
    const healthJson = await health.json();
    assert.equal(health.status, 200);
    assert.equal(healthJson.level, 'B3-scaffold');
    assert.equal(healthJson.adapter.present, true);
    const response = await fetch(base + '/api/items');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });

    const checks = spawnSync(process.execPath, [join(out, 'checks.mjs'), base], {
      cwd: out,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(checks.status, 0, checks.stderr + checks.stdout);
    assert.match(checks.stdout, /"overall": "passed"/);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test('backend scaffold does not copy a missing runtime adapter into Docker', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-backend-scaffold-no-adapter-'));
  const site = join(root, 'workspace', 'example-no-adapter.test');
  try {
    put(join(site, 'api-contract.json'), {
      schema: 'heimdall.contract/1',
      siteId: 'example-no-adapter.test',
      openapi: {
        paths: {
          '/api/items': {
            get: {
              responses: { 200: {} },
            },
          },
        },
      },
    });

    const generated = spawnSync(process.execPath, [CLI, 'backend', 'scaffold', 'example-no-adapter.test', '--json'], {
      cwd: root,
      env: { ...process.env, HEIMDALL_DATA_DIR: root },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(generated.status, 0, generated.stderr + generated.stdout);
    const envelope = JSON.parse(generated.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.result.adapter.present, false);

    const out = envelope.result.outDir;
    const dockerfile = readFileSync(join(out, 'Dockerfile'), 'utf8');
    assert.doesNotMatch(dockerfile, /^COPY runtime-adapter /m);
    assert.equal(existsSync(join(out, 'runtime-adapter')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
