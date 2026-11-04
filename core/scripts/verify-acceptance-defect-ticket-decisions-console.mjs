#!/usr/bin/env node
/** Independent D6 artifact/byte/order checks. Does not start Browser, engine or target requests. */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

assert.equal(process.argv.length, 3, 'Usage: node core/scripts/verify-acceptance-defect-ticket-decisions-console.mjs <OUT>');
const OUT = realpathSync(resolve(process.argv[2])), ROOT = join(OUT, 'runtime/acceptance');
const CORE = fileURLToPath(new URL('../', import.meta.url));
const implementationSourcePaths = [
  'src/acceptance/defect-ticket-schema.mjs', 'src/acceptance/defect-ticket-store.mjs', 'src/acceptance/defect-ticket-service.mjs',
  'src/acceptance/defect-ticket-api.mjs', 'src/engine-server.mjs', '../console/src/acceptance-defect-tickets.js', '../console/src/AcceptanceDefectTickets.vue',
  'scripts/smoke-acceptance-defect-ticket-decisions-console.mjs', 'scripts/fixtures/defect-ticket-decision-relay.mjs',
  'scripts/fixtures/defect-ticket-decision-ingress.mjs', 'scripts/fixtures/browser-resolution-stream.mjs', 'scripts/verify-acceptance-defect-ticket-decisions-console.mjs',
];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']' : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
const raw = name => { const file = join(OUT, name), stat = lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1); return readFileSync(file); };
const json = name => JSON.parse(raw(name)), lines = name => raw(name).toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
const fields = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());
const exactOriginal = (a, b) => assert.equal(canonical(a), canonical(b));
const uuid = prefix => new RegExp(`^${prefix}-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$`);
const timeOf = value => {
  assert.equal(typeof value.at, 'string'); const time = Date.parse(value.at); assert(Number.isFinite(time));
  assert.equal(new Date(time).toISOString(), value.at, 'Evidence timestamps must be exact ISO timestamps.'); return time;
};
function orderedTimes(values, label) {
  let previous = -Infinity;
  for (const value of values) { const time = timeOf(value); assert(time >= previous, label + ' timestamps must not move backwards.'); previous = time; }
}
const required = ['realCapturedSource', 'registeredTwoFixedFailures', 'registeredHealthyTwoMembers', 'fourUniqueOriginalActions',
  'realUIOriginsAndReceiptScope', 'sameUniqueUpstreamBodyPerCase', 'denyAndAcceptedMutuallyExclusive',
  'noTargetOrSourceOrBrowserOrCatalogSideEffects', 'sourceOriginalBytesRemain', 'pendingLayoutsDesktopMobile',
  'onlyExactControlledHttp502Errors', 'implementationInputsUnchanged', 'fourCompleteCases'];
const caseRequired = ['uiOriginalBound', 'prefixObservedBeforeDownstream502', 'controlled502FinishedNormally',
  'unknownRetainsFullOriginal', 'readOnlyUnresolvedPreservesOriginal', 'manualDenyBoundExact', 'winnerOrderingProved',
  'completeProofMatchesDisk', 'lateOriginalMatchesWinningDecision', 'oneUpstreamRequestAndBodyEnd', 'oneDenyRequestAndOneForward',
  'pendingReleasedAfterProof', 'uiOutcomeAndDraft', 'ticketEffectMatchesWinner', 'sideEffectsUnchanged',
  'decisionTreeOnlyExpectedAddition', 'postGetMatchesWinner'];
