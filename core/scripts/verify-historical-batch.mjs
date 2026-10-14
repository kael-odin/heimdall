#!/usr/bin/env node
// Isolated, budgeted v2 replay of historical clones. Example:
// node core/scripts/verify-historical-batch.mjs --host apify.com --max-pages 3 --max-copy-mb 30 --max-minutes 20
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { auditHistoricalVerification } from '../src/audit/historical-verification.mjs';
import { writeFileAtomic } from '../src/fsutil.mjs';
import { WORKSPACE } from '../src/paths.mjs';
import { hostKey } from '../src/session/store.mjs';
import { gradeOf, overallScore } from '../src/verify/compare.mjs';
import { TILE_HEIGHT } from '../src/verify/tiled-compare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..');
const ROOT = resolve(CORE, '..');
const DEFAULT_RUN = join(WORKSPACE, '_runs', 'historical-v2-batch');
const REQUIRED_VIEWPORTS = ['375x812', '768x1024', '1440x900'];
const VERIFIER_FILES = [
  'src/verify/verify.mjs',
  'src/verify/compare.mjs',
  'src/verify/tiled-compare.mjs',
  'src/verify/interactions.mjs',
  'src/freeze.mjs',
  'src/paths.mjs',
  'src/url-canon.mjs',
  'src/site-profile.mjs',
  'src/session/store.mjs',
  'src/ua.mjs',
  'src/page-name.mjs',
  'src/fsutil.mjs',
  'src/emit.mjs',
  'package.json',
  'node_modules/playwright/package.json',
  'node_modules/playwright-core/package.json',
  'node_modules/playwright-core/browsers.json',
  'node_modules/pixelmatch/package.json',
  'node_modules/pngjs/package.json',
];
const FIELDS = ['host', 'page', 'targetPath', 'verifyState', 'oldOverall', 'oldGrade', 'estimatedV2',
  'status', 'newOverall', 'newGrade', 'measured', 'viewportsMeasured', 'worstCoverage', 'missingPixels',
  'error', 'inputBytes', 'inputSha256', 'verifierSha256', 'startedAt', 'finishedAt', 'evidence',
  'lastAttemptStatus', 'lastAttemptError'];
const VP_FIELDS = ['host', 'page', 'viewport', 'status', 'score', 'grade', 'width', 'sourceHeight',
  'cloneHeight', 'coverageRatio', 'missingPixels', 'mismatched', 'heightDelta', 'settleTimedOut',
  'sourceFinalUrl', 'cloneFinalUrl', 'error', 'evidence'];
