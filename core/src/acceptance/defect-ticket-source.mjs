/** Private, owner-bound Browser facts for manual defect tickets. Read-only.
 * The existing Browser verifier is deliberately unchanged. Its ledger validates
 * observations and lineage; this adapter adds whole-batch budgets and fences
 * for raw bytes, optional absence and directory membership. This is a checked
 * batch, not an atomic multi-file snapshot or a backup/rollback detector. */
import { constants, opendirSync, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { assertAcceptanceOwner } from './owner.mjs';
import { validateAcceptanceCatalog, ACCEPTANCE_CATALOG_LIMITS } from './catalog-schema.mjs';
import { createBrowserOperationStore } from './browser-operation-store.mjs';
import { BROWSER_OPERATION_LIMITS, browserOperationSame, browserOperationJson, browserOperationFileName,
  isBrowserOperationId, validateBrowserOperationDispatch, validateBrowserOperationHead,
  validateBrowserOperationReport, validateBrowserOperationRejection, browserOperationRejectionBytes } from './browser-operation-schema.mjs';
import { DEFECT_TICKET_LIMITS, DefectTicketError, defectTicketFail as fail, defectTicketJson,
  defectTicketDigest } from './defect-ticket-schema.mjs';

export const DEFECT_TICKET_SOURCE_LIMITS = Object.freeze({ operations: BROWSER_OPERATION_LIMITS.operations,
  entries: 16384, jsonBytes: DEFECT_TICKET_LIMITS.factsJsonBytes,
  evidenceBytes: BROWSER_OPERATION_LIMITS.evidenceBytes, readWorkBytes: 1024 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs && a.mode === b.mode;
const sameFile = (a, b) => identity(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const fields = (object, keys) => Object.keys(object).length === keys.length && keys.every(key => Object.hasOwn(object, key));
const id = (value, prefix) => typeof value === 'string'
  && new RegExp(`^${prefix}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`).test(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const reference = operation => Object.fromEntries(['operationId', 'targetReleaseId', 'acceptedAt', 'recordedAt',
  'dispatchSha256', 'reportSha256', 'observationsSha256'].map(key => [key, operation[key]]));

function limitsOf(input) {
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
  const result = { ...DEFECT_TICKET_SOURCE_LIMITS }, descriptors = Object.getOwnPropertyDescriptors(input);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
      || !Object.hasOwn(result, key) || !Number.isSafeInteger(descriptor.value)
      || descriptor.value < 0 || descriptor.value > result[key]) fail('INVALID_LIMITS', 'INVALID_INPUT', 400);
    result[key] = descriptor.value;
  }
  return Object.freeze(result);
}

export function createDefectTicketSourceReader({ owner, limits: inputLimits = {} } = {}) {
  // Check the acquired capability before reflecting on owner or touching paths.
  assertAcceptanceOwner(owner);
  const limits = limitsOf(inputLimits), root = resolve(owner.root);
  const owned = () => { assertAcceptanceOwner(owner); if (realpathSync(root) !== root) fail('ROOT_CHANGED'); };
  function boundary(fn) {
    try { owned(); return fn(); }
    catch (cause) {
      if (cause instanceof DefectTicketError || ['ACCEPTANCE_OWNER_LOST', 'ACCEPTANCE_OWNER_UNAVAILABLE'].includes(cause?.code)) throw cause;
      fail('SOURCE_UNAVAILABLE');
    }
  }
  function capture(input) { return boundary(() => {
    let request;
    try {
      request = defectTicketJson(input, DEFECT_TICKET_LIMITS.requestBytes);
      if (!id(request.projectId, 'ap') || !(fields(request, ['projectId', 'candidateId', 'contentDigest'])
        && id(request.candidateId, 'bc') && /^[a-f0-9]{64}$/.test(request.contentDigest)
        || fields(request, ['projectId', 'operationId']) && isBrowserOperationId(request.operationId))) throw new Error();
    } catch { fail('INVALID_SOURCE_REQUEST', 'INVALID_INPUT', 400); }
    const { projectId } = request; let { candidateId, contentDigest } = request;
    const directories = new Map(), files = new Map(), absent = new Set();
    const chargedJson = new Set(); let entryCount = 0, jsonBytes = 0, evidenceBytes = 0;
    let maximumJson = 1, maximumEvidenceFile = 0, maximumEvidenceFiles = 0, maximumOperationEvidence = 0;
    let hashedBytes = 0;
    function directory(path, { optional = false, names = false, maximum = BROWSER_OPERATION_LIMITS.directoryEntries } = {}) {
      owned(); let stat;
      try { stat = lstatSync(path, { bigint: true }); }
      catch (cause) { if (optional && cause.code === 'ENOENT') { absent.add(path); return null; } throw cause; }
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path) fail('DIRECTORY_UNSAFE');
      const record = { path, stat, names: names ? readNames(path, maximum) : null, maximum };
      if (!identity(stat, lstatSync(path, { bigint: true }))) fail('DIRECTORY_CHANGED');
      directories.set(path, record); return record;
    }
    function readNames(path, maximum) {
      const names = [], handle = opendirSync(path);
      try { let entry; while ((entry = handle.readSync())) {
        if (names.length >= maximum) fail('DIRECTORY_CAPACITY', 'CAPACITY', 503);
        names.push(entry.name);
      } } finally { handle.closeSync(); }
      return names.sort();
    }
    function statFile(path, maximum) {
      if (++entryCount > limits.entries) fail('SOURCE_ENTRY_BUDGET', 'CAPACITY', 503);
      const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size < 0n
        || stat.size > BigInt(maximum) || realpathSync(path) !== path) fail('FILE_UNSAFE');
      const record = { path, stat, maximum, sha256: null }; files.set(path, record); return record;
    }
    function chargeJson(file) {
      if (!file || chargedJson.has(file.path)) return;
      jsonBytes += Number(file.stat.size); chargedJson.add(file.path);
      if (jsonBytes > limits.jsonBytes) fail('SOURCE_JSON_BUDGET', 'CAPACITY', 503);
    }
    function readBytes(file, { checking = false } = {}) {
      let fd;
      try {
        const before = lstatSync(file.path, { bigint: true });
        if (!sameFile(file.stat, before) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
          || before.size > BigInt(file.maximum) || realpathSync(file.path) !== file.path) fail('SOURCE_CHANGED', 'STALE_FACTS', 409);
        fd = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        const opened = fstatSync(fd, { bigint: true });
        if (!sameFile(before, opened)) fail('SOURCE_CHANGED', 'STALE_FACTS', 409);
        const bytes = Buffer.alloc(Number(opened.size)); let offset = 0;
        while (offset < bytes.length) { const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
          if (!count) fail('SOURCE_CHANGED', 'STALE_FACTS', 409); offset += count; }
        if (readSync(fd, Buffer.alloc(1), 0, 1, bytes.length) !== 0 || !sameFile(opened, fstatSync(fd, { bigint: true }))
          || !sameFile(opened, lstatSync(file.path, { bigint: true }))) fail('SOURCE_CHANGED', 'STALE_FACTS', 409);
        const digest = sha(bytes);
        if (file.sha256 && file.sha256 !== digest) fail('SOURCE_CHANGED', 'STALE_FACTS', 409);
        if (!checking) { file.sha256 = digest; hashedBytes += bytes.length; }
        return bytes;
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    function readJson(file) {
      const bytes = readBytes(file);
      return { bytes, value: browserOperationJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), file.maximum) };
    }
    function checkShape() {
      for (const path of absent) {
        try { lstatSync(path); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
        fail('SOURCE_ABSENCE_CHANGED', 'STALE_FACTS', 409);
      }
      for (const row of directories.values()) {
        const stat = lstatSync(row.path, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink() || !identity(row.stat, stat) || realpathSync(row.path) !== row.path
          || row.names && !browserOperationSame(row.names, readNames(row.path, row.maximum))) fail('SOURCE_NAMESPACE_CHANGED', 'STALE_FACTS', 409);
      }
      for (const file of files.values()) {
        const stat = lstatSync(file.path, { bigint: true });
        if (!sameFile(file.stat, stat) || realpathSync(file.path) !== file.path) fail('SOURCE_CHANGED', 'STALE_FACTS', 409);
      }
    }
    function checkCurrent() {
      owned(); checkShape();
      for (const file of files.values()) if (file.sha256) readBytes(file, { checking: true });
      // Match the old scope's before/after shape checks, adding explicit names
      // and absence. This still does not claim cross-file atomicity.
      checkShape();
      owned(); return true;
    }
    directory(root);
    const catalogFile = statFile(join(root, 'catalog.json'), ACCEPTANCE_CATALOG_LIMITS.jsonBytes);
    chargeJson(catalogFile);
    const catalogBytes = readBytes(catalogFile);
    const catalog = validateAcceptanceCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalogBytes)));
    const project = catalog.projects[projectId]; let candidate;
    if (!project) fail('SOURCE_NOT_FOUND', 'NOT_FOUND', 404);
    function selectCandidate() {
      candidate = catalog.browserCandidates?.[candidateId];
      if (!candidate || candidate.projectId !== projectId) fail('SOURCE_NOT_FOUND', 'NOT_FOUND', 404);
      if (candidate.contentDigest !== contentDigest) fail('SOURCE_CONTENT_CHANGED', 'STALE_FACTS', 409);
    }
    if (candidateId) selectCandidate();

    const parent = join(root, 'browser-operations'), namespace = join(parent, 'v1'), rows = [];
    const parentRecord = directory(parent, { optional: true });
    const space = parentRecord && directory(namespace, { optional: true, names: true, maximum: limits.operations });
    for (const operationId of space?.names ?? []) {
      if (!isBrowserOperationId(operationId)) fail('NAMESPACE_UNSAFE');
      const path = join(namespace, operationId), folder = directory(path, { names: true });
      const rejected = folder.names.includes('rejection.json'), row = { operationId, path, files: new Map(), evidence: new Map(), rejected };
      if (rejected && !browserOperationSame(folder.names, ['rejection.json'])) fail('DECISION_MIXED');
      if (!rejected && !folder.names.includes('dispatch.json')) fail('DECISION_INCOMPLETE');
      for (const name of folder.names) {
        if (!rejected && name === 'evidence') {
          const evidencePath = join(path, name), evidence = directory(evidencePath, { names: true });
          if (evidence.names.length > BROWSER_OPERATION_LIMITS.evidenceFiles) fail('EVIDENCE_FILE_BUDGET', 'CAPACITY', 503);
          let bytes = 0;
          for (const filename of evidence.names) {
            if (!browserOperationFileName(filename)) fail('EVIDENCE_NAME_UNSAFE');
            const file = statFile(join(evidencePath, filename), BROWSER_OPERATION_LIMITS.evidenceFileBytes);
            bytes += Number(file.stat.size); row.evidence.set(filename, file);
            maximumEvidenceFile = Math.max(maximumEvidenceFile, Number(file.stat.size));
          }
          if (bytes > BROWSER_OPERATION_LIMITS.evidenceBytes) fail('EVIDENCE_OPERATION_BUDGET', 'CAPACITY', 503);
          maximumOperationEvidence = Math.max(maximumOperationEvidence, bytes);
          maximumEvidenceFiles = Math.max(maximumEvidenceFiles, evidence.names.length);
        } else {
          if (!['dispatch.json', 'head.json', 'report.json', 'observations.json', ...(rejected ? ['rejection.json'] : [])].includes(name)) fail('DECISION_MIXED');
          const file = statFile(join(path, name), name === 'head.json' ? 64 * 1024
            : name === 'rejection.json' ? BROWSER_OPERATION_LIMITS.rejectionBytes : BROWSER_OPERATION_LIMITS.jsonBytes);
          row.files.set(name, file);
          if (!['head.json', 'rejection.json'].includes(name)) maximumJson = Math.max(maximumJson, Number(file.stat.size));
        }
      }
      for (const name of rejected ? [] : ['head.json', 'report.json', 'observations.json', 'evidence']) {
        if (!folder.names.includes(name)) absent.add(join(path, name));
      }
      rows.push(row);
    }
    // Account the complete namespace metadata before the first dispatch parse or
    // call to the legacy reader. Foreign metadata is inspected by that reader.
    for (const row of rows) for (const name of ['dispatch.json', 'head.json', 'rejection.json']) chargeJson(row.files.get(name));
    const completed = [];
    for (const row of rows) {
      if (row.rejected) {
        const file = row.files.get('rejection.json'), parsed = readJson(file);
        const rejection = validateBrowserOperationRejection(parsed.value);
        if (rejection.operationId !== row.operationId || !browserOperationRejectionBytes(rejection).equals(parsed.bytes)) fail('REJECTION_CHANGED');
        continue;
      }
      const dispatch = row.files.get('dispatch.json'), raw = readJson(dispatch), envelope = validateBrowserOperationDispatch(raw.value);
      if (envelope.operationId !== row.operationId) fail('DISPATCH_IDENTITY_MISMATCH');
      row.record = { envelope, bytes: raw.bytes, sha256: dispatch.sha256 };
      const headFile = row.files.get('head.json'); row.head = headFile ? validateBrowserOperationHead(readJson(headFile).value, row.record) : null;
      maximumJson = Math.max(maximumJson, raw.bytes.length);
      if (envelope.project.id === projectId && row.head?.status === 'completed') {
        const reportFile = row.files.get('report.json'); if (!reportFile) fail('REPORT_MISSING');
        chargeJson(reportFile); chargeJson(row.files.get('observations.json')); completed.push(row);
      }
    }
    if (request.operationId) {
      const selected = completed.find(row => row.operationId === request.operationId);
      if (!selected) fail('SOURCE_NOT_FOUND', 'NOT_FOUND', 404);
      candidateId = selected.record.envelope.candidate.id; contentDigest = selected.record.envelope.candidate.contentDigest;
      selectCandidate();
    }
    // All completed operations in the project are charged, even when the ticket
    // selects one candidate. ledger() fully reads each of these operations.
    for (const row of completed) {
      const reportFile = row.files.get('report.json'), parsed = readJson(reportFile);
      if (reportFile.sha256 !== row.head.reportSha256) fail('REPORT_CHANGED');
      row.report = validateBrowserOperationReport(parsed.value, row.record);
      if (row.report.gate !== row.head.gate || !Array.isArray(row.report.evidenceManifest)) fail('REPORT_MANIFEST_MISSING');
      let operationEvidence = 0;
      for (const entry of row.report.evidenceManifest) {
        const file = row.evidence.get(entry.file);
        if (!file || file.stat.size !== BigInt(entry.bytes)) fail('EVIDENCE_SIZE_MISMATCH');
        operationEvidence += entry.bytes; evidenceBytes += entry.bytes;
        maximumEvidenceFile = Math.max(maximumEvidenceFile, entry.bytes);
      }
      if (evidenceBytes > limits.evidenceBytes) fail('SOURCE_EVIDENCE_BUDGET', 'CAPACITY', 503);
      maximumOperationEvidence = Math.max(maximumOperationEvidence, operationEvidence);
      maximumEvidenceFiles = Math.max(maximumEvidenceFiles, row.report.evidenceManifest.length);
      maximumJson = Math.max(maximumJson, parsed.bytes.length);
      const observationFile = row.files.get('observations.json');
      row.observation = observationFile ? readJson(observationFile).value : null;
      if (observationFile) maximumJson = Math.max(maximumJson, Number(observationFile.stat.size));
    }
    const byOperation = new Map(completed.map(row => [row.operationId, row]));
    for (const row of completed) if (row.observation) {
      const beforeId = row.observation.beforeOperationId;
      if (beforeId !== null) {
        const before = byOperation.get(beforeId);
        // ledger reads the referenced operation before it checks project/content;
        // reject foreign, absent or incomplete edges before allowing that I/O.
        if (!isBrowserOperationId(beforeId) || beforeId === row.operationId || !before
          || before.record.envelope.candidate.contentDigest !== row.record.envelope.candidate.contentDigest
          || before.record.envelope.acceptedAt > row.record.envelope.acceptedAt) fail('SOURCE_LINEAGE_UNSAFE');
      }
    }
    // Tightened per-file/per-operation limits also bound hostile changes during
    // legacy I/O. Assume every namespace operation could become completed and
    // registered: N metadata decisions, N full reads, <=N unique lineage nodes,
    // <=N direct-before reads and <=N context scopes. Each scope has <=1 obs.
    // 3*D + 7*N*F + 5*N*J safely overcharges ledger's repeated byte reads.
    const n = rows.length, j = maximumJson, f = 2 * j + 64 * 1024 + maximumOperationEvidence;
    const legacyReadUpperBound = 3 * n * (j + 64 * 1024) + 7 * n * f + 5 * n * j;
    // Payload bytes only: owner-lock reads and directory/stat work have separate
    // fixed per-call bounds. A future guard adds hashedBytes payload bytes; it is
    // not silently included in this once-per-capture charge.
    // Our own initial reads plus the two complete positive-byte fence passes.
    const batchReadUpperBound = legacyReadUpperBound + 3 * (jsonBytes + evidenceBytes);
    if (!Number.isSafeInteger(batchReadUpperBound) || batchReadUpperBound > limits.readWorkBytes) fail('SOURCE_READ_WORK_BUDGET', 'CAPACITY', 503);
    // Hash positive evidence only after every project manifest and work budget
    // has passed. Preserve the raw digest, never a JSON reserialization digest.
    for (const row of completed) for (const entry of row.report.evidenceManifest) {
      const file = row.evidence.get(entry.file);
      if (sha(readBytes(file)) !== entry.sha256) fail('EVIDENCE_CHANGED');
    }
    checkCurrent();
    const store = createBrowserOperationStore({ owner, limits: { operations: n, jsonBytes: j,
      evidenceFileBytes: maximumEvidenceFile, evidenceFiles: maximumEvidenceFiles, evidenceBytes: maximumOperationEvidence } });
    const ledger = store.ledger(projectId);
    const expected = completed.filter(row => row.observation).map(row => row.operationId).sort();
    if (!browserOperationSame(ledger.entries.map(entry => entry.operationId).sort(), expected)) fail('REGISTERED_SET_CHANGED');
    for (const observation of ledger.entries) {
      const row = byOperation.get(observation.operationId);
      if (!row || !browserOperationSame(observation, row.observation)) fail('OBSERVATION_CHANGED');
    }
    const operations = ledger.entries.map(observation => {
      const row = byOperation.get(observation.operationId), envelope = row.record.envelope;
      return { operationId: row.operationId, targetReleaseId: envelope.targetRelease.id, acceptedAt: envelope.acceptedAt,
        recordedAt: observation.recordedAt, dispatchSha256: row.record.sha256,
        reportSha256: row.files.get('report.json').sha256, observationsSha256: row.files.get('observations.json').sha256,
        report: row.report, observation };
    }).sort((a, b) => compare(a.acceptedAt, b.acceptedAt) || compare(a.recordedAt, b.recordedAt) || compare(a.operationId, b.operationId));
    // Project lists may contain tickets for several candidates. Select another
    // candidate from these already verified project facts without replaying the
    // full ledger for each row. Consumers still hold this capture's one guard.
    function factsFor(input) {
      let selected;
      try { selected = defectTicketJson(input, DEFECT_TICKET_LIMITS.requestBytes);
        if (!fields(selected, ['candidateId', 'contentDigest']) || !id(selected.candidateId, 'bc')
          || !/^[a-f0-9]{64}$/.test(selected.contentDigest)) throw new Error();
      } catch { fail('INVALID_SOURCE_REQUEST', 'INVALID_INPUT', 400); }
      const entity = catalog.browserCandidates?.[selected.candidateId];
      if (!entity || entity.projectId !== projectId) fail('SOURCE_NOT_FOUND', 'NOT_FOUND', 404);
      if (entity.contentDigest !== selected.contentDigest) fail('SOURCE_CONTENT_CHANGED', 'STALE_FACTS', 409);
      const chosen = operations.filter(operation => operation.observation.candidateId === selected.candidateId
        && operation.observation.contentDigest === selected.contentDigest);
      const factsDigest = defectTicketDigest('facts', { projectId, ...selected,
        catalog: { generationId: catalog.generationId, revision: catalog.revision, headSha256: catalogFile.sha256,
          projectDigest: sha(Buffer.from(JSON.stringify(project))), candidateDigest: sha(Buffer.from(JSON.stringify(entity))) },
        operations: chosen.map(reference) });
      return freeze(defectTicketJson({ projectId, ...selected, factsDigest, operations: chosen }, DEFECT_TICKET_LIMITS.factsJsonBytes));
    }
    const facts = factsFor({ candidateId, contentDigest });
    checkCurrent();
    const assertCurrent = () => boundary(checkCurrent);
    return Object.freeze({ facts, factsFor, assertCurrent, budget: Object.freeze({ scope: 'one-capture-payload-reads',
      namespaceOperations: n, completedOperations: completed.length,
      registeredOperations: ledger.entries.length, entries: entryCount, jsonBytes, evidenceBytes, hashedBytes,
      legacyReadUpperBound, batchReadUpperBound, guardPayloadReadUpperBound: hashedBytes }) });
  }); }
  return Object.freeze({ capture });
}
