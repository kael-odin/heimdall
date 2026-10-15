import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { exploreOperationStates, sanitizeObservedUrl } from '../crawler/state-graph.mjs';
import { sourceReadDataCollector } from '../crawler/source-read-data.mjs';

const MAX_BROWSER_FAILURES = 100;
const PRIVATE_PATH_PARENT = /^(?:users?|accounts?|members?|profiles?|customers?|patients?|orders?|invoices?|sessions?|reset-password|password-reset|verify-email|email-verification|magic-link|invites?|invitations?|tokens?|secrets?)$/i;
const PUBLIC_ERROR_TYPES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError', 'EvalError', 'AggregateError']);

function boundedInteger(value, fallback, upperBound) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, upperBound) : fallback;
}

function publicPath(value) {
  try {
    const url = new URL(value, 'http://127.0.0.1');
    let privateParent = false;
    return url.pathname.split('/').map(segment => {
      const privateSegment = privateParent || segment.length > 64 || /%40|@/i.test(segment);
      privateParent = PRIVATE_PATH_PARENT.test(segment);
      return privateSegment ? '[redacted]' : segment;
    }).join('/') || '/';
  } catch { return '[invalid path]'; }
}

function publicTarget(value, localOrigin) {
  try {
    const url = new URL(value);
    return url.origin === localOrigin ? publicPath(url.href) : url.origin;
  } catch { return '[invalid URL]'; }
}

function publicErrorType(error) {
  return PUBLIC_ERROR_TYPES.has(error?.name) ? error.name : 'Error';
}

function startOfflineServer(bundleDir) {
  return new Promise((resolve, reject) => {
    const adapterEnabled = existsSync(join(bundleDir, 'runtime-adapter'));
    const runtimeDataDir = adapterEnabled ? mkdtempSync(join(tmpdir(), 'heimdall-adapter-probe-')) : null;
    const child = spawn(process.execPath, [join(bundleDir, 'serve.mjs'), '--port', '0', '--host', '127.0.0.1', '--offline', '--root', 'mirror'], {
      cwd: bundleDir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: runtimeDataDir ? { ...process.env, HEIMDALL_RUNTIME_DATA_DIR: runtimeDataDir } : process.env,
    });
    child.once('close', () => { if (runtimeDataDir) rmSync(runtimeDataDir, { recursive: true, force: true }); });
    let stderr = '';
    child.stderr.on('data', part => { stderr = (stderr + part).slice(-2000); });
    const timer = setTimeout(() => fail(new Error('offline server startup timed out')), 10_000);
    function fail(error) {
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`offline server exited (${code}): ${stderr}`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

/** Request every statically discovered local route from the actual offline server. */
export async function probeOfflineBundle(bundleDir, paths) {
  const { child, base } = await startOfflineServer(bundleDir);
  let next = 0;
  let failed = 0;
  const failures = [];
  try {
    const workers = Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (next < paths.length) {
        const path = paths[next++];
        try {
          const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          if (!response.ok) {
            failed++;
            if (failures.length < 100) failures.push({ path: path.split('?')[0], status: response.status });
          }
          await response.body?.cancel();
        } catch (error) {
          failed++;
          if (failures.length < 100) failures.push({ path: path.split('?')[0], error: String(error?.message ?? error) });
        }
      }
    });
    await Promise.all(workers);
    return { checked: paths.length, failed, failures };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
}

/** Inspect page routes in a real browser with all non-bundle network blocked. */
export async function probeOfflineBrowserBundle(bundleDir, pageRoutes, options = {}) {
  if (!Array.isArray(pageRoutes)) throw new TypeError('pageRoutes must be an array');
  const routes = [...new Set(pageRoutes)];
  const maxPages = boundedInteger(options.maxPages, routes.length, routes.length);
  const navigationTimeoutMs = boundedInteger(options.navigationTimeoutMs, 8_000, 30_000);
  const settleMs = boundedInteger(options.settleMs, 500, 5_000);
  const maxFailures = boundedInteger(options.maxFailures, MAX_BROWSER_FAILURES, MAX_BROWSER_FAILURES);
  const selected = routes.slice(0, maxPages);
  const report = {
    checked: 0,
    failed: 0,
    failures: [],
    failureCount: 0,
    totalPages: routes.length,
    untested: routes.length - selected.length,
    truncated: routes.length > selected.length,
    observationMs: settleMs,
  };
  if (selected.length === 0) return report;
  const { child, base } = await startOfflineServer(bundleDir);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const routePath of selected) {
      report.checked++;
      const pagePath = typeof routePath === 'string' ? publicPath(routePath) : '[invalid path]';
      const seen = new Set();
      let pageFailures = 0;
      const addFailure = failure => {
        const item = { pageIndex: report.checked - 1, page: pagePath, ...failure };
        const key = JSON.stringify(item);
        if (seen.has(key)) return;
        seen.add(key);
        pageFailures++;
        report.failureCount++;
        if (report.failures.length < maxFailures) report.failures.push(item);
      };
      let context;
      let closing = false;
      try {
        if (typeof routePath !== 'string' || !routePath.startsWith('/') || routePath.startsWith('//') || routePath.includes('\\')) {
          addFailure({ kind: 'invalidRoute' });
          continue;
        }
        const target = new URL(routePath, base);
        if (target.origin !== base) {
          addFailure({ kind: 'invalidRoute' });
          continue;
        }
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
        const blocked = new WeakSet();
        await context.route('**/*', async requestRoute => {
          const request = requestRoute.request();
          if (new URL(request.url()).origin === base) return requestRoute.continue();
          blocked.add(request);
          addFailure({ kind: 'externalRequest', target: publicTarget(request.url(), base) });
          await requestRoute.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', async socket => {
          addFailure({ kind: 'websocketUnsupported', target: publicTarget(socket.url(), base) });
          await socket.close({ code: 1008, reason: 'offline probe' });
        });
        context.on('response', response => {
          if (response.status() >= 400) addFailure({
            kind: 'http', status: response.status(), target: publicTarget(response.url(), base),
          });
        });
        context.on('requestfailed', request => {
          if (!closing && !blocked.has(request)) addFailure({ kind: 'requestFailed', target: publicTarget(request.url(), base) });
        });
        context.on('page', page => {
          page.on('pageerror', error => addFailure({ kind: 'pageError', error: publicErrorType(error) }));
          page.on('crash', () => addFailure({ kind: 'pageCrash' }));
        });
        const page = await context.newPage();
        try { await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }); }
        catch (error) { addFailure({ kind: 'navigation', error: publicErrorType(error) }); }
        await page.waitForTimeout(settleMs);
      } catch (error) {
        addFailure({ kind: 'probeError', error: publicErrorType(error) });
      } finally {
        closing = true;
        try { await context?.close(); }
        catch (error) { addFailure({ kind: 'probeError', error: publicErrorType(error) }); }
        if (pageFailures) report.failed++;
      }
    }
    report.truncated ||= report.failures.length < report.failureCount;
    return report;
  } finally {
    try { await browser?.close(); }
    finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
  }
}

