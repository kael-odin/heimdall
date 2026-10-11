/**
 * style-probe — 原站 vs 克隆的 computed style 逐元素配对差异
 *
 * L1 搬运保证两侧 DOM 结构一致 → 按 DOM 路径（tag.首个class + 兄弟序号）配对，
 * 对比关键 computed 属性，产出"哪个元素、哪个属性、原站值 vs 克隆值"的精确清单。
 * 这是 AI 校准补丁的弹药：LLM 不再猜选择器，path 里的类名 token 就是可用选择器。
 *
 * 用法: await probeStyleDiff(srcUrl, cloneUrl, {maxPairs})
 */
import { chromium } from 'playwright';
import { UA } from '../ua.mjs';

const PROPS = [
  'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing',
  'color', 'backgroundColor', 'borderRadius', 'borderColor',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'marginTop', 'marginBottom', 'marginLeft', 'marginRight',
  'width', 'height', 'display', 'textAlign',
];
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'path', 'link', 'meta', 'br']);
async function collectPage(browser, url) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent: UA });
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await p.waitForTimeout(1200);
    const els = await p.evaluate((props) => {
      const out = [];
      const counter = new Map();
      const walk = (el, parentPath) => {
        if (out.length > 600) return;
        const children = [...el.children];
        const tagCount = new Map();
        for (const c of children) {
          const tag = c.tagName.toLowerCase();
          if (['script', 'style', 'noscript', 'svg', 'path', 'br'].includes(tag)) continue;
          const cs = getComputedStyle(c);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const clsAttr = c.getAttribute('class') ?? '';
          const cls = clsAttr.split(/\s+/)[0] ?? '';
          const key = parentPath + '/' + tag + (cls ? '.' + cls : '');
          const n = (tagCount.get(key) ?? 0) + 1;
          tagCount.set(key, n);
          const path = `${key}:${n}`;   // 兄弟同签名按序号配对
          const rect = c.getBoundingClientRect();
          if (rect.width > 4 && rect.height > 4) {
            const styles = {};
            for (const prop of props) styles[prop] = cs[prop];
            out.push({ path, text: (c.textContent ?? '').trim().slice(0, 30), styles });
          }
          walk(c, path);
        }
      };
      walk(document.body, 'body');
      return out;
    }, PROPS);
    return els;
  } finally {
    await p.close();
  }
}

export async function probeStyleDiff(srcUrl, cloneUrl, { maxPairs = 25 } = {}) {
  const browser = await chromium.launch();
  try {
    const src = await collectPage(browser, srcUrl);
    const clone = await collectPage(browser, cloneUrl);
    const cloneMap = new Map(clone.map(e => [e.path, e]));
    const diffs = [];
    for (const s of src) {
      const c = cloneMap.get(s.path);
      if (!c) continue;
      const propDiffs = {};
      for (const k of PROPS) {
        const a = s.styles[k], b = c.styles[k];
        if (a !== b && a && b) propDiffs[k] = { src: a, clone: b };
      }
      if (Object.keys(propDiffs).length) diffs.push({ path: s.path, text: s.text, propDiffs });
      if (diffs.length >= maxPairs) break;
    }
    return diffs;
  } finally {
    await browser.close();
  }
}
