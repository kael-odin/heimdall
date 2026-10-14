import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSafeReadOnlyGetUrl } from './har.mjs';

const MAX_URLS = 100;

/** A workspace-only allowlist for public, read-only GET response bodies. */
export function readDataPlan(baseDir, origin) {
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
  if (plan?.version !== 1 || !Array.isArray(plan.paths) || !plan.paths.length || plan.paths.length > MAX_URLS) {
    return { status: 'invalid', issue: 'invalid-paths', urls: [] };
  }
  const urls = new Set();
  for (const path of plan.paths) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || path.includes('\\') || path.includes('#') || path.length > 2048) {
      return { status: 'invalid', issue: 'invalid-path', urls: [] };
    }
    const url = new URL(path, origin);
    if (url.origin !== origin || !isSafeReadOnlyGetUrl(url.href, origin)) {
      return { status: 'invalid', issue: 'unsafe-url', urls: [] };
    }
    urls.add(url.href);
  }
  return { status: 'ok', urls: [...urls] };
}
