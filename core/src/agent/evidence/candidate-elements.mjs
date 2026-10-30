/**
 * candidate-elements — 候选页的逐元素证据（矩形 + 计算样式），以及和参考元素的对齐。
 *
 * 为什么要有它：Bench 已证明「给精确数字」能把同一模型从 68% 提到 95–98%；
 * 但修复包原先只给参考侧样式，模型看不到候选自己差了多少，最后一公里（3px 换行）
 * 只能靠猜。这里在候选页打开时一次性采集可见元素的矩形与计算样式，按
 * 分段根 → 文本 → 图片 → 结构位置 的顺序和参考元素对上，输出
 *   element.cand   { tag, box, style, sectionId }
 *   element.match  { by, confidence }
 *   element.styleDiff [{ prop, ref, cand, delta? }]
 *   element.boxDiff   { x, y, w, h }
 *
 * 纯读取，不写文件，也不碰验收冻结文件。
 */
import {
  INDEX_STYLE_PROPS, compactStyle, normalizeText, styleDiffOf, boxDiffOf, basename,
} from './element-style.mjs';

const round = (v) => Math.round(v * 10) / 10;

/** 在候选页里运行的采集函数；必须自包含、可序列化。 */
export const CAPTURE_CANDIDATE_ELEMENTS = ({ props, maxElements, sectionIds }) => {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'BR']);
  const DROP = new Set(['', 'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)']);
  const r2 = (v) => Math.round(v * 10) / 10;
  const marker = '[data-heimdall-section]';
  const selected = sectionIds?.length
    ? [...document.querySelectorAll(marker)].filter(el => sectionIds.includes(el.getAttribute(marker.slice(1, -1))))
    : [];
  const roots = selected.length ? [...selected, document.body] : [document.body];
  const out = [];
  const seen = new Set();
  const parents = [];
  const walk = (el, depth, root) => {
    if (out.length >= maxElements) return;
    if (SKIP.has(el.tagName)) return;
    if (el !== root && el.closest('svg') && el.tagName.toLowerCase() !== 'svg') return;
    if (seen.has(el)) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width < 1 || r.height < 1) return;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || Number(cs.opacity) <= 0) return;
    seen.add(el);
    const style = {};
    for (const prop of props) {
      const v = cs[prop];
      if (v === undefined || v === null || DROP.has(String(v))) continue;
      style[prop] = String(v).slice(0, 120);
    }
    const direct = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const sectionEl = el.closest(marker);
    const item = {
      i: out.length, tag: el.tagName.toLowerCase(), depth,
      box: { x: r2(r.left + scrollX), y: r2(r.top + scrollY), w: r2(r.width), h: r2(r.height) },
      sectionId: sectionEl ? sectionEl.getAttribute(marker.slice(1, -1)) : null,
      ...(direct ? { text: direct.slice(0, 120) } : {}),
      ...(Object.keys(style).length ? { style } : {}),
    };
    if (el.id) item.id = el.id.slice(0, 60);
    const cls = [...(el.classList ?? [])].slice(0, 3).map(c => c.slice(0, 40)).join('.');
    if (cls) item.cls = cls;
    if (el.hasAttribute(marker.slice(1, -1))) item.root = true;
    if (el.tagName === 'IMG') { item.img = true; item.src = el.currentSrc || el.src; }
    const bgs = [...cs.backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)].map(m => m[1]);
    if (bgs.length) item.img = true;
    if (parents.length) item.parent = parents.at(-1);
    out.push(item);
    parents.push(item.i);
    for (const child of el.children) walk(child, depth + 1, root);
    parents.pop();
  };
  for (const root of roots) walk(root, 0, root);
  return out;
};

/** 读取候选页的元素索引；失败时返回空数组（修复包退回只给参考值）。 */
export async function readCandidateElements(page, { sectionIds = null, props = INDEX_STYLE_PROPS, maxElements = 3000 } = {}) {
  try {
    const list = await page.evaluate(CAPTURE_CANDIDATE_ELEMENTS, { props: [...props], maxElements, sectionIds });
    return Array.isArray(list) ? list.map(item => ({ ...item, style: item.style ? compactStyle(item.style) ?? {} : {} })) : [];
  } catch {
    return [];
  }
}

function sectionBoxFor(refEl, sectionBoxes) {
  if (!refEl.sectionId || !sectionBoxes) return null;
  return sectionBoxes[refEl.sectionId] ?? null;
}

function rootOf(sectionId, index) {
  if (!sectionId) return null;
  return index.find(c => c.root && c.sectionId === sectionId) ?? null;
}

function relativeY(el, root) {
  if (!root) return el.box.y;
  return el.box.y - root.box.y;
}

function scoreCandidate(refEl, cand, { sectionBoxes, index }) {
  let score = 0;
  if (cand.tag === refEl.sel) score += 2;
  if (refEl.sectionId && cand.sectionId === refEl.sectionId) score += 3;
  if (refEl.id && cand.id === refEl.id) score += 2;
  if (refEl.cls && cand.cls && cand.cls.split('.').some(c => refEl.cls.split('.').includes(c))) score += 1;
  if (typeof refEl.depth === 'number' && typeof cand.depth === 'number') {
    score += Math.max(0, 1 - Math.abs(refEl.depth - cand.depth) / 4);
  }

  const refSec = sectionBoxFor(refEl, sectionBoxes);
  const candSec = rootOf(refEl.sectionId, index);
  // 只有两侧都有分段根时才比「段内相对 y」；否则退回整页绝对 y（少一侧就不可比）。
  const bothSections = !!(refSec && candSec);
  const ry = bothSections ? refEl.box.y - refSec.y : refEl.box.y;
  const cy = bothSections ? cand.box.y - candSec.box.y : cand.box.y;
  const dy = Math.abs(ry - cy);
  score += Math.max(0, 3 - dy / 16);

  const rw = Math.max(1, refEl.box.w), cw = Math.max(1, cand.box.w);
  const rh = Math.max(1, refEl.box.h), ch = Math.max(1, cand.box.h);
  score += Math.max(0, 2 - Math.abs(rw - cw) / rw * 2);
  score += Math.max(0, 1 - Math.abs(rh - ch) / rh);
  return { score, dy };
}

