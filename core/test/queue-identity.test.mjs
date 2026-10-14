import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

function runQueue(dataDir, api) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/queue.mjs', import.meta.url)), 'x.test', '--max', '4', '--no-dedupe'], {
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
