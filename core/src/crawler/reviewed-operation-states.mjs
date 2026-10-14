import { discoverOperationCandidates } from './operation-candidates.mjs';
import { exploreOperationStates, sanitizeObservedUrl } from './state-graph.mjs';

const KINDS = new Set(['menu', 'tab', 'disclosure', 'pagination']);
const STRUCTURAL_SELECTOR = /^body > :nth-child\([1-9]\d*\)(?: > :nth-child\([1-9]\d*\))*$/;
const CATEGORIES = ['asset', 'document', 'dynamic-data', 'realtime', 'write-risk', 'other'];
const SAFE_ERROR_TYPES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);

function safeErrorType(error) {
  return SAFE_ERROR_TYPES.has(error?.name) ? error.name : 'Error';
}

function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function within(promise, duration) {
  if (duration < 100) throw Object.assign(new Error('time budget exhausted'), { name: 'TimeoutError' });
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), duration);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Exact, human-selected candidates from a prior private discovery report. */
export function validateReviewedOperationPlan(value, { origin, pageNames }) {
  if (value?.version !== 1 || value.origin !== origin || !Array.isArray(value.pages)
    || !value.pages.length || value.pages.length > 50) throw new TypeError('invalid operation review plan');
  const capturedPages = new Set(pageNames);
  const byPage = new Map();
  let total = 0;
  for (const page of value.pages) {
    if (typeof page?.pageName !== 'string' || !capturedPages.has(page.pageName)
      || byPage.has(page.pageName) || !Array.isArray(page.candidates) || !page.candidates.length) {
      throw new TypeError('invalid operation review plan');
    }
    const seen = new Set();
    const candidates = [];
    for (const candidate of page.candidates) {
      if (!Number.isInteger(candidate?.index) || candidate.index < 0 || candidate.index >= 200
        || !KINDS.has(candidate.kind) || typeof candidate.selector !== 'string'
        || candidate.selector.length > 512 || !STRUCTURAL_SELECTOR.test(candidate.selector)
        || seen.has(candidate.index)) throw new TypeError('invalid operation review plan');
      seen.add(candidate.index);
      candidates.push({ index: candidate.index, kind: candidate.kind, selector: candidate.selector });
      total++;
      if (total > 100) throw new TypeError('invalid operation review plan');
    }
    byPage.set(page.pageName, candidates);
  }
  return { byPage, total };
}

// The fingerprint is used only for a changed/not-changed signal; page content and
// its digest are never included in the report.
async function privateSnapshot(page, selector) {
  const url = page.url();
  try {
    const dom = await page.evaluate(selector => {
      const html = document.body?.outerHTML ?? '';
      let hash = 2166136261;
      for (let index = 0; index < Math.min(html.length, 500_000); index++) {
        hash = Math.imul(hash ^ html.charCodeAt(index), 16777619);
      }
      const element = document.querySelector(selector);
      const flag = name => ['true', 'false'].includes(element?.getAttribute(name))
        ? element.getAttribute(name) : null;
      const controlled = (element?.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)
        .slice(0, 8).map(id => {
          const region = document.getElementById(id);
          if (!region) return { present: false };
          const style = getComputedStyle(region);
          return { present: true, hidden: region.hidden || region.getAttribute('aria-hidden') === 'true'
            || style.display === 'none' || style.visibility === 'hidden' };
        });
      return {
        length: html.length,
        hash: hash >>> 0,
        truncated: html.length > 500_000,
        control: element ? {
          present: true, expanded: flag('aria-expanded'), selected: flag('aria-selected'),
          pressed: flag('aria-pressed'), current: element.getAttribute('aria-current') != null
            && element.getAttribute('aria-current') !== 'false',
        } : { present: false },
        controlled,
      };
    }, selector);
    return { url, dom };
  } catch { return { url, dom: null }; }
}

function dependencySummary(requests) {
  const categories = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  const outcomes = { complete: 0, pending: 0, blocked: 0, failed: 0, httpError: 0 };
  for (const request of requests) {
    categories[CATEGORIES.includes(request.category) ? request.category : 'other']++;
    if (request.outcome === 'complete') outcomes.complete++;
    else if (request.outcome === 'blocked') outcomes.blocked++;
    else if (request.outcome === 'network-failed') outcomes.failed++;
    else if (request.outcome === 'http-error') outcomes.httpError++;
    else outcomes.pending++;
  }
  return { scope: 'action-window', observed: requests.length, categories, outcomes };
}

