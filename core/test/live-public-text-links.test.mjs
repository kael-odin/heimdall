import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { capturePublicTextLinks } from '../src/live/public-text-links.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const EXPORT = fileURLToPath(new URL('../src/live/export.mjs', import.meta.url));

function put(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function runExport(host, out, dataDir, flags = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [EXPORT, host, '--offline', '--strict', '--root', 'mirror', '--out', out, ...flags], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-10_000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-10_000); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, output }); });
  });
}

test('public text capture enforces exact targets, MIME, redirect origin and budgets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-text-capture-'));
  const liveDir = join(dir, 'live');
  mkdirSync(liveDir);
  const origin = 'https://site.test';
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, 'manual');
    if (url.endsWith('/cross.md')) return new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/private.md' } });
    if (url.endsWith('/query.md')) return new Response(null, { status: 302, headers: { location: '/private/export.md?token=secret' } });
    if (url.endsWith('/hidden.md')) return new Response(null, { status: 302, headers: { location: '/private/guide.md' } });
    if (url.endsWith('/safe.md')) return new Response('# Guide', { status: 200, headers: { 'content-type': 'text/markdown' } });
    if (url.endsWith('/note.txt')) return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url.endsWith('/fake.md')) return new Response('<!doctype html><html>fallback</html>', { status: 200, headers: { 'content-type': 'text/markdown' } });
    if (url.endsWith('/large.txt')) return new Response('a'.repeat(40), { status: 200, headers: { 'content-type': 'text/plain' } });
    if (url.endsWith('/private-cache.md')) return new Response('# private', { status: 200,
      headers: { 'content-type': 'text/markdown', 'cache-control': 'no-store' } });
    if (url.endsWith('/no-cache.md')) return new Response('# private', { status: 200,
      headers: { 'content-type': 'text/markdown', 'cache-control': 'no-cache' } });
    return new Response('not found', { status: 404 });
  };
  try {
    const result = await capturePublicTextLinks({ liveDir, origin,
      targets: ['/safe.md', '/safe.md', '/cross.md', '/query.md', '/hidden.md', '/fake.md', '/large.txt',
        '/private-cache.md', '/no-cache.md', '/private.md', '/tokens.txt',
        '/private%252fexport.md', '/private%25252fexport.md',
        '/page/', '/unsafe.md?token=secret'],
      fetchImpl, maxFileBytes: 20, maxTotalBytes: 40,
    });
    assert.equal(result.eligible, 8);
    assert.equal(result.captured, 1);
    assert.equal(result.rejected, 7);
    assert.equal(result.bytes, 7);
    assert.equal(readFileSync(join(liveDir, 'safe.md'), 'utf8'), '# Guide');
    assert.equal(existsSync(join(liveDir, 'fake.md')), false);
    assert.equal(existsSync(join(liveDir, 'large.txt')), false);
    assert.ok(!requests.some(url => url.includes('elsewhere.test') || url.includes('unsafe.md')
      || url.includes('/private/') || url.includes('token=') || url.includes('/private.md')
      || url.includes('/tokens.txt') || url.includes('private%252f')));
    assert.deepEqual(readdirSync(liveDir), ['safe.md']);

    mkdirSync(join(dir, 'budget'));
    const budget = await capturePublicTextLinks({ liveDir: join(dir, 'budget'), origin,
      targets: ['/safe.md', '/note.txt'], fetchImpl, maxTotalBytes: 10,
    });
    assert.equal(budget.captured, 1);
    assert.equal(budget.bytes, 7);
    assert.equal(existsSync(join(dir, 'budget', 'note.txt')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public text capture reports uncaptured kinds and prioritizes documents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-text-budget-'));
  const liveDir = join(dir, 'live');
  mkdirSync(liveDir);
  const origin = 'https://site.test';
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const path = new URL(url).pathname;
    if (path.endsWith('.md')) return new Response('# Doc', { headers: { 'content-type': 'text/markdown' } });
    if (path.endsWith('.txt')) return new Response('text', { headers: { 'content-type': 'text/plain' } });
    return new Response('<rss><channel></channel></rss>', { headers: { 'content-type': 'application/rss+xml' } });
  };
  try {
    const result = await capturePublicTextLinks({
      liveDir, origin,
      targets: ['/feed.rss', '/one.md', '/feed.xml', '/two.md', '/three.md'],
      fetchImpl, maxTargets: 2,
    });
    assert.equal(result.eligible, 5);
    assert.deepEqual(result.eligibleKinds, { document: 3, feed: 2 });
    assert.equal(result.targetBudget, 2);
    assert.equal(result.attempted, 2);
    assert.equal(result.captured, 2);
    assert.equal(result.rejected, 0);
    assert.deepEqual(result.capturedKinds, { document: 2, feed: 0 });
    assert.deepEqual(result.uncapturedKinds, { document: 1, feed: 2 });
    assert.equal(result.limited, true);
    assert.equal(result.limitedReason, 'target-budget');
    assert.deepEqual(requests.map(url => new URL(url).pathname), ['/one.md', '/two.md']);
    assert.equal(existsSync(join(liveDir, 'one.md')), true);
    assert.equal(existsSync(join(liveDir, 'two.md')), true);
    assert.equal(existsSync(join(liveDir, 'feed.rss')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public config documentation is eligible while private paths stay rejected', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-config-text-'));
  const liveDir = join(dir, 'live');
  mkdirSync(liveDir);
  const origin = 'https://site.test';
  const requests = [];
  const fetchImpl = async url => {
    requests.push(url);
    const path = new URL(url).pathname;
    if (path === '/config.md' || path === '/config/build-options.md') {
      return new Response('# Config', { headers: { 'content-type': 'text/markdown' } });
    }
    return new Response('not found', { status: 404 });
  };
  try {
    const result = await capturePublicTextLinks({
      liveDir, origin,
      targets: ['/config.md', '/config/build-options.md', '/private/guide.md', '/tokens.md'],
      fetchImpl,
    });
    assert.equal(result.eligible, 2);
    assert.equal(result.attempted, 2);
    assert.equal(result.captured, 2);
    assert.equal(result.rejected, 0);
    assert.deepEqual(result.uncapturedKinds, { document: 0, feed: 0 });
    assert.equal(readFileSync(join(liveDir, 'config.md'), 'utf8'), '# Config');
    assert.equal(readFileSync(join(liveDir, 'config', 'build-options.md'), 'utf8'), '# Config');
    assert.ok(!requests.some(url => url.includes('/private/') || url.includes('/tokens.md')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('public text capture rejects symlinked parents inside a candidate', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-text-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const liveDir = join(dir, 'live');
  const outside = join(dir, 'outside');
  mkdirSync(liveDir);
  mkdirSync(outside);
  try { symlinkSync(outside, join(liveDir, 'docs'), 'dir'); }
  catch (error) {
    if (error.code === 'EPERM') return t.skip('symlinks require elevated Windows privileges');
    throw error;
  }
  let calls = 0;
  const result = await capturePublicTextLinks({ liveDir, origin: 'https://site.test', targets: ['/docs/guide.md'],
    fetchImpl: async () => { calls++; return new Response('# Guide', { headers: { 'content-type': 'text/markdown' } }); },
  });
  assert.equal(result.rejected, 1);
  assert.equal(calls, 0);
  assert.equal(existsSync(join(outside, 'guide.md')), false);
});

test('strict export captures public text links but still blocks an uncloned HTML page', { timeout: 120_000 }, async t => {
  const source = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://source.test').pathname);
    if (path === '/gone/') {
      response.statusCode = 404;
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><h1>Not Found</h1>');
      return;
    }
    if (path === '/external/') {
      response.statusCode = 302;
      response.setHeader('location', 'https://elsewhere.test/page');
      response.end();
      return;
    }
    const contents = {
      '/blog.rss': ['application/rss+xml', '<rss version="2.0"><channel><title>Blog</title></channel></rss>'],
      '/guide.md': ['text/markdown', '# Guide'],
      '/llms.txt': ['text/plain', '# Public documentation'],
      '/文档.md': ['text/markdown', '# Documentation'],
      '/next/': ['text/html', '<!doctype html><html><h1>Next</h1></html>'],
    };
    const [mime, body] = contents[path] ?? ['text/html', '<!doctype html><h1>Home</h1>'];
    response.setHeader('content-type', mime);
    response.end(body);
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-text-export-'));
  let serve = null;
  t.after(async () => {
    if (serve?.exitCode === null && serve.signalCode === null) {
      const exited = once(serve, 'exit');
      serve.kill();
      await exited;
    }
    if (source.listening) {
      const closed = new Promise(resolve => source.close(resolve));
      source.closeAllConnections?.();
      await closed;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${source.address().port}`;
  const host = 'public-text-fixture.test';
  const site = join(dir, 'workspace', host);
  const out = join(dir, 'deliverable', 'accepted');
  const html = '<!doctype html><html><body><a href="/blog.rss">RSS</a><a href="/guide.md">Markdown</a><a href="/llms.txt">Text</a><a href="/文档.md">Docs</a><a href="/gone/">Gone</a></body></html>';
  put(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: origin + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>Clone</title>');
  put(join(site, 'live', 'index.html'), html);

  const accepted = await runExport(host, out, dir, ['--heal']);
  assert.equal(accepted.status, 0, accepted.output);
  const healthBytes = readFileSync(join(out, 'health.json'));
  const health = JSON.parse(healthBytes);
  assert.equal(health.links.missing, 1);
  assert.equal(health.strictBlockers.missingLinks, 0);
  assert.equal(health.pathAliases.status, 'checked');
  assert.equal(health.pathAliases.targets, 1);
  assert.equal(health.pathAliases.checked, 1);
  assert.equal(health.pathAliases.expectedMissing, 1);
  assert.equal(health.pathAliases.expectedMissingReferences, 1);
  assert.equal(health.pathAliases.unexpected, 0);
  assert.equal(health.pathAliases.failed, 0);
  assert.equal(health.publicTextLinks.captured, 4);
  assert.equal(health.publicTextLinks.targetBudget, 128);
  assert.deepEqual(health.publicTextLinks.eligibleKinds, { document: 3, feed: 1 });
  assert.deepEqual(health.publicTextLinks.capturedKinds, { document: 3, feed: 1 });
  assert.deepEqual(health.publicTextLinks.uncapturedKinds, { document: 0, feed: 0 });
  assert.equal(health.publicTextLinks.limited, false);
  assert.equal(health.strictBlockers.mirrorRootMissing, 0);
  assert.equal(health.runtimeProbe.failed, 0);
  assert.equal(readFileSync(join(out, 'site', 'live', 'guide.md'), 'utf8'), '# Guide');
  serve = spawn(process.execPath, [join(out, 'serve.mjs'), '--port', '0', '--host', '127.0.0.1'], {
    cwd: out, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const ready = await new Promise((resolve, reject) => {
    serve.once('message', resolve);
    serve.once('error', reject);
  });
  const base = `http://127.0.0.1:${ready.port}`;
  for (const [path, mime] of [['/blog.rss', 'application/rss+xml'], ['/guide.md', 'text/markdown'], ['/llms.txt', 'text/plain'], ['/文档.md', 'text/markdown']]) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type')?.split(';')[0], mime);
  }
  assert.equal((await fetch(base + '/lm/' + host + '/gone/')).status, 404);
  assert.match(readFileSync(join(out, 'site', 'live', 'index.html'), 'utf8'), /href="\/lm\/public-text-fixture\.test\/gone\/"/);

  put(join(site, 'live', 'index.html'), html + '<a href="/external/">External</a>');
  const externalRejected = await runExport(host, out, dir, ['--heal']);
  assert.equal(externalRejected.status, 1, externalRejected.output);
  assert.deepEqual(readFileSync(join(out, 'health.json')), healthBytes,
    'unsupported external redirects must not replace the accepted bundle');
  const externalCandidate = readdirSync(join(dir, 'deliverable'))
    .filter(name => name.startsWith('.candidate-'))
    .map(name => join(dir, 'deliverable', name))
    .filter(path => existsSync(join(path, 'health.json')))
    .reduce((latest, path) => !latest || statSync(path).mtimeMs > statSync(latest).mtimeMs ? path : latest, null);
  const externalHealth = JSON.parse(readFileSync(join(externalCandidate, 'health.json'), 'utf8'));
  assert.equal(externalHealth.pathAliases.unsupportedExternalRedirects, 1);
  assert.equal(externalHealth.pathAliases.unsupportedExternalRedirectReferences, 1);
  assert.equal(externalHealth.pathAliases.details.find(item => item.path === '/external/').disposition,
    'unsupported-external-redirect');
  assert.equal(externalHealth.strictBlockers.unsupportedExternalRedirects, 1);
  assert.equal(externalHealth.strictBlockers.unsupportedExternalRedirectReferences, 1);
  assert.equal(externalHealth.strictBlockers.missingLinks, 0,
    'an explicitly unsupported external redirect is not an unexpected missing link');
  assert.match(readFileSync(join(externalCandidate, 'site', 'live', 'index.html'), 'utf8'),
    /href="\/lm\/public-text-fixture\.test\/external\/"/);

  const acceptedExternal = await runExport(host, join(dir, 'deliverable', 'accepted-external'), dir,
    ['--heal', '--allow-unsupported-external-redirects']);
  assert.equal(acceptedExternal.status, 0, acceptedExternal.output);
  const acceptedExternalHealth = JSON.parse(readFileSync(join(dir, 'deliverable', 'accepted-external', 'health.json'), 'utf8'));
  assert.equal(acceptedExternalHealth.pathAliases.unsupportedExternalRedirects, 1);
  assert.equal(acceptedExternalHealth.externalRedirectPolicy.policy, 'allow-unsupported');
  assert.equal(acceptedExternalHealth.externalRedirectPolicy.accepted, 1);
  assert.equal(acceptedExternalHealth.strictBlockers.unsupportedExternalRedirects, 0);
  assert.equal(JSON.parse(readFileSync(join(dir, 'deliverable', 'accepted-external', 'heimdall-live.json'), 'utf8')).externalRedirectPolicy,
    'allow-unsupported');

  put(join(site, 'live', 'index.html'), html + '<a href="/next/">Next</a>');
  const rejected = await runExport(host, out, dir, ['--heal']);
  assert.equal(rejected.status, 1, rejected.output);
  assert.deepEqual(readFileSync(join(out, 'health.json')), healthBytes);
  const candidates = readdirSync(join(dir, 'deliverable')).filter(name => name.startsWith('.candidate-'));
  assert.ok(candidates.length);
  const latestPath = candidates
    .map(name => join(dir, 'deliverable', name))
    .reduce((latest, path) => !latest || statSync(path).mtimeMs > statSync(latest).mtimeMs ? path : latest, null);
  const latest = JSON.parse(readFileSync(join(latestPath, 'health.json'), 'utf8'));
  assert.ok(latest.strictBlockers.missingLinks > 0);
  assert.equal(latest.publicTextLinks.captured, 4);
  assert.equal(existsSync(join(latestPath, 'site', 'live', 'next', 'index.html')), false);
});

test('strict mirror export requires an actual root snapshot', { timeout: 60_000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-root-export-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = 'root-fixture.test';
  const site = join(dir, 'workspace', host);
  const out = join(dir, 'deliverable', 'accepted');
  put(join(site, 'site-origin.json'), JSON.stringify({ origin: 'https://root-fixture.test' }));
  put(join(site, 'pages', 'guide', 'manifest.json'), JSON.stringify({ target: 'https://root-fixture.test/guide/' }));
  put(join(site, 'pages', 'guide', 'clone', 'index.html'), '<!doctype html><title>Clone</title>');
  put(join(site, 'live', 'guide', 'index.html'), '<!doctype html><title>Guide</title>');
  const result = await runExport(host, out, dir);
  assert.equal(result.status, 1, result.output);
  const candidate = readdirSync(join(dir, 'deliverable')).find(name => name.startsWith('.candidate-'));
  const health = JSON.parse(readFileSync(join(dir, 'deliverable', candidate, 'health.json'), 'utf8'));
  assert.equal(health.strictBlockers.mirrorRootMissing, 1);
  assert.equal(health.links.missing, 0);

  put(join(site, 'live', 'index.html'), '<!doctype html><title>Stale root snapshot</title>');
  const before = new Set(readdirSync(join(dir, 'deliverable')));
  const stale = await runExport(host, out, dir);
  assert.equal(stale.status, 1, stale.output);
  const newCandidate = readdirSync(join(dir, 'deliverable'))
    .find(name => name.startsWith('.candidate-') && !before.has(name));
  assert.ok(newCandidate);
  const staleHealth = JSON.parse(readFileSync(join(dir, 'deliverable', newCandidate, 'health.json'), 'utf8'));
  assert.equal(staleHealth.strictBlockers.mirrorRootMissing, 1);
});
