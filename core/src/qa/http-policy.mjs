const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const verifiedBrowsers = new WeakSet();
const ownedPages = new WeakSet();
const originOf = value => { try { return new URL(value).origin; } catch { return null; } };

function trustedOrigins(site, login) {
  return new Set([site.origin, login?.origin ?? site.origin]);
}

export function browserContextOptions(login) {
  const { extraHTTPHeaders, ...options } = login?.contextOptions ?? {};
  return options;
}

export function qaBrowserLaunchOptions(login, headless = true) {
  return { headless, ...(login?.contextOptions?.extraHTTPHeaders ? { args: ['--site-per-process', '--enable-automation'] } : {}) };
}

async function requireSiteIsolation(context) {
  const browser = context.browser();
  if (verifiedBrowsers.has(browser)) return;
  const session = await browser.newBrowserCDPSession();
  try {
    const { arguments: args } = await session.send('Browser.getBrowserCommandLine');
    if (!args.includes('--site-per-process')) throw new Error('site isolation required');
    verifiedBrowsers.add(browser);
  } finally { await session.detach().catch(() => {}); }
}

export function scopedHeaders(login, site, url) {
  const configured = login?.contextOptions?.extraHTTPHeaders;
  if (!configured) return null;
  try {
    const origin = login.origin ?? site.origin;
    return new URL(url).origin === origin ? configured : null;
  } catch { return null; }
}

function trustedRequestFrame(request, site, login) {
  const origins = trustedOrigins(site, login);
  try {
    let frame = request.frame();
    if (!ownedPages.has(frame.page())) return false;
    while (frame) {
      if (!origins.has(originOf(frame.url()))) return false;
      frame = frame.parentFrame();
    }
    return true;
  } catch { return false; }
}

/** Header credentials are added per request, never to the browser context. */
export async function newQaPage(context, { site, login }) {
  const page = await context.newPage();
  ownedPages.add(page);
  const configured = login?.contextOptions?.extraHTTPHeaders;
  if (!configured) return page;
  try {
    await requireSiteIsolation(context);
    const session = await context.newCDPSession(page);
    const frames = new Map();
    const redirects = new Map();
    const origins = trustedOrigins(site, login);
    let rootId = null;
    let pristineRoot = true;
    session.on('Page.frameAttached', ({ frameId, parentFrameId }) => frames.set(frameId, { parentId: parentFrameId, url: null }));
    session.on('Page.frameNavigated', ({ frame }) => {
      frames.set(frame.id, { parentId: frame.parentId ?? null, url: frame.url });
      if (frame.id === rootId && frame.url !== 'about:blank') pristineRoot = false;
    });
    session.on('Page.frameDetached', ({ frameId }) => frames.delete(frameId));
    await session.send('Page.enable');
    const tree = await session.send('Page.getFrameTree');
    rootId = tree.frameTree.frame.id;
    const addFrame = node => {
      frames.set(node.frame.id, { parentId: node.frame.parentId ?? null, url: node.frame.url });
      for (const child of node.childFrames ?? []) addFrame(child);
    };
    addFrame(tree.frameTree);
    const trustedFrame = event => {
      let id = event.frameId;
      let first = true;
      let reachedRoot = false;
      while (id) {
        const frame = frames.get(id);
        if (!frame) return false;
        const blank = !frame.url || frame.url === 'about:blank';
        if (blank) {
          if (!first || event.resourceType !== 'Document' || (!frame.parentId && !(id === rootId && pristineRoot))) return false;
        } else if (!origins.has(originOf(frame.url))) return false;
        if (id === rootId) reachedRoot = true;
        first = false;
        id = frame.parentId;
      }
      return reachedRoot;
    };
    session.on('Fetch.requestPaused', event => {
      const currentOrigin = originOf(event.request.url);
      const cleanChain = (!event.redirectedRequestId || redirects.get(event.redirectedRequestId) === true) && origins.has(currentOrigin);
      redirects.set(event.requestId, cleanChain);
      if (redirects.size > 10000) redirects.delete(redirects.keys().next().value);
      const scoped = cleanChain && trustedFrame(event) ? scopedHeaders(login, site, event.request.url) : null;
      const headers = { ...event.request.headers };
      for (const [key, value] of Object.entries(configured)) {
        const existing = Object.keys(headers).find(name => name.toLowerCase() === key.toLowerCase());
        if (existing && String(headers[existing]) === String(value)) delete headers[existing];
        if (scoped) {
          if (existing) delete headers[existing];
          headers[key] = value;
        }
      }
      session.send('Fetch.continueRequest', { requestId: event.requestId,
        headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })) })
        .catch(() => session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'Failed' }).catch(() => {}));
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    return page;
  } catch {
    await context.close().catch(() => {});
    throw new Error('无法启用请求头凭据隔离或验证站点进程隔离，本次测试已停止');
  }
}

export async function routeQaRequest(route, { site, login, onBlocked = () => {} }) {
  const request = route.request();
  const method = request.method().toUpperCase();
  const isRead = READ_METHODS.has(method);
  let url;
  try { url = new URL(request.url()); } catch { /* reject non-read requests without a URL */ }
  const allow = site.writeAllow ?? [];
  const allowedWrite = site.writes === 'allow' || (method === 'POST' && url && allow.some(rule =>
    rule && typeof rule === 'object' && rule.method === method && rule.origin === url.origin && rule.path === url.pathname));
  if (!isRead && !allowedWrite) {
    onBlocked(request, 'not-allowed');
    return route.abort('blockedbyclient').catch(() => {});
  }
  const checkWriteRedirect = !isRead && site.writes !== 'allow';
  if (!checkWriteRedirect) return route.continue().catch(() => {});
  if (!trustedRequestFrame(request, site, login)) {
    onBlocked(request, 'untrusted-page');
    return route.abort('blockedbyclient').catch(() => {});
  }
  const scoped = scopedHeaders(login, site, request.url());
  let response;
  try {
    const headers = scoped ? { ...request.headers() } : undefined;
    for (const [key, value] of Object.entries(scoped ?? {})) headers[key.toLowerCase()] = value;
    // A fulfilled response keeps browser redirects from inheriting injected credentials.
    response = await route.fetch({ ...(headers ? { headers } : {}), maxRedirects: 0 });
    if (checkWriteRedirect && REDIRECTS.has(response.status())) {
      onBlocked(request, 'redirect');
      return await route.abort('blockedbyclient').catch(() => {});
    }
    return await route.fulfill({ response });
  } catch {
    return route.abort('failed').catch(() => {});
  } finally {
    await response?.dispose().catch(() => {});
  }
}

export async function requestQaLink(context, method, href, { site, login, timeout, maxRedirects = 5 }) {
  let current = href;
  let cleanChain = true;
  const origins = trustedOrigins(site, login);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    cleanChain = cleanChain && origins.has(originOf(current));
    const headers = cleanChain ? scopedHeaders(login, site, current) : null;
    const response = await context.request[method](current, { timeout, maxRedirects: 0, ...(headers ? { headers } : {}) }).catch(() => null);
    if (!response) return null;
    const status = response.status();
    const location = response.headers().location;
    if (!REDIRECTS.has(status) || !location) return response;
    await response.dispose().catch(() => {});
    if (hop === maxRedirects) return null;
    try {
      const next = new URL(location, current);
      if (!['http:', 'https:'].includes(next.protocol)) return null;
      current = next.href;
    } catch { return null; }
  }
  return null;
}
