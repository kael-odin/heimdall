/** Bounded versioned project metadata; immutable runs remain outside the catalog. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ACCEPTANCE_ROOT } from './store.mjs';
import { hashAcceptanceValue } from './identity.mjs';
import { writeAtomicFileSync } from './atomic-file.mjs';
import { writeExclusiveCatalogFileSync } from './catalog-preimage.mjs';
import { readSpecCandidateSource } from './candidate-source.mjs';
import { projectSpecBaselineCandidate } from './candidate-projection.mjs';
import { ACCEPTANCE_CATALOG_LIMITS, AcceptanceCatalogError, error, invalid, unavailable, fields, id, url,
  limitsOf, capacity, plain, iso, boundedText, validateAcceptanceCatalog, buildCatalogMigration,
  candidateProjectionOf, currentSelectionsOf } from './catalog-schema.mjs';

export { ACCEPTANCE_CATALOG_LIMITS, AcceptanceCatalogError, validateAcceptanceCatalog };
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const MODES = new Set(['mirror', 'regression', 'spec']);
const GATES = new Set(['passed', 'failed', 'blocked', 'needs_review']);
const ACTOR = Object.freeze({ kind: 'local-operator' });
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(a) === pathKey(b);
const within = (root, file) => { const rel = relative(root, file); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const entityMaps = ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'migrations'];

/** Both inputs have already passed their own strict schema validators. */
function hasHistoryPrefix(previous, current) {
  if (previous.revision > current.revision
    || hashAcceptanceValue(previous.events) !== hashAcceptanceValue(current.events.slice(0, previous.revision))) return false;
  for (const key of entityMaps) {
    for (const [entityId, entity] of Object.entries(previous[key] ?? {})) {
      if (!Object.hasOwn(current[key] ?? {}, entityId) || hashAcceptanceValue(entity) !== hashAcceptanceValue(current[key][entityId])) return false;
    }
  }
  return true;
}
function validatePredecessor(current, previous) {
  if (!previous) return;
  const head = current.catalog, prior = previous.catalog;
  if (head.schemaVersion === prior.schemaVersion) {
    if (head.generationId !== prior.generationId || !hasHistoryPrefix(prior, head)
      || head.schemaVersion === 2 && hashAcceptanceValue(head.migrations) !== hashAcceptanceValue(prior.migrations)) unavailable('CATALOG_PREVIOUS_NOT_ANCESTOR');
    return;
  }
  if (head.schemaVersion === 2 && prior.schemaVersion === 1) {
    const migration = Object.values(head.migrations)[0];
    if (!migration || migration.fromGenerationId !== prior.generationId || migration.fromRevision !== prior.revision
      || migration.sourceHeadSha256 !== sha256(previous.bytes) || !hasHistoryPrefix(prior, head)) unavailable('CATALOG_MIGRATION_PREIMAGE_MISMATCH');
    return;
  }
  unavailable('CATALOG_PREVIOUS_SCHEMA_MISMATCH');
}

function inputOf(input, allowed) {
  fields(input, ['expectedGenerationId', 'expectedRevision', ...allowed], ['expectedGenerationId', 'expectedRevision', ...allowed.filter(key => key !== 'buildRef')], invalid);
  id(input.expectedGenerationId, 'ag');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) invalid('expectedRevision 必须是非负安全整数。');
  return { ...input };
}
const missing = entity => { throw error('NOT_FOUND', 404, `${entity}不存在。`); };