async function checkAssertion(page, assertion, base) {
  try {
    if (assertion.type === 'visible' || assertion.type === 'hidden') {
      await page.locator(assertion.selector).first().waitFor({
        state: assertion.type, timeout: 2_000,
      });
      return true;
    }
    if (assertion.type === 'text-includes') {
      await page.locator(assertion.selector).filter({ hasText: assertion.value }).first().waitFor({
        state: 'visible', timeout: 2_000,
      });
      return true;
    }
    if (assertion.type === 'url') {
      await page.waitForURL(new URL(assertion.path, base).href, { timeout: 2_000 });
      return true;
    }
  } catch { return false; }
  return false;
}

/** Replay explicit critical paths against the candidate bundle with origin access blocked. */
export async function probeOfflineOperations(bundleDir, flows, options = {}) {
  if (!Array.isArray(flows)) throw new TypeError('flows must be an array');
  if (options.onObservedRequest != null && typeof options.onObservedRequest !== 'function') {
    throw new TypeError('invalid offline request observer');
  }
  if (options.readOnlyGetUrls && (!Array.isArray(options.readOnlyGetUrls) || options.readOnlyGetUrls.length > 100)) {
    throw new TypeError('invalid read-only request list');
  }
  if (options.onReadOnlyGet && typeof options.onReadOnlyGet !== 'function') {
    throw new TypeError('invalid read-only request observer');
  }
  if (options.onReadOnlyObservation && typeof options.onReadOnlyObservation !== 'function') {
    throw new TypeError('invalid read-only response observer');
  }
  const report = {
    status: 'checked', planned: flows.length, checked: 0, failed: 0, untested: flows.length,
    failures: [], omittedFailures: 0, flows: [],
  };
  if (!flows.length) return report;
  const addFailure = failure => {
    if (report.failures.length < MAX_BROWSER_FAILURES) report.failures.push(failure);
    else report.omittedFailures++;
  };
  const { child, base } = await startOfflineServer(bundleDir);
  let browser;
  try {
    const readOnlyRequests = new Map((options.readOnlyGetUrls ?? []).map(value => {
      const sourceUrl = new URL(value);
      return [new URL(sourceUrl.pathname + sourceUrl.search, base).href, value];
    }));
    const readData = sourceReadDataCollector({
      origin: base, urls: [...readOnlyRequests.keys()], onEntry() {},
      onAccepted: (entry, flowIndex) => {
        const sourceUrl = readOnlyRequests.get(entry.url);
        if (!sourceUrl) throw new Error('unmapped read-only response');
        options.onReadOnlyObservation?.(sourceUrl, entry, flowIndex);
      },
    });
    browser = await chromium.launch({ headless: true });
    for (const [flowIndex, flow] of flows.entries()) {
      const issues = [];
      const addIssue = issue => {
        if (!issues.some(existing => JSON.stringify(existing) === JSON.stringify(issue))) issues.push(issue);
      };
      let context;
      try {
        context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
        context.on('request', request => {
          if (request.method().toUpperCase() !== 'GET') return;
          const sourceUrl = readOnlyRequests.get(request.url());
          if (sourceUrl) options.onReadOnlyGet?.(sourceUrl);
        });
        await context.route('**/*', async route => {
          const request = route.request();
          if (new URL(request.url()).origin === base) return route.continue();
          addIssue({ kind: 'externalRequest', target: sanitizeObservedUrl(request.url()) });
          await route.abort('blockedbyclient');
        });
        await context.routeWebSocket('**/*', async socket => {
          addIssue({ kind: 'websocketUnsupported', target: sanitizeObservedUrl(socket.url()) });
          await socket.close({ code: 1008, reason: 'offline probe' });
        });
        context.on('response', response => {
          if (response.status() >= 400) addIssue({
            kind: 'http', status: response.status(), target: sanitizeObservedUrl(response.url()),
          });
          readData.observe(response, flowIndex);
        });
        const page = await context.newPage();
        page.on('download', () => addIssue({ kind: 'downloadUnsupported' }));
        context.on('page', opened => {
          if (opened === page) return;
          addIssue({ kind: 'popupUntested' });
          opened.on('download', () => addIssue({ kind: 'downloadUnsupported' }));
          void opened.close().catch(() => {});
        });
        const graph = await exploreOperationStates({
          page, baseUrl: base,
          actions: [{ type: 'navigate', url: flow.path }, ...flow.actions],
          allowedOrigins: [base],
          allowUnsafeRequests: existsSync(join(bundleDir, 'runtime-adapter')),
          onObservedRequest: request => options.onObservedRequest?.(flowIndex, request, base),
          maxActions: 12,
          settleMs: boundedInteger(options.settleMs, 500, 5_000),
          timeoutMs: boundedInteger(options.timeoutMs, 8_000, 30_000),
        });
        const dependencies = new Map();
        const categories = {};
        for (const state of graph.states) {
          if (state.action && state.result.status !== 'ok') {
            addIssue({ kind: 'action', actionIndex: state.action.index, result: state.result.status });
          }
          if (state.pageErrors.length) addIssue({ kind: 'pageError', stateIndex: state.index });
          if (state.omittedRequests) addIssue({ kind: 'requestsUntested', stateIndex: state.index, count: state.omittedRequests });
          for (const dependency of state.requests) {
            categories[dependency.category] = (categories[dependency.category] ?? 0) + 1;
            const key = [dependency.method, dependency.target, dependency.category].join('|');
            if (dependencies.size < 50 && !dependencies.has(key)) dependencies.set(key, dependency);
            if (dependency.scope === 'external') addIssue({ kind: 'externalRequest', target: dependency.target });
            if (dependency.category === 'realtime') addIssue({ kind: 'realtimeUnsupported', target: dependency.target });
            if (dependency.outcome !== 'complete') addIssue({
              kind: 'request', stateIndex: state.index, outcome: dependency.outcome, target: dependency.target,
            });
          }
        }
        if (graph.summary.unexecuted) addIssue({ kind: 'actionsUntested', count: graph.summary.unexecuted });
        if (!issues.length) {
          for (const [assertionIndex, assertion] of flow.expect.entries()) {
            if (!await checkAssertion(page, assertion, base)) {
              addIssue({ kind: 'assertion', assertionIndex, type: assertion.type });
            }
          }
        }
        report.flows.push({
          index: flowIndex, executedActions: graph.summary.executed,
          plannedActions: graph.summary.planned, states: graph.states.length,
          categories, dependencies: [...dependencies.values()], passed: issues.length === 0,
        });
      } catch (error) {
        addIssue({ kind: 'probeError', error: publicErrorType(error) });
        report.flows.push({ index: flowIndex, passed: false });
      } finally {
        await readData.drain();
        await context?.close().catch(() => {});
        report.checked++;
        report.untested--;
        if (issues.length) {
          report.failed++;
          for (const issue of issues) addFailure({ flowIndex, ...issue });
        }
      }
    }
    if (readOnlyRequests.size) report.readOnlyData = readData.summary();
    return report;
  } finally {
    try { await browser?.close(); }
    finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
  }
}
