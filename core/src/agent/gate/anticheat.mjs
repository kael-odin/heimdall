/**
 * agent/gate/anticheat — 反作弊（E7-18）
 *
 * 门禁最容易被骗的地方：把参考截图当页面内容贴上去。像素分满分，交付物却一文不值。
 * 三道检查，任意一道命中即判「疑作弊」，由调用方把门禁整体判不过：
 *
 *   1. 源码引用 `.heimdall/ref/`（在 compare 里，命中直接 gate_failed）
 *   2. **大位图与参考截图同构**：候选页里占视口面积 ≥ 20% 的位图，缩成 8×8 灰度做均值哈希，
 *      与参考的整页 / 每条视口高的横带逐一比；汉明距离 ≤ 8/64 即命中。
 *      缩放和裁切都不影响 8×8 均值哈希，所以整页截图、首屏截图都能被认出来。
 *      **不比分段裁片**：hero 这类「一张大图占满分段」的页面上，合规地复用原件资产会和参考裁片
 *      长得几乎一样，拿它去比会把好施工判成作弊（E7-11 本来就要求用原件）。整页 / 整屏粘贴才是真作弊。
 *   3. **文本大量缺失**：参考正文的 2 字词（中文）与 3 字母以上单词，在候选可见文本里覆盖率过低。
 *      这一道是「structure 维度兜底」的最小形态，只在整页范围判，单段重建不判。
 *
 * 这里全是纯函数 + 一个页面内取样函数，不依赖具体浏览器实现，便于单测。
 */
import { lum } from '../evidence/image.mjs';
import { parse } from 'parse5';

const CELLS = 8;
/** 比对了才算数的位图门槛：占视口 60% 以上。整页 / 首屏粘贴都在这条线之上，普通配图不在。 */
export const SUSPECT_MIN_AREA_PCT = 60;

const HIDDEN_STYLE = /display\s*:\s*none|visibility\s*:\s*hidden/i;
const attrOf = (n, name) => n.attrs?.find(a => a.name === name)?.value;

/** 参考 DOM 里的可见正文（隐藏元素、script/style 不算），用来判文本覆盖率 */
export function visibleText(html, { maxChars = 400_000 } = {}) {
  const doc = parse(String(html));
  const out = [];
  let length = 0;
  const walk = (n) => {
    if (length > maxChars) return;
    if (n.tagName === 'script' || n.tagName === 'style' || n.tagName === 'noscript' || n.tagName === 'template') return;
    if (n.tagName && (attrOf(n, 'hidden') !== undefined || attrOf(n, 'aria-hidden') === 'true' || HIDDEN_STYLE.test(attrOf(n, 'style') ?? ''))) return;
    if (n.nodeName === '#text') {
      const t = String(n.value ?? '').replace(/\s+/g, ' ').trim();
      if (t) { out.push(t); length += t.length; }
      return;
    }
    for (const c of n.childNodes ?? []) walk(c);
  };
  walk(doc);
  return out.join(' ');
}

/** 8×8 灰度格 → 64 位哈希（16 个十六进制字符）：与均值比，亮的记 1 */
export function hashFromCells(cells) {
  if (!cells || cells.length !== CELLS * CELLS) throw new Error(`需要 ${CELLS * CELLS} 个灰度值`);
  const mean = cells.reduce((s, v) => s + v, 0) / cells.length;
  let bits = '';
  for (let i = 0; i < cells.length; i += 1) bits += cells[i] >= mean ? '1' : '0';
  let out = '';
  for (let i = 0; i < 64; i += 4) out += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return out;
}

/** PNG（pngjs 的 {width,height,data}）某个纵向区间 → 8×8 平均灰度 */
export function cellsOfPng(img, { y0 = 0, y1 = img.height } = {}) {
  const top = Math.max(0, Math.floor(y0)), bottom = Math.min(img.height, Math.ceil(y1));
  const h = Math.max(1, bottom - top);
  const cells = new Array(CELLS * CELLS).fill(0);
  const counts = new Array(CELLS * CELLS).fill(0);
  for (let ry = 0; ry < h; ry += 1) {
    const cy = Math.min(CELLS - 1, Math.floor(ry / h * CELLS));
    const row = (top + ry) * img.width * 4;
    for (let rx = 0; rx < img.width; rx += 1) {
      const cx = Math.min(CELLS - 1, Math.floor(rx / img.width * CELLS));
      const i = row + rx * 4;
      cells[cy * CELLS + cx] += lum(img.data, i);
      counts[cy * CELLS + cx] += 1;
    }
  }
  return cells.map((v, i) => (counts[i] ? v / counts[i] : 0));
}

export const hashOfPng = (img, opts) => hashFromCells(cellsOfPng(img, opts));

/** 参考一侧要比对的几种「形状」：整页、每条视口高的横带、每个分段的外接框 */
export function referenceShapes(img, { viewportHeight, sections = [] } = {}) {
  const shapes = [{ label: 'page', hash: hashOfPng(img) }];
  if (viewportHeight > 0) {
    for (let i = 0, y = 0; y < img.height; i += 1, y += viewportHeight) {
      shapes.push({ label: `band-${i}`, hash: hashOfPng(img, { y0: y, y1: Math.min(img.height, y + viewportHeight) }) });
    }
  }
  for (const s of sections) {
    const b = s.box;
    if (!b || b.h < 40) continue;
    shapes.push({ label: `section:${s.id}`, hash: hashOfPng(img, { y0: b.y, y1: b.y + b.h }) });
  }
  return shapes;
}

