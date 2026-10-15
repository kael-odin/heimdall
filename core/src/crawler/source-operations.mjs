import { chromium } from 'playwright';
import { exploreOperationStates, sanitizeObservedUrl } from './state-graph.mjs';
import { sourceReadDataCollector } from './source-read-data.mjs';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const ASSERTION_TYPES = new Set(['visible', 'hidden', 'text-includes', 'url']);
const SAFE_ERROR_TYPES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);
const MAX_FLOWS = 100;
const MAX_ISSUES = 100;
const MAX_DEPENDENCIES = 100;

function boundedInteger(value, fallback, max, min = 0) {
  return Number.isInteger(value) && value >= min ? Math.min(value, max) : fallback;
}

function errorType(error) {
  return SAFE_ERROR_TYPES.has(error?.name) ? error.name : 'Error';
}

function sourceOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError('invalid source origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new TypeError('invalid source origin');
  return url.origin;
}

function sessionOptions(session, origin) {
  if (session == null) return { storageState: undefined, sessionStorage: [] };
  if (typeof session !== 'object' || Array.isArray(session)
    || (!Array.isArray(session.cookies) && !Array.isArray(session.origins))) {
    throw new TypeError('invalid source session');
  }
  const sessionStorage = (Array.isArray(session.sessionStorage) ? session.sessionStorage : [])
    .filter(item => item?.origin === origin && Array.isArray(item.entries))
    .flatMap(item => item.entries.filter(entry => typeof entry?.name === 'string' && typeof entry?.value === 'string'));
  return {
    storageState: { cookies: Array.isArray(session.cookies) ? session.cookies : [], origins: Array.isArray(session.origins) ? session.origins : [] },
    sessionStorage,
  };
}

function validateFlow(flow, origin) {
  if (!flow || typeof flow !== 'object' || typeof flow.path !== 'string'
    || !flow.path.startsWith('/') || flow.path.startsWith('//') || flow.path.includes('\\')
    || !Array.isArray(flow.actions) || flow.actions.length > 11
    || !Array.isArray(flow.expect) || !flow.expect.length || flow.expect.length > 5) {
    throw new TypeError('invalid source flow');
  }
  let target;
  try { target = new URL(flow.path, origin); } catch { throw new TypeError('invalid source flow'); }
  if (target.origin !== origin) throw new TypeError('invalid source flow');
}

function safeResult(result) {
  const status = ['initial', 'ok', 'blocked', 'error'].includes(result?.status) ? result.status : 'error';
  const out = { status };
  if (status === 'blocked') out.reason = [
    'cross-origin-navigation', 'submit-control', 'write-risk-request',
  ].includes(result?.reason) ? result.reason : 'blocked';
  if (status === 'error') out.errorType = SAFE_ERROR_TYPES.has(result?.errorType) ? result.errorType : 'Error';
  return out;
}

function safeActionType(value) {
  return ['navigate', 'click', 'fill', 'scroll'].includes(value) ? value : 'invalid';
}

function safeRequest(request) {
  const out = {
    target: sanitizeObservedUrl(request?.target),
    scope: request?.scope === 'first-party' ? 'first-party' : 'external',
    method: /^[A-Z]{1,12}$/.test(request?.method) ? request.method : 'OTHER',
    resourceType: typeof request?.resourceType === 'string' && /^[a-z]{1,20}$/.test(request.resourceType)
      ? request.resourceType : 'other',
    category: ['asset', 'document', 'dynamic-data', 'write-risk', 'realtime', 'other'].includes(request?.category)
      ? request.category : 'other',
    outcome: ['pending', 'response', 'complete', 'blocked', 'network-failed', 'http-error', 'opened'].includes(request?.outcome)
      ? request.outcome : 'unknown',
  };
  if (Number.isInteger(request?.status) && request.status >= 100 && request.status <= 599) out.status = request.status;
  return out;
}

function safeState(state) {
  const dom = state.dom && typeof state.dom === 'object' ? Object.fromEntries(
    ['links', 'buttons', 'forms', 'inputs', 'expanded']
      .map(key => [key, state.dom[key]])
      .filter(([, value]) => Number.isInteger(value) && value >= 0),
  ) : null;
  const viewport = state.viewport && Number.isInteger(state.viewport.width) && Number.isInteger(state.viewport.height)
    ? { width: state.viewport.width, height: state.viewport.height } : null;
  return {
    index: state.index,
    from: state.from,
    action: state.action ? { index: state.action.index, type: state.action.type } : null,
    result: safeResult(state.result),
    url: sanitizeObservedUrl(state.url),
    viewport,
    dom,
    requests: state.requests.map(safeRequest),
    omittedRequests: state.omittedRequests,
    pageErrors: state.pageErrors.map(value => SAFE_ERROR_TYPES.has(value) ? value : 'Error'),
  };
}

