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
import { verifierSha256 } from './verifier-fingerprint.mjs';
import { archiveVerifyArtifacts, archiveVerifySummary, evidenceSha256, resumeIdentity } from './resume-cache.mjs';

const log = (...a) => console.error('[verify]', ...a);
const SINGLE_CAPTURE_HEIGHT = 25_000;
const MAX_PAGE_HEIGHT = 100_000;
const MAX_SCROLL_PASSES = 4;
const RENDER_SETTLE_TIMEOUT = process.env.HEIMDALL_VERIFY_SETTLE_TIMEOUT_MS === undefined
  ? 2500 : Number(process.env.HEIMDALL_VERIFY_SETTLE_TIMEOUT_MS);
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
// 断点续跑：只有 --all 有意义（单页本来就是一次到底），见 cachedMeasurement
const RESUME = argv.includes('--resume');
// 有界置信度：默认仍然只认"完全收敛"，显式开启才把"版面已定、只是还有请求挂着"计入分数
const ALLOW_BOUNDED = argv.includes('--allow-bounded');
// 并发页数。默认 1：像素比对对时序敏感，抢 CPU 会让同一页的分数漂移。
const jobsIdx = argv.indexOf('--jobs');
const JOBS = jobsIdx > -1 ? Number(argv[jobsIdx + 1]) : 1;

