import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readBrowserCandidateSource, BROWSER_CANDIDATE_SOURCE_LIMITS } from '../src/acceptance/browser-candidate-source.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { AcceptanceCatalogError } from '../src/acceptance/catalog-schema.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { required } from './fixtures/audit-evidence.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const READER_URL = new URL('../src/acceptance/browser-candidate-source.mjs', import.meta.url).href;
const OWNER_URL = new URL('../src/acceptance/owner.mjs', import.meta.url).href;
const PREPARED = JSON.parse(fs.readFileSync(required('2026-10-16/evidence/acceptance-spec-execution-control/preparation/prepared-record.json'), 'utf8'));
const copy = value => JSON.parse(JSON.stringify(value));
const sha = data => createHash('sha256').update(data).digest('hex');
const parse = path => JSON.parse(fs.readFileSync(path));
const put = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const refs = report => [...new Set(report.checks.flatMap(check => Object.values(check.evidence)).filter(file => file !== null))].sort();

function safeError(code = 'SOURCE_INTEGRITY_FAILED', reason) {
  return error => {
    assert.ok(error instanceof AcceptanceCatalogError);
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'INVALID_INPUT' ? 400 : code === 'NOT_FOUND' ? 404 : code.startsWith('ACCEPTANCE_OWNER_') ? 503 : 409);
    assert.match(error.details.reason, /^[A-Z0-9_]{1,80}$/);
    if (reason) assert.ok((Array.isArray(reason) ? reason : [reason]).includes(error.details.reason), error.details.reason);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(/[A-Z]:\\|\/tmp\/|heimdall-browser-source-|private-fs-message/.test(JSON.stringify(error)), false);
    return true;
  };
}

function temporary(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'heimdall-browser-source-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return parent;
}
function fixture(t, id = 'target-unavailable', { owned = true } = {}) {
  const parent = temporary(t), root = join(parent, 'acceptance');
  fs.mkdirSync(root);
  const original = join(FIXTURES, id), runId = parse(join(original, 'manifest.json')).runId, dir = join(root, runId);
  fs.cpSync(original, dir, { recursive: true });
  const owner = owned ? acquireAcceptanceOwner({ root }) : undefined;
  if (owner) t.after(() => owner.release());
  return { parent, root, runId, dir, owner, id };
}
const read = (item, overrides = {}) => readBrowserCandidateSource(item.runId, { root: item.root, owner: item.owner, ...overrides });
function tree(root) {
  const result = {};
  const visit = (path, prefix = '') => {
    for (const entry of fs.readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name, child = join(path, entry.name);
      if (entry.isDirectory()) visit(child, name + '/'); else result[name] = sha(fs.readFileSync(child));
    }
  };
  visit(root); return result;
}
function editReport(item, mutate, { summarize = false } = {}) {
  const report = parse(join(item.dir, 'report.json')), manifest = parse(join(item.dir, 'manifest.json'));
  mutate(report);
  if (summarize) {
    const normalized = summarizeAcceptanceReport(report);
    report.summary = normalized.summary; report.gate = normalized.gate;
    manifest.summary = copy(report.summary); manifest.gate = report.gate;
  }
  put(join(item.dir, 'report.json'), report);
  manifest.reportSha256 = sha(fs.readFileSync(join(item.dir, 'report.json')));
  put(join(item.dir, 'manifest.json'), manifest);
}
function publishNamespace(item, { reserve = false, bytes } = {}) {
  const directory = join(item.root, 'managed-spec-dispatches', 'v1'); fs.mkdirSync(directory, { recursive: true });
  const envelope = copy(PREPARED);
  if (reserve) envelope.runId = item.runId;
  const file = join(directory, envelope.operationId + '.json');
  fs.writeFileSync(file, bytes ?? JSON.stringify(envelope, null, 2) + '\n');
  return { directory, file, envelope };
}

/** Each adversarial descriptor/namespace hook gets its own process and timeout.
 * The real owner is acquired before patching; no public reader test seam exists. */
