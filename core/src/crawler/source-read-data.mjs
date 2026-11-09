import { createHash } from 'node:crypto';
import { isSafeReadOnlyGetUrl, sanitizeHar } from '../live/har.mjs';

const DATA_MIME = /^(?:application\/(?:[a-z0-9.+-]+\+)?json|text\/plain)(?:\s*;|$)/i;
const MAX_URLS = 100;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * MAX_BODY_BYTES;
const MAX_RESPONSES = 200;
const BODY_TIMEOUT_MS = 5_000;
const CAPTURE_TIMEOUT_MS = 30_000;

function headersArray(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

function projectedHeaders(headers, response = false) {
  const result = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const key = name.toLowerCase();
    if (!response) result[key] = '';
    else if (['content-type', 'content-length', 'content-encoding', 'cache-control', 'vary'].includes(key)) result[key] = String(value);
    else if (key === 'set-cookie') result[key] = '';
  }
  return result;
}

function responseHeaders(item) {
  const headers = { ...item.responseHeaders, ...item.responseExtra };
  for (const name of ['cache-control', 'vary']) {
    headers[name] = [item.responseHeaders?.[name], item.responseExtra?.[name]].filter(Boolean).join(', ');
  }
  return headers;
}

/** Read only the CDP response tied to an observed request, never Playwright's refetch fallback. */
export async function observeReadOnlyPage(page, { collector, urls, flowIndex }) {
  if (!urls.length) return null;
  const approved = new Set(urls.map(url => new URL(url).href));
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Network.enable', { maxTotalBufferSize: MAX_TOTAL_BYTES, maxResourceBufferSize: MAX_BODY_BYTES });
  } catch (error) {
    await session.detach().catch(() => {});
    throw error;
  }
  const records = new Map();
  const ignored = new Set();
  const redirects = new Set();
  const browserCounts = new Map();
  const protocolCounts = new Map();
  let closed = false;
  let trackingOverflow = false;
  const count = (map, url) => map.set(url, (map.get(url) ?? 0) + 1);
  const track = (set, id) => {
    if (set.size >= MAX_RESPONSES * 4 && !set.has(id)) trackingOverflow = true;
    else set.add(id);
  };
  const onResponse = response => {
    if (approved.has(response.url()) && response.request().method() === 'GET') count(browserCounts, response.url());
  };
  page.context().on('response', onResponse);
  const record = id => {
    if (!records.has(id)) {
      if (records.size >= MAX_RESPONSES * 4) { trackingOverflow = true; return null; }
      records.set(id, {});
    }
    return records.get(id);
  };
  const notify = item => { if (item?.notify) item.notify(); };
  session.on('Network.requestWillBeSent', event => {
    const id = event.requestId;
    if (event.redirectResponse) track(redirects, id);
    const request = event.request;
    if (request.method !== 'GET' || !approved.has(request.url)) {
      records.delete(id);
      track(ignored, id);
      return;
    }
    ignored.delete(id);
    const item = record(id);
    if (!item) return;
    item.url = request.url;
    item.requestHeaders = projectedHeaders(request.headers);
    item.hasPostData = !!(request.hasPostData || request.postData);
    item.redirected = redirects.has(id);
    notify(item);
  });
  session.on('Network.requestWillBeSentExtraInfo', event => {
    if (ignored.has(event.requestId)) return;
    const item = record(event.requestId);
    if (!item) return;
    item.requestExtra = projectedHeaders(event.headers);
    notify(item);
  });
  session.on('Network.requestServedFromCache', event => {
    if (ignored.has(event.requestId)) return;
    const item = record(event.requestId);
    if (item) item.cached = true;
  });
  session.on('Network.responseReceived', event => {
    const item = records.get(event.requestId);
    if (!item?.url) return;
    item.status = event.response.status;
    item.responseUrl = event.response.url;
    item.responseHeaders = projectedHeaders(event.response.headers, true);
    item.hasExtraInfo = event.hasExtraInfo;
    item.cached ||= !!(event.response.fromDiskCache || event.response.fromServiceWorker || event.response.fromPrefetchCache);
    notify(item);
  });
  session.on('Network.responseReceivedExtraInfo', event => {
    if (ignored.has(event.requestId)) return;
    const item = record(event.requestId);
    if (!item) return;
    item.responseExtra = projectedHeaders(event.headers, true);
    item.extraStatus = event.statusCode;
    notify(item);
  });
  const forget = id => { records.delete(id); ignored.delete(id); redirects.delete(id); };
  session.on('Network.loadingFailed', event => forget(event.requestId));
  session.on('Network.loadingFinished', event => {
    if (closed) return;
    const id = event.requestId;
    const item = records.get(id);
    if (!item?.url || !Number.isInteger(item.status)) { forget(id); return; }
    count(protocolCounts, item.url);
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('response headers unavailable')), BODY_TIMEOUT_MS);
      item.notify = () => {
        if (item.redirected || item.cached || item.hasExtraInfo === false || item.responseUrl !== item.url) {
          clearTimeout(timer);
          reject(new Error('response provenance unavailable'));
        } else if (item.requestExtra && item.responseExtra) {
          clearTimeout(timer);
          if (item.extraStatus !== item.status) reject(new Error('response status unavailable'));
          else resolve();
        }
      };
      item.notify();
    });
    const request = {
      method: () => 'GET',
      postData: () => item.hasPostData ? '[redacted]' : null,
      allHeaders: async () => { await ready; return { ...item.requestHeaders, ...item.requestExtra }; },
    };
    collector.observe({
      url: () => item.url,
      status: () => item.status,
      request: () => request,
      allHeaders: async () => { await ready; return responseHeaders(item); },
      body: async () => {
        await ready;
        const body = await session.send('Network.getResponseBody', { requestId: id });
        return Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
      },
    }, flowIndex);
    void ready.then(() => forget(id), () => forget(id));
  });
  return {
    async close() {
      if (closed) return;
      await collector.drain();
      closed = true;
      page.context().off('response', onResponse);
      for (const url of approved) collector.noteObservationMismatch(browserCounts.get(url) ?? 0, protocolCounts.get(url) ?? 0);
      if (trackingOverflow) collector.noteObservationMismatch(0, 1);
      await session.detach().catch(() => {});
    },
  };
}

