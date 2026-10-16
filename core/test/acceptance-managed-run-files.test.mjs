import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createManagedRunFileContext } from '../src/acceptance/managed-run-files.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { AcceptanceCatalogError } from '../src/acceptance/catalog-schema.mjs';

const original = Buffer.from('{"status":"running"}\n'), updated = Buffer.from('{"status":"complete"}\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const busy = code => Object.assign(Error('secret path failure'), { code });
const rejected = (reason, committed = false, code) => error => error instanceof AcceptanceCatalogError
  && (!reason || error.details.reason === reason) && (!code || error.code === code)
  && error.writeMayHaveCommitted === committed && !/secret|[A-Z]:\\|\/tmp\//.test(error.message);
function fixture(t, { manifest = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-managed-files-'))), runId = 'ac-' + randomUUID();
  const directory = join(root, runId), file = join(directory, 'manifest.json'); fs.mkdirSync(directory);
  if (manifest) fs.writeFileSync(file, original);
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(root + '.saved', { recursive: true, force: true }); });
  return { root, runId, directory, file, options: { root, runId, assertWritable: () => true } };
}
const temporaryNames = f => fs.readdirSync(f.directory).filter(name => name.endsWith('.tmp'));
function childProbe(f, body) {
  const moduleUrl = new URL('../src/acceptance/managed-run-files.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createManagedRunFileContext } from ${JSON.stringify(moduleUrl)};
    const { root, runId, directory, file } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const options = { root, runId, assertWritable: () => true };
    ${body}
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], {
    input: JSON.stringify(f), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, ''); return child.stdout;
}

test('real owner creates and replaces complete files with private captures and no network', t => {
  const f = fixture(t), owner = acquireAcceptanceOwner({ root: f.root }); t.after(() => owner.release());
  let requests = 0; const fetch = globalThis.fetch;
  globalThis.fetch = () => { requests++; throw Error('unexpected request'); };
  try {
    const context = createManagedRunFileContext({ ...f.options, assertWritable: () => owner.assertOwned() });
    assert.equal(Object.isFrozen(context), true); assert.deepEqual(Object.keys(context), ['read', 'publish', 'assertCurrent']);
    assert.equal(context.read('manifest.json', { optional: true }), null);
    const first = context.publish('manifest.json', original, { expected: null });
    assert.deepEqual(first, { bytes: original, sha256: hash(original) }); assert.equal(Object.isFrozen(first), true);
    first.bytes.fill(0);
    const second = context.publish('manifest.json', updated, { expected: first });
    assert.deepEqual(second, { bytes: updated, sha256: hash(updated) });
    assert.deepEqual(context.read('manifest.json'), second);
    const report = context.publish('report.json', Buffer.from('{}'), { expected: null });
    assert.equal(report.sha256, hash(Buffer.from('{}'))); assert.equal(context.assertCurrent(), true);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), ['manifest.json', 'report.json']);
    owner.release(); assert.throws(() => context.assertCurrent(), rejected('WRITABLE_FENCE_FAILED'));
  } finally { globalThis.fetch = fetch; }
  assert.equal(requests, 0);
});

test('only optional initial absence returns null and missing directories are never created', t => {
  const f = fixture(t), context = createManagedRunFileContext(f.options);
  assert.equal(context.read('report.json', { optional: true }), null);
  assert.throws(() => context.read('report.json'), rejected('FILESYSTEM_FAILURE'));
  const missing = join(f.root, 'missing');
  assert.throws(() => createManagedRunFileContext({ ...f.options, root: missing }), rejected('FILESYSTEM_FAILURE'));
  assert.equal(fs.existsSync(missing), false);
  fs.rmdirSync(f.directory);
  assert.throws(() => createManagedRunFileContext(f.options), rejected('FILESYSTEM_FAILURE'));
  assert.equal(fs.existsSync(f.directory), false);
});

test('strict names, options, bounds and expected tokens reject without invoking accessors', t => {
  const f = fixture(t, { manifest: true }); let getters = 0;
  const context = createManagedRunFileContext(f.options), token = context.read('manifest.json');
  const other = createManagedRunFileContext(f.options), bad = () => assert.fail('getter executed');
  for (const name of ['report.md', 'triage.json', '../manifest.json', 'manifest.json.tmp', '', null]) {
    assert.throws(() => context.read(name), rejected('INVALID_FILE_NAME', false, 'INVALID_INPUT'));
    assert.throws(() => context.publish(name, updated, { expected: token }), rejected('INVALID_FILE_NAME', false, 'INVALID_INPUT'));
  }
  for (const expected of [undefined, {}, { ...token }, new Proxy(token, { get: bad }), other.read('manifest.json')]) {
    assert.throws(() => context.publish('manifest.json', updated, { expected }), rejected('INVALID_EXPECTED_TOKEN', false, 'INVALID_INPUT'));
  }
  assert.throws(() => context.publish('report.json', updated, { expected: token }), rejected('INVALID_EXPECTED_TOKEN', false, 'INVALID_INPUT'));
  assert.throws(() => context.publish('manifest.json', updated), rejected(undefined, false, 'INVALID_INPUT'));
  const withGetter = { ...f.options, get limits() { getters++; return {}; } };
  for (const options of [withGetter, { ...f.options, owner: {} }, { ...f.options, limits: { jsonBytes: 8 * 1024 * 1024 + 1 } },
    { ...f.options, limits: { maxRetryMs: 751 } }, { ...f.options, io: { mkdirSync() {} } },
    { ...f.options, root: 'relative' }, { ...f.options, runId: '../run' }]) assert.throws(() => createManagedRunFileContext(options), rejected(undefined, false, 'INVALID_INPUT'));
  assert.throws(() => context.read('manifest.json', { maxBytes: original.length - 1 }), rejected('FILE_BYTES_EXCEEDED'));
  assert.throws(() => context.read('manifest.json', { optional: 1 }), rejected('INVALID_READ_OPTIONS', false, 'INVALID_INPUT'));
  assert.throws(() => context.read('manifest.json', { optional: null }), rejected('INVALID_READ_OPTIONS', false, 'INVALID_INPUT'));
  assert.throws(() => context.read('manifest.json', { maxBytes: null }), rejected('INVALID_READ_OPTIONS', false, 'INVALID_INPUT'));
  assert.throws(() => context.publish('manifest.json', new SharedArrayBuffer(4), { expected: token }), rejected('INVALID_BYTES', false, 'INVALID_INPUT'));
  assert.throws(() => context.publish('manifest.json', new Uint8Array(new SharedArrayBuffer(4)), { expected: token }), rejected('INVALID_BYTES', false, 'INVALID_INPUT'));
  assert.throws(() => context.publish('manifest.json', new Proxy(updated, {}), { expected: token }), rejected('INVALID_BYTES', false, 'INVALID_INPUT'));
  assert.equal(getters, 0); assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(temporaryNames(f), []);
});

