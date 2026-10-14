#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-upgrade-fault-'));
const server = createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><head><title>Fixture</title></head><body><main>Fixture</main></body></html>');
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${server.address().port}/`;
  const base = join(dataDir, 'workspace', '127.0.0.1');
  const page = join(base, 'pages', 'home');
  const verify = join(base, 'verify');
  mkdirSync(join(page, 'clone'), { recursive: true });
  mkdirSync(verify, { recursive: true });
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target }));
  const original = 'old clone bytes';
  writeFileSync(join(page, 'clone', 'index.html'), original);
  writeFileSync(join(verify, 'verify-summary.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    scoreVersion: 2,
    mode: 'all',
    targetTotal: 1,
    measured: 1,
    untested: 0,
    pages: [{ page: 'home', overall: 0.1, measured: true, minViewport: { name: '375x812', score: 0.1 } }],
  }));

  const run = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/crawler/responsive-upgrade.mjs', '127.0.0.1'], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  assert.equal(run.code, 1, run.output);
  assert.ok(existsSync(join(base, 'audit', 'responsive-upgrade.json')), run.output);
  assert.equal(readFileSync(join(page, 'clone', 'index.html'), 'utf8'), original);
  const report = JSON.parse(readFileSync(join(base, 'audit', 'responsive-upgrade.json'), 'utf8'));
  assert.equal(report.failed, 1);
  assert.match(report.results[0].error, /build_clone\.mjs failed/);
  const staging = join(base, 'audit', 'upgrade-candidates');
  assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'failed candidate must be removed');
  assert.equal(existsSync(join(base, 'audit', 'upgrade-backups')), false, 'old page must not be moved');
  console.log('[smoke-upgrade-failure] pass: build failure left the original clone unchanged');
} finally {
  await new Promise(resolve => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
}
