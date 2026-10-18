import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createDefectTicketService } from '../src/acceptance/defect-ticket-service.mjs';
import { handleDefectTicketRequest } from '../src/acceptance/defect-ticket-api.mjs';
import { defectTicketRequestFingerprint, validateDefectTicketCreateRequest, validateDefectTicketCloseRequest } from '../src/acceptance/defect-ticket-schema.mjs';
import { validateAcceptanceCatalog } from '../src/acceptance/catalog-schema.mjs';
import { browserOperationFixture, browserOperationRaw } from './fixtures/acceptance-browser-operation.mjs';
import { append, empty, copy, rehashEvents, uid as fixedId } from './fixtures/acceptance-browser-organized-candidate.mjs';
import { secondDefectTicketCandidate } from './fixtures/acceptance-defect-ticket.mjs';

const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const uid = prefix => prefix + '-' + randomUUID();
const operationNames = f => readdirSync(join(f.root, 'browser-operations', 'v1')).sort();
async function fixture(t) {
  const f = await browserOperationFixture(t), catalog = empty();
  append(catalog, 'projects', copy(f.project), 'project-created', f.project.id);
  append(catalog, 'releases', copy(f.review.organizationContext.release), 'release-created', f.project.id);
  append(catalog, 'releases', copy(f.targetRelease), 'release-created', f.project.id);
  append(catalog, 'browserSourceBindings', copy(f.sourceBinding), 'browser-source-bound', f.project.id);
  append(catalog, 'browserCandidates', copy(f.candidate), 'browser-candidate-created', f.project.id);
  validateAcceptanceCatalog(catalog); writeFileSync(join(f.root, 'catalog.json'), encode(catalog), { flag: 'wx' });
  let previous = null;
  function operation(bugs, { registered = true, beforeOperationId = previous } = {}) {
    const input = f.request(); f.publish(input); const run = f.store.createRun(input.operationId), raw = browserOperationRaw(f, run);
    for (const index of bugs) { raw.checks[index].status = 'failed'; raw.checks[index].verdict = 'bug'; }
    const value = f.store.finishRun(input.operationId, raw);
    if (registered) f.store.registerResult(input.operationId, { beforeOperationId });
    previous = input.operationId; return value;
  }
  const service = createDefectTicketService({ owner: f.owner });
  const createRequest = source => ({ ticketId: uid('dt'), actionId: uid('da'), sourceOperationId: source.operationId,
    memberCheckIds: source.report.checks.filter(check => check.status === 'failed').map(check => check.id),
    title: 'Menu restoration on both declared checks', severity: 'high', description: 'Both selected checks fail.',
    reproduction: 'Open the fixture route and compare the menu.' });
  const closeRequest = preview => ({ actionId: uid('da'), afterOperationId: preview.afterOperationId,
    expectedRevision: preview.expectedRevision, expectedHeadSha256: preview.expectedHeadSha256,
    memberSetDigest: preview.memberSetDigest, factsDigest: preview.factsDigest, previewDigest: preview.previewDigest,
    resolution: 'Restored both declared checks.', confirmed: true });
  return { ...f, catalog, operation, service, createRequest, closeRequest };
}

