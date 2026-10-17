import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createAcceptanceCatalogStore, validateAcceptanceCatalog } from '../src/acceptance/catalog.mjs';
import { browserBindingProjectionOf, currentSelectionsOf } from '../src/acceptance/catalog-schema.mjs';
import { readBrowserCandidateSource } from '../src/acceptance/browser-candidate-source.mjs';
import { projectBrowserBaselineCandidate } from '../src/acceptance/browser-candidate-projection.mjs';
import { acquireAcceptanceOwner } from '../src/acceptance/owner.mjs';
import { hashAcceptanceValue } from '../src/acceptance/identity.mjs';
import { writeAtomicFileSync } from '../src/acceptance/atomic-file.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { createAcceptanceRun, finishAcceptanceRun, acceptanceRunDir } from '../src/acceptance/store.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/acceptance-browser-source/', import.meta.url));
const uid = prefix => prefix + '-' + randomUUID();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const parse = path => JSON.parse(readFileSync(path, 'utf8'));
const put = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const cas = f => { const { generationId, revision } = f.store.read(); return { expectedGenerationId: generationId, expectedRevision: revision }; };
const head = f => readFileSync(join(f.root, 'catalog.json'));
const input = (f, side = f.side, release = f.release, extra = {}) => ({ ...cas(f), runId: f.runId, sourceSide: side, releaseId: release.id, ...extra });
const project = (f, side = f.side) => projectBrowserBaselineCandidate(readBrowserCandidateSource(f.runId, { root: f.root, owner: f.owner }), { sourceSide: side });

/** Include directories and write timestamps so a read cannot silently repair or create material. */
function tree(root) {
  const result = {};
  function visit(path, key) {
    const stat = lstatSync(path, { bigint: true });
    assert.equal(stat.isSymbolicLink(), false);
    result[key] = stat.isDirectory() ? { directory: true, mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) }
      : { bytes: Number(stat.size), sha256: hash(readFileSync(path)), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) };
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), key ? key + '/' + name : name);
  }
  visit(root, ''); return result;
}
function files(root) {
  return Object.fromEntries(readdirSync(root).sort().map(name => [name, readFileSync(join(root, name))]));
}
function restore(root, saved) { for (const [name, bytes] of Object.entries(saved)) writeFileSync(join(root, name), bytes); }
function safeFailure(code, status = 409, reason) {
  return error => {
    assert.equal(error.code, code); assert.equal(error.status, status);
    if (reason) assert.equal(error.details?.reason, reason);
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(/[A-Z]:\\|\/tmp\/|heimdall-browser-binding-|ENOENT|EACCES/.test(JSON.stringify(error)), false);
    return true;
  };
}
async function unchanged(f, action, code, status = 409, reason) {
  const before = tree(f.root);
  await assert.rejects(action(), safeFailure(code, status, reason));
  assert.deepEqual(tree(f.root), before);
  validateAcceptanceCatalog(f.store.read());
}
function noCapabilities(value) {
  assert.equal(Buffer.isBuffer(value), false); assert.equal(value instanceof Map, false);
  assert.notEqual(typeof value, 'function');
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert.equal(['files', 'owner', 'plan', 'preCommitGuard', 'snapshot'].includes(key), false, key);
    noCapabilities(child);
  }
}
function openStore(f, limits = {}) {
  return createAcceptanceCatalogStore({ root: f.root, owner: f.owner, limits, writeAtomic(file, bytes) {
    f.writes.push(basename(file)); writeAtomicFileSync(file, bytes);
    if (basename(file) === 'catalog.previous.json' && f.afterPrevious) {
      const callback = f.afterPrevious; f.afterPrevious = null; callback();
    }
  } });
}
async function projectRelease(f, targetUrl, name = '独立项目') {
  const project = (await f.store.createProject({ ...cas(f), name })).project;
  const release = (await f.store.createRelease(project.id, { ...cas(f), label: 'v1', targetUrl })).release;
  return { project, release };
}
async function fixture(t, sample = 'target-unavailable', side = 'baseline') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'heimdall-browser-binding-'))), root = join(parent, 'acceptance');
  mkdirSync(root);
  const original = join(FIXTURES, sample), manifest = parse(join(original, 'manifest.json'));
  const dir = join(root, manifest.runId); cpSync(original, dir, { recursive: true });
  const owner = acquireAcceptanceOwner({ root });
  t.after(() => { owner.release(); rmSync(parent, { recursive: true, force: true }); });
  const f = { parent, root, owner, sample, side, runId: manifest.runId, dir, writes: [], afterPrevious: null };
  f.store = openStore(f); await f.store.initialize({ createSchemaVersion: 3 });
  Object.assign(f, await projectRelease(f, manifest.plan[side + 'Url'], 'Browser 来源归属'));
  f.writes.length = 0; return f;
}
function reseal(f, mutate) {
  const manifest = parse(join(f.dir, 'manifest.json')), report = parse(join(f.dir, 'report.json'));
  mutate(manifest, report);
  for (const entry of report.evidenceManifest) {
    const file = join(f.dir, entry.file);
    if (existsSync(file)) { const bytes = readFileSync(file); entry.bytes = bytes.length; entry.sha256 = hash(bytes); }
  }
  put(join(f.dir, 'report.json'), report); manifest.reportSha256 = hash(readFileSync(join(f.dir, 'report.json')));
  put(join(f.dir, 'manifest.json'), manifest);
}
function rewritePlanName(f) {
  reseal(f, (manifest, report) => {
    manifest.plan.name = manifest.name = report.name = '自洽但内容不同的 Browser 来源';
    report.planFingerprint = hash(JSON.stringify(manifest.plan));
  });
}
function rewriteEvidenceBytes(f) {
  const report = parse(join(f.dir, 'report.json')), detail = report.checks[0].evidence.baselineDetails;
  writeFileSync(join(f.dir, detail), readFileSync(join(f.dir, detail), 'utf8') + '\n'); reseal(f, () => {});
}
function replaceTargetEntry(f, targetUrl) {
  // Every frozen route is non-root: entry query is intentionally absent from observed route URLs.
  reseal(f, (manifest, report) => {
    manifest.targetUrl = manifest.plan.targetUrl = report.targetUrl = targetUrl;
    report.planFingerprint = hash(JSON.stringify(manifest.plan));
  });
}

