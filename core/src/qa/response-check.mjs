/** Passive, bounded observation of explicitly declared main-frame responses. */
import { isSafeReadOnlyGetUrl } from '../live/har.mjs';

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSES = 10;
const STATES = {
  matched: '符合声明', missing: '未观察到请求', ambiguous: '观察到多个同名请求',
  pending: '请求未完成', 'request-failed': '请求失败或被拦截', redirect: '请求发生重定向',
  'response-unavailable': '没有可核实的响应', 'http-mismatch': 'HTTP 状态不符合声明',
  cached: '缓存响应无法核实大小', encoded: '压缩响应未读取', 'not-json': '响应不是 JSON',
  'size-unavailable': '无法核实响应大小', 'too-large': '响应超过读取上限',
  'body-unavailable': '响应正文无法读取', 'invalid-json': '响应不是有效 JSON',
  'field-missing': '声明的字段不存在或不是标量', 'json-mismatch': '字段值不符合声明',
};
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { const error = new Error(message); error.code = 'invalid_args'; throw error; };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function keys(value, allowed, label) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown !== undefined) fail(`${label} 不支持字段 ${unknown}`);
}

function responseUrl(spec) {
  const url = new URL(spec.path, spec.origin);
  if (spec.query) url.search = new URLSearchParams(spec.query).toString();
  return url.href;
}

function requestKey(method, value) {
  const url = new URL(value);
  url.searchParams.sort();
  return `${method} ${url.href}`;
}

export function normalizeResponses(raw, label) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_RESPONSES) fail(`${label}.responses 应为 1 到 ${MAX_RESPONSES} 项`);
  const seen = new Set();
  return raw.map((response, index) => {
    const item = `${label}.responses[${index}]`;
    if (!object(response)) fail(`${item} 应为对象`);
    keys(response, ['method', 'origin', 'path', 'query', 'status', 'json'], item);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(response.method)) fail(`${item}.method 只能是 GET / POST / PUT / PATCH / DELETE`);
    let url;
    try { url = new URL(response.origin); } catch { fail(`${item}.origin 应为完整 HTTP 来源`); }
    if (typeof response.origin !== 'string' || response.origin.length > 500 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || /[?#]/.test(response.origin)) fail(`${item}.origin 只能包含协议、主机和端口`);
    const path = response.path;
    if (typeof path !== 'string' || path.length > 500 || !path.startsWith('/') || path.includes('//') || /[\\?#%\x00-\x20\x7f]/.test(path)
      || new URL(path, 'http://example.invalid').pathname !== path) fail(`${item}.path 应为不含查询、编码或特殊路径段的精确路径`);
    let query;
    if (response.query !== undefined) {
      if (response.method !== 'GET' || !object(response.query)) fail(`${item}.query 只能用于公开 GET，且应为字符串键值对象`);
      const pairs = Object.entries(response.query);
      if (!pairs.length || pairs.length > 20 || pairs.some(([, value]) => typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value))) {
        fail(`${item}.query 应包含 1 到 20 个无控制字符的字符串值`);
      }
      query = Object.fromEntries(pairs);
      if (!isSafeReadOnlyGetUrl(responseUrl({ origin: url.origin, path, query }), url.origin)) fail(`${item}.query 不符合公开只读 URL 边界`);
    }
    const status = response.status === undefined ? 200 : response.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) fail(`${item}.status 应为 HTTP 状态码`);
    let json;
    if (response.json !== undefined) {
      const checks = Array.isArray(response.json) ? response.json : [response.json];
      if (!checks.length || checks.length > 20) fail(`${item}.json 应为一个对象或 1 到 20 项断言数组`);
      const paths = new Set();
      const normalized = Array.from(checks, (check, index) => {
        const label = `${item}.json[${index}]`;
        if (!object(check)) fail(`${label} 应为对象`);
        keys(check, ['path', 'equals'], label);
        if (!Array.isArray(check.path) || !check.path.length || check.path.length > 8
          || Array.from(check.path).some(key => typeof key !== 'string' || !key || key.length > 100 || /[\x00-\x1f\x7f]/.test(key))) {
          fail(`${label}.path 应为 1 到 8 个字段名`);
        }
        const value = check.equals;
        if (!own(check, 'equals') || !(value === null || ['string', 'number', 'boolean'].includes(typeof value))
          || (typeof value === 'number' && !Number.isFinite(value)) || (typeof value === 'string' && value.length > 200)) {
          fail(`${label}.equals 应为有限的标量值`);
        }
        const key = JSON.stringify(check.path);
        if (paths.has(key)) fail(`${label}.path 与其他 JSON 断言重复`);
        paths.add(key);
        return { path: check.path, equals: value };
      });
      json = Array.isArray(response.json) ? normalized : normalized[0];
    }
    const key = requestKey(response.method, responseUrl({ origin: url.origin, path, query }));
    if (seen.has(key)) fail(`${item} 与其他 responses 重复`);
    seen.add(key);
    return { method: response.method, origin: url.origin, path, status, ...(query ? { query } : {}), ...(json ? { json } : {}) };
  });
}

