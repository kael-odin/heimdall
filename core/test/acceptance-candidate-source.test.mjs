import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, cpSync,
  renameSync, symlinkSync, unlinkSync, realpathSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readSpecCandidateSource, SPEC_CANDIDATE_SOURCE_LIMITS } from '../src/acceptance/candidate-source.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { createAcceptanceRun, acceptanceRunDir, finishAcceptanceRun, readAcceptanceSnapshot } from '../src/acceptance/store.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { previewOpenApi } from '../src/acceptance/openapi.mjs';

const archiveRoot = fileURLToPath(new URL('../../docs/audits/2026-10-16/evidence/acceptance-catalog/console/run-evidence/', import.meta.url));
const legacyRoot = fileURLToPath(new URL('../../docs/audits/2026-10-16/evidence/acceptance-spec/console/run-evidence/', import.meta.url));
const archivedRuns = ['ac-2424d160-cf8e-4991-8fba-c972a84becd1', 'ac-4a58013b-af7f-498a-a9bb-258c81bd9b6d',
  'ac-5494a1d9-c1bc-4b1c-ad1b-144f8591f743'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const facade = (root, check = () => {}) => ({ root: realpathSync(root), assertOwned: check });
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const safeError = (code = 'SOURCE_INTEGRITY_FAILED', reason) => error => {
  assert.equal(error.code, code);
  assert.equal(error.status, code === 'INVALID_INPUT' ? 400 : code === 'NOT_FOUND' ? 404 : code.startsWith('ACCEPTANCE_OWNER_') ? 503 : 409);
  assert.match(error.details.reason, /^[A-Z0-9_]{1,80}$/);
  if (reason) assert.equal(error.details.reason, reason);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.equal(error.message.includes(tmpdir()), false);
  assert.equal(JSON.stringify(error).includes('heimdall-source-'), false);
  return true;
};

function temporary(t) {
  const parent = mkdtempSync(join(tmpdir(), 'heimdall-source-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return parent;
}
function fixture(t, runId = archivedRuns[0]) {
  const parent = temporary(t), root = join(parent, 'acceptance');
  mkdirSync(root);
  const dir = join(root, runId);
  cpSync(join(archiveRoot, runId), dir, { recursive: true });
  return { parent, root, dir, runId, owner: facade(root) };
}
const read = (fixture, overrides = {}) => readSpecCandidateSource(fixture.runId, { root: fixture.root, owner: fixture.owner, ...overrides });
function treeBytes(root) {
  const result = {};
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path, name + '/');
      else result[name] = sha256(readFileSync(path));
    }
  }
  visit(root); return result;
}
function editReport(fixture, edit) {
  const path = join(fixture.dir, 'report.json'), report = parse(path);
  edit(report); json(path, report);
  const manifestPath = join(fixture.dir, 'manifest.json'), manifest = parse(manifestPath);
  manifest.reportSha256 = sha256(readFileSync(path)); json(manifestPath, manifest);
}
function replaceByte(path) {
  const bytes = readFileSync(path); bytes[bytes.length - 1] ^= 1; writeFileSync(path, bytes);
}