async function timedBody(response, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      response.body(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('response body timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Captures only sanitizer-approved response bodies; raw headers and bodies never enter the report. */
export function sourceReadDataCollector({ origin, urls = [], onEntry,
  onAccepted,
  captureTimeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  if (!Array.isArray(urls) || urls.length > MAX_URLS || (urls.length && typeof onEntry !== 'function')) {
    throw new TypeError('invalid source read-only data options');
  }
  if (onAccepted != null && typeof onAccepted !== 'function') {
    throw new TypeError('invalid source read-only data observer');
  }
  if (!Number.isInteger(captureTimeoutMs) || captureTimeoutMs < 1 || captureTimeoutMs > CAPTURE_TIMEOUT_MS) {
    throw new TypeError('invalid source read-only data timeout');
  }
  const approved = new Set();
  for (const value of urls) {
    if (typeof value !== 'string' || !isSafeReadOnlyGetUrl(value, origin)) {
      throw new TypeError('unsafe source read-only data URL');
    }
    approved.add(new URL(value).href);
  }

  const delivered = new Map();
  const inFlight = new Map();
  const pending = new Set();
  const counts = { observed: 0, accepted: 0, rejected: 0, oversized: 0, failed: 0 };
  let attempts = 0;
  let acceptedBytes = 0;
  let deadlineAt = 0;
  let expired = false;

  function expire() {
    if (expired) return;
    expired = true;
    counts.failed += pending.size;
  }

  function deadlineReached() {
    if (expired) return true;
    if (deadlineAt && Date.now() >= deadlineAt) {
      expire();
      return true;
    }
    return false;
  }

  async function capture(response, url, flowIndex) {
    if (deadlineReached()) return;
    try {
      const status = response.status();
      const responseHeaders = await response.allHeaders();
      if (deadlineReached()) return;
      const mimeType = responseHeaders['content-type'] ?? '';
      const contentLength = Number(responseHeaders['content-length']);
      if (status < 200 || status >= 300 || !DATA_MIME.test(mimeType)) {
        counts.rejected++;
        return;
      }
      if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        counts.oversized++;
        return;
      }
      const body = await timedBody(response, Math.min(BODY_TIMEOUT_MS, Math.max(1, deadlineAt - Date.now())));
      if (deadlineReached()) return;
      if (body.length > MAX_BODY_BYTES) {
        counts.oversized++;
        return;
      }
      const request = response.request();
      const requestHeaders = await request.allHeaders();
      if (deadlineReached()) return;
      const raw = {
        request: { method: 'GET', url, headers: headersArray(requestHeaders),
          ...(request.postData() ? { postData: request.postData() } : {}) },
        response: { status, headers: headersArray(responseHeaders),
          content: { mimeType, text: body.toString('base64'), encoding: 'base64' } },
      };
      const sanitized = sanitizeHar({ log: { entries: [raw] } }, {
        readOnlyOrigin: origin, readOnlyGetUrls: [url],
      });
      if (deadlineReached()) return;
      const entry = sanitized.entries.find(item => item.kind === 'public-read-only-data');
      if (!entry) {
        counts.rejected++;
        return;
      }
      const fingerprint = createHash('sha256')
        .update(String(entry.status)).update('\0').update(entry.mimeType).update('\0').update(entry.body)
        .digest('hex');
      if (deadlineReached()) return;
      if (delivered.get(url) === fingerprint) {
        onAccepted?.(entry, flowIndex);
        counts.accepted++;
        return;
      }
      if (acceptedBytes + body.length > MAX_TOTAL_BYTES) {
        counts.oversized++;
        return;
      }
      acceptedBytes += body.length;
      try {
        await onEntry(entry);
        if (deadlineReached()) {
          acceptedBytes -= body.length;
          return;
        }
        delivered.set(url, fingerprint);
        onAccepted?.(entry, flowIndex);
        counts.accepted++;
      } catch {
        acceptedBytes -= body.length;
        if (!deadlineReached()) counts.failed++;
      }
    } catch {
      if (!deadlineReached()) counts.failed++;
    }
  }

  function observe(response, flowIndex) {
    if (!approved.size) return;
    const url = response.url();
    if (!approved.has(url) || response.request().method().toUpperCase() !== 'GET') return;
    counts.observed++;
    if (!deadlineAt) deadlineAt = Date.now() + captureTimeoutMs;
    if (deadlineReached()) {
      counts.failed++;
      return;
    }
    if (attempts >= MAX_RESPONSES) {
      counts.failed++;
      return;
    }
    attempts++;
    const previous = inFlight.get(url) ?? Promise.resolve();
    const task = previous.then(() => capture(response, url, flowIndex));
    inFlight.set(url, task);
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
      if (inFlight.get(url) === task) inFlight.delete(url);
    });
  }

  async function drain() {
    if (!pending.size || deadlineReached()) return;
    let timer;
    let timedOut = false;
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise(resolve => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, Math.max(1, deadlineAt - Date.now()));
        }),
      ]);
      if (timedOut) expire();
      else deadlineReached();
    } finally {
      clearTimeout(timer);
    }
  }

  function summary() {
    return { ...counts };
  }

  function noteObservationMismatch(browserCount, protocolCount) {
    counts.observed += Math.max(0, browserCount - protocolCount);
    counts.failed += Math.abs(browserCount - protocolCount);
  }

  return { observe, drain, summary, noteObservationMismatch };
}

