import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildCoverageLedger } from '../src/live/coverage.mjs';
import { liveSnapshotPath } from '../src/live/live-path.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));
const HOST = 'fixture.test';
const ORIGIN = 'https://' + HOST;

function put(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function clone(base, bundle, name, target, live = true) {
  put(join(base, 'pages', name, 'manifest.json'), JSON.stringify({ target }));
  put(join(base, 'pages', name, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  put(join(bundle, 'site', 'static', HOST, 'pages', name, 'clone', 'index.html'), '<!doctype html><title>clone</title>');
  if (live) {
    const url = new URL(target);
    put(join(bundle, 'site', 'live', liveSnapshotPath(url.pathname, url.search)), '<!doctype html><title>live</title>');
  }
}

test('coverage matches origin and query-specific routes, reporting undistributed paths without query secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    clone(base, bundle, 'list', ORIGIN + '/list?page=1', false);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({
      origin: ORIGIN, nodes: [
        { url: ORIGIN + '/' },
        { url: ORIGIN + '/list?page=1' },
        { url: ORIGIN + '/users/alice@example.com?token=secret' },
        { url: ORIGIN + '/reset/short-secret?token=hidden' },
      ], meta: { maxPages: 40, maxDepth: 2 },
    }));
    const ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home', 'list'] });
    assert.equal(ledger.scope, 'recon-discovered');
    assert.equal(ledger.denominator, 4);
    assert.equal(ledger.capturedClones, 2);
    assert.equal(ledger.cloned, 2);
    assert.equal(ledger.delivered, 1);
    assert.equal(ledger.missingClone, 2);
    assert.equal(ledger.missingLive, 1);
    assert.deepEqual(ledger.missingPaths, [
      { sourceIndex: 1, path: '/[redacted]?[redacted]', reason: 'no-live-route' },
      { sourceIndex: 2, path: '/[redacted]/[redacted]?[redacted]', reason: 'not-cloned' },
      { sourceIndex: 3, path: '/[redacted]/[redacted]?[redacted]', reason: 'not-cloned' },
    ]);
    assert.doesNotMatch(JSON.stringify(ledger), /alice|secret|page=1|short-secret|hidden/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('coverage explicitly limits no-atlas claims and rejects a foreign atlas', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-source-'));
  const base = join(dir, 'workspace', HOST);
  const bundle = join(dir, 'bundle');
  try {
    clone(base, bundle, 'home', ORIGIN + '/');
    let ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.scope, 'captured-only');
    assert.equal(ledger.denominator, 1);
    assert.equal(ledger.delivered, 1);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://other.test', nodes: [{ url: 'https://other.test/' }] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.scope, 'untrusted-recon');
    assert.equal(ledger.sourceStatus, 'invalid');
    assert.equal(ledger.sourceIssue, 'origin-mismatch');
    assert.equal(ledger.denominator, null);
    assert.equal(ledger.missingClone, 0);
    assert.equal(ledger.extraClones, null);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ nodes: [{ url: ORIGIN + '/' }, { url: 'https://other.test/' }] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.sourceIssue, 'foreign-nodes');
    assert.equal(ledger.foreignNodes, 1);
    assert.equal(ledger.denominator, null);
    assert.equal(ledger.observedTargets, 1);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ nodes: [{ url: ORIGIN + '/' }] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.sourceStatus, 'ok', 'single-origin legacy atlas remains usable');
    assert.equal(ledger.denominator, 1);
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: ORIGIN, status: 'ok', nodes: [] }));
    ledger = buildCoverageLedger({ baseDir: base, bundleDir: bundle, host: HOST, origin: ORIGIN, pageNames: ['home'] });
    assert.equal(ledger.sourceIssue, 'empty-atlas');
    assert.equal(ledger.denominator, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export blocks every discovered but un-cloned URL, including nodes beyond page 40', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-export-'));
  const base = join(dir, 'workspace', HOST);
  const out = join(dir, 'deliverable', 'accepted');
  try {
    put(join(base, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
    put(join(base, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    put(join(base, 'live', 'index.html'), '<!doctype html><title>live</title>');
    const nodes = [{ url: ORIGIN + '/' }, ...Array.from({ length: 44 }, (_, i) => ({ url: ORIGIN + '/page-' + (i + 1) }))];
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: ORIGIN, status: 'ok', nodes, meta: { maxPages: 100, maxDepth: 3 } }));
    put(join(out, 'keep.txt'), 'last accepted');
    const result = spawnSync(process.execPath, [EXPORT, HOST, '--offline', '--strict', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'last accepted');
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(health.coverage.denominator, 45);
    assert.equal(health.coverage.delivered, 1);
    assert.equal(health.coverage.missingClone, 44);
    assert.equal(health.coverage.missingPaths.length, 44);
    assert.equal(health.strictBlockers.discoveredUncloned, 44);
    assert.equal(health.browserProbe.untested, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('strict export refuses a foreign recon despite a matching site ownership marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-coverage-origin-'));
  const base = join(dir, 'workspace', HOST);
  const out = join(dir, 'deliverable', 'accepted');
  try {
    put(join(base, 'site-origin.json'), JSON.stringify({ origin: ORIGIN }));
    put(join(base, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: ORIGIN + '/' }));
    put(join(base, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>clone</title>');
    put(join(base, 'live', 'index.html'), '<!doctype html><title>live</title>');
    put(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://other.test', nodes: [{ url: 'https://other.test/private' }] }));
    put(join(out, 'keep.txt'), 'last accepted');
    const result = spawnSync(process.execPath, [EXPORT, HOST, '--offline', '--strict', '--out', out], {
      cwd: CORE, encoding: 'utf8', env: { ...process.env, HEIMDALL_DATA_DIR: dir }, timeout: 30_000,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(readFileSync(join(out, 'keep.txt'), 'utf8'), 'last accepted');
    const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
    assert.ok(candidate);
    const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
    assert.equal(health.coverage.denominator, null);
    assert.equal(health.coverage.sourceIssue, 'origin-mismatch');
    assert.equal(health.strictBlockers.coverageInvalid, 1);
    assert.equal(health.strictBlockers.discoveredUncloned, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