const quote = value => {
  const raw = value ?? '';
  const safe = typeof raw === 'string' && /^[\x00-\x20]*[=+@-]/.test(raw) ? "'" + raw : String(raw);
  return '"' + safe.replaceAll('"', '""') + '"';
};
export const csv = (rows, fields) => [fields.join(','), ...rows.map(row => fields.map(field => quote(row[field])).join(','))].join('\n') + '\n';
const readJson = file => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const sha256File = file => {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
  return hash.digest('hex');
};
const LOG_LIMIT = 128 * 1024;
const RUNS_ROOT = join(WORKSPACE, '_runs');
const insideOrEqual = (root, target) => {
  const rel = relative(root, target);
  return !rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
};
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const verifierSha256 = () => {
  const hash = createHash('sha256');
  hash.update('node-version').update('\0').update(process.version).update('\0');
  hash.update('platform').update('\0').update(process.platform + '/' + process.arch).update('\0');
  for (const file of VERIFIER_FILES) {
    const path = join(CORE, file);
    hash.update(file).update('\0');
    if (existsSync(path)) hash.update(readFileSync(path));
    else hash.update('<missing>');
    hash.update('\0');
  }
  const sitesDir = join(CORE, 'sites');
  for (const file of (existsSync(sitesDir) ? readdirSync(sitesDir).filter(name => name.endsWith('.json')).sort() : [])) {
    const rel = 'sites/' + file;
    hash.update(rel).update('\0').update(readFileSync(join(sitesDir, file))).update('\0');
  }
  const browserPath = chromium.executablePath();
  if (!existsSync(browserPath)) throw new Error('Chromium executable missing: ' + browserPath);
  hash.update('chromium-executable').update('\0');
  const browserFd = openSync(browserPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let bytes;
    while ((bytes = readSync(browserFd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally { closeSync(browserFd); }
  hash.update('\0');
  return hash.digest('hex');
};
function readProgress(runDir) {
  const file = join(runDir, 'progress.json');
  if (!existsSync(file)) return { records: {} };
  assertNoLinks(file);
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error('progress.json is damaged; preserve and repair it before resuming: ' + error.message); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)) {
    throw new Error('progress.json has an invalid records object');
  }
  return data;
}
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function acquireRunLock(runDir, recoverLock) {
  const file = join(runDir, 'run.lock');
  assertNoLinks(file);
  const token = randomUUID();
  const open = () => {
    const fd = openSync(file, 'wx');
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token }) + '\n'); }
    finally { closeSync(fd); }
  };
  try { open(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!recoverLock) throw new Error('run.lock exists; use --recover-lock only after checking its owner process');
    const recovery = file + '.recover';
    assertNoLinks(recovery);
    const fd = openSync(recovery, 'wx');
    try {
      closeSync(fd);
      assertNoLinks(file);
      const prior = readJson(file);
      if (!Number.isInteger(prior?.pid) || prior.pid <= 0 || !prior.token) {
        throw new Error('run.lock is invalid; refusing automatic recovery');
      }
      if (pidAlive(prior.pid)) throw new Error('run.lock owner PID is still alive: ' + prior.pid);
      unlinkSync(file);
      open();
    } finally { unlinkSync(recovery); }
  }
  return () => {
    if (readJson(file)?.token === token) unlinkSync(file);
  };
}
function assertNoLinks(path) {
  const target = resolve(path);
  if (!insideOrEqual(WORKSPACE, target)) throw new Error('write path outside workspace: ' + target);
  let current = resolve(WORKSPACE);
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !samePath(realpathSync(current), current)) {
        throw new Error('symlink or junction in write path: ' + current);
      }
    }
    current = join(current, part);
  }
  if (existsSync(current)) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !samePath(realpathSync(current), current)) {
      throw new Error('symlink or junction in write path: ' + current);
    }
  }
}
function assertSeparate(target, originals) {
  const actual = realpathSync(target);
  for (const original of originals) {
    if (!existsSync(original)) continue;
    const source = realpathSync(original);
    if (insideOrEqual(source, actual) || insideOrEqual(actual, source)) {
      throw new Error('isolated destination overlaps historical input: ' + target);
    }
  }
}
function logTail() {
  let value = '', dropped = 0;
  return {
    add(data) {
      value += data.toString();
      if (value.length > LOG_LIMIT) {
        dropped += value.length - LOG_LIMIT;
        value = value.slice(-LOG_LIMIT);
      }
    },
    text() { return (dropped ? `[truncated ${dropped} characters]\n` : '') + value; },
  };
}

function options(argv) {
  const opts = { host: null, page: null, state: null, maxPages: 3, maxCopyMb: 100,
    maxPageMb: 50, maxMinutes: 20, runDir: DEFAULT_RUN, keepScreenshots: false,
    retryUnmeasured: false, recoverLock: false, force: false, dryRun: false };
  const values = { '--host': 'host', '--page': 'page', '--state': 'state', '--max-pages': 'maxPages',
    '--max-copy-mb': 'maxCopyMb', '--max-page-mb': 'maxPageMb', '--max-minutes': 'maxMinutes', '--run-dir': 'runDir' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep-screenshots') opts.keepScreenshots = true;
    else if (arg === '--retry-unmeasured') opts.retryUnmeasured = true;
    else if (arg === '--recover-lock') opts.recoverLock = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg in values && argv[i + 1] && !argv[i + 1].startsWith('--')) opts[values[arg]] = argv[++i];
    else throw new Error('Unknown or incomplete argument: ' + arg);
  }
  for (const key of ['maxPages', 'maxCopyMb', 'maxPageMb', 'maxMinutes']) {
    opts[key] = Number(opts[key]);
    if (!Number.isFinite(opts[key]) || opts[key] <= 0 || (key === 'maxPages' && !Number.isInteger(opts[key]))) {
      throw new Error(key + ' must be positive');
    }
  }
  opts.runDir = resolve(opts.runDir);
  const relRun = relative(RUNS_ROOT, opts.runDir);
  if (!relRun || relRun === '..' || relRun.startsWith('..' + sep) || isAbsolute(relRun)) {
    throw new Error('--run-dir must be inside core/workspace/_runs');
  }
  assertNoLinks(opts.runDir);
  return opts;
}

export function inputInfo(sourcePage, hashContents = true) {
  const files = [];
  for (const root of ['manifest.json', 'clone']) {
    const start = join(sourcePage, root);
    if (!existsSync(start)) throw new Error(root + ' missing');
    const walk = path => {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !samePath(realpathSync(path), path)) {
        throw new Error('symlink or junction input refused: ' + relative(sourcePage, path));
      }
      if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
      else if (stat.isFile()) files.push({ path, rel: relative(sourcePage, path).replaceAll('\\', '/'), bytes: stat.size });
      else throw new Error('non-file input refused: ' + relative(sourcePage, path));
    };
    walk(start);
  }
  let bytes = 0;
  for (const file of files) bytes += file.bytes;
  if (!hashContents) return { bytes, files: files.length };
  const hash = createHash('sha256');
  for (const file of files) hash.update(file.rel).update('\0').update(String(file.bytes)).update('\0').update(readFileSync(file.path));
  return { bytes, sha256: hash.digest('hex'), files: files.length };
}