async function checkAssertion(page, assertion, origin, timeoutMs) {
  try {
    if (assertion.type === 'visible' || assertion.type === 'hidden') {
      await page.locator(assertion.selector).first().waitFor({ state: assertion.type, timeout: timeoutMs });
    } else if (assertion.type === 'text-includes') {
      await page.locator(assertion.selector).filter({ hasText: assertion.value }).first().waitFor({ state: 'visible', timeout: timeoutMs });
    } else if (assertion.type === 'url') {
      await page.waitForURL(new URL(assertion.path, origin).href, { timeout: timeoutMs });
    } else return false;
    return true;
  } catch { return false; }
}

/**
 * Observe validated operation flows on the authorized source site. The result
 * contains only allowlisted metadata; session values, selectors, inputs, query
 * values, headers, bodies and unrestricted path segments never enter it.
 * No workspace files are written. A disposable browser context is used per flow.
 */
export async function captureSourceOperations({ origin, flows, session = null, browser: suppliedBrowser,
  readOnlyGetUrls = [], onReadOnlyData, onReadOnlyObservation, onObservedRequest,
  settleMs: requestedSettleMs, timeoutMs: requestedTimeoutMs, assertionTimeoutMs: requestedAssertionTimeoutMs } = {}) {
  const base = sourceOrigin(origin);
  if (onObservedRequest != null && typeof onObservedRequest !== 'function') {
    throw new TypeError('invalid source request observer');
  }
  if (!Array.isArray(flows) || flows.length > MAX_FLOWS) throw new TypeError('invalid source flows');
  for (const flow of flows) validateFlow(flow, base);
  const { storageState, sessionStorage } = sessionOptions(session, base);
  const readData = sourceReadDataCollector({
    origin: base, urls: readOnlyGetUrls, onEntry: onReadOnlyData,
    onAccepted: onReadOnlyObservation,
  });
  const settleMs = boundedInteger(requestedSettleMs, 500, 5_000);
  const timeoutMs = boundedInteger(requestedTimeoutMs, 8_000, 30_000, 1);
  const assertionTimeoutMs = boundedInteger(requestedAssertionTimeoutMs, 2_000, 5_000, 1);
  const report = {
    version: 1, status: 'checked', planned: flows.length, checked: 0, failed: 0,
    untested: flows.length, sessionUsed: session != null, flows: [],
  };
  if (!flows.length) {
    report.readOnlyData = readData.summary();
    return report;
  }
  const ownedBrowser = !suppliedBrowser;
  const browser = suppliedBrowser ?? await chromium.launch({ headless: true });
  try {
    for (const [flowIndex, flow] of flows.entries()) {
      const issues = [];
      let omittedIssues = 0;
      const issueKeys = new Set();
      const addIssue = issue => {
        const key = JSON.stringify(issue);
        if (issueKeys.has(key)) return;
        issueKeys.add(key);
        if (issues.length < MAX_ISSUES) issues.push(issue);
        else omittedIssues++;
      };
      let context;
      let onResponse;
      let closing = false;
      let result;
      try {
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ...(storageState ? { storageState } : {}) });
        if (sessionStorage.length) await context.addInitScript(({ allowedOrigin, entries }) => {
          if (location.origin !== allowedOrigin) return;
          try { for (const { name, value } of entries) sessionStorage.setItem(name, value); } catch {}
        }, { allowedOrigin: base, entries: sessionStorage });
        const blocked = new WeakSet();
        await context.route('**/*', async route => {
          const request = route.request();
          const method = String(request.method()).toUpperCase();
          if (READ_METHODS.has(method)) return route.continue();
          blocked.add(request);
          addIssue({ kind: 'writeBlocked', method: /^[A-Z]{1,12}$/.test(method) ? method : 'OTHER', target: sanitizeObservedUrl(request.url()) });
          await route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', async socket => {
          addIssue({ kind: 'websocketBlocked', target: sanitizeObservedUrl(socket.url()) });
          await socket.close({ code: 1008, reason: 'read-only capture' });
        });
        onResponse = response => {
          if (response.status() >= 400) addIssue({ kind: 'http', status: response.status(), target: sanitizeObservedUrl(response.url()) });
          readData.observe(response, flowIndex);
        };
        context.on('response', onResponse);
        context.on('requestfailed', request => {
          if (!closing && !blocked.has(request)) addIssue({ kind: 'requestFailed', target: sanitizeObservedUrl(request.url()) });
        });
        const openedPages = new Set();
        context.on('page', page => {
          openedPages.add(page);
          if (openedPages.size > 1) addIssue({ kind: 'popupUntested' });
          page.on('pageerror', error => addIssue({ kind: 'pageError', error: errorType(error) }));
          page.on('crash', () => addIssue({ kind: 'pageCrash' }));
          page.on('download', () => addIssue({ kind: 'downloadBlocked' }));
        });
        const page = await context.newPage();
        openedPages.add(page);
        const graph = await exploreOperationStates({
          page, baseUrl: base, allowedOrigins: [base], allowUnsafeRequests: false,
          actions: [{ type: 'navigate', url: flow.path }, ...flow.actions],
          onObservedRequest: request => onObservedRequest?.(flowIndex, request),
          maxActions: 12, maxRequestsPerState: 50, maxUnexecuted: 12,
          settleMs, timeoutMs,
        });
        const states = graph.states.map(safeState);
        const dependencies = new Map();
        let omittedDependencies = 0;
        for (const state of states) {
          if (state.action && state.result.status !== 'ok') addIssue({ kind: 'action', actionIndex: state.action.index, result: state.result.status });
          if (state.pageErrors.length) addIssue({ kind: 'pageError', stateIndex: state.index });
          if (state.omittedRequests) addIssue({ kind: 'requestsUntested', stateIndex: state.index, count: state.omittedRequests });
          for (const request of state.requests) {
            const key = [request.method, request.target, request.category, request.scope].join('|');
            if (!dependencies.has(key)) {
              if (dependencies.size < MAX_DEPENDENCIES) dependencies.set(key, request);
              else omittedDependencies++;
            }
            if (request.outcome !== 'complete') addIssue({ kind: 'request', stateIndex: state.index, outcome: request.outcome, target: request.target });
          }
        }
        if (omittedDependencies) addIssue({ kind: 'dependenciesUntested', count: omittedDependencies });
        if (graph.summary.unexecuted) addIssue({ kind: 'actionsUntested', count: graph.summary.unexecuted });
        const assertions = [];
        const canAssert = graph.summary.unexecuted === 0 && states.every(state => !state.action || state.result.status === 'ok')
          && !issues.some(issue => issue.kind === 'popupUntested');
        for (const [assertionIndex, assertion] of flow.expect.entries()) {
          const type = ASSERTION_TYPES.has(assertion.type) ? assertion.type : 'unknown';
          const status = canAssert ? (await checkAssertion(page, assertion, base, assertionTimeoutMs) ? 'passed' : 'failed') : 'untested';
          assertions.push({ index: assertionIndex, type, status });
          if (status === 'failed') addIssue({ kind: 'assertion', assertionIndex, type });
          if (status === 'untested') addIssue({ kind: 'assertionUntested', assertionIndex, type });
        }
        result = {
          index: flowIndex, start: sanitizeObservedUrl(new URL(flow.path, base).href),
          plannedActions: graph.summary.planned, executedActions: graph.summary.executed,
          unexecutedActions: graph.unexecuted.map(item => ({ index: item.index, type: item.type, reason: item.reason })),
          omittedUnexecutedActions: graph.summary.omittedUnexecuted,
          states, dependencies: [...dependencies.values()], omittedDependencies, assertions,
        };
      } catch (error) {
        addIssue({ kind: 'captureError', error: errorType(error) });
        result = {
          index: flowIndex, start: sanitizeObservedUrl(new URL(flow.path, base).href),
          plannedActions: flow.actions.length + 1, executedActions: 0,
          unexecutedActions: [{ index: 0, type: 'navigate', reason: 'capture-error' },
            ...flow.actions.map((action, index) => ({ index: index + 1, type: safeActionType(action?.type), reason: 'capture-error' }))],
          omittedUnexecutedActions: 0, states: [], dependencies: [], omittedDependencies: 0,
          assertions: flow.expect.map((assertion, index) => ({
            index, type: ASSERTION_TYPES.has(assertion.type) ? assertion.type : 'unknown', status: 'untested',
          })),
        };
      } finally {
        closing = true;
        if (context && onResponse) context.off('response', onResponse);
        await readData.drain();
        await context?.close().catch(() => {});
        result.issues = issues;
        result.omittedIssues = omittedIssues;
        result.passed = issues.length === 0 && omittedIssues === 0;
        report.flows.push(result);
        report.checked++;
        report.untested--;
        if (!result.passed) report.failed++;
      }
    }
    report.readOnlyData = readData.summary();
    return report;
  } finally {
    if (ownedBrowser) await browser.close();
  }
}