export async function exploreReviewedCandidate(context, {
  origin, target, candidate, maxCandidates, deadline, requestCounters,
}) {
  const result = { index: candidate.index, kind: candidate.kind, status: 'unexplored' };
  if (remaining(deadline) < 100) { result.reason = 'time-budget'; return result; }
  let page;
  const beforeRequests = { ...requestCounters() };
  try {
    page = await context.newPage();
    const response = await page.goto(target, {
      waitUntil: 'domcontentloaded', timeout: Math.min(15_000, remaining(deadline)),
    });
    if (!response || response.status() >= 400) { result.reason = 'http-error'; return result; }
    if (new URL(page.url()).origin !== origin) { result.reason = 'cross-origin-redirect'; return result; }
    await within(page.waitForTimeout(250), remaining(deadline));
    const current = await within(discoverOperationCandidates(page, { maxCandidates }), Math.min(8_000, remaining(deadline)));
    const matched = current.candidates[candidate.index];
    if (matched?.kind !== candidate.kind || matched.action.selector !== candidate.selector) {
      result.reason = 'candidate-changed';
      return result;
    }
    const completeBaseline = current.summary.recognized === current.summary.proposed
      && !current.summary.scanTruncated;
    const before = await privateSnapshot(page, candidate.selector);
    const graph = await within(exploreOperationStates({
      page, allowedOrigins: [origin], actions: [{ type: 'click', selector: candidate.selector }],
      maxActions: 1, maxRequestsPerState: 100, timeoutMs: Math.min(5_000, remaining(deadline)),
      settleMs: 350,
    }), remaining(deadline));
    const after = await privateSnapshot(page, candidate.selector);
    const actionState = graph.states[1];
    const actionResult = actionState?.result;
    result.transition = {
      from: sanitizeObservedUrl(before.url), to: sanitizeObservedUrl(after.url),
      urlChanged: before.url !== after.url,
      domChanged: before.dom && after.dom
        ? before.dom.length !== after.dom.length || before.dom.hash !== after.dom.hash : null,
      domSampleTruncated: !!(before.dom?.truncated || after.dom?.truncated),
      controlStateChanged: before.dom && after.dom
        ? JSON.stringify(before.dom.control) !== JSON.stringify(after.dom.control) : null,
      controlledStateChanged: before.dom && after.dom
        ? JSON.stringify(before.dom.controlled) !== JSON.stringify(after.dom.controlled) : null,
    };
    const changed = result.transition.urlChanged || result.transition.controlStateChanged === true
      || result.transition.controlledStateChanged === true;
    const uncertain = result.transition.domChanged == null
      || result.transition.controlStateChanged == null
      || result.transition.controlledStateChanged == null || result.transition.domSampleTruncated;
    result.transition.observation = changed ? 'target-or-url-change'
      : result.transition.domChanged ? 'page-only-change' : uncertain ? 'unknown' : 'unchanged';
    result.status = actionResult?.status === 'ok'
      ? changed ? 'source-observed' : result.transition.domChanged
        ? 'page-change-unattributed' : uncertain ? 'transition-unconfirmed' : 'no-detected-transition'
      : actionResult?.status === 'blocked' ? 'blocked' : 'error';
    if (actionResult?.reason) result.reason = actionResult.reason;
    if (actionResult?.errorType) result.errorType = actionResult.errorType;
    if (result.status === 'no-detected-transition') result.reason = 'no-observed-state-change';
    if (result.status === 'page-change-unattributed') result.reason = 'page-change-not-linked-to-control';
    if (result.status === 'transition-unconfirmed') result.reason = 'state-observation-incomplete';
    result.dependencies = dependencySummary(actionState?.requests ?? []);
    result.omittedDependencies = actionState?.omittedRequests ?? 0;
    result.pageErrors = actionState?.pageErrors?.length ?? 0;
    const afterRequests = requestCounters();
    result.blockedRequests = {
      write: afterRequests.blockedWrite - beforeRequests.blockedWrite,
      external: afterRequests.blockedExternal - beforeRequests.blockedExternal,
      budget: afterRequests.blockedBudget - beforeRequests.blockedBudget,
      webSocket: afterRequests.blockedWebSocket - beforeRequests.blockedWebSocket,
    };
    result.limited = result.status !== 'source-observed'
      || result.omittedDependencies > 0 || result.pageErrors > 0
      || Object.values(result.blockedRequests).some(value => value > 0)
      || Object.values(result.dependencies.outcomes).slice(1).some(value => value > 0);
    if (result.status === 'source-observed' && remaining(deadline) >= 100) {
      try {
        const followup = await within(discoverOperationCandidates(page, { maxCandidates }),
          Math.min(8_000, remaining(deadline)));
        let newUntestedBranchesLowerBound = 0;
        if (completeBaseline) {
          for (const kind of KINDS) {
            const beforeCount = current.candidates.filter(item => item.kind === kind).length;
            const afterCount = followup.candidates.filter(item => item.kind === kind).length;
            newUntestedBranchesLowerBound += Math.max(0, afterCount - beforeCount);
          }
        }
        result.followup = {
          status: 'observed', proposed: followup.summary.proposed,
          untestedBranchesLowerBound: followup.summary.untestedBranchesLowerBound,
          newUntestedBranchesLowerBound,
          newCandidatesUnknown: !completeBaseline || followup.summary.omittedByBudget > 0
            || followup.summary.omittedUnaddressable > 0 || followup.summary.scanTruncated,
          unknownBranchesBeyondScope: followup.summary.unknownBranchesBeyondScope,
          candidates: followup.candidates,
        };
      } catch (error) {
        result.followup = { status: 'unavailable', errorType: safeErrorType(error) };
        result.limited = true;
      }
    }
    return result;
  } catch (error) {
    result.reason = error?.name === 'TimeoutError' ? 'time-budget-or-timeout' : 'execution-error';
    result.errorType = safeErrorType(error);
    return result;
  } finally { await page?.close().catch(() => {}); }
}
