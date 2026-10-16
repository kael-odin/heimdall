import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { readSpecCandidateSource } from '../src/acceptance/candidate-source.mjs';
import { projectSpecBaselineCandidate } from '../src/acceptance/candidate-projection.mjs';
import { AcceptanceCatalogError } from '../src/acceptance/catalog-schema.mjs';
import { createManagedSpecDispatchStore } from '../src/acceptance/managed-dispatch-store.mjs';
import { managedSpecDispatchPlanFingerprint, managedSpecDispatchRequestFingerprint } from '../src/acceptance/managed-dispatch-schema.mjs';
import { createManagedSpecDispatchReadContext, assertManagedSpecDispatchReadContext } from '../src/acceptance/managed-dispatch-reader.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const uuid = prefix => prefix + '-' + randomUUID();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const at = '2026-10-17T00:00:00.000Z';
const unavailable = reason => error => error instanceof AcceptanceCatalogError && error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
  && error.status === 503 && (!reason || error.details.reason === reason) && !/[A-Z]:\\|heimdall-dispatch-reader-|\/tmp\//.test(error.message);
const invalid = reason => error => error instanceof AcceptanceCatalogError && error.code === 'INVALID_INPUT'
  && error.status === 400 && (!reason || error.details.reason === reason);

// A real completed draft, pure candidate and accepted prepared envelope. Only
// the dispatch store writes preparation; the reader never substitutes an owner.
async function fixture(t, { publish = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-dispatch-reader-'))), owner = acquireAcceptanceOwner({ root });
  t.after(() => { owner.release(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = { id: uuid('ap'), name: '只读上下文', createdAt: at };
  const sourceRelease = { id: uuid('ar'), projectId: project.id, label: '规范来源', targetUrl: 'http://127.0.0.1:1/source', createdAt: at };
  const targetRelease = { id: uuid('ar'), projectId: project.id, label: '目标', targetUrl: 'http://127.0.0.1:2/target', createdAt: at };
  const sourcePlan = normalizeSpecPlan({ name: '需求', mode: 'spec', targetUrl: sourceRelease.targetUrl, timeoutMs: 1000,
    spec: { source: { id: 'reader-req', revision: '1', type: 'manual' }, approved: false,
      checks: [{ id: 'healthy', title: '健康', method: 'GET', path: '/healthy', severity: 'high',
        expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } }] } });
  const run = createAcceptanceRun(sourcePlan, { root });
  const raw = await runSpecAcceptance(sourcePlan, { runId: run.runId, outputDir: acceptanceRunDir(run.runId, root) });
  assert.equal(raw.safety.requests, 0); finishAcceptanceRun(run.runId, raw, { root });
  const source = readSpecCandidateSource(run.runId, { root, owner });
  const { projection } = projectSpecBaselineCandidate(source, { projectId: project.id, releaseId: sourceRelease.id, sourceSide: 'source' });
  const candidate = { id: uuid('ab'), ...projection, createdAt: at };
  const approval = { id: uuid('aa'), projectId: project.id, candidateId: candidate.id, contentDigest: candidate.contentDigest,
    reason: '已复核', approvedAt: at, actor: { kind: 'local-operator' } };
  const selection = { id: uuid('as'), projectId: project.id, mode: 'spec', approvalId: approval.id, previousSelectionId: null,
    reason: '已选用', selectedAt: at, actor: { kind: 'local-operator' } };
  const catalog = { generationId: uuid('ag'), revision: 8, headSha256: 'a'.repeat(64) };
  const request = { projectId: project.id, expectedGenerationId: catalog.generationId, expectedRevision: catalog.revision,
    selectionId: selection.id, contentDigest: candidate.contentDigest, targetReleaseId: targetRelease.id };
  const plan = normalizeSpecPlan({ ...sourcePlan, name: '托管计划', targetUrl: targetRelease.targetUrl, spec: { ...sourcePlan.spec, approved: true } });
  const envelope = { schemaVersion: 1, operationId: uuid('ao'), dispatchId: uuid('ad'), runId: uuid('ac'), taskId: uuid('a'), acceptedAt: at,
    request, requestFingerprint: managedSpecDispatchRequestFingerprint(request), catalog, project, selection, approval, candidate,
    sourceRelease, targetRelease, sourceSpecApproved: false, plan, planFingerprint: managedSpecDispatchPlanFingerprint(plan), executor: 'engine-owner-spec-v1' };
  const store = createManagedSpecDispatchStore({ root, owner }), directory = join(root, 'managed-spec-dispatches', 'v1');
  const record = publish ? store.publish(envelope) : null;
  return { root, owner, store, envelope, directory, parent: join(root, 'managed-spec-dispatches'),
    file: join(directory, envelope.operationId + '.json'), record, sourceRunId: run.runId };
}
const another = f => ({ ...copy(f.envelope), operationId: uuid('ao'), dispatchId: uuid('ad'), runId: uuid('ac'), taskId: uuid('a') });
const temporary = f => join(f.directory, uuid('ao') + '.' + randomUUID() + '.tmp');
function tree(root) {
  const walk = path => fs.readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? walk(child) : [[child.slice(root.length), sha(fs.readFileSync(child))]];
  });
  return walk(root).sort(([a], [b]) => a.localeCompare(b));
}
function childProbe(f, body) {
  const readerUrl = new URL('../src/acceptance/managed-dispatch-reader.mjs', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { createManagedSpecDispatchReadContext, assertManagedSpecDispatchReadContext } from ${JSON.stringify(readerUrl)};
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { root, directory, file, envelope } = input;
    ${body}
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], {
    input: JSON.stringify({ root: f.root, directory: f.directory, file: f.file, envelope: f.envelope }), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  return child.stdout;
}

test('real prepared dispatch is captured without owner, requests or filesystem writes', async t => {
  const f = await fixture(t); f.owner.release(); const before = tree(f.root), fetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = () => { requests++; throw Error('No reader network'); };
  try {
    const context = createManagedSpecDispatchReadContext({ root: f.root });
    assert.deepEqual(Object.keys(context), ['read', 'findByRunId', 'inventory', 'captureRecords', 'assertCurrent', 'reread']);
    assert.equal(Object.isFrozen(context), true); assert.equal(assertManagedSpecDispatchReadContext(context, f.root), true);
    assert.deepEqual(context.read(f.envelope.operationId), f.record);
    assert.deepEqual(context.findByRunId(f.envelope.runId), f.record);
    assert.deepEqual(context.reread(f.envelope.operationId, f.record.sha256), f.record);
    assert.deepEqual(context.inventory(), [{ operationId: f.envelope.operationId, dispatchId: f.envelope.dispatchId,
      runId: f.envelope.runId, taskId: f.envelope.taskId, sha256: f.record.sha256 }]);
    assert.deepEqual(context.captureRecords(), [f.record]);
    assert.equal(context.read(uuid('ao')), null); assert.equal(context.findByRunId(uuid('ac')), null);
    assert.equal(context.read(f.envelope.operationId).envelope.sourceSpecApproved, false);
    assert.equal(context.read(f.envelope.operationId).envelope.plan.spec.approved, true);
  } finally { globalThis.fetch = fetch; }
  assert.equal(requests, 0); assert.deepEqual(tree(f.root), before);
  assert.equal(fs.existsSync(join(f.root, '.acceptance-owner.json')), false);
});

test('empty namespace and a missing version directory remain physically absent', async t => {
  const f = await fixture(t, { publish: false }); f.owner.release(); const before = tree(f.root);
  const first = createManagedSpecDispatchReadContext({ root: f.root });
  assert.deepEqual(first.inventory(), []); assert.equal(first.read(f.envelope.operationId), null);
  assert.equal(first.findByRunId(f.envelope.runId), null); assert.deepEqual(tree(f.root), before);
  assert.equal(fs.existsSync(f.parent), false);
  fs.mkdirSync(f.parent);
  assert.throws(() => first.read(f.envelope.operationId), unavailable('DIRECTORY_CHANGED'));
  const partial = createManagedSpecDispatchReadContext({ root: f.root });
  assert.deepEqual(partial.inventory(), []); assert.deepEqual(fs.readdirSync(f.parent), []);
  fs.mkdirSync(f.directory);
  assert.throws(() => partial.assertCurrent(), unavailable('DIRECTORY_CHANGED'));
  const empty = createManagedSpecDispatchReadContext({ root: f.root });
  assert.deepEqual(empty.inventory(), []); assert.equal(empty.assertCurrent(), true);
});

test('unrelated root/ancestor entries do not invalidate the bound namespace', async t => {
  const f = await fixture(t), context = createManagedSpecDispatchReadContext({ root: f.root });
  fs.mkdirSync(join(f.root, uuid('ac'))); fs.writeFileSync(join(f.root, 'unrelated'), 'ordinary root activity');
  fs.mkdirSync(join(f.parent, 'v2'));
  assert.equal(context.assertCurrent(), true); assert.deepEqual(context.read(f.envelope.operationId), f.record);
});

test('returned bytes, envelopes and inventory cannot poison private cached facts', async t => {
  const f = await fixture(t), context = createManagedSpecDispatchReadContext({ root: f.root });
  for (const record of [context.read(f.envelope.operationId), context.findByRunId(f.envelope.runId), context.reread(f.envelope.operationId, f.record.sha256)]) {
    record.bytes.fill(0); record.envelope.runId = uuid('ac'); record.envelope.plan.targetUrl = 'http://127.0.0.1:3/poison'; record.sha256 = 'f'.repeat(64);
    assert.deepEqual(context.read(f.envelope.operationId), f.record);
  }
  const inventory = context.inventory(); assert.equal(Object.isFrozen(inventory), true); assert.equal(Object.isFrozen(inventory[0]), true);
  assert.throws(() => inventory.push({}), TypeError); assert.throws(() => { inventory[0].runId = uuid('ac'); }, TypeError);
  assert.deepEqual(context.findByRunId(f.envelope.runId), f.record);
  const batch = context.captureRecords();
  assert.equal(Object.isFrozen(batch), true);
  batch[0].bytes.fill(0); batch[0].envelope.runId = uuid('ac'); batch[0].sha256 = 'b'.repeat(64);
  assert.deepEqual(context.captureRecords(), [f.record]);
});

test('record batch performs one full namespace fence instead of one per record', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index++) f.store.publish(another(f));
  const output = childProbe(f, `
    const context = createManagedSpecDispatchReadContext({ root });
    const open = fs.opendirSync; let enumerations = 0;
    fs.opendirSync = (...args) => { if (args[0] === directory) enumerations++; return open(...args); };
    syncBuiltinESMExports();
    try {
      const records = context.captureRecords();
      assert.equal(records.length, 6); assert.equal(enumerations, 1);
      records[0].bytes.fill(0);
    } finally { fs.opendirSync = open; syncBuiltinESMExports(); }
    assert.equal(context.captureRecords().length, 6);
  `);
  assert.equal(output, '');
});

