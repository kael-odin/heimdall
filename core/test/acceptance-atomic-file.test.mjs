import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, renameSync, closeSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'acceptance-atomic-file-'));
  const file = join(directory, 'manifest.json');
  writeFileSync(file, '{"status":"old"}');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, file };
}
const busy = code => Object.assign(new Error(`Fixture ${code} replacement failure`), { code });

test('atomic writes replace the destination with a complete file and leave no temporary files', t => {
  const { directory, file } = fixture(t);
  const result = writeAtomicFileSync(file, '{"status":"new"}');
  assert.deepEqual(result, { attempts: 1, retries: 0, waitedMs: 0 });
  assert.equal(readFileSync(file, 'utf8'), '{"status":"new"}');
  assert.deepEqual(readdirSync(directory), ['manifest.json']);
});

test('Windows sharing failures retry while readers continue to see the intact old manifest', t => {
  const { directory, file } = fixture(t);
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    writeFileSync(file, '{"status":"old"}');
    let calls = 0, clock = 0;
    const result = writeAtomicFileSync(file, '{"status":"new"}', {
      platform: 'win32', now: () => clock, sleep: delay => { clock += delay; },
      io: { rename: (source, destination) => { if (++calls <= 2) throw busy(code); renameSync(source, destination); } },
      onRetry: event => {
        assert.equal(readFileSync(file, 'utf8'), '{"status":"old"}');
        assert.equal(readFileSync(event.temporary, 'utf8'), '{"status":"new"}');
        assert.equal(event.code, code);
      },
    });
    assert.equal(result.attempts, 3);
    assert.equal(result.waitedMs, 30);
    assert.equal(readFileSync(file, 'utf8'), '{"status":"new"}');
    assert.deepEqual(readdirSync(directory), ['manifest.json']);
  }
});

test('permanent Windows sharing errors retain the old file and clean only their own temporary file', t => {
  const { directory, file } = fixture(t);
  const unrelated = join(directory, 'unrelated.tmp');
  writeFileSync(unrelated, 'keep this file');
  let clock = 0, calls = 0;
  assert.throws(() => writeAtomicFileSync(file, 'new', {
    platform: 'win32', maxRetryMs: 45, now: () => clock, sleep: delay => { clock += delay; },
    io: { rename: () => { calls++; throw busy('EPERM'); } },
  }), error => error.name === 'AtomicFileError' && error.code === 'EPERM' && error.retryExhausted && error.waitedMs === 45 && error.cause.code === 'EPERM');
  assert.equal(calls, 4);
  assert.equal(readFileSync(file, 'utf8'), '{"status":"old"}');
  assert.equal(readFileSync(unrelated, 'utf8'), 'keep this file');
  assert.deepEqual(readdirSync(directory).sort(), ['manifest.json', 'unrelated.tmp']);
});

test('non-Windows sharing errors and other filesystem errors fail immediately without retry', t => {
  const { directory, file } = fixture(t);
  for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOSPC'], ['win32', 'ENOENT']]) {
    let calls = 0;
    assert.throws(() => writeAtomicFileSync(file, 'new', {
      platform, io: { rename: () => { calls++; throw busy(code); } },
      sleep: () => assert.fail('This failure must not be retried'),
    }), error => error.code === code && error.attempts === 1 && !error.retryExhausted);
    assert.equal(calls, 1);
    assert.equal(readFileSync(file, 'utf8'), '{"status":"old"}');
    assert.deepEqual(readdirSync(directory), ['manifest.json']);
  }
});

test('a failed temporary-file write closes its descriptor, removes the partial file and preserves the old manifest', t => {
  const { directory, file } = fixture(t);
  let closes = 0;
  assert.throws(() => writeAtomicFileSync(file, 'new', {
    io: {
      write: descriptor => { writeFileSync(descriptor, 'partial'); throw busy('ENOSPC'); },
      close: descriptor => { closes++; closeSync(descriptor); },
      rename: () => assert.fail('A partial temporary file must not be published'),
    },
  }), error => error.code === 'ENOSPC' && error.attempts === 0);
  assert.equal(closes, 1);
  assert.equal(readFileSync(file, 'utf8'), '{"status":"old"}');
  assert.deepEqual(readdirSync(directory), ['manifest.json']);
});

test('the retry wait is capped even when an injected clock does not advance', t => {
  const { file } = fixture(t);
  let waited = 0, calls = 0;
  assert.throws(() => writeAtomicFileSync(file, 'new', {
    platform: 'win32', maxRetryMs: 1_000, now: () => 0, sleep: delay => { waited += delay; },
    io: { rename: () => { calls++; throw busy('EACCES'); } },
  }), error => error.waitedMs === 1_000);
  assert.equal(waited, 1_000);
  assert.ok(calls < 15);
  assert.throws(() => writeAtomicFileSync(file, 'new', { maxRetryMs: 1001 }), RangeError);
});

test('real Windows reader holding a non-delete-sharing file handle releases after 180ms and replacement succeeds', { skip: process.platform !== 'win32', timeout: 15_000 }, async t => {
  const { directory, file } = fixture(t);
  const releaseFile = join(directory, 'release-lock');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$acceptanceLockStream = [System.IO.File]::Open($env:ACCEPTANCE_LOCK_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    'try {',
    "  [Console]::WriteLine('LOCKED')",
    '  while (-not [System.IO.File]::Exists($env:ACCEPTANCE_LOCK_RELEASE)) { Start-Sleep -Milliseconds 5 }',
    '  Start-Sleep -Milliseconds 180',
    '} finally { $acceptanceLockStream.Dispose() }',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ACCEPTANCE_LOCK_FILE: file, ACCEPTANCE_LOCK_RELEASE: releaseFile },
  });
  let stderr = '', stdout = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed.catch(() => {}); });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('LOCKED')) resolve(); });
    child.once('error', reject);
    child.once('close', code => { if (!stdout.includes('LOCKED')) reject(new Error(`Reader exited (${code}): ${stderr}`)); });
  });
  const originalObservations = [];
  const started = performance.now();
  const result = writeAtomicFileSync(file, '{"status":"new"}', {
    onRetry: () => {
      originalObservations.push(readFileSync(file, 'utf8'));
      if (!existsSync(releaseFile)) writeFileSync(releaseFile, 'release after 180 ms');
    },
  });
  const elapsedMs = performance.now() - started;
  assert.ok(result.retries >= 1, 'A real non-share-delete handle must block the first replacement');
  assert.ok(elapsedMs >= 150 && elapsedMs < 1_000, `Expected bounded real retry, got ${elapsedMs} ms`);
  assert.ok(originalObservations.every(text => text === '{"status":"old"}'));
  assert.equal(readFileSync(file, 'utf8'), '{"status":"new"}');
  assert.equal(await closed, 0, stderr);
  assert.deepEqual(readdirSync(directory).sort(), ['manifest.json', 'release-lock']);
  t.diagnostic(`Real Windows lock released after 180 ms; ${result.retries} retries, ${Math.round(elapsedMs)} ms, old manifest readable until atomic replacement.`);
});