function headersOf(headers) {
  return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function resultOf(entry) {
  const state = entry.count > 1 ? 'ambiguous' : !entry.count ? 'missing' : entry.request.state;
  const failedJsonIndex = ['field-missing', 'json-mismatch'].includes(state) ? entry.request.failedJsonIndex : null;
  return { method: entry.spec.method, origin: entry.spec.origin, path: entry.spec.path,
    ...(entry.spec.query ? { queryParams: Object.keys(entry.spec.query).sort() } : {}),
    state, http: entry.request?.http ?? null,
    detail: (STATES[state] ?? STATES.pending) + (Number.isInteger(failedJsonIndex) ? `（JSON 断言 ${failedJsonIndex + 1}）` : ''),
    ...(Number.isInteger(failedJsonIndex) ? { failedJsonIndex } : {}) };
}

export async function observeResponses(page, specs) {
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('Network.enable', { maxTotalBufferSize: MAX_BODY_BYTES * MAX_RESPONSES, maxResourceBufferSize: MAX_BODY_BYTES });
    await session.send('Page.enable');
  } catch {
    await session?.detach().catch(() => {});
    throw new Error('无法启用接口响应观察');
  }
  let mainFrame;
  try { mainFrame = (await session.send('Page.getFrameTree')).frameTree.frame.id; }
  catch { await session.detach().catch(() => {}); throw new Error('无法确认主页面'); }
  const entries = specs.map(spec => ({ spec, count: 0, request: null }));
  const byKey = new Map(entries.map(entry => [requestKey(entry.spec.method, responseUrl(entry.spec)), entry]));
  const requests = new Map();
  session.on('Page.frameNavigated', event => { if (!event.frame.parentId) mainFrame = event.frame.id; });
  session.on('Network.requestWillBeSent', event => {
    const previous = requests.get(event.requestId);
    if (previous && event.redirectResponse) previous.request.state = 'redirect';
    if (event.frameId !== mainFrame) return;
    let url;
    try { url = new URL(event.request.url); } catch { return; }
    if (event.request.url.includes('#') || (event.request.url.includes('?') && !url.searchParams.size)) return;
    const entry = byKey.get(requestKey(event.request.method, url.href));
    if (!entry) return;
    entry.count = Math.min(2, entry.count + 1);
    if (entry.count > 1) return;
    entry.request = { state: event.redirectResponse ? 'redirect' : 'pending', http: null, headers: {}, cached: false };
    requests.set(event.requestId, entry);
  });
  session.on('Network.requestServedFromCache', event => {
    const entry = requests.get(event.requestId);
    if (entry) entry.request.cached = true;
  });
  session.on('Network.responseReceived', event => {
    const entry = requests.get(event.requestId);
    if (!entry || entry.request.state !== 'pending') return;
    entry.request.http = event.response.status;
    entry.request.headers = headersOf(event.response.headers);
    entry.request.cached ||= !!(event.response.fromDiskCache || event.response.fromServiceWorker || event.response.fromPrefetchCache);
    if (event.response.status >= 300 && event.response.status < 400) entry.request.state = 'redirect';
  });
  session.on('Network.loadingFailed', event => {
    const entry = requests.get(event.requestId);
    if (!entry || entry.request.state !== 'pending') return;
    // Chromium may discard an already received 204's empty Fetch body as ERR_ABORTED.
    const noContent = entry.request.http === 204 && entry.spec.status === 204 && !entry.spec.json && !entry.request.cached
      && event.canceled === true && event.errorText === 'net::ERR_ABORTED' && !event.corsErrorStatus && !event.blockedReason;
    entry.request.state = noContent ? 'matched' : 'request-failed';
  });
  session.on('Network.loadingFinished', event => {
    const entry = requests.get(event.requestId);
    if (!entry || entry.request.state !== 'pending') return;
    const req = entry.request, spec = entry.spec;
    if (req.http === null) { req.state = 'response-unavailable'; return; }
    if (req.cached) { req.state = 'cached'; return; }
    if (req.http !== spec.status) { req.state = 'http-mismatch'; return; }
    if (!spec.json) { req.state = 'matched'; return; }
    if (req.headers['content-encoding'] && req.headers['content-encoding'].toLowerCase() !== 'identity') { req.state = 'encoded'; return; }
    if (!/^(?:application\/json|application\/[^;\s]+\+json)(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) { req.state = 'not-json'; return; }
    if (!Number.isFinite(event.encodedDataLength) || event.encodedDataLength <= 0) { req.state = 'size-unavailable'; return; }
    if (event.encodedDataLength > MAX_BODY_BYTES) { req.state = 'too-large'; return; }
    session.send('Network.getResponseBody', { requestId: event.requestId }).then(result => {
      const length = result.base64Encoded ? Buffer.byteLength(result.body, 'base64') : Buffer.byteLength(result.body, 'utf8');
      if (length > MAX_BODY_BYTES) { req.state = 'too-large'; return; }
      const bytes = Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
      let body;
      try { body = JSON.parse(bytes.toString('utf8')); } catch { req.state = 'invalid-json'; return; }
      const checks = Array.isArray(spec.json) ? spec.json : [spec.json];
      for (const [index, check] of checks.entries()) {
        req.failedJsonIndex = index;
        let value = body;
        for (const key of check.path) {
          if (!value || typeof value !== 'object' || !own(value, key)) { req.state = 'field-missing'; return; }
          value = value[key];
        }
        if (!(value === null || ['string', 'number', 'boolean'].includes(typeof value))) { req.state = 'field-missing'; return; }
        if (value !== check.equals) { req.state = 'json-mismatch'; return; }
      }
      delete req.failedJsonIndex;
      req.state = 'matched';
    }).catch(() => { req.state = 'body-unavailable'; });
  });
  return {
    async finish(timeout) {
      const deadline = Date.now() + Math.max(0, Math.min(Number(timeout) || 0, 10_000));
      while (Date.now() < deadline && entries.some(entry => !entry.count || (entry.count === 1 && entry.request.state === 'pending'))) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return entries.map(resultOf);
    },
    async close() { await session.detach().catch(() => {}); },
  };
}