/** Exact URLs and fingerprints stay in memory; comparison returns counts only. */
export function addReadOnlyFlowEvidence(evidence, flowIndex, entry, url = entry.url) {
  if (!(evidence instanceof Map) || !Number.isInteger(flowIndex) || flowIndex < 0
    || typeof url !== 'string' || typeof entry?.body !== 'string') {
    throw new TypeError('invalid read-only flow evidence');
  }
  const flow = evidence.get(flowIndex) ?? new Map();
  const signatures = flow.get(url) ?? new Set();
  const bodyHash = createHash('sha256').update(Buffer.from(entry.body, 'base64')).digest('hex');
  signatures.add(JSON.stringify([entry.status, entry.mimeType, bodyHash]));
  flow.set(url, signatures);
  evidence.set(flowIndex, flow);
}

export function compareReadOnlyFlowEvidence(source, offline, flowCount) {
  if (!(source instanceof Map) || !(offline instanceof Map)
    || !Number.isInteger(flowCount) || flowCount < 0 || flowCount > 100) {
    throw new TypeError('invalid read-only flow comparison');
  }
  const result = {
    status: 'checked', checkedFlows: flowCount, matchedFlows: 0, mismatchedFlows: 0,
    missing: 0, unexpected: 0, responseMismatch: 0,
    statusMismatch: 0, mimeMismatch: 0, bodyMismatch: 0, variantMismatch: 0,
    flows: [],
  };
  for (let index = 0; index < flowCount; index++) {
    const expected = source.get(index) ?? new Map();
    const actual = offline.get(index) ?? new Map();
    const flow = { index, missing: 0, unexpected: 0, responseMismatch: 0 };
    for (const [url, signatures] of expected) {
      const observed = actual.get(url);
      if (!observed) {
        flow.missing++;
      } else if (signatures.size !== observed.size
        || [...signatures].some(signature => !observed.has(signature))) {
        flow.responseMismatch++;
        if (signatures.size === 1 && observed.size === 1) {
          const [sourceStatus, sourceMime, sourceBody] = JSON.parse([...signatures][0]);
          const [offlineStatus, offlineMime, offlineBody] = JSON.parse([...observed][0]);
          if (sourceStatus !== offlineStatus) result.statusMismatch++;
          if (sourceMime !== offlineMime) result.mimeMismatch++;
          if (sourceBody !== offlineBody) result.bodyMismatch++;
        } else result.variantMismatch++;
      }
    }
    for (const url of actual.keys()) if (!expected.has(url)) flow.unexpected++;
    result.missing += flow.missing;
    result.unexpected += flow.unexpected;
    result.responseMismatch += flow.responseMismatch;
    if (flow.missing || flow.unexpected || flow.responseMismatch) result.mismatchedFlows++;
    else result.matchedFlows++;
    result.flows.push(flow);
  }
  return result;
}