test('four frozen Browser fixtures bind only explicitly eligible sides and preserve original gate and every source byte', async t => {
  for (const [sample, eligible] of [['matrix', ['baseline', 'target']], ['target-unavailable', ['baseline']],
    ['baseline-unavailable', ['target']], ['assertion-failed', []]]) {
    for (const side of ['baseline', 'target']) await t.test(sample + ':' + side, async t => {
      const f = await fixture(t, sample, side), original = files(f.dir), before = f.store.read();
      if (!eligible.includes(side)) {
        await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f)), 'SOURCE_NOT_ELIGIBLE', 409, 'SOURCE_SELECTED_SIDE_NOT_ELIGIBLE');
        assert.deepEqual(files(f.dir), original); return;
      }
      const expected = project(f), result = await f.store.bindBrowserSource(f.project.id, input(f));
      assert.deepEqual(Object.keys(result).sort(), ['binding', 'event', 'executionReady', 'generationId', 'preview', 'revision']);
      assert.match(result.binding.id, /^ax-[0-9a-f-]{36}$/); assert.equal(result.generationId, before.generationId);
      assert.equal(result.revision, before.revision + 1); assert.equal(result.executionReady, false);
      assert.deepEqual(browserBindingProjectionOf(result.binding), expected.projection); assert.deepEqual(result.preview, expected.preview);
      assert.equal(result.binding.projectId, f.project.id); assert.equal(result.binding.releaseId, f.release.id);
      assert.equal(result.event.kind, 'browser-source-bound'); assert.equal(result.event.entityId, result.binding.id);
      assert.equal(result.event.entityDigest, hashAcceptanceValue(result.binding)); assert.equal(result.event.at, result.binding.boundAt);
      assert.equal(result.event.projectId, f.project.id); assert.equal(result.event.revision, result.revision);
      assert.deepEqual(f.store.read().events.slice(0, -1), before.events); assert.deepEqual(f.store.read().runBindings, {});
      assert.deepEqual(f.store.read().candidates, {}); assert.deepEqual(f.store.read().approvals, {}); assert.deepEqual(f.store.read().selections, {});
      noCapabilities(result); assert.equal(JSON.stringify(result).includes(f.root), false);
      assert.deepEqual(files(f.dir), original); assert.equal(result.preview.sourceGate, parse(join(f.dir, 'report.json')).gate);
      const snapshot = tree(f.root), read = f.store.readBrowserSourceBinding(f.project.id, result.binding.id);
      assert.deepEqual(read.binding, result.binding); assert.deepEqual(read.preview, expected.preview);
      assert.deepEqual(read.diagnostics, { eligible: true, contentMatches: true, issues: [] }); assert.equal(read.executionReady, false);
      noCapabilities(read); assert.deepEqual(tree(f.root), snapshot);
      const restarted = createAcceptanceCatalogStore({ root: f.root, owner: f.owner }); await restarted.initialize({ createSchemaVersion: 3 });
      assert.deepEqual(restarted.read().browserSourceBindings[result.binding.id], result.binding);
      assert.deepEqual(restarted.readBrowserSourceBinding(f.project.id, result.binding.id), read); assert.deepEqual(tree(f.root), snapshot);
    });
  }
});

