import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatHttpCheckFailure, readHttpChecks, validateDeploymentReport, verifyBundleChecksums } from '../src/live/deployment-verify.mjs';

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