test('publication captures caller input before a business hook can mutate its bytes', t => {
  const f = fixture(t), input = Buffer.from(original), context = createManagedRunFileContext(f.options);
  const token = context.publish('manifest.json', input, { expected: null, beforePublish() { input.fill(0); } });
  assert.deepEqual(token.bytes, original); assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(input.every(byte => byte === 0), true);
});

test('lowered byte limit accepts its exact boundary and short reads/writes complete', t => {
  const f = fixture(t), context = createManagedRunFileContext({ ...f.options, limits: { jsonBytes: original.length }, io: {
    readSync: (fd, bytes, offset, count, position) => fs.readSync(fd, bytes, offset, Math.min(count, 3), position),
    writeSync: (fd, bytes, offset, count, position) => fs.writeSync(fd, bytes, offset, Math.min(count, 2), position),
  } });
  assert.deepEqual(context.publish('manifest.json', original, { expected: null }).bytes, original);
  assert.throws(() => context.publish('report.json', Buffer.alloc(original.length + 1), { expected: null }), rejected('FILE_BYTES_EXCEEDED', false, 'INVALID_INPUT'));
  assert.deepEqual(context.read('manifest.json', { maxBytes: original.length }).bytes, original);
  assert.deepEqual(temporaryNames(f), []);
});

test('exclusive publication never overwrites existing targets and old tokens cannot be reused', t => {
  const f = fixture(t, { manifest: true }), context = createManagedRunFileContext(f.options);
  assert.throws(() => context.publish('manifest.json', updated, { expected: null }), rejected('TARGET_EXISTS', false, 'MANAGED_RUN_FILE_CONFLICT'));
  const first = context.read('manifest.json'), second = context.publish('manifest.json', updated, { expected: first });
  assert.throws(() => context.publish('manifest.json', original, { expected: first }), rejected('FILE_CHANGED', false, 'MANAGED_RUN_FILE_CONFLICT'));
  assert.deepEqual(context.read('manifest.json'), second); assert.deepEqual(temporaryNames(f), []);
});

test('target disappearance, same-byte new inode, links and directories cannot satisfy a token', t => {
  for (const mutation of ['remove', 'replace', 'symlink', 'directory']) {
    const f = fixture(t, { manifest: true }), context = createManagedRunFileContext(f.options), token = context.read('manifest.json');
    fs.renameSync(f.file, f.file + '.saved');
    if (mutation === 'replace') fs.writeFileSync(f.file, original);
    if (mutation === 'symlink') fs.symlinkSync(f.file + '.saved', f.file);
    if (mutation === 'directory') fs.mkdirSync(f.file);
    assert.throws(() => context.publish('manifest.json', updated, { expected: token }), rejected());
    assert.deepEqual(fs.readFileSync(f.file + '.saved'), original);
    if (mutation === 'replace') assert.deepEqual(fs.readFileSync(f.file), original);
    if (mutation === 'symlink') assert.equal(fs.lstatSync(f.file).isSymbolicLink(), true);
    if (mutation === 'directory') assert.equal(fs.lstatSync(f.file).isDirectory(), true);
    assert.deepEqual(temporaryNames(f), []);
  }
});

test('root and run directory changes are sticky and directory links are never followed', t => {
  for (const part of ['root', 'directory']) {
    const f = fixture(t), context = createManagedRunFileContext(f.options), path = f[part];
    fs.renameSync(path, path + '.saved'); fs.mkdirSync(path);
    assert.throws(() => context.assertCurrent(), rejected(part === 'root' ? 'ROOT_CHANGED' : 'RUN_DIRECTORY_CHANGED'));
    fs.rmdirSync(path); fs.renameSync(path + '.saved', path);
    assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected());
    assert.equal(fs.existsSync(f.file), false);
  }
  const f = fixture(t); fs.renameSync(f.directory, f.directory + '.saved');
  fs.symlinkSync(f.directory + '.saved', f.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createManagedRunFileContext(f.options), rejected('DIRECTORY_IDENTITY_INVALID'));
  assert.deepEqual(fs.readdirSync(f.directory + '.saved'), []);
});