/** 两个等长十六进制哈希的汉明距离（位） */
export function hamming(a, b) {
  if (a.length !== b.length) throw new Error('哈希长度不一致');
  let d = 0;
  for (let i = 0; i < a.length; i += 1) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** 文本 → 可比的特征串：中文按 2 字切片，拉丁按 3 字母以上的词 */
export function textTokens(text) {
  const s = String(text ?? '').normalize('NFKC');
  const tokens = new Set();
  for (const word of s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) tokens.add(word);
  for (const run of s.match(/[㐀-鿿]+/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i += 1) tokens.add(run.slice(i, i + 2));
  }
  return tokens;
}

/** 参考正文在候选可见文本里的覆盖率 */
export function textCoverage(referenceText, candidateText) {
  const ref = textTokens(referenceText), cand = textTokens(candidateText);
  if (ref.size < 20) return { ratio: null, referenceTokens: ref.size, matched: 0, note: '参考文本太少，不判' };
  let matched = 0;
  for (const t of ref) if (cand.has(t)) matched += 1;
  return { ratio: +(matched / ref.size).toFixed(3), referenceTokens: ref.size, matched };
}

/**
 * 在候选页里量「占了足够大面积的位图」，把每张缩成 8×8 灰度带回来。
 * 读像素在页面内做（浏览器能解任意格式），哈希在 Node 里算，两边逻辑只有一份。
 */
export async function collectLargeBitmaps(page, { minAreaPct = 20, maxBitmaps = 12 } = {}) {
  return page.evaluate(async ({ minAreaPct, maxBitmaps }) => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const found = [];
    const urlOf = (el) => {
      if (el.tagName === 'IMG') return el.currentSrc || el.src || '';
      const bg = getComputedStyle(el).backgroundImage || '';
      const m = /url\((['"]?)(.*?)\1\)/.exec(bg);
      return m ? m[2] : '';
    };
    const draw = async (el, url) => {
      const canvas = document.createElement('canvas');
      canvas.width = 8; canvas.height = 8;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      if (el.tagName === 'IMG') {
        if (!el.complete || !el.naturalWidth) return null;
        ctx.drawImage(el, 0, 0, 8, 8);
      } else {
        const img = new Image();
        img.src = url;
        await img.decode();
        ctx.drawImage(img, 0, 0, 8, 8);
      }
      const d = ctx.getImageData(0, 0, 8, 8).data;
      const cells = [];
      for (let i = 0; i < d.length; i += 4) cells.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      return cells;
    };
    const candidates = [];
    for (const el of document.querySelectorAll('img, picture, div, section, header, footer, a, span, body, main')) {
      if (!urlOf(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) continue;
      const areaPct = +(r.width * r.height / (vw * vh) * 100).toFixed(1);
      if (areaPct < minAreaPct) continue;
      candidates.push({ el, r, areaPct });
    }
    candidates.sort((a, b) => b.areaPct - a.areaPct);
    for (const { el, r, areaPct } of candidates.slice(0, maxBitmaps)) {
      const url = urlOf(el);
      try {
        const cells = await draw(el, url);
        if (!cells) continue;
        found.push({ tag: el.tagName.toLowerCase(), areaPct, url: url.slice(0, 200),
          box: { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
          natural: el.tagName === 'IMG' ? { w: el.naturalWidth, h: el.naturalHeight } : null, cells });
      } catch { /* 跨源图片会污染画布：读不到就算了，不当作弊证据 */ }
    }
    return found;
  }, { minAreaPct, maxBitmaps });
}

/**
 * 汇总判定。
 * @param p { bitmaps, referenceShapes, text: {ratio,...} | null, sourceRefs }
 */
export function evaluateAntiCheat({ bitmaps = [], referenceShapes: shapes = [], text = null, sourceRefs = [], maxDistance = 6, minAreaPct = SUSPECT_MIN_AREA_PCT } = {}) {
  const findings = [];
  for (const b of bitmaps) {
    if (b.areaPct < minAreaPct) continue;   // 普通配图不判：只有「整屏 / 整页」的粘贴才算
    const hash = hashFromCells(b.cells);
    let best = null;
    for (const s of shapes) {
      const d = hamming(hash, s.hash);
      if (!best || d < best.distance) best = { label: s.label, distance: d };
    }
    if (best && best.distance <= maxDistance) {
      findings.push({ code: 'reference_screenshot_reused', severity: 'error',
        detail: `${b.tag} 占视口 ${b.areaPct}%，与参考的 ${best.label} 画像相同（距离 ${best.distance}/64）：${b.url}`,
        element: { tag: b.tag, box: b.box, areaPct: b.areaPct, hash, matched: best.label, distance: best.distance } });
    }
  }
  // 文本缺失**不判作弊**：空页面是没写完，不是骗分。它由门禁的 structure 维度扣分
  // （PRD E7-18 原文：文本大量缺失由 structure 兜底）。这里只当提示。
  if (text && typeof text.ratio === 'number') {
    if (text.ratio < 0.3) findings.push({ code: 'text_missing', severity: 'warn', detail: `参考正文只有 ${(text.ratio * 100).toFixed(0)}% 出现在候选页里（${text.matched}/${text.referenceTokens}）` });
    else if (text.ratio < 0.5) findings.push({ code: 'text_sparse', severity: 'warn', detail: `参考正文覆盖 ${(text.ratio * 100).toFixed(0)}%，偏低（${text.matched}/${text.referenceTokens}）` });
  }
  for (const s of sourceRefs) findings.push({ code: 'source_references_reference_pack', severity: 'error', detail: s });
  const status = findings.some(f => f.severity === 'error') ? 'suspect' : 'clean';
  return { status, findings, stats: { bitmapsScanned: bitmaps.length, referenceShapes: shapes.length, textCoverage: text?.ratio ?? null } };
}
