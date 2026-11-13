import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeReadOnlyGetUrl } from './har.mjs';

const MAX_URLS = 100;
const MAX_BINARY_URLS = 25;

/** A workspace-only allowlist for public, read-only GET response bodies. */
export function readDataPlan(baseDir, origin, { includeBinary = false } = {}) {
  let source;
  try { source = readFileSync(join(baseDir, 'read-data-plan.json'), 'utf8'); }
  catch (error) {
    return error?.code === 'ENOENT'
      ? { status: 'missing', urls: [] }
      : { status: 'invalid', issue: 'unreadable-plan', urls: [] };
  }
  let plan;
  try { plan = JSON.parse(source); }
  catch { return { status: 'invalid', issue: 'invalid-json', urls: [] }; }
  const paths = plan?.paths === undefined ? [] : plan.paths;
  const binaryPaths = plan?.binaryPaths === undefined ? [] : plan.binaryPaths;
  if (plan?.version !== 1 || !Array.isArray(paths) || paths.length > MAX_URLS
    || !Array.isArray(binaryPaths) || binaryPaths.length > MAX_BINARY_URLS
    || (!paths.length && !binaryPaths.length)) {
    return { status: 'invalid', issue: 'invalid-paths', urls: [] };
  }
  const urls = new Set();
  const parse = (path, kind) => {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || path.includes('\\') || path.includes('#') || path.length > 2048) {
      return { status: 'invalid', issue: `invalid-${kind}-path`, urls: [] };
    }
    const url = new URL(path, origin);
    if (url.origin !== origin || !isSafeReadOnlyGetUrl(url.href, origin)) {
      return { status: 'invalid', issue: `unsafe-${kind}-url`, urls: [] };
    }
    return url.href;
  };
  for (const path of paths) {
    const url = parse(path, 'data');
    if (typeof url !== 'string') return url;
    urls.add(url);
  }
  const binaryUrls = new Set();
  for (const path of binaryPaths) {
    const url = parse(path, 'binary');
    if (typeof url !== 'string') return url;
    binaryUrls.add(url);
  }
  if ([...binaryUrls].some(url => urls.has(url))) {
    return { status: 'invalid', issue: 'overlapping-paths', urls: [] };
  }
  if (binaryUrls.size && !includeBinary) return { status: 'invalid', issue: 'binary-requires-flag', urls: [] };
  return { status: 'ok', urls: [...urls], binaryUrls: [...binaryUrls] };
}
