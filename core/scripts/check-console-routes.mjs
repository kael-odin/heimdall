#!/usr/bin/env node
/**
 * Cheap build-time guard: every literal /api path found in console/dist must be
 * served by the running engine. The old launcher embedded this as a shell one-liner;
 * keep it as a dependency-free script so setup and tests can reason about it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIST = join(REPO, 'console', 'dist');

export function extractApiPaths(source) {
  const paths = new Set();
  for (const match of String(source ?? '').matchAll(/(["'`])(\/api\/[a-z0-9\/_:.${}-]*)\1/gi)) {
    paths.add(match[2]);
  }
  return [...paths];
}

const concrete = path => path.replace(/\$\{[^}]+\}/g, 'x').replace(/:[a-z_][a-z0-9_]*/gi, 'x');

export async function checkConsoleRoutes({
  dist = DEFAULT_DIST,
  base = 'http://127.0.0.1:8900',
  fetcher = fetch,
  token = process.env.HEIMDALL_TOKEN,
} = {}) {
  const assets = join(dist, 'assets');
  if (!existsSync(assets)) return { checked: 0, bad: [], skipped: true, reason: 'console dist has no assets directory' };
  const paths = new Set();
  for (const name of readdirSync(assets).filter(name => name.endsWith('.js'))) {
    for (const path of extractApiPaths(readFileSync(join(assets, name), 'utf8'))) paths.add(path);
  }
  const bad = [];
  const headers = token ? { 'x-heimdall-token': token } : {};
  for (const path of paths) {
    const url = base.replace(/\/$/, '') + concrete(path);
    let response;
    try {
      response = await fetcher(url, { method: 'GET', headers, signal: AbortSignal.timeout(2500) });
    } catch { continue; }
    if (response.status !== 404) continue;
    const body = await response.text().catch(() => '');
    if (/unknown|not found|no route/i.test(body.slice(0, 300))) bad.push(path);
  }
  return { checked: paths.size, bad, skipped: false };
}

async function main() {
  const baseIndex = process.argv.indexOf('--base');
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : 'http://127.0.0.1:8900';
  const result = await checkConsoleRoutes({ base });
  if (result.skipped) {
    console.log(`[Heimdall] route check skipped: ${result.reason}`);
    return 0;
  }
  if (result.bad.length) {
    console.error(`[Heimdall] WARNING: ${result.bad.length} console API path(s) are not served by ${base}:`);
    for (const path of result.bad) console.error(`  - ${path}`);
    console.error('  UI buttons backed by them will fail with 404.');
    return 1;
  }
  console.log(`[Heimdall] route check: all ${result.checked} /api paths used by the console are served.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
