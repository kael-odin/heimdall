import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

function runQueue(dataDir, api, args = ['--max', '4']) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/queue.mjs', import.meta.url)), 'x.test', ...args, '--no-dedupe'], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_API: api, HEIMDALL_QUEUE_WORKERS: '2' },
    });
    let output = '';
    child.stdout.on('data', x => { output += x; });
    child.stderr.on('data', x => { output += x; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('queue hung: ' + output)); }, 20_000);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

test('queue keeps colliding URLs and reports failed pages with nonzero exit', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-queue-'));
  const base = join(dataDir, 'workspace', 'x.test');
  mkdirSync(join(base, 'recon'), { recursive: true });
  writeFileSync(join(base, 'recon', 'atlas.json'), JSON.stringify({ nodes: [
    { url: 'https://x.test/a/b', type: 'generic' },
    { url: 'https://x.test/a-b', type: 'generic' },
    { url: 'https://x.test/list?page=1', type: 'generic' },
    { url: 'https://x.test/list?page=2', type: 'generic' },
  ] }));
  let seq = 0;
  const server = createServer((req, res) => {
    if (req.url === '/api/forge') {
      req.resume();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ taskId: 'f' + ++seq }));
    } else if (req.url.startsWith('/api/events')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ kind: 'exit', status: 'failed', code: 17, error: 'fixture failure' }) + '\n\n');
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { code, output } = await runQueue(dataDir, `http://127.0.0.1:${server.address().port}`);
    assert.equal(code, 1, output);
    const queue = JSON.parse(readFileSync(join(base, 'queue.json'), 'utf8'));
    assert.equal(queue.length, 4);
    assert.equal(new Set(queue.map(q => q.name)).size, 4);
    assert.deepEqual(queue.map(q => q.status), ['failed', 'failed', 'failed', 'failed']);
    assert.ok(queue.every(q => q.error === 'fixture failure'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('all-discovered includes auth, legal and every same-origin atlas URL beyond the default cap', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-queue-all-'));
  const base = join(dataDir, 'workspace', 'x.test');
  mkdirSync(join(base, 'recon'), { recursive: true });
  const nodes = [
    ...Array.from({ length: 22 }, (_, index) => ({ url: `https://x.test/page-${index + 1}`, type: 'generic' })),
    { url: 'https://x.test/login', type: 'auth' },
    { url: 'https://x.test/terms', type: 'legal' },
    { url: 'https://other.test/foreign', type: 'generic' },
    { url: 'not-a-url', type: 'generic' },
    null,
  ];
  writeFileSync(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://x.test', nodes }));
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"fixture rejection"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    const full = await runQueue(dataDir, api, ['--all-discovered']);
    assert.equal(full.code, 1, full.output);
    const queue = JSON.parse(readFileSync(join(base, 'queue.json'), 'utf8'));
    assert.equal(queue.length, 24);
    for (const path of ['/page-21', '/page-22', '/login', '/terms']) {
      assert.ok(queue.some(row => row.url === 'https://x.test' + path), path);
    }
    assert.ok(queue.every(row => new URL(row.url).origin === 'https://x.test'));
    assert.match(full.output, /24 valid same-origin URLs \/ 27 atlas nodes/);
    assert.match(full.output, /to forge: 24/);
    const beforeConflict = readFileSync(join(base, 'queue.json'), 'utf8');
    const conflict = await runQueue(dataDir, api, ['--all-discovered', '--max', '2']);
    assert.equal(conflict.code, 2, conflict.output);
    assert.match(conflict.output, /--all-discovered 与 --max 不能同时使用/);
    assert.equal(readFileSync(join(base, 'queue.json'), 'utf8'), beforeConflict);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('all-discovered fills an existing default queue without dropping prior rows', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-queue-resume-all-'));
  const base = join(dataDir, 'workspace', 'x.test');
  mkdirSync(join(base, 'recon'), { recursive: true });
  const nodes = [
    ...Array.from({ length: 22 }, (_, index) => ({ url: `https://x.test/page-${index + 1}`, type: 'generic' })),
    { url: 'https://x.test/login', type: 'auth' },
    { url: 'https://x.test/terms', type: 'legal' },
  ];
  writeFileSync(join(base, 'recon', 'atlas.json'), JSON.stringify({ origin: 'https://x.test', nodes }));
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":"fixture rejection"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const api = `http://127.0.0.1:${server.address().port}`;
    const normal = await runQueue(dataDir, api, []);
    assert.equal(normal.code, 1, normal.output);
    const path = join(base, 'queue.json');
    const first = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(first.length, 20);
    assert.ok(first.every(row => !['auth', 'legal'].includes(row.type)));
    for (const row of first) row.attempts = 2;
    writeFileSync(path, JSON.stringify(first));

    const full = await runQueue(dataDir, api, ['--all-discovered']);
    assert.equal(full.code, 1, full.output);
    const resumed = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(resumed.length, 24);
    assert.ok(first.every(row => resumed.some(next => next.url === row.url && next.attempts === 2)));
    assert.ok(resumed.some(row => row.type === 'auth'));
    assert.ok(resumed.some(row => row.type === 'legal'));
    assert.match(full.output, /4 added; 24 queue rows/);
    assert.match(full.output, /to forge: 4/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('queue rejects a done event when the page product is missing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-queue-product-'));
  const base = join(dataDir, 'workspace', 'x.test');
  mkdirSync(join(base, 'recon'), { recursive: true });
  writeFileSync(join(base, 'recon', 'atlas.json'), JSON.stringify({ nodes: [{ url: 'https://x.test/page', type: 'generic' }] }));
  const server = createServer((req, res) => {
    if (req.url === '/api/forge') { req.resume(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ taskId: 'f1' })); }
    else if (req.url.startsWith('/api/events')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end('data: {"kind":"exit","status":"done","code":0}\n\n'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { code, output } = await runQueue(dataDir, `http://127.0.0.1:${server.address().port}`);
    assert.equal(code, 1, output);
    const queue = JSON.parse(readFileSync(join(base, 'queue.json'), 'utf8'));
    assert.equal(queue[0].status, 'failed');
    assert.match(queue[0].error, /产物或评分文件缺失/);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