/** The supplied owner must fence engine startup/recovery as well as these writes. */
export function createAcceptanceCatalogStore({ root = ACCEPTANCE_ROOT, owner, limits: inputLimits = {},
  writeAtomic = writeAtomicFileSync, writeExclusive = writeExclusiveCatalogFileSync } = {}) {
  if (typeof root !== 'string' || !root.trim() || typeof writeAtomic !== 'function'
    || typeof writeExclusive !== 'function') throw new TypeError('Invalid catalog store options');
  const limits = limitsOf(inputLimits), rootPath = resolve(root);
  let pinnedRoot, pinnedIdentity, pending = 0, tail = Promise.resolve();
  function assertOwned() {
    if (!owner || typeof owner.assertOwned !== 'function') throw error('ACCEPTANCE_OWNER_UNAVAILABLE', 503, '项目目录没有可用的写入所有者。');
    try { owner.assertOwned(); }
    catch (cause) {
      if (cause?.status === 503 && typeof cause.code === 'string') throw cause;
      throw error('ACCEPTANCE_OWNER_UNAVAILABLE', 503, '项目目录写入所有权已失效。');
    }
  }
  function actualRoot(create = false) {
    try {
      if (create && !existsSync(rootPath)) mkdirSync(rootPath, { recursive: true });
      const actual = realpathSync(rootPath), stat = statSync(actual, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}`;
      if (!stat.isDirectory() || pinnedRoot && (!samePath(pinnedRoot, actual) || pinnedIdentity !== identity)
        || owner?.root && !samePath(resolve(owner.root), actual)) unavailable('ROOT_CHANGED');
      pinnedRoot ??= actual; pinnedIdentity ??= identity;
      return actual;
    } catch (cause) { if (cause instanceof AcceptanceCatalogError) throw cause; unavailable('ROOT_UNAVAILABLE'); }
  }
  function safeFile(name, { optional = false } = {}) {
    const base = actualRoot(), file = join(base, name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync(file), file)) unavailable('INVALID_CATALOG_PATH');
      return { file, stat };
    } catch (cause) {
      if (cause instanceof AcceptanceCatalogError) throw cause;
      if (cause?.code === 'ENOENT' && optional) return { file, stat: null };
      unavailable('CATALOG_FILE_UNAVAILABLE');
    }
  }
  function readFile(name, { optional = false } = {}) {
    const { file, stat } = safeFile(name, { optional });
    if (!stat) return null;
    if (stat.size > limits.jsonBytes) unavailable('CATALOG_BYTES_EXCEEDED');
    try {
      const bytes = readFileSync(file);
      if (bytes.length > limits.jsonBytes) unavailable('CATALOG_BYTES_EXCEEDED');
      return { bytes, catalog: validateAcceptanceCatalog(JSON.parse(bytes.toString('utf8')), { limits }) };
    } catch (cause) { if (cause instanceof AcceptanceCatalogError) throw cause; unavailable('CATALOG_UNREADABLE'); }
  }
  function queue(operation) {
    if (pending >= limits.queue) return Promise.reject(error('CATALOG_QUEUE_FULL', 503, '项目目录写入队列已满，请稍后重试。'));
    pending++;
    const task = tail.then(operation);
    tail = task.catch(() => {});
    return task.finally(() => { pending--; });
  }
  function write(name, content) {
    const { file } = safeFile(name, { optional: true });
    assertOwned();
    try { writeAtomic(file, content); }
    catch { unavailable('CATALOG_WRITE_FAILED'); }
  }
  function requireCurrent(catalog) {
    if (catalog.schemaVersion !== 2) unavailable('MIGRATION_REQUIRED');
    return catalog;
  }
  function read() { return requireCurrent(readFile('catalog.json').catalog); }
  function checkUnchanged(name, expected) {
    const current = readFile(name, { optional: !expected });
    if (!!current !== !!expected || current && !current.bytes.equals(expected.bytes)) {
      throw error('STALE_REVISION', 409, '项目目录字节已变化，请刷新后重新操作。');
    }
  }
  function commit(current, previous, bytes, preCommitGuard) {
    assertOwned(); actualRoot();
    checkUnchanged('catalog.json', current);
    checkUnchanged('catalog.previous.json', previous);
    write('catalog.previous.json', current.bytes);
    assertOwned(); actualRoot();
    preCommitGuard?.();
    checkUnchanged('catalog.json', current);
    checkUnchanged('catalog.previous.json', current);
    write('catalog.json', bytes);
  }
  function preflightPreimages(sources) {
    const names = new Set(readdirSync(actualRoot()).filter(file => /^catalog\.v1\.[a-f0-9]{64}\.json$/.test(file)));
    for (const source of sources.filter(Boolean)) {
      const name = `catalog.v1.${sha256(source.bytes)}.json`;
      const existing = readFile(name, { optional: true });
      if (existing && !existing.bytes.equals(source.bytes)) unavailable('MIGRATION_PREIMAGE_MISMATCH');
      names.add(name);
    }
    if (names.size > 2) unavailable('MIGRATION_PREIMAGE_CAPACITY');
  }
  function preservePreimage(source) {
    if (!source) return;
    assertOwned(); actualRoot();
    const name = `catalog.v1.${sha256(source.bytes)}.json`;
    const existing = readFile(name, { optional: true });
    if (existing) {
      if (!existing.bytes.equals(source.bytes)) unavailable('MIGRATION_PREIMAGE_MISMATCH');
      return;
    }
    const { file } = safeFile(name, { optional: true });
    assertOwned();
    try { writeExclusive(file, source.bytes); }
    catch (cause) {
      if (cause?.code !== 'EEXIST') unavailable('MIGRATION_PREIMAGE_WRITE_FAILED');
    }
    const published = readFile(name);
    if (!published.bytes.equals(source.bytes)) unavailable('MIGRATION_PREIMAGE_MISMATCH');
  }
  function migrate(current) {
    const previous = readFile('catalog.previous.json', { optional: true });
    validatePredecessor(current, previous);
    const catalog = buildCatalogMigration(current.catalog, { headSha256: sha256(current.bytes),
      previousSha256: previous ? sha256(previous.bytes) : null, limits });
    const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
    if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录升级超过容量上限；原记录已保留。', { limit: 'jsonBytes' });
    preflightPreimages([current, previous]);
    assertOwned(); actualRoot();
    checkUnchanged('catalog.json', current);
    checkUnchanged('catalog.previous.json', previous);
    preservePreimage(current); preservePreimage(previous);
    commit(current, previous, bytes);
    const committed = readFile('catalog.json');
    if (!committed.bytes.equals(bytes)) unavailable('MIGRATION_COMMIT_CHANGED');
    return requireCurrent(committed.catalog);
  }
  async function initialize() {
    return queue(() => {
      assertOwned(); actualRoot(true);
      if (safeFile('catalog.json', { optional: true }).stat) {
        const current = readFile('catalog.json');
        return current.catalog.schemaVersion === 1 ? migrate(current) : requireCurrent(current.catalog);
      }
      if (readdirSync(actualRoot()).some(name => name.startsWith('catalog.'))) unavailable('MISSING_CATALOG_WITH_RECOVERY_MATERIAL');
      const catalog = { schemaVersion: 2, generationId: 'ag-' + randomUUID(), revision: 0, projects: {}, releases: {}, runBindings: {},
        candidates: {}, approvals: {}, selections: {}, migrations: {}, events: [] };
      const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
      if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限。', { limit: 'jsonBytes' });
      validateAcceptanceCatalog(catalog, { limits }); assertOwned(); write('catalog.json', bytes);
      return catalog;
    });
  }
  function readRunReference(runId) {
    id(runId, 'ac');
    const base = actualRoot(), dir = join(base, runId), manifestFile = join(dir, 'manifest.json');
    let manifest;
    const sourceFail = reason => { throw error('SOURCE_INTEGRITY_FAILED', 409, '运行元数据无效，不能建立归属。', { reason }); };
    try {
      if (!existsSync(dir)) missing('运行');
      const actualDir = realpathSync(dir);
      if (!within(base, actualDir) || !statSync(actualDir).isDirectory()) sourceFail('SOURCE_PATH_INVALID');
      let stat;
      try { stat = lstatSync(manifestFile); } catch (cause) { if (cause.code === 'ENOENT') missing('运行'); throw cause; }
      if (!stat.isFile() || stat.isSymbolicLink() || !within(actualDir, realpathSync(manifestFile))) sourceFail('SOURCE_PATH_INVALID');
      if (stat.size > limits.manifestBytes) sourceFail('MANIFEST_BUDGET');
      const bytes = readFileSync(manifestFile);
      if (bytes.length > limits.manifestBytes) sourceFail('MANIFEST_BUDGET');
      manifest = JSON.parse(bytes.toString('utf8'));
    } catch (cause) {
      if (cause instanceof AcceptanceCatalogError) throw cause;
      sourceFail('MANIFEST_UNREADABLE');
    }
    if (!plain(manifest) || manifest.schemaVersion !== 1 || manifest.runId !== runId || !MODES.has(manifest.mode)
      || !boundedText(manifest.name, 120) || !iso(manifest.createdAt) || !GATES.has(manifest.gate)) sourceFail('INVALID_MANIFEST');
    const targetUrl = url(manifest.targetUrl, sourceFail);
    if (!TERMINAL.has(manifest.status)) {
      if (manifest.status !== 'running') sourceFail('INVALID_RUN_STATUS');
      throw error('SOURCE_NOT_ELIGIBLE', 409, '请等待运行结束后再建立归属。');
    }
    if (manifest.status !== 'completed' && manifest.gate !== 'blocked') sourceFail('INVALID_TERMINAL_GATE');
    if (manifest.plan !== undefined && (!plain(manifest.plan)
      || manifest.plan.mode !== manifest.mode || url(manifest.plan.targetUrl, sourceFail) !== targetUrl)) sourceFail('MANIFEST_PLAN_MISMATCH');
    const issues = [{ code: 'REPORT_EVIDENCE_NOT_VERIFIED', message: '本次仅核对运行元数据并建立组织归属，未验证报告内容或证据。' }];
    let reportPresent = false;
    try {
      const reportFile = join(dir, 'report.json'), stat = lstatSync(reportFile);
      reportPresent = stat.isFile() && !stat.isSymbolicLink() && within(realpathSync(dir), realpathSync(reportFile));
    } catch { /* A missing/inaccessible report does not invalidate valid organizational metadata. */ }
    const reportDigestRecorded = HASH.test(manifest.reportSha256 ?? '');
    if (!reportPresent) issues.push({ code: 'REPORT_UNAVAILABLE', message: '原报告缺失或不可读取；运行归属不证明验收结论。' });
    if (!reportDigestRecorded) issues.push({ code: 'REPORT_DIGEST_UNAVAILABLE', message: '旧记录未保存有效报告摘要；需要重新运行才能获得可验证快照。' });
    return { source: { runId, name: manifest.name, mode: manifest.mode, status: manifest.status, gate: manifest.gate, createdAt: manifest.createdAt, targetUrl },
      diagnostics: { scope: 'manifest-only', manifestValid: true, reportPresent, reportDigestRecorded, evidenceVerified: false, issues } };
  }
  function mutate(input, operation) {
    return queue(() => {
      assertOwned();
      const current = readFile('catalog.json');
      requireCurrent(current.catalog);
      if (input.expectedGenerationId !== current.catalog.generationId || input.expectedRevision !== current.catalog.revision) {
        throw error('STALE_REVISION', 409, '项目目录已变化，请刷新后重新操作。', { generationId: current.catalog.generationId, revision: current.catalog.revision });
      }
      const catalog = JSON.parse(JSON.stringify(current.catalog));
      const at = new Date().toISOString(), result = operation(catalog, at);
      catalog.revision++;
      const entity = result.project ?? result.release ?? result.binding ?? result.candidate ?? result.approval ?? result.selection;
      const event = { id: 'ae-' + randomUUID(), revision: catalog.revision, kind: result.kind,
        projectId: result.project?.id ?? entity.projectId, entityId: entity.id ?? entity.runId,
        entityDigest: hashAcceptanceValue(entity), at, actor: { ...ACTOR } };
      catalog.events.push(event);
      capacity(catalog, limits, limit => { throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit }); });
      const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
      if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit: 'jsonBytes' });
      validateAcceptanceCatalog(catalog, { limits });
      const previous = readFile('catalog.previous.json', { optional: true });
      validatePredecessor(current, previous);
      commit(current, previous, bytes, result.preCommitGuard);
      const { kind: _kind, preCommitGuard: _guard, ...payload } = result;
      return { generationId: catalog.generationId, revision: catalog.revision, ...payload, event };
    });
  }
  function createProject(raw) {
    let input;
    try {
      input = inputOf(raw, ['name']);
      if (typeof input.name !== 'string' || !boundedText(input.name.trim(), 120)) invalid('项目名称必须为 1..120 个字符。');
      input.name = input.name.trim();
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      const project = { id: 'ap-' + randomUUID(), name: input.name, createdAt: at };
      catalog.projects[project.id] = project;
      return { kind: 'project-created', project };
    });
  }
  function createRelease(projectId, raw) {
    let input;
    try {
      id(projectId, 'ap'); input = inputOf(raw, ['label', 'targetUrl', 'buildRef']);
      if (typeof input.label !== 'string' || !boundedText(input.label.trim(), 120)) invalid('版本名称必须为 1..120 个字符。');
      input.label = input.label.trim(); input.targetUrl = url(input.targetUrl, invalid);
      if (Object.hasOwn(input, 'buildRef')) {
        if (typeof input.buildRef !== 'string' || !boundedText(input.buildRef.trim(), 200)) invalid('buildRef 必须为 1..200 个字符。');
        input.buildRef = input.buildRef.trim();
      }
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
      const release = { id: 'ar-' + randomUUID(), projectId, label: input.label, targetUrl: input.targetUrl,
        ...(Object.hasOwn(input, 'buildRef') ? { buildRef: input.buildRef } : {}), createdAt: at };
      catalog.releases[release.id] = release;
      return { kind: 'release-created', release };
    });
  }
  function bindRun(projectId, raw) {
    let input;
    try { id(projectId, 'ap'); input = inputOf(raw, ['runId', 'releaseId']); id(input.runId, 'ac'); id(input.releaseId, 'ar'); }
    catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
      const release = catalog.releases[input.releaseId];
      if (!release) missing('版本');
      if (release.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '所选版本不属于当前项目。');
      if (Object.hasOwn(catalog.runBindings, input.runId)) throw error('CONTEXT_ALREADY_BOUND', 409, '该运行已有明确归属，不能重新绑定。');
      const reference = readRunReference(input.runId);
      if (reference.source.targetUrl !== release.targetUrl) throw error('PROJECT_MISMATCH', 409, '运行的完整目标 URL 与所选版本不一致。');
      const binding = { runId: input.runId, projectId, releaseId: release.id, boundAt: at, actor: { ...ACTOR } };
      catalog.runBindings[input.runId] = binding;
      return { kind: 'run-bound', binding, ...reference };
    });
  }
  function reasonOf(input) {
    if (typeof input.reason !== 'string' || !boundedText(input.reason.trim(), 1000)) invalid('操作理由必须为 1..1000 个字符。');
    input.reason = input.reason.trim();
  }
  function digestOf(value) {
    if (typeof value !== 'string' || !HASH.test(value)) invalid('contentDigest 必须是候选预览中的 SHA-256。');
  }
  function projectSource(catalog, projectId, runId) {
    if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
    const binding = catalog.runBindings[runId];
    if (!binding) throw error('SOURCE_NOT_ELIGIBLE', 409, '请先将来源运行明确归属本项目的版本。', { reason: 'SOURCE_NOT_BOUND' });
    if (binding.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '来源运行不属于当前项目。');
    assertOwned(); actualRoot();
    const material = readSpecCandidateSource(runId, { root: actualRoot(), owner });
    const release = catalog.releases[binding.releaseId];
    const sourceUrl = url(material.snapshot.manifest.targetUrl, () => { throw error('SOURCE_INTEGRITY_FAILED', 409,
      '来源目标地址无效。', { reason: 'SOURCE_TARGET_INVALID' }); });
    if (sourceUrl !== release.targetUrl) {
      throw error('BASELINE_CHANGED', 409, '来源目标与已归属版本不一致。', { reason: 'SOURCE_RELEASE_CHANGED' });
    }
    const result = projectSpecBaselineCandidate(material, { projectId, releaseId: binding.releaseId, sourceSide: 'source' });
    assertOwned(); actualRoot();
    return result;
  }
  function revalidateCandidate(catalog, candidate) {
    const result = projectSource(catalog, candidate.projectId, candidate.source.runId);
    if (hashAcceptanceValue(result.projection) !== hashAcceptanceValue(candidateProjectionOf(candidate))) {
      throw error('BASELINE_CHANGED', 409, '候选来源内容已变化，请重新创建并复核候选。', { reason: 'CANDIDATE_SOURCE_CHANGED' });
    }
    return result;
  }
  function findCandidate(catalog, projectId, candidateId) {
    if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
    const candidate = catalog.candidates[candidateId];
    if (!candidate) missing('候选');
    if (candidate.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '候选不属于当前项目。');
    return candidate;
  }
  function createBaselineCandidate(projectId, raw) {
    let input;
    try {
      id(projectId, 'ap'); input = inputOf(raw, ['mode', 'sourceRunId', 'sourceSide']); id(input.sourceRunId, 'ac');
      if (input.mode !== 'spec' || input.sourceSide !== 'source') invalid('当前只支持 Spec 需求来源候选。');
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      const { projection, preview } = projectSource(catalog, projectId, input.sourceRunId);
      const candidate = { id: 'ab-' + randomUUID(), ...projection, createdAt: at };
      catalog.candidates[candidate.id] = candidate;
      return { kind: 'candidate-created', candidate, preview, executionReady: false,
        preCommitGuard: () => revalidateCandidate(catalog, candidate) };
    });
  }
  function readBaselineCandidate(projectId, candidateId) {
    id(projectId, 'ap'); id(candidateId, 'ab');
    const catalog = read(), candidate = findCandidate(catalog, projectId, candidateId);
    const common = { generationId: catalog.generationId, revision: catalog.revision, candidate, executionReady: false };
    try {
      const { preview } = revalidateCandidate(catalog, candidate);
      return { ...common, preview, diagnostics: { eligible: true, contentMatches: true, issues: [] } };
    } catch (cause) {
      if (cause?.status === 503) throw cause;
      const code = ['BASELINE_CHANGED', 'SOURCE_NOT_ELIGIBLE', 'SOURCE_INTEGRITY_FAILED'].includes(cause?.code)
        ? cause.code : 'SOURCE_UNAVAILABLE';
      return { ...common, preview: null, diagnostics: { eligible: false, contentMatches: false,
        issues: [{ code, message: '当前来源无法重建此候选；历史记录保留，请检查原运行或创建新候选。' }] } };
    }
  }
  function approveBaseline(projectId, raw) {
    let input;
    try {
      id(projectId, 'ap'); input = inputOf(raw, ['candidateId', 'contentDigest', 'reason']);
      id(input.candidateId, 'ab'); digestOf(input.contentDigest); reasonOf(input);
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      const candidate = findCandidate(catalog, projectId, input.candidateId);
      if (candidate.contentDigest !== input.contentDigest) throw error('BASELINE_CHANGED', 409, '请使用完整预览中当前候选的摘要。');
      revalidateCandidate(catalog, candidate);
      const approval = { id: 'aa-' + randomUUID(), projectId, candidateId: candidate.id,
        contentDigest: candidate.contentDigest, reason: input.reason, approvedAt: at, actor: { ...ACTOR } };
      catalog.approvals[approval.id] = approval;
      return { kind: 'baseline-approved', approval, executionReady: false,
        preCommitGuard: () => revalidateCandidate(catalog, candidate) };
    });
  }
  function selectBaseline(projectId, raw) {
    let input;
    try {
      id(projectId, 'ap'); input = inputOf(raw, ['mode', 'approvalId', 'contentDigest', 'reason']); reasonOf(input);
      if (input.mode !== 'spec') invalid('当前只支持 Spec 基线选用。');
      if (input.approvalId === null) { if (input.contentDigest !== null) invalid('取消选用时 contentDigest 必须为 null。'); }
      else { id(input.approvalId, 'aa'); digestOf(input.contentDigest); }
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
      const previous = currentSelectionsOf(catalog, projectId).spec;
      if ((previous?.approvalId ?? null) === input.approvalId) throw error('SELECTION_UNCHANGED', 409, '当前选用未变化，无需重复提交。');
      let candidate = null;
      if (input.approvalId !== null) {
        const approval = catalog.approvals[input.approvalId];
        if (!approval) missing('批准');
        if (approval.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '批准不属于当前项目。');
        if (approval.contentDigest !== input.contentDigest) throw error('BASELINE_CHANGED', 409, '选用摘要与批准不一致。');
        candidate = findCandidate(catalog, projectId, approval.candidateId);
        revalidateCandidate(catalog, candidate);
      }
      const selection = { id: 'as-' + randomUUID(), projectId, mode: 'spec', approvalId: input.approvalId,
        previousSelectionId: previous?.id ?? null, reason: input.reason, selectedAt: at, actor: { ...ACTOR } };
      catalog.selections[selection.id] = selection;
      return { kind: 'baseline-selected', selection, executionReady: false,
        ...(candidate ? { preCommitGuard: () => revalidateCandidate(catalog, candidate) } : {}) };
    });
  }
  return Object.freeze({ initialize, read, createProject, createRelease, bindRun, readRunReference,
    createBaselineCandidate, readBaselineCandidate, approveBaseline, selectBaseline });
}
