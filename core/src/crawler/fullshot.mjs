/**
 * fullshot — 为已有克隆页批量补拍原站全页快照（不重跑整条流水线）
 *
 * compare.html 的原站侧需要 shot-src-full.png；旧版产物缺失时此工具补拍。
 * 并发 2，每页 ~20s。
 *
 * 维护工具：只适用于缺少 shot-src-full.png 的旧产物；常规 forge/verify 不调用它。
 * 用法: node src/crawler/fullshot.mjs <siteId> [pageName] [--apply]
 * 默认只列计划；--apply 才会补拍缺图页，且不会覆盖已有截图。
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, lstatSync, linkSync, unlinkSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPageName } from '../page-name.mjs';
import { readSiteIdentity } from '../site-origin.mjs';
import { WORKSPACE, isInside } from '../paths.mjs';
import { restoreSessionStorage, sessionContext } from '../session/store.mjs';
import { UA } from '../ua.mjs';

const USAGE = 'node src/crawler/fullshot.mjs <siteId> [pageName] [--apply]';
export const FULLSHOT_TOOL_VERSION = 2;
const SITE_ID_RE = /^(?!\.\.?$)[a-z0-9][a-z0-9.-]*(?:--origin-[0-9a-f]{16})?$/i;

function fail(message, code = 2) {
  console.error(message + `\n用法: ${USAGE}`);
  process.exit(code);
}

function parseArgs(argv = process.argv.slice(2)) {
  const positional = argv.filter(arg => !arg.startsWith('--'));
  const host = positional[0];
  const only = positional[1];
  const dryRun = !argv.includes('--apply');
  if (!host) fail('缺少站点 ID');
  if (!SITE_ID_RE.test(host) || basename(host) !== host || host.includes(sep)) {
    fail(`站点 ID 不安全：${host}`);
  }
  if (only) {
    try { assertPageName(only); } catch { fail(`页名无效：${only}`); }
  }
  return { host, only, dryRun };
}

function readTarget(manifestPath) {
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const target = JSON.parse(readFileSync(manifestPath, 'utf8'))?.target;
    if (typeof target !== 'string' || !/^https?:\/\//i.test(target)) return null;
    const url = new URL(target);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/**
 * 只收集旧产物中仍可安全补拍的页面。
 * 维护工具不认领站点目录，也不把坏 manifest 猜成默认 URL。
 */
export function planFullshots({ workspace = WORKSPACE, host, only } = {}) {
  if (!host || !SITE_ID_RE.test(host) || basename(host) !== host) {
    throw new Error(`站点 ID 不安全：${host ?? ''}`);
  }
  const base = resolve(workspace, host);
  if (!isInside(workspace, base)) throw new Error(`站点目录越界：${host}`);
  const pagesDir = join(base, 'pages');
  for (const directory of [base, pagesDir]) {
    if (!existsSync(directory)) continue;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`站点路径不是普通目录：${directory}`);
  }
  let identity = null;
  try { identity = readSiteIdentity(workspace, host); }
  catch { /* 旧产物可含损坏 manifest；逐页校验并列为 skipped */ }
  let expectedOrigin = identity?.origin ?? null;
  const targets = [];
  const skipped = [];
  const entries = existsSync(pagesDir) ? readdirSync(pagesDir, { withFileTypes: true }) : [];
  if (!expectedOrigin) {
    const origins = new Set();
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const target = readTarget(join(pagesDir, entry.name, 'manifest.json'));
      if (target) origins.add(new URL(target).origin);
    }
    const byHostname = [...origins].filter(origin =>
      new URL(origin).hostname.replace(/^www\./, '') === host.replace(/--origin-[0-9a-f]{16}$/i, ''));
    if (byHostname.length === 1) expectedOrigin = byHostname[0];
    else if (origins.size > 0) throw new Error(`站点 ${host} 的旧 manifest 来源不唯一或 hostname 不符，已拒绝补拍`);
  }
  const scopedHash = host.match(/--origin-([0-9a-f]{16})$/i)?.[1]?.toLowerCase();
  if (scopedHash && expectedOrigin
    && createHash('sha256').update(expectedOrigin).digest('hex').slice(0, 16) !== scopedHash) {
    throw new Error(`站点 ${host} 的 origin 摘要与目录名不符，已拒绝补拍`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || (only && entry.name !== only)) continue;
    let pageName;
    try { pageName = assertPageName(entry.name); } catch { skipped.push({ name: entry.name, reason: 'unsafe-page-name' }); continue; }
    const pageDir = join(pagesDir, pageName);
    const manifestPath = join(pageDir, 'manifest.json');
    const shotPath = join(pageDir, 'shot-src-full.png');
    if (!existsSync(manifestPath)) { skipped.push({ name: pageName, reason: 'missing-manifest' }); continue; }
    if (existsSync(shotPath)) continue;
    try {
      if (lstatSync(shotPath).isSymbolicLink()) { skipped.push({ name: pageName, reason: 'unsafe-shot-link' }); continue; }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const url = readTarget(manifestPath);
    if (!url) { skipped.push({ name: pageName, reason: 'invalid-target' }); continue; }
    const origin = new URL(url).origin;
    if (origin !== expectedOrigin) {
      skipped.push({ name: pageName, reason: `origin-mismatch:${origin}` });
      continue;
    }
    targets.push({ name: pageName, url, pageDir, shotPath });
  }
  return { base, pagesDir, expectedOrigin, targets, skipped };
}

