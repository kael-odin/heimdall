#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { readSiteIdentity } from '../site-origin.mjs';
import { restoreSessionStorage, sessionContext } from '../session/store.mjs';
import { UA } from '../ua.mjs';
import { sanitizeObservedUrl } from './state-graph.mjs';
import { discoverOperationCandidates } from './operation-candidates.mjs';

const USAGE = 'node src/cli.mjs discover-operations <siteId> [--max-pages N] [--max-candidates N]';
const READ_METHODS = new Set(['GET', 'HEAD']);
const SAFE_ERROR_TYPES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);
const NAVIGATION_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_REQUESTS_PER_PAGE = 150;

function positiveOption(args, name, fallback, ceiling) {
  const flag = `--${name}`;
  const position = args.findIndex(arg => arg === flag || arg.startsWith(`${flag}=`));
  if (position < 0) return fallback;
  const raw = args[position] === flag ? args[position + 1] : args[position].slice(flag.length + 1);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > ceiling) throw new TypeError(`invalid ${flag}`);
  return value;
}

function parseArgs(argv) {
  const [siteId, ...options] = argv;
  if (!siteId || !/^(?!\.\.?$)[a-z0-9.-]+$/i.test(siteId)) throw new TypeError('invalid site id');
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option === '--max-pages' || option === '--max-candidates') { i++; if (!options[i]) throw new TypeError('missing option value'); }
    else if (!/^--(?:max-pages|max-candidates)=/.test(option)) throw new TypeError('unknown option');
  }
  return {
    siteId,
    maxPages: positiveOption(options, 'max-pages', 5, 50),
    maxCandidates: positiveOption(options, 'max-candidates', 32, 200),
  };
}

function safeErrorType(error) {
  return SAFE_ERROR_TYPES.has(error?.name) ? error.name : 'Error';
}

function manifestTarget(siteDir, pageName, origin) {
  try {
    const manifest = JSON.parse(readFileSync(join(siteDir, 'pages', pageName, 'manifest.json'), 'utf8'));
    const target = new URL(manifest?.target);
    if (!['http:', 'https:'].includes(target.protocol) || target.origin !== origin
      || target.username || target.password) return null;
    return target;
  } catch { return null; }
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function inspectPage(browser, { siteDir, pageName, origin, sessionKey, session, maxCandidates }) {
  const target = manifestTarget(siteDir, pageName, origin);
  const result = {
    pageName,
    target: target ? sanitizeObservedUrl(target.href) : '[invalid-url]',
    status: 'unavailable',
    requests: { allowed: 0, blockedWrite: 0, blockedExternal: 0, blockedBudget: 0, blockedWebSocket: 0 },
    candidates: [], summary: null,
  };
  if (!target) { result.reason = 'invalid-or-cross-origin-manifest'; return result; }

  let context;
  try {
    context = await browser.newContext({
      serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: 1440, height: 900 }, userAgent: UA, ...session,
    });
    await restoreSessionStorage(context, sessionKey);
    let observedRequests = 0;
    await context.route('**/*', async route => {
      const request = route.request();
      observedRequests++;
      if (observedRequests > MAX_REQUESTS_PER_PAGE) {
        result.requests.blockedBudget++;
        return route.abort('blockedbyclient');
      }
      const method = String(request.method()).toUpperCase();
      if (!READ_METHODS.has(method)) {
        result.requests.blockedWrite++;
        return route.abort('blockedbyclient');
      }
      let requestOrigin;
      try { requestOrigin = new URL(request.url()).origin; } catch { requestOrigin = null; }
      if (requestOrigin !== origin) {
        result.requests.blockedExternal++;
        return route.abort('blockedbyclient');
      }
      result.requests.allowed++;
      return route.continue();
    });
    await context.routeWebSocket('**/*', async socket => {
      result.requests.blockedWebSocket++;
      await socket.close({ code: 1008, reason: 'read-only discovery' });
    });
    const page = await context.newPage();
    const response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    if (!response || response.status() >= 400) {
      result.status = 'http-error';
      result.httpStatus = response?.status() ?? null;
      return result;
    }
    if (new URL(page.url()).origin !== origin) {
      result.status = 'cross-origin-redirect';
      return result;
    }
    await page.waitForTimeout(350);
    const discovery = await withTimeout(discoverOperationCandidates(page, { maxCandidates }), DISCOVERY_TIMEOUT_MS);
    result.observed = discovery.source;
    result.redirected = page.url() !== target.href;
    result.candidates = discovery.candidates;
    result.summary = discovery.summary;
    result.status = result.redirected ? 'redirected' : 'observed';
    return result;
  } catch (error) {
    result.status = 'error';
    result.errorType = safeErrorType(error);
    return result;
  } finally {
    await context?.close().catch(() => {});
  }
}

