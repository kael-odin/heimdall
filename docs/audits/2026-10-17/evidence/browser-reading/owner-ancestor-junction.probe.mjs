// Reproduction of the already completed in-memory probe. This saved copy has
// not been rerun. It changes no product source; both owner variants use data URLs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const repo = process.cwd();
const constantsUrl = pathToFileURL(path.join(repo, 'core/src/acceptance/constants.mjs')).href;
const current = fs.readFileSync(path.join(repo, 'core/src/acceptance/owner.mjs'), 'utf8')
  .replace("'./constants.mjs'", JSON.stringify(constantsUrl));
const variants = {
  current,
  naiveNoCanonicalRealpath: current.replace(' || realpathSync(path) !== path', ''),
};
const temporaryRoot = fs.realpathSync(os.tmpdir());
const base = fs.mkdtempSync(path.join(temporaryRoot, 'heimdall-owner-cost-review-'));
const rows = [];
try {
  for (const [variant, source] of Object.entries(variants)) {
    const mod = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//' + variant).toString('base64'));
    for (const operation of ['assertOwned', 'release']) {
      const fixture = path.join(base, variant + '-' + operation);
      const parent = path.join(fixture, 'parent');
      const moved = path.join(fixture, 'parent-moved');
      const root = path.join(parent, 'acceptance');
      fs.mkdirSync(root, { recursive: true });
      const owner = mod.acquireAcceptanceOwner({ root });
      const before = fs.lstatSync(root, { bigint: true });
      fs.renameSync(parent, moved);
      fs.symlinkSync(moved, parent, process.platform === 'win32' ? 'junction' : 'dir');
      const after = fs.lstatSync(root, { bigint: true });
      let result, error;
      try { result = owner[operation](); } catch (caught) { error = caught.code; }
      rows.push({ variant, operation, beforeCanonical: root, afterCanonical: fs.realpathSync(root),
        samePhysicalRoot: before.dev === after.dev && before.ino === after.ino
          && before.birthtimeNs === after.birthtimeNs && before.mode === after.mode,
        result, error,
        originalLockStillPresent: fs.existsSync(path.join(moved, 'acceptance', mod.ACCEPTANCE_OWNER_FILE)) });
      if (operation !== 'release') owner.release();
    }
  }
  console.log(JSON.stringify(rows, null, 2));
} finally {
  const checked = path.resolve(base), inside = path.relative(temporaryRoot, checked);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('unsafe fixture cleanup');
  fs.rmSync(checked, { recursive: true, force: true });
}
