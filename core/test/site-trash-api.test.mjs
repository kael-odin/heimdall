import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const ENGINE = fileURLToPath(new URL('../src/engine-server.mjs', import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function startEngine(dataRoot, port, extraEnv = {}) {
  const child = spawn(process.execPath, [ENGINE, String(port)], {
    cwd: CORE,
    env: { ...globalThis.process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_TOKEN: 'test-token', HEIMDALL_TRASH_WARN_BYTES: '1', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const result = await fetch(base + '/api/status', { headers: { 'x-heimdall-token': 'test-token' } });
      if (result.ok) return { child, base };
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error('engine did not start: ' + logs.slice(-500));
}

async function waitFor(check, label, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for ' + label);
}

test('delete, list and restore site/page over protected engine API', { timeout: 30_000 }, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-site-trash-api-'));
  const host = 'fixture.test';
  const site = join(dataRoot, 'workspace', host);
  const page = join(site, 'pages', 'home');
  const atlasPath = join(site, 'recon', 'atlas.json');
  mkdirSync(page, { recursive: true });
  mkdirSync(join(site, 'recon'));
  writeFileSync(join(page, 'manifest.json'), JSON.stringify({ target: `https://${host}/` }));
  writeFileSync(join(page, 'clone.html'), 'original page');
  const atlas = JSON.stringify({ nodes: [{ id: 'home', url: `https://${host}/` }], edges: [] });
  writeFileSync(atlasPath, atlas);
  const port = await freePort();
  let engine;
  try {
    engine = await startEngine(dataRoot, port);
    const { base } = engine;
    const headers = { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' };
    const json = async (path, init = {}) => {
      const response = await fetch(base + path, { ...init, headers: { ...headers, ...init.headers } });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await fetch(base + '/api/trash')).status, 401);

    const pageDeleted = await json(`/api/sites/${host}/pages/home`, { method: 'DELETE' });
    assert.equal(pageDeleted.status, 200);
    assert.equal(pageDeleted.body.removedArtifacts, true);
    assert.equal(pageDeleted.body.removedNode, true);
    assert.equal(existsSync(page), false);
    assert.equal(JSON.parse(readFileSync(atlasPath, 'utf8')).nodes.length, 0);
    const pageId = pageDeleted.body.trashId;
    assert.ok(pageId);
    const listed = await json('/api/trash');
    assert.equal(listed.status, 200);
    assert.equal(listed.body.entries.find(entry => entry.id === pageId)?.state, 'ready');
    assert.equal(listed.body.summary.warningBytes, 1);
    const pagePreview = await json(`/api/trash/${pageId}/preview`);
    assert.equal(pagePreview.status, 200);
    assert.equal(pagePreview.body.purgeable, false);
    assert.equal(pagePreview.body.payloadPresent, true);
    assert.equal((await json(`/api/trash/${pageId}`, {
      method: 'DELETE', body: JSON.stringify({ confirmId: pageId, revision: pagePreview.body.revision }),
    })).status, 409);
    assert.equal(existsSync(join(dataRoot, 'trash', pageId, 'page', 'clone.html')), true);
    const blocked = await json(`/api/trash/${pageId}/restore`, {
      method: 'POST', body: '{}', headers: { origin: 'null' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(existsSync(page), false);
    const pageRestored = await json(`/api/trash/${pageId}/restore`, {
      method: 'POST', body: '{}', headers: { origin: 'http://localhost:5173' },
    });
    assert.equal(pageRestored.status, 200);
    assert.equal(pageRestored.body.restored, true);
    assert.equal(readFileSync(join(page, 'clone.html'), 'utf8'), 'original page');
    assert.equal(readFileSync(atlasPath, 'utf8'), atlas);

    assert.equal((await json(`/api/sites/${host}`, { method: 'DELETE', body: '{}' })).status, 400);
    const siteDeleted = await json(`/api/sites/${host}`, {
      method: 'DELETE', body: JSON.stringify({ confirmHost: host }),
    });
    assert.equal(siteDeleted.status, 200);
    assert.equal(siteDeleted.body.removed, 'site');
    assert.equal(existsSync(site), false);
    assert.equal((await json('/api/sites')).body.sites.some(row => row.host === host), false);
    const siteRestored = await json(`/api/trash/${siteDeleted.body.trashId}/restore`, {
      method: 'POST', body: '{}',
    });
    assert.equal(siteRestored.status, 200);
    assert.equal(readFileSync(join(page, 'clone.html'), 'utf8'), 'original page');
    assert.equal((await json('/api/sites')).body.sites.some(row => row.host === host), true);
    assert.equal((await json('/api/trash')).body.entries.find(entry => entry.id === siteDeleted.body.trashId)?.state, 'restored');
    const siteId = siteDeleted.body.trashId;
    const terminal = await json(`/api/trash/${siteId}/preview`);
    assert.equal(terminal.status, 200);
    assert.equal(terminal.body.purgeable, true);
    assert.equal((await json(`/api/trash/${siteId}`, {
      method: 'DELETE', body: JSON.stringify({ confirmId: 'wrong', revision: terminal.body.revision }),
    })).status, 400);
    assert.equal((await json(`/api/trash/${siteId}`, {
      method: 'DELETE', body: JSON.stringify({ confirmId: siteId, revision: terminal.body.revision }),
      headers: { origin: 'null' },
    })).status, 403);
    const purged = await json(`/api/trash/${siteId}`, {
      method: 'DELETE', body: JSON.stringify({ confirmId: siteId, revision: terminal.body.revision }),
    });
    assert.equal(purged.status, 200);
    assert.equal(existsSync(join(dataRoot, 'trash', siteId)), false);
    assert.equal(readFileSync(join(page, 'clone.html'), 'utf8'), 'original page');
    assert.equal(JSON.parse(readFileSync(join(dataRoot, 'trash', '.purge-receipts', `${siteId}.json`), 'utf8')).state, 'complete');
  } finally {
    if (engine?.child.exitCode === null && engine.child.signalCode === null) {
      engine.child.kill();
      await new Promise(resolve => engine.child.once('exit', resolve));
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
});

test('protected API backs up, purges, and rebuilds a recoverable trash entry', { timeout: 30_000 }, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-api-data-'));
  const backupRoot = mkdtempSync(join(tmpdir(), 'heimdall-trash-api-backup-'));
  const host = 'backup.test';
  const site = join(dataRoot, 'workspace', host);
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'evidence.txt'), 'original evidence');
  const port = await freePort();
  let engine;
  try {
    engine = await startEngine(dataRoot, port, { HEIMDALL_TRASH_BACKUP_DIR: backupRoot });
    const headers = { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' };
    const json = async (route, init = {}) => {
      const response = await fetch(engine.base + route, {
        ...init, headers: { ...headers, ...init.headers },
      });
      return { status: response.status, body: await response.json() };
    };
    const deleted = await json(`/api/sites/${host}`, {
      method: 'DELETE', body: JSON.stringify({ confirmHost: host }),
    });
    assert.equal(deleted.status, 200);
    const id = deleted.body.trashId;
    const preview = await json(`/api/trash/${id}/preview`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.backup.configured, true);
    assert.equal(preview.body.purgeable, false);
    assert.equal((await json(`/api/trash/${id}/backup`, {
      method: 'POST', body: JSON.stringify({ revision: preview.body.revision }),
      headers: { origin: 'null' },
    })).status, 403);
    const copied = await json(`/api/trash/${id}/backup`, {
      method: 'POST', body: JSON.stringify({ revision: preview.body.revision }),
    });
    assert.equal(copied.status, 200, JSON.stringify(copied.body));
    assert.equal(copied.body.verified, true);
    const purgePreview = await json(`/api/trash/${id}/preview`);
    assert.equal(purgePreview.body.purgeable, true);
    assert.equal(purgePreview.body.backup.verified, true);
    assert.equal((await json(`/api/trash/${id}`, {
      method: 'DELETE', body: JSON.stringify({ confirmId: id, revision: purgePreview.body.revision }),
    })).status, copied.body.sameFilesystem ? 409 : 200);
    if (copied.body.sameFilesystem) {
      const purged = await json(`/api/trash/${id}`, {
        method: 'DELETE', body: JSON.stringify({ confirmId: id,
          revision: purgePreview.body.revision, acceptSameFilesystem: true }),
      });
      assert.equal(purged.status, 200, JSON.stringify(purged.body));
    }
    assert.equal(existsSync(join(dataRoot, 'trash', id)), false);
    const list = await json('/api/trash');
    assert.equal(list.status, 200);
    assert.equal(list.body.purged.find(row => row.id === id)?.backup.available, true);
    assert.equal((await json(`/api/trash/${id}/recover-backup`, {
      method: 'POST', body: JSON.stringify({ confirmId: id, revision: purgePreview.body.revision }),
      headers: { origin: 'null' },
    })).status, 403);
    const recovered = await json(`/api/trash/${id}/recover-backup`, {
      method: 'POST', body: JSON.stringify({ confirmId: id, revision: purgePreview.body.revision }),
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.restoredToTrash, true);
    const restored = await json(`/api/trash/${id}/restore`, { method: 'POST', body: '{}' });
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(readFileSync(join(site, 'evidence.txt'), 'utf8'), 'original evidence');
  } finally {
    if (engine?.child.exitCode === null && engine.child.signalCode === null) {
      engine.child.kill();
      await new Promise(resolve => engine.child.once('exit', resolve));
    }
    rmSync(dataRoot, { recursive: true, force: true });
    rmSync(backupRoot, { recursive: true, force: true });
  }
});

test('storage rescans after site deletion and restore during active scans', { timeout: 60_000 }, async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-storage-race-'));
  const host = 'race.test';
  const site = join(dataRoot, 'workspace', host);
  const marker = join(dataRoot, 'storage-scan-blocked');
  const release = join(dataRoot, 'storage-scan-release');
  const gate = join(dataRoot, 'storage-scan-gate');
  const counter = join(dataRoot, 'storage-scan-count');
  const preload = join(dataRoot, 'storage-write-gate.cjs');
  mkdirSync(site, { recursive: true });
  writeFileSync(join(site, 'payload.bin'), Buffer.alloc(4096, 7));
  writeFileSync(gate, 'on');
  writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const original = fs.writeFileSync;',
    'fs.writeFileSync = function (file, ...args) {',
    "  if (process.argv[1]?.replaceAll('\\\\', '/').endsWith('/audit/storage.mjs')",
    "      && path.resolve(file) === path.join(process.env.HEIMDALL_DATA_DIR, 'storage.json')) {",
    "    const countFile = path.join(process.env.HEIMDALL_DATA_DIR, 'storage-scan-count');",
    "    const count = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : 0) + 1;",
    '    original(countFile, String(count));',
    "    if (fs.existsSync(path.join(process.env.HEIMDALL_DATA_DIR, 'storage-scan-gate'))",
    "        && !fs.existsSync(path.join(process.env.HEIMDALL_DATA_DIR, 'storage-scan-blocked'))) {",
    "      original(path.join(process.env.HEIMDALL_DATA_DIR, 'storage-scan-blocked'), 'ready');",
    "      while (!fs.existsSync(path.join(process.env.HEIMDALL_DATA_DIR, 'storage-scan-release'))) {",
    '        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);',
    '      }',
    '    }',
    '  }',
    '  return original(file, ...args);',
    '};',
  ].join('\n'));
  const port = await freePort();
  let engine;
  try {
    engine = await startEngine(dataRoot, port, { NODE_OPTIONS: '--require=' + preload });
    const headers = { 'x-heimdall-token': 'test-token', 'content-type': 'application/json' };
    const json = async (path, init = {}) => {
      const response = await fetch(engine.base + path, { ...init, headers: { ...headers, ...init.headers } });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await json('/api/storage/scan', { method: 'POST' })).status, 202);
    await waitFor(() => existsSync(marker), 'first storage snapshot to block');
    const deleted = await json('/api/sites/' + host, {
      method: 'DELETE', body: JSON.stringify({ confirmHost: host }),
    });
    assert.equal(deleted.status, 200);
    assert.equal(existsSync(site), false);
    writeFileSync(release, 'go');
    const afterDelete = await waitFor(async () => {
      const storage = (await json('/api/storage')).body;
      const trash = (await json('/api/trash')).body;
      return Number(readFileSync(counter, 'utf8')) >= 2
        && !storage.stale && !storage.scanning
        && storage.sites.every(row => row.host !== host)
        && trash.summary.uniqueBytes > 0 && !trash.summary.stale && !trash.summary.scanning
        ? { storage, trash } : null;
    }, 'fresh storage and trash after deletion');
    assert.equal(afterDelete.storage.trash.uniqueBytes, afterDelete.trash.summary.uniqueBytes);
    assert.equal(afterDelete.trash.entries.find(row => row.id === deleted.body.trashId)?.state, 'ready');

    const beforeRestoreScans = Number(readFileSync(counter, 'utf8'));
    rmSync(marker);
    rmSync(release);
    assert.equal((await json('/api/storage/scan', { method: 'POST' })).status, 202);
    await waitFor(() => existsSync(marker), 'pre-restore storage snapshot to block');
    const restored = await json('/api/trash/' + deleted.body.trashId + '/restore', { method: 'POST', body: '{}' });
    assert.equal(restored.status, 200);
    writeFileSync(release, 'go');
    const afterRestore = await waitFor(async () => {
      const storage = (await json('/api/storage')).body;
      const trash = (await json('/api/trash')).body;
      return Number(readFileSync(counter, 'utf8')) >= beforeRestoreScans + 2
        && !storage.stale && !storage.scanning
        && storage.sites.some(row => row.host === host)
        && trash.summary.uniqueBytes >= 0 && !trash.summary.stale && !trash.summary.scanning
        ? { storage, trash } : null;
    }, 'fresh storage and trash after restore');
    assert.equal(afterRestore.trash.entries.find(row => row.id === deleted.body.trashId)?.state, 'restored');
    assert.equal(afterRestore.storage.trash.uniqueBytes, afterRestore.trash.summary.uniqueBytes);
    assert.ok(afterRestore.trash.summary.logicalBytes < afterDelete.trash.summary.logicalBytes);
    assert.equal(existsSync(site), true);
  } finally {
    writeFileSync(release, 'go');
    if (engine?.child.exitCode === null && engine.child.signalCode === null) {
      engine.child.kill();
      await new Promise(resolve => engine.child.once('exit', resolve));
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      try { rmSync(dataRoot, { recursive: true, force: true }); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  }
});