test('observed file/root/run realpath ENOENT is unsafe instead of optional absence', t => {
  const f = fixture(t, { manifest: true });
  for (const part of ['root', 'directory', 'file']) childProbe(f, `
    const target = ${JSON.stringify(part)} === 'root' ? root : ${JSON.stringify(part)} === 'directory' ? directory : file;
    const native = fs.realpathSync; let armed = false;
    fs.realpathSync = (path, ...args) => { if (armed && path === target) throw Object.assign(Error('secret resolution'), { code: 'ENOENT' }); return native(path, ...args); };
    syncBuiltinESMExports(); const context = createManagedRunFileContext(options); armed = true;
    assert.throws(() => context.read('manifest.json', { optional: true }), error => error.code === 'MANAGED_RUN_FILES_UNAVAILABLE'
      && error.details.reason === 'FILESYSTEM_FAILURE' && error.writeMayHaveCommitted === false && !error.message.includes('secret'));
  `);
});

test('same-length target mutation with fixed metadata cannot satisfy an expected capture', t => {
  const f = fixture(t, { manifest: true });
  childProbe(f, `
    const nativeLstat = fs.lstatSync, nativeFstat = fs.fstatSync, pinned = nativeLstat(file, { bigint: true });
    fs.lstatSync = (path, ...args) => path === file ? pinned : nativeLstat(path, ...args);
    fs.fstatSync = (fd, ...args) => { const stat = nativeFstat(fd, ...args); return stat.dev === pinned.dev && stat.ino === pinned.ino ? pinned : stat; };
    syncBuiltinESMExports(); const context = createManagedRunFileContext(options), token = context.read('manifest.json');
    const modified = fs.readFileSync(file); modified[0] = 32; fs.writeFileSync(file, modified);
    assert.throws(() => context.publish('manifest.json', Buffer.from('{}'), { expected: token }), error => error.details.reason === 'FILE_CHANGED'
      && error.writeMayHaveCommitted === false); assert.deepEqual(fs.readFileSync(file), modified);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 0);
  `);
});

test('second descriptor read corruption is rejected even without filesystem metadata changes', t => {
  const f = fixture(t, { manifest: true }); let bodyReads = 0;
  const context = createManagedRunFileContext({ ...f.options, io: { readSync(fd, bytes, offset, count, position) {
    const result = fs.readSync(fd, bytes, offset, count, position);
    if (count === original.length && position === 0 && ++bodyReads === 2) bytes[0] = 32; return result;
  } } });
  assert.throws(() => context.read('manifest.json'), rejected('FILE_CHANGED', false, 'MANAGED_RUN_FILE_CONFLICT'));
  assert.equal(bodyReads, 2); assert.deepEqual(fs.readFileSync(f.file), original);
});

test('read failures and invalid counts close every read descriptor', t => {
  for (const outcome of ['throw', 0, -1, 1000, NaN]) {
    const f = fixture(t, { manifest: true }), active = new Set();
    const context = createManagedRunFileContext({ ...f.options, io: {
      openSync(...args) { const fd = fs.openSync(...args); active.add(fd); return fd; },
      closeSync(fd) { fs.closeSync(fd); active.delete(fd); },
      readSync() { if (outcome === 'throw') throw busy('EIO'); return outcome; },
    } });
    assert.throws(() => context.read('manifest.json'), rejected(outcome === 'throw' ? 'FILESYSTEM_FAILURE' : 'READ_INCOMPLETE'));
    assert.equal(active.size, 0); assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('file growth before descriptor capture is refused before any body read', t => {
  const f = fixture(t, { manifest: true }); let reads = 0, opened;
  const context = createManagedRunFileContext({ ...f.options, io: {
    openSync(path, ...args) { fs.appendFileSync(path, ' '.repeat(8192)); opened = fs.openSync(path, ...args); return opened; },
    readSync() { reads++; assert.fail('grown file body read'); },
  } });
  assert.throws(() => context.read('manifest.json'), rejected('FILE_CHANGED', false, 'MANAGED_RUN_FILE_CONFLICT'));
  assert.equal(reads, 0); assert.throws(() => fs.fstatSync(opened), error => error.code === 'EBADF');
  assert.equal(fs.statSync(f.file).size, original.length + 8192);
});

test('non-regular named pipe targets are rejected without opening or blocking', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); const child = spawnSync('mkfifo', [f.file], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); let opens = 0;
  const context = createManagedRunFileContext({ ...f.options, io: { openSync() { opens++; assert.fail('pipe opened'); } } });
  assert.throws(() => context.read('manifest.json', { optional: true }), rejected('FILE_IDENTITY_INVALID'));
  assert.equal(opens, 0); assert.equal(fs.lstatSync(f.file).isFIFO(), true);
});

test('incomplete writes, fsync failure and writer-close failure never publish', t => {
  for (const phase of ['write-throw', 'write-zero', 'write-over', 'fsync', 'close']) {
    const f = fixture(t), writers = new Set(); let publications = 0;
    const context = createManagedRunFileContext({ ...f.options, io: {
      openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); if (flags === 'wx') writers.add(fd); return fd; },
      writeSync(fd, bytes, offset, count, position) {
        if (phase === 'write-zero') return 0; if (phase === 'write-over') return count + 1;
        if (phase === 'write-throw') { fs.writeSync(fd, bytes, offset, 2, position); throw busy('ENOSPC'); }
        return fs.writeSync(fd, bytes, offset, count, position);
      },
      fsyncSync(fd) { if (phase === 'fsync') throw busy('EIO'); fs.fsyncSync(fd); },
      closeSync(fd) { fs.closeSync(fd); if (writers.delete(fd) && phase === 'close') throw busy('EIO'); },
      linkSync() { publications++; assert.fail('incomplete file published'); },
    } });
    assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected());
    assert.equal(publications, 0); assert.equal(fs.existsSync(f.file), false); assert.deepEqual(temporaryNames(f), []);
  }
});

