import { lstatSync, realpathSync, renameSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** An export may replace only a real descendant of the configured deliverable directory. */
export function assertExportTarget(root, target) {
  const base = resolve(root);
  const out = resolve(target);
  const rel = relative(base, out);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) {
    throw new Error('export target must be inside deliverable (not its root): ' + out);
  }
  const stat = (path) => { try { return lstatSync(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  if (stat(base)?.isSymbolicLink()) {
    throw new Error('deliverable root must not be a symlink: ' + base);
  }
  let path = base;
  for (const part of rel.split(sep)) {
    path = join(path, part);
    const entry = stat(path);
    if (!entry) break;
    if (entry.isSymbolicLink()) throw new Error('export target crosses a symlink: ' + path);
  }
  if (stat(base) && stat(out)) {
    const realRel = relative(realpathSync(base), realpathSync(out));
    if (!realRel || realRel === '..' || realRel.startsWith('..' + sep) || isAbsolute(realRel)) {
      throw new Error('export target escapes deliverable: ' + out);
    }
    if (!lstatSync(out).isDirectory()) throw new Error('export target is not a directory: ' + out);
  }
  return out;
}

/** Commit only after every packaging gate passed; retain the previous bundle for rollback. */
export function promoteCandidate(root, target, candidate) {
  const out = assertExportTarget(root, target);
  const built = assertExportTarget(root, candidate);
  if (out === built) throw new Error('candidate and target must differ');
  let builtStat, outStat;
  try { builtStat = lstatSync(built); } catch {}
  try { outStat = lstatSync(out); } catch {}
  if (!builtStat?.isDirectory()) throw new Error('candidate missing: ' + built);
  const backup = outStat ? join(resolve(root), `.backup-${basename(out)}-${randomUUID()}`) : null;
  if (backup) renameSync(out, backup);
  try { renameSync(built, out); }
  catch (error) {
    if (backup) renameSync(backup, out);
    throw error;
  }
  return { out, backup };
}
