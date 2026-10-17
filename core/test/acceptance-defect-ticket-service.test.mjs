import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDefectTicketService } from '../src/acceptance/defect-ticket-service.mjs';
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