test('close-before-throw failures release owned read and writer descriptors without publishing', t => {
  for (const operation of ['read', 'publish']) {
    const f = fixture(t, { manifest: operation === 'read' }), descriptors = []; let failed = false;
    const context = createManagedRunFileContext({ ...f.options, io: {
      openSync(...args) { const fd = fs.openSync(...args); descriptors.push(fd); return fd; },
      closeSync(fd) { if (!failed) { failed = true; throw busy('EIO'); } fs.closeSync(fd); },
    } });
    assert.throws(() => operation === 'read' ? context.read('manifest.json') : context.publish('manifest.json', original, { expected: null }), rejected('FILESYSTEM_FAILURE'));
    assert.equal(failed, true);
    for (const fd of new Set(descriptors)) assert.throws(() => fs.fstatSync(fd), error => error.code === 'EBADF');
    assert.equal(fs.existsSync(f.file), operation === 'read'); assert.deepEqual(temporaryNames(f), []);
  }
});

test('close-then-throw never closes a descriptor reused for another inode', t => {
  const f = fixture(t, { manifest: true }), unrelated = join(f.directory, 'unrelated'); fs.writeFileSync(unrelated, 'keep');
  let reused, failed = false;
  t.after(() => { if (reused !== undefined) fs.closeSync(reused); });
  const context = createManagedRunFileContext({ ...f.options, io: { closeSync(fd) {
    fs.closeSync(fd);
    if (!failed) { failed = true; reused = fs.openSync(unrelated, 'r'); assert.equal(reused, fd); throw busy('EIO'); }
  } } });
  assert.throws(() => context.read('manifest.json'), rejected('FILESYSTEM_FAILURE'));
  assert.equal(fs.fstatSync(reused).isFile(), true); assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep');
});

test('temporary inode remains pinned through writer close and conditional cleanup', t => {
  const f = fixture(t), active = new Map(); let writer, pinnedAtClose = false, pinnedAtCleanup = false;
  const context = createManagedRunFileContext({ ...f.options, io: {
    openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); active.set(fd, { path, flags }); if (flags === 'wx') writer = fd; return fd; },
    closeSync(fd) { if (fd === writer && active.get(fd)?.flags === 'wx') pinnedAtClose = [...active].some(([other, entry]) => other !== fd && entry.path.endsWith('.tmp'));
      fs.closeSync(fd); active.delete(fd); },
    unlinkSync(path) { pinnedAtCleanup = [...active.values()].some(entry => entry.path === path && entry.flags !== 'wx'); fs.unlinkSync(path); },
  } });
  context.publish('manifest.json', original, { expected: null });
  assert.equal(pinnedAtClose, true); assert.equal(pinnedAtCleanup, true); assert.equal(active.size, 0); assert.deepEqual(temporaryNames(f), []);
});

test('same-byte temporary replacements after writer close are preserved instead of cleaned', t => {
  const f = fixture(t); let writer, temporary, replaced = false;
  const context = createManagedRunFileContext({ ...f.options, io: {
    openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); if (flags === 'wx') { writer = fd; temporary = path; } return fd; },
    closeSync(fd) { fs.closeSync(fd); if (fd === writer && !replaced) { replaced = true; fs.unlinkSync(temporary); fs.writeFileSync(temporary, original); } },
  } });
  assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('TEMPORARY_CHANGED'));
  assert.equal(replaced, true); assert.deepEqual(fs.readFileSync(temporary), original); assert.equal(fs.existsSync(f.file), false);
});

test('temporary symlink replacements after writer close are preserved and never followed', t => {
  const f = fixture(t), unrelated = join(f.directory, 'keep'); fs.writeFileSync(unrelated, original);
  let writer, temporary, replaced = false;
  const context = createManagedRunFileContext({ ...f.options, io: {
    openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); if (flags === 'wx') { writer = fd; temporary = path; } return fd; },
    closeSync(fd) { fs.closeSync(fd); if (fd === writer && !replaced) { replaced = true; fs.unlinkSync(temporary); fs.symlinkSync(unrelated, temporary); } },
  } });
  assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('FILE_IDENTITY_INVALID'));
  assert.equal(fs.lstatSync(temporary).isSymbolicLink(), true); assert.deepEqual(fs.readFileSync(unrelated), original); assert.equal(fs.existsSync(f.file), false);
});

test('lost writable fence after a write preserves partial temporary material and never publishes', t => {
  const f = fixture(t); let valid = true, writes = 0, links = 0;
  const context = createManagedRunFileContext({ ...f.options, assertWritable: () => { if (!valid) throw busy('ELOCK'); }, io: {
    writeSync(...args) { writes++; const result = fs.writeSync(...args); valid = false; return result; },
    linkSync() { links++; assert.fail('lost owner published'); },
  } });
  assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('WRITABLE_FENCE_FAILED'));
  assert.equal(writes, 1); assert.equal(links, 0); assert.equal(fs.existsSync(f.file), false);
  assert.equal(temporaryNames(f).length, 1); valid = true; assert.throws(() => context.assertCurrent(), rejected('WRITABLE_FENCE_FAILED'));
});

test('exclusive link failures distinguish before-commit and commit-then-throw without rollback', t => {
  for (const commit of [false, true]) {
    const f = fixture(t), context = createManagedRunFileContext({ ...f.options, io: {
      linkSync(source, target) { if (commit) fs.linkSync(source, target); throw busy('EIO'); },
    } });
    assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('FILESYSTEM_FAILURE', commit));
    assert.equal(fs.existsSync(f.file), commit);
    if (commit) assert.deepEqual(fs.readFileSync(f.file), original);
    assert.equal(temporaryNames(f).length, commit ? 1 : 0);
  }
});