function childProbe(item, body, input = {}) {
  const source = `
    import fs from 'node:fs';
    import { join, basename } from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    import { acquireAcceptanceOwner } from ${JSON.stringify(OWNER_URL)};
    import { readBrowserCandidateSource } from ${JSON.stringify(READER_URL)};
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { root, runId, dir, parent } = input;
    const owner = acquireAcceptanceOwner({ root });
    const original = Object.fromEntries(['openSync','closeSync','readSync','fstatSync','lstatSync','realpathSync','readFileSync',
      'writeFileSync','mkdirSync','renameSync','unlinkSync','appendFileSync','truncateSync','cpSync','rmSync','opendirSync'].map(name => [name, fs[name]]));
    const descriptors = new Map(), opens = {}, closes = {}, reads = {}, events = [];
    const output = { hooks: 0 };
    const isSource = path => typeof path === 'string' && path.startsWith(dir + (process.platform === 'win32' ? '\\\\' : '/'));
    fs.openSync = (path, ...args) => {
      const fd = original.openSync(path, ...args);
      if (isSource(path)) { descriptors.set(fd, { path, name: basename(path), length: original.fstatSync(fd).size }); opens[basename(path)] = (opens[basename(path)] ?? 0) + 1; events.push('open:' + basename(path)); }
      return fd;
    };
    fs.closeSync = fd => {
      const data = descriptors.get(fd);
      if (data) { closes[data.name] = (closes[data.name] ?? 0) + 1; events.push('close:' + data.name); descriptors.delete(fd); }
      return original.closeSync(fd);
    };
    fs.readSync = (fd, buffer, offset, length, position) => {
      const data = descriptors.get(fd); if (data) reads[data.name] = (reads[data.name] ?? 0) + 1;
      return original.readSync(fd, buffer, offset, length, position);
    };
    try {
      ${body}
    } catch (error) { output.harnessError = { message: error.message, stack: error.stack }; }
    finally {
      for (const [name, value] of Object.entries(original)) fs[name] = value;
      syncBuiltinESMExports(); owner.release();
    }
    output.opens = opens; output.closes = closes; output.reads = reads; output.events = events;
    output.remainingDescriptors = descriptors.size;
    console.log(JSON.stringify(output));
  `;
  const child = spawnSync(process.execPath, ['--unhandled-rejections=strict', '--input-type=module', '-e', source], {
    input: JSON.stringify({ root: item.root, runId: item.runId, dir: item.dir, parent: item.parent, ...input }),
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stderr, '');
  const output = JSON.parse(child.stdout);
  assert.equal(output.harnessError, undefined, output.harnessError?.stack);
  return output;
}
const captureResult = `
  syncBuiltinESMExports();
  try { const material = readBrowserCandidateSource(runId, { root: input.readRoot ?? root, owner });
    output.result = 'accepted'; output.files = [...material.files.keys()]; output.integrity = material.snapshot.integrity;
  } catch (error) { output.result = 'rejected'; output.error = { code: error.code, status: error.status, message: error.message,
    details: error.details, cause: Object.hasOwn(error, 'cause') }; }
`;
function rejectedChild(output, code = 'SOURCE_INTEGRITY_FAILED') {
  assert.equal(output.result, 'rejected'); assert.equal(output.error.code, code);
  assert.equal(output.error.status, code.startsWith('ACCEPTANCE_OWNER_') ? 503 : 409);
  assert.match(output.error.details.reason, /^[A-Z0-9_]{1,80}$/);
  assert.equal(output.error.cause, false);
  assert.equal(/[A-Z]:\\|\/tmp\/|heimdall-browser-source-|private-fs-message/.test(JSON.stringify(output.error)), false);
  assert.equal(output.remainingDescriptors, 0);
}

test('real acquired owner captures all four Browser samples and feeds pure selected-side projection', async t => {
  const index = parse(join(FIXTURES, 'source-index.json'));
  for (const sample of index.samples) await t.test(sample.id, t => {
    const item = fixture(t, sample.id), before = tree(item.root), material = read(item);
    assert.deepEqual(material.snapshot.manifest, parse(join(item.dir, 'manifest.json')));
    assert.deepEqual(material.snapshot.report, parse(join(item.dir, 'report.json')));
    assert.deepEqual(material.snapshot.integrity, parse(join(item.dir, 'integrity.json')));
    assert.deepEqual([...material.files.keys()], ['manifest.json', 'report.json', ...refs(material.snapshot.report)]);
    assert.equal(material.files.size, sample.files.length);
    for (const entry of sample.files) {
      const data = material.files.get(entry.file);
      assert.equal(Buffer.isBuffer(data), true); assert.equal(data.length, entry.bytes); assert.equal(sha(data), entry.sha256);
    }
    assert.equal(material.files.has('integrity.json'), false);
    assert.equal(Object.hasOwn(material.snapshot, 'files'), false);
    assert.equal(JSON.stringify(material.snapshot).includes('"type":"Buffer"'), false);
    const sides = sample.id === 'matrix' ? ['baseline', 'target']
      : sample.id === 'target-unavailable' ? ['baseline'] : sample.id === 'baseline-unavailable' ? ['target'] : [];
    for (const sourceSide of sides) {
      const result = projectBrowserBaselineCandidate(material, { sourceSide });
      assert.equal(result.preview.executionReady, false); assert.equal(result.preview.sourceGate, sample.gate);
      assert.equal(result.projection.source.runId, sample.runId); assert.equal(result.projection.source.side, sourceSide);
    }
    if (sample.id === 'assertion-failed') for (const sourceSide of ['baseline', 'target']) {
      assert.throws(() => projectBrowserBaselineCandidate(material, { sourceSide }), safeError('SOURCE_NOT_ELIGIBLE', 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE'));
    }
    assert.equal(item.owner.assertOwned(), true); assert.deepEqual(tree(item.root), before);
  });
});

test('each actual non-null screenshot, repeat, details and diff rejects corruption and absence', async t => {
  const item = fixture(t, 'matrix'), report = parse(join(item.dir, 'report.json'));
  const names = refs(report);
  assert.equal(names.length, 52);
  assert.ok(names.some(name => name.endsWith('-diff.png')));
  for (const name of names) for (const mutation of ['same-length corruption', 'missing']) {
    await t.test(name + ': ' + mutation, () => {
      const path = join(item.dir, name), original = fs.readFileSync(path);
      try {
        if (mutation === 'missing') fs.unlinkSync(path);
        else { const changed = Buffer.from(original); changed[changed.length - 1] ^= 1; fs.writeFileSync(path, changed); }
        assert.throws(() => read(item), safeError());
      } finally { fs.writeFileSync(path, original); }
    });
  }
  assert.equal(read(item).files.size, 54);
});

test('nullable syntax is restricted to four screenshot roles and never to details, diff or unknown roles', async t => {
  for (const [role, value] of [['baselineDetails', null], ['targetDetails', null], ['diff', null],
    ['newRole', null], ['targetScreenshot', false], ['baselineRepeat', 0], ['targetRepeat', ''], ['baselineScreenshot', '../escape.png']]) {
    await t.test(role + ':' + String(value), t => {
      const item = fixture(t);
      editReport(item, report => { report.checks[0].evidence[role] = value; });
      assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_EVIDENCE_REFERENCE_INVALID'));
    });
  }
  for (const role of ['baselineScreenshot', 'targetScreenshot', 'baselineRepeat', 'targetRepeat']) await t.test(role + ': null is syntactically readable', t => {
    const item = fixture(t, 'matrix');
    editReport(item, report => { report.checks[0].evidence[role] = null; });
    const material = read(item);
    assert.equal(material.snapshot.report.checks[0].evidence[role], null);
    assert.throws(() => projectBrowserBaselineCandidate(material, { sourceSide: 'baseline' }), AcceptanceCatalogError);
  });
});

test('reader leaves Browser role contents and source eligibility to the pure projector', t => {
  const item = fixture(t), report = parse(join(item.dir, 'report.json'));
  const file = report.checks[0].evidence.baselineScreenshot, data = Buffer.from('bounded raw bytes, not a PNG');
  fs.writeFileSync(join(item.dir, file), data);
  editReport(item, current => { const entry = current.evidenceManifest.find(entry => entry.file === file);
    entry.bytes = data.length; entry.sha256 = sha(data); });
  const material = read(item);
  assert.deepEqual(material.files.get(file), data);
  assert.throws(() => projectBrowserBaselineCandidate(material, { sourceSide: 'baseline' }), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_PNG_INVALID'));
});

test('source index, head digests, summaries and completion remain checked independently', async t => {
  const mutations = [
    ['head report corruption', item => { const path = join(item.dir, 'report.json'), data = fs.readFileSync(path); data[data.length - 1] ^= 1; fs.writeFileSync(path, data); }],
    ['missing report digest', item => { const path = join(item.dir, 'manifest.json'), manifest = parse(path); delete manifest.reportSha256; put(path, manifest); }],
    ['different run identity', item => { const path = join(item.dir, 'manifest.json'), manifest = parse(path); manifest.runId = 'ac-' + randomUUID(); put(path, manifest); }],
    ['different saved plan', item => { const path = join(item.dir, 'manifest.json'), manifest = parse(path); manifest.plan.name = 'edited'; put(path, manifest); }],
    ['changed report summary', item => editReport(item, report => { report.summary.total++; })],
    ['changed report gate', item => editReport(item, report => { report.gate = 'passed'; })],
    ['unfinished report', item => editReport(item, report => { report.status = 'running'; })],
    ['duplicate evidence entry', item => editReport(item, report => { report.evidenceManifest.push(copy(report.evidenceManifest[0])); })],
    ['case-folded duplicate evidence entry', item => editReport(item, report => { const entry = copy(report.evidenceManifest[0]);
      entry.file = entry.file.toUpperCase(); report.evidenceManifest.push(entry); })],
    ['extra evidence index property', item => editReport(item, report => { report.evidenceManifest[0].private = true; })],
    ['unindexed reference', item => editReport(item, report => { report.evidenceManifest.shift(); })],
    ['reserved index entry', item => editReport(item, report => { report.evidenceManifest[0].file = 'manifest.json'; })],
    ['array evidence roles', item => editReport(item, report => { report.checks[0].evidence = []; })],
    ['missing required screenshot role', item => editReport(item, report => { delete report.checks[0].evidence.baselineScreenshot; })],
  ];
  for (const [name, mutate] of mutations) await t.test(name, t => {
    const item = fixture(t); mutate(item); assert.throws(() => read(item), safeError());
  });
});

test('both Browser modes read but Spec mode and managed markers are quarantined without repairing bytes', async t => {
  await t.test('mirror and regression remain Browser sources', t => {
    const item = fixture(t), manifest = parse(join(item.dir, 'manifest.json'));
    manifest.mode = 'mirror'; manifest.plan.mode = 'mirror';
    editReport(item, report => { report.mode = 'mirror'; report.planFingerprint = sha(JSON.stringify(manifest.plan)); });
    manifest.reportSha256 = sha(fs.readFileSync(join(item.dir, 'report.json'))); put(join(item.dir, 'manifest.json'), manifest);
    assert.equal(read(item).snapshot.report.mode, 'mirror');
  });
  await t.test('Spec is not a Browser source', t => {
    const item = fixture(t), path = join(item.dir, 'manifest.json'), manifest = parse(path);
    manifest.mode = 'spec'; put(path, manifest);
    assert.throws(() => read(item), safeError('SOURCE_NOT_ELIGIBLE', 'SOURCE_MODE_UNSUPPORTED'));
  });
  for (const head of ['manifest', 'report']) for (const marker of ['managed', 'authority', 'dispatchId', 'dispatchSha256', 'operationId', 'executor']) {
    await t.test(head + ':' + marker, t => {
      const item = fixture(t);
      if (head === 'report') editReport(item, report => { report[marker] = false; });
      else { const path = join(item.dir, 'manifest.json'), manifest = parse(path); manifest[marker] = false; put(path, manifest); }
      const before = tree(item.root);
      assert.throws(() => read(item), safeError('SOURCE_NOT_ELIGIBLE', 'SOURCE_MANAGED_UNSUPPORTED'));
      assert.deepEqual(tree(item.root), before);
    });
  }
});

test('real owner brand is required and the original lock must still be owned now', async t => {
  const item = fixture(t);
  let hooks = 0;
  for (const owner of [undefined, {}, { root: item.root, assertOwned() { hooks++; return true; } },
    Object.create(item.owner), new Proxy(item.owner, { get() { hooks++; throw new Error('owner proxy'); } }),
    { get root() { hooks++; return item.root; }, assertOwned() { hooks++; } }]) {
    assert.throws(() => read(item, { owner }), safeError('ACCEPTANCE_OWNER_UNAVAILABLE', 'OWNER_REQUIRED'));
  }
  assert.equal(hooks, 0);
  const otherRoot = join(item.parent, 'other'); fs.mkdirSync(otherRoot);
  const otherOwner = acquireAcceptanceOwner({ root: otherRoot }); t.after(() => otherOwner.release());
  assert.throws(() => read(item, { owner: otherOwner }), safeError('ACCEPTANCE_OWNER_LOST'));
  item.owner.release();
  assert.throws(() => read(item), safeError('ACCEPTANCE_OWNER_LOST', 'OWNER_LOST'));
});

test('strict options, identifiers and lowered limits reject accessors and proxies before hooks run', t => {
  const item = fixture(t);
  let invoked = 0;
  for (const runId of [undefined, null, {}, '../manifest.json', item.runId.toUpperCase(), 'ac-' + 'a'.repeat(36)]) {
    assert.throws(() => readBrowserCandidateSource(runId, { root: item.root, owner: item.owner }), safeError('INVALID_INPUT', 'INVALID_SOURCE_INPUT'));
  }
  for (const options of [null, [], new Proxy({}, { get() { invoked++; } }), { unknown: true },
    { sourceSide: 'baseline' }, { get root() { invoked++; return item.root; } },
    Object.defineProperty({}, 'owner', { value: item.owner }), { [Symbol('unknown')]: true }]) {
    assert.throws(() => readBrowserCandidateSource(item.runId, options), safeError('INVALID_INPUT', 'INVALID_SOURCE_INPUT'));
  }
  for (const limits of [null, [], { unknown: 1 }, { jsonBytes: -1 }, { checks: 1.5 },
    { checks: BROWSER_CANDIDATE_SOURCE_LIMITS.checks + 1 }, { get checks() { invoked++; return 1; } },
    { [Symbol('hidden')]: 1 }, new Proxy({}, { get() { invoked++; } })]) {
    assert.throws(() => read(item, { limits }), safeError('INVALID_INPUT', 'INVALID_LIMITS'));
  }
  assert.equal(invoked, 0); assert.equal(Object.isFrozen(BROWSER_CANDIDATE_SOURCE_LIMITS), true);
});

test('head, evidence count/bytes and JSON complexity each have independently lowerable budgets', t => {
  const item = fixture(t), report = parse(join(item.dir, 'report.json')), referenced = refs(report);
  const files = referenced.map(file => fs.readFileSync(join(item.dir, file)));
  const limits = { jsonBytes: Math.max(...['manifest.json', 'report.json'].map(file => fs.statSync(join(item.dir, file)).size)),
    evidenceFiles: referenced.length, evidenceFileBytes: Math.max(...files.map(data => data.length)),
    evidenceBytes: files.reduce((sum, data) => sum + data.length, 0), checks: report.checks.length };
  assert.equal(read(item, { limits }).files.size, referenced.length + 2);
  for (const key of Object.keys(limits)) {
    assert.throws(() => read(item, { limits: { ...limits, [key]: limits[key] - 1 } }), safeError());
  }
  for (const key of ['jsonDepth', 'jsonNodes', 'jsonCharacters']) {
    assert.throws(() => read(item, { limits: { [key]: 0 } }), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_JSON_COMPLEXITY_EXCEEDED'));
  }
});

test('default head JSON complexity and UTF-8 bounds are enforced before recursive snapshot processing', async t => {
  for (const scenario of ['deep manifest', 'wide manifest', 'invalid UTF-8', 'array head', 'null head']) await t.test(scenario, t => {
    const item = fixture(t), path = join(item.dir, 'manifest.json');
    if (scenario === 'deep manifest') {
      const manifest = parse(path); let cursor = manifest;
      for (let i = 0; i <= BROWSER_CANDIDATE_SOURCE_LIMITS.jsonDepth; i++) cursor = cursor.private = {};
      put(path, manifest);
    }
    if (scenario === 'wide manifest') {
      const manifest = parse(path); manifest.private = Array(BROWSER_CANDIDATE_SOURCE_LIMITS.jsonNodes + 1).fill(null); put(path, manifest);
    }
    if (scenario === 'invalid UTF-8') fs.writeFileSync(path, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
    if (scenario === 'array head') fs.writeFileSync(path, '[]');
    if (scenario === 'null head') fs.writeFileSync(path, 'null');
    assert.ok(fs.statSync(path).size < BROWSER_CANDIDATE_SOURCE_LIMITS.jsonBytes);
    assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', scenario.endsWith('manifest')
      ? 'SOURCE_JSON_COMPLEXITY_EXCEEDED' : 'SOURCE_JSON_INVALID'));
  });
});

test('unreferenced evidence and handoff files do not become captured provenance', t => {
  const item = fixture(t), initial = read(item);
  fs.writeFileSync(join(item.dir, 'integrity.json'), 'corrupt untrusted handoff');
  editReport(item, report => { report.evidenceManifest.push({ file: 'unread-extra.json', bytes: 999, sha256: 'a'.repeat(64) }); });
  const material = read(item);
  assert.equal(material.files.has('unread-extra.json'), false);
  assert.equal(material.files.has('integrity.json'), false);
  assert.equal(material.snapshot.integrity.verifiedFiles, initial.snapshot.integrity.verifiedFiles);
  assert.equal(material.snapshot.integrity.verifiedBytes, initial.snapshot.integrity.verifiedBytes);
});

test('returned snapshots, Map entries and Buffers are isolated from the source and later captures', t => {
  const item = fixture(t), before = tree(item.root), first = read(item), second = read(item);
  first.snapshot.report.checks[0].title = 'caller mutation'; first.snapshot.manifest.plan.name = 'caller plan mutation';
  first.files.get('manifest.json').fill(0); first.files.clear();
  assert.deepEqual(read(item), second);
  assert.deepEqual(tree(item.root), before);
});

test('root aliases are canonicalized while runs, heads, evidence links and hardlinks are refused', async t => {
  await t.test('canonical root alias', t => {
    const item = fixture(t), alias = join(item.parent, 'alias');
    fs.symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(read(item, { root: alias }).files.size, 6);
    const other = join(item.parent, 'other'); fs.mkdirSync(other);
    fs.unlinkSync(alias); fs.symlinkSync(other, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => read(item, { root: alias }), safeError('ACCEPTANCE_OWNER_LOST'));
  });
  await t.test('run junction', t => {
    const item = fixture(t), moved = join(item.parent, 'moved-run');
    fs.renameSync(item.dir, moved); fs.symlinkSync(moved, item.dir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_RUN_PATH_INVALID'));
  });
  for (const name of ['manifest.json', 'report.json', 'route-1-1-desktop-baseline.json', 'route-1-1-desktop-baseline.png']) {
    for (const kind of ['symlink', 'hardlink']) await t.test(kind + ':' + name, t => {
      const item = fixture(t), path = join(item.dir, name), moved = join(item.parent, name);
      fs.renameSync(path, moved);
      if (kind === 'hardlink') fs.linkSync(moved, path);
      else try { fs.symlinkSync(moved, path, 'file'); }
      catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlink permission unavailable'); throw error; }
      assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_PATH_INVALID'));
    });
  }
  await t.test('directory replacing evidence file', t => {
    const item = fixture(t), path = join(item.dir, 'route-1-1-desktop-baseline.json');
    fs.unlinkSync(path); fs.mkdirSync(path);
    assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_PATH_INVALID'));
  });
});

test('missing roots and runs use safe errors and never initialize directories or owner records', t => {
  const item = fixture(t), before = tree(item.root), absent = join(item.parent, 'absent');
  assert.throws(() => readBrowserCandidateSource('ac-' + randomUUID(), { root: item.root, owner: item.owner }), safeError('NOT_FOUND', 'SOURCE_RUN_MISSING'));
  assert.throws(() => read(item, { root: absent }), safeError('ACCEPTANCE_OWNER_LOST'));
  assert.equal(fs.existsSync(absent), false); assert.deepEqual(tree(item.root), before);
});

test('valid unrelated dispatch namespace is readable while reserved IDs and damaged namespace are quarantined', async t => {
  await t.test('valid unrelated dispatch', t => {
    const item = fixture(t); publishNamespace(item);
    const before = tree(item.root); assert.equal(read(item).files.size, 6); assert.deepEqual(tree(item.root), before);
  });
  await t.test('reserved identity without a managed marker', t => {
    const item = fixture(t); publishNamespace(item, { reserve: true });
    const before = tree(item.root);
    assert.throws(() => read(item), safeError('SOURCE_NOT_ELIGIBLE', 'SOURCE_MANAGED_UNSUPPORTED'));
    assert.deepEqual(tree(item.root), before);
  });
  for (const mutation of ['malformed published JSON', 'unknown name', 'parent is file', 'version is file']) {
    await t.test(mutation, t => {
      const item = fixture(t), parent = join(item.root, 'managed-spec-dispatches'), version = join(parent, 'v1');
      if (mutation === 'malformed published JSON') publishNamespace(item, { bytes: Buffer.from('{private namespace') });
      if (mutation === 'unknown name') { fs.mkdirSync(version, { recursive: true }); fs.writeFileSync(join(version, 'private.tmp'), 'unknown'); }
      if (mutation === 'parent is file') fs.writeFileSync(parent, 'not a directory');
      if (mutation === 'version is file') { fs.mkdirSync(parent); fs.writeFileSync(version, 'not a directory'); }
      const before = tree(item.root);
      assert.throws(() => read(item), safeError('SOURCE_INTEGRITY_FAILED', 'SOURCE_MANAGED_DISPATCH_UNAVAILABLE'));
      assert.deepEqual(tree(item.root), before);
    });
  }
});

test('every captured source file has two bounded descriptor reads and native short reads remain valid', t => {
  const item = fixture(t, 'target-unavailable', { owned: false });
  const output = childProbe(item, `
    const read = fs.readSync;
    fs.readSync = (fd, buffer, offset, length, position) => {
      if (descriptors.has(fd) && length > 7) { output.hooks++; length = 7; }
      return read(fd, buffer, offset, length, position);
    };
    ${captureResult}
  `);
  assert.equal(output.result, 'accepted'); assert.ok(output.hooks > 100);
  assert.equal(output.remainingDescriptors, 0);
  assert.equal(output.files.length, 6);
  for (const file of output.files) { assert.equal(output.opens[file], 2, file); assert.equal(output.closes[file], 2, file); }
});

test('invalid read counts, premature EOF, reads past EOF and native failures reject with every descriptor closed', async t => {
  for (const scenario of ['negative', 'fractional', 'nan', 'oversized', 'string', 'undefined', 'zero', 'sentinel', 'read-error', 'close-error']) {
    await t.test(scenario, t => {
      const item = fixture(t, 'target-unavailable', { owned: false });
      const output = childProbe(item, `
        const read = fs.readSync, close = fs.closeSync;
        fs.readSync = (fd, buffer, offset, length, position) => {
          const data = descriptors.get(fd);
          if (data?.name === 'manifest.json' && !output.hooks && input.scenario !== 'close-error' && (input.scenario !== 'sentinel' || position === data.length)) {
            output.hooks++;
            if (input.scenario === 'negative') return -1;
            if (input.scenario === 'fractional') return 0.5;
            if (input.scenario === 'nan') return NaN;
            if (input.scenario === 'oversized') return length + 1;
            if (input.scenario === 'string') return '1';
            if (input.scenario === 'undefined') return undefined;
            if (input.scenario === 'zero') return 0;
            if (input.scenario === 'sentinel') return 1;
            if (input.scenario === 'read-error') throw Error('private-fs-message ' + data.path);
          }
          return read(fd, buffer, offset, length, position);
        };
        if (input.scenario === 'close-error') fs.closeSync = fd => {
          const data = descriptors.get(fd); const result = close(fd);
          if (data?.name === 'manifest.json') { output.hooks++; throw Error('private-fs-message ' + data.path); }
          return result;
        };
        ${captureResult}
      `, { scenario });
      rejectedChild(output); assert.equal(output.hooks, 1);
      assert.equal(output.opens['manifest.json'], 1); assert.equal(output.closes['manifest.json'], 1);
    });
  }
});

test('growth, truncation and mismatching descriptor identity are rejected without allocating for changed sizes', async t => {
  for (const scenario of ['growth', 'truncate', 'wrong-fstat', 'not-file-fstat']) await t.test(scenario, t => {
    const item = fixture(t, 'target-unavailable', { owned: false });
    const output = childProbe(item, `
      const read = fs.readSync, fstat = fs.fstatSync;
      fs.readSync = (fd, buffer, offset, length, position) => {
        const data = descriptors.get(fd);
        if (data?.name === 'manifest.json' && !output.hooks && ['growth','truncate'].includes(input.scenario)) {
          output.hooks++; output.allocation = buffer.length; output.originalLength = data.length;
          if (input.scenario === 'growth') original.appendFileSync(data.path, 'x');
          else original.truncateSync(data.path, data.length - 1);
        }
        return read(fd, buffer, offset, length, position);
      };
      fs.fstatSync = (fd, ...args) => {
        const stat = fstat(fd, ...args), data = descriptors.get(fd);
        if (data?.name === 'manifest.json' && !output.hooks && ['wrong-fstat','not-file-fstat'].includes(input.scenario)) {
          output.hooks++;
          if (input.scenario === 'wrong-fstat') return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n });
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isFile: () => false });
        }
        return stat;
      };
      ${captureResult}
    `, { scenario });
    rejectedChild(output); assert.equal(output.hooks, 1);
    if (scenario === 'growth' || scenario === 'truncate') assert.equal(output.allocation, output.originalLength);
    assert.equal(output.closes['manifest.json'], output.opens['manifest.json']);
  });
});

test('canonical root identity survives calls but rejects root replacement, while same-target aliases may change', async t => {
  await t.test('same physical root through different aliases', t => {
    const item = fixture(t), first = join(item.parent, 'first'), second = join(item.parent, 'second');
    for (const alias of [first, second]) fs.symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(read(item, { root: first }).files.size, 6);
    fs.unlinkSync(first); fs.symlinkSync(item.root, first, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(read(item, { root: first }).files.size, 6); assert.equal(read(item, { root: second }).files.size, 6);
  });
  await t.test('same root pathname with a new directory and copied lock is rejected', t => {
    const item = fixture(t); read(item);
    const moved = join(item.parent, 'old-root'); fs.renameSync(item.root, moved); fs.cpSync(moved, item.root, { recursive: true });
    assert.notEqual(fs.lstatSync(item.root, { bigint: true }).ino, fs.lstatSync(moved, { bigint: true }).ino);
    assert.throws(() => read(item), safeError('ACCEPTANCE_OWNER_LOST'));
  });
  await t.test('root recreated before the first reader capture cannot retain authority by moving back the original lock', t => {
    const item = fixture(t), lock = join(item.root, '.acceptance-owner.json'), lockBytes = fs.readFileSync(lock);
    const lockInode = fs.lstatSync(lock, { bigint: true }).ino, moved = join(item.parent, 'original-root');
    fs.renameSync(item.root, moved); fs.mkdirSync(item.root);
    fs.renameSync(join(moved, '.acceptance-owner.json'), lock);
    fs.cpSync(join(moved, item.runId), item.dir, { recursive: true });
    assert.equal(fs.lstatSync(lock, { bigint: true }).ino, lockInode, 'attack preserves the actual acquired lock inode');
    assert.deepEqual(fs.readFileSync(lock), lockBytes);
    assert.throws(() => item.owner.assertOwned(), error => error.code === 'ACCEPTANCE_OWNER_LOST' && error.status === 503);
    assert.throws(() => read(item), safeError('ACCEPTANCE_OWNER_LOST', 'OWNER_LOST'));
    assert.equal(item.owner.release(), false);
    assert.deepEqual(fs.readFileSync(lock), lockBytes, 'release must preserve the moved lock as evidence');
  });
  await t.test('ordinary root contents may change without losing the acquired directory', t => {
    const item = fixture(t);
    fs.mkdirSync(join(item.root, 'ordinary-new-folder'));
    fs.writeFileSync(join(item.root, 'ordinary-note.txt'), 'normal root contents');
    assert.equal(item.owner.assertOwned(), true); assert.equal(read(item).files.size, 6);
  });
});

test('owner, root, run and alias changes during descriptor capture cannot escape the final fence', async t => {
  for (const scenario of ['owner', 'root', 'run', 'alias']) await t.test(scenario, t => {
    const item = fixture(t, 'target-unavailable', { owned: false });
    const alias = join(item.parent, 'alias');
    if (scenario === 'alias') fs.symlinkSync(item.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const output = childProbe(item, `
      const close = fs.closeSync;
      fs.closeSync = fd => {
        const data = descriptors.get(fd), result = close(fd);
        if (data?.name === input.target && !output.hooks) {
          output.hooks++;
          if (input.scenario === 'owner') original.unlinkSync(join(root, '.acceptance-owner.json'));
          if (input.scenario === 'root') { const moved = join(parent, 'moved-root'); original.renameSync(root, moved); original.cpSync(moved, root, { recursive: true }); }
          if (input.scenario === 'run') { const moved = join(parent, 'moved-run'); original.renameSync(dir, moved); original.cpSync(moved, dir, { recursive: true }); }
          if (input.scenario === 'alias') { const other = join(parent, 'other'); original.mkdirSync(other); original.unlinkSync(input.readRoot); fs.symlinkSync(other, input.readRoot, process.platform === 'win32' ? 'junction' : 'dir'); }
        }
        return result;
      };
      ${captureResult}
    `, { scenario, target: 'route-1-1-desktop-baseline.json', ...(scenario === 'alias' ? { readRoot: alias } : {}) });
    rejectedChild(output, scenario === 'run' ? 'SOURCE_INTEGRITY_FAILED' : 'ACCEPTANCE_OWNER_LOST');
    assert.equal(output.hooks, 1);
  });
});

test('head and evidence mutation after either capture and during the final namespace check are rejected', async t => {
  const cases = [
    ['manifest.json', 1], ['report.json', 1], ['manifest.json', 2], ['report.json', 2],
    ['route-1-1-desktop-baseline.json', 1], ['route-1-1-desktop-baseline.json', 2],
    ['route-1-1-desktop-baseline.png', 2],
  ];
  for (const [target, occurrence] of cases) await t.test(target + ': close ' + occurrence, t => {
    const item = fixture(t, 'target-unavailable', { owned: false });
    const output = childProbe(item, `
      const close = fs.closeSync;
      fs.closeSync = fd => {
        const data = descriptors.get(fd), result = close(fd);
        if (data?.name === input.target && closes[data.name] === input.occurrence && !output.hooks) {
          output.hooks++; const raw = original.readFileSync(data.path); raw[raw.length - 1] ^= 1; original.writeFileSync(data.path, raw);
        }
        return result;
      };
      ${captureResult}
    `, { target, occurrence });
    rejectedChild(output); assert.equal(output.hooks, 1);
  });
  await t.test('source changes during final namespace revalidation', t => {
    const item = fixture(t, 'target-unavailable', { owned: false }), namespace = publishNamespace(item);
    const output = childProbe(item, `
      const opendir = fs.opendirSync;
      fs.opendirSync = (...args) => {
        const handle = opendir(...args);
        if (args[0] === input.namespace && closes['report.json'] === 2 && !output.hooks) {
          const close = handle.closeSync.bind(handle);
          handle.closeSync = () => { const result = close(); if (!output.hooks) {
            output.hooks++; const path = join(dir, input.target), raw = original.readFileSync(path); raw[raw.length - 1] ^= 1; original.writeFileSync(path, raw);
          } return result; };
        }
        return handle;
      };
      ${captureResult}
    `, { namespace: namespace.directory, target: 'route-1-1-desktop-baseline.png' });
    rejectedChild(output); assert.equal(output.hooks, 1);
    assert.equal(output.error.details.reason, 'SOURCE_EVIDENCE_CHANGED');
  });
});

test('managed namespace changes at every capture stage invalidate the fixed negative without adopting new records', async t => {
  const stages = ['manifest', 'report', 'first evidence', 'second evidence', 'final report', 'after final report'];
  for (const initial of ['absent', 'present']) for (const stage of stages) await t.test(initial + ': ' + stage, t => {
    const item = fixture(t, 'target-unavailable', { owned: false });
    const namespace = initial === 'present' ? publishNamespace(item) : { directory: join(item.root, 'managed-spec-dispatches', 'v1') };
    const output = childProbe(item, `
      const mutate = () => {
        if (output.hooks) return; output.hooks++;
        if (input.initial === 'absent') { original.mkdirSync(input.namespace, { recursive: true }); original.writeFileSync(join(input.namespace, 'new-private-entry'), 'new bytes'); }
        else if (input.stage === 'report' || input.stage === 'second evidence') original.appendFileSync(input.namespaceFile, ' ');
        else if (input.stage === 'final report') { const moved = join(parent, 'moved-namespace'); original.renameSync(input.namespace, moved); original.mkdirSync(input.namespace); }
        else original.writeFileSync(join(input.namespace, 'new-private-entry'), 'new bytes');
      };
      const open = fs.openSync, close = fs.closeSync;
      fs.openSync = (path, ...args) => {
        const fd = open(path, ...args), data = descriptors.get(fd);
        if (data) {
          if (input.stage === 'manifest' && data.name === 'manifest.json' && opens[data.name] === 1) mutate();
          if (input.stage === 'report' && data.name === 'report.json' && opens[data.name] === 1) mutate();
          if (input.stage === 'first evidence' && data.name === input.target && opens[data.name] === 1) mutate();
          if (input.stage === 'second evidence' && data.name === input.target && opens[data.name] === 2) mutate();
          if (input.stage === 'final report' && data.name === 'report.json' && opens[data.name] === 2) mutate();
        }
        return fd;
      };
      fs.closeSync = fd => { const data = descriptors.get(fd), result = close(fd);
        if (input.stage === 'after final report' && data?.name === 'report.json' && closes[data.name] === 2) mutate();
        return result;
      };
      ${captureResult}
    `, { initial, stage, namespace: namespace.directory, namespaceFile: namespace.file, target: 'route-1-1-desktop-baseline.json' });
    rejectedChild(output); assert.equal(output.hooks, 1);
    assert.equal(output.error.details.reason, 'SOURCE_MANAGED_DISPATCH_CHANGED');
  });
  await t.test('namespace changes during its final revalidation', t => {
    const item = fixture(t, 'target-unavailable', { owned: false }), namespace = publishNamespace(item);
    const output = childProbe(item, `
      const opendir = fs.opendirSync;
      fs.opendirSync = (...args) => {
        const handle = opendir(...args);
        if (args[0] === input.namespace && closes['report.json'] === 2 && !output.hooks) {
          const close = handle.closeSync.bind(handle);
          handle.closeSync = () => { const result = close(); if (!output.hooks) {
            output.hooks++; original.writeFileSync(join(input.namespace, 'late-private-entry'), 'new namespace bytes');
          } return result; };
        }
        return handle;
      };
      ${captureResult}
    `, { namespace: namespace.directory });
    rejectedChild(output); assert.equal(output.hooks, 1);
    assert.equal(output.error.details.reason, 'SOURCE_MANAGED_DISPATCH_CHANGED');
  });
});

test('reader capture performs no filesystem writes, target fetches or namespace initialization', t => {
  const item = fixture(t, 'matrix', { owned: false }), before = tree(item.root);
  const output = childProbe(item, `
    const writes = [];
    for (const name of ['writeFileSync','mkdirSync','renameSync','unlinkSync','appendFileSync','truncateSync','cpSync','rmSync']) fs[name] = () => { writes.push(name); throw Error('reader write forbidden'); };
    globalThis.fetch = () => { writes.push('fetch'); throw Error('reader network forbidden'); };
    ${captureResult}
    output.writes = writes;
  `);
  assert.equal(output.result, 'accepted'); assert.deepEqual(output.writes, []);
  assert.equal(output.remainingDescriptors, 0); assert.deepEqual(tree(item.root), before);
  assert.equal(output.files.length, 54);
  for (const file of output.files) { assert.equal(output.opens[file], 2, file); assert.equal(output.closes[file], 2, file); }
  assert.equal(fs.existsSync(join(item.root, 'managed-spec-dispatches')), false);
});