function privateWrite(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

export async function discoverWorkspaceOperations({ siteId, maxPages = 5, maxCandidates = 32 } = {}) {
  const identity = readSiteIdentity(WORKSPACE, siteId);
  if (!identity) throw new TypeError('site has no verified origin');
  const siteDir = join(WORKSPACE, siteId);
  const pagesDir = join(siteDir, 'pages');
  const pageNames = existsSync(pagesDir)
    ? readdirSync(pagesDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(join(pagesDir, entry.name, 'manifest.json')))
      .map(entry => entry.name).sort()
    : [];
  if (!pageNames.length) throw new TypeError('site has no captured pages');
  const selected = pageNames.slice(0, maxPages);
  const sessionKey = identity.hostname.replace(/^www\./, '');
  const session = sessionContext(sessionKey);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    siteId,
    origin: identity.origin,
    policy: {
      candidateExecution: 'none', reviewRequired: true, assertionsRequired: true,
      requestMethods: ['GET', 'HEAD'], externalRequests: 'blocked', webSockets: 'blocked',
      snapshotOnly: true, futureStatesUntested: true,
      note: 'GET may still have source-side effects; review authorization before visiting a site.',
    },
    limits: { maxPages, maxCandidates, maxRequestsPerPage: MAX_REQUESTS_PER_PAGE,
      navigationTimeoutMs: NAVIGATION_TIMEOUT_MS, discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS },
    sessionUsed: !!session.storageState,
    pages: [],
    summary: { capturedPages: pageNames.length, attemptedPages: selected.length,
      omittedPages: pageNames.length - selected.length, observedPages: 0, failedPages: 0,
      proposedCandidates: 0, untestedBranchesLowerBound: 0, blockedRequests: 0,
      unknownBranchesBeyondScope: false },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    for (const pageName of selected) {
      const result = await inspectPage(browser, {
        siteDir, pageName, origin: identity.origin, sessionKey, session, maxCandidates,
      });
      report.pages.push(result);
      if (result.status === 'observed' || result.status === 'redirected') report.summary.observedPages++;
      else report.summary.failedPages++;
      report.summary.proposedCandidates += result.candidates.length;
      report.summary.untestedBranchesLowerBound += result.summary?.untestedBranchesLowerBound ?? 0;
      const blockedRequests = result.requests.blockedWrite + result.requests.blockedExternal
        + result.requests.blockedBudget + result.requests.blockedWebSocket;
      report.summary.blockedRequests += blockedRequests;
      report.summary.unknownBranchesBeyondScope ||= result.status !== 'observed'
        || !!result.summary?.unknownBranchesBeyondScope || blockedRequests > 0;
    }
  } finally { await browser.close(); }
  report.summary.unknownBranchesBeyondScope ||= report.summary.omittedPages > 0;
  const output = join(siteDir, 'operation-discovery.json');
  privateWrite(output, report);
  return { output, report };
}

const isMain = process.argv[1] && process.argv[1].replaceAll('\\', '/').endsWith('/crawler/discover-operations.mjs');
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { output, report } = await discoverWorkspaceOperations(options);
    console.log(`[discover-operations] ${report.summary.observedPages}/${report.summary.attemptedPages} pages observed, ${report.summary.proposedCandidates} untested candidates; private report: ${output}`);
    if (report.summary.failedPages) process.exitCode = 1;
  } catch (error) {
    console.error(`[discover-operations] ${safeErrorType(error)}: ${error?.message === 'site has no captured pages' ? 'site has no captured pages' : error?.message === 'site has no verified origin' ? 'site has no verified origin' : USAGE}`);
    process.exitCode = 1;
  }
}