test('rename failures reconcile original identity versus committed replacement', t => {
  for (const commit of [false, true]) {
    const f = fixture(t, { manifest: true }), context = createManagedRunFileContext({ ...f.options, io: {
      renameSync(source, target) { if (commit) fs.renameSync(source, target); throw busy('ENOSPC'); },
    } }), token = context.read('manifest.json');
    assert.throws(() => context.publish('manifest.json', updated, { expected: token }), rejected('FILESYSTEM_FAILURE', commit));
    assert.deepEqual(fs.readFileSync(f.file), commit ? updated : original); assert.deepEqual(temporaryNames(f), []);
  }
});

test('postpublication lost fence retains the formal file and reports possible commit', t => {
  const f = fixture(t); let valid = true;
  const context = createManagedRunFileContext({ ...f.options, assertWritable: () => { if (!valid) throw busy('ELOCK'); }, io: {
    linkSync(source, target) { fs.linkSync(source, target); valid = false; },
  } });
  assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('WRITABLE_FENCE_FAILED', true));
  assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(temporaryNames(f).length, 1);
});

test('postpublication file corruption is never deleted or reported as a successful write', t => {
  const f = fixture(t), modified = Buffer.from(original); modified[0] = 32;
  const context = createManagedRunFileContext({ ...f.options, io: {
    linkSync(source, target) { fs.linkSync(source, target); fs.writeFileSync(target, modified); },
  } });
  assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('PUBLISHED_FILE_CHANGED', true));
  assert.deepEqual(fs.readFileSync(f.file), modified);
});

test('Windows sharing failures retry complete bytes within an independent wait budget', t => {
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    const f = fixture(t, { manifest: true }); let calls = 0, waited = 0;
    const context = createManagedRunFileContext({ ...f.options, platform: 'win32', now: () => 0,
      sleep: delay => { waited += delay; }, io: { renameSync(source, target) {
        assert.deepEqual(fs.readFileSync(target), original);
        if (++calls < 3) throw busy(code); fs.renameSync(source, target);
      } } });
    context.publish('manifest.json', updated, { expected: context.read('manifest.json') });
    assert.equal(calls, 3); assert.equal(waited, 30); assert.deepEqual(fs.readFileSync(f.file), updated); assert.deepEqual(temporaryNames(f), []);
  }
  const f = fixture(t, { manifest: true }); let calls = 0, waited = 0;
  const context = createManagedRunFileContext({ ...f.options, platform: 'win32', limits: { maxRetryMs: 45 }, now: () => 0,
    sleep: delay => { waited += delay; }, io: { renameSync() { calls++; throw busy('EBUSY'); } } });
  assert.throws(() => context.publish('manifest.json', updated, { expected: context.read('manifest.json') }), rejected('FILESYSTEM_FAILURE'));
  assert.equal(calls, 4); assert.equal(waited, 45); assert.deepEqual(fs.readFileSync(f.file), original); assert.deepEqual(temporaryNames(f), []);
});

test('beforePublish follows completed bytes and short authority, with no later business callback before commit', t => {
  const f = fixture(t), events = []; let synced = false, closedWriter = false, writer, phase = 'initial';
  const checkPublication = () => {
    assert.equal(phase, 'business');
    const lastBusiness = events.lastIndexOf('business'); assert.ok(lastBusiness >= 0);
    assert.equal(events.slice(lastBusiness + 1).includes('authority'), false);
    assert.ok(events.slice(lastBusiness + 1).includes('read')); phase = 'committed';
  };
  const context = createManagedRunFileContext({ ...f.options, assertWritable() { events.push('authority');
    if (phase === 'business') phase = 'callback-after-business'; }, io: {
    openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); if (flags === 'wx') writer = fd; return fd; },
    fsyncSync(fd) { fs.fsyncSync(fd); synced = true; },
    closeSync(fd) { fs.closeSync(fd); if (fd === writer) { closedWriter = true; writer = undefined; } },
    readSync(...args) { events.push('read'); return fs.readSync(...args); },
    linkSync(source, target) { checkPublication(); fs.linkSync(source, target); },
    renameSync(source, target) { checkPublication(); fs.renameSync(source, target); },
  } });
  const beforePublish = () => {
    assert.equal(synced, true); assert.equal(closedWriter, true); assert.equal(events.at(-1), 'authority');
    events.push('business'); phase = 'business'; return true;
  };
  const first = context.publish('manifest.json', original, { expected: null, beforePublish });
  context.publish('manifest.json', updated, { expected: first, beforePublish });
  assert.equal(events.filter(event => event === 'business').length, 2); assert.deepEqual(fs.readFileSync(f.file), updated);
});

test('beforePublish runs for every Windows retry and a later failure makes the scope sticky', t => {
  for (const failAfterBusy of [false, true]) {
    const f = fixture(t, { manifest: true }); let calls = 0, hooks = 0;
    const context = createManagedRunFileContext({ ...f.options, platform: 'win32', now: () => 0, sleep() {}, io: {
      renameSync(source, target) { if (++calls < 3) throw busy('EBUSY'); fs.renameSync(source, target); },
    } });
    const beforePublish = () => { hooks++; if (failAfterBusy && hooks === 2) throw Error('secret business changed'); };
    const expected = context.read('manifest.json');
    if (failAfterBusy) {
      assert.throws(() => context.publish('manifest.json', updated, { expected, beforePublish }), rejected('PUBLISH_GUARD_FAILED', true));
      assert.equal(calls, 1); assert.equal(hooks, 2); assert.equal(temporaryNames(f).length, 1);
      assert.deepEqual(fs.readFileSync(f.file), original);
      assert.throws(() => context.assertCurrent(), rejected('PUBLISH_GUARD_FAILED'));
    } else {
      context.publish('manifest.json', updated, { expected, beforePublish }); assert.equal(calls, 3); assert.equal(hooks, 3);
      assert.deepEqual(fs.readFileSync(f.file), updated); assert.deepEqual(temporaryNames(f), []);
    }
  }
});