test('private brand rejects duck types, proxies and a different root without invoking getters', async t => {
  const f = await fixture(t), context = createManagedSpecDispatchReadContext({ root: f.root }); let getters = 0;
  const fake = { get assertCurrent() { getters++; throw Error('getter'); } };
  assert.throws(() => assertManagedSpecDispatchReadContext(fake, f.root), invalid('INVALID_READ_CONTEXT'));
  assert.throws(() => assertManagedSpecDispatchReadContext(new Proxy(context, { get() { getters++; throw Error('proxy'); } }), f.root), invalid('INVALID_READ_CONTEXT'));
  assert.throws(() => assertManagedSpecDispatchReadContext(context, join(f.root, 'other')), invalid('CONTEXT_ROOT_MISMATCH'));
  assert.throws(() => createManagedSpecDispatchReadContext({ get root() { getters++; return f.root; } }), invalid());
  assert.equal(getters, 0); assert.equal(context.assertCurrent(), true);
});

test('inputs and lowered budgets are strict and missing root is never created', async t => {
  const f = await fixture(t), missing = join(f.root, 'absent');
  for (const options of [undefined, {}, { root: '' }, { root: 'relative' }, { root: f.root, owner: {} },
    { root: f.root, limits: { dispatches: 1025 } }, { root: f.root, limits: { jsonBytes: -1 } }]) {
    assert.throws(() => createManagedSpecDispatchReadContext(options), invalid());
  }
  assert.throws(() => createManagedSpecDispatchReadContext({ root: missing }), unavailable('ROOT_UNAVAILABLE'));
  assert.equal(fs.existsSync(missing), false);
  const context = createManagedSpecDispatchReadContext({ root: f.root });
  for (const call of [() => context.read('../x'), () => context.findByRunId('x'), () => context.reread(f.envelope.operationId, 'x')]) assert.throws(call, invalid());
  assert.equal(context.assertCurrent(), true);
});