test('mirror source mode is preserved separately from Browser binding kind', async t => {
  const f = await fixture(t);
  reseal(f, (manifest, report) => { manifest.mode = manifest.plan.mode = report.mode = 'mirror'; report.planFingerprint = hash(JSON.stringify(manifest.plan)); });
  const expected = project(f), sourceBefore = files(f.dir), result = await f.store.bindBrowserSource(f.project.id, input(f));
  assert.equal(result.binding.source.sourceMode, 'mirror'); assert.equal(Object.hasOwn(result.binding, 'mode'), false);
  assert.deepEqual(browserBindingProjectionOf(result.binding), expected.projection); assert.deepEqual(files(f.dir), sourceBefore);
});

test('side is mandatory and binding inputs cannot inject projections, authority or hooks', async t => {
  const f = await fixture(t); let hooks = 0;
  const base = input(f), missing = { ...base }; delete missing.sourceSide;
  const getter = { ...base }; Object.defineProperty(getter, 'sourceSide', { enumerable: true, get() { hooks++; return 'baseline'; } });
  const hidden = { ...base }; Object.defineProperty(hidden, 'preview', { value: {}, enumerable: false });
  for (const value of [missing, { ...base, sourceSide: 'source' }, { ...base, sourceSide: null }, getter, hidden,
    ...['projection', 'contentDigest', 'preview', 'sourceMode', 'entryUrl', 'actor', 'bindingId', 'plan'].map(key => ({ ...base, [key]: 'injected' })),
    { ...base, [Symbol('side')]: 'baseline' }, new Proxy(base, { ownKeys() { hooks++; throw new Error('proxy hook'); } })]) {
    await unchanged(f, () => f.store.bindBrowserSource(f.project.id, value), 'INVALID_INPUT', 400);
  }
  assert.equal(hooks, 0);
});

test('project and release existence and ownership are checked before reading source PNGs', async t => {
  const f = await fixture(t), other = await projectRelease(f, f.release.targetUrl);
  renameSync(f.dir, f.dir + '-retained');
  await unchanged(f, () => f.store.bindBrowserSource(uid('ap'), input(f)), 'NOT_FOUND', 404);
  await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f, f.side, { id: uid('ar') })), 'NOT_FOUND', 404);
  await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f, f.side, other.release)), 'PROJECT_MISMATCH');
});

test('full normalized planned entry URL including ordered query is required rather than origin or observed route URL', async t => {
  const f = await fixture(t, 'baseline-unavailable', 'target'), original = parse(join(f.dir, 'manifest.json')).plan.targetUrl;
  const exact = original + '?revision=one&build=two'; replaceTargetEntry(f, exact);
  const projected = project(f); assert.equal(projected.projection.source.entryUrl, exact);
  assert.ok(projected.preview.observations.every(item => item.observedFinalUrl !== exact));
  for (const targetUrl of [new URL(exact).origin, original + '/different', original,
    original + '?revision=changed&build=two', original + '?build=two&revision=one', projected.preview.observations[0].observedFinalUrl]) {
    const release = (await f.store.createRelease(f.project.id, { ...cas(f), label: '故意不匹配', targetUrl })).release;
    await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f, 'target', release)), 'PROJECT_MISMATCH');
  }
  const release = (await f.store.createRelease(f.project.id, { ...cas(f), label: '完整入口一致', targetUrl: exact })).release;
  const result = await f.store.bindBrowserSource(f.project.id, input(f, 'target', release)); assert.equal(result.binding.source.entryUrl, exact);
});