if (!/^(?!\.\.?$)[a-z0-9.-]+$/i.test(host) || (!pageArg && !all)) {
  console.error('usage: node src/verify/verify.mjs <host> <page>|--all [--max N] [--resume] [--jobs N] [--allow-bounded] [--page-dir ABSOLUTE] [--viewports 375x812,768x1024,1440x900] [--threshold 85] [--keep-screenshots]');
  process.exit(2);
}
if (RESUME && !all) {
  console.error('--resume 只能与 --all 一起用（单页本来就是一次跑完）');
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
    || !Number.isFinite(THRESHOLD) || THRESHOLD < 0 || THRESHOLD > 100
    || !Number.isInteger(RENDER_SETTLE_TIMEOUT) || RENDER_SETTLE_TIMEOUT < 2500 || RENDER_SETTLE_TIMEOUT > 15000
    || !Number.isInteger(JOBS) || JOBS < 1 || JOBS > 8) {
  console.error('--viewports must contain 1-6 unique WxH entries; --threshold must be between 0 and 100; HEIMDALL_VERIFY_SETTLE_TIMEOUT_MS must be 2500..15000; --jobs must be 1..8');
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

let verifier = null;
if (all) {
  try { verifier = verifierSha256(); }
  catch { log('无法核验验证器指纹，本次不复用或生成续跑缓存'); }
}
const cacheOptions = { viewports: VIEWPORTS.map(v => v.name), interactions: RUN_IX,
  keepScreenshots: KEEP_SCREENSHOTS, allowBounded: ALLOW_BOUNDED, settleTimeout: RENDER_SETTLE_TIMEOUT, jobs: JOBS };
if (RESUME) archiveVerifySummary(join(BASE, 'verify'));

const forgedUrls = new Set(pages.map(name => {
  try { return canonUrl(JSON.parse(readFileSync(join(PAGES, name, 'manifest.json'), 'utf8')).target); } catch { return null; }
}).filter(Boolean));
const atlas = (() => { try { return JSON.parse(readFileSync(join(BASE, 'recon', 'atlas.json'), 'utf8')); } catch { return null; } })();
const excluded = new Set(loadProfile(host).queue.excludeTypes);
const missingAtlasUrls = all ? [...new Set((atlas?.nodes ?? []).filter(n => !excluded.has(n.type)).map(n => canonUrl(n.url)).filter(Boolean))].filter(u => !forgedUrls.has(u)) : [];

/**
 * 断点续跑：判断某页上一次的完整测量能不能直接复用。
 *
 * 只复用 `measured: true` 的结果 —— 那意味着每个视口都有分数、两侧渲染都收敛、
 * 克隆侧没有额外的可见坏图。未测到的页恰恰是最该重跑的，不能用旧结论顶替。
 *
 * 本地输入、验证器、选项和输出证据都要一致；这不证明在线参考站没有变化。
 */
function cachedMeasurement(outDir, identity) {
  const file = join(outDir, 'verify.json');
  let prev;
  try { prev = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!identity || prev?.scoreVersion !== 2 || prev.measured !== true || !Number.isFinite(prev.overall)
      || !Array.isArray(prev.viewports) || prev.viewports.some(v => !v || typeof v !== 'object')) return null;
  const names = (prev.viewports ?? []).map(v => v.name);
  if (JSON.stringify(names) !== JSON.stringify(cacheOptions.viewports)) return null;
  const { evidence, ...previousIdentity } = prev.resumeCache ?? {};
  if (JSON.stringify(previousIdentity) !== JSON.stringify(identity) || !evidence
      || evidenceSha256(prev, outDir, KEEP_SCREENSHOTS) !== evidence) return null;
  return prev;
}

async function waitForStableRender(page, pendingRequests) {
  const start = Date.now();
  let signature = '', lastChange = start, metrics = null;
  while (true) {
    metrics = await page.evaluate(() => {
      const incomplete = [...document.images].filter(image => !image.complete);
      const visibleInDocument = image => {
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (rect.right <= 0 || rect.left >= innerWidth) return false;
        const visibility = getComputedStyle(image).visibility;
        if (visibility === 'hidden' || visibility === 'collapse') return false;
        let fixed = false;
        for (let element = image; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          if (style.display === 'none' || Number(style.opacity) === 0
              || style.contentVisibility === 'hidden') return false;
          if (style.position === 'fixed') fixed = true;
        }
        if (fixed && (rect.bottom <= 0 || rect.top >= innerHeight)) return false;
        return true;
      };
      const visibleIncompleteImages = incomplete.filter(image => {
        const rect = image.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight
            || rect.right <= 0 || rect.left >= innerWidth) return false;
        return getComputedStyle(image).visibility !== 'hidden';
      }).length;
      const broken = [...document.images].filter(image => image.complete && image.naturalWidth === 0);
      return {
        height: Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0),
        textLength: document.body?.textContent?.length ?? 0,
        imageCount: document.images.length,
        incompleteImages: incomplete.length,
        visibleIncompleteImages,
        brokenImages: broken.length,
        visibleBrokenImages: broken.filter(visibleInDocument).length,
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
      // 只说"没收敛"没有用：402 页卡在这里，而每种卡法的含义完全不同。
      // 请求一直挂着（长轮询 / 埋点）但版面早就定住了，和"滚动后高度还在涨"
      // 不是一回事 —— 前者截图是终态，后者截图是中间态，不能同一口径处理。
      const quietMs = Date.now() - lastChange;
      const layoutStable = quietMs >= RENDER_SETTLE_STABLE_FOR;
      const blockedBy = [];
      if (pendingRequests.size > 0) blockedBy.push({ reason: 'pending-requests', count: pendingRequests.size });
      if (metrics.visibleIncompleteImages > 0) blockedBy.push({ reason: 'incomplete-images', count: metrics.visibleIncompleteImages });
      if (!layoutStable) blockedBy.push({ reason: 'layout-changing', count: 0 });
      return { stable: false, elapsedMs, quietMs, layoutStable, blockedBy, pendingRequests: pendingRequests.size, ...metrics };
    }
    await page.waitForTimeout(100);
  }
}

/**
 * 把一次 shoot 的收敛情况翻译成"这次截图能不能当数"。
 *
 *   full    —— 两侧都收敛（原有口径，默认仍然只认这个）
 *   bounded —— 版面在最后 500ms 内没再变，只是还有请求挂着（长轮询、埋点、统计心跳）。
 *              截图是终态，分数可信，但页面还在背地里跑东西。
 *   none    —— 版面还在变，或者滚动后高度还在涨。截到的是中间态，分数不能用。
 *
 * 只有 `--allow-bounded` 时 bounded 才计入 measured；默认口径一个字都不改。
 */
export function settleAssessment(settle) {
  const phases = [settle?.beforeScroll, settle?.afterScroll].filter(Boolean);
  if (!phases.length) return { confidence: 'none', blocking: [{ reason: 'no-capture' }] };
  const blocking = [];
  for (const phase of phases) {
    if (phase.stable) continue;
    const reasons = phase.blockedBy?.length ? phase.blockedBy : [{ reason: 'unknown', count: 0 }];
    for (const r of reasons) if (!blocking.some(b => b.reason === r.reason)) blocking.push(r);
  }
  if (!settle?.scrollConverged) blocking.push({ reason: 'scroll-growing', count: 0 });
  // 版面还在动 / 滚动后还在长 —— 这两类是"截图本身不可信"，任何模式下都不放行
  if (blocking.some(b => b.reason === 'layout-changing' || b.reason === 'scroll-growing')) {
    return { confidence: 'none', blocking };
  }
  return { confidence: blocking.length ? 'bounded' : 'full', blocking };
}

const REASON_TEXT = {
  'pending-requests': '还有请求一直没结束（长轮询 / 埋点 / 统计心跳）',
  'incomplete-images': '还有可见图片没加载完',
  'layout-changing': '版面在观察窗口内一直在变',
  'scroll-growing': '滚动后页高还在增长（无限滚动 / 懒加载）',
  'no-capture': '没有取得任何视口截图',
  unknown: '未收敛原因未知',
};
const reasonText = r => REASON_TEXT[r.reason] ?? r.reason;

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
      // 收敛的判据是"版面定住 + 滚动后页高不再变"，不是"请求全部结束"。
      // 长轮询永远不会有结束的那一刻，但版面早在第一秒就定住了 —— 把这两件事
      // 混成一个 `stable` 布尔，就是 402 页永远等不到收敛的直接原因。
      const layoutStill = afterScroll.layoutStable !== false;
      if (afterScroll.height === beforeHeight && layoutStill) { scrollConverged = true; break; }
      if (!afterScroll.stable || !layoutStill) break;
    }
    const height = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0));
    if (height > MAX_PAGE_HEIGHT || viewport.height > SINGLE_CAPTURE_HEIGHT) {
      return { skipped: 'page or viewport too tall: ' + height + 'px' };
    }
    const tiled = height > SINGLE_CAPTURE_HEIGHT;
    const parts = tiled ? await shootTiles(page, file, viewport.width, height) : null;
    if (!tiled) await page.screenshot({ path: file, fullPage: true, timeout: 90_000 });
    const settle = { beforeScroll, afterScroll, scrollConverged };
    return { ok: true, height, width: viewport.width, tiled, parts,
      capturedAt: new Date().toISOString(), finalUrl: page.url(), settle };
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
let reused = 0;   // --resume 复用的页数，写进摘要，让"这次真测了几页"一眼可读

