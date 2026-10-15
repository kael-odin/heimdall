/**
 * Explore an explicit, bounded operation script on an existing Playwright page
 * or context. The report is safe to share: selectors, input values, query
 * strings, response bodies, headers and unrestricted path segments stay out.
 *
 * The caller owns the context and any supplied page. A page created from a
 * supplied context is closed here. Run this in a disposable context: GET links
 * and page scripts can still have server-side effects that cannot be inferred
 * from HTTP method alone.
 */
const PUBLIC_PATH_SEGMENTS = new Set([
  'about', 'articles', 'blog', 'cart', 'categories', 'category', 'checkout',
  'contact', 'dashboard', 'docs', 'faq', 'help', 'home', 'index', 'login',
  'news', 'pages', 'pricing', 'product', 'products', 'search', 'settings',
  'shop', 'signup', 'store', 'support', 'tag', 'terms',
]);
const PRIVATE_PATH_PARENTS = /^(?:users?|accounts?|members?|profiles?|customers?|patients?|orders?|invoices?|sessions?|reset-password|password-reset|verify-email|email-verification|magic-link|invites?|invitations?|tokens?|secrets?)$/i;
const SAFE_ERROR_TYPES = new Set(['Error', 'TimeoutError', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError']);
const SAFE_RESOURCE_TYPES = new Set([
  'document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack',
  'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other',
]);
const ASSET_TYPES = new Set(['stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'manifest']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function boundedInteger(value, fallback, max) {
  return Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;
}

function safeErrorType(error) {
  return SAFE_ERROR_TYPES.has(error?.name) ? error.name : 'Error';
}

function requestMethod(request) {
  const method = String(request.method()).toUpperCase();
  return /^[A-Z]{1,12}$/.test(method) ? method : 'OTHER';
}

function responseMime(response) {
  const value = response.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value ?? '') ? value : null;
}

/** Redact all query values and all path segments that are not fixed route words. */
export function sanitizeObservedUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return '[non-web-url]';
    let privateParent = false;
    const path = url.pathname.split('/').map((segment, index) => {
      if (index === 0 || !segment) return segment;
      const safe = !privateParent && PUBLIC_PATH_SEGMENTS.has(segment.toLowerCase());
      privateParent ||= PRIVATE_PATH_PARENTS.test(segment);
      return safe ? segment.toLowerCase() : '[redacted]';
    }).join('/');
    return url.origin + (path || '/');
  } catch { return '[invalid-url]'; }
}

export function classifyOperationRequest(request) {
  const method = requestMethod(request);
  const rawType = String(request.resourceType());
  const resourceType = SAFE_RESOURCE_TYPES.has(rawType) ? rawType : 'other';
  let category = 'other';
  if (resourceType === 'websocket' || resourceType === 'eventsource') category = 'realtime';
  else if (!READ_METHODS.has(method)) category = 'write-risk';
  else if (ASSET_TYPES.has(resourceType)) category = 'asset';
  else if (resourceType === 'xhr' || resourceType === 'fetch') category = 'dynamic-data';
  else if (resourceType === 'document') category = 'document';
  return { method, resourceType, category };
}

async function readPageState(page) {
  let dom = null;
  let viewport = page.viewportSize();
  try {
    const observed = await page.evaluate(() => ({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      dom: {
        links: document.querySelectorAll('a[href]').length,
        buttons: document.querySelectorAll('button, [role="button"]').length,
        forms: document.forms.length,
        inputs: document.querySelectorAll('input, textarea, select').length,
        expanded: document.querySelectorAll('[aria-expanded="true"]').length,
      },
    }));
    dom = observed.dom;
    viewport ??= observed.viewport;
  } catch { /* Navigation may replace the document during observation. */ }
  return {
    url: sanitizeObservedUrl(page.url()),
    viewport,
    dom,
  };
}

function isSubmitControl(element) {
  const target = element.closest('button, input, [role="button"]') ?? element;
  const tag = target.tagName.toLowerCase();
  const type = (target.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'input') return ['submit', 'image', 'reset'].includes(type);
  if (tag === 'button') return type === 'submit' || (!type && !!target.form);
  return false;
}