const expected = [['A', 'create', 'rejected'], ['B', 'create', 'recorded'], ['C', 'close', 'rejected'], ['D', 'close', 'recorded']];
function tree(root) {
  const result = {};
  for (const name of readdirSync(root).sort()) {
    const file = join(root, name), stat = lstatSync(file); assert(!stat.isSymbolicLink());
    if (stat.isDirectory()) for (const [key, value] of Object.entries(tree(file))) result[name + '/' + key] = value;
    else { assert(stat.isFile() && stat.nlink === 1); const bytes = readFileSync(file); result[name] = { bytes: bytes.length, sha256: sha(bytes) }; }
  }
  return result;
}
function validateImplementationInputs(value) {
  fields(value, ['sources', 'consoleBundle']); fields(value.sources, implementationSourcePaths);
  assert(value.consoleBundle && typeof value.consoleBundle === 'object' && !Array.isArray(value.consoleBundle));
  assert(Object.keys(value.consoleBundle).length > 0, 'The built console bundle must be present.');
  for (const entry of [...Object.values(value.sources), ...Object.values(value.consoleBundle)]) {
    fields(entry, ['bytes', 'sha256']); assert(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0);
    assert.equal(typeof entry.sha256, 'string'); assert(/^[a-f0-9]{64}$/.test(entry.sha256));
  }
  return value;
}
function currentImplementationInputs() {
  return {
    sources: Object.fromEntries(implementationSourcePaths.map(name => {
      const file = resolve(CORE, name), stat = lstatSync(file); assert(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1);
      const bytes = readFileSync(file); return [name, { bytes: bytes.length, sha256: sha(bytes) }];
    })),
    consoleBundle: tree(resolve(CORE, '../console/dist')),
  };
}
const summary = json('summary.json');
assert.equal(summary.schemaVersion, 1); assert.equal(summary.kind, 'manual-defect-ticket-decision-browser-smoke'); assert.equal(summary.passed, true);
assert.equal(summary.caseCount, 4); assert.equal(summary.cases.length, 4); assert.deepEqual(summary.requiredChecks, required); assert.deepEqual(summary.caseCheckNames, caseRequired);
assert.equal(summary.checkCount, required.length); fields(summary.checks, required); required.forEach(name => assert.equal(summary.checks[name], true));
assert.deepEqual(json('checks.json'), summary.checks); assert.deepEqual(summary.pageErrors, []);
const inputsBefore = validateImplementationInputs(json('implementation-inputs-before.json'));
const inputsAfter = validateImplementationInputs(json('implementation-inputs-after.json'));
assert.deepEqual(inputsBefore, inputsAfter);
assert.deepEqual(inputsBefore, currentImplementationInputs(), 'Evidence inputs must match current repository sources and the current built console bundle.');
assert.equal(new Set(summary.cases.map(value => value.actionId)).size, 4); assert.notEqual(summary.engineBase, summary.uiBase);
for (const base of [summary.engineBase, summary.uiBase, summary.targetBase]) { const url = new URL(base); assert.equal(url.hostname, '127.0.0.1'); assert.equal(url.protocol, 'http:'); }
assert(!['5173', '5174', '5175'].includes(new URL(summary.uiBase).port));
const requests = json('browser-requests.json'), responses = json('browser-responses.json'), allIngress = lines('ingress.jsonl'), relay = lines('relay.jsonl');
const cdp = json('cdp-network.json'), completions = json('playwright-completions.json');
function assertActionRequestCompleted(request, expectedStatus, expectedRaw, downstream) {
  const response = responses.filter(value => value.requestId === request.id); assert.equal(response.length, 1);
  assert.equal(response[0].status, expectedStatus); assert.equal(response[0].bodySha256, sha(expectedRaw));
  assert.deepEqual(Buffer.from(response[0].rawBody), expectedRaw);
  if (response[0].bodySource === 'relay-complete-action-response') assert.equal(response[0].downstreamResponseFinished, true);
  const completion = completions.filter(value => value.requestId === request.id); assert.equal(completion.length, 1);
  assert.equal(downstream.length, 1); assert.equal(downstream[0].writableEnded, true); assert.equal(downstream[0].writableFinished, true);
  const nativeRequest = cdp.filter(value => value.event === 'request' && value.method === request.method && value.url === request.url
    && value.bodySha256 === request.bodySha256); assert.equal(nativeRequest.length, 1);
  const nativeEvents = cdp.filter(value => value.requestId === nativeRequest[0].requestId);
  const nativeResponse = nativeEvents.filter(value => value.event === 'response'); assert.equal(nativeResponse.length, 1); assert.equal(nativeResponse[0].status, expectedStatus);
  if (request.finished === true) {
    assert.equal(request.failed, null); assert.equal(completion[0].event, 'finished');
    assert.equal(nativeEvents.filter(value => value.event === 'finished').length, 1);
    assert.equal(nativeEvents.filter(value => value.event === 'failed').length, 0);
    return;
  }
  assert.equal(request.finished, false); assert.deepEqual(request.failed, { errorText: 'net::ERR_ABORTED' });
  assert.equal(completion[0].event, 'failed'); assert.deepEqual(completion[0].failure, request.failed);
  assert.equal(response[0].bodySource, 'relay-complete-action-response');
  const nativeFailure = nativeEvents.filter(value => value.event === 'failed'); assert.equal(nativeFailure.length, 1);
  assert.equal(nativeFailure[0].errorText, 'net::ERR_ABORTED'); assert.equal(nativeFailure[0].canceled, true);
  assert.equal(nativeEvents.filter(value => value.event === 'finished').length, 0);
}
assert(requests.length > 0); assert(requests.every(value => value.origin === summary.uiBase));
assert.equal(relay.filter(value => ['fixture-error', 'proxy-error', 'original-upstream-error'].includes(value.event)).length, 0);
assert(responses.every(value => !value.readFailure));
for (const response of responses.filter(value => value.browserBodyReadFailure)) {
  assert.match(response.browserBodyReadFailure, /Network\.getResponseBody|navigated away/);
  assert.equal(response.bodySource, 'relay-complete-action-response');
  assert(relay.some(value => value.event === 'action-response-end' && value.method === response.method && value.path === response.path
    && value.status === response.status && value.bodySha256 === response.bodySha256));
  assert(relay.some(value => value.event === 'action-response-downstream-finish' && value.method === response.method && value.path === response.path
    && value.status === response.status && value.bodySha256 === response.bodySha256 && value.writableFinished === true));
}
for (const response of responses.filter(value => value.bodySource === 'relay-complete-action-response')) {
  assert(relay.some(value => value.event === 'action-response-end' && value.method === response.method && value.path === response.path
    && value.status === response.status && value.bodySha256 === response.bodySha256));
}
const originals = [], outcomes = [];
for (const [index, [caseId, kind, winner]] of expected.entries()) {
  const prefix = 'case-' + caseId + '/', item = json(prefix + 'case.json'); assert.deepEqual(item, summary.cases[index]);
  assert.equal(item.caseId, caseId); assert.equal(item.kind, kind); assert.equal(item.intendedWinner, winner); assert.equal(item.actualOutcome, winner); assert.equal(item.completed, true);
  fields(item.checks, caseRequired); caseRequired.forEach(name => assert.equal(item.checks[name], true, caseId + '.' + name));
  const original = json(prefix + 'original-confirmation.json'), body = raw(prefix + 'original-ui-body.raw.json'), originalStorage = json(prefix + 'original-storage-before.json');
  fields(original, ['version', 'projectId', 'ticketId', 'kind', 'actionId', 'requestFingerprint', 'request']); assert.equal(original.version, 1);
  assert(uuid('ap').test(original.projectId)); assert(uuid('dt').test(original.ticketId)); assert(uuid('da').test(original.actionId)); assert.equal(original.kind, kind);
  assert.equal(original.actionId, item.actionId); assert.equal(original.ticketId, item.ticketId); exactOriginal(original.request, JSON.parse(body));
  assert.equal(original.actionId, original.request.actionId); assert.equal(original.requestFingerprint, item.requestFingerprint);
  assert.equal(original.requestFingerprint, sha(Buffer.from(canonical({ domain: 'heimdall-defect-ticket-request', version: 1,
    projectId: original.projectId, ticketId: original.ticketId, kind, request: original.request }))));
  if (kind === 'create') {
    assert.equal(original.ticketId, original.request.ticketId); assert.deepEqual(original.request.memberCheckIds, [...original.request.memberCheckIds].sort()); assert.equal(original.request.memberCheckIds.length, 2);
  }
  assert.equal(originalStorage.key, `heimdall:defect-tickets:v1:${summary.uiBase}:${original.projectId}`);
  assert.deepEqual(originalStorage.values, [original]); assert.equal(originalStorage.raw, canonical([original]));
  assert.deepEqual(json(prefix + 'original-storage-after.json').values, []);
  const basePath = '/api/acceptance/projects/' + original.projectId + '/defect-tickets', path = basePath + (kind === 'close' ? '/' + original.ticketId + '/close' : '');
  const events = json(prefix + 'relay-events.json');
  const uiOriginal = requests.filter(value => value.method === 'POST' && value.path === path && value.body?.actionId === original.actionId);
  assert.equal(uiOriginal.length, 1);
  assert.equal(uiOriginal[0].rawBody, body.toString('utf8')); assert.equal(uiOriginal[0].bodySha256, sha(body)); assert.equal(uiOriginal[0].bytes, body.length); assert.equal(item.rawBodySha256, sha(body));
  const originalReplies = responses.filter(value => value.requestId === uiOriginal[0].id); assert.equal(originalReplies.length, 1); assert.equal(originalReplies[0].status, 502);
  const controlledRaw = raw(prefix + 'controlled-http-502.raw.json'), controlledPayload = JSON.parse(controlledRaw);
  assertActionRequestCompleted(uiOriginal[0], 502, controlledRaw, events.filter(value => value.event === 'original-downstream-finish'));
  assert.deepEqual(controlledPayload, { code: 'D6_CONTROLLED_HTTP_502', error: 'Controlled relay response; original action remains unknown.', outcomeUnknown: true });
  assert.equal(originalReplies[0].rawBody, controlledRaw.toString('utf8')); assert.equal(originalReplies[0].bodySha256, sha(controlledRaw)); assert.deepEqual(originalReplies[0].payload, controlledPayload);
  const nativeRequest = cdp.filter(value => value.event === 'request' && value.method === 'POST' && value.url === summary.uiBase + path && value.bodySha256 === sha(body));
  assert.equal(nativeRequest.length, 1); const nativeEvents = cdp.filter(value => value.requestId === nativeRequest[0].requestId);
  const nativeReply = nativeEvents.filter(value => value.event === 'response'); assert.equal(nativeReply.length, 1); assert.equal(nativeReply[0].status, 502);
  const responseHeaders = Object.fromEntries(Object.entries(nativeReply[0].headers).map(([key, value]) => [key.toLowerCase(), value]));
  assert.equal(responseHeaders['content-type'], 'application/json; charset=utf-8'); assert.equal(responseHeaders['content-length'], String(controlledRaw.length));
  assert.equal(responseHeaders['cache-control'], 'no-store'); assert.equal(nativeEvents.filter(value => value.event === 'finished').length, 1);
  assert.equal(nativeEvents.filter(value => value.event === 'failed').length, 0);
  const originalCompletions = completions.filter(value => value.requestId === uiOriginal[0].id);
  assert.equal(originalCompletions.length, 1); assert.equal(originalCompletions[0].event, 'finished'); assert.equal(originalCompletions[0].mapped, true);
  const deny = raw(prefix + 'deny-ui-body.raw.json'); exactOriginal(JSON.parse(deny), { schemaVersion: 1, confirmed: true, original });
  const uiDeny = requests.filter(value => value.method === 'POST' && value.path === basePath + '/actions/' + original.actionId + '/deny'); assert.equal(uiDeny.length, 1);
  assert.equal(uiDeny[0].rawBody, deny.toString('utf8')); assert.equal(uiDeny[0].bodySha256, sha(deny));
  const uiGets = requests.filter(value => value.method === 'GET' && value.url === summary.uiBase + basePath + '/actions/' + original.actionId);
  assert.equal(uiGets.length, 2, 'One explicit read-only check and one real deny preflight.');
  for (const get of uiGets) { const values = responses.filter(value => value.requestId === get.id); assert.equal(values.length, 1); assert.equal(values[0].status, 200); assert.equal(values[0].payload.outcome, 'unresolved'); }
  for (const filename of ['read-only-unresolved.json', 'deny-preflight-unresolved.json']) {
    const value = json(prefix + filename); assert.equal(value.outcome, 'unresolved'); assert.equal(value.reason, 'ABSENCE_IS_NOT_A_COMMIT_DECISION'); assert.equal(value.actionId, original.actionId);
  }
  const before = json(prefix + 'baseline.json'), after = json(prefix + 'side-effects-after.json'); assert.deepEqual(before.originals, after.originals); assert.equal(before.targetCount, after.targetCount);
  const decisionRaw = raw(prefix + 'decision.raw.json'), decision = JSON.parse(decisionRaw); assert.equal(decisionRaw.toString('utf8'), canonical(decision) + '\n');
  assert.equal(item.decisionSha256, sha(decisionRaw)); assert.deepEqual(readFileSync(join(ROOT, 'defect-tickets/v1/events', original.actionId + '.json')), decisionRaw);
  assert.deepEqual(after.decisions, { ...before.decisions, ['v1/events/' + original.actionId + '.json']: { bytes: decisionRaw.length, sha256: sha(decisionRaw) } });
  const denyReplyRaw = raw(prefix + 'deny-response.raw.json');
  const replies = { original: JSON.parse(raw(prefix + 'original-upstream-response.raw.json')), deny: JSON.parse(denyReplyRaw), get: json(prefix + 'action-get.json') };
  const statuses = json(prefix + 'reply-statuses.json'); assert.equal(statuses.original, winner === 'rejected' ? 200 : 201); assert.equal(statuses.deny, winner === 'rejected' ? 201 : 200);
  assertActionRequestCompleted(uiDeny[0], statuses.deny, denyReplyRaw, relay.filter(value => value.event === 'action-response-downstream-finish'
    && value.method === 'POST' && value.path === uiDeny[0].path && value.bodySha256 === sha(denyReplyRaw)));
  const uiDenyReplies = responses.filter(value => value.requestId === uiDeny[0].id); assert.equal(uiDenyReplies.length, 1); assert.equal(uiDenyReplies[0].status, statuses.deny); assert.deepEqual(uiDenyReplies[0].payload, replies.deny);
  for (const proof of Object.values(replies)) {
    assert.equal(proof.schemaVersion, 1); assert.equal(proof.kind, 'manual-defect-ticket-action'); assert.equal(proof.outcome, winner);
    for (const key of ['projectId', 'ticketId', 'actionId', 'requestFingerprint']) assert.equal(proof[key], original[key]);
    if (winner === 'rejected') { assert.deepEqual(proof.rejection, decision); assert.equal(proof.rejectionSha256, sha(decisionRaw)); assert.equal(Object.hasOwn(proof, 'event'), false); }
    else { assert.deepEqual(proof.event, decision); assert.equal(proof.eventSha256, sha(decisionRaw)); assert.equal(Object.hasOwn(proof, 'rejection'), false); }
  }
  if (winner === 'rejected') {
    fields(decision, ['actionDecisionVersion', 'kind', 'original', 'effect', 'decidedAt', 'actor']); assert.equal(decision.actionDecisionVersion, 1);
    assert.equal(decision.kind, 'manual-defect-ticket-action-rejection'); assert.equal(decision.effect, 'deny-late-manual-defect-ticket-action'); exactOriginal(decision.original, original);
    assert.deepEqual(decision.actor, { kind: 'local-operator' }); assert.equal(new Date(decision.decidedAt).toISOString(), decision.decidedAt);
    assert.deepEqual(json(prefix + 'released-before-original-tail.json').values, []);
  } else {
    assert.equal(decision.ticketContractVersion, 1); assert.equal(decision.kind, kind); assert.equal(decision.actionId, original.actionId); assert.equal(decision.requestFingerprint, original.requestFingerprint);
    const accepted = json(prefix + 'accepted-before-deny-forward.json'); assert.equal(accepted.status, 201); assert.equal(accepted.denyForwardCount, 0); assert.equal(accepted.diskSha256, sha(decisionRaw)); assert.deepEqual(accepted.payload, replies.original);
    const request = kind === 'create' ? { ticketId: decision.ticketId, actionId: decision.actionId, sourceOperationId: decision.source.operationId,
      memberCheckIds: decision.members.map(value => value.checkId), title: decision.title, severity: decision.severity, description: decision.description, reproduction: decision.reproduction }
      : { actionId: decision.actionId, afterOperationId: decision.after.operationId, expectedRevision: decision.revision - 1,
        expectedHeadSha256: decision.previousEventSha256, memberSetDigest: decision.memberSetDigest, factsDigest: decision.factsDigest,
        previewDigest: decision.previewDigest, resolution: decision.resolution, confirmed: decision.confirmed };
    exactOriginal(request, original.request);
  }
  const prefixIngress = json(prefix + 'ingress-prefix.json'), complete = json(prefix + 'ingress-complete.json'), splitAt = Math.max(1, Math.floor(body.length / 2));
  assert.equal(prefixIngress.filter(value => value.event === 'request').length, 1); assert.equal(prefixIngress[0].contentLength, body.length);
  assert.equal(prefixIngress.at(-1).bytes, splitAt); assert.equal(prefixIngress.at(-1).bodySha256, sha(body.subarray(0, splitAt)));
  assert.equal(prefixIngress.filter(value => ['end', 'aborted', 'close'].includes(value.event)).length, 0);
  const traceId = prefixIngress[0].traceId, live = allIngress.filter(value => value.traceId === traceId);
  orderedTimes(live, caseId + ' ingress'); assert.deepEqual(prefixIngress, live.slice(0, prefixIngress.length));
  assert.equal(new Set(live.map(value => value.requestId)).size, 1); assert.equal(new Set(live.map(value => value.connectionId)).size, 1);
  assert.equal(live.filter(value => value.event === 'request').length, 1); assert.equal(live.filter(value => value.event === 'end').length, 1); assert.equal(live.filter(value => value.event === 'aborted').length, 0);
  assert(live.every(value => value.actionId === original.actionId && value.path === path));
  const end = live.find(value => value.event === 'end'); assert.equal(end.bytes, body.length); assert.equal(end.bodySha256, sha(body));
  assert.deepEqual(complete, live.slice(0, complete.length));
  const heldIngress = json(prefix + (winner === 'rejected' ? 'ingress-at-deny-ack.json' : 'ingress-at-held-deny.json'));
  assert.deepEqual(heldIngress, live.slice(0, heldIngress.length)); assert.equal(heldIngress.at(-1).bytes, splitAt);
  assert.equal(heldIngress.filter(value => ['end', 'aborted', 'close'].includes(value.event)).length, 0);
  const position = kind => events.findIndex(value => value.event === kind);
  orderedTimes(events, caseId + ' relay'); orderedTimes(nativeEvents, caseId + ' native network'); orderedTimes(originalCompletions, caseId + ' original completion');
  for (const kind of ['original-body', 'controlled-http-502', 'deny-body', 'deny-forward', 'deny-response', 'original-tail-release', 'original-upstream-response'])
    assert.equal(events.filter(value => value.event === kind).length, 1, caseId + '.' + kind);
  const controlledEvent = events[position('controlled-http-502')]; assert.equal(controlledEvent.bytes, controlledRaw.length); assert.equal(controlledEvent.bodySha256, sha(controlledRaw));
  assert.equal(controlledEvent.contentType, 'application/json; charset=utf-8');
  assert.equal(prefixIngress.at(-1).event, 'data'); assert(timeOf(prefixIngress.at(-1)) <= timeOf(controlledEvent), 'The real engine prefix must precede the controlled HTTP response.');
  assert(timeOf(events[position('original-tail-release')]) <= timeOf(end), 'The ingress body must end after the original tail is released.');
  assert(timeOf(end) <= timeOf(events[position('original-upstream-response')]), 'The complete ingress body must precede the original upstream response.');
  const diskControlled = relay.filter(value => value.event === 'controlled-http-502' && value.caseId === caseId); assert.deepEqual(diskControlled, [controlledEvent]);
  for (const name of ['original-downstream-finish', 'original-downstream-close']) {
    const values = events.filter(value => value.event === name); assert.equal(values.length, 1); assert.equal(values[0].writableEnded, true); assert.equal(values[0].writableFinished, true);
    assert(Date.parse(values[0].at) >= Date.parse(controlledEvent.at)); assert(Date.parse(values[0].at) <= Date.parse(events[position('deny-body')].at));
  }
  assert(Date.parse(nativeEvents.find(value => value.event === 'finished').at) <= Date.parse(events[position('deny-body')].at));
  assert(Date.parse(originalCompletions[0].at) <= Date.parse(events[position('deny-body')].at));
  assert(position('original-body') < position('controlled-http-502')); assert(position('controlled-http-502') < position('deny-body'));
  if (winner === 'rejected') { assert(position('deny-response') < position('original-tail-release')); assert(position('original-tail-release') < position('original-upstream-response')); }
  else { assert(position('deny-body') < position('original-tail-release')); assert(position('original-tail-release') < position('original-upstream-response')); assert(position('original-upstream-response') < position('deny-forward')); }
  assert.equal(events[position('original-body')].bodySha256, sha(body)); assert.equal(events[position('deny-body')].bodySha256, sha(deny));
  assert.equal(events[position('original-body')].host, new URL(summary.uiBase).host); assert.equal(events[position('original-body')].origin, summary.uiBase);
  const ticket = json(prefix + 'ticket-after.json'), ui = json(prefix + 'ui-outcome.json'); assert.deepEqual(ui.draftAfter, before.draft);
  if (winner === 'rejected') { assert(ui.notice.includes('原动作已永久拒绝')); if (kind === 'create') assert.deepEqual(ticket, { absent: true, code: 'NOT_FOUND' }); else assert.deepEqual(ticket, before.ticket); }
  else { assert(ui.notice.includes('原动作已记录')); assert.equal(ticket.ticket.revision, kind === 'create' ? 0 : 1); assert.equal(ticket.ticket.processingStatus, kind === 'create' ? 'open' : 'closed'); }
  originals.push(original); outcomes.push({ caseId, kind, winner, actionId: original.actionId, originalBodySha256: sha(body), decisionSha256: sha(decisionRaw) });
}
assert.notEqual(originals[0].ticketId, originals[1].ticketId); assert.equal(originals[1].ticketId, originals[2].ticketId); assert.equal(originals[2].ticketId, originals[3].ticketId);
assert.equal(new Set(originals.map(value => value.projectId)).size, 1);
assert.equal(requests.filter(value => value.method === 'POST' && value.path.includes('/defect-tickets')).length, 8);
assert.equal(relay.filter(value => value.event === 'controlled-http-502').length, 4);
assert.deepEqual(Object.keys(tree(join(ROOT, 'defect-tickets'))).sort(), originals.map(value => 'v1/events/' + value.actionId + '.json').sort());
assert.deepEqual(tree(join(ROOT, summary.sourceRunId)), json('source-file-digests.json'));
const http = lines('http.jsonl'), executionBase = 'projects/' + originals[0].projectId + '/browser-executions';
assert.equal(http.filter(value => value.method === 'POST' && value.path === 'runs').length, 1);
assert.equal(http.filter(value => value.method === 'POST' && value.path === executionBase).length, 2);
assert.equal(http.filter(value => value.method === 'POST' && value.path.endsWith('/register-result')).length, 2);
const bad = http.find(value => value.path === executionBase + '/' + summary.badOperationId + '/report').payload.report;
for (const id of originals[1].request.memberCheckIds) { const check = bad.checks.find(value => value.id === id); assert.equal(check.status, 'failed'); assert.equal(check.verdict, 'bug'); assert.notEqual(check.evaluationLimited, true); }
const final = json('final-ticket.json').ticket; assert.equal(final.processingStatus, 'closed'); assert.equal(final.revision, 1); assert.equal(final.counts.passed, 2); assert.equal(final.verificationStatus, 'verified_passed');
const errors = json('browser-errors.json'); assert.deepEqual(errors.pageErrors, []); assert.equal(errors.controlledReplies.length, 4);
for (const message of errors.consoleMessages) { const url = new URL(message.location.url); assert.equal(url.origin, summary.uiBase); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.equal(message.type, 'error'); assert.equal(message.text, 'Failed to load resource: the server responded with a status of 502 (Bad Gateway)');
  assert(errors.controlledReplies.some(value => value.caseId === message.caseId && value.path === url.pathname && value.status === 502)); }
const imageNames = ['A-create-unknown-desktop-light', 'C-close-unknown-mobile-dark', 'B-recorded-create-mobile-light', 'D-recorded-close-desktop-dark'];
assert.deepEqual([...summary.captures].sort(), imageNames.map(value => value + '.png').sort());
const layouts = json('layouts.json'); assert.equal(layouts.length, 4);
for (const name of imageNames) { const layout = layouts.find(value => value.name === name); assert(layout);
  assert(layout.clientWidth > 0 && layout.documentWidth <= layout.width + 1 && layout.scrollWidth <= layout.clientWidth + 1);
  const image = raw(name + '.png'); assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a'); assert.equal(image.readUInt32BE(16), layout.width); assert.equal(image.readUInt32BE(20), layout.height); }
console.log(JSON.stringify({ schemaVersion: 1, kind: 'manual-defect-ticket-decision-browser-verification', passed: true,
  caseCount: outcomes.length, outcomes, outputDirectory: OUT }, null, 2));
