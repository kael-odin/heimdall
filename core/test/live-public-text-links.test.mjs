import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const html = '<!doctype html><html><body><a href="/blog.rss">RSS</a><a href="/guide.md">Markdown</a><a href="/llms.txt">Text</a><a href="/文档.md">Docs</a></body></html>';
  put(join(site, 'site-origin.json'), JSON.stringify({ origin }));
  put(join(site, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: origin + '/' }));
  put(join(site, 'pages', 'home', 'clone', 'index.html'), '<!doctype html><title>Clone</title>');
  put(join(site, 'live', 'index.html'), html);

  const accepted = await runExport(host, out, dir, ['--heal']);
  assert.equal(accepted.status, 0, accepted.output);
  const healthBytes = readFileSync(join(out, 'health.json'));
  const health = JSON.parse(healthBytes);
  assert.equal(health.links.missing, 0);
  assert.equal(health.publicTextLinks.captured, 4);
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

  put(join(site, 'live', 'index.html'), html + '<a href="/next/">Next</a>');
  const rejected = await runExport(host, out, dir, ['--heal']);
  assert.equal(rejected.status, 1, rejected.output);
  assert.deepEqual(readFileSync(join(out, 'health.json')), healthBytes);
  const candidates = readdirSync(join(dir, 'deliverable')).filter(name => name.startsWith('.candidate-'));
  assert.ok(candidates.length);
  const latest = JSON.parse(readFileSync(join(dir, 'deliverable', candidates.at(-1), 'health.json'), 'utf8'));
  assert.ok(latest.strictBlockers.missingLinks > 0);
  assert.equal(latest.publicTextLinks.captured, 4);
  assert.equal(existsSync(join(dir, 'deliverable', candidates.at(-1), 'site', 'live', 'next', 'index.html')), false);
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
