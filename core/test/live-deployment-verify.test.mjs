import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatHttpCheckFailure, readHttpChecks, summarizeBrowserProbeFailures, validateDeploymentReport, validateStaticDeploymentReport, verifyBundleChecksums, verifyDeploymentBundle, verifyStaticDeploymentBundle } from '../src/live/deployment-verify.mjs';

test('deployment evidence requires network-none, runtime checks, and the current bundle checksum', () => {
  const report = {
    schema: 'heimdall.adapter-egress-verification/1', siteId: 'example.test',
    serverEgress: 'verified', bundleChecksumsSha256: 'a'.repeat(64),
    docker: { network: 'none' },
    checks: { health: 'passed', stateVolume: 'passed' },
  };
  assert.equal(validateDeploymentReport(report, {
    siteId: 'example.test', checksumsSha256: 'a'.repeat(64),
  }), true);
  assert.equal(validateDeploymentReport(report, {
    siteId: 'example.test', checksumsSha256: 'b'.repeat(64),
  }), false);
  assert.equal(validateDeploymentReport({ ...report, docker: { network: 'bridge' } }, {
    siteId: 'example.test', checksumsSha256: 'a'.repeat(64),
  }), false);
});

test('deployment evidence rejects a changed file even when checksums.json itself is unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-deployment-checksums-'));
  try {
    const file = join(root, 'README.txt');
    const checksums = join(root, 'checksums.json');
    writeFileSync(file, 'before');
    writeFileSync(checksums, JSON.stringify({ files: [{
      p: 'README.txt', s: 6, h: createHash('sha256').update('before').digest('hex'),
    }] }));
    assert.match(verifyBundleChecksums(root), /^[a-f0-9]{64}$/);
    writeFileSync(file, 'after');
    assert.throws(() => verifyBundleChecksums(root), /校验失败/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP deployment checks keep write assertions before restart and readback assertions after restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-http-checks-'));
  try {
    const file = join(root, 'checks.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      beforeRestart: [{ id: 'create', method: 'POST', path: '/api/items',
        headers: { 'content-type': 'application/json' }, body: { name: 'fixture' },
        expect: { status: 201, contentType: 'application/json', json: [{ pointer: '/ok', equals: true }] } }],
      afterRestart: [{ id: 'readback', method: 'GET', path: '/api/items',
        expect: { status: 200, json: [{ pointer: '/items/0/name', equals: 'fixture' }] } }],
    }));
    const plan = readHttpChecks(file);
    assert.equal(plan.beforeRestart[0].method, 'POST');
    assert.equal(plan.afterRestart[0].expect.json[0].pointer, '/items/0/name');
    assert.match(plan.sha256, /^[a-f0-9]{64}$/);
    assert.throws(() => readHttpChecks(join(root, 'missing.json')), /HTTP 检查文件/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('HTTP deployment failures identify the phase and safe assertion detail', () => {
  const check = { id: 'readback', method: 'GET', path: '/api/items', expect: { status: 200 } };
  assert.equal(formatHttpCheckFailure('beforeRestart', check, 'status expected 200, got 500'),
    'HTTP check failed [beforeRestart]: readback (status expected 200, got 500)');
  assert.equal(formatHttpCheckFailure('afterRestart', { id: 'write', expect: {} }, 'JSON pointer /id mismatch'),
    'HTTP check failed [afterRestart]: write (JSON pointer /id mismatch)');
  assert.doesNotMatch(formatHttpCheckFailure('beforeRestart', check, 'text assertion failed'), /fixture|token|secret/i);
});

test('browser deployment failures summarize safe causes without exposing request paths', () => {
  const summary = summarizeBrowserProbeFailures({ failures: [
    { kind: 'externalRequest', target: 'https://analytics.ietf.org/private?token=secret' },
    { kind: 'externalRequest', target: 'https://analytics.ietf.org' },
    { kind: 'http', target: '/_nuxt/private?token=secret', status: 404 },
  ] });
  assert.equal(summary, 'externalRequest@analytics.ietf.org×2、http:404×1');
  assert.doesNotMatch(summary, /private|token|secret/i);
});

test('static deployment failures persist a sanitized attempt without creating pass evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-static-deployment-attempt-verify-'));
  try {
    mkdirSync(join(root, 'site', 'live'), { recursive: true });
    const files = {
      'health.json': JSON.stringify({ adapter: { status: 'not-included' }, offline: true }),
      'Dockerfile': 'FROM node:22-alpine',
      'serve.mjs': 'console.log(1)',
      'heimdall-live.json': JSON.stringify({ siteId: 'example.test', port: 8080 }),
      'site/live/index.html': '<!doctype html><h1>Example</h1>',
    };
    for (const [name, body] of Object.entries(files)) {
      const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body);
    }
    writeFileSync(join(root, 'checksums.json'), JSON.stringify({ files: Object.entries(files).map(([p, body]) => ({
      p, s: Buffer.byteLength(body), h: createHash('sha256').update(body).digest('hex'),
    })) }));
    const reportPath = join(root, 'deployment-verification.json');
    const runDocker = args => {
      if (args[0] === 'inspect') return 'none';
      if (args[0] === 'exec') return JSON.stringify({ health: 'passed', root: 'passed', routes: ['/'], routesChecked: 1, sourceWorkspace: 'passed' });
      return '';
    };
    await assert.rejects(verifyStaticDeploymentBundle({ bundleDir: root, siteId: 'example.test', reportPath, runDocker, observeMs: 1,
      copySnapshot: ({ destination }) => cpSync(root, destination, { recursive: true }),
      probeBrowser: async () => ({ checked: 1, failed: 1, untested: 0, truncated: false, failureCount: 2, failures: [
        { kind: 'externalRequest', target: 'https://analytics.ietf.org/private?token=secret' },
        { kind: 'http', target: '/_nuxt/private?token=secret', status: 404 },
      ] }),
    }), /最终镜像浏览器验收失败/);
    const attempt = JSON.parse(readFileSync(`${reportPath}.attempt.json`, 'utf8'));
    assert.equal(attempt.schema, 'heimdall.deployment-verification-attempt/1');
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.stage, 'browser-probe');
    assert.equal(attempt.browserProbe.causes, 'externalRequest@analytics.ietf.org×1、http:404×1');
    assert.ok(!existsSync(reportPath), 'failed verification must not create a passing report');
    assert.doesNotMatch(JSON.stringify(attempt), /private|token|secret/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('live-verify CLI resolves relative bundle paths from the invoking directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-live-verify-cli-path-'));
  try {
    mkdirSync(join(root, 'bundle'), { recursive: true });
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'live-verify', 'bundle', '--static', '--site-id', 'example.test',
    ], { cwd: join(root, '..'), env: { ...process.env, HEIMDALL_INVOKE_CWD: root }, encoding: 'utf8', windowsHide: true });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /health\.json/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /交付包 必须是普通目录/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('adapter deployment verification can replay an authorized operation plan from the final image filesystem', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-adapter-operation-verify-'));
  try {
    mkdirSync(join(root, 'site', 'live'), { recursive: true });
    mkdirSync(join(root, 'runtime-adapter'), { recursive: true });
    const files = {
      'health.json': JSON.stringify({ adapter: { status: 'included' }, offline: true }),
      'Dockerfile': 'FROM node:22-alpine',
      'serve.mjs': 'console.log(1)',
      'heimdall-live.json': JSON.stringify({ siteId: 'adapter.test', origin: 'https://adapter.test', port: 8080 }),
      'site/live/index.html': '<!doctype html><button id="save">Save</button>',
      'runtime-adapter/manifest.json': JSON.stringify({ version: 1, routes: [{ method: 'GET', path: '/api/items' }] }),
      'runtime-adapter/index.mjs': 'export async function handle() { return Response.json([]); }',
    };
    for (const [name, body] of Object.entries(files)) {
      const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body);
    }
    const entries = Object.entries(files).map(([p, body]) => ({ p, s: Buffer.byteLength(body), h: createHash('sha256').update(body).digest('hex') }));
    writeFileSync(join(root, 'checksums.json'), JSON.stringify({ files: entries }));
    const planPath = join(root, '..', 'operation-plan.json');
    writeFileSync(planPath, JSON.stringify({ version: 1, flows: [{ path: '/', actions: [], expect: [{ type: 'visible', selector: '#save' }] }] }));
    const reportPath = join(root, '..', 'adapter-egress-verification.json');
    const calls = [];
    const runDocker = args => {
      calls.push(args);
      if (args[0] === 'inspect') return 'none';
      if (args[0] === 'exec') return JSON.stringify({ health: 'passed', root: 'passed', declaredRoutes: 1,
        exercisedRoutes: 1, untestedRoutes: 0, gapLedger: { uniqueGaps: 0 }, stateVolume: 'passed' });
      return '';
    };
    const result = await verifyDeploymentBundle({ bundleDir: root, siteId: 'adapter.test', reportPath,
      operationPlanPath: planPath, runDocker, observeMs: 1,
      copySnapshot: ({ destination }) => cpSync(root, destination, { recursive: true }),
      probeOperations: async (snapshot, flows, sessions) => {
        assert.ok(snapshot.includes('heimdall-adapter-image-'));
        assert.equal(flows.length, 1);
        assert.deepEqual(sessions, {});
        return { planned: 1, checked: 1, failed: 0, untested: 0, flows: [{ passed: true }] };
      },
    });
    assert.equal(result.report.serverEgress, 'verified');
    assert.equal(result.report.checks.operationProbe.scope, 'final-image-filesystem');
    assert.equal(result.report.checks.operationProbe.checked, 1);
    assert.equal(result.report.checks.operationProbe.failed, 0);
    assert.equal(validateDeploymentReport(result.report, {
      siteId: 'adapter.test', checksumsSha256: verifyBundleChecksums(root),
    }), true);
    assert.equal(calls.filter(args => args[0] === 'exec').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('static deployment verification checks the final image filesystem with Chromium', async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-static-deployment-verify-'));
  try {
    mkdirSync(join(root, 'site', 'live'), { recursive: true });
    const files = {
      'health.json': JSON.stringify({ adapter: { status: 'not-included' }, offline: true }),
      'Dockerfile': 'FROM node:22-alpine',
      'serve.mjs': 'console.log(1)',
      'heimdall-live.json': JSON.stringify({ siteId: 'example.test', port: 8080 }),
      'site/live/index.html': '<!doctype html><h1>Example</h1>',
    };
    for (const [name, body] of Object.entries(files)) {
      const file = join(root, name); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, body);
    }
    const entries = Object.entries(files).map(([p, body]) => ({ p, s: Buffer.byteLength(body), h: createHash('sha256').update(body).digest('hex') }));
    writeFileSync(join(root, 'checksums.json'), JSON.stringify({ files: entries }));
    const reportPath = join(root, '..', 'deployment-verification.json');
    const calls = [];
    const runDocker = args => {
      calls.push(args);
      if (args[0] === 'inspect') return 'none';
      if (args[0] === 'exec') return JSON.stringify({ health: 'passed', root: 'passed', routes: ['/'], routesChecked: 1, sourceWorkspace: 'passed' });
      return '';
    };
    const result = await verifyStaticDeploymentBundle({ bundleDir: root, siteId: 'example.test', reportPath, runDocker, observeMs: 1,
      copySnapshot: ({ destination }) => cpSync(root, destination, { recursive: true }),
      probeBrowser: async (_snapshot, routes) => ({ checked: routes.length, failed: 0, untested: 0, truncated: false, failureCount: 0 }),
    });
    assert.equal(result.report.deployment, 'verified');
    assert.equal(result.report.checks.routes.checked, 1);
    assert.equal(result.report.checks.restart, 'passed');
    assert.equal(result.report.checks.browserProbe.scope, 'final-image-filesystem');
    assert.equal(result.report.checks.browserProbe.checked, 1);
    assert.equal(validateStaticDeploymentReport(result.report, { siteId: 'example.test', checksumsSha256: verifyBundleChecksums(root) }), true);
    assert.equal(calls.filter(args => args[0] === 'exec').length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
