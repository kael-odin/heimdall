const MIME_ALIASES = new Map([
  ['application/javascript', 'text/javascript'],
  ['application/x-javascript', 'text/javascript'],
  ['image/vnd.microsoft.icon', 'image/x-icon'],
]);
const LOCALIZABLE_ASSETS = new Set(['script', 'stylesheet', 'image', 'font', 'media', 'texttrack', 'manifest']);

function dependencyClass(request) {
  if (request.category === 'write-risk' || request.category === 'realtime') return request.category;
  if (request.resourceType === 'xhr' || request.resourceType === 'fetch') return 'api';
  if (['script', 'stylesheet', 'image', 'font', 'media', 'texttrack', 'manifest'].includes(request.resourceType)) {
    return request.resourceType;
  }
  return request.resourceType === 'document' ? 'document' : 'other';
}

function normalizedMime(value) {
  const mime = typeof value === 'string' ? value.toLowerCase() : null;
  return MIME_ALIASES.get(mime) ?? mime;
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

/** Exact paths and query values remain only in these in-memory maps. */
export function createOperationDependencyEvidence(origin) {
  const base = new URL(origin).origin;
  const flows = new Map();
  const unverified = new Map();
  const external = new Map();
  return {
    origin: base, flows, unverified, external,
    observe(flowIndex, request) {
      if (!Number.isInteger(flowIndex) || flowIndex < 0 || typeof request !== 'object') {
        throw new TypeError('invalid operation dependency');
      }
      const kind = dependencyClass(request);
      let url;
      try { url = new URL(request.url); } catch { url = null; }
      if (!url || !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        increment(unverified, flowIndex);
        return;
      }
      const scope = url.origin === base ? 'first-party' : 'external';
      if (scope === 'external') increment(external, flowIndex);
      if (request.outcome === 'complete' && (!Number.isInteger(request.status) || !request.mime)) {
        increment(unverified, flowIndex);
      }
      const target = scope === 'first-party' ? url.pathname + url.search : url.origin + url.pathname + url.search;
      const key = JSON.stringify([kind, request.method, request.resourceType, scope, target]);
      const signature = JSON.stringify([request.outcome, request.status ?? null, normalizedMime(request.mime)]);
      const flow = flows.get(flowIndex) ?? new Map();
      const group = flow.get(key) ?? { kind, signatures: new Map() };
      increment(group.signatures, signature);
      flow.set(key, group);
      flows.set(flowIndex, flow);
    },
  };
}

function classRow(rows, kind) {
  return rows[kind] ??= {
    source: 0, bundle: 0, missing: 0, unexpected: 0, responseMismatch: 0,
    outcomeMismatch: 0, statusMismatch: 0, mimeMismatch: 0, variantMismatch: 0,
  };
}

function totalSignatures(group) {
  return [...group.signatures.values()].reduce((sum, count) => sum + count, 0);
}

function exactAssetUrlMap(value, sourceOrigin, bundleOrigin) {
  if (value == null) return new Map();
  if (!(value instanceof Map)) throw new TypeError('assetUrlMap must be a Map');
  const result = new Map();
  for (const [from, to] of value) {
    if (typeof from !== 'string' || typeof to !== 'string') throw new TypeError('invalid asset URL mapping');
    let sourceUrl, bundleUrl;
    try {
      sourceUrl = new URL(from);
      bundleUrl = new URL(to, bundleOrigin);
    } catch { throw new TypeError('invalid asset URL mapping'); }
    if (!['http:', 'https:'].includes(sourceUrl.protocol) || sourceUrl.origin === sourceOrigin
      || sourceUrl.hash || sourceUrl.username || sourceUrl.password
      || !['http:', 'https:'].includes(bundleUrl.protocol) || bundleUrl.origin !== bundleOrigin
      || bundleUrl.hash || bundleUrl.username || bundleUrl.password) {
      throw new TypeError('invalid asset URL mapping');
    }
    result.set(sourceUrl.href, bundleUrl.pathname + bundleUrl.search);
  }
  return result;
}

function mappedSourceFlow(expected, assetUrlMap) {
  const mapped = new Map();
  let localizedExternal = 0;
  for (const [key, group] of expected) {
    const [kind, method, resourceType, scope, target] = JSON.parse(key);
    const localPath = scope === 'external' && (method === 'GET' || method === 'HEAD')
      && LOCALIZABLE_ASSETS.has(kind) ? assetUrlMap.get(target) : null;
    const mappedKey = localPath
      ? JSON.stringify([kind, method, resourceType, 'first-party', localPath]) : key;
    if (localPath) localizedExternal += totalSignatures(group);
    const merged = mapped.get(mappedKey) ?? { kind, signatures: new Map() };
    for (const [signature, count] of group.signatures) increment(merged.signatures, signature, count);
    mapped.set(mappedKey, merged);
  }
  return { mapped, localizedExternal };
}

function mappedBundleFlow(actual, assetUrlMap) {
  const aliases = new Map();
  for (const localPath of assetUrlMap.values()) {
    const match = /^\/lm\/[^/]+(\/_ext\/.+)$/.exec(localPath);
    if (!match) continue;
    const alias = match[1];
    aliases.set(alias, aliases.has(alias) && aliases.get(alias) !== localPath ? null : localPath);
  }
  if (!aliases.size) return actual;
  const mapped = new Map();
  for (const [key, group] of actual) {
    const [kind, method, resourceType, scope, target] = JSON.parse(key);
    const canonical = scope === 'first-party' && (method === 'GET' || method === 'HEAD')
      && LOCALIZABLE_ASSETS.has(kind) ? aliases.get(target) : null;
    const mappedKey = canonical
      ? JSON.stringify([kind, method, resourceType, scope, canonical]) : key;
    const merged = mapped.get(mappedKey) ?? { kind, signatures: new Map() };
    for (const [signature, count] of group.signatures) increment(merged.signatures, signature, count);
    mapped.set(mappedKey, merged);
  }
  return mapped;
}

/** Compare exact request identity, status and MIME; response body parity is checked separately for approved GET data. */
export function compareOperationDependencyEvidence(source, bundle, flowCount, { assetUrlMap } = {}) {
  if (!source?.flows || !bundle?.flows || !source.origin || !bundle.origin
    || !Number.isInteger(flowCount) || flowCount < 0 || flowCount > 100) {
    throw new TypeError('invalid operation dependency comparison');
  }
  const localAssets = exactAssetUrlMap(assetUrlMap, source.origin, bundle.origin);
  const report = {
    status: 'checked', checkedFlows: flowCount, matchedFlows: 0, mismatchedFlows: 0,
    source: 0, bundle: 0, missing: 0, unexpected: 0, responseMismatch: 0,
    outcomeMismatch: 0, statusMismatch: 0, mimeMismatch: 0, variantMismatch: 0,
    sourceExternal: 0, localizedExternal: 0, unmappedExternal: 0, unverified: 0, flows: [],
  };
  for (let index = 0; index < flowCount; index++) {
    const sourceFlow = source.flows.get(index) ?? new Map();
    const { mapped: expected, localizedExternal } = mappedSourceFlow(sourceFlow, localAssets);
    const actual = mappedBundleFlow(bundle.flows.get(index) ?? new Map(), localAssets);
    const flow = {
      index, source: 0, bundle: 0, missing: 0, unexpected: 0, responseMismatch: 0,
      outcomeMismatch: 0, statusMismatch: 0, mimeMismatch: 0, variantMismatch: 0,
      sourceExternal: source.external.get(index) ?? 0,
      localizedExternal,
      unmappedExternal: (source.external.get(index) ?? 0) - localizedExternal,
      unverified: (source.unverified.get(index) ?? 0) + (bundle.unverified.get(index) ?? 0),
      classes: {},
    };
    for (const [key, sourceGroup] of expected) {
      const row = classRow(flow.classes, sourceGroup.kind);
      const count = totalSignatures(sourceGroup);
      row.source += count;
      flow.source += count;
      const bundleGroup = actual.get(key);
      if (!bundleGroup) {
        row.missing += count;
        flow.missing += count;
        continue;
      }
      const sourceOnly = new Map(sourceGroup.signatures);
      const bundleOnly = new Map(bundleGroup.signatures);
      for (const [signature, sourceCount] of sourceOnly) {
        const common = Math.min(sourceCount, bundleOnly.get(signature) ?? 0);
        sourceOnly.set(signature, sourceCount - common);
        bundleOnly.set(signature, (bundleOnly.get(signature) ?? 0) - common);
      }
      const sourceLeft = [...sourceOnly.values()].reduce((sum, n) => sum + n, 0);
      const bundleLeft = [...bundleOnly.values()].reduce((sum, n) => sum + n, 0);
      const mismatch = Math.max(sourceLeft, bundleLeft);
      row.responseMismatch += mismatch;
      flow.responseMismatch += mismatch;
      if (mismatch && sourceGroup.signatures.size === 1 && bundleGroup.signatures.size === 1) {
        const [sourceOutcome, sourceStatus, sourceMime] = JSON.parse([...sourceGroup.signatures.keys()][0]);
        const [bundleOutcome, bundleStatus, bundleMime] = JSON.parse([...bundleGroup.signatures.keys()][0]);
        for (const [field, changed] of [
          ['outcomeMismatch', sourceOutcome !== bundleOutcome],
          ['statusMismatch', sourceStatus !== bundleStatus],
          ['mimeMismatch', sourceMime !== bundleMime],
        ]) {
          if (changed) { row[field] += mismatch; flow[field] += mismatch; }
        }
        if (sourceOutcome === bundleOutcome && sourceStatus === bundleStatus && sourceMime === bundleMime) {
          row.variantMismatch += mismatch;
          flow.variantMismatch += mismatch;
        }
      } else if (mismatch) {
        row.variantMismatch += mismatch;
        flow.variantMismatch += mismatch;
      }
    }
    for (const [key, bundleGroup] of actual) {
      const row = classRow(flow.classes, bundleGroup.kind);
      const count = totalSignatures(bundleGroup);
      row.bundle += count;
      flow.bundle += count;
      if (!expected.has(key)) {
        row.unexpected += count;
        flow.unexpected += count;
      }
    }
    for (const field of ['source', 'bundle', 'missing', 'unexpected', 'responseMismatch',
      'outcomeMismatch', 'statusMismatch', 'mimeMismatch', 'variantMismatch',
      'sourceExternal', 'localizedExternal', 'unmappedExternal', 'unverified']) {
      report[field] += flow[field];
    }
    if (flow.missing || flow.unexpected || flow.responseMismatch || flow.unmappedExternal || flow.unverified) {
      report.mismatchedFlows++;
    } else report.matchedFlows++;
    report.flows.push(flow);
  }
  return report;
}