/**
 * 把参考元素对到候选元素。返回 { element, by, confidence, score } 或 null。
 * 匹配顺序有明确优先级：分段根 → 文本 → 图片 → 结构位置。
 * 结构位置是最后手段，要求同标签、纵向偏差小；对不上就返回 null，宁可不说。
 */
export function matchCandidateElement(refEl, index, { sectionBoxes = null } = {}) {
  if (!refEl || !Array.isArray(index) || !index.length) return null;
  const refBox = refEl.box;
  if (!refBox) return null;

  if (refEl.ref && /\/e0$/.test(refEl.ref) && refEl.sectionId) {
    const root = rootOf(refEl.sectionId, index);
    if (root) return { element: root, by: 'section-root', confidence: 1, score: 20 };
  }

  let pool = index;
  if (refEl.sectionId) {
    const inSection = index.filter(c => c.sectionId === refEl.sectionId);
    if (inSection.length) pool = inSection;
  }

  const bestOf = (list, base, by) => {
    let best = null;
    for (const cand of list) {
      const { score, dy } = scoreCandidate(refEl, cand, { sectionBoxes, index });
      const total = base + score;
      if (!best || total > best.score) best = { element: cand, by, confidence: Math.min(1, +(total / 16).toFixed(2)), score: total, dy };
    }
    return best;
  };

  const text = normalizeText(refEl.text);
  if (text.length >= 2) {
    const exact = pool.filter(c => normalizeText(c.text) === text);
    if (exact.length) return bestOf(exact, 10, 'text');
    const partial = pool.filter(c => {
      const ct = normalizeText(c.text);
      return ct.length >= 2 && (ct.includes(text) || text.includes(ct));
    });
    if (partial.length) return bestOf(partial, 5, 'text');
  }

  const src = basename(refEl.src);
  if (src) {
    const images = pool.filter(c => c.img && basename(c.src) === src);
    if (images.length) return bestOf(images, 8, 'image');
  }

  // 结构位置：同标签、同分段，纵向相对位置接近。没有文本/图片的块（section、div）走这里。
  if (refEl.sel) {
    const sameTag = pool.filter(c => c.tag === refEl.sel);
    if (sameTag.length) {
      const best = bestOf(sameTag, 0, 'structure');
      if (best && best.dy <= 48 && best.score >= 6) return best;
    }
  }
  return null;
}

/** 给单个参考元素补候选侧证据；不改变参考侧字段。 */
export function enrichElement(e, index, opts = {}) {
  if (!e) return e;
  const match = matchCandidateElement(e, index, opts);
  if (!match) return e;
  const cand = {
    tag: match.element.tag,
    box: match.element.box,
    style: match.element.style ?? {},
    sectionId: match.element.sectionId ?? null,
  };
  const styleDiff = styleDiffOf(e.style, cand.style);
  const boxDiff = boxDiffOf(e.box, cand.box);
  return {
    ...e,
    cand,
    match: { by: match.by, confidence: match.confidence },
    ...(styleDiff.length ? { styleDiff } : { styleDiff: [] }),
    ...(boxDiff ? { boxDiff } : {}),
  };
}

/** 给 elementHints() 的结果补上候选侧证据；不改变参考侧字段。 */
export function enrichElementHints(hints, index, opts = {}) {
  if (!hints) return hints;
  return {
    ...hints,
    best: (hints.best ?? []).map(e => enrichElement(e, index, opts)),
    container: hints.container ? enrichElement(hints.container, index, opts) : null,
  };
}

const overlapArea = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

/**
 * 区域覆盖范围内「确实有样式差」的元素。elementHints 只留 IoU 最高的两个，
 * 字号/颜色这类差异往往落在更小的子元素上（h1、按钮），会漏掉；这里按区域补扫。
 * 返回最多 max 个已 enrich 的元素，按差异条数和覆盖面积排序。
 */
export function styleEvidenceForRegion(regionBox, elements, index, { max = 3, sectionBoxes = null } = {}) {
  if (!regionBox || !Array.isArray(elements) || !index?.length) return [];
  const seen = new Set();
  const found = [];
  for (const e of elements) {
    if (!e?.box || !e.style) continue;
    const area = overlapArea(e.box, regionBox);
    if (!area) continue;
    const key = e.ref ?? `${e.sel}:${e.box.x},${e.box.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const enriched = enrichElement(e, index, { sectionBoxes });
    if (!enriched?.styleDiff?.length) continue;
    if ((enriched.match?.confidence ?? 0) < 0.45) continue;
    found.push({ element: enriched, area });
  }
  found.sort((a, b) => (b.element.styleDiff.length - a.element.styleDiff.length) || (b.area - a.area));
  return found.slice(0, max).map(x => x.element);
}

export { styleDiffOf, boxDiffOf };
