import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { acquireAcceptanceOwner } from '../../../src/acceptance/owner.mjs';
import { createDefectTicketService } from '../../../src/acceptance/defect-ticket-service.mjs';
import { defectTicketRequestFingerprint } from '../../../src/acceptance/defect-ticket-schema.mjs';

const uid = prefix => prefix + '-' + randomUUID(), root = new URL('./readiness-review-' + randomUUID(), import.meta.url).pathname;
const owner = acquireAcceptanceOwner({ root: process.platform === 'win32' ? decodeURIComponent(root.slice(1)) : root });
const projectId = uid('ap'), request = { ticketId: uid('dt'), actionId: uid('da'), sourceOperationId: uid('bo'),
  memberCheckIds: ['desktop'], title: 'Review', severity: 'high', description: 'Review', reproduction: 'Review' };
const original = { version: 1, projectId, ticketId: request.ticketId, kind: 'create', actionId: request.actionId,
  requestFingerprint: defectTicketRequestFingerprint({ projectId, ticketId: request.ticketId, kind: 'create', request }), request };
const results = [], unhandled = [];
const listener = reason => unhandled.push(String(reason?.message ?? reason));
process.on('unhandledRejection', listener);
try {
  let getterCalls = 0;
  const promise = Promise.resolve(true);
  Object.defineProperty(promise, 'constructor', { get() { getterCalls++; return Promise; } });
  const returned = createDefectTicketService({ owner, assertReady: () => promise });
  try { await returned.deny(projectId, request.actionId, original); } catch (error) { results.push({ case: 'returned promise constructor getter', code: error.code, getterCalls }); }
  const thrown = createDefectTicketService({ owner, assertReady() { throw Promise.reject(Error('thrown readiness promise')); } });
  try { await thrown.deny(projectId, request.actionId, original); } catch (error) { results.push({ case: 'thrown rejected promise', code: error.code }); }
  await new Promise(setImmediate); await new Promise(setImmediate);
  results.push({ unhandled, ticketNamespaceCreated: fs.existsSync(owner.root + '/defect-tickets') });
  console.log(JSON.stringify(results, null, 2));
} finally { owner.release(); process.off('unhandledRejection', listener); }