test('temporary bytes are bounded inventory material and never parsed or promoted', async t => {
  const f = await fixture(t), orphan = temporary(f); fs.writeFileSync(orphan, Buffer.from([0xff, 0, 0x7b]));
  const before = tree(f.root), context = createManagedSpecDispatchReadContext({ root: f.root });
  assert.equal(context.inventory().length, 1); assert.equal(context.read(orphan.split(/[\\/]/).at(-1).slice(0, 39)), null);
  assert.deepEqual(context.read(f.envelope.operationId), f.record); assert.deepEqual(tree(f.root), before);
  const total = f.record.bytes.length + 3;
  assert.equal(createManagedSpecDispatchReadContext({ root: f.root, limits: { totalBytes: total, directoryEntries: 2, dispatches: 1 } }).inventory().length, 1);
  for (const [limits, reason] of [[{ totalBytes: total - 1 }, 'TOTAL_BYTES_EXCEEDED'], [{ directoryEntries: 1 }, 'DIRECTORY_ENTRIES_EXCEEDED'],
    [{ dispatches: 0 }, 'DISPATCH_COUNT_EXCEEDED'], [{ jsonBytes: f.record.bytes.length - 1 }, 'FILE_BYTES_EXCEEDED']]) {
    assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root, limits }), unavailable(reason));
  }
  assert.equal(fs.readFileSync(orphan).length, 3);
});

