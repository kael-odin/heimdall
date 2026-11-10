import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  collectRuntimeServiceCacheUrls,
  fetchRuntimeServiceCache,
  parseRuntimeServiceCacheFile,
  validateRuntimeServiceCacheServices,
} from '../src/live/runtime-service-cache.mjs';
import { localizeQueryEntries, rewriteLocalRefs } from '../src/live/heal.mjs';

test('runtime service cache list is explicit and bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-runtime-policy-'));
  try {
    const file = join(dir, 'services.json');
    writeFileSync(file, JSON.stringify(['iconify', 'vite-sponsors', 'github-avatars']));
    assert.deepEqual([...parseRuntimeServiceCacheFile(file)].sort(), ['github-avatars', 'iconify', 'vite-sponsors']);
    writeFileSync(file, JSON.stringify(['iconify', 'iconify']));
    assert.throws(() => parseRuntimeServiceCacheFile(file), TypeError);
    writeFileSync(file, JSON.stringify(['not a service id']));
    assert.throws(() => parseRuntimeServiceCacheFile(file), TypeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runtime cache collects only approved GET services from source HAR', () => {
  const harEntries = [
    { request: { method: 'GET', url: 'https://api.iconify.design/simple-icons.json?icons=github' }, response: { status: 200 } },
    { request: { method: 'GET', url: 'https://sponsors.vite.dev/sponsors.json' }, response: { status: 200 } },
    { request: { method: 'GET', url: 'https://github.com/sapphi-red.png' }, response: { status: 302 } },
    { request: { method: 'GET', url: 'https://cdn.example.org/app.js' }, response: { status: 200 } },
    { request: { method: 'POST', url: 'https://api.iconify.design/simple-icons.json' }, response: { status: 200 } },
  ];
  const urls = collectRuntimeServiceCacheUrls({
    harEntries,
    services: new Set(['iconify', 'vite-sponsors', 'github-avatars']),
  });
  assert.deepEqual([...urls].sort(), [
    'https://api.iconify.design/simple-icons.json?icons=github',
    'https://api.simplesvg.com/simple-icons.json?icons=github',
    'https://api.unisvg.com/simple-icons.json?icons=github',
    'https://github.com/sapphi-red.png',
    'https://sponsors.vite.dev/sponsors.json',
  ]);
});

test('runtime cache policy refuses undiscovered service IDs', () => {
  assert.throws(() => validateRuntimeServiceCacheServices({
    services: new Set(['iconify']),
    discoveredIds: new Set(['vite-sponsors']),
  }), RangeError);
  assert.doesNotThrow(() => validateRuntimeServiceCacheServices({
    services: new Set(['iconify']),
    discoveredIds: new Set(['iconify', 'vite-sponsors']),
  }));
});

test('cached runtime origins include unsampled approved service hosts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-runtime-hosts-'));
  try {
    const liveDir = join(dir, 'live');
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(join(liveDir, 'iconify.js'),
      'const base = "https://api.unisvg.com"; export default base + "/simple-icons.json?icons=github";');
    const entry = {
      method: 'GET',
      url: 'https://api.iconify.design/simple-icons.json?icons=github',
      status: 200,
      mimeType: 'application/json',
      body: Buffer.from('{}').toString('base64'),
      kind: 'runtime-service-cache',
    };
    const localized = localizeQueryEntries({
      entries: [entry], liveDir, host: 'fixture.test', origin: 'https://fixture.test',
      hostPrefixes: true, runtimeServiceHosts: ['api.iconify.design', 'api.simplesvg.com', 'api.unisvg.com'],
    });
    assert.equal(localized.map.get('https://api.unisvg.com'), '/lm/fixture.test/_ext/api.unisvg.com');
    rewriteLocalRefs({ liveDir, map: localized.map });
    const js = readFileSync(join(liveDir, 'iconify.js'), 'utf8');
    assert.doesNotMatch(js, /https:\/\/api\.unisvg\.com/);
    assert.match(js, /\/lm\/fixture\.test\/_ext\/api\.unisvg\.com/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline server resolves localized query assets to hashed bodies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-runtime-query-serve-'));
  let child;
  try {
    for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs', 'clone-asset-cors.mjs']) {
      copyFileSync(join('src/live', name), join(dir, name));
    }
    const sourceUrl = 'https://api.iconify.design/lucide.json?icons=languages%2Csearch%2Cx';
    const digest = createHash('sha1').update(sourceUrl).digest('hex').slice(0, 8);
    const extDir = join(dir, 'site/live/_ext/api.iconify.design');
    mkdirSync(extDir, { recursive: true });
    writeFileSync(join(extDir, `lucide~${digest}.json`), '{"cached":true}');
    writeFileSync(join(dir, 'heimdall-live.json'), JSON.stringify({
      host: 'fixture.test', siteId: 'fixture.test', origin: 'https://fixture.test',
      port: 0, offline: true, replayApi: true, root: 'landing', bind: '127.0.0.1',
    }));
    child = spawn(process.execPath, [join(dir, 'serve.mjs'), '--port', '0', '--host', '127.0.0.1', '--offline'], {
      cwd: dir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const ready = await new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('exit', reject);
      setTimeout(() => reject(new Error('server startup timeout')), 10_000);
    });
    const response = await fetch(`http://127.0.0.1:${ready.port}/lm/fixture.test/_ext/api.iconify.design/lucide.json?icons=languages%2Csearch%2Cx`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-heimdall-localized-query'), '1');
    assert.equal((await response.json()).cached, true);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runtime cache follows approved redirects and preserves the original URL', async () => {
  const urls = new Set([
    'https://api.iconify.design/simple-icons.json?icons=github',
    'https://github.com/sapphi-red.png',
    'https://sponsors.vite.dev/images/bolt.svg',
  ]);
  const fetchImpl = async url => {
    if (url === 'https://api.iconify.design/simple-icons.json?icons=github') {
      return new Response(JSON.stringify({ icons: {} }), { headers: { 'content-type': 'application/json' } });
    }
    if (url === 'https://github.com/sapphi-red.png') {
      return Response.redirect('https://avatars.githubusercontent.com/u/1.png', 302);
    }
    if (url === 'https://avatars.githubusercontent.com/u/1.png') {
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } });
    }
    if (url === 'https://sponsors.vite.dev/images/bolt.svg') {
      return new Response('<svg></svg>', { headers: { 'content-type': 'image/svg+xml' } });
    }
    throw new Error('unexpected URL ' + url);
  };
  const report = await fetchRuntimeServiceCache({ urls, fetchImpl });
  assert.equal(report.requested, 3);
  assert.equal(report.fetched, 3);
  assert.equal(report.failed, 0);
  assert.equal(report.entries.length, 3);
  assert.ok(report.entries.every(entry => entry.kind === 'runtime-service-cache'));
  const github = report.entries.find(entry => entry.url === 'https://github.com/sapphi-red.png');
  assert.equal(github.mimeType, 'image/png');
  assert.equal(Buffer.from(github.body, 'base64').length, 3);
  assert.equal(report.bytes, Buffer.from(report.entries[0].body, 'base64').length + 3
    + Buffer.from('<svg></svg>').length);
});

