/** Bounded versioned project metadata; immutable runs remain outside the catalog. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync,
  openSync, closeSync, fstatSync, readSync, opendirSync, constants as fsConstants } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { types } from 'node:util';
import { ACCEPTANCE_ROOT } from './store.mjs';
import { hashAcceptanceValue } from './identity.mjs';
import { writeAtomicFileSync } from './atomic-file.mjs';
import { writeExclusiveCatalogFileSync } from './catalog-preimage.mjs';
import { assertAcceptanceOwner } from './owner.mjs';
import { readSpecCandidateSource } from './candidate-source.mjs';
import { projectSpecBaselineCandidate } from './candidate-projection.mjs';
import { readBrowserCandidateSource } from './browser-candidate-source.mjs';
import { projectBrowserBaselineCandidate } from './browser-candidate-projection.mjs';
import { buildBrowserCandidateReview, assertBrowserCandidateEnvelope } from './browser-candidate-review.mjs';
import { compileFixedBrowserContract } from './browser-fixed-contract.mjs';
import { prepareManagedSpecContract } from './managed-spec-plan.mjs';
import { createManagedSpecDispatchStore } from './managed-dispatch-store.mjs';
import { managedSpecDispatchRequestFingerprint } from './managed-dispatch-schema.mjs';
import { createAcceptanceReadScope, captureAcceptanceRunFile } from './managed-run-reader.mjs';
import { ACCEPTANCE_CATALOG_LIMITS, AcceptanceCatalogError, error, invalid, unavailable, fields, id, url,
  limitsOf, capacity, plain, iso, boundedText, validateAcceptanceCatalog, buildCatalogMigration, buildCatalogMigrationV3, buildCatalogMigrationV4,
  candidateProjectionOf, currentSelectionsOf, browserBindingProjectionOf } from './catalog-schema.mjs';

export { ACCEPTANCE_CATALOG_LIMITS, AcceptanceCatalogError, validateAcceptanceCatalog };
const HASH = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^ao-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const MODES = new Set(['mirror', 'regression', 'spec']);
const GATES = new Set(['passed', 'failed', 'blocked', 'needs_review']);
const ACTOR = Object.freeze({ kind: 'local-operator' });
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const samePath = (a, b) => pathKey(a) === pathKey(b);
const within = (root, file) => { const rel = relative(root, file); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const entityMaps = ['projects', 'releases', 'runBindings', 'candidates', 'approvals', 'selections', 'migrations', 'browserSourceBindings', 'browserCandidates'];
const MIGRATION_BUILDERS = Object.freeze({ 1: buildCatalogMigration, 2: buildCatalogMigrationV3, 3: buildCatalogMigrationV4 });
const MAINTENANCE_ROOT_ENTRIES = 4096;
const sameFileStat = (a, b) => ['dev', 'ino', 'size', 'nlink', 'mode', 'mtimeNs', 'ctimeNs', 'birthtimeNs'].every(key => a[key] === b[key]);

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
      || head.schemaVersion >= 2 && hashAcceptanceValue(head.migrations) !== hashAcceptanceValue(prior.migrations)) unavailable('CATALOG_PREVIOUS_NOT_ANCESTOR');
    return;
  }
  if (head.schemaVersion === prior.schemaVersion + 1 && [2, 3, 4].includes(head.schemaVersion)) {
    const migration = Object.values(head.migrations).find(value => value.fromSchemaVersion === prior.schemaVersion
      && value.toSchemaVersion === head.schemaVersion);
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
const nativePromise = Promise, nativePromisePrototype = Promise.prototype, nativeThen = Promise.prototype.then;
const nativeSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species).get;
function consumeAdmissionPromise(value) {
  if (types.isPromise(value) && Object.getPrototypeOf(value) === nativePromisePrototype
    && !Object.getOwnPropertyDescriptor(value, 'constructor')
    && Object.getOwnPropertyDescriptor(nativePromisePrototype, 'constructor')?.value === nativePromise
    && Object.getOwnPropertyDescriptor(nativePromise, Symbol.species)?.get === nativeSpecies) nativeThen.call(value, undefined, () => {});
}

/** The supplied owner must fence engine startup/recovery as well as these writes. */
export function createAcceptanceCatalogStore({ root = ACCEPTANCE_ROOT, owner, limits: inputLimits = {},
  writeAtomic = writeAtomicFileSync, writeExclusive = writeExclusiveCatalogFileSync, managedDispatchOptions = {} } = {}) {
  if (typeof root !== 'string' || !root.trim() || typeof writeAtomic !== 'function'
    || typeof writeExclusive !== 'function') throw new TypeError('Invalid catalog store options');
  const limits = limitsOf(inputLimits), rootPath = resolve(root);
  let pinnedRoot, pinnedIdentity, pending = 0, tail = Promise.resolve(), managedDispatches;
  function assertOwned() {
    if (!owner || typeof owner.assertOwned !== 'function') throw error('ACCEPTANCE_OWNER_UNAVAILABLE', 503, '项目目录没有可用的写入所有者。');
    try { owner.assertOwned(); }
    catch (cause) {
      if (cause?.status === 503 && typeof cause.code === 'string') throw cause;
      throw error('ACCEPTANCE_OWNER_UNAVAILABLE', 503, '项目目录写入所有权已失效。');
    }
  }
  function assertMaintenanceOwned() {
    // The brand check precedes all reflection on a caller-supplied owner.
    assertAcceptanceOwner(owner);
    actualRoot();
  }
  function readMaintenanceFile(name, { optional = false } = {}) {
    assertMaintenanceOwned();
    const { file, stat } = safeFile(name, { optional });
    if (!stat) return null;
    let descriptor;
    try {
      const before = lstatSync(file, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size > BigInt(limits.jsonBytes)) unavailable('INVALID_CATALOG_PATH');
      descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
      if (!sameFileStat(before, fstatSync(descriptor, { bigint: true }))) unavailable('CATALOG_FILE_CHANGED');
      const chunks = []; let size = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limits.jsonBytes + 1 - size));
        const count = readSync(descriptor, chunk, 0, chunk.length, null);
        if (!count) break;
        size += count;
        if (size > limits.jsonBytes) unavailable('CATALOG_BYTES_EXCEEDED');
        chunks.push(chunk.subarray(0, count));
      }
      if (BigInt(size) !== before.size || !sameFileStat(before, fstatSync(descriptor, { bigint: true }))
        || !sameFileStat(before, lstatSync(file, { bigint: true })) || !samePath(realpathSync(file), file)) unavailable('CATALOG_FILE_CHANGED');
      const bytes = Buffer.concat(chunks, size);
      const catalog = validateAcceptanceCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), { limits });
      assertMaintenanceOwned();
      return { bytes, catalog };
    } catch (cause) {
      assertMaintenanceOwned();
      if (cause instanceof AcceptanceCatalogError) throw cause;
      unavailable('CATALOG_UNREADABLE');
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  function maintenanceNames() {
    assertMaintenanceOwned();
    const names = [], directory = opendirSync(actualRoot()); let count = 0;
    try {
      let entry;
      while ((entry = directory.readSync())) {
        if (++count > MAINTENANCE_ROOT_ENTRIES) unavailable('MIGRATION_ROOT_ENTRY_CAPACITY');
        if (/^catalog\.v[0-9]+\..*\.json$/.test(entry.name)) names.push(entry.name);
      }
    } finally { directory.closeSync(); }
    assertMaintenanceOwned();
    return { names: names.sort(), count };
  }
  function inventoryItem(name, source) {
    return { name, schemaVersion: source.catalog.schemaVersion, bytes: source.bytes.length, sha256: sha256(source.bytes) };
  }
  function preimageInventory() {
    const { names } = maintenanceNames(), inventory = [], counts = new Map([1, 2, 3].map(version => [version, 0]));
    for (const name of names) {
      const match = /^catalog\.v([123])\.([a-f0-9]{64})\.json$/.exec(name);
      if (!match) unavailable('MIGRATION_PREIMAGE_NAME_INVALID');
      const source = readMaintenanceFile(name);
      if (source.catalog.schemaVersion !== Number(match[1]) || sha256(source.bytes) !== match[2]) unavailable('MIGRATION_PREIMAGE_MISMATCH');
      counts.set(Number(match[1]), counts.get(Number(match[1])) + 1);
      if (counts.get(Number(match[1])) > 2) unavailable('MIGRATION_PREIMAGE_CAPACITY');
      inventory.push(inventoryItem(name, source));
    }
    if (hashAcceptanceValue(names) !== hashAcceptanceValue(maintenanceNames().names)) unavailable('MIGRATION_PREIMAGE_CHANGED');
    return inventory;
  }
  function checkInventory(expected) {
    const sorted = [...expected.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (hashAcceptanceValue(preimageInventory()) !== hashAcceptanceValue(sorted)) {
      throw error('STALE_REVISION', 409, '目录前像已变化，请重新预览迁移计划。');
    }
  }
  function checkMaintenanceUnchanged(name, expected) {
    const current = readMaintenanceFile(name, { optional: !expected });
    if (!!current !== !!expected || current && !current.bytes.equals(expected.bytes)) {
      throw error('STALE_REVISION', 409, '项目目录字节已变化，请刷新后重新操作。');
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
    if (![3, 4].includes(catalog.schemaVersion)) unavailable('MIGRATION_REQUIRED');
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
  function preimageName(source) {
    if (![1, 2, 3].includes(source.catalog.schemaVersion)) unavailable('MIGRATION_PREIMAGE_SCHEMA');
    return `catalog.v${source.catalog.schemaVersion}.${sha256(source.bytes)}.json`;
  }
  function preflightPreimages(sources) {
    const inventory = preimageInventory(), names = new Map([1, 2, 3].map(version => [version, new Set()]));
    for (const item of inventory) names.get(item.schemaVersion).add(item.name);
    for (const source of sources.filter(Boolean)) {
      const name = preimageName(source);
      const existing = readMaintenanceFile(name, { optional: true });
      if (existing && !existing.bytes.equals(source.bytes)) unavailable('MIGRATION_PREIMAGE_MISMATCH');
      names.get(source.catalog.schemaVersion).add(name);
    }
    if ([...names.values()].some(values => values.size > 2)) unavailable('MIGRATION_PREIMAGE_CAPACITY');
    return inventory;
  }
  function preservePreimage(source) {
    if (!source) return;
    assertMaintenanceOwned();
    const name = preimageName(source);
    const existing = readMaintenanceFile(name, { optional: true });
    if (existing) {
      if (!existing.bytes.equals(source.bytes)) unavailable('MIGRATION_PREIMAGE_MISMATCH');
      return;
    }
    const { file } = safeFile(name, { optional: true });
    assertMaintenanceOwned();
    try { writeExclusive(file, source.bytes); }
    catch (cause) {
      if (cause?.code !== 'EEXIST') unavailable('MIGRATION_PREIMAGE_WRITE_FAILED');
    }
    const published = readMaintenanceFile(name);
    if (!published.bytes.equals(source.bytes)) unavailable('MIGRATION_PREIMAGE_MISMATCH');
  }
  function migrateOne(current, expectedInventory) {
    assertMaintenanceOwned();
    const previous = readMaintenanceFile('catalog.previous.json', { optional: true });
    validatePredecessor(current, previous);
    const buildMigration = MIGRATION_BUILDERS[current.catalog.schemaVersion];
    if (!buildMigration) unavailable('MIGRATION_REQUIRED');
    const catalog = buildMigration(current.catalog, { headSha256: sha256(current.bytes),
      previousSha256: previous ? sha256(previous.bytes) : null, limits });
    const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
    if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录升级超过容量上限；原记录已保留。', { limit: 'jsonBytes' });
    preflightPreimages([current, previous]);
    checkInventory(expectedInventory);
    assertMaintenanceOwned();
    checkUnchanged('catalog.json', current);
    checkUnchanged('catalog.previous.json', previous);
    for (const source of [current, previous].filter(Boolean)) {
      preservePreimage(source);
      expectedInventory.set(preimageName(source), inventoryItem(preimageName(source), source));
      checkInventory(expectedInventory);
    }
    commit(current, previous, bytes, () => {
      assertMaintenanceOwned(); checkInventory(expectedInventory);
      checkMaintenanceUnchanged('catalog.json', current);
      checkMaintenanceUnchanged('catalog.previous.json', current);
    });
    assertMaintenanceOwned();
    const committed = readMaintenanceFile('catalog.json');
    if (!committed.bytes.equals(bytes)) unavailable('MIGRATION_COMMIT_CHANGED');
    // Each step is independent. Only a new explicit preview/confirmation may
    // continue after interruption; ordinary initialization never migrates.
    validatePredecessor(committed, readMaintenanceFile('catalog.previous.json', { optional: true }));
    return committed;
  }
  function migrationTarget(input) {
    fields(input, ['targetSchemaVersion'], ['targetSchemaVersion'], invalid);
    if (input.targetSchemaVersion !== 4) invalid('迁移目标必须明确为格式4。');
  }
  function migrationPlan(current, previous) {
    validatePredecessor(current, previous);
    const currentRootEntries = maintenanceNames().count;
    const inventory = preimageInventory(), known = new Map(inventory.map(item => [item.name, item]));
    const preimages = [1, 2, 3].map(schemaVersion => ({ schemaVersion, existingCount: inventory.filter(item => item.schemaVersion === schemaVersion).length,
      requiredNewCount: 0, maximumCount: 2, sources: [] }));
    function reserve(source, origin, generated = false) {
      if (!source) return;
      const version = source.catalog.schemaVersion, plan = preimages[version - 1];
      if (!plan) unavailable('MIGRATION_PREIMAGE_SCHEMA');
      const name = preimageName(source);
      // Future step IDs/times are deliberately absent from the confirmation
      // identity. Reserve a slot; its exact filename is known only on publish.
      if (generated) {
        plan.requiredNewCount++;
        plan.sources.push({ origin, bytes: source.bytes.length, filename: 'resolved-at-apply' });
      } else if (!plan.sources.some(item => item.name === name)) {
        plan.sources.push({ origin, name, bytes: source.bytes.length, sha256: sha256(source.bytes), alreadyPresent: known.has(name) });
        if (!known.has(name)) { plan.requiredNewCount++; known.set(name, inventoryItem(name, source)); }
      }
      if (plan.existingCount + plan.requiredNewCount > plan.maximumCount) unavailable('MIGRATION_PREIMAGE_CAPACITY');
    }
    let simulated = current, prior = previous;
    const steps = [];
    while (simulated.catalog.schemaVersion < 4) {
      const from = simulated.catalog.schemaVersion, buildMigration = MIGRATION_BUILDERS[from];
      if (!buildMigration) unavailable('MIGRATION_REQUIRED');
      if (!steps.length) { reserve(simulated, 'head'); reserve(prior, 'previous'); }
      else reserve(simulated, 'step-' + steps.length + '-head', true);
      const catalog = buildMigration(simulated.catalog, { headSha256: sha256(simulated.bytes),
        previousSha256: prior ? sha256(prior.bytes) : null, at: '2000-01-01T00:00:00.000Z', limits });
      const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
      if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录升级超过容量上限；原记录已保留。', { limit: 'jsonBytes' });
      steps.push({ fromSchemaVersion: from, toSchemaVersion: catalog.schemaVersion,
        fromRevision: simulated.catalog.revision, revision: catalog.revision, projectedJsonBytes: bytes.length,
        addedMaps: from === 1 ? ['candidates', 'approvals', 'selections', 'migrations'] : from === 2 ? ['browserSourceBindings'] : ['browserCandidates'],
        addedMigrationCount: 1, addedEventCount: 1 });
      prior = simulated; simulated = { bytes, catalog };
    }
    const source = { schemaVersion: current.catalog.schemaVersion, generationId: current.catalog.generationId,
      revision: current.catalog.revision, headSha256: sha256(current.bytes), headBytes: current.bytes.length,
      previousSha256: previous ? sha256(previous.bytes) : null, previousBytes: previous?.bytes.length ?? null };
    // Reserve the whole chain before publishing any recovery material. Both
    // exclusive-link and atomic-rename writers briefly need one extra name.
    const requiredNewEntries = preimages.reduce((sum, item) => sum + item.requiredNewCount, 0)
      + (steps.length && !previous ? 1 : 0);
    const rootEntries = { currentCount: currentRootEntries, requiredNewCount: requiredNewEntries,
      temporaryEntries: steps.length ? 1 : 0, projectedFinalCount: currentRootEntries + requiredNewEntries,
      maximumCount: MAINTENANCE_ROOT_ENTRIES };
    if (rootEntries.projectedFinalCount + rootEntries.temporaryEntries > MAINTENANCE_ROOT_ENTRIES) unavailable('MIGRATION_ROOT_ENTRY_CAPACITY');
    const content = { previewVersion: 1, targetSchemaVersion: 4, changed: steps.length > 0, source, steps, preimages, inventory,
      limits: { ...limits }, capacity: { eligible: true, rootEntries, finalJsonBytes: simulated.bytes.length,
        finalRevision: simulated.catalog.revision, finalMigrationCount: Object.keys(simulated.catalog.migrations).length } };
    checkMaintenanceUnchanged('catalog.json', current);
    checkMaintenanceUnchanged('catalog.previous.json', previous);
    checkInventory(new Map(inventory.map(item => [item.name, item])));
    if (maintenanceNames().count !== currentRootEntries) throw error('STALE_REVISION', 409, '目录条目已变化，请重新预览迁移计划。');
    return { ...content, planDigest: hashAcceptanceValue({ domain: 'heimdall-acceptance-catalog-migration-plan', ...content }), executionReady: false };
  }
  async function previewMigration(input) {
    migrationTarget(input);
    return queue(() => {
      assertMaintenanceOwned();
      const current = readMaintenanceFile('catalog.json'), previous = readMaintenanceFile('catalog.previous.json', { optional: true });
      return migrationPlan(current, previous);
    });
  }
  async function applyMigration(input) {
    const keys = ['targetSchemaVersion', 'expectedGenerationId', 'expectedRevision', 'expectedHeadSha256', 'expectedPreviousSha256', 'expectedPlanDigest'];
    fields(input, keys, keys, invalid);
    const confirmation = { ...input };
    migrationTarget({ targetSchemaVersion: confirmation.targetSchemaVersion });
    id(confirmation.expectedGenerationId, 'ag');
    if (!Number.isSafeInteger(confirmation.expectedRevision) || confirmation.expectedRevision < 0
      || !HASH.test(typeof confirmation.expectedHeadSha256 === 'string' ? confirmation.expectedHeadSha256 : '')
      || !HASH.test(typeof confirmation.expectedPlanDigest === 'string' ? confirmation.expectedPlanDigest : '')
      || confirmation.expectedPreviousSha256 !== null && !HASH.test(typeof confirmation.expectedPreviousSha256 === 'string' ? confirmation.expectedPreviousSha256 : '')) invalid('迁移确认摘要或版本无效。');
    return queue(() => {
      assertMaintenanceOwned();
      let current = readMaintenanceFile('catalog.json');
      const previous = readMaintenanceFile('catalog.previous.json', { optional: true });
      if (confirmation.expectedGenerationId !== current.catalog.generationId || confirmation.expectedRevision !== current.catalog.revision
        || confirmation.expectedHeadSha256 !== sha256(current.bytes)
        || confirmation.expectedPreviousSha256 !== (previous ? sha256(previous.bytes) : null)) {
        throw error('STALE_REVISION', 409, '目录或前像已变化，请重新预览迁移计划。');
      }
      const plan = migrationPlan(current, previous);
      if (confirmation.expectedPlanDigest !== plan.planDigest) throw error('STALE_REVISION', 409, '目录迁移计划已变化，请重新预览后确认。');
      const expectedInventory = new Map(plan.inventory.map(item => [item.name, item])), completedSteps = [];
      while (current.catalog.schemaVersion < 4) {
        const fromSchemaVersion = current.catalog.schemaVersion;
        current = migrateOne(current, expectedInventory);
        completedSteps.push({ fromSchemaVersion, toSchemaVersion: current.catalog.schemaVersion,
          generationId: current.catalog.generationId, revision: current.catalog.revision, headSha256: sha256(current.bytes) });
      }
      assertMaintenanceOwned(); checkInventory(expectedInventory);
      checkMaintenanceUnchanged('catalog.json', current);
      return { catalog: current.catalog, completedSteps, changed: completedSteps.length > 0, executionReady: false };
    });
  }
  async function initialize(options = {}) {
    fields(options, ['createSchemaVersion'], [], invalid);
    const createSchemaVersion = options.createSchemaVersion;
    if (createSchemaVersion !== undefined && ![3, 4].includes(createSchemaVersion)) invalid('新目录必须明确选择格式3或4。');
    return queue(() => {
      assertOwned(); actualRoot(true);
      if (safeFile('catalog.json', { optional: true }).stat) {
        const current = readFile('catalog.json');
        validatePredecessor(current, readFile('catalog.previous.json', { optional: true }));
        return requireCurrent(current.catalog);
      }
      if (readdirSync(actualRoot()).some(name => name.startsWith('catalog.'))) unavailable('MISSING_CATALOG_WITH_RECOVERY_MATERIAL');
      if (createSchemaVersion === undefined) unavailable('CREATION_SCHEMA_REQUIRED');
      const catalog = { schemaVersion: createSchemaVersion, generationId: 'ag-' + randomUUID(), revision: 0, projects: {}, releases: {}, runBindings: {},
        candidates: {}, approvals: {}, selections: {}, migrations: {}, browserSourceBindings: {},
        ...(createSchemaVersion === 4 ? { browserCandidates: {} } : {}), events: [] };
      const bytes = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
      if (bytes.length > limits.jsonBytes) throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限。', { limit: 'jsonBytes' });
      validateAcceptanceCatalog(catalog, { limits }); assertOwned();
      const { file } = safeFile('catalog.json', { optional: true });
      try { writeExclusive(file, bytes); }
      catch (cause) {
        if (cause?.code === 'EEXIST') throw error('STALE_REVISION', 409, '目录已经存在，请打开并核对当前记录。');
        unavailable('CATALOG_WRITE_FAILED');
      }
      assertOwned(); actualRoot();
      if (!readFile('catalog.json').bytes.equals(bytes)) unavailable('CATALOG_COMMIT_CHANGED');
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
      const { kind: _kind, preCommitGuard: _guard, responseGuard: _responseGuard, ...payload } = result;
      const response = { generationId: catalog.generationId, revision: catalog.revision, ...payload, event };
      // A new response contract must be returnable before publishing any bytes.
      result.responseGuard?.(response);
      commit(current, previous, bytes, result.preCommitGuard);
      return response;
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
      assertBrowserTargetContext(catalog, input.runId, projectId, release.id);
      // Managed runs already have a frozen catalog destination. Opening their
      // result reader must not expose the legacy subsequent-binding writer.
      let sourceScope, sourceHead;
      const sourceUnavailable = () => { throw error('SOURCE_INTEGRITY_FAILED', 409, '来源记录无法安全核验，不能建立归属。'); };
      try {
        sourceScope = createAcceptanceReadScope({ root: actualRoot() });
        const manifestBytes = captureAcceptanceRunFile(input.runId, 'manifest.json', { scope: sourceScope });
        const reportBytes = captureAcceptanceRunFile(input.runId, 'report.json', { scope: sourceScope });
        const manifest = manifestBytes ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) : null;
        let report;
        // A malformed legacy report is preserved as opaque captured bytes.
        // Organizational binding remains manifest-only, never evidence proof.
        if (reportBytes) try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(reportBytes)); } catch { /* Diagnostic only. */ }
        sourceHead = sourceScope.classify(input.runId, manifest, report);
      } catch { sourceUnavailable(); }
      if (sourceHead?.kind === 'managed') throw error('SOURCE_NOT_ELIGIBLE', 409, '托管运行已有固定的项目与版本，暂不支持后续认领。');
      const preCommitGuard = () => { try { sourceScope.assertCurrent(); } catch { sourceUnavailable(); } };
      preCommitGuard();
      const reference = readRunReference(input.runId);
      if (reference.source.targetUrl !== release.targetUrl) throw error('PROJECT_MISMATCH', 409, '运行的完整目标 URL 与所选版本不一致。');
      const binding = { runId: input.runId, projectId, releaseId: release.id, boundAt: at, actor: { ...ACTOR } };
      catalog.runBindings[input.runId] = binding;
      return { kind: 'run-bound', binding, ...reference, preCommitGuard };
    });
  }
  function assertBrowserTargetContext(catalog, runId, projectId, releaseId) {
    const target = Object.values(catalog.browserSourceBindings).find(binding => binding.source.runId === runId && binding.source.side === 'target');
    if (target && (target.projectId !== projectId || target.releaseId !== releaseId)) {
      throw error('PROJECT_MISMATCH', 409, '该运行的 Browser 目标来源已有不同的项目或版本归属。');
    }
  }
  function projectBrowserSource(runId, sourceSide) {
    assertOwned(); actualRoot();
    const material = readBrowserCandidateSource(runId, { root: actualRoot(), owner });
    const result = projectBrowserBaselineCandidate(material, { sourceSide });
    assertOwned(); actualRoot();
    return result;
  }
  function revalidateBrowserBinding(catalog, binding) {
    try {
      const result = projectBrowserSource(binding.source.runId, binding.source.side);
      const release = catalog.releases[binding.releaseId];
      if (!release || release.projectId !== binding.projectId || result.projection.source.entryUrl !== release.targetUrl
        || hashAcceptanceValue(result.projection) !== hashAcceptanceValue(browserBindingProjectionOf(binding))) throw new Error('changed');
      return result;
    } catch (cause) {
      if (cause?.status === 503) throw cause;
      throw error('BASELINE_CHANGED', 409, 'Browser 所选来源已变化或无法重建，原归属记录保留。', { reason: 'BROWSER_SOURCE_CHANGED' });
    }
  }
  function bindBrowserSource(projectId, raw) {
    let input;
    try {
      id(projectId, 'ap'); input = inputOf(raw, ['runId', 'sourceSide', 'releaseId']);
      id(input.runId, 'ac'); id(input.releaseId, 'ar');
      if (!['baseline', 'target'].includes(input.sourceSide)) invalid('必须明确选择 Browser 的 baseline 或 target 来源侧。');
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
      const release = catalog.releases[input.releaseId];
      if (!release) missing('版本');
      if (release.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '所选版本不属于当前项目。');
      if (Object.values(catalog.browserSourceBindings).some(binding => binding.source.runId === input.runId && binding.source.side === input.sourceSide)) {
        throw error('CONTEXT_ALREADY_BOUND', 409, '该运行的所选 Browser 来源侧已有明确归属，不能重新绑定。');
      }
      const target = catalog.runBindings[input.runId];
      if (input.sourceSide === 'target' && target && (target.projectId !== projectId || target.releaseId !== release.id)) {
        throw error('PROJECT_MISMATCH', 409, '所选 Browser 目标来源与已有运行归属不一致。');
      }
      const { projection, preview } = projectBrowserSource(input.runId, input.sourceSide);
      if (projection.source.entryUrl !== release.targetUrl) throw error('PROJECT_MISMATCH', 409, '所选 Browser 来源的完整入口 URL 与版本不一致。');
      const { mode: _mode, contentDigest, ...sourceProjection } = projection;
      const binding = { id: 'ax-' + randomUUID(), projectId, releaseId: release.id, ...sourceProjection,
        sourceContentDigest: contentDigest, boundAt: at, actor: { ...ACTOR } };
      catalog.browserSourceBindings[binding.id] = binding;
      return { kind: 'browser-source-bound', binding, preview, executionReady: false,
        preCommitGuard: () => revalidateBrowserBinding(catalog, binding) };
    });
  }
  function readBrowserSourceBinding(projectId, bindingId) {
    id(projectId, 'ap'); id(bindingId, 'ax');
    const catalog = read();
    if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
    const binding = catalog.browserSourceBindings[bindingId];
    if (!binding) missing('Browser 来源归属');
    if (binding.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, 'Browser 来源归属不属于当前项目。');
    const common = { generationId: catalog.generationId, revision: catalog.revision, binding, executionReady: false };
    try {
      const { preview } = revalidateBrowserBinding(catalog, binding);
      return { ...common, preview, diagnostics: { eligible: true, contentMatches: true, issues: [] } };
    } catch (cause) {
      if (cause?.status === 503) throw cause;
      return { ...common, preview: null, diagnostics: { eligible: false, contentMatches: false,
        issues: [{ code: 'BASELINE_CHANGED', message: '当前 Browser 所选来源无法重建已记录内容；历史归属保留，请检查原运行。' }] } };
    }
  }
  function requireBrowserCandidateSchema(catalog) {
    if (catalog.schemaVersion !== 4) throw error('CATALOG_MIGRATION_REQUIRED', 409,
      '请先停止同根引擎，显式预览并确认维护到 Schema4 后再记录 Browser 候选。', { reason: 'SCHEMA4_REQUIRED' });
    return catalog;
  }
  function browserReviewContext(catalog, projectId, sourceBindingId) {
    requireBrowserCandidateSchema(catalog);
    const project = catalog.projects[projectId];
    if (!project) missing('项目');
    const sourceBinding = catalog.browserSourceBindings[sourceBindingId];
    if (!sourceBinding) missing('Browser 来源归属');
    if (sourceBinding.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, 'Browser 来源归属不属于当前项目。');
    const release = catalog.releases[sourceBinding.releaseId];
    if (!release || release.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, 'Browser 来源版本与项目不一致。');
    return { project, release, sourceBinding };
  }
  function materializeBrowserReview(catalog, projectId, sourceBindingId) {
    const context = browserReviewContext(catalog, projectId, sourceBindingId);
    try {
      assertOwned(); actualRoot();
      const material = readBrowserCandidateSource(context.sourceBinding.source.runId, { root: actualRoot(), owner });
      const review = buildBrowserCandidateReview({ ...context, material });
      assertOwned(); actualRoot();
      return { review, material };
    } catch (cause) {
      if (cause?.status === 503) throw cause;
      // Ownership/root failures are availability failures, never a stale-source diagnostic.
      assertOwned(); actualRoot();
      if (cause?.code === 'SOURCE_NOT_ELIGIBLE' && cause?.details?.reason === 'BROWSER_REVIEW_BUDGET') throw cause;
      throw error('BASELINE_CHANGED', 409, 'Browser 当前来源无法重建完整候选，已存归属与候选保留。', { reason: 'BROWSER_SOURCE_CHANGED' });
    }
  }
  function findBrowserCandidate(catalog, projectId, candidateId) {
    requireBrowserCandidateSchema(catalog);
    if (!Object.hasOwn(catalog.projects, projectId)) missing('项目');
    const candidate = catalog.browserCandidates[candidateId];
    if (!candidate) missing('Browser 候选');
    if (candidate.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, 'Browser 候选不属于当前项目。');
    return candidate;
  }
  function assertBrowserCandidateMatches(candidate, review) {
    if (candidate.contentDigest !== review.contentDigest
      || candidate.sourceContentDigest !== review.candidateContent.sourceContentDigest
      || candidate.organizationContextDigest !== review.organizationContextDigest
      || candidate.sourceBindingId !== review.candidateContent.sourceBindingId
      || candidate.projectId !== review.candidateContent.projectId
      || candidate.releaseId !== review.candidateContent.releaseId) {
      throw error('BASELINE_CHANGED', 409, 'Browser 候选与当前完整来源不一致。', { reason: 'BROWSER_CANDIDATE_CHANGED' });
    }
  }
  function previewBrowserBaselineCandidate(projectId, sourceBindingId) {
    id(projectId, 'ap'); id(sourceBindingId, 'ax');
    const current = readFile('catalog.json'), catalog = requireCurrent(current.catalog);
    const { review } = materializeBrowserReview(catalog, projectId, sourceBindingId);
    checkUnchanged('catalog.json', current);
    return assertBrowserCandidateEnvelope({ ...review, generationId: catalog.generationId, revision: catalog.revision });
  }
  function createBrowserBaselineCandidate(projectId, raw) {
    let input;
    try {
      id(projectId, 'ap'); input = inputOf(raw, ['sourceBindingId', 'contentDigest']);
      id(input.sourceBindingId, 'ax'); digestOf(input.contentDigest);
    } catch (cause) { return Promise.reject(cause); }
    return mutate(input, (catalog, at) => {
      const context = browserReviewContext(catalog, projectId, input.sourceBindingId);
      const existing = Object.values(catalog.browserCandidates).find(value => value.sourceBindingId === input.sourceBindingId);
      if (existing) throw error('CANDIDATE_ALREADY_EXISTS', 409, '此 Browser 来源已有候选，请先读取原记录核对。', { existingCandidateId: existing.id });
      for (const [limit, count] of [['browserCandidates', Object.keys(catalog.browserCandidates).length], ['events', catalog.events.length]]) {
        if (count >= limits[limit]) throw error('CATALOG_CAPACITY', 409, '项目目录超过容量上限；历史记录未删除。', { limit });
      }
      const { review } = materializeBrowserReview(catalog, projectId, input.sourceBindingId);
      if (review.contentDigest !== input.contentDigest) throw error('BASELINE_CHANGED', 409,
        '完整候选合同已变化，请重新复核再明确保存。', { reason: 'BROWSER_CANDIDATE_CHANGED' });
      const candidate = { id: 'bc-' + randomUUID(), ...review.candidateContent,
        contentDigest: review.contentDigest, createdAt: at, actor: { ...ACTOR } };
      // Context is taken from the catalog, never accepted from the request.
      if (candidate.releaseId !== context.release.id) throw error('PROJECT_MISMATCH', 409, '候选版本不一致。');
      catalog.browserCandidates[candidate.id] = candidate;
      return { kind: 'browser-candidate-created', candidate, ...review,
        responseGuard: response => assertBrowserCandidateEnvelope(response),
        preCommitGuard: () => {
          const fresh = materializeBrowserReview(catalog, projectId, input.sourceBindingId).review;
          assertBrowserCandidateMatches(candidate, fresh);
          if (hashAcceptanceValue(fresh) !== hashAcceptanceValue(review)) throw error('BASELINE_CHANGED', 409,
            'Browser 完整来源在提交前变化，请重新复核。', { reason: 'BROWSER_SOURCE_CHANGED' });
        } };
    });
  }
  function readBrowserBaselineCandidate(projectId, candidateId) {
    id(projectId, 'ap'); id(candidateId, 'bc');
    const current = readFile('catalog.json'), catalog = requireCurrent(current.catalog);
    const candidate = findBrowserCandidate(catalog, projectId, candidateId);
    const common = { schemaVersion: catalog.schemaVersion, generationId: catalog.generationId,
      revision: catalog.revision, candidate, executionReady: false };
    try {
      const { review } = materializeBrowserReview(catalog, projectId, candidate.sourceBindingId);
      assertBrowserCandidateMatches(candidate, review);
      checkUnchanged('catalog.json', current);
      return assertBrowserCandidateEnvelope({ ...review, ...common });
    } catch (cause) {
      if (!['BASELINE_CHANGED', 'SOURCE_NOT_ELIGIBLE', 'SOURCE_INTEGRITY_FAILED'].includes(cause?.code)) throw cause;
      assertOwned(); actualRoot(); checkUnchanged('catalog.json', current);
      return { ...common, review: null, diagnostics: { eligible: false, contentMatches: false,
        issues: [{ code: cause.code, message: '当前来源无法完整复核此 Browser 候选；原记录保留，请检查原运行。' }] } };
    }
  }
  function browserEvidenceInput(raw) {
    fields(raw, ['file', 'expectedContentDigest'], ['file', 'expectedContentDigest'], invalid);
    if (typeof raw.file !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,234}\.png$/i.test(raw.file)) invalid('图片文件名无效。');
    digestOf(raw.expectedContentDigest);
    return { file: raw.file, expectedContentDigest: raw.expectedContentDigest };
  }
  function captureBrowserCandidateEvidence(projectId, sourceOrCandidateId, raw, saved) {
    id(projectId, 'ap'); id(sourceOrCandidateId, saved ? 'bc' : 'ax');
    const input = browserEvidenceInput(raw), current = readFile('catalog.json'), catalog = requireCurrent(current.catalog);
    requireBrowserCandidateSchema(catalog);
    const candidate = saved ? findBrowserCandidate(catalog, projectId, sourceOrCandidateId) : null;
    const sourceBindingId = candidate?.sourceBindingId ?? sourceOrCandidateId;
    const { review, material } = materializeBrowserReview(catalog, projectId, sourceBindingId);
    if (candidate) assertBrowserCandidateMatches(candidate, review);
    if (review.contentDigest !== input.expectedContentDigest) throw error('BASELINE_CHANGED', 409,
      '图片所属完整候选合同已变化，请重新复核。', { reason: 'BROWSER_CANDIDATE_CHANGED' });
    const selected = review.review.selectedEvidence.flatMap(value => [value.roles.screenshot, value.roles.repeat]);
    const metadata = selected.find(value => value.file === input.file);
    if (!metadata) missing('所选来源截图');
    const captured = material.files.get(input.file);
    if (!Buffer.isBuffer(captured) || captured.length !== metadata.bytes || sha256(captured) !== metadata.sha256) {
      throw error('SOURCE_INTEGRITY_FAILED', 409, '图片与完整来源不一致。', { reason: 'BROWSER_EVIDENCE_CHANGED' });
    }
    assertOwned(); actualRoot(); checkUnchanged('catalog.json', current);
    return { bytes: Buffer.from(captured), sha256: metadata.sha256 };
  }
  function readBrowserCandidatePreviewEvidence(projectId, sourceBindingId, input) {
    return captureBrowserCandidateEvidence(projectId, sourceBindingId, input, false);
  }
  function readBrowserBaselineCandidateEvidence(projectId, candidateId, input) {
    return captureBrowserCandidateEvidence(projectId, candidateId, input, true);
  }
  /** Single-operation approval uses the current complete candidate, under the
   * catalog queue. Publishing an operation does not mutate global selections. */
  function withBrowserExecutionCandidate(projectId, raw, options) {
    let input;
    try {
      id(projectId, 'ap');
      input = inputOf(raw, ['operationId', 'candidateId', 'contentDigest', 'targetReleaseId']);
      if (!/^bo-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.operationId ?? '')) invalid('Browser 操作 ID 无效。');
      id(input.candidateId, 'bc'); id(input.targetReleaseId, 'ar'); digestOf(input.contentDigest);
      fields(options, ['assertAdmission', 'publish'], ['assertAdmission', 'publish'], invalid);
      for (const callback of [options.assertAdmission, options.publish]) {
        if (typeof callback !== 'function' || types.isProxy(callback) || types.isAsyncFunction(callback)
          || types.isGeneratorFunction(callback)) invalid('Browser 接纳与发布必须同步执行。');
      }
    } catch (cause) { return Promise.reject(cause); }
    const admission = () => {
      assertOwned(); actualRoot();
      const result = options.assertAdmission();
      if (result !== undefined && result !== true) {
        consumeAdmissionPromise(result);
        throw error('BROWSER_EXECUTION_UNAVAILABLE', 503, '本次 Browser 执行接纳已停止。');
      }
    };
    return queue(() => {
      admission();
      const current = readFile('catalog.json'), catalog = requireCurrent(current.catalog);
      if (catalog.generationId !== input.expectedGenerationId || catalog.revision !== input.expectedRevision) {
        throw error('STALE_REVISION', 409, '项目目录已变化，请重新完整复核后确认。',
          { generationId: catalog.generationId, revision: catalog.revision });
      }
      const previous = readFile('catalog.previous.json', { optional: true });
      validatePredecessor(current, previous);
      const candidate = findBrowserCandidate(catalog, projectId, input.candidateId);
      if (candidate.contentDigest !== input.contentDigest) throw error('BASELINE_CHANGED', 409, '候选内容与本次确认不一致。');
      const targetRelease = catalog.releases[input.targetReleaseId];
      if (!targetRelease) missing('目标版本');
      if (targetRelease.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '目标版本不属于本项目。');
      const { review, material } = materializeBrowserReview(catalog, projectId, candidate.sourceBindingId);
      assertBrowserCandidateMatches(candidate, review);
      const compiled = compileFixedBrowserContract({ material, review, candidate, targetRelease });
      const assertCurrent = () => {
        admission(); checkUnchanged('catalog.json', current); checkUnchanged('catalog.previous.json', previous);
        const fresh = materializeBrowserReview(catalog, projectId, candidate.sourceBindingId);
        assertBrowserCandidateMatches(candidate, fresh.review);
        if (hashAcceptanceValue(fresh.review) !== hashAcceptanceValue(review)) {
          throw error('BASELINE_CHANGED', 409, '来源完整合同在批准过程中发生变化。');
        }
        admission(); checkUnchanged('catalog.json', current); checkUnchanged('catalog.previous.json', previous);
      };
      assertCurrent();
      const result = options.publish({ request: input, project: catalog.projects[projectId], candidate,
        sourceBinding: catalog.browserSourceBindings[candidate.sourceBindingId], targetRelease, review, ...compiled }, { assertCurrent });
      const invalidPublication = () => {
        consumeAdmissionPromise(result);
        throw Object.assign(error('BROWSER_EXECUTION_UNAVAILABLE', 503, 'Browser 准备发布未同步完成。'), { writeMayHaveCommitted: true });
      };
      fields(result, ['record', 'replayed'], ['record', 'replayed'], invalidPublication);
      if (typeof result.replayed !== 'boolean' || !plain(result.record)) invalidPublication();
      return { ...result, ...compiled };
    });
  }
  function reasonOf(input) {
    if (typeof input.reason !== 'string' || !boundedText(input.reason.trim(), 1000)) invalid('操作理由必须为 1..1000 个字符。');
    input.reason = input.reason.trim();
  }
  function digestOf(value) {
    if (typeof value !== 'string' || !HASH.test(value)) invalid('contentDigest 必须是候选预览中的 SHA-256。');
  }
  function materializeProjectSource(catalog, projectId, runId) {
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
    assertOwned(); actualRoot();
    return material;
  }
  function projectSource(catalog, projectId, runId) {
    const material = materializeProjectSource(catalog, projectId, runId);
    const result = projectSpecBaselineCandidate(material, { projectId, releaseId: catalog.runBindings[runId].releaseId, sourceSide: 'source' });
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
  function dispatchStore(initialize = true) {
    assertOwned();
    const actual = actualRoot();
    managedDispatches ??= createManagedSpecDispatchStore({ ...managedDispatchOptions, root: actual, owner });
    if (initialize) managedDispatches.initialize();
    return managedDispatches;
  }
  function managedContext(catalog, projectId, input) {
    const project = catalog.projects[projectId];
    if (!project) missing('项目');
    const selection = currentSelectionsOf(catalog, projectId).spec;
    if (!selection?.approvalId || selection.id !== input.selectionId) {
      throw error('BASELINE_CHANGED', 409, '当前选用已变化，请重新确认本次执行依据。', { reason: 'CURRENT_SELECTION_CHANGED' });
    }
    const approval = catalog.approvals[selection.approvalId];
    const candidate = findCandidate(catalog, projectId, approval.candidateId);
    if (approval.contentDigest !== input.contentDigest) {
      throw error('BASELINE_CHANGED', 409, '需求摘要与当前选用不一致。', { reason: 'CONFIRMATION_DIGEST_CHANGED' });
    }
    const targetRelease = catalog.releases[input.targetReleaseId];
    if (!targetRelease) missing('目标版本');
    if (targetRelease.projectId !== projectId) throw error('PROJECT_MISMATCH', 409, '目标版本不属于当前项目。');
    const material = materializeProjectSource(catalog, projectId, candidate.source.runId);
    const contract = prepareManagedSpecContract(material, { candidate, targetRelease });
    assertOwned(); actualRoot();
    return { project, selection, approval, candidate, sourceRelease: catalog.releases[candidate.source.releaseId],
      targetRelease, sourceSpecApproved: contract.sourceSpecApproved, plan: contract.plan, planFingerprint: contract.planFingerprint };
  }
  function managedConfirmation(projectId, raw) {
    id(projectId, 'ap');
    const input = inputOf(raw, ['operationId', 'selectionId', 'contentDigest', 'targetReleaseId']);
    if (typeof input.operationId !== 'string' || !OPERATION_ID.test(input.operationId)) invalid('operationId 必须是完整操作 ID。');
    id(input.selectionId, 'as'); id(input.targetReleaseId, 'ar'); digestOf(input.contentDigest);
    const { operationId, ...confirmation } = input;
    const request = { projectId, ...confirmation };
    return { input, operationId, request, requestFingerprint: managedSpecDispatchRequestFingerprint(request) };
  }
  function matchingDispatch(dispatches, confirmation) {
    const record = dispatches.read(confirmation.operationId);
    if (record && record.envelope.requestFingerprint !== confirmation.requestFingerprint) {
      throw error('IDEMPOTENCY_CONFLICT', 409, '操作 ID 已用于其他确认；请核对原操作记录。');
    }
    return record;
  }
  /** Private reconciliation only. Absence never publishes, reserves or starts.
   * The full original confirmation prevents a key being reused across projects
   * or substituted with a fresh CAS. Current catalog/source are not consulted. */
  function readManagedSpecDispatch(projectId, raw) {
    const confirmation = managedConfirmation(projectId, raw);
    return matchingDispatch(dispatchStore(false), confirmation);
  }
  /**
   * Private preparation only: reserve immutable identities and persist authority.
   * No run/task is created and no execution may be inferred from a saved record.
   * Replaying an operation never prepares a second record or starts any work.
   */
  function prepareManagedSpecDispatch(projectId, raw, options = {}) {
    let confirmation, assertAdmission;
    try {
      fields(options, ['assertAdmission'], [], invalid);
      assertAdmission = options.assertAdmission;
      if (assertAdmission !== undefined && (typeof assertAdmission !== 'function' || types.isProxy(assertAdmission)
        || types.isAsyncFunction(assertAdmission) || types.isGeneratorFunction(assertAdmission))) invalid('接纳检查必须同步执行。');
      confirmation = managedConfirmation(projectId, raw);
    }
    catch (cause) { return Promise.reject(cause); }
    const admission = () => {
      if (!assertAdmission) return;
      const result = assertAdmission();
      if (result !== true && result !== undefined) {
        // Only consume native promises; never assimilate caller thenables.
        consumeAdmissionPromise(result);
        throw error('MANAGED_EXECUTION_UNAVAILABLE', 503, '本次执行接纳已停止。');
      }
    };
    const { input, operationId, request, requestFingerprint } = confirmation;
    return queue(() => {
      // This fence precedes namespace initialization and remains inside the
      // catalog queue: an outer check cannot revoke already queued work.
      admission();
      const dispatches = dispatchStore(), existing = matchingDispatch(dispatches, confirmation);
      const resultOf = (record, replayed) => ({ record, replayed, state: 'prepared', runCreated: false, executionReady: false });
      if (existing) return resultOf(existing, true);
      admission();
      const current = readFile('catalog.json'); requireCurrent(current.catalog);
      if (input.expectedGenerationId !== current.catalog.generationId || input.expectedRevision !== current.catalog.revision) {
        throw error('STALE_REVISION', 409, '项目目录已变化，请刷新后重新操作。', {
          generationId: current.catalog.generationId, revision: current.catalog.revision });
      }
      const previous = readFile('catalog.previous.json', { optional: true });
      validatePredecessor(current, previous);
      const context = managedContext(current.catalog, projectId, input);
      const envelope = { schemaVersion: 1, operationId, dispatchId: 'ad-' + randomUUID(), runId: 'ac-' + randomUUID(),
        taskId: 'a-' + randomUUID(), acceptedAt: new Date().toISOString(), request, requestFingerprint,
        catalog: { generationId: current.catalog.generationId, revision: current.catalog.revision, headSha256: sha256(current.bytes) },
        ...context, executor: 'engine-owner-spec-v1' };
      const record = dispatches.publish(envelope, { beforePublish() {
        admission();
        assertOwned(); actualRoot();
        checkUnchanged('catalog.json', current); checkUnchanged('catalog.previous.json', previous);
        const verified = managedContext(current.catalog, projectId, input);
        if (hashAcceptanceValue(verified) !== hashAcceptanceValue(context)) {
          throw error('BASELINE_CHANGED', 409, '派发准备期间需求或目标版本已变化。', { reason: 'DISPATCH_CONTEXT_CHANGED' });
        }
        assertOwned(); actualRoot();
        checkUnchanged('catalog.json', current); checkUnchanged('catalog.previous.json', previous);
        admission();
      } });
      return resultOf(record, false);
    });
  }
  return Object.freeze({ initialize, previewMigration, applyMigration, read, createProject, createRelease, bindRun, readRunReference, bindBrowserSource, readBrowserSourceBinding,
    previewBrowserBaselineCandidate, createBrowserBaselineCandidate, readBrowserBaselineCandidate,
    readBrowserCandidatePreviewEvidence, readBrowserBaselineCandidateEvidence, withBrowserExecutionCandidate,
    createBaselineCandidate, readBaselineCandidate, approveBaseline, selectBaseline, prepareManagedSpecDispatch, readManagedSpecDispatch });
}
