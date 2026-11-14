import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDeploymentReport, verifyBundleChecksums } from '../src/live/deployment-verify.mjs';

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
