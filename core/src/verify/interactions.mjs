/**
 * verify/interactions — 交互回放（功能保真 v1）
 *
 * 在“原站”和“克隆页”上发现同一批可交互元素（按钮/折叠/标签页/aria-expanded），
 * 用同一条 DOM 路径点击，比较点击后的状态签名 + 视口截图相似度：
 *   通过 = 两侧都点击成功且（状态一致 或 视觉相似度 ≥ 0.98）
 */
import { comparePngBuffers } from './compare.mjs';
import { freezeCss } from '../freeze.mjs';
import { restoreSessionStorage, sessionContext } from '../session/store.mjs';
import { UA } from '../ua.mjs';

export const FREEZE = freezeCss();

export function discoverFn() {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const pathOf = (el) => {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.body) {
      const parent = cur.parentElement;
      if (!parent) break;
      const sameTag = [...parent.children].filter(c => c.tagName === cur.tagName);
      parts.unshift(cur.tagName.toLowerCase() + ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')');
      cur = parent;
    }
    return 'body > ' + parts.join(' > ');
  };
  const labelOf = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const nodes = [...document.querySelectorAll('button, summary, [role="button"], [role="tab"], [aria-expanded], [aria-haspopup]')]
    .filter(visible)
    .filter(el => !el.closest('a[href]') || el.hasAttribute('aria-expanded'))
    .slice(0, 60);
  const out = [], seen = new Set();
  for (const el of nodes) {
    const c = { selector: pathOf(el), label: labelOf(el), tag: el.tagName.toLowerCase(), ariaExpanded: el.getAttribute('aria-expanded') };
    if (!c.label) continue;
    const key = c.label + '|' + c.selector;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= 8) break;
  }
  return out;
}

function replayContextOptions(url, viewport, source) {
  const options = { viewport: viewport ?? { width: 1440, height: 900 }, userAgent: UA };
  if (source) return { ...options, ...sessionContext(new URL(url).hostname) };
  if (process.env.HEIMDALL_TOKEN) options.extraHTTPHeaders = { 'x-heimdall-token': process.env.HEIMDALL_TOKEN };
  return options;
}

async function clickAndCapture(browser, url, selector, { viewport, source = false } = {}) {
  const ctx = await browser.newContext(replayContextOptions(url, viewport, source));
  if (source) await restoreSessionStorage(ctx, new URL(url).hostname);
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => {});
    await page.addStyleTag({ content: FREEZE });
    await page.waitForTimeout(600);
    let clicked = false;
    try { await page.locator(selector).first().click({ timeout: 4000 }); clicked = true; } catch {}
    await page.waitForTimeout(700);
    const state = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      let h = 0x811c9dc5;
      const s = text.slice(0, 200000);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
      const visibleCount = [...document.querySelectorAll('body *')].filter(e => {
        const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none';
      }).length;
      return { ariaExpanded: el?.getAttribute('aria-expanded') ?? null, textHash: h.toString(16), textLength: text.length, scrollHeight: document.documentElement.scrollHeight, visibleCount };
    }, selector);
    const shot = await page.screenshot({ timeout: 30_000 }).catch(() => null);
    return { clicked, state, shot };
  } finally { await ctx.close().catch(() => {}); }
}

export async function verifyInteractions(browser, { sourceUrl, cloneUrl, max = 3, viewport } = {}) {
  const ctx = await browser.newContext(replayContextOptions(sourceUrl, viewport, true));
  await restoreSessionStorage(ctx, new URL(sourceUrl).hostname);
  const page = await ctx.newPage();
  let candidates = [];
  try {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(800);
    candidates = await page.evaluate(discoverFn);
  } catch (e) {
    return [{ pass: null, unverified: true, error: `source discovery failed: ${String(e).slice(0, 160)}` }];
  } finally { await ctx.close().catch(() => {}); }

  const results = [];
  for (const c of candidates.slice(0, max)) {
    let src, clone;
    try {
      src = await clickAndCapture(browser, sourceUrl, c.selector, { viewport, source: true });
      clone = await clickAndCapture(browser, cloneUrl, c.selector, { viewport });
    } catch (e) {
      results.push({ label: c.label, selector: c.selector, pass: null, unverified: true, error: String(e).slice(0, 160) });
      continue;
    }
    const stateMatch = src.state.ariaExpanded === clone.state.ariaExpanded
      && Math.abs(src.state.visibleCount - clone.state.visibleCount) <= Math.max(3, src.state.visibleCount * 0.02)
      && Math.abs(src.state.textLength - clone.state.textLength) <= Math.max(20, src.state.textLength * 0.02);
    let visualScore = null, diffPng = null;
    if (src.shot && clone.shot) {
      const cmp = comparePngBuffers(src.shot, clone.shot);
      visualScore = cmp.score; diffPng = cmp.diffPng;
    }
    const pass = !!(src.clicked && clone.clicked && (stateMatch || (visualScore != null && visualScore >= 0.98)));
    results.push({ label: c.label, selector: c.selector, sourceClicked: src.clicked, cloneClicked: clone.clicked, stateMatch, visualScore, pass, diffPng, sourceState: src.state, cloneState: clone.state });
  }
  return results;
}

/** 功能得分（通过数 / 交互数），无交互或存在未核实结果时返回 null */
export function scoreInteractions(results) {
  if (!results?.length || results.some(result => result.unverified)) return null;
  return { total: results.length, passed: results.filter(r => r.pass).length, score: +(results.filter(r => r.pass).length / results.length).toFixed(4) };
}