function sourceSessionFile(sourcePage, workspaceRoot = WORKSPACE) {
  try {
    const hostname = new URL(readJson(join(sourcePage, 'manifest.json'))?.target).hostname;
    const file = join(workspaceRoot, hostKey(hostname), 'session.json');
    return existsSync(file) ? file : null;
  } catch { return null; }
}

function writeProgress(runDir, catalog, records, lastRun = null) {
  const pages = catalog.map(page => {
    const result = records[page.host + '/' + page.page] ?? {};
    return { ...page, status: result.status ?? (page.hasClone ? 'pending' : 'no_clone'),
      newOverall: result.newOverall ?? '', newGrade: result.newGrade ?? '', measured: result.measured ?? '',
      viewportsMeasured: result.viewportsMeasured ?? '', worstCoverage: result.worstCoverage ?? '',
      missingPixels: result.missingPixels ?? '', error: result.error ?? '', inputBytes: result.inputBytes ?? '',
      inputSha256: result.inputSha256 ?? '', startedAt: result.startedAt ?? '',
      finishedAt: result.finishedAt ?? '', evidence: result.evidence ?? '',
      verifierSha256: result.verifierSha256 ?? '', lastAttemptStatus: result.lastAttempt?.status ?? '',
      lastAttemptError: result.lastAttempt?.error ?? '' };
  });
  const viewports = catalog.flatMap(page => {
    const record = records[page.host + '/' + page.page];
    return ['measured', 'unmeasured'].includes(record?.status) ? (record.viewports ?? []) : [];
  });
  for (const file of ['progress.json', 'pages.csv', 'viewports.csv']) assertNoLinks(join(runDir, file));
  writeFileAtomic(join(runDir, 'progress.json'), JSON.stringify({ updatedAt: new Date().toISOString(), records, lastRun }, null, 2) + '\n');
  writeFileAtomic(join(runDir, 'pages.csv'), csv(pages, FIELDS));
  writeFileAtomic(join(runDir, 'viewports.csv'), csv(viewports, VP_FIELDS));
}

async function freePort() {
  const server = createServer();
  await new Promise((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await Promise.race([new Promise(done => killer.once('exit', done).once('error', done)), sleep(3000)]);
    if (killer.exitCode === null && killer.signalCode === null) {
      try { killer.kill('SIGKILL'); } catch {}
    }
  }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch {}
  }
  if (child.exitCode !== null || child.signalCode !== null) return true;
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(3000)]);
  return child.exitCode !== null || child.signalCode !== null;
}

export async function waitForExitOrTimeout(child, timeLimitMs) {
  let timer;
  let timedOut = false;
  const exitCode = await new Promise((done, fail) => {
    child.once('error', fail);
    child.once('exit', code => done(code));
    timer = setTimeout(() => { timedOut = true; done(null); }, timeLimitMs);
  }).finally(() => clearTimeout(timer));
  const terminationFailed = timedOut && !(await stopProcess(child));
  return { exitCode, timedOut, terminationFailed };
}

