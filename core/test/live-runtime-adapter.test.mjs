import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = fileURLToPath(new URL('../src/live/', import.meta.url));
const ADAPTER_CODE = `
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function handle(request, { dataDir }) {
  const file = join(dataDir, 'items.json');
  let items;
  try { items = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; items = []; }
  if (request.method === 'POST') {
    items.push(JSON.parse(await request.text()));
    await writeFile(file, JSON.stringify(items));
    return Response.json({ count: items.length }, { status: 201 });
  }
  return Response.json(items);
}
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-runtime-adapter-'));
  const bundle = join(root, 'bundle');
  const state = join(root, 'state');
  mkdirSync(join(bundle, 'runtime-adapter'), { recursive: true });
  mkdirSync(join(bundle, 'site', 'live', 'api'), { recursive: true });
  mkdirSync(state);
  for (const name of ['serve.mjs', 'har.mjs', 'live-path.mjs', 'clone-asset-cors.mjs', 'adapter-runtime.mjs']) {
    copyFileSync(join(SOURCE, name), join(bundle, name));
  }
  writeFileSync(join(bundle, 'heimdall-live.json'), JSON.stringify({
    host: 'fixture.test', origin: 'https://source.invalid', port: 0,
    bind: '127.0.0.1', root: 'mirror', offline: true, adapter: true,
  }));
  writeFileSync(join(bundle, 'har.json'), JSON.stringify({ entries: [{
    method: 'GET', url: 'https://source.invalid/api/items?view=all', status: 200,
    mimeType: 'application/json', headers: {},
    body: Buffer.from('["HAR must not shadow adapter"]').toString('base64'), bodyEncoding: 'base64',
  }] }));
  writeFileSync(join(bundle, 'site', 'live', 'api', 'items'), 'snapshot must not shadow adapter');
  writeFileSync(join(bundle, 'runtime-adapter', 'manifest.json'), JSON.stringify({
    version: 1, routes: [
      { method: 'GET', path: '/api/items' },
      { method: 'POST', path: '/api/items' },
    ],
  }));
  writeFileSync(join(bundle, 'runtime-adapter', 'index.mjs'), ADAPTER_CODE);
  return { root, bundle, state };
}

function launch(bundle, state) {
  const child = spawn(process.execPath, [join(bundle, 'serve.mjs')], {
    cwd: bundle,
    env: { ...process.env, HEIMDALL_RUNTIME_DATA_DIR: state },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
  const outcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('adapter startup timed out')), 5_000);
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      resolve({ base: `http://127.0.0.1:${message.port}`, child });
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`adapter server exited (${code}): ${stderr}`));
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, outcome };
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await new Promise(resolve => child.once('exit', resolve));
}

function streamingPost(base, body) {
  const outgoing = httpRequest(base + '/api/items', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' },
  });
  const response = new Promise((resolve, reject) => {
    outgoing.once('error', reject);
    outgoing.once('response', incoming => {
      incoming.resume();
      incoming.once('end', () => resolve(incoming.statusCode));
      incoming.once('error', reject);
    });
  });
  outgoing.write(body);
  return { outgoing, response };
}