test('global run-and-side uniqueness survives new CAS and different projects or releases', async t => {
  const f = await fixture(t), result = await f.store.bindBrowserSource(f.project.id, input(f));
  const other = await projectRelease(f, f.release.targetUrl), sibling = (await f.store.createRelease(f.project.id,
    { ...cas(f), label: '相同 URL 的独立版本', targetUrl: f.release.targetUrl })).release;
  for (const [projectId, release] of [[f.project.id, f.release], [other.project.id, other.release], [f.project.id, sibling]]) {
    await unchanged(f, () => f.store.bindBrowserSource(projectId, input(f, f.side, release)), 'CONTEXT_ALREADY_BOUND');
  }
  assert.deepEqual(Object.keys(f.store.read().browserSourceBindings), [result.binding.id]);
});

test('baseline and target sides of one run may belong to independent projects and versions', async t => {
  const f = await fixture(t, 'matrix'), baseline = await f.store.bindBrowserSource(f.project.id, input(f));
  const targetContext = await projectRelease(f, parse(join(f.dir, 'manifest.json')).plan.targetUrl);
  const target = await f.store.bindBrowserSource(targetContext.project.id, input(f, 'target', targetContext.release));
  assert.notEqual(baseline.binding.projectId, target.binding.projectId); assert.notEqual(baseline.binding.releaseId, target.binding.releaseId);
  assert.equal(Object.keys(f.store.read().browserSourceBindings).length, 2); assert.deepEqual(f.store.read().runBindings, {});
  assert.notEqual(baseline.binding.sourceContentDigest, target.binding.sourceContentDigest);
  await unchanged(f, () => f.store.bindBrowserSource(targetContext.project.id, input(f, 'baseline', targetContext.release)), 'CONTEXT_ALREADY_BOUND');
});

test('legacy target first requires exact project and release IDs for later Browser target', async t => {
  for (const context of ['same', 'other-project', 'other-release']) await t.test(context, async t => {
    const f = await fixture(t, 'baseline-unavailable', 'target');
    await f.store.bindRun(f.project.id, { ...cas(f), runId: f.runId, releaseId: f.release.id });
    if (context === 'same') { const result = await f.store.bindBrowserSource(f.project.id, input(f)); assert.equal(result.binding.releaseId, f.release.id); return; }
    const other = context === 'other-project' ? await projectRelease(f, f.release.targetUrl)
      : { project: f.project, release: (await f.store.createRelease(f.project.id, { ...cas(f), label: '相同 URL', targetUrl: f.release.targetUrl })).release };
    renameSync(f.dir, f.dir + '-retained');
    await unchanged(f, () => f.store.bindBrowserSource(other.project.id, input(f, 'target', other.release)), 'PROJECT_MISMATCH');
  });
});

test('Browser target first fences later legacy target even if the source manifest later advertises Spec', async t => {
  for (const context of ['same', 'other-project', 'other-release', 'later-spec']) await t.test(context, async t => {
    const f = await fixture(t, 'baseline-unavailable', 'target'); await f.store.bindBrowserSource(f.project.id, input(f));
    if (context === 'same') { await f.store.bindRun(f.project.id, { ...cas(f), runId: f.runId, releaseId: f.release.id }); return; }
    const other = context === 'other-release'
      ? { project: f.project, release: (await f.store.createRelease(f.project.id, { ...cas(f), label: '独立同 URL', targetUrl: f.release.targetUrl })).release }
      : await projectRelease(f, f.release.targetUrl);
    if (context === 'later-spec') {
      const manifest = parse(join(f.dir, 'manifest.json')); manifest.mode = 'spec';
      manifest.plan = normalizeSpecPlan({ name: '替代的 Spec 元数据', mode: 'spec', targetUrl: f.release.targetUrl,
        spec: { approved: false, source: { id: 'REQ-REPLACED', revision: '1', type: 'manual' },
          checks: [{ id: 'HEALTH', title: '独立 Spec 元数据', method: 'GET', path: '/health', severity: 'high', expect: { status: 200 } }] } });
      put(join(f.dir, 'manifest.json'), manifest);
    } else renameSync(f.dir, f.dir + '-retained');
    await unchanged(f, () => f.store.bindRun(other.project.id, { ...cas(f), runId: f.runId, releaseId: other.release.id }), 'PROJECT_MISMATCH');
  });
});

