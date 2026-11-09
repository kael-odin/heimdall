import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baselineFileKey, versionedBaselineFileKey, readBaselineFile } from '../src/seo/baseline-file.mjs';
import { SEO_SCORE_METHOD_VERSION, SEO_MEASUREMENT_VERSION } from '../src/seo/method.mjs';
import { buildBaseline } from '../src/seo/baseline.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

test('damaged required baseline fails before crawling and remains unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-baseline-'));
  try {
    const baselinePath = join(root, 'baseline.json');
    const broken = '{"version":1,"pages":';
    writeFileSync(baselinePath, broken);
    assert.throws(() => readBaselineFile(baselinePath, { required: true }), /cannot be parsed/);

    const run = spawnSync(process.execPath, [
      'src/seo/audit.mjs', 'http://127.0.0.1:1',
      '--baseline', baselinePath, '--require-baseline', '--fail-on-regression',
    ], { cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /baseline cannot be parsed/);
    assert.equal(readFileSync(baselinePath, 'utf8'), broken);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline file must have the current version and a page map', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-shape-'));
  try {
    const baselinePath = join(root, 'baseline.json');
    assert.throws(() => readBaselineFile(baselinePath, { required: true }), /not found/);
    assert.equal(readBaselineFile(baselinePath), null);
    writeFileSync(baselinePath, '{"version":1}');
    assert.throws(() => readBaselineFile(baselinePath), /invalid structure/);
    writeFileSync(baselinePath, '{"version":0,"pages":{}}');
    assert.throws(() => readBaselineFile(baselinePath), /baseline version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline schema rejects empty pages, cross-origin pages, and unknown severities', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-baseline-schema-'));
  try {
    const baselinePath = join(root, 'baseline.json');
    const valid = {
      version: 1,
      host: 'example.com',
      origin: 'https://example.com',
      stable: 100,
      score: 100,
      pages: {
        'https://example.com': { stable: 100, score: 100, issues: {} },
      },
      siteIssues: {},
      summary: { pages: 1, issues: 0 },
    };
    writeFileSync(baselinePath, JSON.stringify(valid));
    assert.deepEqual(readBaselineFile(baselinePath, {
      required: true, expectedOrigin: 'https://example.com/', expectedHost: 'example.com',
    }), valid);

    const cases = [
      { ...valid, pages: {} },
      { ...valid, origin: 'https://other.example' },
      { ...valid, pages: { 'https://other.example': valid.pages['https://example.com'] } },
      { ...valid, pages: { 'https://example.com': { ...valid.pages['https://example.com'], issues: { 'content-title': 'urgent' } } } },
      { ...valid, pages: { 'https://example.com': { ...valid.pages['https://example.com'], stable: 101 } } },
    ];
    for (const item of cases) {
      writeFileSync(baselinePath, JSON.stringify(item));
      assert.throws(() => readBaselineFile(baselinePath), /invalid structure|origin|cross-origin|severity|between 0 and 100/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function validBaseline(over = {}) {
  return {
    version: 1,
    host: 'example.com',
    origin: 'https://example.com',
    stable: 100,
    score: 100,
    pages: {
      'https://example.com': { stable: 100, score: 100, issues: {} },
    },
    siteIssues: {},
    ...over,
  };
}

test('baseline file rejects empty or semantically damaged snapshots', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-baseline-semantic-'));
  try {
    const file = join(root, 'baseline.json');
    writeFileSync(file, JSON.stringify(validBaseline({ pages: {} })));
    assert.throws(() => readBaselineFile(file, { required: true }), /pages is empty/);

    writeFileSync(file, JSON.stringify(validBaseline({ origin: 'https://other.example' })));
    assert.throws(() => readBaselineFile(file, { required: true, expectedOrigin: 'https://example.com', expectedHost: 'example.com' }), /origin mismatch/);

    writeFileSync(file, JSON.stringify(validBaseline({ pages: {
      'https://example.com': { stable: 100, score: 100, issues: { 'content-title-missing': 'urgent' } },
    } })));
    assert.throws(() => readBaselineFile(file, { required: true, expectedOrigin: 'https://example.com' }), /invalid severity/);

    writeFileSync(file, JSON.stringify(validBaseline({ pages: {
      'https://other.example': { stable: 100, score: 100, issues: {} },
    } })));
    assert.throws(() => readBaselineFile(file, { required: true, expectedOrigin: 'https://example.com' }), /cross-origin/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('baseline file key is stable and cannot collide on origin protocol or port', () => {
  const apex = baselineFileKey('https://example.com/path');
  assert.match(apex, /^example\.com--origin-[a-f0-9]{24}$/);
  assert.equal(versionedBaselineFileKey('https://example.com/path'), `${apex}--score-v${SEO_SCORE_METHOD_VERSION}--measure-v${SEO_MEASUREMENT_VERSION}`);
  assert.notEqual(versionedBaselineFileKey('https://example.com/path'), apex);
  assert.equal(baselineFileKey('https://example.com/other'), apex);
  assert.notEqual(baselineFileKey('https://www.example.com/path'), apex);
  assert.notEqual(baselineFileKey('http://example.com/path'), apex);
  assert.notEqual(baselineFileKey('https://example.com:8443/path'), apex);
  assert.throws(() => baselineFileKey('not a target'), /valid URL|Invalid URL/);
});

test('generated baseline with a query on a trailing-slash path passes its own schema', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-query-baseline-'));
  try {
    const file = join(root, 'baseline.json');
    const baseline = buildBaseline({
      host: 'example.com', origin: 'https://example.com',
      pages: [{ url: 'https://example.com/docs/?page=2', issues: [] }],
      siteIssues: [], summary: { issues: 0 },
    });
    assert.deepEqual(Object.keys(baseline.pages), ['https://example.com/docs?page=2']);
    writeFileSync(file, JSON.stringify(baseline));
    assert.deepEqual(readBaselineFile(file, { required: true, expectedOrigin: baseline.origin }), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('audit refuses a valid baseline for another origin before crawling', () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-seo-baseline-origin-'));
  try {
    const baselinePath = join(root, 'baseline.json');
    writeFileSync(baselinePath, JSON.stringify(validBaseline()));
    const run = spawnSync(process.execPath, [
      'src/seo/audit.mjs', 'http://127.0.0.1:1', '--baseline', baselinePath,
      '--require-baseline', '--fail-on-regression',
    ], { cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 5000 });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stderr, /baseline origin mismatch/);
    assert.doesNotMatch(run.stderr, /fetching robots/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