test('beforePublish rejection retains temporary material and never follows a thenable getter', t => {
  for (const result of [false, 0, '', null, { get then() { assert.fail('then getter'); } }]) {
    const f = fixture(t), context = createManagedRunFileContext(f.options);
    const object = typeof result === 'object' && result !== null;
    assert.throws(() => context.publish('manifest.json', original, { expected: null, beforePublish: () => result }),
      rejected(object ? 'ASYNC_GUARD_UNSUPPORTED' : 'PUBLISH_GUARD_REJECTED', false, object ? 'INVALID_INPUT' : undefined));
    assert.equal(fs.existsSync(f.file), false); assert.equal(temporaryNames(f).length, 1);
    assert.throws(() => context.assertCurrent(), rejected(object ? 'ASYNC_GUARD_UNSUPPORTED' : 'PUBLISH_GUARD_REJECTED'));
  }
  const f = fixture(t), context = createManagedRunFileContext(f.options);
  for (const beforePublish of [async () => true, function* () {}, new Proxy(() => true, {})]) {
    assert.throws(() => context.publish('manifest.json', original, { expected: null, beforePublish }), rejected('INVALID_PUBLISH_GUARD', false, 'INVALID_INPUT'));
  }
  assert.deepEqual(fs.readdirSync(f.directory), []);
  childProbe(f, `
    const context = createManagedRunFileContext(options);
    assert.throws(() => context.publish('manifest.json', Buffer.from('{}'), { expected: null,
      beforePublish: () => Promise.reject(Error('native publish rejection')) }), error => error.details.reason === 'ASYNC_GUARD_UNSUPPORTED'
      && error.writeMayHaveCommitted === false);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(fs.existsSync(file), false);
    assert.equal(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')).length, 1);
  `);
});