test('runtime cache rejects unsafe query data without leaking it in failures', async () => {
  const urls = new Set(['https://api.iconify.design/icons.json?token=private-secret']);
  const report = await fetchRuntimeServiceCache({
    urls,
    fetchImpl: async () => {
      throw new Error('must not fetch unsafe URL');
    },
  });
  assert.equal(report.fetched, 0);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.failures, [{ url: 'https://api.iconify.design', reason: 'unsafe-url' }]);
  assert.doesNotMatch(JSON.stringify(report), /private-secret|token=/);
});

test('cached runtime entries localize and rewrite exact JS references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-runtime-localize-'));
  try {
    const liveDir = join(dir, 'live');
    mkdirSync(liveDir, { recursive: true });
    mkdirSync(join(liveDir, 'assets'), { recursive: true });
    writeFileSync(join(liveDir, 'assets', 'app.js'),
      'export const url = "https://api.iconify.design/simple-icons.json?icons=github";');
    const entry = {
      method: 'GET',
      url: 'https://api.iconify.design/simple-icons.json?icons=github',
      status: 200,
      mimeType: 'application/json',
      body: Buffer.from('{}').toString('base64'),
      kind: 'runtime-service-cache',
    };
    const localized = localizeQueryEntries({
      entries: [entry], liveDir, host: 'fixture.test', origin: 'https://fixture.test',
    });
    const local = localized.map.get(entry.url);
    assert.ok(local?.startsWith('/lm/fixture.test/_ext/api.iconify.design/'));
    const file = join(liveDir, local.slice('/lm/fixture.test/'.length));
    assert.ok(existsSync(file));
    assert.equal(readFileSync(file, 'utf8'), '{}');
    const rewritten = rewriteLocalRefs({ liveDir, map: localized.map });
    assert.equal(rewritten.rewrites, 1);
    assert.match(readFileSync(join(liveDir, 'assets', 'app.js'), 'utf8'), /\/lm\/fixture\.test\/_ext\/api\.iconify\.design\//);
    assert.doesNotMatch(readFileSync(join(liveDir, 'assets', 'app.js'), 'utf8'), /https:\/\/api\.iconify\.design/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cached runtime origins rewrite JS base URLs without double slashes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-runtime-origin-'));
  try {
    const liveDir = join(dir, 'live');
    mkdirSync(join(liveDir, 'assets'), { recursive: true });
    writeFileSync(join(liveDir, 'assets', 'iconify.js'),
      'const base = "https://api.iconify.design"; export default base + "/lucide.json?icons=x";');
    const entry = {
      method: 'GET',
      url: 'https://api.iconify.design/lucide.json?icons=x',
      status: 200,
      mimeType: 'application/json',
      body: Buffer.from('{}').toString('base64'),
      kind: 'runtime-service-cache',
    };
    const localized = localizeQueryEntries({
      entries: [entry], liveDir, host: 'fixture.test', origin: 'https://fixture.test', hostPrefixes: true,
    });
    rewriteLocalRefs({ liveDir, map: localized.map });
    const js = readFileSync(join(liveDir, 'assets', 'iconify.js'), 'utf8');
    assert.doesNotMatch(js, /https:\/\/api\.iconify\.design/);
    assert.match(js, /const base = "\/lm\/fixture\.test\/_ext\/api\.iconify\.design"/);
    assert.match(js, /base \+ "\/lucide\.json\?icons=x/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
