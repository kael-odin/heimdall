import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { auditBundlePrivacy } from '../src/live/privacy-audit.mjs';

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test('privacy audit reports credential query, Bearer and Cookie counts without values or raw path names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-'));
  try {
    const secretDir = join(dir, 'site', 'static', 'secret-host.example', 'pages', 'alice@example.com', 'clone');
    put(join(secretDir, 'index.html'), [
      '<a href="https://example.test/private?access_token=realAccess12345&page=1">link</a>',
      '<img src="/image?%61pi_key=realApiKey98765&amp;w=2">',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'Cookie: theme=dark; session=realSession123; tracking=0123456789abcdef',
      'Set-Cookie: auth=privateValue123; Path=/; HttpOnly',
    ].join('\n'));
    put(join(dir, 'site', 'live', 'index.html'), 'https:\\/\\/example.test\\/?client_secret=encodedSecret123');
    const audit = auditBundlePrivacy({ bundleDir: dir });
    assert.equal(audit.status, 'issues');
    assert.deepEqual(audit.counts, {
      'credential-query': 3,
      'bearer-value': 1,
      'cookie-value': 3,
    });
    assert.equal(audit.issueCount, 7);
    assert.equal(audit.failureCount, 0);
    assert.ok(audit.findings.every(item => item.path.startsWith('site/')));
    const report = JSON.stringify(audit);
    assert.doesNotMatch(report, /realAccess|realApiKey|realSession|privateValue|encodedSecret|eyJhbG|alice@|secret-host/);
    assert.match(report, /\[redacted-[a-f0-9]{12}\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy audit does not mistake pagination, placeholders, benign cookies or binary content for credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-clean-'));
  try {
    put(join(dir, 'site', 'live', 'index.html'), [
      '<a href="/list?page=1&amp;sort=recent">next</a>',
      'Authorization: Bearer YOUR_TOKEN',
      'Cookie: theme=dark; locale=en',
      'const header = `Bearer ${token}`;',
      'https://example.test/path?token=redacted',
      'https://localhost:51204/__vitest__/?token=123',
      'http://localhost:51204/__vitest__/?token=`...`',
    ].join('\n'));
    put(join(dir, 'site', 'live', 'guide.md'), Buffer.from('\u001b[32m# Benchmarking\u001b[39m\n', 'utf8'));
    put(join(dir, 'site', 'static', 'source.test', 'assets', 'photo.png'), Buffer.from('Cookie: session=realValue123\0', 'utf8'));
    const audit = auditBundlePrivacy({ bundleDir: dir });
    assert.equal(audit.status, 'clean');
    assert.equal(audit.issueCount, 0);
    assert.equal(audit.scannedFiles, 2);
    assert.equal(audit.skippedBinaryFiles, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy audit inspects bounded decoded text bodies in har.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-har-'));
  try {
    const body = Buffer.from('Authorization: Bearer decodedBodyToken12345', 'utf8').toString('base64');
    put(join(dir, 'har.json'), JSON.stringify({ entries: [{ mimeType: 'application/json', bodyEncoding: 'base64', body }] }));
    const audit = auditBundlePrivacy({ bundleDir: dir });
    assert.equal(audit.status, 'issues');
    assert.equal(audit.counts['bearer-value'], 1);
    assert.deepEqual(audit.findings, [{ path: 'har.json', type: 'bearer-value', count: 1 }]);
    assert.doesNotMatch(JSON.stringify(audit), /decodedBodyToken/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy audit explains scan limits, malformed metadata and undecodable text without exposing content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-limits-'));
  try {
    put(join(dir, 'site', 'live', 'oversize.html'), 'A'.repeat(50));
    put(join(dir, 'har.json'), '{broken');
    put(join(dir, 'bad.txt'), Buffer.from([0xff, 0xfe, 0x00]));
    const audit = auditBundlePrivacy({ bundleDir: dir, limits: { maxFileBytes: 40 } });
    assert.equal(audit.status, 'incomplete');
    assert.ok(audit.failures.some(item => item.reason === 'file-byte-limit'));
    assert.ok(audit.failures.some(item => item.reason === 'invalid-har-json'));
    assert.ok(audit.failures.some(item => item.reason === 'undecodable-text'));
    assert.doesNotMatch(JSON.stringify(audit), /broken|oversize/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy audit marks a file-count-limited scan incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-count-'));
  try {
    put(join(dir, 'first.txt'), 'ordinary content');
    put(join(dir, 'second.txt'), 'ordinary content');
    const audit = auditBundlePrivacy({ bundleDir: dir, limits: { maxFiles: 1 } });
    assert.equal(audit.status, 'incomplete');
    assert.equal(audit.filesVisited, 2);
    assert.equal(audit.failureCount, 1);
    assert.equal(audit.failures[0].reason, 'file-limit');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('privacy audit never follows a package symlink', t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-privacy-link-'));
  const outside = mkdtempSync(join(tmpdir(), 'heimdall-privacy-outside-'));
  try {
    put(join(outside, 'credential.txt'), 'Authorization: Bearer outsideSecret12345');
    try { symlinkSync(join(outside, 'credential.txt'), join(dir, 'link.txt'), 'file'); }
    catch { t.skip('file symlinks unavailable on this host'); return; }
    const audit = auditBundlePrivacy({ bundleDir: dir });
    assert.equal(audit.status, 'incomplete');
    assert.equal(audit.issueCount, 0);
    assert.deepEqual(audit.failures, [{ path: audit.failures[0].path, reason: 'symbolic-link' }]);
    assert.doesNotMatch(JSON.stringify(audit), /outsideSecret|credential\.txt/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
