import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE, ACCEPTANCE_RECOVERY_FILE } from '../src/acceptance/owner.mjs';

const OWNER_URL = new URL('../src/acceptance/owner.mjs', import.meta.url).href;
const unavailable = { code: 'ACCEPTANCE_OWNER_UNAVAILABLE', status: 503 };
const lost = { code: 'ACCEPTANCE_OWNER_LOST', status: 503 };

function fixture(t) {
  const temporaryRoot = fs.realpathSync(tmpdir());
  const parent = fs.realpathSync(fs.mkdtempSync(join(temporaryRoot, 'heimdall-owner-root-')));
  const root = join(parent, 'acceptance');
  fs.mkdirSync(root);
  t.after(() => {
    const part = relative(temporaryRoot, resolve(parent));
    assert.ok(part && !part.startsWith('..') && !isAbsolute(part));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return { parent, root };
}

function replaceRoot(item, { moveLock = true } = {}) {
  const moved = join(item.parent, 'acquired-root');
  const original = fs.lstatSync(item.root, { bigint: true });
  const bytes = fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE));
  fs.renameSync(item.root, moved);
  fs.mkdirSync(item.root);
  const replacement = fs.lstatSync(item.root, { bigint: true });
  assert.notEqual(original.ino, replacement.ino);
  if (moveLock) fs.renameSync(join(moved, ACCEPTANCE_OWNER_FILE), join(item.root, ACCEPTANCE_OWNER_FILE));
  else fs.writeFileSync(join(item.root, ACCEPTANCE_OWNER_FILE), 'replacement-root-private-lock');
  fs.writeFileSync(join(item.root, 'scene.txt'), 'replacement root must remain untouched');
  return { moved, bytes };
}

test('owner acquisition identity survives ordinary directory and content updates', t => {
  const item = fixture(t), owner = acquireAcceptanceOwner({ root: item.root });
  t.after(() => owner.release());
  const lock = fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE));
  fs.mkdirSync(join(item.root, 'new-run'));
  fs.writeFileSync(join(item.root, 'new-run', 'report.json'), '{"status":"running"}\n');
  fs.writeFileSync(join(item.root, 'new-run', 'report.json'), '{"status":"completed"}\n');
  fs.writeFileSync(join(item.root, 'ordinary.json'), '{}\n');
  assert.equal(owner.assertOwned(), true);
  assert.deepEqual(fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE)), lock);
  assert.equal(owner.release(), true);
  assert.equal(fs.existsSync(join(item.root, ACCEPTANCE_OWNER_FILE)), false);
  assert.equal(fs.readFileSync(join(item.root, 'ordinary.json'), 'utf8'), '{}\n');
});

test('first owner assertion rejects a replaced root even when the acquired lock inode is moved back', t => {
  const item = fixture(t), owner = acquireAcceptanceOwner({ root: item.root });
  const lockBefore = fs.lstatSync(join(item.root, ACCEPTANCE_OWNER_FILE), { bigint: true });
  const scene = replaceRoot(item);
  assert.equal(fs.lstatSync(join(item.root, ACCEPTANCE_OWNER_FILE), { bigint: true }).ino, lockBefore.ino);
  assert.throws(() => owner.assertOwned(), lost);
  assert.equal(owner.release(), false);
  assert.deepEqual(fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE)), scene.bytes);
  assert.equal(fs.readFileSync(join(item.root, 'scene.txt'), 'utf8'), 'replacement root must remain untouched');
  assert.equal(fs.existsSync(scene.moved), true);
});

test('release without a preceding assertion preserves a replacement root and the moved acquired lock', t => {
  const item = fixture(t), owner = acquireAcceptanceOwner({ root: item.root });
  const scene = replaceRoot(item);
  assert.equal(owner.release(), false);
  assert.equal(owner.release(), false);
  assert.deepEqual(fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE)), scene.bytes);
  assert.equal(fs.readFileSync(join(item.root, 'scene.txt'), 'utf8'), 'replacement root must remain untouched');
  assert.throws(() => owner.assertOwned(), lost);
});

test('release preserves both a foreign replacement lock and the original lock in the moved root', t => {
  const item = fixture(t), owner = acquireAcceptanceOwner({ root: item.root });
  const scene = replaceRoot(item, { moveLock: false });
  assert.throws(() => owner.assertOwned(), lost);
  assert.equal(owner.release(), false);
  assert.equal(fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE), 'utf8'), 'replacement-root-private-lock');
  assert.deepEqual(fs.readFileSync(join(scene.moved, ACCEPTANCE_OWNER_FILE)), scene.bytes);
});

test('same-canonical root alias recreation retains acquired ownership', t => {
  const item = fixture(t), alias = join(item.parent, 'alias');
  fs.symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = acquireAcceptanceOwner({ root: alias });
  t.after(() => owner.release());
  const originalLock = fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE));
  fs.unlinkSync(alias);
  fs.symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(owner.assertOwned(), true);
  assert.deepEqual(fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE)), originalLock);
  assert.equal(owner.release(), true);
});