test('malformed published JSON, UTF-8, unknown schema and filename mismatch cannot look empty', async t => {
  const f = await fixture(t), original = fs.readFileSync(f.file);
  for (const bytes of [Buffer.from('{'), Buffer.from([0xc3, 0x28]), Buffer.from(JSON.stringify({ ...f.envelope, schemaVersion: 2 }))]) {
    fs.writeFileSync(f.file, bytes);
    assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable('STORED_ENVELOPE_INVALID'));
    assert.deepEqual(fs.readFileSync(f.file), bytes);
  }
  fs.writeFileSync(f.file, JSON.stringify({ ...f.envelope, operationId: uuid('ao') }));
  assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable('STORED_OPERATION_MISMATCH'));
  fs.writeFileSync(f.file, original);
  assert.deepEqual(createManagedSpecDispatchReadContext({ root: f.root }).read(f.envelope.operationId), f.record);
});

test('unknown entries, directories and file/directory links fail closed without repair', async t => {
  const f = await fixture(t), unknown = join(f.directory, 'unexpected.json'); fs.writeFileSync(unknown, '{}');
  assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable('UNKNOWN_DIRECTORY_ENTRY'));
  assert.equal(fs.readFileSync(unknown, 'utf8'), '{}'); fs.unlinkSync(unknown);
  const nested = join(f.directory, uuid('ao') + '.json'); fs.mkdirSync(nested);
  assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable('FILE_IDENTITY_INVALID')); fs.rmdirSync(nested);
  const saved = join(f.root, 'saved-envelope.json');
  fs.renameSync(f.file, saved); fs.symlinkSync(saved, f.file);
  assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable('FILE_IDENTITY_INVALID'));
  fs.unlinkSync(f.file); fs.renameSync(saved, f.file);
  fs.renameSync(f.parent, f.parent + '.saved'); fs.symlinkSync(f.parent + '.saved', f.parent, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable('DIRECTORY_IDENTITY_INVALID'));
  assert.equal(fs.lstatSync(f.parent).isSymbolicLink(), true);
});