test('archived passed and failed Spec sources capture every original referenced byte without writing or networking', () => {
  const before = treeBytes(archiveRoot), owner = facade(archiveRoot), originalFetch = globalThis.fetch;
  let network = 0;
  globalThis.fetch = () => { network++; throw new Error('source reader must not request targets'); };
  try {
    for (const [index, runId] of archivedRuns.entries()) {
      const { snapshot, files } = readSpecCandidateSource(runId, { root: archiveRoot, owner });
      assert.equal(snapshot.integrity.valid, true);
      assert.equal(snapshot.integrity.evidenceVerified, true);
      assert.deepEqual(snapshot, readAcceptanceSnapshot(runId, { root: archiveRoot }));
      assert.equal(snapshot.report.gate, index === 2 ? 'failed' : 'passed');
      assert.equal(files.size, 5);
      assert.deepEqual([...files.keys()], ['manifest.json', 'report.json', 'spec-1-QUOTA-contract.json', 'spec-1-QUOTA-request.json', 'spec-1-QUOTA-response.json']);
      for (const [name, bytes] of files) {
        assert.equal(Buffer.isBuffer(bytes), true);
        assert.deepEqual(bytes, readFileSync(join(archiveRoot, runId, name)));
      }
      assert.equal(sha256(files.get('report.json')), snapshot.integrity.reportSha256);
      assert.deepEqual(JSON.parse(files.get('manifest.json')), snapshot.manifest);
      assert.deepEqual(JSON.parse(files.get('report.json')), snapshot.report);
      assert.equal(Object.hasOwn(snapshot, 'files'), false);
      assert.equal(Object.hasOwn(snapshot, 'bytes'), false);
      assert.equal(JSON.stringify(snapshot).includes('"type":"Buffer"'), false);
      assert.equal(files.has('report.md'), false);
    }
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(network, 0);
  assert.deepEqual(treeBytes(archiveRoot), before);
});

test('already acquired real owner is used without changing any run or lock bytes', t => {
  const item = fixture(t), owner = acquireAcceptanceOwner({ root: item.root });
  t.after(() => owner.release());
  const before = treeBytes(item.root);
  assert.equal(read(item, { owner }).files.size, 5);
  assert.deepEqual(treeBytes(item.root), before);
  assert.equal(owner.assertOwned(), true);
});

test('unapproved OpenAPI run captures the source document and contract without requesting a target', async t => {
  const root = temporary(t), originalFetch = globalThis.fetch;
  const document = { openapi: '3.1.1', info: { title: 'Private source', version: 'v1' }, paths: {
    '/quota': { get: { responses: { 200: { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } } } } },
  } };
  const { plan } = previewOpenApi(document, { targetUrl: 'http://127.0.0.1:1/no-network?tenant=private' });
  let network = 0;
  globalThis.fetch = () => { network++; throw new Error('unapproved candidate must not request a target'); };
  try {
    const manifest = createAcceptanceRun(plan, { root });
    const raw = await runSpecAcceptance(plan, { runId: manifest.runId, outputDir: acceptanceRunDir(manifest.runId, root) });
    finishAcceptanceRun(manifest.runId, raw, { root });
    const before = treeBytes(root);
    const { snapshot, files } = readSpecCandidateSource(manifest.runId, { root, owner: facade(root) });
    assert.equal(snapshot.report.gate, 'blocked');
    assert.equal(snapshot.manifest.plan.spec.approved, false);
    assert.equal(files.size, 4);
    assert.deepEqual(JSON.parse(files.get('requirement-source.json')).document, document);
    assert.equal(files.has(snapshot.report.checks[0].evidence.contract), true);
    assert.equal(Object.hasOwn(snapshot.report.checks[0].evidence, 'response'), false);
    assert.deepEqual(treeBytes(root), before);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(network, 0);
});

test('raw PNG and non-object JSON references are preserved as bytes under evidence budgets', t => {
  const item = fixture(t);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 255, 0]);
  const raw = Buffer.from('null\n');
  writeFileSync(join(item.dir, 'raw-capture.png'), png);
  writeFileSync(join(item.dir, 'raw-null.json'), raw);
  editReport(item, report => {
    report.checks[0].evidence.capture = 'raw-capture.png';
    report.checks[0].evidence.raw = 'raw-null.json';
    report.evidenceManifest.push(...[['raw-capture.png', png], ['raw-null.json', raw]].map(([file, bytes]) => ({ file, bytes: bytes.length, sha256: sha256(bytes) })));
  });
  const { files } = read(item);
  assert.equal(files.size, 7);
  assert.deepEqual(files.get('raw-capture.png'), png);
  assert.deepEqual(files.get('raw-null.json'), raw);
});

