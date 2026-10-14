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
    try {
      await Promise.race([
        Promise.allSettled([...pending]),
        new Promise(resolve => {
          timer = setTimeout(resolve, Math.max(1, deadlineAt - Date.now()));
        }),
      ]);
      deadlineReached();
    } finally {
      clearTimeout(timer);
    }
  }

  function summary() {
    return { ...counts };
  }

  return { observe, drain, summary };
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
