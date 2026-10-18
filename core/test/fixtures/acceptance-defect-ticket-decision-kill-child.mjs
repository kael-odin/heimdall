/** Real process interruption at filesystem boundaries; production has no crash hook. */
import fs from 'node:fs';
import { join } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { acquireAcceptanceOwner } from '../../src/acceptance/owner.mjs';

const [root, inputFile, marker, phase] = process.argv.slice(2), input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const owner = acquireAcceptanceOwner({ root }), original = { mkdirSync: fs.mkdirSync, linkSync: fs.linkSync,
  writeFileSync: fs.writeFileSync, existsSync: fs.existsSync, readdirSync: fs.readdirSync };
const parent = join(root, 'defect-tickets'), version = join(parent, 'v1'), events = join(version, 'events');
const scope = input.event ?? input.rejection.original, target = join(events, scope.actionId + '.json');
function stop() {
  original.writeFileSync(marker, JSON.stringify({ phase, kind: input.event ? 'event' : 'rejection',
    names: original.existsSync(events) ? original.readdirSync(events).sort() : [] }) + '\n', { flag: 'wx' });
  process.kill(process.pid, 'SIGKILL');
}
// Patch only this disposable process, before the store imports its native fs bindings.
fs.mkdirSync = function(path, ...args) {
  const result = original.mkdirSync(path, ...args);
  if (phase === 'namespace-parent' && path === parent || phase === 'namespace-version' && path === version) stop();
  return result;
};
fs.linkSync = function(from, to) {
  if (to === target && phase === 'before-link') stop();
  const result = original.linkSync(from, to);
  if (to === target && phase === 'linked') stop();
  return result;
};
syncBuiltinESMExports();
const { createDefectTicketStore } = await import('../../src/acceptance/defect-ticket-store.mjs');
const store = createDefectTicketStore({ owner });
function assertCurrent() {
  if (!original.existsSync(events)) return true;
  const names = original.readdirSync(events).sort();
  if (phase === 'temporary' && names.length === 1 && names[0].endsWith('.tmp')
    || phase === 'committed' && names.length === 1 && names[0] === scope.actionId + '.json') stop();
  return true;
}
try {
  const args = { projectId: scope.projectId, actionId: scope.actionId, requestFingerprint: scope.requestFingerprint,
    prepare: () => ({ ...(input.event ? { event: input.event } : { rejection: input.rejection }), assertCurrent }) };
  await (input.event ? store.append(args) : store.deny(args));
  throw Error('Requested crash boundary was not observed: ' + phase);
} finally { owner.release(); }