test('a baseline in another project does not block legacy target binding or matching Browser target', async t => {
  const f = await fixture(t, 'matrix'); await f.store.bindBrowserSource(f.project.id, input(f));
  const other = await projectRelease(f, parse(join(f.dir, 'manifest.json')).plan.targetUrl);
  await f.store.bindRun(other.project.id, { ...cas(f), runId: f.runId, releaseId: other.release.id });
  await f.store.bindBrowserSource(other.project.id, input(f, 'target', other.release));
  assert.equal(Object.keys(f.store.read().browserSourceBindings).length, 2); validateAcceptanceCatalog(f.store.read());
});

test('stale CAS rejects without reading absent source and concurrent same-CAS requests commit once', async t => {
  const f = await fixture(t), stale = input(f);
  await f.store.createProject({ ...cas(f), name: '推进 CAS' }); renameSync(f.dir, f.dir + '-retained');
  await unchanged(f, () => f.store.bindBrowserSource(f.project.id, stale), 'STALE_REVISION');
  renameSync(f.dir + '-retained', f.dir);
  const current = input(f), before = f.store.read(), results = await Promise.allSettled([
    f.store.bindBrowserSource(f.project.id, current), f.store.bindBrowserSource(f.project.id, current),
  ]);
  assert.deepEqual(results.map(item => item.status === 'fulfilled' ? 'ok' : item.reason.code), ['ok', 'STALE_REVISION']);
  assert.equal(f.store.read().revision, before.revision + 1); assert.equal(Object.keys(f.store.read().browserSourceBindings).length, 1);
  await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f)), 'CONTEXT_ALREADY_BOUND');
});

test('Browser binding, event and serialized-byte capacities reject before any catalog write', async t => {
  for (const limit of ['browserSourceBindings', 'events', 'jsonBytes']) await t.test(limit, async t => {
    const f = await fixture(t), limits = limit === 'browserSourceBindings' ? { browserSourceBindings: 0 }
      : limit === 'events' ? { events: f.store.read().events.length } : { jsonBytes: head(f).length + 1 };
    f.store = openStore(f, limits); f.writes.length = 0;
    await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f)), 'CATALOG_CAPACITY');
    assert.deepEqual(f.writes, []); assert.deepEqual(f.store.read().browserSourceBindings, {});
  });
});

test('all actual references including the other side and diff remain mandatory even for a healthy selected side', async t => {
  for (const role of ['targetScreenshot', 'baselineScreenshot', 'diff']) await t.test(role, async t => {
    const f = await fixture(t, 'matrix'), report = parse(join(f.dir, 'report.json'));
    const file = report.checks.map(check => check.evidence[role]).find(Boolean); assert.ok(file);
    writeFileSync(join(f.dir, file), Buffer.from('deliberately damaged evidence'));
    await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f)), 'SOURCE_INTEGRITY_FAILED');
  });
});

test('initial ineligible, unfinished, managed and unsupported-verifier sources never create Browser facts', async t => {
  const edits = [
    ['spec', f => { const path = join(f.dir, 'manifest.json'), manifest = parse(path); manifest.mode = 'spec'; put(path, manifest); }, 'SOURCE_NOT_ELIGIBLE'],
    ['running', f => { const path = join(f.dir, 'manifest.json'), manifest = parse(path); manifest.status = 'running'; put(path, manifest); }, 'SOURCE_INTEGRITY_FAILED'],
    ['managed marker', f => { const path = join(f.dir, 'manifest.json'), manifest = parse(path); manifest.managed = false; put(path, manifest); }, 'SOURCE_NOT_ELIGIBLE'],
    ['unknown verifier', f => reseal(f, (_manifest, report) => { report.verifierFingerprint = 'b'.repeat(64); }), 'SOURCE_NOT_ELIGIBLE'],
  ];
  for (const [name, edit, code] of edits) await t.test(name, async t => {
    const f = await fixture(t); edit(f); await unchanged(f, () => f.store.bindBrowserSource(f.project.id, input(f)), code);
    assert.deepEqual(f.store.read().browserSourceBindings, {});
  });
});