test('two accepted operations cannot reserve the same run or task', async t => {
  for (const field of ['runId', 'taskId']) {
    const f = await fixture(t), second = another(f); second[field] = f.envelope[field]; f.store.publish(second);
    const before = tree(f.root);
    assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root }), unavailable(field === 'runId' ? 'RESERVED_RUN_CONFLICT' : 'RESERVED_TASK_CONFLICT'));
    assert.deepEqual(tree(f.root), before);
  }
});

test('several unique operations have stable sorted references and exact count/byte limits', async t => {
  const f = await fixture(t), second = another(f), other = f.store.publish(second);
  const limits = { dispatches: 2, directoryEntries: 2, totalBytes: f.record.bytes.length + other.bytes.length };
  const context = createManagedSpecDispatchReadContext({ root: f.root, limits });
  assert.deepEqual(context.inventory().map(item => item.operationId), [f.envelope.operationId, second.operationId].sort());
  assert.deepEqual(context.findByRunId(second.runId), other);
  assert.throws(() => createManagedSpecDispatchReadContext({ root: f.root, limits: { dispatches: 1 } }), unavailable('DISPATCH_COUNT_EXCEEDED'));
});

test('namespace additions, removals, same-byte replacement and in-place edits invalidate cached negatives', async t => {
  for (const mutation of ['add', 'remove', 'replace', 'rewrite', 'temporary']) {
    const f = await fixture(t), orphan = temporary(f); if (mutation === 'temporary') fs.writeFileSync(orphan, '{}');
    const context = createManagedSpecDispatchReadContext({ root: f.root }), missing = uuid('ao'); assert.equal(context.read(missing), null);
    if (mutation === 'add') f.store.publish(another(f));
    if (mutation === 'remove') fs.unlinkSync(f.file);
    if (mutation === 'replace') { fs.renameSync(f.file, f.file + '.saved'); fs.writeFileSync(f.file, f.record.bytes); }
    if (mutation === 'rewrite') { const bytes = Buffer.from(f.record.bytes); bytes[0] = 32; fs.writeFileSync(f.file, bytes); }
    if (mutation === 'temporary') fs.writeFileSync(orphan, '[]');
    assert.throws(() => context.read(missing), unavailable(), mutation);
    for (const call of [() => context.assertCurrent(), () => context.inventory(), () => context.findByRunId(uuid('ac')),
      () => context.reread(f.envelope.operationId, f.record.sha256)]) assert.throws(call, unavailable(), mutation);
  }
});

test('root, partial ancestor and version directory replacement invalidates a context permanently', async t => {
  for (const component of ['root', 'parent', 'directory']) {
    const f = await fixture(t, { publish: component !== 'parent' }); f.owner.release();
    if (component === 'parent') fs.mkdirSync(f.parent);
    const context = createManagedSpecDispatchReadContext({ root: f.root }), path = f[component];
    fs.renameSync(path, path + '.saved'); fs.mkdirSync(path);
    assert.throws(() => context.assertCurrent(), unavailable(component === 'root' ? 'ROOT_CHANGED' : 'DIRECTORY_CHANGED'));
    fs.rmdirSync(path); fs.renameSync(path + '.saved', path);
    assert.equal(createManagedSpecDispatchReadContext({ root: f.root }).assertCurrent(), true);
    assert.throws(() => context.assertCurrent(), unavailable());
  }
});

test('reread requires the captured operation and exact original SHA instead of adopting new facts', async t => {
  const f = await fixture(t), context = createManagedSpecDispatchReadContext({ root: f.root });
  assert.throws(() => context.reread(f.envelope.operationId, '0'.repeat(64)), unavailable('DISPATCH_DIGEST_MISMATCH'));
  assert.throws(() => context.assertCurrent(), unavailable('DISPATCH_DIGEST_MISMATCH'));
  const fresh = createManagedSpecDispatchReadContext({ root: f.root });
  assert.throws(() => fresh.reread(uuid('ao'), f.record.sha256), unavailable('DISPATCH_MISSING'));
});