/**
 * 单页验证。抽成函数是为了并发（--jobs）：每页仍然独占自己的浏览器上下文，
 * 页与页之间不共享任何状态，所以并发不改变结果，只改变耗时。
 */
async function verifyOne(name, index = 0, total = 1) {
    const dir = PAGE_DIR ?? join(PAGES, name);
    const outDir = PAGE_DIR ? join(PAGE_DIR, 'verify') : join(BASE, 'verify', name);
    mkdirSync(outDir, { recursive: true });
    const identity = all ? resumeIdentity(dir, cacheOptions, verifier) : null;
    if (RESUME) {
      const prev = cachedMeasurement(outDir, identity);
      if (prev) {
        reused += 1;
        log(name, '已测过，复用上次结果', (prev.overall * 100).toFixed(1) + '%', prev.grade ?? '', prev.generatedAt ?? '');
        emit({ kind: 'verify-page', index, total, page: name, overall: prev.overall, measured: true, grade: prev.grade ?? null,
          minViewport: prev.minViewport ?? null, functional: prev.functional ?? null, reused: true });
        return { page: name, overall: prev.overall, measured: true, confidence: prev.confidence ?? 'full',
          grade: prev.grade ?? null, minViewport: prev.minViewport ?? null, functional: prev.functional ?? null,
          error: null, reused: true, measuredAt: prev.generatedAt ?? null };
      }
      try { archiveVerifyArtifacts(outDir); }
      catch {
        const error = 'previous verification evidence could not be archived';
        emit({ kind: 'verify-error', page: name, error });
        return { page: name, overall: null, measured: false, confidence: 'none', grade: null, error };
      }
    }
    if (!existsSync(join(dir, 'clone', 'index.html'))) {
      const result = { page: name, generatedAt: new Date().toISOString(), scoreVersion: 2, overall: null, measured: false, grade: null, error: 'clone/index.html missing', viewports: [] };
      writeFileSync(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
      emit({ kind: 'verify-page', index, total, page: name, overall: null, measured: false, error: result.error });
      return { page: name, overall: null, measured: false, confidence: 'none', grade: null, error: result.error };
    }
    let target;
    try { target = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).target; new URL(target); }
    catch (e) {
      const error = 'invalid manifest target: ' + String(e).slice(0, 120);
      const result = { page: name, generatedAt: new Date().toISOString(), scoreVersion: 2,
        overall: null, measured: false, grade: null, minViewport: null, viewports: [],
        functional: null, interactions: [], error };
      writeFileAtomic(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
      emit({ kind: 'verify-page', index, total, page: name, overall: null, measured: false, error });
      return { page: name, overall: null, measured: false, confidence: 'none', grade: null, error };
    }
    log('page', name, '->', target);
    const srcCtx = await browser.newContext({ userAgent: UA, ...sessionContext(new URL(target).hostname) });
    await restoreSessionStorage(srcCtx, new URL(target).hostname);
    const cloneCtx = await browser.newContext({ userAgent: UA });
    const srcPage = await srcCtx.newPage();
    const clonePage = await cloneCtx.newPage();
    const cloneUrl = clonePreview.urlFor(join(dir, 'clone', 'index.html'));
    const cloneBase = new URL('.', cloneUrl).href;
    let externalCloneRequest = false;
    clonePage.on('request', request => {
      if (/^https?:\/\//i.test(request.url()) && !request.url().startsWith(cloneBase)) externalCloneRequest = true;
    });
    const viewports = [];
    for (const vp of VIEWPORTS) {
      const srcFile = join(outDir, 'src-' + vp.name + '.png');
      const cloneFile = join(outDir, 'clone-' + vp.name + '.png');
      try {
        const s = await shoot(srcPage, target, vp, srcFile);
        const c = await shoot(clonePage, cloneUrl, vp, cloneFile, { cloneBase });
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
        // 两侧各自判一次，取更差的那个：源站收敛但克隆没收敛，同样说明像素不可比
        const a = settleAssessment(s.settle), b = settleAssessment(c.settle);
        const rank = { full: 0, bounded: 1, none: 2 };
        const confidence = rank[a.confidence] >= rank[b.confidence] ? a.confidence : b.confidence;
        const blocking = [...new Map([...a.blocking, ...b.blocking].map(x => [x.reason, x])).values()];
        // settleTimedOut 保持原意"没有完全收敛"（bounded 也算），但"能不能当分数用"
        // 交给 confidence；只有 none（版面还在动）才真的不给等级。
        const settleTimedOut = confidence !== 'full';
        const additionalBrokenImages = Math.max(0,
          c.settle.beforeScroll.brokenImages - s.settle.beforeScroll.brokenImages,
          (c.settle.afterScroll?.brokenImages ?? 0) - (s.settle.afterScroll?.brokenImages ?? 0));
        const additionalVisibleBrokenImages = Math.max(0,
          c.settle.beforeScroll.visibleBrokenImages - s.settle.beforeScroll.visibleBrokenImages,
          (c.settle.afterScroll?.visibleBrokenImages ?? 0) - (s.settle.afterScroll?.visibleBrokenImages ?? 0));
        // 默认只保留 diff + JSON 控制体积；取证时可保留两侧全页截图。
        if (!tiled) writeFileSync(join(outDir, 'diff-' + vp.name + '.png'), cmp.diffPng);
        if (!KEEP_SCREENSHOTS) {
          for (const path of [srcFile, cloneFile, ...(s.parts ?? []).map(p => p.file), ...(c.parts ?? []).map(p => p.file)]) {
            try { unlinkSync(path); } catch {}
          }
        }
        viewports.push({ name: vp.name, width: vp.width, score: cmp.score, confidence,
          ...(blocking.length ? { blocking: blocking.map(x => ({ ...x, text: reasonText(x) })) } : {}),
          grade: confidence === 'none' || additionalVisibleBrokenImages ? null : gradeOf(cmp.score),
          settleTimedOut, additionalBrokenImages, additionalVisibleBrokenImages,
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
    // 页面级置信度：取最差视口。任一视口是 none（版面还在动）整页就是 none。
    const pageConfidence = viewports.length !== VIEWPORTS.length
      || viewports.some(v => v.confidence !== 'full' && v.confidence !== 'bounded') ? 'none'
      : viewports.some(v => v.confidence === 'bounded') ? 'bounded' : 'full';
    // 有界置信度的页只有在显式 --allow-bounded 时才算数；默认口径与以前逐字相同。
    const measured = viewports.length === VIEWPORTS.length
      && viewports.every(v => typeof v.score === 'number' && !v.additionalVisibleBrokenImages)
      && (pageConfidence === 'full' || (pageConfidence === 'bounded' && ALLOW_BOUNDED));
    const provisionalOverall = overallScore(viewports);
    const overall = measured ? provisionalOverall : null;
    const minViewport = worstViewport(viewports);
    if (!measured && minViewport) minViewport.grade = null;
    const incomplete = viewports.find(v => v.error || v.skipped || v.settleTimedOut || v.additionalVisibleBrokenImages);
    // 每个没判定的视口都要说清卡在哪 —— 以前只有一句 "render did not settle"，
    // 402 页卡在这里却没人知道是长轮询、还是一次懒加载没完。
    const confidenceReasons = [...new Set(viewports.flatMap(v =>
      (v.blocking ?? []).map(x => `${v.name}: ${x.text}`)))];
    const error = measured ? null : incomplete?.error ?? incomplete?.skipped
      ?? (incomplete?.settleTimedOut
        ? `${incomplete.name}: render did not settle${confidenceReasons.length ? ' — ' + confidenceReasons.join('；') : ''}`
        : incomplete?.additionalVisibleBrokenImages
          ? `${incomplete.name}: clone has ${incomplete.additionalVisibleBrokenImages} additional visible broken image(s)`
          : pageConfidence === 'bounded'
            ? `${viewports[0]?.name ?? 'viewport'}: 版面已定住但请求未结束${confidenceReasons.length ? ' — ' + confidenceReasons.join('；') : ''}（加 --allow-bounded 可按有界置信度计入）`
            : 'viewport measurement incomplete');

    // 功能保真：交互回放（按钮/折叠/标签页），状态签名 + 视口像素
    let interactions = [];
    if (RUN_IX) {
      try {
        interactions = await verifyInteractions(browser, { sourceUrl: target, cloneUrl, max: 3 });
        interactions.forEach((r, i) => { if (r.diffPng) { try { writeFileSync(join(outDir, 'ix-' + (i + 1) + '.png'), r.diffPng); } catch {} delete r.diffPng; } });
        const unverified = interactions.find(r => r.unverified);
        if (unverified) emit({ kind: 'verify-error', page: name, viewport: 'interactions', error: unverified.error });
        else emit({ kind: 'verify-interactions', page: name, ...(scoreInteractions(interactions) ?? { total: 0, passed: 0, score: null }) });
      } catch (e) {
        interactions = [{ pass: null, unverified: true, error: String(e).slice(0, 160) }];
        emit({ kind: 'verify-error', page: name, viewport: 'interactions', error: String(e).slice(0, 160) });
      }
    }
    const functional = scoreInteractions(interactions);

    const result = { page: name, target, generatedAt: new Date().toISOString(), scoreVersion: 2,
      overall, provisionalOverall: measured ? null : provisionalOverall, confidence: pageConfidence,
      ...(confidenceReasons.length ? { confidenceReasons } : {}),
      measured, grade: measured ? gradeOf(overall) : null, minViewport, viewports, functional, interactions,
      ...(error ? { error } : {}) };
    if (measured && identity && !externalCloneRequest
        && JSON.stringify(identity) === JSON.stringify(resumeIdentity(dir, cacheOptions, verifier))) {
      const evidence = evidenceSha256(result, outDir, KEEP_SCREENSHOTS);
      if (evidence) result.resumeCache = { ...identity, evidence };
    }
    writeFileSync(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
    const scoreText = measured ? (overall * 100).toFixed(1) + '%'
      : provisionalOverall === null ? '未测到（无有效视口）' : '未完整测量';
    log(name, 'overall', scoreText, result.grade ?? '', minViewport ? '| 最低 ' + minViewport.name + ' ' + (minViewport.score * 100).toFixed(1) + '%' : '', functional ? '| 交互 ' + functional.passed + '/' + functional.total : '| 交互 n/a');
    emit({ kind: 'verify-page', index, total, page: name, overall, measured, grade: result.grade, minViewport, functional, error });
    return { page: name, overall, measured, confidence: pageConfidence, grade: result.grade, measuredAt: result.generatedAt,
      minViewport, functional, error,
      ...(confidenceReasons.length ? { confidenceReasons } : {}) };
}

try {
  browser = await chromium.launch();
  // 页与页之间没有共享状态，所以可以并发；顺序仍按目录名，结果才可复现。
  // 默认 1：像素比对对时序敏感，并发抢 CPU 会让同一页的分数漂移，
  // 快是使用者的选择，准是默认值。
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(JOBS, targets.length) }, async () => {
    while (cursor < targets.length) {
      const name = targets[cursor++];
      results.push(await verifyOne(name, cursor, targets.length));
    }
  }));
  // 并发完成顺序不固定 —— 按目标顺序重排，摘要与以前逐行一致
  const order = new Map(targets.map((n, i) => [n, i]));
  results.sort((a, b) => order.get(a.page) - order.get(b.page));
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
  // 卡点直方图：把 402 页那种"一片未测到"拆成可行动的几类，而不是一句 did not settle
  const blockers = {};
  for (const r of results) {
    for (const line of r.confidenceReasons ?? []) {
      const key = line.split(': ').slice(1).join(': ').replace(/\d+/g, 'N');
      blockers[key] = (blockers[key] ?? 0) + 1;
    }
  }
  const bounded = scored.filter(r => r.confidence === 'bounded').length;
  writeFileSync(join(BASE, 'verify', 'verify-summary.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), scoreVersion: 2, mode: Number.isFinite(MAX) ? 'sample' : 'all', targetTotal, selected: targets.length, pages: results, measured: scored.length, bounded, unmeasured: results.length - scored.length, untested, reused, pendingAtlasUrls: missingAtlasUrls, missingAtlasUrls, blockers, allowBounded: ALLOW_BOUNDED, failedPages, average: +avg.toFixed(4), worst, threshold: THRESHOLD, passed }, null, 2));
  log('site average', (avg * 100).toFixed(1) + `%（${scored.length}/${targetTotal} 页完整测到）`, bounded ? `| 其中 ${bounded} 页是有界置信度` : '', reused ? `| 复用 ${reused} 页（--resume）` : '', worst ? '| 最差 ' + worst.page + ' ' + worst.name + ' ' + (worst.score * 100).toFixed(1) + '%' : '');
  const blocked = Object.entries(blockers).sort((a, b) => b[1] - a[1]);
  if (blocked.length) log('未测到的卡点', blocked.map(([text, n]) => `${n} 视口 · ${text}`).join(' | '));
  emit({ kind: 'verify-done', host, pages: results.length, targetTotal, measured: scored.length, bounded, untested, reused, blockers,
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