test('post-previous guard rejects coherent plan and evidence rewrites that remain eligible but change the complete projection', async t => {
  for (const [name, rewrite] of [['plan', rewritePlanName], ['evidence', rewriteEvidenceBytes]]) await t.test(name, async t => {
    const f = await fixture(t), original = files(f.dir), initial = project(f).projection;
    rewrite(f); const replacement = files(f.dir), altered = project(f).projection;
    assert.notDeepEqual(altered, initial); assert.notEqual(altered.contentDigest, initial.contentDigest);
    assert.equal(readBrowserCandidateSource(f.runId, { root: f.root, owner: f.owner }).snapshot.integrity.valid, true);
    restore(f.dir, original); const before = head(f); let injected, fired = false;
    f.afterPrevious = () => { fired = true; restore(f.dir, replacement); injected = tree(f.root); };
    await assert.rejects(f.store.bindBrowserSource(f.project.id, input(f)), safeFailure('BASELINE_CHANGED', 409, 'BROWSER_SOURCE_CHANGED'));
    assert.equal(fired, true); assert.deepEqual(head(f), before); assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), before);
    assert.deepEqual(tree(f.root), injected); assert.deepEqual(f.writes, ['catalog.previous.json']);
    assert.deepEqual(f.store.read().browserSourceBindings, {}); assert.deepEqual(project(f).projection, altered);
  });
});

test('post-previous guard refuses broken evidence, missing run and changed managed namespace without publishing head', async t => {
  for (const kind of ['evidence', 'missing-run', 'managed-namespace']) await t.test(kind, async t => {
    const f = await fixture(t), before = head(f); let injected;
    f.afterPrevious = () => {
      if (kind === 'evidence') writeFileSync(join(f.dir, 'report.json'), '{broken');
      if (kind === 'missing-run') renameSync(f.dir, f.dir + '-retained');
      if (kind === 'managed-namespace') {
        const namespace = join(f.root, 'managed-spec-dispatches', 'v1'); mkdirSync(namespace, { recursive: true }); put(join(namespace, uid('ao') + '.json'), {});
      }
      injected = tree(f.root);
    };
    await assert.rejects(f.store.bindBrowserSource(f.project.id, input(f)), safeFailure('BASELINE_CHANGED', 409, 'BROWSER_SOURCE_CHANGED'));
    assert.deepEqual(head(f), before); assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), before);
    assert.deepEqual(tree(f.root), injected); assert.deepEqual(f.writes, ['catalog.previous.json']);
    assert.deepEqual(f.store.read().browserSourceBindings, {});
  });
});

test('between-capture byte-identical run reconstruction remains within the content guard contract', async t => {
  const f = await fixture(t), expected = project(f), before = f.store.read(), original = files(f.dir); let fired = false;
  f.afterPrevious = () => {
    fired = true; renameSync(f.dir, f.dir + '-retained'); cpSync(f.dir + '-retained', f.dir, { recursive: true });
  };
  const result = await f.store.bindBrowserSource(f.project.id, input(f));
  assert.equal(fired, true); assert.equal(result.revision, before.revision + 1);
  assert.deepEqual(browserBindingProjectionOf(result.binding), expected.projection);
  assert.deepEqual(files(f.dir), original); assert.deepEqual(files(f.dir + '-retained'), original);
  assert.deepEqual(f.writes, ['catalog.previous.json', 'catalog.json']);
});

test('post-previous owner loss and root replacement retain 503 rather than source-changed 409', async t => {
  for (const kind of ['owner', 'root']) await t.test(kind, async t => {
    const f = await fixture(t), before = head(f); let injected;
    f.afterPrevious = () => {
      if (kind === 'owner') f.owner.release();
      else { const moved = join(f.parent, 'original-root'); renameSync(f.root, moved); cpSync(moved, f.root, { recursive: true }); }
      injected = tree(f.root);
    };
    await assert.rejects(f.store.bindBrowserSource(f.project.id, input(f)), error => {
      assert.equal(error.status, 503); assert.notEqual(error.code, 'BASELINE_CHANGED'); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
    });
    assert.deepEqual(head(f), before); assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), before);
    assert.deepEqual(tree(f.root), injected); assert.deepEqual(f.writes, ['catalog.previous.json']);
  });
});

test('method-shaped fake owners cannot grant Browser source authority and lost real owners reject binding and query', async t => {
  const f = await fixture(t), binding = (await f.store.bindBrowserSource(f.project.id, input(f))).binding;
  const forged = createAcceptanceCatalogStore({ root: f.root, owner: { root: f.root, assertOwned() {} } });
  const current = { ...cas(f), runId: f.runId, sourceSide: 'target', releaseId: f.release.id };
  await unchanged(f, () => forged.bindBrowserSource(f.project.id, current), 'ACCEPTANCE_OWNER_UNAVAILABLE', 503);
  assert.throws(() => forged.readBrowserSourceBinding(f.project.id, binding.id), safeFailure('ACCEPTANCE_OWNER_UNAVAILABLE', 503));
  f.owner.release(); const before = tree(f.root);
  await assert.rejects(f.store.bindBrowserSource(f.project.id, input(f)), safeFailure('ACCEPTANCE_OWNER_LOST', 503));
  assert.throws(() => f.store.readBrowserSourceBinding(f.project.id, binding.id), safeFailure('ACCEPTANCE_OWNER_LOST', 503));
  assert.deepEqual(tree(f.root), before);
});