test('service persists fixed two-member tickets, rejects partial close and explicitly closes/reopens across restart', async t => {
  const f = await fixture(t), source = f.operation([0, 1]), request = f.createRequest(source);
  let names = operationNames(f);
  const created = await f.service.create(f.project.id, request);
  assert.equal(created.status, 201); assert.equal(created.payload.outcome, 'recorded');
  assert.equal(created.payload.event.members.length, 2);
  assert.deepEqual(operationNames(f), names, 'manual creation cannot start a Browser operation');
  assert.equal(f.service.action(f.project.id, request.actionId).eventSha256, created.payload.eventSha256);
  assert.equal((await f.service.create(f.project.id, request)).payload.replayed, true);
  await assert.rejects(f.service.create(f.project.id, { ...request, title: 'Different input' }), { code: 'ACTION_CONFLICT', status: 409 });
  const partial = f.operation([1]); names = operationNames(f);
  let preview = f.service.previewClose(f.project.id, request.ticketId, partial.operationId).preview;
  assert.equal(preview.closeEligible, false); assert.equal(preview.counts.passed, 1); assert.equal(preview.counts.failed, 1);
  await assert.rejects(f.service.close(f.project.id, request.ticketId, f.closeRequest(preview)), { code: 'SOURCE_NOT_ELIGIBLE' });
  assert.deepEqual(operationNames(f), names);
  const healthy = f.operation([]); preview = f.service.previewClose(f.project.id, request.ticketId, healthy.operationId).preview;
  assert.equal(preview.closeEligible, true);
  const closeInput = f.closeRequest(preview), closed = await f.service.close(f.project.id, request.ticketId, closeInput);
  assert.equal(closed.payload.event.revision, 1);
  assert.equal((await f.service.close(f.project.id, request.ticketId, closeInput)).payload.replayed, true);
  const restarted = createDefectTicketService({ owner: f.owner });
  assert.equal(restarted.read(f.project.id, request.ticketId).ticket.processingStatus, 'closed');
  f.operation([1]); let ticket = restarted.read(f.project.id, request.ticketId).ticket;
  assert.equal(ticket.processingStatus, 'reopened'); assert.equal(ticket.reopenReasons.length, 1);
  const recovered = f.operation([]); ticket = restarted.read(f.project.id, request.ticketId).ticket;
  assert.equal(ticket.processingStatus, 'reopened'); assert.equal(ticket.verificationStatus, 'verified_passed');
  const listing = restarted.list(f.project.id);
  assert.equal(listing.ticketCount, 1); assert.equal(listing.associatedCheckCount, 2);
  assert.equal(listing.tickets[0].processingStatus, 'reopened');
  const exported = JSON.parse(restarted.exportTicket(f.project.id, request.ticketId, 'json').bytes);
  assert.equal(exported.handling.status, 'reopened'); assert.equal(exported.history.length, 2);
  assert.equal(exported.history[0].eventSha256, created.payload.eventSha256);
  preview = restarted.previewClose(f.project.id, request.ticketId, recovered.operationId).preview;
  const reclosed = await restarted.close(f.project.id, request.ticketId, f.closeRequest(preview));
  assert.equal(reclosed.payload.event.revision, 2);
  assert.equal(restarted.read(f.project.id, request.ticketId).ticket.processingStatus, 'closed');
});

test('stale facts reject queued close, source damage retains blocked history and exact action replay', async t => {
  const f = await fixture(t), source = f.operation([0]), request = f.createRequest(source);
  const created = await f.service.create(f.project.id, request), healthy = f.operation([]);
  const preview = f.service.previewClose(f.project.id, request.ticketId, healthy.operationId).preview;
  assert.equal(preview.closeEligible, true);
  // An explicitly registered empty observation is still the latest operation.
  f.operation([], { beforeOperationId: null });
  await assert.rejects(f.service.close(f.project.id, request.ticketId, f.closeRequest(preview)), { code: 'STALE_FACTS' });
  const path = join(f.root, 'browser-operations', 'v1', source.operationId, 'evidence', source.report.evidenceManifest[0].file);
  const bytes = readFileSync(path); bytes[0] ^= 1; writeFileSync(path, bytes);
  const ticket = f.service.read(f.project.id, request.ticketId).ticket;
  assert.equal(ticket.processingStatus, 'open'); assert.equal(ticket.verificationStatus, 'integrity_blocked');
  assert.equal(ticket.closeEligible, false);
  const markdown = f.service.exportTicket(f.project.id, request.ticketId, 'md').bytes.toString('utf8');
  assert.match(markdown, /integrity\\_blocked/); assert.match(markdown, /当前证据未核验/);
  assert.equal(f.service.action(f.project.id, request.actionId).eventSha256, created.payload.eventSha256);
  assert.equal((await f.service.create(f.project.id, request)).payload.replayed, true, 'existing exact action wins over unavailable source');
  const unknown = f.service.action(f.project.id, uid('da'));
  assert.equal(unknown.outcome, 'unresolved'); assert.equal(unknown.reason, 'ABSENCE_IS_NOT_A_COMMIT_DECISION');
});