test('offline adapter owns exact routes and persists writes after restart', { timeout: 30_000 }, async () => {
  const f = fixture();
  let child;
  try {
    let running = launch(f.bundle, f.state);
    child = running.child;
    let { base } = await running.outcome;
    const initial = await fetch(base + '/api/items');
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), [], 'adapter GET must precede the local snapshot');
    const write = await fetch(base + '/lm/fixture.test/api/items', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'saved' }),
    });
    assert.equal(write.status, 201);
    assert.deepEqual(await write.json(), { count: 1 });
    assert.equal((await fetch(base + '/api/items', { method: 'PUT' })).status, 404);
    assert.equal((await fetch(base + '/api/unknown', { method: 'POST' })).status, 404);
    await stop(child);
    running = launch(f.bundle, f.state);
    child = running.child;
    ({ base } = await running.outcome);
    const persisted = await fetch(base + '/api/items?view=all');
    assert.equal(persisted.status, 200);
    assert.deepEqual(await persisted.json(), [{ name: 'saved' }]);
  } finally {
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('enabled adapter fails closed when its manifest or module is missing or invalid', { timeout: 30_000 }, async () => {
  const f = fixture();
  try {
    for (const [name, change] of [
      ['missing module', () => rmSync(join(f.bundle, 'runtime-adapter', 'index.mjs'))],
      ['invalid module', () => writeFileSync(join(f.bundle, 'runtime-adapter', 'index.mjs'), 'export const handle = null;')],
      ['invalid manifest', () => writeFileSync(join(f.bundle, 'runtime-adapter', 'manifest.json'), JSON.stringify({
        version: 1, routes: [{ method: 'POST', path: '/api/../outside' }],
      }))],
    ]) {
      change();
      const running = launch(f.bundle, f.state);
      try {
        await assert.rejects(running.outcome, /adapter server exited/, name);
      } finally { await stop(running.child); }
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('adapter refuses runtime state inside the exported bundle', { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const bundledState = join(f.bundle, 'state');
    mkdirSync(bundledState);
    const running = launch(f.bundle, bundledState);
    try { await assert.rejects(running.outcome, /adapter server exited/); }
    finally { await stop(running.child); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('adapter files cannot silently fall back to default online configuration', { timeout: 10_000 }, async () => {
  const f = fixture();
  try {
    const config = join(f.bundle, 'heimdall-live.json');
    for (const value of ['{invalid json', JSON.stringify({ adapter: false, offline: false })]) {
      writeFileSync(config, value);
      const running = launch(f.bundle, f.state);
      try { await assert.rejects(running.outcome, /adapter server exited/); }
      finally { await stop(running.child); }
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('adapter failure returns a local error without falling through to HAR', { timeout: 10_000 }, async () => {
  const f = fixture();
  let child;
  try {
    writeFileSync(join(f.bundle, 'runtime-adapter', 'index.mjs'),
      'export async function handle() { throw new Error("private adapter detail"); }');
    const running = launch(f.bundle, f.state);
    child = running.child;
    const { base } = await running.outcome;
    const response = await fetch(base + '/api/items?view=all');
    assert.equal(response.status, 500);
    assert.equal(await response.text(), 'adapter failed');
  } finally {
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('oversized chunked request returns 413 before the sender ends its body', { timeout: 15_000 }, async () => {
  const f = fixture();
  let child;
  let outgoing;
  try {
    const running = launch(f.bundle, f.state);
    child = running.child;
    const { base } = await running.outcome;
    const start = Date.now();
    const pending = streamingPost(base, Buffer.alloc(4 * 1024 * 1024 + 1, 0x20));
    outgoing = pending.outgoing;
    assert.equal(await pending.response, 413);
    assert.ok(Date.now() - start < 5_000, 'oversized streaming body must fail promptly');
    assert.equal((await fetch(base + '/__heimdall/health')).status, 200);
  } finally {
    outgoing?.destroy();
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('incomplete chunked request times out instead of occupying a connection forever', { timeout: 20_000 }, async () => {
  const f = fixture();
  let child;
  let outgoing;
  try {
    const running = launch(f.bundle, f.state);
    child = running.child;
    const { base } = await running.outcome;
    const pending = streamingPost(base, '{"name":');
    outgoing = pending.outgoing;
    assert.equal(await pending.response, 408);
    assert.equal((await fetch(base + '/__heimdall/health')).status, 200);
  } finally {
    outgoing?.destroy();
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('aborted request body does not crash the adapter server', { timeout: 10_000 }, async () => {
  const f = fixture();
  let child;
  let outgoing;
  try {
    const running = launch(f.bundle, f.state);
    child = running.child;
    const { base } = await running.outcome;
    const pending = streamingPost(base, '{"name":');
    outgoing = pending.outgoing;
    outgoing.destroy();
    await assert.rejects(pending.response);
    assert.equal((await fetch(base + '/__heimdall/health')).status, 200);
  } finally {
    outgoing?.destroy();
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adapter handler that never resolves returns 504 within its deadline', { timeout: 25_000 }, async () => {
  const f = fixture();
  let child;
  try {
    writeFileSync(join(f.bundle, 'runtime-adapter', 'index.mjs'),
      'export async function handle() { await new Promise(() => {}); }');
    const running = launch(f.bundle, f.state);
    child = running.child;
    const { base } = await running.outcome;
    const response = await fetch(base + '/api/items');
    assert.equal(response.status, 504);
    assert.equal(await response.text(), 'adapter timed out');
    assert.equal((await fetch(base + '/__heimdall/health')).status, 200);
  } finally {
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('adapter response stream that never ends is aborted within the same deadline', { timeout: 25_000 }, async () => {
  const f = fixture();
  let child;
  try {
    writeFileSync(join(f.bundle, 'runtime-adapter', 'index.mjs'), `
      export async function handle() {
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
        }));
      }
    `);
    const running = launch(f.bundle, f.state);
    child = running.child;
    const { base } = await running.outcome;
    const response = await fetch(base + '/api/items');
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), /terminated|aborted|socket/i);
    assert.equal((await fetch(base + '/__heimdall/health')).status, 200);
  } finally {
    await stop(child);
    rmSync(f.root, { recursive: true, force: true });
  }
});