async function runAction(page, action, { allowedOrigins, baseUrl, timeoutMs, allowUnsafeRequests }) {
  if (!action || typeof action !== 'object') throw new TypeError('invalid action');
  switch (action.type) {
    case 'navigate': {
      if (typeof action.url !== 'string' || action.url.length > 2_048) throw new TypeError('invalid navigation');
      let target;
      try { target = new URL(action.url, page.url() === 'about:blank' ? baseUrl : page.url()); }
      catch { throw new TypeError('invalid navigation'); }
      if (!['http:', 'https:'].includes(target.protocol) || !allowedOrigins.has(target.origin)) {
        return { status: 'blocked', reason: 'cross-origin-navigation' };
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      return { status: 'ok' };
    }
    case 'click': {
      if (typeof action.selector !== 'string' || !action.selector || action.selector.length > 512) {
        throw new TypeError('invalid selector');
      }
      const locator = page.locator(action.selector).first();
      if (!allowUnsafeRequests && await locator.evaluate(isSubmitControl, undefined, { timeout: timeoutMs })) {
        return { status: 'blocked', reason: 'submit-control' };
      }
      await locator.click({ timeout: timeoutMs });
      return { status: 'ok' };
    }
    case 'fill': {
      if (typeof action.selector !== 'string' || !action.selector || action.selector.length > 512
        || typeof action.value !== 'string' || action.value.length > 10_000) {
        throw new TypeError('invalid fill');
      }
      await page.locator(action.selector).first().fill(action.value, { timeout: timeoutMs });
      return { status: 'ok' };
    }
    case 'scroll': {
      if (!Number.isInteger(action.y) || Math.abs(action.y) > 10_000) throw new TypeError('invalid scroll');
      await page.mouse.wheel(0, action.y);
      return { status: 'ok' };
    }
    default: throw new TypeError('invalid action type');
  }
}

/**
 * @param {object} options
 * @param {import('playwright').Page} [options.page] Already authenticated page.
 * @param {import('playwright').BrowserContext} [options.context] Used to create a page if omitted.
 * @param {Array} options.actions Explicit navigate/click/fill/scroll operations.
 * @param {string} [options.baseUrl] Origin for the first relative navigate action; use
 *   the same relative script with source and offline-clone base URLs to replay it.
 * @param {string[]} [options.allowedOrigins] Defaults to current page or first navigate origin.
 */
export async function exploreOperationStates(options = {}) {
  const {
    context, actions, allowedOrigins: originInput, allowUnsafeRequests = false,
  } = options;
  if (!Array.isArray(actions)) throw new TypeError('actions must be an array');
  if (!options.page && !context?.newPage) throw new TypeError('page or context is required');
  if (options.page && context && options.page.context() !== context) throw new TypeError('page and context differ');
  if (options.onObservedRequest != null && typeof options.onObservedRequest !== 'function') {
    throw new TypeError('onObservedRequest must be a function');
  }

  const maxActions = boundedInteger(options.maxActions, 12, 100);
  const maxRequestsPerState = boundedInteger(options.maxRequestsPerState, 100, 500);
  const maxUnexecuted = boundedInteger(options.maxUnexecuted, 100, 500);
  const timeoutMs = boundedInteger(options.timeoutMs, 8_000, 30_000);
  const settleMs = boundedInteger(options.settleMs, 400, 5_000);
  const ownedPage = !options.page;
  const page = options.page ?? await context.newPage();
  const firstUrl = page.url() === 'about:blank'
    ? (() => { try { return new URL(actions[0]?.url, options.baseUrl).href; } catch { return null; } })()
    : page.url();
  const origin = (() => { try { return new URL(firstUrl).origin; } catch { return null; } })();
  const allowedOrigins = new Set(originInput ?? (origin ? [origin] : []));
  if (!allowedOrigins.size || [...allowedOrigins].some(value => {
    try { return new URL(value).origin !== value; } catch { return true; }
  })) {
    if (ownedPage) await page.close();
    throw new TypeError('a valid allowed origin is required');
  }

  const report = {
    version: 1,
    limits: { maxActions, maxRequestsPerState, settleMs, timeoutMs },
    policy: { allowUnsafeRequests: !!allowUnsafeRequests },
    states: [],
    unexecuted: [],
    summary: { planned: actions.length, executed: 0, unexecuted: 0, omittedUnexecuted: 0 },
  };
  let active = null;
  let current = null;
  const byRequest = new WeakMap();
  const rawUrlByEntry = new WeakMap();
  const omitted = new WeakSet();
  const makeBucket = () => ({ requests: [], omittedRequests: 0, pageErrors: [], blockedReasons: new Set() });
  const record = (request, outcome) => {
    if (omitted.has(request)) return null;
    let entry = byRequest.get(request);
    if (!entry && active) {
      if (active.requests.length >= maxRequestsPerState) {
        active.omittedRequests++;
        omitted.add(request);
        return null;
      }
      const detail = classifyOperationRequest(request);
      entry = {
        target: sanitizeObservedUrl(request.url()),
        scope: allowedOrigins.has(new URL(request.url()).origin) ? 'first-party' : 'external',
        ...detail,
        outcome: 'pending',
      };
      active.requests.push(entry);
      byRequest.set(request, entry);
      rawUrlByEntry.set(entry, request.url());
    }
    if (entry && outcome) entry.outcome = outcome;
    return entry;
  };
  const onRequest = request => { record(request); };
  const onResponse = response => {
    const entry = record(response.request());
    if (entry) {
      entry.status = response.status();
      entry.mime = responseMime(response);
      entry.outcome = response.status() >= 400 ? 'http-error' : 'response';
    }
  };
  const onRequestFinished = request => {
    const entry = record(request);
    if (entry && entry.outcome === 'response') entry.outcome = 'complete';
  };
  const onRequestFailed = request => {
    const entry = record(request);
    if (entry && entry.outcome !== 'blocked') entry.outcome = 'network-failed';
  };
  const onPageError = error => {
    if (active && active.pageErrors.length < 20) active.pageErrors.push(safeErrorType(error));
  };
  const onWebSocket = socket => {
    if (!active) return;
    if (active.requests.length >= maxRequestsPerState) { active.omittedRequests++; return; }
    const entry = {
      target: sanitizeObservedUrl(socket.url()),
      scope: allowedOrigins.has(new URL(socket.url()).origin) ? 'first-party' : 'external',
      method: 'GET', resourceType: 'websocket', category: 'realtime', outcome: 'opened',
    };
    active.requests.push(entry);
    rawUrlByEntry.set(entry, socket.url());
  };
  const routeHandler = async route => {
    const request = route.request();
    let blockedReason = null;
    if (!allowUnsafeRequests && !READ_METHODS.has(requestMethod(request))) blockedReason = 'write-risk-request';
    try {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()
        && !allowedOrigins.has(new URL(request.url()).origin)) blockedReason = 'cross-origin-navigation';
    } catch { /* A request without a frame is handled by the method guard. */ }
    if (blockedReason) {
      record(request, 'blocked');
      active?.blockedReasons.add(blockedReason);
      await route.abort('blockedbyclient');
    } else await route.fallback();
  };
  const capture = async (index, action, result) => {
    const bucket = current;
    const state = await readPageState(page);
    for (const request of bucket.requests) {
      options.onObservedRequest?.({ ...request, url: rawUrlByEntry.get(request) ?? null, stateIndex: index });
    }
    report.states.push({
      index,
      from: index ? index - 1 : null,
      action: action ? { index: index - 1, type: ['navigate', 'click', 'fill', 'scroll'].includes(action.type) ? action.type : 'invalid' } : null,
      result,
      ...state,
      requests: bucket.requests.map(request => ({ ...request })),
      omittedRequests: bucket.omittedRequests,
      pageErrors: [...bucket.pageErrors],
    });
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onRequestFinished);
  page.on('requestfailed', onRequestFailed);
  page.on('pageerror', onPageError);
  page.on('websocket', onWebSocket);
  try {
    await page.route('**/*', routeHandler);
    current = makeBucket(); active = current;
    await page.waitForTimeout(settleMs);
    await capture(0, null, { status: 'initial' });
    let stopReason = null;
    for (let i = 0; i < actions.length && i < maxActions; i++) {
      current = makeBucket(); active = current;
      let result;
      try { result = await runAction(page, actions[i], { allowedOrigins, baseUrl: options.baseUrl, timeoutMs, allowUnsafeRequests }); }
      catch (error) { result = { status: 'error', errorType: safeErrorType(error) }; }
      await page.waitForTimeout(settleMs);
      if (current.blockedReasons.size) {
        result = { status: 'blocked', reason: [...current.blockedReasons][0] };
      }
      await capture(i + 1, actions[i], result);
      report.summary.executed++;
      if (result.status !== 'ok') { stopReason = result.status === 'blocked' ? result.reason : 'previous-action-failed'; break; }
    }
    const remaining = actions.length - report.summary.executed;
    report.summary.unexecuted = remaining;
    report.summary.omittedUnexecuted = Math.max(0, remaining - maxUnexecuted);
    for (let i = report.summary.executed; i < Math.min(actions.length, report.summary.executed + maxUnexecuted); i++) {
      report.unexecuted.push({ index: i, type: ['navigate', 'click', 'fill', 'scroll'].includes(actions[i]?.type) ? actions[i].type : 'invalid', reason: stopReason ?? 'action-budget' });
    }
    return report;
  } finally {
    active = null;
    await page.unroute('**/*', routeHandler).catch(() => {});
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', onRequestFinished);
    page.off('requestfailed', onRequestFailed);
    page.off('pageerror', onPageError);
    page.off('websocket', onWebSocket);
    if (ownedPage) await page.close().catch(() => {});
  }
}
