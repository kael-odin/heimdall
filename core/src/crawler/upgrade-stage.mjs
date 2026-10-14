import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { isInside } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';

export function prepareCandidate(pageDir, candidateDir) {
  if (!existsSync(pageDir)) throw new Error('source page missing: ' + pageDir);
  if (existsSync(candidateDir)) throw new Error('candidate already exists: ' + candidateDir);
  mkdirSync(dirname(candidateDir), { recursive: true });
  cpSync(pageDir, candidateDir, { recursive: true, errorOnExist: true, force: false });
}

export function commitCandidate(pageDir, candidateDir, backupDir, { rename = renameSync } = {}) {
  if (!existsSync(pageDir) || !existsSync(candidateDir)) throw new Error('page or candidate missing');
  if (existsSync(backupDir)) throw new Error('backup already exists: ' + backupDir);
  mkdirSync(dirname(backupDir), { recursive: true });
  rename(pageDir, backupDir);
  try {
    rename(candidateDir, pageDir);
  } catch (error) {
    try { rename(backupDir, pageDir); }
    catch (rollbackError) { throw new AggregateError([error, rollbackError], 'candidate switch and rollback failed; backup is at ' + backupDir); }
    throw error;
  }
}

export function publishCandidate(pageDir, candidateDir, backupDir, verifyDir, backupVerifyDir, summaryPath, summaryData, { rename = renameSync, writeSummary = writeFileAtomic } = {}) {
  const candidateVerify = join(candidateDir, 'verify');
  if (!existsSync(candidateVerify)) throw new Error('candidate verification missing');
  if (existsSync(backupVerifyDir)) throw new Error('verification backup already exists');
  commitCandidate(pageDir, candidateDir, backupDir, { rename });
  let oldVerifyMoved = false;
  let newVerifyMoved = false;
  try {
    mkdirSync(dirname(verifyDir), { recursive: true });
    mkdirSync(dirname(backupVerifyDir), { recursive: true });
    if (existsSync(verifyDir)) {
      rename(verifyDir, backupVerifyDir);
      oldVerifyMoved = true;
    }
    rename(join(pageDir, 'verify'), verifyDir);
    newVerifyMoved = true;
    writeSummary(summaryPath, summaryData);
  } catch (error) {
    const rollbackErrors = [];
    if (newVerifyMoved) {
      try { rename(verifyDir, join(pageDir, 'verify')); }
      catch (e) { rollbackErrors.push(e); }
    }
    if (oldVerifyMoved) {
      try { rename(backupVerifyDir, verifyDir); }
      catch (e) { rollbackErrors.push(e); }
    }
    try { rename(pageDir, candidateDir); rename(backupDir, pageDir); }
    catch (e) { rollbackErrors.push(e); }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], 'upgrade publication and rollback failed; inspect ' + backupDir);
    throw error;
  }
}

export function discardCandidate(candidateDir, candidatesRoot) {
  if (!isInside(candidatesRoot, candidateDir)) throw new Error('candidate outside staging root');
  rmSync(candidateDir, { recursive: true, force: true });
}

/** Detect changes to the published clone after site-wide postprocessing. */
export function snapshotCloneArtifacts(pagesDir, names) {
  const snapshots = new Map();
  for (const name of names) {
    const root = join(pagesDir, name, 'clone');
    const files = [];
    const walk = dir => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile()) {
          const stat = statSync(file);
          files.push([relative(root, file), stat.size, stat.mtimeMs, stat.ino].join(':'));
        }
      }
    };
    if (existsSync(root)) walk(root);
    snapshots.set(name, files.sort().join('\n'));
  }
  return snapshots;
}

export function recalculateVerificationSummary(summary) {
  const next = structuredClone(summary);
  const scored = next.pages.filter(p => p.measured && typeof p.overall === 'number');
  const average = scored.length ? scored.reduce((n, p) => n + p.overall, 0) / scored.length : 0;
  next.measured = scored.length;
  next.unmeasured = next.pages.length - scored.length;
  next.untested = Math.max(0, next.targetTotal - scored.length);
  next.average = +average.toFixed(4);
  next.worst = scored.reduce((worst, p) => p.minViewport && (!worst || p.minViewport.score < worst.score) ? { page: p.page, ...p.minViewport } : worst, null);
  next.passed = next.untested === 0 && (!next.threshold || average * 100 >= next.threshold);
  next.generatedAt = new Date().toISOString();
  return next;
}

export function invalidatePublishedVerification(base, summary, changedPages, reason) {
  const next = structuredClone(summary);
  const changed = new Set(changedPages);
  next.pages = next.pages.map(page => changed.has(page.page)
    ? { ...page, overall: null, measured: false, grade: null, minViewport: null, functional: null,
        invalidated: { reason, previousOverall: page.overall, previousMinViewport: page.minViewport } }
    : page);
  const invalidated = recalculateVerificationSummary(next);
  writeFileAtomic(join(base, 'verify', 'verify-summary.json'), JSON.stringify(invalidated, null, 2));
  const errors = [];
  for (const page of changed) {
    const file = join(base, 'verify', page, 'verify.json');
    try {
      const prior = JSON.parse(readFileSync(file, 'utf8'));
      writeFileAtomic(file, JSON.stringify({
        page, target: prior.target, generatedAt: invalidated.generatedAt, scoreVersion: 2,
        overall: null, measured: false, grade: null, minViewport: null, viewports: [],
        functional: null, interactions: [], invalidated: { reason, previous: prior },
      }, null, 2));
    } catch (error) { errors.push('could not invalidate ' + page + ': ' + String(error).slice(0, 300)); }
  }
  return { summary: invalidated, errors };
}