test('retargeted alias loses assertion authority while release only removes its unchanged original root lock', t => {
  const item = fixture(t), alias = join(item.parent, 'alias'), other = join(item.parent, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = acquireAcceptanceOwner({ root: alias }), otherOwner = acquireAcceptanceOwner({ root: other });
  t.after(() => owner.release()); t.after(() => otherOwner.release());
  const otherLock = fs.readFileSync(join(other, ACCEPTANCE_OWNER_FILE));
  fs.unlinkSync(alias);
  fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => owner.assertOwned(), lost);
  assert.equal(owner.release(), true);
  assert.equal(fs.existsSync(join(item.root, ACCEPTANCE_OWNER_FILE)), false);
  assert.deepEqual(fs.readFileSync(join(other, ACCEPTANCE_OWNER_FILE)), otherLock);
  assert.equal(otherOwner.assertOwned(), true);
});

test('a root swap during stale-owner probing fails acquisition without deleting either scene', t => {
  const item = fixture(t);
  const record = { schemaVersion: 1, pid: 2147483646, hostname: hostname(),
    nonce: randomBytes(32).toString('hex'), createdAt: new Date(0).toISOString() };
  fs.writeFileSync(join(item.root, ACCEPTANCE_OWNER_FILE), JSON.stringify(record) + '\n');
  let scene, probes = 0;
  assert.throws(() => acquireAcceptanceOwner({ root: item.root, processProbe() {
    probes++; scene = replaceRoot(item);
    throw Object.assign(new Error('fixture proves process is gone'), { code: 'ESRCH' });
  } }), unavailable);
  assert.equal(probes, 1);
  assert.deepEqual(fs.readFileSync(join(item.root, ACCEPTANCE_OWNER_FILE)), scene.bytes);
  assert.equal(fs.existsSync(join(item.root, ACCEPTANCE_RECOVERY_FILE)), false);
  assert.equal(fs.readFileSync(join(item.root, 'scene.txt'), 'utf8'), 'replacement root must remain untouched');
});

test('root replacement inside lock creation or immediately before acquisition return never grants a capability', async t => {
  for (const timing of ['after-open', 'after-close']) await t.test(timing, {
    skip: timing === 'after-open' && process.platform === 'win32'
      ? 'Windows refuses to rename the directory while its lock descriptor is open; Linux exercises this acquisition race.' : false,
  }, t => {
    const item = fixture(t);
    const script = `
      import fs from 'node:fs';
      import { join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE } from ${JSON.stringify(OWNER_URL)};
      const { root, parent, timing } = JSON.parse(fs.readFileSync(0, 'utf8'));
      const originalOpen = fs.openSync, originalClose = fs.closeSync;
      let lockFd, swapped = false, acquired = false, error;
      const lockPath = join(root, ACCEPTANCE_OWNER_FILE), moved = join(parent, 'acquired-root');
      const swap = () => {
        if (swapped) return;
        swapped = true;
        fs.renameSync(root, moved); fs.mkdirSync(root);
        fs.renameSync(join(moved, ACCEPTANCE_OWNER_FILE), lockPath);
        fs.writeFileSync(join(root, 'scene.txt'), 'replacement during acquire');
      };
      fs.openSync = (path, ...args) => {
        const fd = originalOpen(path, ...args);
        if (path === lockPath && args[0] === 'wx') { lockFd = fd; if (timing === 'after-open') swap(); }
        return fd;
      };
      fs.closeSync = fd => {
        const value = originalClose(fd);
        if (fd === lockFd && timing === 'after-close') swap();
        return value;
      };
      try { syncBuiltinESMExports(); acquireAcceptanceOwner({ root }); acquired = true; }
      catch (caught) { error = { code: caught.code, status: caught.status, message: caught.message, hasCause: Object.hasOwn(caught, 'cause') }; }
      finally { fs.openSync = originalOpen; fs.closeSync = originalClose; syncBuiltinESMExports(); }
      console.log(JSON.stringify({ swapped, acquired, error, lockExists: fs.existsSync(lockPath),
        lockBytes: fs.existsSync(lockPath) ? fs.readFileSync(lockPath, 'utf8') : null,
        scene: fs.readFileSync(join(root, 'scene.txt'), 'utf8'), movedExists: fs.existsSync(moved) }));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      input: JSON.stringify({ ...item, timing }), encoding: 'utf8', timeout: 10000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr, '');
    const result = JSON.parse(child.stdout);
    assert.equal(result.swapped, true);
    assert.equal(result.acquired, false);
    assert.equal(result.error.code, unavailable.code); assert.equal(result.error.status, unavailable.status);
    assert.equal(result.error.hasCause, false);
    assert.equal(result.error.message.includes(item.parent), false);
    assert.equal(result.lockExists, true);
    assert.equal(result.scene, 'replacement during acquire');
    assert.equal(result.movedExists, true);
    if (timing === 'after-open') assert.equal(result.lockBytes, '');
    else assert.match(JSON.parse(result.lockBytes).nonce, /^[a-f0-9]{64}$/);
  });
});
