import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CORE_ROOT } from '../paths.mjs';

const VERIFIER_FILES = [
  'src/verify/verify.mjs',
  'src/verify/compare.mjs',
  'src/verify/tiled-compare.mjs',
  'src/verify/interactions.mjs',
  'src/verify/verifier-fingerprint.mjs',
  'src/verify/resume-cache.mjs',
  'src/clone-preview-server.mjs',
  'src/freeze.mjs',
  'src/paths.mjs',
  'src/url-canon.mjs',
  'src/site-profile.mjs',
  'src/session/store.mjs',
  'src/ua.mjs',
  'src/page-name.mjs',
  'src/fsutil.mjs',
  'src/emit.mjs',
  'package.json',
  'node_modules/playwright/package.json',
  'node_modules/playwright-core/package.json',
  'node_modules/playwright-core/browsers.json',
  'node_modules/pixelmatch/package.json',
  'node_modules/pngjs/package.json',
];

export const verifierSha256 = () => {
  const hash = createHash('sha256');
  hash.update('node-version').update('\0').update(process.version).update('\0');
  hash.update('platform').update('\0').update(process.platform + '/' + process.arch).update('\0');
  for (const file of VERIFIER_FILES) {
    const path = join(CORE_ROOT, file);
    hash.update(file).update('\0');
    if (existsSync(path)) hash.update(readFileSync(path));
    else hash.update('<missing>');
    hash.update('\0');
  }
  const sitesDir = join(CORE_ROOT, 'sites');
  for (const file of (existsSync(sitesDir) ? readdirSync(sitesDir).filter(name => name.endsWith('.json')).sort() : [])) {
    const rel = 'sites/' + file;
    hash.update(rel).update('\0').update(readFileSync(join(sitesDir, file))).update('\0');
  }
  const browserPath = chromium.executablePath();
  if (!existsSync(browserPath)) throw new Error('Chromium executable missing: ' + browserPath);
  hash.update('chromium-executable').update('\0');
  const fd = openSync(browserPath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let bytes;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { closeSync(fd); }
  return hash.update('\0').digest('hex');
};