test('later freshness uses read descriptors and one bounded name inventory without adopting new facts', async t => {
  const f = await fixture(t); f.owner.release(); const before = tree(f.root);
  const output = childProbe(f, `
    const original = { open: fs.openSync, close: fs.closeSync, read: fs.readSync, opendir: fs.opendirSync };
    let inventories = 0, reads = 0; const active = new Set();
    fs.openSync = (path, flags, ...args) => {
      assert.equal(typeof flags, 'number'); assert.equal(flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR), 0);
      const fd = original.open(path, flags, ...args); active.add(fd); return fd;
    };
    fs.closeSync = fd => { original.close(fd); active.delete(fd); };
    fs.readSync = (...args) => { reads++; return original.read(...args); };
    fs.opendirSync = (...args) => { inventories++; return original.opendir(...args); };
    for (const name of ['mkdirSync', 'writeSync', 'writeFileSync', 'unlinkSync', 'linkSync', 'renameSync']) fs[name] = () => { throw Error('Unexpected mutation ' + name); };
    syncBuiltinESMExports();
    const context = createManagedSpecDispatchReadContext({ root });
    const constructionReads = reads, constructionInventories = inventories;
    assert.ok(constructionReads > 0); assert.ok(constructionInventories > 0); assert.equal(active.size, 0);
    const beforeFence = inventories; context.assertCurrent(); assert.equal(inventories, beforeFence + 1);
    for (let i = 0; i < 3; i++) { context.read(envelope.operationId); context.findByRunId(envelope.runId); context.inventory(); context.assertCurrent(); }
    assertManagedSpecDispatchReadContext(context, root);
    const laterReads = reads; assert.ok(laterReads > constructionReads); assert.ok(inventories > constructionInventories); assert.equal(active.size, 0);
    const expectedSha256 = context.inventory()[0].sha256, beforeReread = reads;
    context.reread(envelope.operationId, expectedSha256);
    assert.ok(reads > beforeReread); assert.equal(active.size, 0);
    console.log(JSON.stringify({ inventories, constructionInventories, constructionReads, laterReads: laterReads - constructionReads,
      rereadReads: reads - beforeReread, active: active.size }));
  `);
  assert.match(output, /"constructionInventories":/); assert.deepEqual(tree(f.root), before);
});

test('new namespace names are rejected even when directory metadata is unchanged', async t => {
  for (const mutation of ['published', 'temporary', 'unknown', 'remove']) {
    const f = await fixture(t); f.owner.release();
    const changedFile = childProbe(f, `
      const originalLstat = fs.lstatSync, originalOpendir = fs.opendirSync;
      const pinned = originalLstat(directory, { bigint: true }); let activeDirectories = 0;
      fs.lstatSync = (path, ...args) => path === directory ? pinned : originalLstat(path, ...args);
      fs.opendirSync = (...args) => {
        const handle = originalOpendir(...args); activeDirectories++;
        return { readSync: () => handle.readSync(), closeSync() { handle.closeSync(); activeDirectories--; } };
      };
      syncBuiltinESMExports();
      const context = createManagedSpecDispatchReadContext({ root });
      const mutation = ${JSON.stringify(mutation)};
      const changed = mutation === 'remove' ? file : file.replace(/ao-[^\\\\/]+$/, mutation === 'unknown' ? 'unexpected.json'
        : 'ao-11111111-1111-1111-1111-111111111111' + (mutation === 'temporary' ? '.22222222-2222-2222-2222-222222222222.tmp' : '.json'));
      if (mutation === 'remove') fs.unlinkSync(file); else fs.writeFileSync(changed, mutation === 'published' ? fs.readFileSync(file) : '{}');
      const reject = error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE' && error.details.reason === 'DIRECTORY_CHANGED';
      assert.throws(() => context.findByRunId('ac-33333333-3333-3333-3333-333333333333'), reject);
      assert.equal(activeDirectories, 0);
      if (mutation === 'remove') fs.writeFileSync(file, JSON.stringify(envelope)); else fs.unlinkSync(changed);
      assert.throws(() => context.inventory(), reject); assert.equal(activeDirectories, 0);
      console.log(changed);
    `).trim();
    assert.equal(fs.existsSync(changedFile), mutation === 'remove');
  }
});

