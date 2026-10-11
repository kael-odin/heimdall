/**
 * differ/shape — 差异的**形态**分析（不只是总量）
 *
 * 为什么需要：两个页面都可能是 96% 像素相似，但含义完全相反 ——
 *
 *   · 一处图片没抓到   → 差异集中在一块大区域，**是内容缺失**
 *   · 全页文字抗锯齿略不同 → 差异碎成几千个小点，**是渲染差异**
 *
 * 只给一个百分比，用户没法分辨这两者，只能自己去翻 diff 热图。
 * 实测来源：ant.design 克隆得 95.96%，看着不高，但差异是 2801 个连通块、
 * 前 5 块只占 5% —— 全落在标题与按钮的字形边缘上，没有一处内容缺失。
 * 而一个真正坏掉的克隆会长成完全相反的样子。
 *
 * 判据用「前 5 大连通块占总差异的比例」：
 *   集中（≥40%）→ 少数区域出问题，去查那些区域
 *   混合         → 两者都有
 *   弥散（≤12%）→ 碎在边缘上，多为抗锯齿/亚像素差异
 *
 * 差异小到不足画面千分之一时不下判断（negligible）—— 那个量级上"连通块只有几个"
 * 是必然的，判成"集中"只会把用户支使去查几十像素的噪声。
 */

const SEEN = 1, DIFF = 2;

/**
 * @param {Uint8Array|Buffer} rgba pixelmatch 输出图（差异像素画成红色）
 * @param {number} width
 * @param {number} height
 * @param {{redThreshold?:number, greenMax?:number, maxBlobs?:number}} [opts]
 */
export function analyzeDiffShape(rgba, width, height, opts = {}) {
  const redT = opts.redThreshold ?? 200;
  const greenMax = opts.greenMax ?? 120;
  const maxBlobs = opts.maxBlobs ?? 20000;
  const W = width, H = height;

  // 差异掩码
  const mask = new Uint8Array(W * H);
  let pixels = 0;
  for (let i = 0; i < W * H; i++) {
    const p = i * 4;
    if (rgba[p] > redT && rgba[p + 1] < greenMax) { mask[i] = DIFF; pixels++; }
  }
  if (!pixels) return { pixels: 0, blobs: 0, largest: 0, top5Share: 0, shape: 'identical' };

  // 连通块（4 邻域，显式栈）
  const state = new Uint8Array(W * H);
  const sizes = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (mask[start] !== DIFF || state[start] === SEEN) continue;
    let sp = 0;
    stack[sp++] = start;
    state[start] = SEEN;
    let count = 0;
    while (sp > 0) {
      const i = stack[--sp];
      count++;
      const x = i % W, y = (i / W) | 0;
      if (x > 0) { const j = i - 1; if (mask[j] === DIFF && state[j] !== SEEN) { state[j] = SEEN; stack[sp++] = j; } }
      if (x < W - 1) { const j = i + 1; if (mask[j] === DIFF && state[j] !== SEEN) { state[j] = SEEN; stack[sp++] = j; } }
      if (y > 0) { const j = i - W; if (mask[j] === DIFF && state[j] !== SEEN) { state[j] = SEEN; stack[sp++] = j; } }
      if (y < H - 1) { const j = i + W; if (mask[j] === DIFF && state[j] !== SEEN) { state[j] = SEEN; stack[sp++] = j; } }
    }
    sizes.push(count);
    if (sizes.length > maxBlobs) break;   // 极端情况兜底，别把内存吃光
  }

  sizes.sort((a, b) => b - a);
  const top5 = sizes.slice(0, 5).reduce((s, v) => s + v, 0);
  const top5Share = +(top5 / pixels).toFixed(4);

  // 差异太小就先别下判断。像素少到一定程度时，"连通块只有几个"是必然的，
  // 于是 top5Share 恒为 1 → 必然判成"集中" → 让用户去查几块其实只有几十像素的区域。
  // 实测 vitest.dev 修好字体后只剩 562px（6 块，最大 164px），就是这样被误报的。
  const share = pixels / (W * H);
  if (share < (opts.negligibleShare ?? 0.001)) {
    return { pixels, blobs: sizes.length, largest: sizes[0] ?? 0, top5Share, share: +share.toFixed(5), shape: 'negligible' };
  }

  const shape = top5Share >= 0.4 ? 'concentrated' : (top5Share <= 0.12 ? 'diffuse' : 'mixed');
  return { pixels, blobs: sizes.length, largest: sizes[0] ?? 0, top5Share, share: +share.toFixed(5), shape };
}

/** 给报告用的一句话解释 */
export function shapeNote(shape) {
  if (shape === 'identical') return '两图逐像素一致。';
  if (shape === 'negligible') return '差异极小（不足画面千分之一），可视为一致。';
  if (shape === 'concentrated') return '差异集中在少数区域 —— 大概率是内容缺失或错位，去查 diff 热图里的那几块。';
  if (shape === 'diffuse') return '差异碎成大量小点，集中在文字/图形边缘 —— 多为抗锯齿与亚像素渲染差异，通常不是内容缺失。';
  return '差异既有成片区域也有碎点 —— 两者都看一下。';
}