async function main(argv = process.argv.slice(2)) {
  const { host, only, dryRun } = parseArgs(argv);
  let plan;
  try { plan = planFullshots({ workspace: WORKSPACE, host, only }); }
  catch (error) { fail(error.message, 1); }
  const { targets, skipped } = plan;
  console.log(`fullshot ${host}: ${targets.length} missing page(s)` + (dryRun ? ' (dry-run)' : ''));
  for (const item of skipped) console.log(`  - skip ${item.name}: ${item.reason}`);
  for (const target of targets) console.log(`  ${dryRun ? '·' : '→'} ${target.name} ${target.url}`);
  if (dryRun || !targets.length) {
    console.log(`fullshot PLAN: ${targets.length} pending, ${skipped.length} skipped`);
    return 0;
  }

  const browser = await chromium.launch();
  const session = sessionContext(new URL(targets[0].url).hostname);
  let done = 0, failed = 0;
  async function shoot({ name, url, shotPath }) {
    let p, ctx;
    const tempPath = `${shotPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: UA, ...session });
      await restoreSessionStorage(ctx, new URL(url).hostname);
      p = await ctx.newPage();
      await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const landed = p.url();
      if (new URL(landed).origin !== new URL(url).origin) throw new Error(`cross-origin redirect: ${landed}`);
      try { await p.getByRole('button', { name: /accept|dismiss|agree|consent/i }).first().click({ timeout: 4000 }); } catch {}
      await p.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
        window.scrollTo(0, 0);
      });
      await p.waitForTimeout(1500);
      if (new URL(p.url()).origin !== new URL(url).origin) throw new Error(`cross-origin redirect: ${p.url()}`);
      await p.screenshot({ path: tempPath, fullPage: true, timeout: 90_000 });
      linkSync(tempPath, shotPath);
      unlinkSync(tempPath);
      done++;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch {}
      console.log(`  ✗ ${name}:`, String(e).slice(0, 160));
    } finally { await ctx?.close().catch(() => {}); }
  }
  const queue = [...targets];
  try {
    await Promise.all([1, 2].map(async () => { while (queue.length) { const target = queue.shift(); if (target) await shoot(target); } }));
  } finally { await browser.close(); }
  console.log(`fullshot v${FULLSHOT_TOOL_VERSION} DONE: ${done} ok, ${failed} failed, ${skipped.length} skipped`);
  return failed ? 1 : 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