test('published same-length rewrite invalidates freshness even when file timestamps are unchanged', async t => {
  const f = await fixture(t); f.owner.release();
  childProbe(f, `
    const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
    const pinned = originalLstat(file, { bigint: true });
    fs.lstatSync = (path, ...args) => path === file ? pinned : originalLstat(path, ...args);
    fs.fstatSync = (fd, ...args) => {
      const actual = originalFstat(fd, ...args);
      return actual.dev === pinned.dev && actual.ino === pinned.ino ? pinned : actual;
    };
    syncBuiltinESMExports();
    const context = createManagedSpecDispatchReadContext({ root });
    const original = fs.readFileSync(file), modified = Buffer.from(original); modified[0] = 32;
    fs.writeFileSync(file, modified);
    assert.equal(original.length, modified.length); assert.notDeepEqual(original, modified);
    assert.throws(() => context.assertCurrent(), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILE_CHANGED');
    assert.throws(() => context.read(envelope.operationId), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILE_CHANGED');
    assert.deepEqual(fs.readFileSync(file), modified);
  `);
  const modified = Buffer.from(f.record.bytes); modified[0] = 32;
  assert.deepEqual(fs.readFileSync(f.file), modified);
});

test('post-lstat realpath ENOENT for root, ancestors and records is unavailable, never absence', async t => {
  const f = await fixture(t); f.owner.release();
  for (const part of ['root', 'parent', 'directory', 'file']) childProbe(f, `
    const target = ${JSON.stringify(part)} === 'parent' ? directory.replace(/[\\\\/]v1$/, '') : input[${JSON.stringify(part)}];
    const originalLstat = fs.lstatSync, originalRealpath = fs.realpathSync; let observed = 0, resolved = 0;
    fs.lstatSync = (path, ...args) => { const stat = originalLstat(path, ...args); if (path === target) observed++; return stat; };
    fs.realpathSync = (path, ...args) => { if (path === target) { resolved++; throw Object.assign(Error('secret filesystem path'), { code: 'ENOENT' }); } return originalRealpath(path, ...args); };
    syncBuiltinESMExports();
    assert.throws(() => createManagedSpecDispatchReadContext({ root }), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILESYSTEM_FAILURE' && !error.message.includes('secret'));
    assert.ok(observed > 0); assert.equal(resolved, 1);
  `);
});

test('short reads finish exactly; descriptor read failure closes every handle and preserves files', async t => {
  const f = await fixture(t); f.owner.release(); const before = tree(f.root);
  childProbe(f, `
    const originalRead = fs.readSync;
    fs.readSync = (fd, bytes, offset, length, position) => originalRead(fd, bytes, offset, Math.min(length, 19), position);
    syncBuiltinESMExports();
    assert.deepEqual(createManagedSpecDispatchReadContext({ root }).read(envelope.operationId).envelope, envelope);
  `);
  childProbe(f, `
    const originalOpen = fs.openSync, originalClose = fs.closeSync; const active = new Set();
    fs.openSync = (...args) => { const fd = originalOpen(...args); active.add(fd); return fd; };
    fs.closeSync = fd => { originalClose(fd); active.delete(fd); };
    fs.readSync = () => { throw Object.assign(Error('secret read failure'), { code: 'EIO' }); };
    syncBuiltinESMExports();
    assert.throws(() => createManagedSpecDispatchReadContext({ root }), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILESYSTEM_FAILURE' && !error.message.includes('secret'));
    assert.equal(active.size, 0);
  `);
  assert.deepEqual(tree(f.root), before);
});