test('evidence is bounded separately from head JSON and exact byte/count budgets are accepted', t => {
  const item = fixture(t), response = 'spec-1-QUOTA-response.json';
  const bytes = Buffer.alloc(32 * 1024, 255);
  writeFileSync(join(item.dir, response), bytes);
  editReport(item, report => {
    const entry = report.evidenceManifest.find(entry => entry.file === response);
    Object.assign(entry, { bytes: bytes.length, sha256: sha256(bytes) });
  });
  const headBytes = Math.max(...['manifest.json', 'report.json'].map(file => readFileSync(join(item.dir, file)).length));
  assert.ok(headBytes < bytes.length);
  const report = parse(join(item.dir, 'report.json'));
  const limits = { jsonBytes: headBytes, evidenceFiles: report.evidenceManifest.length,
    evidenceFileBytes: bytes.length, evidenceBytes: report.evidenceManifest.reduce((sum, entry) => sum + entry.bytes, 0), checks: 1 };
  assert.deepEqual(read(item, { limits }).files.get(response), bytes);
  for (const key of Object.keys(limits)) assert.throws(() => read(item, { limits: { ...limits, [key]: limits[key] - 1 } }), safeError());
});

test('contract/source role semantics remain the projector responsibility', t => {
  const item = fixture(t);
  editReport(item, report => { report.checks[0].evidence = {}; report.evidenceManifest = []; });
  const result = read(item);
  assert.equal(result.snapshot.integrity.valid, true);
  assert.deepEqual([...result.files.keys()], ['manifest.json', 'report.json']);
});