test('single-binding reads return safe diagnostics while retaining history and writing no directories or bytes', async t => {
  for (const kind of ['coherent-change', 'corruption', 'missing']) await t.test(kind, async t => {
    const f = await fixture(t), binding = (await f.store.bindBrowserSource(f.project.id, input(f))).binding;
    if (kind === 'coherent-change') rewritePlanName(f);
    if (kind === 'corruption') writeFileSync(join(f.dir, 'report.json'), '{private-fs-message');
    if (kind === 'missing') renameSync(f.dir, f.dir + '-retained');
    const before = tree(f.root), writes = f.writes.length, current = f.store.read(), result = f.store.readBrowserSourceBinding(f.project.id, binding.id);
    assert.deepEqual(result.binding, binding); assert.equal(result.preview, null); assert.equal(result.executionReady, false);
    assert.equal(result.diagnostics.eligible, false); assert.equal(result.diagnostics.contentMatches, false);
    assert.deepEqual(result.diagnostics.issues.map(issue => issue.code), ['BASELINE_CHANGED']);
    assert.equal(/[A-Z]:\\|\/tmp\/|private-fs-message|ENOENT/.test(JSON.stringify(result)), false);
    assert.deepEqual(f.store.read(), current); assert.deepEqual(tree(f.root), before); assert.equal(f.writes.length, writes); noCapabilities(result);
  });
});

test('single-binding lookup rejects wrong context and never revalidates every unrelated stored source', async t => {
  const f = await fixture(t), first = (await f.store.bindBrowserSource(f.project.id, input(f))).binding;
  const original = join(FIXTURES, 'baseline-unavailable'), manifest = parse(join(original, 'manifest.json')), secondDir = join(f.root, manifest.runId);
  cpSync(original, secondDir, { recursive: true });
  const other = await projectRelease(f, manifest.plan.targetUrl);
  const second = (await f.store.bindBrowserSource(other.project.id, { ...cas(f), runId: manifest.runId, sourceSide: 'target', releaseId: other.release.id })).binding;
  writeFileSync(join(secondDir, 'report.json'), 'unavailable unrelated source'); const before = tree(f.root);
  assert.deepEqual(f.store.read().browserSourceBindings[second.id], second);
  assert.equal(f.store.readBrowserSourceBinding(f.project.id, first.id).diagnostics.eligible, true);
  assert.throws(() => f.store.readBrowserSourceBinding(f.project.id, second.id), safeFailure('PROJECT_MISMATCH'));
  assert.throws(() => f.store.readBrowserSourceBinding(uid('ap'), first.id), safeFailure('NOT_FOUND', 404));
  assert.throws(() => f.store.readBrowserSourceBinding(f.project.id, uid('ax')), safeFailure('NOT_FOUND', 404));
  assert.deepEqual(tree(f.root), before);
});

