#!/usr/bin/env node
/** Build responsive variants in a candidate page, then switch only after verification. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { CORE_ROOT, WORKSPACE, isInside } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { emit } from '../emit.mjs';
import { snapPage } from './multi-snapshot.mjs';
import { prepareCandidate, publishCandidate, discardCandidate, snapshotCloneArtifacts, recalculateVerificationSummary, invalidatePublishedVerification } from './upgrade-stage.mjs';
import { makeArgs } from '../args.mjs';

const argv = process.argv.slice(2);
const { argOf } = makeArgs(argv);
const host = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const THRESHOLD = Number(argOf('threshold', 0.97));
const MAX = Number(argOf('max', 99));
const FORCE = argv.includes('--force');
if (!host || host === '.' || host === '..' || /[/\\]/.test(host) || !Number.isFinite(THRESHOLD) || THRESHOLD < 0 || THRESHOLD > 1 || !Number.isInteger(MAX) || MAX < 1) {
  console.error('usage: node src/crawler/responsive-upgrade.mjs <host> [--threshold 0.97] [--max N] [--force]');
  process.exit(2);
}

const BASE = join(WORKSPACE, host);
if (!isInside(WORKSPACE, BASE)) { console.error('invalid host directory'); process.exit(2); }
const PAGES = join(BASE, 'pages');
const AUDIT = join(BASE, 'audit');
const CANDIDATES = join(AUDIT, 'upgrade-candidates');
const BACKUPS = join(AUDIT, 'upgrade-backups');
const RUNS = join(AUDIT, 'responsive-upgrade-runs');
const runId = randomUUID();
const summaryPath = join(BASE, 'verify', 'verify-summary.json');
if (!existsSync(summaryPath)) { console.error('missing verify-summary.json; run verify ' + host + ' --all'); process.exit(1); }
let summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
if (summary.scoreVersion !== 2) { console.error('verify summary uses an old scoring method; rerun verify ' + host + ' --all'); process.exit(1); }
if (summary.mode !== 'all' || summary.untested !== 0 || summary.measured !== summary.targetTotal) {
  console.error('responsive upgrade requires a complete v2 site verification; rerun verify ' + host + ' --all');
  process.exit(1);
}
const available = new Set(existsSync(PAGES) ? readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'manifest.json'))) : []);
const summaryPages = summary.pages ?? [];
const summarized = new Set(summaryPages.map(p => p.page));
if (summaryPages.length !== available.size || summarized.size !== available.size || [...available].some(page => !summarized.has(page))) {
  console.error('verify summary does not cover the current page set; rerun verify ' + host + ' --all');
  process.exit(1);
}
const verifiedAt = Date.parse(summary.generatedAt ?? '');
if (!Number.isFinite(verifiedAt)) {
  console.error('verify summary has no valid generatedAt; rerun verify ' + host + ' --all');
  process.exit(1);
}
const stalePages = summaryPages.filter(p => {
  if (!available.has(p.page)) return false;
  // NTFS records sub-millisecond mtimes; generatedAt is an ISO timestamp rounded to milliseconds.
  try { return Math.floor(statSync(join(PAGES, p.page, 'clone', 'index.html')).mtimeMs) > verifiedAt; }
  catch { return true; }
});
if (stalePages.length) {
  console.error('verify summary predates cloned pages (' + stalePages.slice(0, 5).map(p => p.page).join(', ') + '); rerun verify ' + host + ' --all');
  process.exit(1);
}
const candidates = summaryPages
  .filter(p => available.has(p.page) && p.measured && typeof p.overall === 'number' && typeof p.minViewport?.score === 'number' && p.minViewport.score < THRESHOLD)
  .filter(p => FORCE || !existsSync(join(PAGES, p.page, 'dom-375.html')))
  .sort((a, b) => a.minViewport.score - b.minViewport.score)
  .slice(0, MAX);
console.log('[upgrade] host=' + host + ' threshold=' + THRESHOLD + ' candidates=' + candidates.length);

function runNode(args, timeout = 600_000) {
  const r = spawnSync(process.execPath, args, { cwd: CORE_ROOT, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    const detail = String(r.stderr || r.stdout || r.error || '').trim().slice(-500);
    throw new Error(args[0] + ' failed (' + (r.status ?? r.signal ?? 'spawn') + '): ' + detail);
  }
  return r;
}

function verifyCandidate(page, dir) {
  const r = runNode(['src/verify/verify.mjs', host, page, '--page-dir', dir, '--no-interactions']);
  const line = String(r.stdout || '').split(/\r?\n/).findLast(l => l.startsWith('@@EVENT@@') && l.includes('"kind":"verify-page"'));
  const result = line ? JSON.parse(line.slice('@@EVENT@@'.length)) : null;
  if (!result?.measured || typeof result.overall !== 'number' || !result.minViewport) throw new Error('candidate verification did not measure every viewport');
  return result;
}

function rebindCandidateMetadata(dir, pageDir, page) {
  for (const [file, value] of [
    ['score.json', page],
    ['clone-gaps.json', relative(WORKSPACE, pageDir).replaceAll('\\', '/')],
  ]) {
    const path = join(dir, file);
    const data = JSON.parse(readFileSync(path, 'utf8'));
    data.page = value;
    writeFileAtomic(path, JSON.stringify(data, null, 2));
  }
}

function nextSummaryFor(page, after) {
  const next = structuredClone(summary);
  const idx = next.pages.findIndex(p => p.page === page);
  if (idx < 0) throw new Error('page missing from verify summary: ' + page);
  const { kind, ...entry } = after;
  next.pages[idx] = { ...next.pages[idx], ...entry };
  return recalculateVerificationSummary(next);
}

const results = [];
if (candidates.length) {
  const browser = await chromium.launch();
  try {
    for (const c of candidates) {
      const page = c.page;
      const id = randomUUID();
      const pageDir = join(PAGES, page);
      const stage = join(CANDIDATES, page + '-' + id);
      const backup = join(BACKUPS, page + '-' + id);
      const backupVerify = join(BACKUPS, page + '-' + id + '-verify');
      const before = { overall: c.overall, min: c.minViewport.score, minVp: c.minViewport.name };
      const result = { page, before, kept: false };
      try {
        prepareCandidate(pageDir, stage);
        await snapPage(browser, host, page, [375, 768], stage);
        runNode(['src/crawler/build_clone.mjs', stage]);
        const cloneUrl = pathToFileURL(join(stage, 'clone', 'index.html')).href;
        runNode(['src/crawler/shot_clone.mjs', cloneUrl, join(stage, 'shot-clone.png')]);
        runNode(['src/differ/diff.mjs', stage]);
        rebindCandidateMetadata(stage, pageDir, page);
        const after = verifyCandidate(page, stage);
        result.after = { overall: after.overall, min: after.minViewport.score, minVp: after.minViewport.name };
        const keep = after.minViewport.score > before.min + 0.005 && after.overall >= before.overall - 0.005;
        if (keep) {
          const next = nextSummaryFor(page, after);
          publishCandidate(pageDir, stage, backup, join(BASE, 'verify', page), backupVerify, summaryPath, JSON.stringify(next, null, 2));
          summary = next;
          result.kept = true;
          result.backup = relative(BASE, backup);
          if (existsSync(backupVerify)) result.backupVerify = relative(BASE, backupVerify);
        }
        console.log('[upgrade] ' + (keep ? 'KEEP ' : 'REJECT ') + page + ' ' + (before.overall * 100).toFixed(1) + '/' + (before.min * 100).toFixed(1) + ' -> ' + (after.overall * 100).toFixed(1) + '/' + (after.minViewport.score * 100).toFixed(1));
      } catch (error) {
        result.error = String(error).slice(0, 500);
        if (error instanceof AggregateError) {
          result.recoveryRequired = true;
          result.backup = relative(BASE, backup);
          result.backupVerify = relative(BASE, backupVerify);
        }
        console.error('[upgrade] FAIL ' + page + ': ' + result.error);
      } finally {
        if (!result.recoveryRequired && existsSync(stage)) {
          try { discardCandidate(stage, CANDIDATES); }
          catch (error) { result.cleanupError = String(error).slice(0, 240); }
        }
      }
      results.push(result);
      emit({ kind: 'upgrade-page', page, kept: result.kept, error: result.error ?? result.cleanupError });
      if (result.recoveryRequired) break;
    }
  } finally { await browser.close(); }
}

const postprocessErrors = [];
let postprocessChangedPages = [];
if (results.some(r => r.kept)) {
  const before = snapshotCloneArtifacts(PAGES, available);
  for (const script of ['src/crawler/linker.mjs', 'src/audit/assets.mjs']) {
    try { runNode([script, host]); }
    catch (error) { postprocessErrors.push(String(error).slice(0, 500)); }
  }
  const after = snapshotCloneArtifacts(PAGES, available);
  postprocessChangedPages = [...available].filter(page => before.get(page) !== after.get(page));
  if (postprocessChangedPages.length) {
    const reason = 'clone changed after verification during site postprocessing';
    const invalidated = invalidatePublishedVerification(BASE, summary, postprocessChangedPages, reason);
    summary = invalidated.summary;
    postprocessErrors.push(...invalidated.errors);
    console.error('[upgrade] postprocessing changed ' + postprocessChangedPages.length + ' clone(s); verification invalidated, rerun verify ' + host + ' --all');
  }
}
const report = { host, runId, generatedAt: new Date().toISOString(), scoreVersion: 2, threshold: THRESHOLD, candidates: candidates.length, kept: results.filter(r => r.kept).length, reverted: results.filter(r => !r.kept && !r.error).length, failed: results.filter(r => r.error).length, postprocessErrors, postprocessChangedPages, results };
mkdirSync(RUNS, { recursive: true });
writeFileAtomic(join(RUNS, runId + '.json'), JSON.stringify(report, null, 2));
writeFileAtomic(join(AUDIT, 'responsive-upgrade.json'), JSON.stringify(report, null, 2));
console.log('[upgrade] DONE kept=' + report.kept + ' rejected=' + report.reverted + ' failed=' + report.failed + ' invalidated=' + postprocessChangedPages.length + ' -> audit/responsive-upgrade.json');
if (report.failed || postprocessErrors.length || postprocessChangedPages.length || results.some(r => r.cleanupError)) process.exitCode = 1;
