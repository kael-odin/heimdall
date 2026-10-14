#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { readSiteIdentity } from '../site-origin.mjs';
import { restoreSessionStorage, sessionContext } from '../session/store.mjs';
import { UA } from '../ua.mjs';
import { sanitizeObservedUrl } from './state-graph.mjs';
import { discoverOperationCandidates } from './operation-candidates.mjs';
import { exploreReviewedCandidate, validateReviewedOperationPlan } from './reviewed-operation-states.mjs';

const USAGE = 'node src/cli.mjs discover-operations <siteId> [--max-pages N] [--max-candidates N] [--execute-reviewed --max-actions N --max-explore-ms N]';
const READ_METHODS = new Set(['GET', 'HEAD']);
const SAFE_ERROR_TYPES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);
const NAVIGATION_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 8_000;
const MAX_REQUESTS_PER_PAGE = 150;
const MAX_REVIEW_PLAN_BYTES = 128 * 1024;

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
  let executeReviewed = false;
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option === '--execute-reviewed' && !executeReviewed) executeReviewed = true;
    else if (['--max-pages', '--max-candidates', '--max-actions', '--max-explore-ms'].includes(option)) {
      i++; if (!options[i]) throw new TypeError('missing option value');
    } else if (!/^--(?:max-pages|max-candidates|max-actions|max-explore-ms)=/.test(option)) {
      throw new TypeError('unknown option');
    }
  }
  if (!executeReviewed && options.some(option => /^--(?:max-actions|max-explore-ms)(?:=|$)/.test(option))) {
    throw new TypeError('review execution required');
  }
  return {
    siteId,
    maxPages: positiveOption(options, 'max-pages', 5, 50),
    maxCandidates: positiveOption(options, 'max-candidates', 32, 200),
    executeReviewed,
    maxActions: positiveOption(options, 'max-actions', 8, 50),
    maxExploreMs: positiveOption(options, 'max-explore-ms', 45_000, 120_000),
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

async function inspectPage(browser, {
  siteDir, pageName, origin, sessionKey, session, maxCandidates,
  reviewedCandidates = [], maxActions = 0, maxExploreMs = 45_000,
}) {
  const target = manifestTarget(siteDir, pageName, origin);
  const result = {
    pageName,
    target: target ? sanitizeObservedUrl(target.href) : '[invalid-url]',
    status: 'unavailable',
    requests: { allowed: 0, blockedWrite: 0, blockedExternal: 0, blockedBudget: 0, blockedWebSocket: 0 },
    candidates: [], summary: null, reviewed: [], attemptedReviewed: 0,
  };
  const untested = reason => reviewedCandidates.map(candidate => ({
    index: candidate.index, kind: candidate.kind, status: 'unexplored', reason,
  }));
  result.reviewed = untested('page-unavailable');
  if (!target) { result.reason = 'invalid-or-cross-origin-manifest'; return result; }

  const deadline = reviewedCandidates.length ? Date.now() + maxExploreMs : null;
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
    const response = await page.goto(target.href, {
      waitUntil: 'domcontentloaded',
      timeout: deadline ? Math.max(1, Math.min(NAVIGATION_TIMEOUT_MS, deadline - Date.now())) : NAVIGATION_TIMEOUT_MS,
    });
    if (!response || response.status() >= 400) {
      result.status = 'http-error';
      result.httpStatus = response?.status() ?? null;
      return result;
    }
    if (new URL(page.url()).origin !== origin) {
      result.status = 'cross-origin-redirect';
      return result;
    }
    if (deadline) await withTimeout(page.waitForTimeout(350), Math.max(1, deadline - Date.now()));
    else await page.waitForTimeout(350);
    const discovery = await withTimeout(discoverOperationCandidates(page, { maxCandidates }),
      deadline ? Math.max(1, Math.min(DISCOVERY_TIMEOUT_MS, deadline - Date.now())) : DISCOVERY_TIMEOUT_MS);
    result.observed = discovery.source;
    result.redirected = page.url() !== target.href;
    result.candidates = discovery.candidates;
    result.summary = discovery.summary;
    result.status = result.redirected ? 'redirected' : 'observed';
    if (reviewedCandidates.length) {
      await page.close();
      const reviewed = [];
      for (const candidate of reviewedCandidates) {
        if (result.attemptedReviewed >= maxActions) {
          reviewed.push({ index: candidate.index, kind: candidate.kind,
            status: 'unexplored', reason: 'action-budget' });
          continue;
        }
        const current = discovery.candidates[candidate.index];
        if (current?.kind !== candidate.kind || current.action.selector !== candidate.selector) {
          reviewed.push({ index: candidate.index, kind: candidate.kind,
            status: 'unexplored', reason: 'candidate-changed' });
          continue;
        }
        result.attemptedReviewed++;
        reviewed.push(await exploreReviewedCandidate(context, {
          origin, target: target.href, candidate, maxCandidates, deadline,
          requestCounters: () => ({ ...result.requests }),
        }));
      }
      result.reviewed = reviewed;
    }
    return result;
  } catch (error) {
    result.status = 'error';
    result.errorType = safeErrorType(error);
    if (deadline && Date.now() >= deadline) result.reason = 'page-time-budget';
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

export async function discoverWorkspaceOperations({
  siteId, maxPages = 5, maxCandidates = 32, executeReviewed = false,
  maxActions = 8, maxExploreMs = 45_000,
} = {}) {
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
  let review = { byPage: new Map(), total: 0 };
  if (executeReviewed) {
    const planFile = join(siteDir, 'operation-review.json');
    if (!existsSync(planFile) || statSync(planFile).size > MAX_REVIEW_PLAN_BYTES) {
      throw new TypeError('invalid operation review plan');
    }
    try {
      review = validateReviewedOperationPlan(JSON.parse(readFileSync(planFile, 'utf8')),
        { origin: identity.origin, pageNames });
    } catch { throw new TypeError('invalid operation review plan'); }
  }
  const selected = pageNames.slice(0, maxPages);
  const sessionKey = identity.hostname.replace(/^www\./, '');
  const session = sessionContext(sessionKey);
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    siteId,
    origin: identity.origin,
    policy: {
      candidateExecution: executeReviewed ? 'explicit-reviewed-only' : 'none',
      reviewRequired: true, assertionsRequiredForCloneVerification: true,
      requestMethods: ['GET', 'HEAD'], externalRequests: 'blocked', webSockets: 'blocked',
      sourceObservationOnly: true, futureStatesUntested: true,
      note: 'GET may still have source-side effects; review authorization before visiting a site.',
    },
    limits: { maxPages, maxCandidates, maxRequestsPerPage: MAX_REQUESTS_PER_PAGE,
      navigationTimeoutMs: NAVIGATION_TIMEOUT_MS, discoveryTimeoutMs: DISCOVERY_TIMEOUT_MS,
      maxActions: executeReviewed ? maxActions : 0, maxExploreMs: executeReviewed ? maxExploreMs : 0 },
    sessionUsed: !!session.storageState,
    pages: [],
    summary: { capturedPages: pageNames.length, attemptedPages: selected.length,
      omittedPages: pageNames.length - selected.length, observedPages: 0, failedPages: 0,
      proposedCandidates: 0, untestedBranchesLowerBound: 0, blockedRequests: 0,
      reviewedCandidates: review.total, attemptedReviewed: 0, sourceObservedBranches: 0,
      reviewedUnexplored: 0, reviewedLimited: 0, followupCandidates: 0,
      followupUntestedBranchesLowerBound: 0,
      unknownBranchesBeyondScope: false },
  };
  const browser = await chromium.launch({ headless: true });
  try {
    let remainingActions = maxActions;
    for (const pageName of selected) {
      const reviewedCandidates = review.byPage.get(pageName) ?? [];
      const result = await inspectPage(browser, {
        siteDir, pageName, origin: identity.origin, sessionKey, session, maxCandidates,
        reviewedCandidates, maxActions: remainingActions, maxExploreMs,
      });
      remainingActions -= result.attemptedReviewed;
      report.pages.push(result);
      if (result.status === 'observed' || result.status === 'redirected') report.summary.observedPages++;
      else report.summary.failedPages++;
      report.summary.proposedCandidates += result.candidates.length;
      report.summary.attemptedReviewed += result.attemptedReviewed;
      const sourceObserved = result.reviewed.filter(item => item.status === 'source-observed').length;
      report.summary.sourceObservedBranches += sourceObserved;
      report.summary.reviewedUnexplored += result.reviewed.filter(item => item.status !== 'source-observed').length;
      report.summary.reviewedLimited += result.reviewed.filter(item => item.limited).length;
      report.summary.followupCandidates += result.reviewed.reduce((sum, item) =>
        sum + (item.followup?.proposed ?? 0), 0);
      const followupUntested = Math.max(0, ...result.reviewed.map(item =>
        item.followup?.newUntestedBranchesLowerBound ?? 0));
      report.summary.followupUntestedBranchesLowerBound += followupUntested;
      report.summary.untestedBranchesLowerBound += Math.max(0,
        (result.summary?.untestedBranchesLowerBound ?? 0) - sourceObserved) + followupUntested;
      const blockedRequests = result.requests.blockedWrite + result.requests.blockedExternal
        + result.requests.blockedBudget + result.requests.blockedWebSocket;
      report.summary.blockedRequests += blockedRequests;
      report.summary.unknownBranchesBeyondScope ||= result.status !== 'observed'
        || !!result.summary?.unknownBranchesBeyondScope || blockedRequests > 0
        || result.reviewed.some(item => item.status !== 'source-observed' || item.limited
          || item.followup?.newCandidatesUnknown
          || (item.followup?.untestedBranchesLowerBound ?? 0) > 0);
    }
  } finally { await browser.close(); }
  report.unexploredReviewed = [];
  for (const pageName of pageNames.slice(maxPages)) {
    for (const candidate of review.byPage.get(pageName) ?? []) {
      report.unexploredReviewed.push({ pageName, index: candidate.index,
        kind: candidate.kind, reason: 'page-budget' });
      report.summary.reviewedUnexplored++;
    }
  }
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
    console.log(`[discover-operations] ${report.summary.observedPages}/${report.summary.attemptedPages} pages observed, ${report.summary.proposedCandidates} candidates, ${report.summary.sourceObservedBranches}/${report.summary.reviewedCandidates} reviewed branches observed at source; private report: ${output}`);
    if (report.summary.failedPages || report.summary.reviewedUnexplored || report.summary.reviewedLimited
      || (options.executeReviewed && report.summary.blockedRequests)) process.exitCode = 1;
  } catch (error) {
    console.error(`[discover-operations] ${safeErrorType(error)}: ${error?.message === 'site has no captured pages' ? 'site has no captured pages' : error?.message === 'site has no verified origin' ? 'site has no verified origin' : USAGE}`);
    process.exitCode = 1;
  }
}