async function startEngine(dataRoot, port, runDeadline) {
  const logFile = join(dirname(dataRoot), 'engine.log');
  assertNoLinks(logFile);
  const logs = logTail();
  const child = spawn(process.execPath, [join(CORE, 'src', 'engine-server.mjs'), String(port)], {
    cwd: ROOT, env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdout.on('data', data => logs.add(data));
  child.stderr.on('data', data => logs.add(data));
  const deadline = Math.min(Date.now() + 20_000, runDeadline);
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('isolated engine exited: ' + child.exitCode);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/status`, {
          signal: AbortSignal.timeout(1000),
          headers: process.env.HEIMDALL_TOKEN ? { 'x-heimdall-token': process.env.HEIMDALL_TOKEN } : {},
        });
        if (response.ok) return { child, logs, logFile };
      } catch {}
      await sleep(200);
    }
    throw new Error('isolated engine startup timed out');
  } catch (error) {
    await stopProcess(child);
    writeFileSync(logFile, logs.text());
    throw error;
  }
}

async function verifyOne(page, dataRoot, port, timeLimitMs, keepScreenshots, logFile) {
  assertNoLinks(logFile);
  const args = [join(CORE, 'src', 'verify', 'verify.mjs'), page.host, page.page, '--no-interactions'];
  if (keepScreenshots) args.push('--keep-screenshots');
  const child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_PORT: String(port) } });
  const log = logTail();
  child.stdout.on('data', data => log.add(data));
  child.stderr.on('data', data => log.add(data));
  const execution = await waitForExitOrTimeout(child, timeLimitMs);
  writeFileSync(logFile, log.text());
  return execution;
}

function viewportRows(page, result, evidence) {
  return (result?.viewports ?? []).map(v => ({ host: page.host, page: page.page, viewport: v.name,
    status: v.error ? 'error' : v.skipped ? 'skipped' : v.settleTimedOut ? 'unstable' : 'measured',
    score: v.score ?? '', grade: v.grade ?? '', width: v.width ?? '',
    sourceHeight: v.sourceHeight ?? '', cloneHeight: v.cloneHeight ?? '',
    coverageRatio: v.coverageRatio ?? '', missingPixels: v.missingPixels ?? '',
    mismatched: v.mismatched ?? '', heightDelta: v.heightDelta ?? '',
    settleTimedOut: v.settleTimedOut ?? '', sourceFinalUrl: v.sourceCapture?.finalUrl ?? '',
    cloneFinalUrl: v.cloneCapture?.finalUrl ?? '', error: v.error ?? v.skipped ?? '', evidence }));
}

function priorMeasurement(record) {
  if (record?.priorMeasured) return record.priorMeasured;
  if (record?.status !== 'measured') return null;
  return {
    overall: record.newOverall ?? null,
    grade: record.newGrade ?? null,
    inputSha256: record.inputSha256 ?? null,
    verifierSha256: record.verifierSha256 ?? null,
    evidence: record.evidence ?? null,
  };
}

export function invalidateOldVerifier(records, catalog, currentSha256) {
  let invalidated = 0;
  for (const page of catalog) {
    const key = page.host + '/' + page.page;
    const record = records[key];
    if (record?.status !== 'measured' || record.verifierSha256 === currentSha256) continue;
    records[key] = {
      ...record,
      status: 'stale', measured: false, newOverall: null, newGrade: null,
      error: 'verifier changed; revalidation required',
      priorMeasured: priorMeasurement(record),
    };
    invalidated++;
  }
  return invalidated;
}

export function invalidateSessionMeasurements(records, catalog, workspaceRoot = WORKSPACE) {
  let invalidated = 0;
  for (const page of catalog) {
    const key = page.host + '/' + page.page;
    if (records[key]?.status !== 'measured') continue;
    const sourcePage = join(workspaceRoot, page.host, 'pages', page.page);
    if (!sourceSessionFile(sourcePage, workspaceRoot)) continue;
    noteIssue(records, page, 'session_skipped', 'source session exists but is not staged into the isolated batch', null,
      { stale: true });
    invalidated++;
  }
  return invalidated;
}

function noteIssue(records, page, status, error, inputBytes = null, options = {}) {
  const key = page.host + '/' + page.page;
  const previous = records[key];
  const attempt = { status, error: String(error), at: new Date().toISOString() };
  if (options.stale && (previous?.status === 'measured' || previous?.status === 'stale' || previous?.priorMeasured)) {
    records[key] = {
      ...previous,
      status: 'stale',
      measured: false,
      newOverall: null,
      newGrade: null,
      error: attempt.error,
      inputBytes: inputBytes ?? previous?.inputBytes ?? null,
      ...(options.inputSha256 ? { inputSha256: options.inputSha256 } : {}),
      ...(options.verifierSha256 ? { verifierSha256: options.verifierSha256 } : {}),
      priorMeasured: priorMeasurement(previous),
      lastAttempt: attempt,
    };
  } else {
    records[key] = previous?.status === 'measured'
      ? { ...previous, lastAttempt: attempt }
      : { ...previous, status, error: attempt.error, inputBytes: inputBytes ?? previous?.inputBytes ?? null,
        lastAttempt: attempt };
  }
  return { host: page.host, page: page.page, ...attempt };
}

function measuredResultValid(result, page) {
  if (result?.scoreVersion !== 2 || result.page !== page.page || result.measured !== true
      || result.error || !Array.isArray(result.viewports)
      || result.viewports.length !== REQUIRED_VIEWPORTS.length) return false;
  const names = result.viewports.map(viewport => viewport?.name);
  if (new Set(names).size !== REQUIRED_VIEWPORTS.length
      || REQUIRED_VIEWPORTS.some(name => !names.includes(name))) return false;
  for (const viewport of result.viewports) {
    const source = viewport.sourceSize;
    const clone = viewport.cloneSize;
    if (viewport.error || viewport.skipped || viewport.settleTimedOut
        || viewport.captureMode !== 'full' && viewport.captureMode !== 'tiled'
        || viewport.sourceCapture?.settle?.beforeScroll?.stable !== true
        || viewport.sourceCapture?.settle?.afterScroll?.stable !== true
        || viewport.cloneCapture?.settle?.beforeScroll?.stable !== true
        || viewport.cloneCapture?.settle?.afterScroll?.stable !== true
        || !Number.isInteger(source?.width) || source.width < 1
        || !Number.isInteger(source?.height) || source.height < 1
        || !Number.isInteger(clone?.width) || clone.width < 1
        || !Number.isInteger(clone?.height) || clone.height < 1) return false;
    const overlap = Math.min(source.width, clone.width) * Math.min(source.height, clone.height);
    const union = source.width * source.height + clone.width * clone.height - overlap;
    const missing = union - overlap;
    if (!Number.isSafeInteger(union) || !Number.isInteger(viewport.mismatched)
        || viewport.mismatched < missing || viewport.mismatched > union
        || viewport.missingPixels !== missing
        || viewport.coverageRatio !== +(overlap / union).toFixed(4)
        || viewport.heightDelta !== Math.abs(source.height - clone.height)
        || viewport.sourceHeight !== source.height || viewport.cloneHeight !== clone.height
        || viewport.score !== +Math.max(0, 1 - viewport.mismatched / union).toFixed(4)
        || viewport.grade !== gradeOf(viewport.score)) return false;
  }
  const calculated = overallScore(result.viewports);
  return Number.isFinite(result.overall) && result.overall === calculated
    && result.grade === gradeOf(result.overall);
}

function diffSpecs(result) {
  const files = [];
  for (const viewport of result.viewports) {
    const source = viewport.sourceSize;
    const clone = viewport.cloneSize;
    const maxHeight = Math.max(source.height, clone.height);
    if (viewport.captureMode === 'full') {
      files.push({ name: `diff-${viewport.name}.png`, width: Math.max(source.width, clone.width), height: maxHeight });
      continue;
    }
    const count = Math.ceil(maxHeight / TILE_HEIGHT);
    if (!Array.isArray(viewport.diffParts) || viewport.diffParts.length !== count) return null;
    for (let index = 0; index < count; index++) {
      const y = index * TILE_HEIGHT;
      const name = `diff-${viewport.name}-part-${String(index + 1).padStart(3, '0')}.png`;
      if (viewport.diffParts[index] !== name) return null;
      const sourceRows = Math.min(TILE_HEIGHT, Math.max(0, source.height - y));
      const cloneRows = Math.min(TILE_HEIGHT, Math.max(0, clone.height - y));
      files.push({ name, width: sourceRows && cloneRows ? Math.max(source.width, clone.width)
        : sourceRows ? source.width : clone.width, height: Math.max(sourceRows, cloneRows) });
    }
  }
  return files;
}

function pngEvidence(file) {
  assertNoLinks(file);
  const bytes = statSync(file).size;
  const fd = openSync(file, 'r');
  const header = Buffer.alloc(24);
  const trailer = Buffer.alloc(12);
  try {
    if (bytes < 45 || readSync(fd, header, 0, header.length, 0) !== header.length
        || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || header.readUInt32BE(8) !== 13 || header.toString('ascii', 12, 16) !== 'IHDR'
        || readSync(fd, trailer, 0, trailer.length, bytes - trailer.length) !== trailer.length
        || trailer.readUInt32BE(0) !== 0 || trailer.toString('ascii', 4, 8) !== 'IEND') {
      throw new Error('invalid PNG evidence: ' + file);
    }
  } finally { closeSync(fd); }
  return { bytes, width: header.readUInt32BE(16), height: header.readUInt32BE(20), sha256: sha256File(file) };
}

function collectDiffEvidence(runDir, evidence, result) {
  const specs = diffSpecs(result);
  if (!specs) return null;
  const outDir = dirname(join(runDir, evidence));
  return specs.map(spec => {
    const actual = pngEvidence(join(outDir, spec.name));
    if (actual.width !== spec.width || actual.height !== spec.height) {
      throw new Error('diff PNG dimensions mismatch: ' + spec.name);
    }
    return { name: spec.name, bytes: actual.bytes, sha256: actual.sha256 };
  });
}

function evidenceValid(runDir, page, record, inputSha256, versionSha256) {
  if (!record || record.inputSha256 !== inputSha256 || record.verifierSha256 !== versionSha256) return false;
  const evidence = join('data', 'workspace', page.host, 'verify', page.page, 'verify.json').replaceAll('\\', '/');
  if (record.evidence !== evidence) return false;
  const file = join(runDir, evidence);
  assertNoLinks(file);
  const result = readJson(file);
  if (result?.scoreVersion !== 2 || result.page !== page.page
      || result.measured !== (record.status === 'measured')
      || !Array.isArray(result.viewports) || result.viewports.length !== REQUIRED_VIEWPORTS.length) return false;
  if (record.status === 'measured' && record.measured !== true) return false;
  if (record.status !== 'measured' && record.measured === true) return false;
  const names = result.viewports.map(viewport => viewport?.name);
  if (new Set(names).size !== REQUIRED_VIEWPORTS.length || REQUIRED_VIEWPORTS.some(name => !names.includes(name))) return false;
  if (record.status !== 'measured') return result.overall === null && result.grade === null
    && record.newOverall == null && record.newGrade == null;
  if (record.viewportsMeasured !== REQUIRED_VIEWPORTS.length || !measuredResultValid(result, page)
      || result.overall !== record.newOverall || result.grade !== record.newGrade
      || record.resultSha256 !== sha256File(file) || !Array.isArray(record.diffEvidence)) return false;
  try {
    const actual = collectDiffEvidence(runDir, evidence, result);
    return actual !== null && JSON.stringify(actual) === JSON.stringify(record.diffEvidence);
  } catch { return false; }
}

const remainingPages = (catalog, records) => catalog.filter(page => page.hasClone
  && records[page.host + '/' + page.page]?.status !== 'measured').length;

async function main() {
  const opts = options(process.argv.slice(2));
  const runDir = opts.runDir;
  const dataRoot = join(runDir, 'data');
  const deadline = Date.now() + opts.maxMinutes * 60_000;
  const versionSha256 = verifierSha256();
  const lastRun = { id: randomUUID(), startedAt: new Date().toISOString(), status: 'running',
    verifierSha256: versionSha256, selected: 0, completed: 0, issues: [] };
  let releaseLock = null;
  let catalog = null;
  let records = null;
  let engine;
  try {
    assertNoLinks(WORKSPACE);
    if (!opts.dryRun) {
      assertNoLinks(runDir);
      mkdirSync(runDir, { recursive: true });
      assertNoLinks(runDir);
      releaseLock = acquireRunLock(runDir, opts.recoverLock);
    }
    records = readProgress(runDir).records;
    catalog = auditHistoricalVerification(WORKSPACE).pages;
    const invalidated = invalidateOldVerifier(records, catalog, versionSha256);
    if (invalidated) console.error(`marked ${invalidated} old verifier measurement(s) stale`);
    const sessionInvalidated = invalidateSessionMeasurements(records, catalog);
    if (sessionInvalidated) console.error(`marked ${sessionInvalidated} measurement(s) stale because source sessions are not isolated`);
    const eligible = catalog.filter(page => page.hasClone && (!opts.host || page.host === opts.host)
      && (!opts.page || page.page === opts.page) && (!opts.state || page.verifyState === opts.state));
    if (!eligible.length) throw new Error('No matching cloned pages');
    const selected = [];
    let copyBytes = 0;
    const limitBytes = opts.maxCopyMb * 1024 * 1024;
    const pageLimitBytes = opts.maxPageMb * 1024 * 1024;
    for (const page of eligible) {
      if (selected.length >= opts.maxPages) break;
      const key = page.host + '/' + page.page;
      const previous = records[key];
      const preserveMeasured = previous?.status === 'measured' || previous?.status === 'stale' || previous?.priorMeasured;
      if (Date.now() >= deadline) {
        lastRun.issues.push(noteIssue(records, page, 'preparation_timeout', 'time budget expired during selection', null,
          { stale: preserveMeasured, verifierSha256: versionSha256 }));
        break;
      }
      const sourcePage = join(WORKSPACE, page.host, 'pages', page.page);
      let info;
      try {
        assertNoLinks(sourcePage);
        info = inputInfo(sourcePage, false);
      } catch (error) {
        lastRun.issues.push(noteIssue(records, page, 'input_error', error, null,
          { stale: preserveMeasured, verifierSha256: versionSha256 }));
        continue;
      }
      if (sourceSessionFile(sourcePage)) {
        lastRun.issues.push(noteIssue(records, page, 'session_skipped',
          'source session exists but is not staged into the isolated batch', info.bytes,
          { stale: preserveMeasured, verifierSha256: versionSha256 }));
        continue;
      }
      if (!opts.force && ['measured', 'unmeasured'].includes(previous?.status)
          && previous.inputBytes === info.bytes) {
        try {
          info = inputInfo(sourcePage);
          if (evidenceValid(runDir, page, previous, info.sha256, versionSha256)
              && (previous.status === 'measured' || !opts.retryUnmeasured)) continue;
        } catch (error) {
          lastRun.issues.push(noteIssue(records, page, 'evidence_error', error, info.bytes,
            { stale: preserveMeasured, inputSha256: info.sha256, verifierSha256: versionSha256 }));
        }
      }
      if (info.bytes > pageLimitBytes || copyBytes + info.bytes > limitBytes) {
        const reason = info.bytes > pageLimitBytes ? 'page copy exceeds max-page-mb' : 'total copy exceeds max-copy-mb';
        lastRun.issues.push(noteIssue(records, page, 'budget_skipped', reason, info.bytes,
          { stale: preserveMeasured, inputSha256: info.sha256, verifierSha256: versionSha256 }));
        continue;
      }
      try { if (!info.sha256) info = inputInfo(sourcePage); }
      catch (error) {
        lastRun.issues.push(noteIssue(records, page, 'input_error', error, info.bytes,
          { stale: preserveMeasured, verifierSha256: versionSha256 }));
        continue;
      }
      selected.push({ page, info, sourcePage, preserveMeasured });
      copyBytes += info.bytes;
    }
    lastRun.selected = selected.length;
    lastRun.remaining = remainingPages(catalog, records);
    if (!opts.dryRun) writeProgress(runDir, catalog, records, lastRun);
    console.log(JSON.stringify({ selected: selected.map(({ page, info }) => ({ host: page.host, page: page.page, bytes: info.bytes })),
      copyBytes, remaining: lastRun.remaining,
      runDir, dryRun: opts.dryRun, verifierSha256: versionSha256 }, null, 2));
    if (opts.dryRun || !selected.length) return;

    assertNoLinks(dataRoot);
    mkdirSync(dataRoot, { recursive: true });
    assertNoLinks(dataRoot);
    const staged = [];
    for (const item of selected) {
      const { page, info, sourcePage, preserveMeasured } = item;
      if (Date.now() >= deadline) {
        lastRun.issues.push(noteIssue(records, page, 'preparation_timeout', 'time budget expired before copying', info.bytes,
          { stale: preserveMeasured, inputSha256: info.sha256, verifierSha256: versionSha256 }));
        continue;
      }
      const key = page.host + '/' + page.page;
      const destPage = join(dataRoot, 'workspace', page.host, 'pages', page.page);
      try {
        assertNoLinks(sourcePage);
        assertNoLinks(destPage);
        if (existsSync(destPage)) {
          const existing = inputInfo(destPage);
          if (existing.sha256 !== info.sha256) throw new Error('staged input differs; use a fresh --run-dir: ' + key);
        } else {
          mkdirSync(destPage, { recursive: true });
          assertNoLinks(destPage);
          assertSeparate(destPage, [sourcePage, join(WORKSPACE, page.host, 'verify', page.page)]);
          cpSync(join(sourcePage, 'manifest.json'), join(destPage, 'manifest.json'));
          cpSync(join(sourcePage, 'clone'), join(destPage, 'clone'), { recursive: true });
          if (inputInfo(destPage).sha256 !== info.sha256) throw new Error('staged copy mismatch: ' + key);
        }
        assertSeparate(destPage, [sourcePage, join(WORKSPACE, page.host, 'verify', page.page)]);
        if (Date.now() >= deadline) throw new Error('time budget expired while copying');
        staged.push(item);
      } catch (error) {
        lastRun.issues.push(noteIssue(records, page, 'input_error', error, info.bytes,
          { stale: preserveMeasured, inputSha256: info.sha256, verifierSha256: versionSha256 }));
      }
    }
    if (!staged.length) return;
    if (Date.now() >= deadline) {
      for (const { page, info, preserveMeasured } of staged) {
        lastRun.issues.push(noteIssue(records, page, 'preparation_timeout', 'time budget expired before engine startup', info.bytes,
          { stale: preserveMeasured, inputSha256: info.sha256, verifierSha256: versionSha256 }));
      }
      return;
    }
    const port = await freePort();
    engine = await startEngine(dataRoot, port, deadline);
    for (const { page, info, preserveMeasured } of staged) {
      if (Date.now() >= deadline) {
        lastRun.issues.push(noteIssue(records, page, 'timeout', 'time budget expired before verification', info.bytes,
          { stale: preserveMeasured, inputSha256: info.sha256, verifierSha256: versionSha256 }));
        continue;
      }
      const key = page.host + '/' + page.page;
      const evidence = join('data', 'workspace', page.host, 'verify', page.page, 'verify.json').replaceAll('\\', '/');
      const logFile = join(runDir, 'verify-' + page.host + '-' + page.page + '.log');
      const outDir = join(dataRoot, 'workspace', page.host, 'verify', page.page);
      const archiveParent = join(runDir, 'attempts', page.host, page.page);
      assertNoLinks(outDir);
      assertNoLinks(archiveParent);
      assertNoLinks(logFile);
      let priorMeasured = records[key]?.priorMeasured ?? null;
      if (existsSync(outDir)) {
        mkdirSync(archiveParent, { recursive: true });
        assertNoLinks(archiveParent);
        const archived = join(archiveParent, new Date().toISOString().replaceAll(':', '-') + '-' + randomUUID());
        renameSync(outDir, archived);
        const previous = records[key];
        if (previous?.status === 'measured') {
          priorMeasured = { overall: previous.newOverall, grade: previous.newGrade,
            inputSha256: previous.inputSha256, verifierSha256: previous.verifierSha256,
            evidence: relative(runDir, join(archived, 'verify.json')).replaceAll('\\', '/') };
        } else if (previous?.priorMeasured) {
          priorMeasured = { ...previous.priorMeasured,
            evidence: relative(runDir, join(archived, 'verify.json')).replaceAll('\\', '/') };
        }
      }
      assertNoLinks(dirname(outDir));
      assertSeparate(dirname(outDir), [join(WORKSPACE, page.host, 'verify')]);
      records[key] = { status: 'running', inputBytes: info.bytes, inputSha256: info.sha256,
        verifierSha256: versionSha256, startedAt: new Date().toISOString(), evidence, priorMeasured };
      writeProgress(runDir, catalog, records, lastRun);
      const timeLimitMs = Math.min(8 * 60_000, Math.max(1, deadline - Date.now()));
      console.log('verify ' + key);
      let execution;
      try { execution = await verifyOne(page, dataRoot, port, timeLimitMs, opts.keepScreenshots, logFile); }
      catch (error) { execution = { exitCode: null, error: String(error) }; }
      const evidenceFile = join(runDir, evidence);
      const result = readJson(evidenceFile);
      const viewports = viewportRows(page, result, evidence);
      const candidateMeasured = !execution.timedOut && execution.exitCode === 0 && result?.scoreVersion === 2
        && result.page === page.page && result.measured === true && Number.isFinite(result.overall)
        && ['A', 'B', 'C', 'D'].includes(result.grade)
        && Date.parse(result.generatedAt) >= Date.parse(records[key].startedAt);
      let diffEvidence = null;
      let evidenceError = null;
      const validResult = candidateMeasured && measuredResultValid(result, page);
      if (validResult) {
        try { diffEvidence = collectDiffEvidence(runDir, evidence, result); }
        catch (error) { evidenceError = String(error); }
      }
      const measured = validResult && diffEvidence !== null;
      records[key] = { ...records[key], finishedAt: new Date().toISOString(),
        status: execution.timedOut ? 'timeout' : measured ? 'measured' : 'unmeasured',
        newOverall: measured ? result.overall : null, newGrade: measured ? result.grade : null,
        measured, resultSha256: measured ? sha256File(evidenceFile) : null,
        diffEvidence: measured ? diffEvidence : null,
        viewportsMeasured: viewports.filter(v => v.status === 'measured').length,
        worstCoverage: result?.viewports?.reduce((min, v) => v.coverageRatio == null ? min : Math.min(min, v.coverageRatio), 1) ?? null,
        missingPixels: result?.viewports?.reduce((sum, v) => sum + (v.missingPixels ?? 0), 0) ?? null,
        error: execution.timedOut ? 'page time budget exceeded' + (execution.terminationFailed ? '; process did not exit' : '')
          : result?.error ?? execution.error ?? evidenceError
            ?? (!measured ? 'invalid or missing measurement evidence' : null), viewports };
      lastRun.completed++;
      if (!measured) lastRun.issues.push({ host: page.host, page: page.page, status: records[key].status, error: records[key].error });
      lastRun.remaining = remainingPages(catalog, records);
      writeProgress(runDir, catalog, records, lastRun);
      console.log(`${key}: ${records[key].status} ${records[key].newOverall ?? ''} ${records[key].error ?? ''}`);
      if (execution.terminationFailed) break;
    }
  } catch (error) {
    console.error(error);
    lastRun.issues.push({ status: 'batch_error', error: String(error) });
  } finally {
    if (engine) {
      await stopProcess(engine.child);
      writeFileSync(engine.logFile, engine.logs.text());
    }
    if (!opts.dryRun && releaseLock) {
      lastRun.finishedAt = new Date().toISOString();
      lastRun.remaining = catalog && records ? remainingPages(catalog, records) : null;
      lastRun.status = lastRun.issues.length || lastRun.remaining ? 'partial' : 'complete';
      try { if (catalog && records) writeProgress(runDir, catalog, records, lastRun); }
      finally { releaseLock(); }
    }
    if (lastRun.issues.length) process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
