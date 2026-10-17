/** Real process crash at observable store states, without production hooks. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireAcceptanceOwner } from '../../src/acceptance/owner.mjs';
import { createBrowserOperationStore } from '../../src/acceptance/browser-operation-store.mjs';

const [root, inputFile, marker, phase] = process.argv.slice(2);
const input = JSON.parse(readFileSync(inputFile, 'utf8'));
const owner = acquireAcceptanceOwner({ root }), store = createBrowserOperationStore({ owner });
const folder = join(root, 'browser-operations/v1', input.request.operationId);
function assertCurrent() {
  if (!existsSync(folder)) return true;
  const names = readdirSync(folder).sort();
  const reached = phase === 'empty' ? names.length === 0
    : phase === 'temporary' ? names.some(name => /^rejection\.json\.tmp\./.test(name)) && !names.includes('rejection.json')
      : phase === 'committed' ? names.length === 1 && names[0] === 'rejection.json' : false;
  if (reached) {
    writeFileSync(marker, JSON.stringify({ phase, names, operationId: input.request.operationId }) + '\n', { flag: 'wx' });
    process.kill(process.pid, 'SIGKILL');
  }
  return true;
}
try {
  store.publishRejection(input, { assertCurrent });
  throw Error('Requested crash boundary was not observed: ' + phase);
} finally { owner.release(); }
