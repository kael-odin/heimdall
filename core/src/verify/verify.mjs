#!/usr/bin/env node
/**
 * verify — 多视口全页保真验证（视觉回归）
 *
 * 用法:
 *   node src/verify/verify.mjs <host> <page>
 *   node src/verify/verify.mjs <host> --all [--max N]
 *   node src/verify/verify.mjs <host> <page> --page-dir <absolute>
 *   可选: --viewports 375x812,768x1024,1440x900  --threshold 85
 *         --keep-screenshots  保留源站与克隆的全页截图，供取证复核
 *
 * 产物: workspace/<host>/verify/<page>/
 *   verify.json         每个视口的 score/grade/heightDelta + 综合分
 *   diff-<vp>.png       差异热图（证据；全页截图在比较后删除以控制体积）
 *
 * 说明：冻结动画/清空输入框后拍摄；超过 25000px 的页面分段截图并计分。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { canonUrl } from '../url-canon.mjs';
import { loadProfile } from '../site-profile.mjs';
import { restoreSessionStorage, sessionContext } from '../session/store.mjs';
import { comparePngBuffers, overallScore, worstViewport, gradeOf } from './compare.mjs';
import { compareTiledPng, TILE_HEIGHT } from './tiled-compare.mjs';
import { verifyInteractions, scoreInteractions } from './interactions.mjs';
import { emit } from '../emit.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { freezeCss } from '../freeze.mjs';
import { UA } from '../ua.mjs';
import { isSafePageName } from '../page-name.mjs';
import { startClonePreviewServer } from '../clone-preview-server.mjs';

const log = (...a) => console.error('[verify]', ...a);
const SINGLE_CAPTURE_HEIGHT = 25_000;
const MAX_PAGE_HEIGHT = 100_000;
const MAX_SCROLL_PASSES = 4;
const RENDER_SETTLE_TIMEOUT = 2500;
const RENDER_SETTLE_MIN_WAIT = 1000;
const RENDER_SETTLE_STABLE_FOR = 500;
const FREEZE_CSS = freezeCss({ swiper: true, consent: true });

const argv = process.argv.slice(2);
const host = argv[0] ?? '';
const pageArg = argv[1];
const all = argv.includes('--all');
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx > -1 ? Number(argv[maxIdx + 1]) : Infinity;
const dirIdx = argv.indexOf('--page-dir');
const PAGE_DIR = dirIdx > -1 ? resolve(argv[dirIdx + 1] ?? '') : null;
const vpIdx = argv.indexOf('--viewports');
const viewportArg = vpIdx > -1 ? argv[vpIdx + 1] : '375x812,768x1024,1440x900';
const VIEWPORTS = typeof viewportArg === 'string' ? viewportArg
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const [w, h] = s.split('x').map(Number); return { name: s, width: w, height: h }; })
  : [];
const thrIdx = argv.indexOf('--threshold');
const THRESHOLD = thrIdx > -1 ? Number(argv[thrIdx + 1]) : 0;
// 交互回放（功能保真）：单页默认开启；--all 需显式 --interactions；--no-interactions 关闭
const RUN_IX = !argv.includes('--no-interactions') && (!all || argv.includes('--interactions'));
const KEEP_SCREENSHOTS = argv.includes('--keep-screenshots');

if (!/^(?!\.\.?$)[a-z0-9.-]+$/i.test(host) || (!pageArg && !all)) {
  console.error('usage: node src/verify/verify.mjs <host> <page>|--all [--max N] [--page-dir ABSOLUTE] [--viewports 375x812,768x1024,1440x900] [--threshold 85] [--keep-screenshots]');
  process.exit(2);
}
if (!all && !isSafePageName(pageArg)) {
  console.error('页名无效：必须是单个安全目录名');
  process.exit(2);
}
if ((maxIdx > -1 && (!Number.isInteger(MAX) || MAX < 1)) || (PAGE_DIR && (all || !isAbsolute(argv[dirIdx + 1] ?? '')))) {
  console.error('--max must be a positive integer; --page-dir requires one page and an absolute path');
  process.exit(2);
}
if (!VIEWPORTS.length || VIEWPORTS.length > 6 || new Set(VIEWPORTS.map(v => v.name)).size !== VIEWPORTS.length
    || VIEWPORTS.some(v => !/^\d+x\d+$/.test(v.name) || !Number.isInteger(v.width)
      || !Number.isInteger(v.height) || v.width < 1 || v.width > 4096 || v.height < 1 || v.height > MAX_PAGE_HEIGHT)
    || !Number.isFinite(THRESHOLD) || THRESHOLD < 0 || THRESHOLD > 100) {
  console.error('--viewports must contain 1-6 unique WxH entries; --threshold must be between 0 and 100');
  process.exit(2);
}

const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const relPageDir = PAGE_DIR ? relative(BASE, PAGE_DIR) : null;
if (PAGE_DIR && (!relPageDir || relPageDir.startsWith('..') || isAbsolute(relPageDir))) {
  console.error('--page-dir must be inside workspace/' + host);
  process.exit(2);
}
const pages = existsSync(PAGES) ? readdirSync(PAGES, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
const targets = PAGE_DIR ? [pageArg] : all ? pages.slice(0, MAX) : pages.filter(n => n === pageArg);
if (!targets.length) { console.error('no matching forged pages under', PAGES); process.exit(1); }

const forgedUrls = new Set(pages.map(name => {
  try { return canonUrl(JSON.parse(readFileSync(join(PAGES, name, 'manifest.json'), 'utf8')).target); } catch { return null; }
}).filter(Boolean));
const atlas = (() => { try { return JSON.parse(readFileSync(join(BASE, 'recon', 'atlas.json'), 'utf8')); } catch { return null; } })();
const excluded = new Set(loadProfile(host).queue.excludeTypes);
const missingAtlasUrls = all ? [...new Set((atlas?.nodes ?? []).filter(n => !excluded.has(n.type)).map(n => canonUrl(n.url)).filter(Boolean))].filter(u => !forgedUrls.has(u)) : [];

async function waitForStableRender(page, pendingRequests) {
  const start = Date.now();
  let signature = '', lastChange = start, metrics = null;
  while (true) {
    metrics = await page.evaluate(() => {
      const incomplete = [...document.images].filter(image => !image.complete);
      const visibleIncompleteImages = incomplete.filter(image => {
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight
            || rect.right <= 0 || rect.left >= innerWidth) return false;
        return getComputedStyle(image).visibility !== 'hidden';
      }).length;
      return {
        height: Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0),
        textLength: document.body?.textContent?.length ?? 0,
        imageCount: document.images.length,
        incompleteImages: incomplete.length,
        visibleIncompleteImages,
        brokenImages: [...document.images].filter(image => image.complete && image.naturalWidth === 0).length,
      };
    });
    const next = JSON.stringify(metrics);
    if (next !== signature) { signature = next; lastChange = Date.now(); }
    const elapsedMs = Date.now() - start;
    if (elapsedMs >= RENDER_SETTLE_MIN_WAIT
        && Date.now() - lastChange >= RENDER_SETTLE_STABLE_FOR
        && pendingRequests.size === 0 && metrics.visibleIncompleteImages === 0) {
      return { stable: true, elapsedMs, ...metrics };
    }
    if (elapsedMs >= RENDER_SETTLE_TIMEOUT) {
      return { stable: false, elapsedMs, pendingRequests: pendingRequests.size, ...metrics };
    }
    await page.waitForTimeout(100);
  }
}

async function shoot(page, url, viewport, file, { cloneBase = null } = {}) {
  const origin = new URL(url).origin;
  const pendingRequests = new Set();
  let documentResponse = null;
  const onResponse = response => {
    if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) documentResponse = response;
  };
  const onRequest = request => {
    if (!['fetch', 'xhr', 'image'].includes(request.resourceType())) return;
    const headers = request.headers();
    if (headers['next-router-prefetch'] || /prefetch/i.test(`${headers.purpose ?? ''} ${headers['sec-purpose'] ?? ''}`)) return;
    if (request.resourceType() === 'image') { pendingRequests.add(request); return; }
    try { if (new URL(request.url()).origin === origin) pendingRequests.add(request); } catch {}
  };
  const onRequestDone = request => pendingRequests.delete(request);
  page.on('request', onRequest);
  page.on('requestfinished', onRequestDone);
  page.on('requestfailed', onRequestDone);
  page.on('response', onResponse);
  try {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!documentResponse?.ok()) throw new Error(`page HTTP ${documentResponse?.status() ?? 'no response'}: ${url}`);
    await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
    if (cloneBase && (!page.url().startsWith(cloneBase)
        || !documentResponse?.ok()
        || !/^text\/html(?:;|$)/i.test(documentResponse.headers()['content-type'] ?? ''))) {
      throw new Error(`clone document is not local HTML: ${page.url()}`);
    }
    await page.evaluate(() => document.fonts?.ready).catch(() => {});
    await page.addStyleTag({ content: FREEZE_CSS });
    await page.evaluate(() => { document.querySelectorAll('input, textarea').forEach(el => { el.value = ''; }); });
    const beforeScroll = await waitForStableRender(page, pendingRequests);
    let afterScroll = null;
    let scrollConverged = false;
    for (let pass = 0; pass < MAX_SCROLL_PASSES; pass++) {
      const beforeHeight = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0));
      if (beforeHeight > MAX_PAGE_HEIGHT) break;
      await page.evaluate(async () => {
        const h = Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0);
        for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
        window.scrollTo(0, 0);
      });
      afterScroll = await waitForStableRender(page, pendingRequests);
      if (!afterScroll.stable) break;
      if (afterScroll.height === beforeHeight && afterScroll.stable) { scrollConverged = true; break; }
    }
    const height = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0));
    if (height > MAX_PAGE_HEIGHT || viewport.height > SINGLE_CAPTURE_HEIGHT) {
      return { skipped: 'page or viewport too tall: ' + height + 'px' };
    }
    const tiled = height > SINGLE_CAPTURE_HEIGHT;
    const parts = tiled ? await shootTiles(page, file, viewport.width, height) : null;
    if (!tiled) await page.screenshot({ path: file, fullPage: true, timeout: 90_000 });
    return { ok: true, height, width: viewport.width, tiled, parts,
      capturedAt: new Date().toISOString(), finalUrl: page.url(),
      settle: { beforeScroll, afterScroll, scrollConverged } };
  } finally {
    page.off('request', onRequest);
    page.off('requestfinished', onRequestDone);
    page.off('requestfailed', onRequestDone);
    page.off('response', onResponse);
  }
}

async function shootTiles(page, file, width, height) {
  const parts = [];
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let y = 0; y < height; y += TILE_HEIGHT) {
      const partHeight = Math.min(TILE_HEIGHT, height - y);
      const partFile = file.replace(/\.png$/, `-part-${String(parts.length + 1).padStart(3, '0')}.png`);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: 0, y, width, height: partHeight, scale: 1 },
      });
      writeFileSync(partFile, Buffer.from(data, 'base64'));
      parts.push({ y, height: partHeight, file: partFile });
    }
  } finally {
    await cdp.detach().catch(() => {});
  }
  return parts;
}

const clonePreview = await startClonePreviewServer();
let browser;
const results = [];
try {
  browser = await chromium.launch();
  for (const name of targets) {
    const dir = PAGE_DIR ?? join(PAGES, name);
    const outDir = PAGE_DIR ? join(PAGE_DIR, 'verify') : join(BASE, 'verify', name);
    mkdirSync(outDir, { recursive: true });
    if (!existsSync(join(dir, 'clone', 'index.html'))) {
      const result = { page: name, generatedAt: new Date().toISOString(), scoreVersion: 2, overall: null, measured: false, grade: null, error: 'clone/index.html missing', viewports: [] };
      writeFileSync(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
      results.push({ page: name, overall: null, measured: false, grade: null, error: result.error });
      emit({ kind: 'verify-page', page: name, overall: null, measured: false, error: result.error });
      continue;
    }
    let target;
    try { target = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).target; new URL(target); }
    catch (e) {
      const error = 'invalid manifest target: ' + String(e).slice(0, 120);
      const result = { page: name, generatedAt: new Date().toISOString(), scoreVersion: 2,
        overall: null, measured: false, grade: null, minViewport: null, viewports: [],
        functional: null, interactions: [], error };
      writeFileAtomic(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
      results.push({ page: name, overall: null, measured: false, grade: null, error });
      emit({ kind: 'verify-page', page: name, overall: null, measured: false, error });
      continue;
    }
    log('page', name, '->', target);
    const srcCtx = await browser.newContext({ userAgent: UA, ...sessionContext(new URL(target).hostname) });
    await restoreSessionStorage(srcCtx, new URL(target).hostname);
    const cloneCtx = await browser.newContext({ userAgent: UA });
    const srcPage = await srcCtx.newPage();
    const clonePage = await cloneCtx.newPage();
    const cloneUrl = clonePreview.urlFor(join(dir, 'clone', 'index.html'));
    const viewports = [];
    for (const vp of VIEWPORTS) {
      const srcFile = join(outDir, 'src-' + vp.name + '.png');
      const cloneFile = join(outDir, 'clone-' + vp.name + '.png');
      try {
        const s = await shoot(srcPage, target, vp, srcFile);
        const c = await shoot(clonePage, cloneUrl, vp, cloneFile, { cloneBase: new URL('.', cloneUrl).href });
        if (s.skipped) { viewports.push({ name: vp.name, skipped: s.skipped }); continue; }
        if (c.skipped) { viewports.push({ name: vp.name, skipped: c.skipped }); continue; }
        if (s.tiled && !c.tiled) c.parts = await shootTiles(clonePage, cloneFile, c.width, c.height);
        if (c.tiled && !s.tiled) s.parts = await shootTiles(srcPage, srcFile, s.width, s.height);
        const tiled = s.tiled || c.tiled;
        const cmp = tiled
          ? compareTiledPng(s, c, {
            readPart: readFileSync,
            writeDiff: (y, png) => {
              const name = `diff-${vp.name}-part-${String(y / TILE_HEIGHT + 1).padStart(3, '0')}.png`;
              writeFileSync(join(outDir, name), png);
              return name;
            },
          })
          : comparePngBuffers(readFileSync(srcFile), readFileSync(cloneFile));
        const settleTimedOut = !s.settle.beforeScroll.stable || !s.settle.afterScroll?.stable
          || !s.settle.scrollConverged || !c.settle.beforeScroll.stable
          || !c.settle.afterScroll?.stable || !c.settle.scrollConverged;
        const additionalBrokenImages = Math.max(0,
          c.settle.beforeScroll.brokenImages - s.settle.beforeScroll.brokenImages,
          (c.settle.afterScroll?.brokenImages ?? 0) - (s.settle.afterScroll?.brokenImages ?? 0));
        // 默认只保留 diff + JSON 控制体积；取证时可保留两侧全页截图。
        if (!tiled) writeFileSync(join(outDir, 'diff-' + vp.name + '.png'), cmp.diffPng);
        if (!KEEP_SCREENSHOTS) {
          for (const path of [srcFile, cloneFile, ...(s.parts ?? []).map(p => p.file), ...(c.parts ?? []).map(p => p.file)]) {
            try { unlinkSync(path); } catch {}
          }
        }
        viewports.push({ name: vp.name, width: vp.width, score: cmp.score,
          grade: settleTimedOut || additionalBrokenImages ? null : gradeOf(cmp.score),
          settleTimedOut, additionalBrokenImages,
          captureMode: tiled ? 'tiled' : 'full', ...(tiled ? { diffParts: cmp.diffParts } : {}),
          sourceCapture: { capturedAt: s.capturedAt, finalUrl: s.finalUrl, settle: s.settle },
          cloneCapture: { capturedAt: c.capturedAt, finalUrl: c.finalUrl, settle: c.settle },
          mismatched: cmp.mismatched, missingPixels: cmp.missingPixels, coverageRatio: cmp.coverageRatio, heightDelta: cmp.heightDelta, sourceSize: cmp.sourceSize, cloneSize: cmp.cloneSize, sourceHeight: cmp.sourceSize.height, cloneHeight: cmp.cloneSize.height });
        emit({ kind: 'verify-viewport', page: name, viewport: vp.name, score: cmp.score });
      } catch (e) {
        viewports.push({ name: vp.name, error: String(e).slice(0, 200) });
        emit({ kind: 'verify-error', page: name, viewport: vp.name, error: String(e).slice(0, 200) });
      }
    }
    await srcCtx.close(); await cloneCtx.close();
    // `overallScore` 在**没有任何视口测出分数**时返回 null（三个视口全失败、或全被判"页面太高"跳过）。
    // 以前这里写的是 `?? 0` —— 于是"没测到"被记成"测出来是 0 分 / D 级"，
    // 在 verify-summary.json 与 verify-done 事件里与真的 0 分完全无法区分，
    // 还把站点均值按 100/N 拉下去。**没测到就说没测到**，不进均值。
    const measured = viewports.length === VIEWPORTS.length && viewports.every(v =>
      typeof v.score === 'number' && !v.settleTimedOut && !v.additionalBrokenImages);
    const provisionalOverall = overallScore(viewports);
    const overall = measured ? provisionalOverall : null;
    const minViewport = worstViewport(viewports);
    if (!measured && minViewport) minViewport.grade = null;
    const incomplete = viewports.find(v => v.error || v.skipped || v.settleTimedOut || v.additionalBrokenImages);
    const error = measured ? null : incomplete?.error ?? incomplete?.skipped
      ?? (incomplete?.settleTimedOut ? `${incomplete.name}: render did not settle`
        : incomplete?.additionalBrokenImages
          ? `${incomplete.name}: clone has ${incomplete.additionalBrokenImages} additional broken image(s)`
          : 'viewport measurement incomplete');

    // 功能保真：交互回放（按钮/折叠/标签页），状态签名 + 视口像素
    let interactions = [];
    if (RUN_IX) {
      try {
        interactions = await verifyInteractions(browser, { sourceUrl: target, cloneUrl, max: 3 });
        interactions.forEach((r, i) => { if (r.diffPng) { try { writeFileSync(join(outDir, 'ix-' + (i + 1) + '.png'), r.diffPng); } catch {} delete r.diffPng; } });
        emit({ kind: 'verify-interactions', page: name, ...(scoreInteractions(interactions) ?? { total: 0, passed: 0, score: null }) });
      } catch (e) {
        interactions = [{ pass: false, error: String(e).slice(0, 160) }];
        emit({ kind: 'verify-error', page: name, viewport: 'interactions', error: String(e).slice(0, 160) });
      }
    }
    const functional = scoreInteractions(interactions);

    const result = { page: name, target, generatedAt: new Date().toISOString(), scoreVersion: 2,
      overall, provisionalOverall: measured ? null : provisionalOverall,
      measured, grade: measured ? gradeOf(overall) : null, minViewport, viewports, functional, interactions,
      ...(error ? { error } : {}) };
    writeFileSync(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
    results.push({ page: name, overall, measured, grade: result.grade, minViewport, functional, error });
    const scoreText = measured ? (overall * 100).toFixed(1) + '%'
      : provisionalOverall === null ? '未测到（无有效视口）' : '未完整测量';
    log(name, 'overall', scoreText, result.grade ?? '', minViewport ? '| 最低 ' + minViewport.name + ' ' + (minViewport.score * 100).toFixed(1) + '%' : '', functional ? '| 交互 ' + functional.passed + '/' + functional.total : '| 交互 n/a');
    emit({ kind: 'verify-page', page: name, overall, measured, grade: result.grade, minViewport, functional, error });
  }
} finally { await browser?.close(); await clonePreview.close(); }

if (all) {
  // 均值只按**真的测到的页**算；测不到的页单独计数并在摘要里写明 ——
  // 混进分母就是把"没测"报成"测得差"（和 index-page 的档案均值同一个口径问题）
  const scored = results.filter(r => r.measured && typeof r.overall === 'number');
  const avg = scored.length ? scored.reduce((a, r) => a + r.overall, 0) / scored.length : 0;
  const worst = scored.reduce((a, r) => (r.minViewport && (!a || r.minViewport.score < a.score) ? { page: r.page, ...r.minViewport } : a), null);
  const targetTotal = pages.length + missingAtlasUrls.length;
  const untested = targetTotal - scored.length;
  const passed = untested === 0 && (!THRESHOLD || avg * 100 >= THRESHOLD);
  const failedPages = [...results.filter(r => !r.measured).map(r => ({ page: r.page, error: r.error ?? 'viewport measurement incomplete' })),
    ...missingAtlasUrls.map(url => ({ url, error: 'not cloned' }))];
  writeFileSync(join(BASE, 'verify', 'verify-summary.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), scoreVersion: 2, mode: Number.isFinite(MAX) ? 'sample' : 'all', targetTotal, selected: targets.length, pages: results, measured: scored.length, unmeasured: results.length - scored.length, untested, missingAtlasUrls, failedPages, average: +avg.toFixed(4), worst, threshold: THRESHOLD, passed }, null, 2));
  log('site average', (avg * 100).toFixed(1) + `%（${scored.length}/${targetTotal} 页完整测到）`, worst ? '| 最差 ' + worst.page + ' ' + worst.name + ' ' + (worst.score * 100).toFixed(1) + '%' : '');
  emit({ kind: 'verify-done', host, pages: results.length, targetTotal, measured: scored.length, untested,
    average: +avg.toFixed(4), threshold: THRESHOLD, failedPages, passed });
  if (!passed) process.exitCode = 1;
} else {
  const passed = !!results[0]?.measured && (!THRESHOLD || results[0].overall * 100 >= THRESHOLD);
  const failedPages = results[0]?.measured ? [] : [{ page: results[0]?.page ?? pageArg,
    error: results[0]?.error ?? 'viewport measurement incomplete' }];
  emit({ kind: 'verify-done', host, page: pageArg, pages: results.length,
    measured: results[0]?.measured ? 1 : 0, untested: results[0]?.measured ? 0 : 1,
    average: results[0]?.overall ?? null, threshold: THRESHOLD, failedPages, passed });
  if (!passed) process.exitCode = 1;
}
