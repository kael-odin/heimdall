import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { acquireAcceptanceOwner, ACCEPTANCE_OWNER_FILE, ACCEPTANCE_RECOVERY_FILE } from '../src/acceptance/owner.mjs';

function temporary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-owner-'));
  try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
const record = overrides => ({ schemaVersion: 1, pid: process.pid, hostname: hostname(),
  nonce: randomBytes(32).toString('hex'), createdAt: new Date(0).toISOString(), ...overrides });
const unavailable = error => error?.status === 503 && error.code === 'ACCEPTANCE_OWNER_UNAVAILABLE'
  && !error.message.includes(tmpdir()) && !error.message.includes('heimdall-owner-');
const esrch = () => { throw Object.assign(new Error('fixture dead'), { code: 'ESRCH' }); };

test('one owner per real root, explicit release and re-acquire', () => temporary(root => {
  const owner = acquireAcceptanceOwner({ root });
  assert.equal(owner.root, realpathSync(root));
  assert.equal(owner.assertOwned(), true);
  assert.match(owner.nonce, /^[a-f0-9]{64}$/);
  assert.throws(() => acquireAcceptanceOwner({ root }), unavailable);
  assert.equal(owner.release(), true);
  assert.equal(owner.release(), false);
  assert.throws(() => owner.assertOwned(), { code: 'ACCEPTANCE_OWNER_LOST', status: 503 });
  const next = acquireAcceptanceOwner({ root });
  assert.notEqual(next.nonce, owner.nonce);
  assert.equal(next.release(), true);
}));

test('junction/symlink aliases share ownership and retargeting loses ownership', () => temporary(parent => {
  const root = join(parent, 'real'), alias = join(parent, 'alias'), other = join(parent, 'other');
  mkdirSync(root); mkdirSync(other);
  symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const owner = acquireAcceptanceOwner({ root: alias });
  assert.throws(() => acquireAcceptanceOwner({ root }), unavailable);
  unlinkSync(alias);
  symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => owner.assertOwned(), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.equal(owner.release(), true);
}));

test('live owner is never recovered because of an old timestamp', () => temporary(root => {
  const bytes = JSON.stringify(record());
  writeFileSync(join(root, ACCEPTANCE_OWNER_FILE), bytes);
  assert.throws(() => acquireAcceptanceOwner({ root }), unavailable);
  assert.equal(readFileSync(join(root, ACCEPTANCE_OWNER_FILE), 'utf8'), bytes);
}));

test('confirmed exited same-host process can be conservatively recovered', () => temporary(root => {
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  assert.ok(Number.isSafeInteger(child.pid));
  const stale = record({ pid: child.pid });
  writeFileSync(join(root, ACCEPTANCE_OWNER_FILE), JSON.stringify(stale));
  const owner = acquireAcceptanceOwner({ root });
  assert.notEqual(owner.nonce, stale.nonce);
  assert.equal(owner.assertOwned(), true);
  assert.equal(existsSync(join(root, ACCEPTANCE_RECOVERY_FILE)), false);
  owner.release();
}));

test('unknown and EPERM probes or remote hostname do not steal a lock', () => temporary(root => {
  const path = join(root, ACCEPTANCE_OWNER_FILE);
  for (const [value, processProbe] of [
    [record(), () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); }],
    [record(), () => { throw new Error('unknown'); }],
    [record({ hostname: 'another-host.invalid' }), esrch],
  ]) {
    const bytes = JSON.stringify(value); writeFileSync(path, bytes);
    assert.throws(() => acquireAcceptanceOwner({ root, processProbe }), unavailable);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
}));

test('malformed, oversized, and interrupted recovery records remain untouched', () => temporary(root => {
  const path = join(root, ACCEPTANCE_OWNER_FILE);
  for (const bytes of ['{bad', JSON.stringify({ pid: process.pid }), 'x'.repeat(4096)]) {
    writeFileSync(path, bytes);
    assert.throws(() => acquireAcceptanceOwner({ root, processProbe: esrch }), unavailable);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  }
  const bytes = JSON.stringify(record()); writeFileSync(path, bytes);
  writeFileSync(join(root, ACCEPTANCE_RECOVERY_FILE), JSON.stringify(record()));
  assert.throws(() => acquireAcceptanceOwner({ root, processProbe: esrch }), unavailable);
  assert.equal(readFileSync(path, 'utf8'), bytes);
}));

test('nonce change loses ownership and exit release cannot delete a replacement', () => temporary(root => {
  const owner = acquireAcceptanceOwner({ root });
  const replacement = JSON.stringify(record());
  writeFileSync(join(root, ACCEPTANCE_OWNER_FILE), replacement);
  assert.throws(() => owner.assertOwned(), { code: 'ACCEPTANCE_OWNER_LOST' });
  assert.equal(owner.release(), false);
  assert.equal(readFileSync(join(root, ACCEPTANCE_OWNER_FILE), 'utf8'), replacement);
}));

test('recovery rereads nonce under guard and keeps a changed lock', () => temporary(root => {
  const path = join(root, ACCEPTANCE_OWNER_FILE);
  writeFileSync(path, JSON.stringify(record()));
  const replacement = JSON.stringify(record());
  let probes = 0;
  assert.throws(() => acquireAcceptanceOwner({ root, processProbe: () => {
    if (++probes === 1) writeFileSync(path, replacement);
    esrch();
  } }), unavailable);
  assert.equal(readFileSync(path, 'utf8'), replacement);
  assert.equal(existsSync(join(root, ACCEPTANCE_RECOVERY_FILE)), false);
}));

test('late nonce changes fence both the stale owner and the recovery guard', () => temporary(root => {
  const path = join(root, ACCEPTANCE_OWNER_FILE), guard = join(root, ACCEPTANCE_RECOVERY_FILE);
  for (const changedPath of [path, guard]) {
    const initial = JSON.stringify(record()), replacement = JSON.stringify(record());
    writeFileSync(path, initial);
    let probes = 0;
    assert.throws(() => acquireAcceptanceOwner({ root, processProbe: () => {
      if (++probes === 2) writeFileSync(changedPath, replacement);
      esrch();
    } }), unavailable);
    assert.equal(readFileSync(path, 'utf8'), changedPath === path ? replacement : initial);
    if (changedPath === guard) {
      assert.equal(readFileSync(guard, 'utf8'), replacement);
      unlinkSync(guard);
    }
  }
}));
