import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveVerifyArtifacts, evidenceSha256, resultSha256, resumeIdentity } from '../src/verify/resume-cache.mjs';

test('result digest detects changed scores without hashing its own proof', () => {
  const result = { measured: true, overall: 1, viewports: [{ name: '100x100', score: 1 }] };
  const digest = resultSha256(result);
  assert.ok(digest);
  assert.equal(resultSha256({ ...result, measurementProof: { resultSha256: digest }, resumeCache: {} }), digest);
  assert.notEqual(resultSha256({ ...result, overall: 0.5 }), digest);
  assert.notEqual(resultSha256({ ...result, viewports: [{ name: '100x100', score: 0.5 }] }), digest);
  assert.equal(resultSha256(null), null);
});

test('resume identity follows file contents, settings and verifier, not modification times', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-cache-identity-'));
  try {
    mkdirSync(join(dir, 'clone', 'assets'), { recursive: true });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target: 'http://cache-fixture.invalid/' }));
    writeFileSync(join(dir, 'clone', 'index.html'), '<html></html>');
    for (const file of ['style.css', 'app.js', 'assets/image.png']) writeFileSync(join(dir, 'clone', file), 'original');
    const options = { viewports: ['100x100'], interactions: false, keepScreenshots: false,
      allowBounded: false, settleTimeout: 2500, jobs: 1 };
    const identity = () => resumeIdentity(dir, options, 'verifier-a');
    const original = identity();
    assert.ok(original?.inputs);
    for (const file of ['style.css', 'app.js', 'assets/image.png']) {
      const path = join(dir, 'clone', file);
      const before = statSync(path);
      writeFileSync(path, 'modified');
      utimesSync(path, before.atime, before.mtime);
      assert.notEqual(identity().inputs, original.inputs, file);
      writeFileSync(path, 'original');
    }
    assert.deepEqual(identity(), original);
    assert.notDeepEqual(resumeIdentity(dir, { ...options, allowBounded: true }, 'verifier-a'), original);
    assert.notDeepEqual(resumeIdentity(dir, options, 'verifier-b'), original);
    assert.equal(resumeIdentity(dir, { ...options, interactions: true }, 'verifier-a'), null);
    assert.equal(resumeIdentity(dir, options, null), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume identity refuses links and files blocked as secrets', t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-cache-links-'));
  try {
    mkdirSync(join(dir, 'clone'));
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target: 'http://cache-fixture.invalid/' }));
    writeFileSync(join(dir, 'clone', 'index.html'), 'x');
    const options = { interactions: false };
    writeFileSync(join(dir, 'clone', 'session.json'), '{}');
    assert.equal(resumeIdentity(dir, options, 'v'), null);
    rmSync(join(dir, 'clone', 'session.json'));
    try { symlinkSync(join(dir, 'manifest.json'), join(dir, 'clone', 'link')); }
    catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('symbolic links unavailable');
      throw error;
    }
    assert.equal(resumeIdentity(dir, options, 'v'), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resume evidence detects missing or altered full and tiled screenshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-cache-evidence-'));
  try {
    const result = { viewports: [{ name: '100x100', captureMode: 'full' }] };
    for (const name of ['diff-100x100.png', 'src-100x100.png', 'clone-100x100.png']) writeFileSync(join(dir, name), name);
    const original = evidenceSha256(result, dir, true);
    assert.ok(original);
    writeFileSync(join(dir, 'diff-100x100.png'), 'changed');
    assert.notEqual(evidenceSha256(result, dir, true), original);
    rmSync(join(dir, 'clone-100x100.png'));
    assert.equal(evidenceSha256(result, dir, true), null);
    assert.ok(evidenceSha256(result, dir, false));

    const tiled = { viewports: [{ name: '100x100', captureMode: 'tiled', sourceHeight: 4097, cloneHeight: 100,
      diffParts: ['diff-100x100-part-001.png', 'diff-100x100-part-002.png'] }] };
    for (const name of [...tiled.viewports[0].diffParts, 'src-100x100-part-001.png',
      'src-100x100-part-002.png', 'clone-100x100-part-001.png']) writeFileSync(join(dir, name), name);
    assert.ok(evidenceSha256(tiled, dir, true));
    rmSync(join(dir, 'src-100x100-part-002.png'));
    assert.equal(evidenceSha256(tiled, dir, true), null);
    tiled.viewports[0].diffParts[0] = '../unexpected.png';
    assert.equal(evidenceSha256(tiled, dir, false), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('archiving previous evidence leaves originals and unrelated files in place', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-cache-archive-'));
  const dir = join(root, 'page');
  try {
    mkdirSync(dir);
    for (const name of ['verify.json', 'diff-100x100.png', 'notes.txt']) writeFileSync(join(dir, name), name);
    const archive = archiveVerifyArtifacts(dir);
    assert.equal(readFileSync(join(archive, 'verify.json'), 'utf8'), 'verify.json');
    assert.equal(readFileSync(join(dir, 'diff-100x100.png'), 'utf8'), 'diff-100x100.png');
    assert.equal(existsSync(join(archive, 'notes.txt')), false);
    assert.equal(existsSync(join(dir, 'notes.txt')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