test('same-length record mutation during capture is rejected instead of returning mixed material', async t => {
  const f = await fixture(t); f.owner.release();
  childProbe(f, `
    const originalOpen = fs.openSync, originalClose = fs.closeSync; let targetFd, mutated = false;
    fs.openSync = (path, ...args) => { const fd = originalOpen(path, ...args); if (path === file) targetFd = fd; return fd; };
    fs.closeSync = fd => {
      originalClose(fd);
      if (fd === targetFd && !mutated) { mutated = true; const bytes = fs.readFileSync(file); bytes[0] = 32; fs.writeFileSync(file, bytes); }
    };
    syncBuiltinESMExports();
    assert.throws(() => createManagedSpecDispatchReadContext({ root }), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILE_CHANGED');
    assert.equal(mutated, true);
  `);
  assert.equal(fs.existsSync(f.file), true);
});

test('independent second-read corruption fails byte comparison with unchanged filesystem metadata', async t => {
  const f = await fixture(t); f.owner.release(); const before = tree(f.root);
  childProbe(f, `
    const originalRead = fs.readSync; const length = fs.statSync(file).size; let bodyReads = 0;
    fs.readSync = (fd, bytes, offset, count, position) => {
      const read = originalRead(fd, bytes, offset, count, position);
      if (count === length && position === 0 && ++bodyReads === 2) bytes[0] = 32;
      return read;
    };
    syncBuiltinESMExports();
    assert.throws(() => createManagedSpecDispatchReadContext({ root }), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILE_CHANGED');
    assert.equal(bodyReads, 2);
  `);
  assert.deepEqual(tree(f.root), before);
});

test('growth before descriptor capture is refused before any body read and closes the descriptor', async t => {
  const f = await fixture(t); f.owner.release();
  childProbe(f, `
    const originalOpen = fs.openSync, originalClose = fs.closeSync, originalRead = fs.readSync;
    const active = new Set(); let mutated = false, reads = 0;
    fs.openSync = (path, ...args) => {
      if (path === file && !mutated) { mutated = true; fs.appendFileSync(file, ' '.repeat(8192)); }
      const fd = originalOpen(path, ...args); active.add(fd); return fd;
    };
    fs.closeSync = fd => { originalClose(fd); active.delete(fd); };
    fs.readSync = (...args) => { reads++; return originalRead(...args); };
    syncBuiltinESMExports();
    assert.throws(() => createManagedSpecDispatchReadContext({ root }), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILE_CHANGED');
    assert.equal(mutated, true); assert.equal(reads, 0); assert.equal(active.size, 0);
  `);
  assert.equal(fs.statSync(f.file).size, f.record.bytes.length + 8192);
});

test('directory enumeration failure closes its handle and cannot yield an empty inventory', async t => {
  const f = await fixture(t); f.owner.release(); const before = tree(f.root);
  childProbe(f, `
    const originalOpendir = fs.opendirSync; let closed = false;
    fs.opendirSync = (...args) => {
      const handle = originalOpendir(...args);
      return { readSync() { throw Object.assign(Error('secret directory failure'), { code: 'EIO' }); },
        closeSync() { handle.closeSync(); closed = true; } };
    };
    syncBuiltinESMExports();
    assert.throws(() => createManagedSpecDispatchReadContext({ root }), error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILESYSTEM_FAILURE' && !error.message.includes('secret'));
    assert.equal(closed, true);
  `);
  childProbe(f, `
    const originalOpendir = fs.opendirSync; let armed = false, closed = 0;
    fs.opendirSync = (...args) => {
      const handle = originalOpendir(...args);
      return { readSync() { if (armed) throw Object.assign(Error('secret freshness failure'), { code: 'EIO' }); return handle.readSync(); },
        closeSync() { handle.closeSync(); closed++; } };
    };
    syncBuiltinESMExports();
    const context = createManagedSpecDispatchReadContext({ root }), before = closed; armed = true;
    const reject = error => error.code === 'MANAGED_DISPATCH_UNAVAILABLE'
      && error.details.reason === 'FILESYSTEM_FAILURE' && !error.message.includes('secret');
    assert.throws(() => context.inventory(), reject); assert.equal(closed, before + 1);
    armed = false; assert.throws(() => context.assertCurrent(), reject); assert.equal(closed, before + 1);
  `);
  assert.deepEqual(tree(f.root), before);
});