test('legacy archived reports without report digests remain rejected and unchanged', () => {
  const before = treeBytes(legacyRoot), owner = facade(legacyRoot);
  for (const runId of ['ac-5210041a-cc04-48e8-b02b-702fddd5c8a8', 'ac-7b5a7528-617c-4032-b887-4e9d546fab66']) {
    assert.throws(() => readSpecCandidateSource(runId, { root: legacyRoot, owner }), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_SNAPSHOT_INVALID'));
  }
  assert.deepEqual(treeBytes(legacyRoot), before);
});

test('every referenced role rejects same-length corruption and missing files', async t => {
  for (const role of ['contract', 'request', 'response']) for (const mutation of ['corrupt', 'missing']) {
    await t.test(`${role}: ${mutation}`, t => {
      const item = fixture(t), name = parse(join(item.dir, 'report.json')).checks[0].evidence[role], path = join(item.dir, name);
      if (mutation === 'corrupt') replaceByte(path); else unlinkSync(path);
      assert.throws(() => read(item), safeError());
    });
  }
});

test('changed report, missing digest, mismatched run identity and non-Spec mode reject safely', async t => {
  for (const mutation of ['report-bytes', 'missing-digest', 'identity', 'mode']) await t.test(mutation, t => {
    const item = fixture(t), path = join(item.dir, 'manifest.json'), manifest = parse(path);
    if (mutation === 'report-bytes') { replaceByte(join(item.dir, 'report.json')); }
    else {
      if (mutation === 'missing-digest') delete manifest.reportSha256;
      if (mutation === 'identity') manifest.runId = archivedRuns[1];
      if (mutation === 'mode') manifest.mode = 'mirror';
      json(path, manifest);
    }
    assert.throws(() => read(item), safeError(mutation === 'mode' ? 'SOURCE_NOT_ELIGIBLE' : 'SOURCE_INTEGRITY_FAILED'));
  });
});

test('completed state, report/plan digests, targets and summaries match the existing snapshot contract', async t => {
  for (const mutation of ['manifest-status', 'report-status', 'plan', 'target', 'baseline', 'report-summary', 'manifest-summary', 'report-gate', 'manifest-gate']) {
    await t.test(mutation, t => {
      const item = fixture(t);
      if (mutation.startsWith('report-')) editReport(item, report => {
        if (mutation === 'report-status') report.status = 'running';
        if (mutation === 'report-summary') report.summary.total++;
        if (mutation === 'report-gate') report.gate = 'blocked';
      });
      else {
        const path = join(item.dir, 'manifest.json'), manifest = parse(path);
        if (mutation === 'manifest-status') manifest.status = 'running';
        if (mutation === 'plan') manifest.plan.name = 'Altered plan';
        if (mutation === 'target') manifest.targetUrl += '&changed=true';
        if (mutation === 'baseline') manifest.baselineUrl = 'http://127.0.0.1:1/';
        if (mutation === 'manifest-summary') manifest.summary.total++;
        if (mutation === 'manifest-gate') manifest.gate = 'blocked';
        json(path, manifest);
      }
      assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_SNAPSHOT_INVALID'));
    });
  }
});

test('malformed, duplicated, unindexed, traversal and reserved evidence entries reject', async t => {
  for (const mutation of ['duplicate', 'unindexed', 'traversal', 'reserved', 'array-evidence']) await t.test(mutation, t => {
    const item = fixture(t);
    editReport(item, report => {
      if (mutation === 'duplicate') report.evidenceManifest.push(report.evidenceManifest[0]);
      if (mutation === 'unindexed') report.evidenceManifest.pop();
      if (mutation === 'traversal') report.checks[0].evidence.request = '../request.json';
      if (mutation === 'reserved') report.evidenceManifest[0].file = 'manifest.json';
      if (mutation === 'array-evidence') report.checks[0].evidence = [];
    });
    assert.throws(() => read(item), safeError());
  });
});

test('run directory links and evidence/head links are rejected including links inside the same run', async t => {
  await t.test('run junction', t => {
    const item = fixture(t), moved = join(item.parent, 'moved-run');
    renameSync(item.dir, moved);
    symlinkSync(moved, item.dir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_RUN_PATH_INVALID'));
  });
  for (const name of ['manifest.json', 'report.json', 'spec-1-QUOTA-contract.json', 'spec-1-QUOTA-request.json', 'spec-1-QUOTA-response.json']) {
    await t.test(name, t => {
      const item = fixture(t), path = join(item.dir, name), moved = join(item.dir, 'linked-target.json');
      renameSync(path, moved);
      try { symlinkSync(moved, path, 'file'); }
      catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlink permission unavailable'); throw error; }
      assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_PATH_INVALID'));
    });
  }
});

test('canonical owner accepts a root alias and rejects that alias after retargeting', t => {
  const item = fixture(t), alias = join(item.parent, 'alias'), other = join(item.parent, 'other');
  mkdirSync(other);
  symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(read(item, { root: alias }).files.size, 5);
  unlinkSync(alias); symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => read(item, { root: alias }), safeError('ACCEPTANCE_OWNER_LOST'));
});

test('owner root identity remains pinned between calls even if the same pathname is recreated', t => {
  const item = fixture(t), moved = join(item.parent, 'old-acceptance');
  read(item);
  renameSync(item.root, moved);
  cpSync(moved, item.root, { recursive: true });
  assert.notEqual(lstatSync(item.root, { bigint: true }).ino, lstatSync(moved, { bigint: true }).ino);
  assert.throws(() => read(item), safeError('ACCEPTANCE_OWNER_LOST', 'SOURCE_ROOT_CHANGED'));
});

test('owner/root/run fences reject replacement while reading', async t => {
  for (const mutation of ['owner', 'root', 'run', 'alias']) await t.test(mutation, t => {
    const item = fixture(t), alias = join(item.parent, 'alias');
    if (mutation === 'alias') symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    let calls = 0;
    item.owner = facade(item.root, () => {
      if (++calls !== 5) return;
      if (mutation === 'owner') throw new Error(`private owner failure ${item.root}`);
      if (mutation === 'root') {
        const moved = join(item.parent, 'old-root'); renameSync(item.root, moved); cpSync(moved, item.root, { recursive: true });
      }
      if (mutation === 'run') {
        const moved = join(item.parent, 'old-run'); renameSync(item.dir, moved); cpSync(moved, item.dir, { recursive: true });
      }
      if (mutation === 'alias') {
        const other = join(item.parent, 'other'); mkdirSync(other); unlinkSync(alias);
        symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
      }
    });
    assert.throws(() => read(item, { root: mutation === 'alias' ? alias : item.root }), safeError(mutation === 'run' ? 'SOURCE_INTEGRITY_FAILED' : 'ACCEPTANCE_OWNER_LOST'));
    assert.ok(calls >= 5);
  });
});

test('re-reading and final metadata checks reject head/evidence changes at every late owner checkpoint', async t => {
  let checkpoints = 0;
  const baseline = fixture(t);
  read(baseline, { owner: facade(baseline.root, () => checkpoints++) });
  assert.ok(checkpoints > 15);
  for (const name of ['manifest.json', 'report.json', 'spec-1-QUOTA-request.json', 'spec-1-QUOTA-response.json']) {
    for (const checkpoint of [12, checkpoints - 1, checkpoints]) await t.test(`${name} at checkpoint ${checkpoint}`, t => {
      const item = fixture(t); let calls = 0;
      const owner = facade(item.root, () => { if (++calls === checkpoint) replaceByte(join(item.dir, name)); });
      assert.throws(() => read(item, { owner }), safeError());
      assert.ok(calls >= checkpoint);
    });
  }
});

test('missing roots/runs, unavailable owners and mismatched canonical roots never expose filesystem errors', t => {
  const item = fixture(t);
  assert.throws(() => read(item, { owner: undefined }), safeError('ACCEPTANCE_OWNER_UNAVAILABLE'));
  assert.throws(() => readSpecCandidateSource(archivedRuns[1], { root: item.root, owner: item.owner }), safeError('NOT_FOUND'));
  assert.throws(() => read(item, { root: join(item.parent, 'missing') }), safeError());
  assert.throws(() => read(item, { owner: facade(item.parent) }), safeError('ACCEPTANCE_OWNER_LOST'));
  assert.throws(() => read(item, { owner: facade(item.root, () => { throw new Error('secret owner error'); }) }), safeError('ACCEPTANCE_OWNER_LOST', 'OWNER_LOST'));
});

test('invalid input, getters, proxies, unknown fields and loosened limits are rejected without invoking accessors', t => {
  const item = fixture(t);
  for (const runId of [null, {}, '../manifest.json', item.runId.toUpperCase()]) assert.throws(() => readSpecCandidateSource(runId, { root: item.root, owner: item.owner }), safeError('INVALID_INPUT'));
  let invoked = 0;
  for (const options of [null, [], new Proxy({}, { get() { invoked++; } }), { unknown: true },
    { get root() { invoked++; return item.root; } }, Object.defineProperty({}, 'owner', { value: item.owner })]) {
    assert.throws(() => readSpecCandidateSource(item.runId, options), safeError('INVALID_INPUT'));
  }
  for (const limits of [null, [], { unknown: 1 }, { jsonBytes: -1 }, { checks: 1.5 },
    { checks: SPEC_CANDIDATE_SOURCE_LIMITS.checks + 1 }, { get checks() { invoked++; return 1; } },
    { [Symbol('hidden')]: 1 }, new Proxy({}, { get() { invoked++; } })]) assert.throws(() => read(item, { limits }), safeError('INVALID_INPUT'));
  for (const owner of [[], new Proxy({}, { get() { invoked++; } }), { root: resolve(item.root) },
    { get root() { invoked++; return item.root; }, assertOwned() {} }, Object.create(item.owner)]) {
    assert.throws(() => read(item, { owner }), safeError('ACCEPTANCE_OWNER_UNAVAILABLE'));
  }
  assert.equal(invoked, 0);
  assert.throws(() => read(item, { limits: { jsonBytes: 0 } }), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_BUDGET_EXCEEDED'));
});