test('a post-publication read failure remains unknown while its exact durable action can be reconciled read-only', async t => {
  const f = await fixture(t), source = f.operation([0]), request = f.createRequest(source);
  const nativeOpen = fs.openSync, nativeUnlink = fs.unlinkSync; let published = false, injected = false;
  fs.unlinkSync = function (path, ...args) {
    const result = Reflect.apply(nativeUnlink, fs, [path, ...args]);
    if (String(path).includes('.defect-ticket-') && String(path).endsWith('.tmp')) published = true;
    return result;
  };
  fs.openSync = function (path, ...args) {
    if (published && !injected && String(path).endsWith(request.actionId + '.json')) {
      injected = true; const error = new Error('private path / secret must never escape'); error.code = 'EIO'; throw error;
    }
    return Reflect.apply(nativeOpen, fs, [path, ...args]);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(f.service.create(f.project.id, request), error => error.writeMayHaveCommitted === true && error.code === 'INTEGRITY_BLOCKED'); }
  finally { fs.openSync = nativeOpen; fs.unlinkSync = nativeUnlink; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  const names = operationNames(f), receipt = f.service.action(f.project.id, request.actionId);
  assert.equal(receipt.outcome, 'recorded'); assert.equal(receipt.ticketId, request.ticketId);
  assert.equal(receipt.event.requestFingerprint, receipt.requestFingerprint);
  assert.deepEqual(operationNames(f), names, 'reconciliation cannot execute or register anything');
});

test('completion without registration cannot create a ticket and source selection does not write actions', async t => {
  const f = await fixture(t), source = f.operation([0], { registered: false });
  const request = f.createRequest(source), before = readdirSync(f.root).sort();
  await assert.rejects(f.service.create(f.project.id, request), { code: 'SOURCE_NOT_ELIGIBLE' });
  assert.deepEqual(readdirSync(f.root).sort(), before);
  f.store.registerResult(source.operationId);
  const listing = f.service.sources(f.project.id, f.candidate.id);
  assert.equal(listing.operations.length, 1); assert.equal(listing.operations[0].members.length, 1);
  assert.equal(listing.operations[0].members[0].checkId, source.report.checks[0].id);
  assert.deepEqual(readdirSync(f.root).sort(), before);
});

test('an unavailable first ticket candidate does not block another valid candidate in the project list', async t => {
  const f = await fixture(t), original = f.operation([0]);
  const first = { ...f.createRequest(original), ticketId: fixedId('dt', 1) };
  await f.service.create(f.project.id, first);
  const other = await secondDefectTicketCandidate(f, f.catalog);
  validateAcceptanceCatalog(f.catalog); writeFileSync(join(f.root, 'catalog.json'), encode(f.catalog));
  const request = { ...f.request(), candidateId: other.candidate.id, contentDigest: other.candidate.contentDigest };
  f.store.publish({ ...other, request }); const run = f.store.createRun(request.operationId);
  const failed = f.store.finishRun(request.operationId, browserOperationRaw(other, run, { bug: true }));
  f.store.registerResult(request.operationId);
  const second = { ...f.createRequest(failed), ticketId: fixedId('dt', 2) };
  await f.service.create(f.project.id, second);
  // A separately valid catalog snapshot no longer offers the first scope.
  // This changes no stored ticket event or Browser artifact.
  delete f.catalog.browserCandidates[f.candidate.id];
  f.catalog.events = f.catalog.events.filter(event => event.entityId !== f.candidate.id);
  rehashEvents(f.catalog); validateAcceptanceCatalog(f.catalog);
  writeFileSync(join(f.root, 'catalog.json'), encode(f.catalog));
  const listing = f.service.list(f.project.id);
  assert.equal(listing.tickets[0].ticketId, first.ticketId);
  assert.equal(listing.tickets[0].verificationStatus, 'integrity_blocked');
  assert.equal(listing.tickets[1].ticketId, second.ticketId);
  assert.equal(listing.tickets[1].verificationStatus, 'still_failed');
  assert.equal(f.service.read(f.project.id, second.ticketId).ticket.verificationStatus, 'still_failed');
});

test('preview selectors reject non-string hooks before any model serialization', async t => {
  const f = await fixture(t); let touches = 0;
  const value = { toJSON() { touches++; return uid('bo'); } };
  assert.throws(() => f.service.previewClose(f.project.id, uid('dt'), value), { code: 'INVALID_INPUT' });
  assert.equal(touches, 0);
});

function originalConfirmation(projectId, ticketId, kind, raw) {
  const request = kind === 'create' ? validateDefectTicketCreateRequest(raw) : validateDefectTicketCloseRequest(raw);
  return { version: 1, projectId, ticketId, kind, actionId: request.actionId,
    requestFingerprint: defectTicketRequestFingerprint({ projectId, ticketId, kind, request }), request };
}

test('D6 permanent rejection preserves ticket facts and seals create/close action IDs across restart', async t => {
  const f = await fixture(t), source = f.operation([0, 1]), create = f.createRequest(source);
  const original = originalConfirmation(f.project.id, create.ticketId, 'create', create), names = operationNames(f);
  const denied = await f.service.deny(f.project.id, create.actionId, original);
  assert.equal(denied.status, 201); assert.equal(denied.payload.outcome, 'rejected');
  assert.deepEqual(denied.payload.rejection.original, original);
  assert.equal(f.service.list(f.project.id).ticketCount, 0);
  const restarted = createDefectTicketService({ owner: f.owner });
  assert.equal(restarted.action(f.project.id, create.actionId).rejectionSha256, denied.payload.rejectionSha256);
  const replay = await restarted.create(f.project.id, create);
  assert.equal(replay.status, 200); assert.equal(replay.payload.outcome, 'rejected');
  assert.equal(replay.payload.rejectionSha256, denied.payload.rejectionSha256);
  await assert.rejects(restarted.create(f.project.id, { ...create, title: 'Different confirmation' }), { code: 'ACTION_CONFLICT' });
  assert.deepEqual(operationNames(f), names);
  const fresh = { ...create, actionId: uid('da') };
  await restarted.create(f.project.id, fresh);
  const healthy = f.operation([]), preview = restarted.previewClose(f.project.id, fresh.ticketId, healthy.operationId).preview;
  const closing = f.closeRequest(preview), closeOriginal = originalConfirmation(f.project.id, fresh.ticketId, 'close', closing);
  const before = restarted.read(f.project.id, fresh.ticketId), beforeExport = JSON.parse(restarted.exportTicket(f.project.id, fresh.ticketId, 'json').bytes);
  const closeDenied = await restarted.deny(f.project.id, closing.actionId, closeOriginal);
  assert.equal(closeDenied.payload.outcome, 'rejected');
  assert.equal((await restarted.close(f.project.id, fresh.ticketId, closing)).payload.outcome, 'rejected');
  assert.deepEqual(restarted.read(f.project.id, fresh.ticketId), before);
  const afterExport = JSON.parse(restarted.exportTicket(f.project.id, fresh.ticketId, 'json').bytes);
  delete beforeExport.exportedAt; delete afterExport.exportedAt; assert.deepEqual(afterExport, beforeExport);
  const freshClose = f.closeRequest(preview), closed = await restarted.close(f.project.id, fresh.ticketId, freshClose);
  assert.equal(closed.payload.outcome, 'recorded'); assert.equal(closed.payload.event.revision, 1);
  const closeWinner = await restarted.deny(f.project.id, closed.payload.actionId,
    originalConfirmation(f.project.id, fresh.ticketId, 'close', freshClose));
  assert.equal(closeWinner.status, 200); assert.equal(closeWinner.payload.outcome, 'recorded');
  assert.equal(closeWinner.payload.eventSha256, closed.payload.eventSha256);
});

test('D6 complete accepted/rejected proofs precede damaged catalog, source, readiness and full queue', async t => {
  for (const decision of ['recorded', 'rejected']) {
    const f = await fixture(t), source = f.operation([0]), request = f.createRequest(source);
    const original = originalConfirmation(f.project.id, request.ticketId, 'create', request);
    const result = decision === 'recorded' ? await f.service.create(f.project.id, request)
      : await f.service.deny(f.project.id, request.actionId, original);
    writeFileSync(join(f.root, 'catalog.json'), '{corrupt current catalog');
    const evidence = join(f.root, 'browser-operations', 'v1', source.operationId, 'evidence', source.report.evidenceManifest[0].file);
    writeFileSync(evidence, 'corrupt current source');
    let readyReads = 0;
    const service = createDefectTicketService({ owner: f.owner, storeLimits: { queue: 0 }, assertReady() { readyReads++; return false; } });
    assert.equal(service.action(f.project.id, request.actionId).outcome, decision);
    assert.equal((await service.create(f.project.id, request)).payload.outcome, decision);
    assert.equal((await service.deny(f.project.id, request.actionId, original)).payload.outcome, decision);
    assert.equal(readyReads, 0, 'existing proofs cannot depend on current admission');
    assert.equal(service.action(f.project.id, request.actionId).requestFingerprint, result.payload.requestFingerprint);
    assert.throws(() => service.deny(f.project.id, uid('da'), original), { code: 'INVALID_INPUT' });
  }
});

test('D6 new denial requires a current project and synchronous ready guard but no ticket or source', async t => {
  const f = await fixture(t), raw = f.createRequest({ operationId: uid('bo'), report: { checks: [{ id: 'missing-source', status: 'failed' }] } });
  const original = originalConfirmation(f.project.id, raw.ticketId, 'create', raw);
  let ready = false, reads = 0;
  const service = createDefectTicketService({ owner: f.owner, assertReady() { reads++; return ready; } });
  await assert.rejects(service.deny(f.project.id, raw.actionId, original), { code: 'INTEGRITY_BLOCKED' });
  assert.equal(fs.existsSync(join(f.root, 'defect-tickets')), false);
  ready = true;
  assert.equal((await service.deny(f.project.id, raw.actionId, original)).payload.outcome, 'rejected');
  assert.ok(reads > 1, 'new decision rechecks readiness before publication');
  const otherProject = uid('ap'), otherRaw = { ...raw, actionId: uid('da') };
  const otherOriginal = originalConfirmation(otherProject, raw.ticketId, 'create', otherRaw);
  await assert.rejects(service.deny(otherProject, otherRaw.actionId, otherOriginal), { code: 'NOT_FOUND' });
  for (const guard of [() => false, () => null, () => 1, () => ({}), () => Promise.resolve(true), () => Promise.reject(Error('private guard failure'))]) {
    const guarded = createDefectTicketService({ owner: f.owner, assertReady: guard });
    const request = { ...raw, actionId: uid('da') }, confirmation = originalConfirmation(f.project.id, raw.ticketId, 'create', request);
    await assert.rejects(guarded.deny(f.project.id, request.actionId, confirmation), { code: 'INTEGRITY_BLOCKED' });
  }
  assert.throws(() => createDefectTicketService({ owner: f.owner, assertReady: async () => true }), { code: 'INVALID_INPUT' });
});

test('D6 service rechecks admission before and after rejection publication without losing uncertainty', async t => {
  for (const phase of ['staged', 'published']) {
    const f = await fixture(t), request = f.createRequest({ operationId: uid('bo'), report: { checks: [{ id: 'uncaptured', status: 'failed' }] } });
    const original = originalConfirmation(f.project.id, request.ticketId, 'create', request);
    let ready = true, injected = false;
    const service = createDefectTicketService({ owner: f.owner, assertReady: () => ready });
    const nativeFsync = fs.fsyncSync, nativeUnlink = fs.unlinkSync, nativeOpen = fs.openSync, temporaryFds = new Set();
    if (phase === 'staged') {
      fs.openSync = function (path, ...args) {
        const fd = Reflect.apply(nativeOpen, fs, [path, ...args]);
        if (String(path).includes('.defect-ticket-') && String(path).endsWith('.tmp') && args[0] === 'wx') temporaryFds.add(fd);
        return fd;
      };
      fs.fsyncSync = function (fd, ...args) {
        const result = Reflect.apply(nativeFsync, fs, [fd, ...args]);
        if (temporaryFds.has(fd)) { injected = true; ready = false; }
        return result;
      };
    }
    else fs.unlinkSync = function (path, ...args) {
      const result = Reflect.apply(nativeUnlink, fs, [path, ...args]);
      if (String(path).includes('.defect-ticket-') && String(path).endsWith('.tmp')) { injected = true; ready = false; }
      return result;
    };
    syncBuiltinESMExports();
    try {
      await assert.rejects(service.deny(f.project.id, request.actionId, original),
        error => error.code === 'INTEGRITY_BLOCKED' && (error.writeMayHaveCommitted === true) === (phase === 'published'));
    } finally { fs.fsyncSync = nativeFsync; fs.unlinkSync = nativeUnlink; fs.openSync = nativeOpen; syncBuiltinESMExports(); }
    assert.equal(injected, true);
    const target = join(f.root, 'defect-tickets', 'v1', 'events', request.actionId + '.json');
    assert.equal(fs.existsSync(target), phase === 'published');
    if (phase === 'published') {
      const proof = service.action(f.project.id, request.actionId);
      assert.equal(proof.outcome, 'rejected', 'an existing complete proof survives blocked admission');
      assert.deepEqual(proof.rejection.original, original);
    }
    assert.equal(fs.existsSync(join(f.root, 'browser-operations')), false, 'deny cannot create an execution namespace');
  }
});

test('D6 synchronous readiness rejects hostile promise results without constructor hooks or unhandled rejection', async t => {
  const f = await fixture(t), request = f.createRequest({ operationId: uid('bo'), report: { checks: [{ id: 'uncaptured', status: 'failed' }] } });
  const original = originalConfirmation(f.project.id, request.ticketId, 'create', request);
  let hooks = 0;
  const result = Promise.resolve(true);
  Object.defineProperty(result, 'constructor', { get() { hooks++; throw Error('must never run'); } });
  const proxy = new Proxy({}, { get() { hooks++; throw Error('must never run'); }, getPrototypeOf() { hooks++; throw Error('must never run'); } });
  for (const assertReady of [() => result, () => proxy, () => { throw Promise.reject(Error('private thrown readiness promise')); }]) {
    const service = createDefectTicketService({ owner: f.owner, assertReady });
    await assert.rejects(service.deny(f.project.id, request.actionId, original), { code: 'INTEGRITY_BLOCKED' });
  }
  await new Promise(setImmediate);
  assert.equal(hooks, 0); assert.equal(fs.existsSync(join(f.root, 'defect-tickets')), false);
  assert.throws(() => createDefectTicketService({ owner: f.owner, assertReady: function* () { yield true; } }), { code: 'INVALID_INPUT' });
});

async function ticketHttp(t, service) {
  let signalIngress, signalPrefix;
  const ingress = new Promise(resolve => { signalIngress = resolve; }), prefix = new Promise(resolve => { signalPrefix = resolve; });
  const server = createServer((req, res) => {
    if (req.headers['x-delayed-original'] === '1') { signalIngress(); req.once('data', signalPrefix); }
    const json = (response, status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); };
    handleDefectTicketRequest(req, res, new URL(req.url, 'http://fixture'), { service, json })
      .then(handled => { if (!handled) json(res, 404, {}); }).catch(error => { res.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (path, body) => new Promise((resolve, reject) => {
    const bytes = Buffer.from(JSON.stringify(body));
    // Each assertion gets one fresh connection. Long synchronous source checks
    // must not leave a pooled idle socket to race the server's keep-alive close.
    const request = httpRequest(base + path, { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length },
      signal: AbortSignal.timeout(30000) }, incoming => {
      const chunks = []; incoming.on('data', bytes => chunks.push(bytes));
      incoming.once('error', reject); incoming.once('aborted', () => reject(Error('fixture POST response aborted')));
      incoming.once('end', () => {
        try { resolve({ status: incoming.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }); }
        catch (error) { reject(error); }
      });
    });
    request.once('error', reject); t.after(() => request.destroy()); request.end(bytes);
  });
  function delayed(path, body) {
    const bytes = Buffer.from(JSON.stringify(body)); let complete;
    const response = new Promise((resolve, reject) => {
      const request = httpRequest(base + path, { method: 'POST', headers: { 'content-type': 'application/json',
        'content-length': bytes.length, 'x-delayed-original': '1' } }, incoming => {
        const chunks = []; incoming.on('data', bytes => chunks.push(bytes)); incoming.once('error', reject);
        incoming.once('end', () => { try { resolve({ status: incoming.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
      });
      request.once('error', reject); request.setTimeout(30000, () => request.destroy(Error('fixture delayed body timeout')));
      t.after(() => request.destroy()); complete = () => request.end(bytes.subarray(bytes.length - 1));
      request.write(bytes.subarray(0, bytes.length - 1));
    });
    return { response, ingress, prefix, complete };
  }
  return { post, delayed };
}

for (const kind of ['create', 'close']) for (const winner of ['rejected', 'recorded']) {
  test(`D6 native HTTP ${kind}: ${winner} wins the same action while original body tail is held`, { timeout: 120000 }, async t => {
    const f = await fixture(t), source = f.operation([0, 1]);
    let raw = f.createRequest(source), ticketId = raw.ticketId;
    if (kind === 'close') {
      await f.service.create(f.project.id, raw); const healthy = f.operation([]);
      raw = f.closeRequest(f.service.previewClose(f.project.id, ticketId, healthy.operationId).preview);
    }
    const original = originalConfirmation(f.project.id, ticketId, kind, raw), http = await ticketHttp(t, f.service);
    const root = '/api/acceptance/projects/' + f.project.id + '/defect-tickets';
    const path = kind === 'create' ? root : root + '/' + ticketId + '/close';
    const actions = join(f.root, 'defect-tickets', 'v1', 'events');
    const before = kind === 'close' ? f.service.read(f.project.id, ticketId) : null;
    const browserNames = operationNames(f), held = http.delayed(path, raw);
    await held.ingress; await held.prefix;
    assert.equal(f.service.action(f.project.id, raw.actionId).outcome, 'unresolved');
    let denied, submitted;
    const denyBody = { schemaVersion: 1, confirmed: true, original };
    if (winner === 'rejected') {
      denied = await http.post(root + '/actions/' + raw.actionId + '/deny', denyBody);
      assert.equal(denied.status, 201); held.complete(); submitted = await held.response;
      assert.equal(submitted.status, 200); assert.equal(submitted.payload.rejectionSha256, denied.payload.rejectionSha256);
      if (kind === 'create') assert.equal(f.service.list(f.project.id).ticketCount, 0);
      else assert.deepEqual(f.service.read(f.project.id, ticketId), before);
    } else {
      held.complete(); submitted = await held.response; assert.equal(submitted.status, 201);
      denied = await http.post(root + '/actions/' + raw.actionId + '/deny', denyBody);
      assert.equal(denied.status, 200); assert.equal(denied.payload.eventSha256, submitted.payload.eventSha256);
      assert.equal(f.service.read(f.project.id, ticketId).ticket.processingStatus, kind === 'close' ? 'closed' : 'open');
    }
    assert.equal(submitted.payload.outcome, winner); assert.equal(denied.payload.outcome, winner);
    assert.deepEqual(operationNames(f), browserNames, 'decision competition never executes a Browser run');
    const filenames = readdirSync(actions);
    assert.equal(filenames.filter(name => name === raw.actionId + '.json').length, 1);
    assert.equal(filenames.length, kind === 'close' ? 2 : 1);
    const late = await http.post(path, raw); assert.equal(late.status, 200); assert.equal(late.payload.outcome, winner);
    const changed = await http.post(path, { ...raw, [kind === 'create' ? 'title' : 'resolution']: 'Another original' });
    assert.equal(changed.status, 409); assert.equal(changed.payload.code, 'ACTION_CONFLICT');
  });
}
