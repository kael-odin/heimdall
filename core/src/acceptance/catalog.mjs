/** Bounded local project/release metadata. It never edits or approves a run. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import { ACCEPTANCE_ROOT } from './store.mjs';
import { normalizeAcceptanceUrl } from './urls.mjs';
import { hashAcceptanceValue } from './identity.mjs';
import { writeAtomicFileSync } from './atomic-file.mjs';

export const ACCEPTANCE_CATALOG_LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, manifestBytes: 8 * 1024 * 1024,
  projects: 64, releases: 1024, runBindings: 4096, events: 8192, queue: 32 });
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDS = Object.fromEntries(['ag', 'ap', 'ar', 'ac', 'ae'].map(prefix => [prefix, new RegExp(`^${prefix}-${UUID}$`)]));
const HASH = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const MODES = new Set(['mirror', 'regression', 'spec']);
const GATES = new Set(['passed', 'failed', 'blocked', 'needs_review']);
const ACTOR = Object.freeze({ kind: 'local-operator' });
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(a) === pathKey(b);
const within = (root, file) => { const rel = relative(root, file); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const iso = value => {
  if (typeof value !== 'string' || value.length !== 24) return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const boundedText = (value, max) => typeof value === 'string' && value.trim() === value && !!value && value.length <= max;

export class AcceptanceCatalogError extends Error {
  constructor(code, status, message, details) {
    super(message);
    this.name = 'AcceptanceCatalogError'; this.code = code; this.status = status;
    if (details) this.details = details;
  }
}
const error = (code, status, message, details) => new AcceptanceCatalogError(code, status, message, details);
const invalid = message => { throw error('INVALID_INPUT', 400, message); };
const unavailable = reason => { throw error('CATALOG_UNAVAILABLE', 503, '项目目录不可用；原记录已保留。', { reason }); };
function fields(value, allowed, required, fail) {
  if (!plain(value)) return fail('INVALID_OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !allowed.includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return fail('INVALID_FIELD');
  }
  if (required.some(key => !Object.hasOwn(descriptors, key))) return fail('MISSING_FIELD');
}
const id = (value, prefix, fail = invalid) => IDS[prefix].test(typeof value === 'string' ? value : '') || fail('运行或目录 ID 无效。');
function actor(value, fail) {
  fields(value, ['kind'], ['kind'], fail);
  if (value.kind !== 'local-operator') fail('INVALID_ACTOR');
}
function url(value, fail) {
  try { return normalizeAcceptanceUrl(value); } catch { return fail('URL 必须是无凭据、无片段的完整 HTTP(S) 地址。'); }
}
function limitsOf(input) {
  fields(input, Object.keys(ACCEPTANCE_CATALOG_LIMITS), [], () => { throw new TypeError('Invalid catalog limits'); });
  const limits = { ...ACCEPTANCE_CATALOG_LIMITS, ...input };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0) || limits.queue < 1) throw new TypeError('Invalid catalog limits');
  return limits;
}
function capacity(catalog, limits, fail) {
  for (const key of ['projects', 'releases', 'runBindings', 'events']) {
    const count = key === 'events' ? catalog.events.length : Object.keys(catalog[key]).length;
    if (count > limits[key]) fail(key);
  }
}

/** Strict B1 schema; future approval/managed fields are deliberately unsupported. */
export function validateAcceptanceCatalog(catalog, { limits: inputLimits = {} } = {}) {
  const limits = limitsOf(inputLimits), fail = unavailable;
  fields(catalog, ['schemaVersion', 'generationId', 'revision', 'projects', 'releases', 'runBindings', 'events'],
    ['schemaVersion', 'generationId', 'revision', 'projects', 'releases', 'runBindings', 'events'], fail);
  if (catalog.schemaVersion !== 1) fail('UNSUPPORTED_SCHEMA');
  id(catalog.generationId, 'ag', fail);
  if (!Number.isSafeInteger(catalog.revision) || catalog.revision < 0) fail('INVALID_REVISION');
  for (const key of ['projects', 'releases', 'runBindings']) if (!plain(catalog[key])) fail('INVALID_MAP');
  if (!Array.isArray(catalog.events)) fail('INVALID_EVENTS');
  capacity(catalog, limits, () => fail('CAPACITY_EXCEEDED'));
  const { projects, releases, runBindings, events } = catalog;
  for (const [key, project] of Object.entries(projects)) {
    id(key, 'ap', fail); fields(project, ['id', 'name', 'createdAt'], ['id', 'name', 'createdAt'], fail);
    if (project.id !== key || !boundedText(project.name, 120) || !iso(project.createdAt)) fail('INVALID_PROJECT');
  }
  for (const [key, release] of Object.entries(releases)) {
    id(key, 'ar', fail); fields(release, ['id', 'projectId', 'label', 'targetUrl', 'buildRef', 'createdAt'],
      ['id', 'projectId', 'label', 'targetUrl', 'createdAt'], fail);
    id(release.projectId, 'ap', fail);
    if (release.id !== key || !Object.hasOwn(projects, release.projectId) || !boundedText(release.label, 120)
      || !iso(release.createdAt) || url(release.targetUrl, fail) !== release.targetUrl
      || Object.hasOwn(release, 'buildRef') && !boundedText(release.buildRef, 200)) fail('INVALID_RELEASE');
  }
  for (const [key, binding] of Object.entries(runBindings)) {
    id(key, 'ac', fail); fields(binding, ['runId', 'projectId', 'releaseId', 'boundAt', 'actor'], ['runId', 'projectId', 'releaseId', 'boundAt', 'actor'], fail);
    id(binding.projectId, 'ap', fail); id(binding.releaseId, 'ar', fail); actor(binding.actor, fail);
    if (binding.runId !== key || !Object.hasOwn(projects, binding.projectId) || !Object.hasOwn(releases, binding.releaseId)
      || releases[binding.releaseId].projectId !== binding.projectId || !iso(binding.boundAt)) fail('INVALID_BINDING');
  }
  if (events.length !== catalog.revision || events.length !== Object.keys(projects).length + Object.keys(releases).length + Object.keys(runBindings).length) fail('EVENT_HISTORY_MISMATCH');
  const eventIds = new Set(), entities = new Set(), seenProjects = new Set(), seenReleases = new Set();
  for (const [index, event] of events.entries()) {
    fields(event, ['id', 'revision', 'kind', 'projectId', 'entityId', 'entityDigest', 'at', 'actor'],
      ['id', 'revision', 'kind', 'projectId', 'entityId', 'entityDigest', 'at', 'actor'], fail);
    id(event.id, 'ae', fail); id(event.projectId, 'ap', fail); actor(event.actor, fail);
    if (event.revision !== index + 1 || eventIds.has(event.id) || entities.has(event.entityId) || !HASH.test(event.entityDigest) || !iso(event.at)) fail('INVALID_EVENT');
    let entity;
    if (event.kind === 'project-created') {
      entity = projects[event.entityId];
      if (!entity || entity.id !== event.projectId) fail('INVALID_EVENT_REFERENCE');
      seenProjects.add(entity.id);
    } else if (event.kind === 'release-created') {
      entity = releases[event.entityId];
      if (!entity || entity.projectId !== event.projectId || !seenProjects.has(entity.projectId)) fail('INVALID_EVENT_REFERENCE');
      seenReleases.add(entity.id);
    } else if (event.kind === 'run-bound') {
      entity = runBindings[event.entityId];
      if (!entity || entity.projectId !== event.projectId || !seenReleases.has(entity.releaseId)) fail('INVALID_EVENT_REFERENCE');
    } else fail('INVALID_EVENT_KIND');
    if ((entity.createdAt ?? entity.boundAt) !== event.at || hashAcceptanceValue(entity) !== event.entityDigest) fail('ENTITY_HISTORY_MISMATCH');
    eventIds.add(event.id); entities.add(event.entityId);
  }
  return catalog;
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
  writeAtomic = writeAtomicFileSync } = {}) {
  if (typeof root !== 'string' || !root.trim() || typeof writeAtomic !== 'function') throw new TypeError('Invalid catalog store options');
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
  function readFile(name) {
    const { file, stat } = safeFile(name);
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
    try { writeAtomic(file, content); }
    catch { unavailable('CATALOG_WRITE_FAILED'); }
  }
  function read() { return readFile('catalog.json').catalog; }
  async function initialize() {
    return queue(() => {
      assertOwned(); actualRoot(true);
      if (safeFile('catalog.json', { optional: true }).stat) return read();
      if (readdirSync(actualRoot()).some(name => name.startsWith('catalog.'))) unavailable('MISSING_CATALOG_WITH_RECOVERY_MATERIAL');
      const catalog = { schemaVersion: 1, generationId: 'ag-' + randomUUID(), revision: 0, projects: {}, releases: {}, runBindings: {}, events: [] };
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
      if (input.expectedGenerationId !== current.catalog.generationId || input.expectedRevision !== current.catalog.revision) {
        throw error('STALE_REVISION', 409, '项目目录已变化，请刷新后重新操作。', { generationId: current.catalog.generationId, revision: current.catalog.revision });
      }
      const catalog = JSON.parse(JSON.stringify(current.catalog));
      const at = new Date().toISOString(), result = operation(catalog, at);
      catalog.revision++;
      const entity = result.project ?? result.release ?? result.binding;
      const event = { id: 'ae-' + randomUUID(), revision: catalog.revision, kind: result.kind,
        projectId: result.project?.id ?? entity.projectId, entityId: entity.id ?? entity.runId,
        entityDigest: hashAcceptanceValue(entity), at, actor: { ...ACTOR } };
      catalog.events.push(event);
      capacity(catalog, limits, limit => { throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit }); });
      const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
      if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit: 'jsonBytes' });
      validateAcceptanceCatalog(catalog, { limits }); assertOwned();
      if (!readFile('catalog.json').bytes.equals(current.bytes)) throw error('STALE_REVISION', 409, '项目目录字节已变化，请刷新后重新操作。');
      if (safeFile('catalog.previous.json', { optional: true }).stat) readFile('catalog.previous.json');
      write('catalog.previous.json', current.bytes);
      assertOwned(); write('catalog.json', bytes);
      const { kind: _kind, ...payload } = result;
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
  return Object.freeze({ initialize, read, createProject, createRelease, bindRun, readRunReference });
}
