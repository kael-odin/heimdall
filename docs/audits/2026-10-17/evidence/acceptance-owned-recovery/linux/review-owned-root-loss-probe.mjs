import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireAcceptanceOwner } from '../../../src/acceptance/owner.mjs';
import { recoverOwnedAcceptanceRuns } from '../../../src/acceptance/recovery.mjs';

const root = nativeFs.realpathSync(nativeFs.mkdtempSync(join(tmpdir(), 'heimdall-owned-root-review-')));
const hidden = root + '.moved';
const owner = acquireAcceptanceOwner({ root });
const original = nativeFs.lstatSync;
let injected = false, outcome;
try {
  nativeFs.lstatSync = (path, ...args) => {
    if (!injected && path === root) {
      injected = true;
      nativeFs.renameSync(root, hidden);
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try { outcome = { returned: recoverOwnedAcceptanceRuns({ owner }) }; }
  catch (error) { outcome = { error: { code: error.code, details: error.details } }; }
  try { owner.assertOwned(); outcome.ownerStillValid = true; }
  catch (error) { outcome.ownerStillValid = false; outcome.ownerError = error.code; }
} finally {
  nativeFs.lstatSync = original;
  syncBuiltinESMExports();
  if (nativeFs.existsSync(hidden)) nativeFs.renameSync(hidden, root);
  owner.release();
  nativeFs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ injected, ...outcome }, null, 2));