test('hook-created target or temporary replacements cannot escape the final internal fence', t => {
  for (const part of ['target', 'temporary']) {
    const f = fixture(t, { manifest: true }); let temporary, publications = 0;
    const context = createManagedRunFileContext({ ...f.options, io: {
      openSync(path, flags, ...args) { if (flags === 'wx') temporary = path; return fs.openSync(path, flags, ...args); },
      renameSync() { publications++; assert.fail('replaced material published'); },
    } });
    const expected = context.read('manifest.json'), replaced = part === 'target' ? f.file : null;
    assert.throws(() => context.publish('manifest.json', updated, { expected, beforePublish() {
      const path = replaced ?? temporary; fs.renameSync(path, path + '.saved'); fs.writeFileSync(path, 'keep replacement');
    } }), rejected());
    assert.equal(publications, 0); assert.equal(fs.readFileSync(replaced ?? temporary, 'utf8'), 'keep replacement');
    if (part === 'target') assert.deepEqual(fs.readFileSync(f.file + '.saved'), original);
    else assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('hook same-length byte changes with unchanged metadata are rejected after the last business callback', t => {
  for (const part of ['target', 'temporary']) {
    const f = fixture(t, { manifest: true });
    childProbe(f, `
      const nativeLstat = fs.lstatSync, nativeFstat = fs.fstatSync;
      let pinnedPath, pinnedStat, temporary, publications = 0;
      fs.lstatSync = (path, ...args) => path === pinnedPath ? pinnedStat : nativeLstat(path, ...args);
      fs.fstatSync = (fd, ...args) => { const stat = nativeFstat(fd, ...args); return pinnedStat && stat.dev === pinnedStat.dev && stat.ino === pinnedStat.ino ? pinnedStat : stat; };
      syncBuiltinESMExports();
      const context = createManagedRunFileContext({ ...options, io: {
        openSync(path, flags, ...args) { if (flags === 'wx') temporary = path; return fs.openSync(path, flags, ...args); },
        renameSync() { publications++; assert.fail('changed bytes published'); } } });
      const expected = context.read('manifest.json');
      assert.throws(() => context.publish('manifest.json', Buffer.from('01234567890123456789'), { expected, beforePublish() {
        pinnedPath = ${JSON.stringify(part)} === 'target' ? file : temporary; pinnedStat = nativeLstat(pinnedPath, { bigint: true });
        const modified = fs.readFileSync(pinnedPath); modified[0] = 32; fs.writeFileSync(pinnedPath, modified);
      } }), error => error.details.reason === (${JSON.stringify(part)} === 'target' ? 'FILE_CHANGED' : 'TEMPORARY_CHANGED')
        && error.writeMayHaveCommitted === false);
      assert.equal(publications, 0); assert.equal(fs.existsSync(file), true);
    `);
  }
});

test('non-Windows and permanent rename failures are never retried', t => {
  for (const [platform, code] of [['linux', 'EBUSY'], ['darwin', 'EPERM'], ['win32', 'ENOSPC']]) {
    const f = fixture(t, { manifest: true }); let calls = 0;
    const context = createManagedRunFileContext({ ...f.options, platform, sleep: () => assert.fail('unexpected retry'),
      io: { renameSync() { calls++; throw busy(code); } } });
    assert.throws(() => context.publish('manifest.json', updated, { expected: context.read('manifest.json') }), rejected('FILESYSTEM_FAILURE'));
    assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(f.file), original);
  }
});

test('Windows retry rechecks lost authority and keeps the untouched target and temporary', t => {
  const f = fixture(t, { manifest: true }); let valid = true, calls = 0;
  const context = createManagedRunFileContext({ ...f.options, platform: 'win32', assertWritable: () => { if (!valid) throw Error('lost'); },
    now: () => 0, sleep: () => { valid = false; }, io: { renameSync() { calls++; throw busy('EBUSY'); } } });
  assert.throws(() => context.publish('manifest.json', updated, { expected: context.read('manifest.json') }), rejected('WRITABLE_FENCE_FAILED', true));
  assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(temporaryNames(f).length, 1);
});

test('Windows retry rejects run or temporary replacement before a second attempt', t => {
  for (const part of ['directory', 'temporary']) {
    if (part === 'directory' && process.platform === 'win32') continue; // A live anchor blocks directory rename on Windows.
    const f = fixture(t, { manifest: true }); let temporary, calls = 0;
    const context = createManagedRunFileContext({ ...f.options, platform: 'win32', now: () => 0,
      sleep() {
        if (part === 'directory') { fs.renameSync(f.directory, f.directory + '.saved'); fs.mkdirSync(f.directory); }
        else { fs.unlinkSync(temporary); fs.writeFileSync(temporary, 'keep replacement'); }
      }, io: { renameSync(source) { temporary = source; calls++; throw busy('EBUSY'); } } });
    assert.throws(() => context.publish('manifest.json', updated, { expected: context.read('manifest.json') }), rejected(undefined, part === 'directory'));
    assert.equal(calls, 1);
    if (part === 'directory') { assert.deepEqual(fs.readFileSync(join(f.directory + '.saved', 'manifest.json')), original); assert.deepEqual(fs.readdirSync(f.directory), []); }
    else { assert.deepEqual(fs.readFileSync(f.file), original); assert.equal(fs.readFileSync(temporary, 'utf8'), 'keep replacement'); }
  }
});

test('Windows retry fences a changed run identity even when its path is still canonical', t => {
  const f = fixture(t, { manifest: true });
  childProbe(f, `
    const nativeLstat = fs.lstatSync, pinned = nativeLstat(directory, { bigint: true });
    const changed = Object.create(pinned); Object.defineProperty(changed, 'ino', { value: pinned.ino + 1n });
    let armed = false, calls = 0;
    fs.lstatSync = (path, ...args) => armed && path === directory ? changed : nativeLstat(path, ...args);
    syncBuiltinESMExports();
    const context = createManagedRunFileContext({ ...options, platform: 'win32', now: () => 0, sleep() { armed = true; },
      io: { renameSync() { calls++; throw Object.assign(Error('busy'), { code: 'EBUSY' }); } } });
    const token = context.read('manifest.json');
    assert.throws(() => context.publish('manifest.json', Buffer.from('{}'), { expected: token }), error =>
      error.details.reason === 'RUN_DIRECTORY_CHANGED' && error.writeMayHaveCommitted === true);
    assert.equal(calls, 1); assert.deepEqual(fs.readFileSync(file), token.bytes);
  `);
});

test('Windows retry detects same-length target and temporary edits even with frozen metadata', t => {
  for (const part of ['target', 'temporary']) {
    const f = fixture(t, { manifest: true });
    childProbe(f, `
      const nativeLstat = fs.lstatSync, nativeFstat = fs.fstatSync;
      let pinnedPath, pinnedStat, temporary, calls = 0;
      fs.lstatSync = (path, ...args) => path === pinnedPath ? pinnedStat : nativeLstat(path, ...args);
      fs.fstatSync = (fd, ...args) => { const stat = nativeFstat(fd, ...args); return pinnedStat && stat.dev === pinnedStat.dev && stat.ino === pinnedStat.ino ? pinnedStat : stat; };
      syncBuiltinESMExports();
      const context = createManagedRunFileContext({ ...options, platform: 'win32', now: () => 0,
        sleep() { pinnedPath = ${JSON.stringify(part)} === 'target' ? file : temporary; pinnedStat = nativeLstat(pinnedPath, { bigint: true });
          const bytes = fs.readFileSync(pinnedPath); bytes[0] = 32; fs.writeFileSync(pinnedPath, bytes); },
        io: { renameSync(source) { temporary = source; calls++; throw Object.assign(Error('busy'), { code: 'EBUSY' }); } } });
      const token = context.read('manifest.json');
      assert.throws(() => context.publish('manifest.json', Buffer.from('01234567890123456789'), { expected: token }), error =>
        error.details.reason === (${JSON.stringify(part)} === 'target' ? 'FILE_CHANGED' : 'TEMPORARY_CHANGED'));
      assert.equal(calls, 1); assert.equal(fs.existsSync(file), true);
    `);
  }
});

test('invalid clocks and asynchronous runtime results stop bounded retries', t => {
  for (const clock of [NaN, Infinity, -Infinity]) {
    const f = fixture(t, { manifest: true }); let calls = 0;
    const context = createManagedRunFileContext({ ...f.options, now: () => clock, io: { renameSync() { calls++; assert.fail('invalid clock published'); } } });
    assert.throws(() => context.publish('manifest.json', updated, { expected: context.read('manifest.json') }), rejected('INVALID_CLOCK', false, 'INVALID_INPUT'));
    assert.equal(calls, 0); assert.deepEqual(fs.readFileSync(f.file), original);
  }
  const f = fixture(t, { manifest: true });
  const context = createManagedRunFileContext({ ...f.options, platform: 'win32', now: () => 0,
    sleep: () => ({ get then() { assert.fail('then getter'); } }), io: { renameSync() { throw busy('EBUSY'); } } });
  assert.throws(() => context.publish('manifest.json', updated, { expected: context.read('manifest.json') }), rejected('ASYNC_RUNTIME_UNSUPPORTED', false, 'INVALID_INPUT'));
  assert.deepEqual(fs.readFileSync(f.file), original);
});

test('async/thenable guards and io reject synchronously without unhandled native rejection or getters', t => {
  const f = fixture(t);
  childProbe(f, `
    let getters = 0;
    assert.throws(() => createManagedRunFileContext({ ...options, assertWritable: () => ({ get then() { getters++; throw Error('getter'); } }) }), error => error.details.reason === 'ASYNC_GUARD_UNSUPPORTED');
    assert.throws(() => createManagedRunFileContext({ ...options, assertWritable: () => Promise.reject(Error('native rejected guard')) }), error => error.details.reason === 'ASYNC_GUARD_UNSUPPORTED');
    const promise = Promise.reject(Error('native own-then rejection')); Object.defineProperty(promise, 'then', { get() { getters++; throw Error('getter'); } });
    assert.throws(() => createManagedRunFileContext({ ...options, assertWritable: () => promise }), error => error.details.reason === 'ASYNC_GUARD_UNSUPPORTED');
    assert.throws(() => createManagedRunFileContext({ ...options, assertWritable: async () => true }), error => error.details.reason === 'INVALID_WRITABLE_GUARD');
    const context = createManagedRunFileContext({ ...options, io: { fsyncSync: () => Promise.reject(Error('native rejected fsync')) } });
    assert.throws(() => context.publish('manifest.json', Buffer.from('{}'), { expected: null }), error => error.details.reason === 'ASYNC_IO_UNSUPPORTED' && error.writeMayHaveCommitted === false);
    const badClose = createManagedRunFileContext({ ...options, io: { closeSync(fd) { fs.closeSync(fd); return { get then() { getters++; throw Error('getter'); } }; } } });
    assert.throws(() => badClose.publish('manifest.json', Buffer.from('{}'), { expected: null }), error => error.details.reason === 'ASYNC_IO_UNSUPPORTED');
    fs.writeFileSync(file, '{}');
    for (const phase of ['clock', 'sleep']) {
      const runtime = phase === 'clock' ? { now: () => Promise.reject(Error('native clock rejection')) }
        : { now: () => 0, sleep: () => Promise.reject(Error('native sleep rejection')) };
      const next = createManagedRunFileContext({ ...options, ...runtime, platform: 'win32', io: {
        renameSync() { throw Object.assign(Error('busy'), { code: 'EBUSY' }); } } });
      assert.throws(() => next.publish('manifest.json', Buffer.from('[]'), { expected: next.read('manifest.json') }),
        error => error.details.reason === 'ASYNC_RUNTIME_UNSUPPORTED' && error.writeMayHaveCommitted === false);
    }
    fs.unlinkSync(file);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(getters, 0); assert.equal(fs.existsSync(file), false);
  `);
});

test('cleanup preserves a replacement installed by its final guard', t => {
  const f = fixture(t); let temporary, cleanup = false, replaced = false;
  const context = createManagedRunFileContext({ ...f.options, assertWritable() {
    if (cleanup && !replaced) { replaced = true; fs.unlinkSync(temporary); fs.writeFileSync(temporary, 'keep replacement'); }
  }, io: {
    openSync(path, flags, ...args) { const fd = fs.openSync(path, flags, ...args); if (flags === 'wx') temporary = path; return fd; },
    linkSync() { cleanup = true; throw busy('EIO'); },
  } });
  assert.throws(() => context.publish('manifest.json', original, { expected: null }), rejected('FILESYSTEM_FAILURE'));
  assert.equal(replaced, true); assert.equal(fs.readFileSync(temporary, 'utf8'), 'keep replacement'); assert.equal(fs.existsSync(f.file), false);
});

test('real Windows non-share-delete reader releases and replacement retries successfully', { skip: process.platform !== 'win32', timeout: 15000 }, async t => {
  const f = fixture(t, { manifest: true }), release = join(f.directory, 'release-reader');
  const script = ["$ErrorActionPreference = 'Stop'", "$stream = [System.IO.File]::Open($env:MANAGED_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)",
    "try { [Console]::WriteLine('LOCKED'); while (-not [System.IO.File]::Exists($env:MANAGED_RELEASE)) { Start-Sleep -Milliseconds 5 }; Start-Sleep -Milliseconds 120 } finally { $stream.Dispose() }"].join('\n');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MANAGED_FILE: f.file, MANAGED_RELEASE: release },
  });
  let stdout = '', stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code)); });
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed.catch(() => {}); });
  await new Promise((resolve, reject) => { child.stdout.on('data', bytes => { stdout += bytes; if (stdout.includes('LOCKED')) resolve(); });
    child.once('error', reject); child.once('close', code => { if (!stdout.includes('LOCKED')) reject(Error(`Reader exited ${code}: ${stderr}`)); }); });
  let calls = 0;
  const context = createManagedRunFileContext({ ...f.options, io: { renameSync(source, target) {
    calls++; try { fs.renameSync(source, target); } catch (error) { if (!fs.existsSync(release)) fs.writeFileSync(release, 'release'); throw error; }
  } } });
  context.publish('manifest.json', updated, { expected: context.read('manifest.json') });
  assert.ok(calls > 1); assert.deepEqual(fs.readFileSync(f.file), updated); assert.equal(await closed, 0, stderr); assert.deepEqual(temporaryNames(f), []);
});