test('Browser source facts do not authorize Browser candidate, approval, selection or managed execution', async t => {
  const f = await fixture(t), binding = (await f.store.bindBrowserSource(f.project.id, input(f))).binding;
  await unchanged(f, () => f.store.createBaselineCandidate(f.project.id, { ...cas(f), mode: 'browser', sourceRunId: f.runId, sourceSide: 'baseline' }), 'INVALID_INPUT', 400);
  await unchanged(f, () => f.store.createBaselineCandidate(f.project.id, { ...cas(f), mode: 'spec', sourceRunId: f.runId, sourceSide: 'source' }), 'SOURCE_NOT_ELIGIBLE');
  await unchanged(f, () => f.store.approveBaseline(f.project.id, { ...cas(f), candidateId: binding.id, contentDigest: binding.sourceContentDigest, reason: '来源归属不是批准' }), 'INVALID_INPUT', 400);
  await unchanged(f, () => f.store.selectBaseline(f.project.id, { ...cas(f), mode: 'browser', approvalId: null, contentDigest: null, reason: '来源不是选用' }), 'INVALID_INPUT', 400);
  const before = head(f), previous = readFileSync(join(f.root, 'catalog.previous.json')), sourceBefore = files(f.dir);
  const beforeRuns = readdirSync(f.root).filter(name => name.startsWith('ac-')).sort();
  await assert.rejects(f.store.prepareManagedSpecDispatch(f.project.id, { ...cas(f), operationId: uid('ao'), selectionId: uid('as'),
    contentDigest: binding.sourceContentDigest, targetReleaseId: f.release.id }), safeFailure('BASELINE_CHANGED'));
  assert.deepEqual(head(f), before); assert.deepEqual(readFileSync(join(f.root, 'catalog.previous.json')), previous);
  assert.deepEqual(files(f.dir), sourceBefore); assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('ac-')).sort(), beforeRuns);
  assert.deepEqual(currentSelectionsOf(f.store.read(), f.project.id), { spec: null });
  // Existing private preparation initializes this empty namespace before checking Spec selection.
  assert.deepEqual(readdirSync(join(f.root, 'managed-spec-dispatches', 'v1')), []);
});

test('Spec candidate, approval, cancel, reselect and private preparation remain independent of Browser bindings', async t => {
  const f = await fixture(t), browser = (await f.store.bindBrowserSource(f.project.id, input(f))).binding;
  const release = (await f.store.createRelease(f.project.id, { ...cas(f), label: 'Spec 来源', targetUrl: 'http://127.0.0.1:1/spec?version=1' })).release;
  const target = (await f.store.createRelease(f.project.id, { ...cas(f), label: 'Spec 明确目标', targetUrl: 'http://127.0.0.1:2/spec?version=2' })).release;
  const plan = normalizeSpecPlan({ mode: 'spec', name: '不联网的独立 Spec 草稿', targetUrl: release.targetUrl,
    spec: { approved: false, source: { id: 'REQ-BROWSER-ISOLATION', revision: '1', type: 'manual' },
      checks: [{ id: 'HEALTH', title: '健康检查', method: 'GET', path: '/health', severity: 'high', expect: { status: 200 } }] } });
  const run = createAcceptanceRun(plan, { root: f.root }), dir = acceptanceRunDir(run.runId, f.root);
  finishAcceptanceRun(run.runId, await runSpecAcceptance(plan, { runId: run.runId, outputDir: dir }), { root: f.root });
  await f.store.bindRun(f.project.id, { ...cas(f), runId: run.runId, releaseId: release.id });
  const candidate = (await f.store.createBaselineCandidate(f.project.id, { ...cas(f), mode: 'spec', sourceRunId: run.runId, sourceSide: 'source' })).candidate;
  const approval = (await f.store.approveBaseline(f.project.id, { ...cas(f), candidateId: candidate.id, contentDigest: candidate.contentDigest, reason: '复核 Spec 合同' })).approval;
  const select = () => f.store.selectBaseline(f.project.id, { ...cas(f), mode: 'spec', approvalId: approval.id, contentDigest: approval.contentDigest, reason: '明确选用 Spec' });
  await select();
  await f.store.selectBaseline(f.project.id, { ...cas(f), mode: 'spec', approvalId: null, contentDigest: null, reason: '明确取消 Spec' });
  const selected = (await select()).selection, beforeRuns = readdirSync(f.root).filter(name => name.startsWith('ac-')).sort(), catalogBefore = head(f);
  const prepared = await f.store.prepareManagedSpecDispatch(f.project.id, { ...cas(f), operationId: uid('ao'), selectionId: selected.id,
    contentDigest: candidate.contentDigest, targetReleaseId: target.id });
  assert.equal(prepared.record.envelope.candidate.source.runId, run.runId); assert.equal(prepared.executionReady, false);
  assert.equal(prepared.runCreated, false); assert.deepEqual(head(f), catalogBefore);
  assert.deepEqual(readdirSync(f.root).filter(name => name.startsWith('ac-')).sort(), beforeRuns);
  assert.deepEqual(f.store.read().browserSourceBindings[browser.id], browser); assert.equal(f.store.readBaselineCandidate(f.project.id, candidate.id).diagnostics.eligible, true);
  assert.equal(currentSelectionsOf(f.store.read(), f.project.id).spec.id, selected.id); validateAcceptanceCatalog(f.store.read());
});
