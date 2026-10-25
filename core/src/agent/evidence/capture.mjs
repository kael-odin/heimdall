/**
 * agent/evidence/capture — 快速裁判与评估器共用的拍摄流程（PRD 05 §3.1 第 2 步）
 *
 * 两侧（参考镜像、候选）必须同条件，否则差异里全是环境噪声。Phase 0 定下的条件：
 *   · 同一份冻结样式（freeze.mjs：动画 / 过渡归零、轮播回位、同意弹层隐藏）、清空输入框
 *   · 等 load 与 document.fonts.ready，再等版面静止
 *   · **不做滚动预热**：与验收 runner 一致（S4：预热让 apify.com/contact 在 375 下页高 +96px）
 *   · 文字灰度抗锯齿 --disable-lcd-text（S1：Windows 默认的 LCD 亚像素抗锯齿让噪声误报高 2–4 倍）
 *   · 页面内滚动一律 behavior: 'instant'（有站点设了 scroll-behavior: smooth，普通 scrollTo 是异步动画）
 * PROFILE 写进参考包，候选拍摄条件与它不一致时 compare 会告警（PRD 05 §1.2「环境一致性」）。
 */
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { freezeCss, FREEZE_MARK } from '../../freeze.mjs';
import { UA } from '../../ua.mjs';
import { CapabilityError } from '../envelope.mjs';
import { crop, decodePng } from './image.mjs';

export const VIEWPORTS = Object.freeze([
  Object.freeze({ width: 375, height: 812 }),
  Object.freeze({ width: 768, height: 1024 }),
  Object.freeze({ width: 1440, height: 900 }),
]);
export const viewportOf = (width) => VIEWPORTS.find(v => v.width === Number(width)) ?? null;

const FREEZE_CSS = freezeCss({ swiper: true, consent: true });
const MAX_HEIGHT = 25_000;
const PLAYWRIGHT_VERSION = (() => { try { return createRequire(import.meta.url)('playwright/package.json').version; } catch { return null; } })();

export const PROFILE = Object.freeze({
  version: 1,
  textAntialias: 'grayscale',
  scrollPass: false,
  freeze: FREEZE_MARK,
  deviceScaleFactor: 1,
  playwright: PLAYWRIGHT_VERSION,
});

export async function launchBrowser() {
  try {
    return await chromium.launch({ args: ['--disable-lcd-text'] });
  } catch (error) {
    if (/Executable doesn't exist|browserType\.launch/i.test(String(error?.message))) {
      throw new CapabilityError('chromium_missing', '本机没有可用的 Chromium');
    }
    throw error;
  }
}

async function settle(page, { minMs = 600, stableMs = 400, maxMs = 4000 } = {}) {
  const start = Date.now();
  let sig = '', last = start;
  while (true) {
    const now = await page.evaluate(() => JSON.stringify([
      Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0),
      [...document.images].filter(i => !i.complete).length,
      document.fonts?.status,
    ]));
    if (now !== sig) { sig = now; last = Date.now(); }
    const t = Date.now() - start;
    if (t >= minMs && Date.now() - last >= stableMs) return { stable: true, ms: t };
    if (t >= maxMs) return { stable: false, ms: t };
    await page.waitForTimeout(80);
  }
}

/** 打开一页并收敛；返回 { ctx, page, settled, loadMs } */
export async function openPage(browser, url, viewport, { freeze = true, scrollPass = false } = {}) {
  const t0 = Date.now();
  const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1, userAgent: UA,
    serviceWorkers: 'block' });
  const page = await ctx.newPage();
  let resp;
  // Windows 上资源很多的镜像偶发 ERR_NO_BUFFER_SPACE / 连接被重置：短暂等一下重试一次
  const transient = (e) => /ERR_NO_BUFFER_SPACE|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE/.test(String(e?.message));
  try {
    try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
    catch (error) { if (!transient(error)) throw error; await new Promise(r => setTimeout(r, 1500)); resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }); }
  }
  catch (error) { await ctx.close(); throw new CapabilityError('candidate_unreachable', `打不开 ${new URL(url).origin}`, { details: { reason: String(error?.message ?? error).split('\n')[0].slice(0, 160) } }); }
  if (!resp?.ok()) { await ctx.close(); throw new CapabilityError('candidate_unreachable', `页面返回 HTTP ${resp?.status() ?? '无响应'}`); }
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  if (freeze) await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => { document.querySelectorAll('input, textarea').forEach(el => { el.value = ''; }); });
  const s1 = await settle(page);
  let s2 = { stable: true };
  if (scrollPass) {
    await page.evaluate(async () => {
      const to = (y) => { window.scrollTo({ top: y, behavior: 'instant' }); document.body.scrollTo({ top: y, behavior: 'instant' }); };
      const h = Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0);
      for (let y = 0; y < h; y += 800) { to(y); await new Promise(r => setTimeout(r, 50)); }
      to(0);
    });
    s2 = await settle(page);
  }
  return { ctx, page, loadMs: Date.now() - t0, settled: s1.stable && s2.stable };
}

/**
 * 整页截图并解码。contentCrop：页面内容比视口矮时，整页截图不会比视口矮，下方多出一截空白；
 * 裁到 body 子元素的实际底边（S2 第一轮把这截空白算成了缺失大块，1440 永远过不了 silver）。
 */
export async function shoot(page, { contentCrop = false } = {}) {
  await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); document.body?.scrollTo({ top: 0, behavior: 'instant' }); });
  const height = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0));
  if (height > MAX_HEIGHT) {
    throw new CapabilityError('render_not_settled', `页面高 ${height}px，超过单次截图上限 ${MAX_HEIGHT}px`, { hint: '按分段对比（--section），或缩小页面范围' });
  }
  let img = decodePng(await page.screenshot({ fullPage: true, timeout: 90_000 }));
  if (contentCrop) {
    const bottom = await page.evaluate(() => Math.ceil(Math.max(0, ...[...(document.body?.children ?? [])].map(el => el.getBoundingClientRect().bottom + scrollY))));
    if (bottom > 0 && bottom < img.height) img = crop(img, 0, 0, img.width, bottom);
  }
  return img;
}

/** 候选页里某个分段根元素的整页坐标外接框（约定：分段根带 data-heimdall-section="<sectionId>"） */
export async function sectionBox(page, sectionId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-heimdall-section="${CSS.escape(id)}"]`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) };
  }, sectionId);
}
