/**
 * agent/evidence/fixpacket — 修复包 v1：行对齐 → 差异 → ±1px 容差 → 区域 → 原因 → 排序 → 裁剪（E6-10）
 *
 * 由 Phase 0 S1 原型转正（PRD 05 §3.1；S1 在两页三视口 216 个注入缺陷上前 3 条命中 86%）。
 * 与草案不同、由 S1 验证过的几处：
 *   · 像素差之前先做**行对齐**：上方一个块高度变了，下方整页都会错位；对齐后差异只剩真正改动的那一段。
 *   · 高度变了的段保留顶对齐 / 底对齐两种映射，「被推开的内容」单独报，多栏里只有一栏被推开也说得清。
 *   · ±1px 容差只用来找区域和排序；门禁的像素分照旧逐像素直接比。
 *   · 排序做级联修正（根排在果前）与集中度修正（零散的渲染噪声降权）。
 *
 * 门禁口径（PRD 05 §1.2，Phase 0 改）：pixelSimilarity 用 verify/compare.mjs 的规则
 * （pixelmatch threshold 0.1、并集面积），与验收正式裁判同一个函数；maxBlob 在同一张 pixelmatch 差异图上算。
 * diff.mjs 的「任一通道差 > 24」只作 pixelChannel 留给旧的克隆评分对照。
 *
 * 修复包里 Heimdall 自己写的字段（hint）只用区域与元素的 ID，不拼接网页字符串（PRD 08 §3.2(d)）；
 * 来自参考页的选择器只保留选择器安全字符，网页文字放进 element.text，由调用方列入 trust.untrustedPaths。
 */
import pixelmatch from 'pixelmatch';
import { analyzeDiffShape } from '../../differ/shape.mjs';
import { CHANNEL_T, lum, hex, cropRows, diffOverlay, stack, downscale, writePng } from './image.mjs';

const differs = (a, i, b, j) => Math.abs(a[i] - b[j]) > CHANNEL_T
  || Math.abs(a[i + 1] - b[j + 1]) > CHANNEL_T || Math.abs(a[i + 2] - b[j + 2]) > CHANNEL_T;

// ---------------------------------------------------------------------------
// 1. 门禁口径的像素分（不对齐）
// ---------------------------------------------------------------------------

/**
 * 门禁口径的整页度量（顶对齐，缺失区域整块算差，分母取两图的并集面积）：
 *   pixelSimilarity —— pixelmatch threshold 0.1（verify/compare.mjs、验收正式裁判同一规则）
 *   pixelChannel    —— diff.mjs 规则（任一通道差 > 24），只作历史对照
 *   maxBlobPct      —— 同一张 pixelmatch 差异图上最大 4 邻域连通块占**视口**面积（W × 视口高）的百分数
 *   maxBlobPagePct  —— 同一块占整页并集面积的百分数（S2 反馈：只给视口口径时，「最大块大于总损失」会误导模型）
 * dyn 是参考坐标系里的动态遮罩：被遮住的像素先把候选改成与参考相同，再交给 pixelmatch。
 */
export function directMetrics(ref, cand, viewportHeight, dyn = null) {
  const ow = Math.min(ref.width, cand.width), oh = Math.min(ref.height, cand.height);
  const W = Math.max(ref.width, cand.width), H = Math.max(ref.height, cand.height);
  const sub = (img) => {
    const out = Buffer.alloc(ow * oh * 4);
    for (let y = 0; y < oh; y++) img.data.copy(out, y * ow * 4, y * img.width * 4, (y * img.width + ow) * 4);
    return out;
  };
  const a = sub(ref), b = sub(cand);
  let masked = 0, changed = 0;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const i = (y * ow + x) * 4;
    if (dyn && dyn[y * ref.width + x]) { masked++; b[i] = a[i]; b[i + 1] = a[i + 1]; b[i + 2] = a[i + 2]; b[i + 3] = a[i + 3]; continue; }
    if (differs(a, i, b, i)) changed++;
  }
  const overlapDiff = Buffer.alloc(ow * oh * 4);
  const pm = ow && oh ? pixelmatch(a, b, overlapDiff, ow, oh, { threshold: 0.1 }) : 0;
  // 拼回整幅：只有一侧有的像素算完整差异（与 compare.mjs 相同，画成品红）
  const rgba = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) {
    if (y < oh) overlapDiff.copy(rgba, y * W * 4, y * ow * 4, (y + 1) * ow * 4);
    for (let x = y < oh ? ow : 0; x < W; x++) {
      const inA = x < ref.width && y < ref.height, inB = x < cand.width && y < cand.height;
      if (inA !== inB) { const k = (y * W + x) * 4; rgba[k] = 255; rgba[k + 1] = 0; rgba[k + 2] = 255; rgba[k + 3] = 255; }
    }
  }
  const union = ref.width * ref.height + cand.width * cand.height - ow * oh;
  const missing = union - ow * oh;
  const shape = analyzeDiffShape(rgba, W, H, { maxBlobs: 1e7 });
  const denom = Math.max(1, union - masked);
  return {
    pixelSimilarity: +Math.max(0, 1 - (pm + missing) / denom).toFixed(5),
    pixelChannel: +Math.max(0, 1 - (changed + missing) / denom).toFixed(5),
    maxBlobPx: shape.largest ?? 0,
    maxBlobPct: +((shape.largest ?? 0) / (ref.width * viewportHeight) * 100).toFixed(3),
    maxBlobPagePct: +((shape.largest ?? 0) / Math.max(1, union) * 100).toFixed(3),
    diffShape: shape.shape,
    blobs: shape.blobs,
    size: { ref: { w: ref.width, h: ref.height }, cand: { w: cand.width, h: cand.height } },
    heightDelta: cand.height - ref.height,
    maskedPx: masked,
  };
}

// ---------------------------------------------------------------------------
// 2. 行对齐（patience diff：唯一行做锚点 → 递归 → 共同前后缀）
// ---------------------------------------------------------------------------

export function rowSignatures(img, width = img.width) {
  const { data } = img;
  const H = img.height, stride = img.width * 4;
  const hash = new Uint32Array(H), uniform = new Uint8Array(H);
  for (let y = 0; y < H; y++) {
    const base = y * stride;
    const r0 = data[base], g0 = data[base + 1], b0 = data[base + 2];
    let h = 0x811c9dc5, same = 1;
    for (let x = 0; x < width; x++) {
      const i = base + x * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (same && (r !== r0 || g !== g0 || b !== b0)) same = 0;
      h = Math.imul(h ^ r, 0x01000193);
      h = Math.imul(h ^ g, 0x01000193);
      h = Math.imul(h ^ b, 0x01000193);
    }
    hash[y] = h >>> 0;
    uniform[y] = same;
  }
  return { hash, uniform };
}

function lis(pairs) {
  const tails = [], tailIdx = [], prev = new Int32Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i][1];
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < v) lo = mid + 1; else hi = mid; }
    tails[lo] = v; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const out = [];
  let k = tails.length ? tailIdx[tails.length - 1] : -1;
  while (k >= 0) { out.push(pairs[k]); k = prev[k]; }
  return out.reverse();
}

function uniqueAnchors(R, C, r0, r1, c0, c1) {
  const m = new Map();
  for (let y = r0; y < r1; y++) {
    if (R.uniform[y]) continue;
    const h = R.hash[y];
    let e = m.get(h);
    if (!e) { e = [0, -1, 0, -1]; m.set(h, e); }
    e[0]++; e[1] = y;
  }
  for (let y = c0; y < c1; y++) {
    if (C.uniform[y]) continue;
    const e = m.get(C.hash[y]);
    if (e) { e[2]++; e[3] = y; }
  }
  // 截图里两行像素碰巧一样并不罕见（卡片边框、分隔线）。孤立的一行若把偏移拉到别处，
  // 会造成「删 12 行再插 12 行」的假对齐（S1 实测）；所以锚点要么与区间两端的偏移一致，
  // 要么前后至少连着 3 行在同一偏移上相等
  const off0 = c0 - r0, off1 = c1 - r1;
  const pairs = [];
  for (const e of m.values()) {
    if (e[0] !== 1 || e[2] !== 1) continue;
    const r = e[1], c = e[3], off = c - r;
    if (off !== off0 && off !== off1) {
      let run = 1;
      for (let k = 1; k < 3 && r + k < r1 && c + k < c1 && R.hash[r + k] === C.hash[c + k]; k++) run++;
      for (let k = 1; k < 3 && r - k >= r0 && c - k >= c0 && R.hash[r - k] === C.hash[c - k]; k++) run++;
      if (run < 3) continue;
    }
    pairs.push([r, c]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  return lis(pairs);
}

/** 一段行映射下逐行比对的代价（抽样），用来在顶对齐 / 底对齐之间选默认 */
function bandMatchCost(ref, cand, W, r0, rows) {
  let cost = 0;
  for (let i = 0; i < rows.length; i++) {
    const cy = rows[i];
    if (cy < 0) { cost += W; continue; }
    const rb = (r0 + i) * ref.width * 4, cb = cy * cand.width * 4;
    for (let x = 0; x < W; x += 3) if (differs(ref.data, rb + x * 4, cand.data, cb + x * 4)) cost += 3;
  }
  return cost;
}

/** 一段行是否全是同一种颜色的纯色行（用来认「±1 行空白伸缩」） */
function uniformSame(ref, R, r0, r1, cand, C, c0, c1) {
  let color = null;
  const check = (img, sig, a, b) => {
    for (let y = a; y < b; y++) {
      if (!sig.uniform[y]) return false;
      const i = y * img.width * 4;
      const c = (img.data[i] << 16) | (img.data[i + 1] << 8) | img.data[i + 2];
      if (color === null) color = c; else if (c !== color) return false;
    }
    return true;
  };
  return check(ref, R, r0, r1) && check(cand, C, c0, c1);
}

export function alignRows(ref, cand, { maxDepth = 32 } = {}) {
  const W = Math.min(ref.width, cand.width);
  const R = rowSignatures(ref, W), C = rowSignatures(cand, W);
  const ops = [];
  const pushEqual = (r, c, len) => {
    if (len <= 0) return;
    const last = ops[ops.length - 1];
    if (last && last.type === 'equal' && last.r + last.len === r && last.c + last.len === c) last.len += len;
    else ops.push({ type: 'equal', r, c, len });
  };
  const recurse = (r0, r1, c0, c1, depth) => {
    let p = 0;
    while (r0 + p < r1 && c0 + p < c1 && R.hash[r0 + p] === C.hash[c0 + p]) p++;
    pushEqual(r0, c0, p); r0 += p; c0 += p;
    let s = 0;
    while (r1 - s > r0 && c1 - s > c0 && R.hash[r1 - 1 - s] === C.hash[c1 - 1 - s]) s++;
    const sr = r1 - s, sc = c1 - s;
    if (sr > r0 || sc > c0) {
      const anchors = depth < maxDepth && sr > r0 && sc > c0 ? uniqueAnchors(R, C, r0, sr, c0, sc) : [];
      if (!anchors.length) ops.push({ type: 'band', r0, r1: sr, c0, c1: sc });
      else {
        let pr = r0, pc = c0;
        for (const [ar, ac] of anchors) { recurse(pr, ar, pc, ac, depth + 1); pushEqual(ar, ac, 1); pr = ar + 1; pc = ac + 1; }
        recurse(pr, sr, pc, sc, depth + 1);
      }
    }
    pushEqual(sr, sc, s);
  };
  recurse(0, ref.height, 0, cand.height, 0);

  const candRow = new Int32Array(ref.height).fill(-1);
  const bandOf = new Int32Array(ref.height).fill(-1);
  const bands = [];
  let equalRows = 0;
  for (const op of ops) {
    if (op.type === 'equal') {
      for (let i = 0; i < op.len; i++) candRow[op.r + i] = op.c + i;
      equalRows += op.len;
      continue;
    }
    const Lr = op.r1 - op.r0, Lc = op.c1 - op.c0, n = Math.min(Lr, Lc);
    const kind = Lr === 0 ? 'insert' : Lc === 0 ? 'delete' : Lr === Lc ? 'replace' : 'resize';
    const b = { kind, r0: op.r0, r1: op.r1, c0: op.c0, c1: op.c1, Lr, Lc, delta: Lc - Lr, anchor: 'top' };
    // ±1 行纯色空白的伸缩：亚像素 / 1px 错位被行对齐吸收后留下的「接缝」，不是缺陷
    if (Math.abs(Lc - Lr) <= 1 && uniformSame(ref, R, op.r0, op.r1, cand, C, op.c0, op.c1)) b.elastic = true;
    const top = new Int32Array(Lr).fill(-1);
    for (let i = 0; i < n; i++) top[i] = op.c0 + i;
    b.rows = top;
    if (kind === 'resize') {
      // 高度变了的段同时保留两种映射：顶对齐（段内内容没动）与底对齐（段内内容整体移了 delta）。
      // 比对时两种映射下都对不上的像素才算差异；只在底对齐下对得上的，是「被推开的内容」。
      const bottom = new Int32Array(Lr).fill(-1);
      for (let i = 0; i < n; i++) bottom[Lr - 1 - i] = op.c1 - 1 - i;
      b.rowsTop = top; b.rowsBottom = bottom;
      if (bandMatchCost(ref, cand, W, op.r0, bottom) < bandMatchCost(ref, cand, W, op.r0, top)) { b.anchor = 'bottom'; b.rows = bottom; }
    }
    if (kind === 'insert') b.insert = { c0: op.c0, c1: op.c1, refY: op.r0 };
    for (let i = 0; i < Lr; i++) { candRow[op.r0 + i] = b.rows[i]; bandOf[op.r0 + i] = bands.length; }
    bands.push(b);
  }
  // 「先插 k 行、过一段再删 k 行」（或反过来）= 中间那段内容整体上下移了 k px，而它所在的行里没有别的东西。
  // 行对齐把它吸收成两条接缝；这里把这对接缝还原成一个 shift 区域（S1 实测：3px 的 translate 就是这样）
  const pairs = [];
  const real = bands.map((b, i) => [b, i]).filter(([b]) => !b.elastic);
  for (let k = 0; k + 1 < real.length; k++) {
    const [a, ia] = real[k], [b, ib] = real[k + 1];
    const insThenDel = a.kind === 'insert' && b.kind === 'delete' && a.Lc === b.Lr;
    const delThenIns = a.kind === 'delete' && b.kind === 'insert' && a.Lr === b.Lc;
    const size = insThenDel ? a.Lc : delThenIns ? a.Lr : 0;
    if (size < 2 || b.r0 - a.r0 > 1200) continue;
    a.paired = b.paired = true;
    const y0 = insThenDel ? a.r0 : a.r1, y1 = b.r0;
    pairs.push({ y0, y1: insThenDel ? b.r1 : y1, contentTop: y0, contentBottom: y1, dy: insThenDel ? size : -size, off: a.c0 - a.r0, bands: [ia, ib] });
    k++;
  }
  return { candRow, bandOf, bands, pairs, equalRows, share: +(equalRows / Math.max(1, ref.height)).toFixed(4), width: W };
}

/** 成对接缝 → shift 区域：横向范围取被移动内容所在的非纯色列；diffPx 按不对齐时的差异像素计 */
export function pairRegions(ref, cand, align) {
  const out = [];
  const W = align.width;
  for (const p of align.pairs) {
    let x0 = Infinity, x1 = -1;
    for (let y = p.contentTop; y < p.contentBottom; y++) {
      const base = y * ref.width * 4;
      for (let x = 0; x < W; x++) if (differs(ref.data, base + x * 4, ref.data, base)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    if (x1 < 0) continue;
    const y0 = p.dy > 0 ? p.contentTop : p.contentTop + p.dy, y1 = p.dy > 0 ? p.contentBottom + p.dy : p.contentBottom;
    let diffPx = 0;
    for (let y = Math.max(0, y0); y < Math.min(ref.height, y1); y++) {
      const cy = y + p.off;
      if (cy < 0 || cy >= cand.height) { diffPx += x1 - x0 + 1; continue; }
      for (let x = x0; x <= x1; x++) if (differs(ref.data, (y * ref.width + x) * 4, cand.data, (cy * cand.width + x) * 4)) diffPx++;
    }
    out.push({ kind: 'pairshift', x: x0, y: Math.max(0, y0), w: x1 - x0 + 1, h: Math.min(ref.height, y1) - Math.max(0, y0), diffPx, pair: p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. 对齐后的差异掩码 → 区域
// ---------------------------------------------------------------------------

/**
 * 返回两张掩码：
 *   mask  —— 真差异（高度变了的段里：顶对齐、底对齐两种映射下都对不上）
 *   moved —— 被推开的内容（顶对齐下对不上、底对齐下对得上：内容本身没变，只是位置移了 delta）
 */
export function alignedMask(ref, cand, align, dyn = null) {
  const W = ref.width, H = ref.height, Wc = Math.min(ref.width, cand.width);
  const mask = new Uint8Array(W * H), moved = new Uint8Array(W * H);
  let n = 0, nMoved = 0;
  const perBand = new Map();
  for (let y = 0; y < H; y++) {
    const bi = align.bandOf[y];
    const band = bi >= 0 ? align.bands[bi] : null;
    if (band?.elastic || band?.paired) continue;
    const off = y * W;
    const resize = band?.kind === 'resize';
    const top = resize ? band.rowsTop[y - band.r0] : align.candRow[y];
    const bottom = resize ? band.rowsBottom[y - band.r0] : -1;
    let bd = 0, bm = 0;
    for (let x = 0; x < W; x++) {
      const k = off + x;
      if (dyn && dyn[k]) continue;
      if (x >= Wc) { mask[k] = 1; n++; bd++; continue; }
      const dTop = top < 0 || differs(ref.data, k * 4, cand.data, (top * cand.width + x) * 4);
      if (!dTop) continue;
      if (resize) {
        const dBottom = bottom < 0 || differs(ref.data, k * 4, cand.data, (bottom * cand.width + x) * 4);
        if (!dBottom) { moved[k] = 1; nMoved++; bm++; continue; }
      }
      mask[k] = 1; n++; bd++;
    }
    if (band) { const s = perBand.get(bi) ?? { diff: 0, moved: 0 }; s.diff += bd; s.moved += bm; perBand.set(bi, s); }
  }
  return { mask, n, moved, nMoved, perBand, width: W, height: H };
}

/**
 * ±1px 容差：一个差异像素，若它的值落在对侧 3×3 邻域的取值范围内（每通道放宽 T），
 * 且对侧像素同样落在本侧邻域范围内，就视为抗锯齿 / 亚像素错位，不进区域。
 * 高度变了的段里，两种映射任一能解释就算解释得了。
 *
 * 为什么要它：S1 冒烟实测，25% 的文字元素做 0.5–1px 抖动（模拟重建里常见的亚像素偏差），
 * 抖动产生的差异块比真正的缺陷还大，缺陷在排序里掉到第 18–26 位。
 * 门禁的像素分仍按严格口径算；容差只用于「该先看哪块」。
 */
export function tolerate(dm, ref, cand, align, { T = 12 } = {}) {
  const { mask, width: W, height: H } = dm;
  const out = new Uint8Array(mask.length);
  let n = 0;
  const Wc = Math.min(W, cand.width);
  const explained = (A, ax, ay, B, bx, by) => {
    const ia = (ay * A.width + ax) * 4;
    for (let c = 0; c < 3; c++) {
      let mn = 255, mx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = by + dy;
        if (yy < 0 || yy >= B.height) continue;
        const row = yy * B.width;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = bx + dx;
          if (xx < 0 || xx >= B.width) continue;
          const v = B.data[(row + xx) * 4 + c];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      const v = A.data[ia + c];
      if (v < mn - T || v > mx + T) return false;
    }
    return true;
  };
  const ok = (x, y, cy) => cy >= 0 && explained(ref, x, y, cand, x, cy) && explained(cand, x, cy, ref, x, y);
  for (let y = 0; y < H; y++) {
    const bi = align.bandOf[y];
    const band = bi >= 0 ? align.bands[bi] : null;
    const resize = band?.kind === 'resize';
    const cy = resize ? band.rowsTop[y - band.r0] : align.candRow[y];
    const cy2 = resize ? band.rowsBottom[y - band.r0] : -1;
    // ±1 行的删减：缺的那一行用最近的已对应候选行来解释（1px 错位留下的接缝）
    let near = -1;
    if (cy < 0 && band && Math.abs(band.delta) <= 1) {
      if (y > 0 && align.candRow[y - 1] >= 0) near = Math.min(cand.height - 1, align.candRow[y - 1] + 1);
      else if (y + 1 < H && align.candRow[y + 1] >= 0) near = Math.max(0, align.candRow[y + 1] - 1);
    }
    const off = y * W;
    for (let x = 0; x < W; x++) {
      const k = off + x;
      if (!mask[k]) continue;
      if (near >= 0 && x < Wc && explained(ref, x, y, cand, x, near)) continue;
      if (x >= Wc || !(ok(x, y, cy) || (resize && ok(x, y, cy2)))) { out[k] = 1; n++; }
    }
  }
  return { ...dm, mask: out, n };
}

/** 盒式膨胀（半径 r 个格子）：横向两遍、纵向两遍，各记最近一次命中的位置 */
function dilate(occ, CW, CH, r) {
  const tmp = new Uint8Array(CW * CH), out = new Uint8Array(CW * CH);
  for (let y = 0; y < CH; y++) {
    const row = y * CW;
    let last = -Infinity;
    for (let x = 0; x < CW; x++) { if (occ[row + x]) last = x; if (x - last <= r) tmp[row + x] = 1; }
    last = Infinity;
    for (let x = CW - 1; x >= 0; x--) { if (occ[row + x]) last = x; if (last - x <= r) tmp[row + x] = 1; }
  }
  for (let x = 0; x < CW; x++) {
    let last = -Infinity;
    for (let y = 0; y < CH; y++) { if (tmp[y * CW + x]) last = y; if (y - last <= r) out[y * CW + x] = 1; }
    last = Infinity;
    for (let y = CH - 1; y >= 0; y--) { if (tmp[y * CW + x]) last = y; if (last - y <= r) out[y * CW + x] = 1; }
  }
  return out;
}

export function regionsFromMask({ mask, width: W, height: H }, { cell = 4, radius = 3, minPx = 12 } = {}) {
  const CW = Math.ceil(W / cell), CH = Math.ceil(H / cell);
  const count = new Uint32Array(CW * CH);
  for (let y = 0; y < H; y++) {
    const crow = ((y / cell) | 0) * CW, off = y * W;
    for (let x = 0; x < W; x++) if (mask[off + x]) count[crow + ((x / cell) | 0)]++;
  }
  const occ = new Uint8Array(CW * CH);
  for (let i = 0; i < occ.length; i++) occ[i] = count[i] > 0 ? 1 : 0;
  const dil = dilate(occ, CW, CH, radius);
  const label = new Int32Array(CW * CH).fill(-1);
  const stackBuf = new Int32Array(CW * CH);
  const comps = [];
  let speckles = 0, specklePx = 0;
  for (let s = 0; s < CW * CH; s++) {
    if (!dil[s] || label[s] >= 0) continue;
    let sp = 0; stackBuf[sp++] = s; label[s] = comps.length;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, px = 0;
    while (sp) {
      const i = stackBuf[--sp];
      const cx = i % CW, cy = (i / CW) | 0;
      if (count[i]) { px += count[i]; if (cx < x0) x0 = cx; if (cx > x1) x1 = cx; if (cy < y0) y0 = cy; if (cy > y1) y1 = cy; }
      if (cx > 0 && dil[i - 1] && label[i - 1] < 0) { label[i - 1] = label[s]; stackBuf[sp++] = i - 1; }
      if (cx < CW - 1 && dil[i + 1] && label[i + 1] < 0) { label[i + 1] = label[s]; stackBuf[sp++] = i + 1; }
      if (cy > 0 && dil[i - CW] && label[i - CW] < 0) { label[i - CW] = label[s]; stackBuf[sp++] = i - CW; }
      if (cy < CH - 1 && dil[i + CW] && label[i + CW] < 0) { label[i + CW] = label[s]; stackBuf[sp++] = i + CW; }
    }
    if (px < minPx) { speckles++; specklePx += px; comps.push(null); continue; }
    comps.push({ x0, y0, x1, y1, px });
  }
  const out = [];
  for (const c of comps) {
    if (!c) continue;
    // 收紧到真实差异像素的外接框
    let bx0 = Infinity, by0 = Infinity, bx1 = -1, by1 = -1;
    const X0 = c.x0 * cell, X1 = Math.min(W, (c.x1 + 1) * cell), Y0 = c.y0 * cell, Y1 = Math.min(H, (c.y1 + 1) * cell);
    for (let y = Y0; y < Y1; y++) {
      const off = y * W;
      for (let x = X0; x < X1; x++) if (mask[off + x]) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    }
    out.push({ kind: 'diff', x: bx0, y: by0, w: bx1 - bx0 + 1, h: by1 - by0 + 1, diffPx: c.px });
  }
  return { regions: out, speckles, specklePx };
}

/**
 * 候选独有的行单独成区域，坐标放在参考坐标系的插入点上：
 *   纯插入段；以及高度变了、但两种映射下都既无差异也无移动像素的段（多出来的只有空白）
 */
export function insertRegions(cand, align, perBand = new Map(), ref = null) {
  const out = [];
  for (const [bi, b] of align.bands.entries()) {
    if (b.elastic || b.paired) continue;
    if (ref && b.kind === 'insert' && b.Lc === 1 && seamRow(cand, b.c0, ref, b.r0)) continue;
    let ins = b.insert;
    if (!ins && b.kind === 'resize' && b.delta > 0) {
      const s = perBand.get(bi) ?? { diff: 0, moved: 0 };
      if (s.diff === 0 && s.moved === 0) ins = b.anchor === 'top' ? { c0: b.c0 + b.Lr, c1: b.c1, refY: b.r1 } : { c0: b.c0, c1: b.c0 + b.delta, refY: b.r0 };
    }
    if (!ins) continue;
    const { c0, c1, refY } = ins;
    const h = c1 - c0;
    // 横向范围：与该段首行颜色不同的列
    let x0 = Infinity, x1 = -1;
    const W = align.width;
    const bgI = c0 * cand.width * 4;
    for (let y = c0; y < c1; y++) {
      const rb = y * cand.width * 4;
      for (let x = 0; x < W; x++) if (differs(cand.data, rb + x * 4, cand.data, bgI)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    const blankRows = x1 < 0;
    if (blankRows) { x0 = 0; x1 = W - 1; }
    out.push({ kind: 'insert', x: x0, y: refY, w: x1 - x0 + 1, h, diffPx: h * (x1 - x0 + 1), cand: { x: x0, y: c0, w: x1 - x0 + 1, h }, blankRows, band: b });
  }
  return out;
}

/** 候选的一行能否被参考在插入点附近（上下各一行）的 3×3 取值范围解释 —— 能，就是 1px 接缝 */
function seamRow(cand, cy, ref, ry) {
  const W = Math.min(cand.width, ref.width);
  for (let x = 0; x < W; x++) {
    const i = (cy * cand.width + x) * 4;
    for (let c = 0; c < 3; c++) {
      let mn = 255, mx = 0;
      for (let yy = Math.max(0, ry - 1); yy <= Math.min(ref.height - 1, ry); yy++) {
        for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) {
          const v = ref.data[(yy * ref.width + xx) * 4 + c];
          if (v < mn) mn = v; if (v > mx) mx = v;
        }
      }
      const v = cand.data[i + c];
      if (v < mn - 12 || v > mx + 12) return false;
    }
  }
  return true;
}

const inter = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};
export const iou = (a, b) => { const i = inter(a, b); return i ? i / (a.w * a.h + b.w * b.h - i) : 0; };
export const interArea = inter;

/**
 * 按参考元素归并：两个差异区域都（≥ 80%）落在同一个紧凑元素里（元素面积 ≤ 两区域外接框的 4 倍），就并成一个。
 * S1 实测：一张留白多的插图被藏掉，差异会碎成 2–3 块，每块都不到整图一半；手风琴标题的文字与箭头也会分开。
 */
export function groupByElement(regions, elements) {
  const list = regions.slice();
  const near = (a, b) => !(a.x > b.x + b.w + 200 || b.x > a.x + a.w + 200 || a.y > b.y + b.h + 200 || b.y > a.y + a.h + 200);
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.kind !== 'diff' || b.kind !== 'diff' || !near(a, b)) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const u = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
        let host = null;
        for (const e of elements) {
          const ea = e.box.w * e.box.h;
          if (ea > 4 * u.w * u.h || inter(a, e.box) < 0.8 * a.w * a.h || inter(b, e.box) < 0.8 * b.w * b.h) continue;
          if (!host || ea < host.box.w * host.box.h) host = e;
        }
        if (!host) continue;
        list[i] = { kind: 'diff', ...u, diffPx: a.diffPx + b.diffPx, groupedBy: host.sel };
        list.splice(j, 1);
        changed = true;
        break outer;
      }
    }
  }
  return list;
}

/** 合并：外接框重叠达到较小框面积 30% 的区域；插入区域与紧贴的同段差异区域合并 */
export function mergeRegions(regions) {
  let list = regions.slice();
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        let merge = false;
        if (a.kind === 'insert' || b.kind === 'insert') {
          const ins = a.kind === 'insert' ? a : b, other = a.kind === 'insert' ? b : a;
          if (other.kind !== 'insert') {
            const touches = ins.y >= other.y - 8 && ins.y <= other.y + other.h + 8
              && Math.min(ins.x + ins.w, other.x + other.w) > Math.max(ins.x, other.x);
            merge = touches;
          }
        } else {
          const i2 = inter(a, b);
          merge = i2 > 0.3 * Math.min(a.w * a.h, b.w * b.h);
        }
        if (!merge) continue;
        const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        const m = {
          kind: a.kind === 'insert' && b.kind === 'insert' ? 'insert' : 'diff',
          x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y,
          diffPx: a.diffPx + b.diffPx,
          inserted: [...(a.inserted ?? (a.kind === 'insert' ? [a] : [])), ...(b.inserted ?? (b.kind === 'insert' ? [b] : []))],
        };
        if (m.kind === 'insert') Object.assign(m, { cand: a.cand, blankRows: a.blankRows && b.blankRows, band: a.band });
        list[i] = m; list.splice(j, 1); changed = true;
        break outer;
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// 4. 原因分类（v1 启发式）
// ---------------------------------------------------------------------------

function borderBg(img) {
  const counts = new Map();
  const { width: w, height: h, data } = img;
  const add = (x, y) => {
    const i = (y * w + x) * 4;
    const key = (data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3);
    const e = counts.get(key);
    if (e) { e[0]++; e[1] += data[i]; e[2] += data[i + 1]; e[3] += data[i + 2]; }
    else counts.set(key, [1, data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { add(0, y); add(w - 1, y); }
  let best = null;
  for (const e of counts.values()) if (!best || e[0] > best[0]) best = e;
  return best ? [best[1] / best[0], best[2] / best[0], best[3] / best[0]] : [255, 255, 255];
}

/** 墨迹：与背景色任一通道差 > 24 的像素；返回占比、外接框、均色 */
function ink(img, bg, box = null) {
  const { width: w, data } = img;
  const X0 = box ? box.x : 0, Y0 = box ? box.y : 0, X1 = box ? box.x + box.w : w, Y1 = box ? box.y + box.h : img.height;
  let n = 0, total = 0, r = 0, g = 0, b = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      total++;
      const i = (y * w + x) * 4;
      if (data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 255) continue;   // 缺行填充
      if (Math.abs(data[i] - bg[0]) > CHANNEL_T || Math.abs(data[i + 1] - bg[1]) > CHANNEL_T || Math.abs(data[i + 2] - bg[2]) > CHANNEL_T) {
        n++; r += data[i]; g += data[i + 1]; b += data[i + 2];
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return { share: n / Math.max(1, total), n, mean: n ? [r / n, g / n, b / n] : null, bbox: n ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

/** 墨迹像素里最多的那种颜色占多少（量化到每通道 5 位） */
function dominantShare(img, bg, box) {
  const counts = new Map();
  let n = 0;
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = (y * img.width + x) * 4, d = img.data;
    if (Math.abs(d[i] - bg[0]) <= CHANNEL_T && Math.abs(d[i + 1] - bg[1]) <= CHANNEL_T && Math.abs(d[i + 2] - bg[2]) <= CHANNEL_T) continue;
    n++;
    const key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    const e = counts.get(key);
    if (e) { e[0]++; e[1] += d[i]; e[2] += d[i + 1]; e[3] += d[i + 2]; } else counts.set(key, [1, d[i], d[i + 1], d[i + 2]]);
  }
  let best = null;
  for (const e of counts.values()) if (!best || e[0] > best[0]) best = e;
  return best ? { share: best[0] / n, color: [best[1] / best[0], best[2] / best[0], best[3] / best[0]] } : { share: 0, color: null };
}

function inkLum(img, bg) {
  const bgL = 0.299 * bg[0] + 0.587 * bg[1] + 0.114 * bg[2];
  const out = new Float32Array(img.width * img.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = Math.abs(lum(img.data, p) - bgL);
  return out;
}

function bestProfileShift(a, b, maxShift) {
  let best = 0, bestErr = Infinity;
  const n = a.length;
  for (let d = -maxShift; d <= maxShift; d++) {
    let err = 0, cnt = 0;
    for (let i = Math.max(0, -d); i < Math.min(n, n - d); i++) { err += Math.abs(a[i] - b[i + d]); cnt++; }
    if (cnt < n * 0.5) continue;
    err /= cnt;
    if (err < bestErr - 1e-9 || (Math.abs(err - bestErr) < 1e-9 && Math.abs(d) < Math.abs(best))) { bestErr = err; best = d; }
  }
  return best;
}

function shiftError(La, Lb, w, h, box, dx, dy) {
  let err = 0, cnt = 0;
  const step = box.w * box.h > 400_000 ? 2 : 1;
  for (let y = box.y; y < box.y + box.h; y += step) {
    const yb = y + dy;
    if (yb < 0 || yb >= h) continue;
    for (let x = box.x; x < box.x + box.w; x += step) {
      const xb = x + dx;
      if (xb < 0 || xb >= w) continue;
      err += Math.abs(La[y * w + x] - Lb[yb * w + xb]); cnt++;
    }
  }
  return cnt ? err / cnt : Infinity;
}

function edgeMap(L, w, h) {
  const e = new Uint8Array(w * h);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    if (Math.abs(L[i + 1] - L[i]) + Math.abs(L[i + w] - L[i]) > 40) e[i] = 1;
  }
  return e;
}

function edgeAgreement(ea, eb, w, h) {
  let na = 0, hit = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!ea[i]) continue;
    na++;
    if (eb[i] || eb[i - 1] || eb[i + 1] || eb[i - w] || eb[i + w]) hit++;
  }
  return na ? hit / na : 1;
}

const dist = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;

function overlapShare(region, boxes) {
  const area = region.w * region.h;
  if (!area) return 0;
  let s = 0;
  for (const b of boxes) s += inter(region, b);
  return Math.min(1, s / area);
}

/** 参考页来的选择器只留选择器安全字符、≤ 120 字符（PRD 08 §3.2(e)）；不合规就不给 */
export function safeAnchor(sel) {
  const s = String(sel ?? '');
  return /^[A-Za-z0-9_\-.#>:() [\]="'*+~^$|]{1,120}$/.test(s) ? s : undefined;
}

export function elementHints(region, elements) {
  const scored = [];
  let container = null;
  const area = Math.max(1, region.w * region.h);
  for (const e of elements) {
    const i = inter(region, e.box);
    if (!i) continue;
    const u = i / (area + e.box.w * e.box.h - i);
    scored.push([u, e]);
    if (i >= 0.9 * area && (!container || e.box.w * e.box.h < container.box.w * container.box.h)) container = e;
  }
  scored.sort((a, b) => b[0] - a[0]);
  const fmt = (e, conf) => e && ({ ...(e.ref ? { ref: e.ref } : {}), anchor: safeAnchor(e.sel), ...(e.text ? { text: e.text } : {}), box: e.box,
    ...(e.sectionId ? { sectionId: e.sectionId } : {}), ...(conf !== undefined ? { iou: +conf.toFixed(2) } : {}) });
  return {
    best: scored.slice(0, 2).map(([u, e]) => fmt(e, u)),
    container: container ? fmt(container) : null,
  };
}

const PAD = 32;

/** 参考行 y 在「顶对齐」映射下对应的候选行（被推开的内容要按这个映射看，位移才看得出来） */
function bandRowTop(align, y) {
  const bi = align.bandOf[y];
  const b = bi >= 0 ? align.bands[bi] : null;
  return b?.kind === 'resize' ? b.rowsTop[y - b.r0] : align.candRow[y];
}

/** 给一个区域做原因判断；`ctx` = { ref, cand, align, elements } */
export function classify(region, ctx) {
  const { ref, cand, align, elements } = ctx;
  const W = ref.width;
  // 分析用裁剪：四周留 PAD 余量，参考与候选在**参考坐标系**里逐行对应
  const x = Math.max(0, region.x - PAD), x1 = Math.min(W, region.x + region.w + PAD), w = x1 - x;
  let refRows, candRows;
  if (region.kind === 'pairshift') {
    region.cause = 'shift';
    region.causeConfidence = 0.85;
    region.shift = { dx: 0, dy: region.pair.dy };
    const y0 = Math.max(0, region.y - PAD), y1 = Math.min(ref.height, region.y + region.h + PAD);
    refRows = Array.from({ length: y1 - y0 }, (_, i) => y0 + i);
    candRows = refRows.map(y => y + region.pair.off);
    return { refRows, candRows, x, w };
  }
  if (region.kind === 'moved') {
    // 被推开的内容：本身没变，只是相对上方内容移了 delta（底对齐映射下对得上）
    const b = align.bands[region.bandIndex];
    region.cause = 'spacing';
    region.causeConfidence = 0.8;
    region.shift = { dx: 0, dy: b.delta };
    region.heightDelta = b.delta;
    const y0 = Math.max(0, region.y - PAD), y1 = Math.min(ref.height, region.y + region.h + PAD);
    refRows = Array.from({ length: y1 - y0 }, (_, i) => y0 + i);
    candRows = refRows.map(y => bandRowTop(align, y));
    const mapped = candRows.filter(c => c >= 0);
    if (mapped.length) region.cand = { x: region.x, y: Math.min(...mapped) + b.delta, w: region.w, h: region.h };
    return { refRows, candRows, x, w };
  }
  if (region.kind === 'insert') {
    const c = region.cand ?? region.inserted?.[0]?.cand;
    const cy0 = Math.max(0, c.y - PAD), cy1 = Math.min(cand.height, c.y + c.h + PAD);
    candRows = Array.from({ length: cy1 - cy0 }, (_, i) => cy0 + i);
    const ry0 = Math.max(0, region.y - PAD), ry1 = Math.min(ref.height, region.y + PAD);
    refRows = Array.from({ length: ry1 - ry0 }, (_, i) => ry0 + i);
    const blank = region.blankRows ?? false;
    region.cause = blank ? 'spacing' : 'extra-content';
    region.causeConfidence = blank ? 0.9 : 0.6;
    region.heightDelta = c.h;
    region.cand = c;
    return { refRows, candRows, x, w };
  }
  const y0 = Math.max(0, region.y - PAD), y1 = Math.min(ref.height, region.y + region.h + PAD);
  refRows = Array.from({ length: y1 - y0 }, (_, i) => y0 + i);
  candRows = refRows.map(y => align.candRow[y]);
  const refCrop = cropRows(ref, refRows, x, w);
  const candCrop = cropRows(cand, candRows, x, w);
  const inner = { x: region.x - x, y: region.y - y0, w: region.w, h: region.h };

  // 对应的候选坐标（对齐后的连续行段）
  const mapped = [];
  for (let y = region.y; y < region.y + region.h; y++) if (align.candRow[y] >= 0) mapped.push(align.candRow[y]);
  if (mapped.length) region.cand = { x: region.x, y: Math.min(...mapped), w: region.w, h: Math.max(...mapped) - Math.min(...mapped) + 1 };

  // 与之重叠的对齐段（高度变化）
  let heightDelta = 0, missingRows = 0;
  for (const b of align.bands) {
    if (b.r1 < region.y - 8 || b.r0 > region.y + region.h + 8) continue;
    heightDelta += b.Lc - b.Lr;
  }
  for (let y = region.y; y < region.y + region.h; y++) if (align.candRow[y] < 0) missingRows++;
  region.heightDelta = heightDelta;

  const bgR = borderBg(refCrop), bgC = borderBg(candCrop);
  const inkR = ink(refCrop, bgR, inner), inkC = ink(candCrop, bgC, inner);
  const imgs = elements.filter(e => e.img);
  const texts = elements.filter(e => e.textual);
  const imgShare = overlapShare(region, imgs.map(e => e.box));
  const textShare = overlapShare(region, texts.map(e => e.box));
  region.domShare = { img: +imgShare.toFixed(2), text: +textShare.toFixed(2) };
  const set = (cause, conf, extra = {}) => { region.cause = cause; region.causeConfidence = +Math.max(0, Math.min(1, conf)).toFixed(2); Object.assign(region, extra); };

  // ① 候选整段缺行
  if (missingRows >= 0.5 * region.h) {
    if (inkR.share < 0.01) set('spacing', 0.85);
    else if (imgShare >= 0.5) set('image-missing', 0.8);
    else set('missing-content', 0.85);
    return { refRows, candRows, x, w, refCrop, candCrop };
  }
  // ② 一侧有墨迹、另一侧几乎为空
  if (inkR.share >= 0.02 && inkC.share <= 0.3 * inkR.share) {
    if (imgShare >= 0.4) set('image-missing', 1 - inkC.share / inkR.share);
    else set('missing-content', 1 - inkC.share / inkR.share);
    return { refRows, candRows, x, w, refCrop, candCrop };
  }
  if (inkC.share >= 0.02 && inkR.share <= 0.3 * inkC.share) {
    // 多出来的是一整块单色：多半是背景色变了（与周围同色的块换了颜色），按颜色报
    const solid = dominantShare(candCrop, bgC, inner);
    if (solid.share >= 0.85) set('color', 0.6, { colors: { what: 'background', ref: hex(bgR), cand: hex(solid.color) } });
    else set('extra-content', 1 - inkR.share / inkC.share);
    return { refRows, candRows, x, w, refCrop, candCrop };
  }
  // ③ 平移：投影轮廓估计 (dx, dy)，再在 3×3 邻域内用二维误差确认
  const La = inkLum(refCrop, bgR), Lb = inkLum(candCrop, bgC);
  const ch = refCrop.height;
  const rowA = new Float32Array(ch), rowB = new Float32Array(ch), colA = new Float32Array(w), colB = new Float32Array(w);
  for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < w; xx++) {
    const i = yy * w + xx;
    rowA[yy] += La[i]; rowB[yy] += Lb[i]; colA[xx] += La[i]; colB[xx] += Lb[i];
  }
  const dy0 = bestProfileShift(rowA, rowB, PAD), dx0 = bestProfileShift(colA, colB, PAD);
  const err0 = shiftError(La, Lb, w, ch, inner, 0, 0);
  let best = { dx: 0, dy: 0, err: err0 };
  for (let ddy = -1; ddy <= 1; ddy++) for (let ddx = -1; ddx <= 1; ddx++) {
    const dx = dx0 + ddx, dy = dy0 + ddy;
    if (!dx && !dy) continue;
    const e = shiftError(La, Lb, w, ch, inner, dx, dy);
    if (e < best.err) best = { dx, dy, err: e };
  }
  const reduction = err0 > 0 ? 1 - best.err / err0 : 0;
  if ((best.dx || best.dy) && reduction >= 0.6) {
    set('shift', reduction, { shift: { dx: best.dx, dy: best.dy }, subpixel: Math.max(Math.abs(best.dx), Math.abs(best.dy)) <= 1 });
    return { refRows, candRows, x, w, refCrop, candCrop };
  }
  // ④ 颜色：边缘几乎一致，但墨迹均色或背景色偏了
  const ea = edgeMap(La, w, ch), eb = edgeMap(Lb, w, ch);
  const agree = Math.min(edgeAgreement(ea, eb, w, ch), edgeAgreement(eb, ea, w, ch));
  const dInk = dist(inkR.mean, inkC.mean), dBg = dist(bgR, bgC);
  if (agree >= 0.75 && Math.max(dInk, dBg) >= 24) {
    set('color', agree * Math.min(1, Math.max(dInk, dBg) / 60), {
      colors: dBg >= dInk ? { what: 'background', ref: hex(bgR), cand: hex(bgC) } : { what: 'foreground', ref: hex(inkR.mean), cand: hex(inkC.mean) },
    });
    return { refRows, candRows, x, w, refCrop, candCrop };
  }
  // ⑤ 尺寸 / 字形：墨迹外接框变了，或该段高度变了
  if (inkR.bbox && inkC.bbox) {
    const dw = inkC.bbox.w - inkR.bbox.w, dh = inkC.bbox.h - inkR.bbox.h;
    const grown = Math.abs(dw) >= Math.max(3, 0.04 * inkR.bbox.w) || Math.abs(dh) >= Math.max(2, 0.04 * inkR.bbox.h) || heightDelta !== 0;
    if (grown) {
      const cause = textShare >= 0.5 ? 'font' : 'size';
      set(cause, 0.6, { inkSize: { ref: { w: inkR.bbox.w, h: inkR.bbox.h }, cand: { w: inkC.bbox.w, h: inkC.bbox.h } } });
      return { refRows, candRows, x, w, refCrop, candCrop };
    }
  }
  if (agree < 0.75 && textShare >= 0.5) set('font', 0.4);
  else set('unknown', 0.3);
  return { refRows, candRows, x, w, refCrop, candCrop };
}

// ---------------------------------------------------------------------------
// 5. 严重度、排序、提示
// ---------------------------------------------------------------------------

const CAUSE_WEIGHT = {
  'missing-content': 2, 'image-missing': 2, 'extra-content': 1.5, spacing: 1.5, size: 1.5,
  font: 1.3, color: 1.3, shift: 1.2, unknown: 0.8,
};

function severityOf(r, vpArea) {
  const areaPct = r.diffPx / vpArea * 100;
  if (r.subpixel || r.scattered) return 'low';
  if (areaPct >= 0.5 || (['missing-content', 'image-missing', 'extra-content'].includes(r.cause) && areaPct >= 0.1)) return 'high';
  return areaPct >= 0.05 ? 'medium' : 'low';
}

function hintOf(r) {
  // 只引用 Heimdall 生成的元素编号（如 e12），不拼接网页里的类名或文字
  const anchor = r.element?.best?.[0]?.ref;
  switch (r.cause) {
    case 'unknown': if (r.scattered) return '零散差异（像素稀疏地散在一片文字上，多为渲染 / 抗锯齿差别），最后再管。';
      return '内容不同，对照裁剪图检查。';
    case 'shift': return r.subpixel
      ? `亚像素级错位（${r.shift.dx}, ${r.shift.dy}）px，多为渲染差异，最后再管。`
      : `整块偏移 (${r.shift.dx}, ${r.shift.dy})px，检查定位、外边距或 transform${anchor ? `（参考元素 ${anchor}）` : ''}。`;
    case 'missing-content': return `候选缺少这块内容${anchor ? `（参考 ${anchor}）` : ''}，检查是否漏写或被隐藏。`;
    case 'image-missing': return `这里应有一张图${anchor ? `（参考 ${anchor}）` : ''}，候选没显示出来，检查资源路径、尺寸与 display。`;
    case 'extra-content': return '候选多出这块内容，参考里没有。';
    case 'spacing': return r.kind === 'moved'
      ? `这块内容本身没变，但比参考${r.heightDelta > 0 ? '低' : '高'} ${Math.abs(r.heightDelta)}px：检查它上方的 margin / padding / gap 或某个块的高度。`
      : `垂直间距差约 ${r.heightDelta > 0 ? '+' : ''}${r.heightDelta}px（候选相对参考），检查 margin / padding / gap。`;
    case 'color': return `${r.colors.what === 'background' ? '背景色' : '前景色'}不符：参考 ${r.colors.ref}，候选 ${r.colors.cand}。`;
    case 'font': return `文字尺寸 / 字形不符${r.inkSize ? `（墨迹 ${r.inkSize.ref.w}×${r.inkSize.ref.h} → ${r.inkSize.cand.w}×${r.inkSize.cand.h}）` : ''}，检查 font-size / line-height / font-weight / letter-spacing。`;
    case 'size': return `块尺寸不符${r.heightDelta ? `（高度差 ${r.heightDelta > 0 ? '+' : ''}${r.heightDelta}px）` : ''}，检查 width / height / padding。`;
    default: return '内容不同，对照裁剪图检查。';
  }
}

// ---------------------------------------------------------------------------
// 6. 单视口分析入口
// ---------------------------------------------------------------------------

export function analyzeViewport({ ref, cand, viewport, viewportHeight, elements = [], dyn = null, classifyLimit = 400, tolerant = true }) {
  const t0 = performance.now();
  const metrics = directMetrics(ref, cand, viewportHeight, dyn);
  const t1 = performance.now();
  const align = alignRows(ref, cand);
  const strictMask = alignedMask(ref, cand, align, dyn);
  const dm = tolerant ? tolerate(strictMask, ref, cand, align) : strictMask;
  const found = regionsFromMask(dm);
  const movedFound = regionsFromMask({ mask: strictMask.moved, width: strictMask.width, height: strictMask.height });
  const moved = movedFound.regions.map(r => ({ ...r, kind: 'moved', bandIndex: align.bandOf[r.y] }))
    .filter(r => !tolerant || Math.abs(align.bands[r.bandIndex]?.delta ?? 0) > 1);
  const ins = insertRegions(cand, align, strictMask.perBand, tolerant ? ref : null);
  let regions = [...groupByElement(mergeRegions([...found.regions, ...ins]), elements), ...moved, ...pairRegions(ref, cand, align)];
  const t2 = performance.now();
  regions.sort((a, b) => b.diffPx - a.diffPx);
  const vpArea = ref.width * viewportHeight;
  const ctx = { ref, cand, align, elements };
  for (const [i, r] of regions.entries()) {
    if (i < classifyLimit || r.diffPx >= vpArea * 1e-4) classify(r, ctx);
    else { r.cause = 'unknown'; r.causeConfidence = 0; r.unclassified = true; }
    r.element = elementHints(r, elements);
    r.areaPct = +(r.diffPx / vpArea * 100).toFixed(3);
    r.severity = severityOf(r, vpArea);
    // 集中度：差异像素占外接框的比例。真缺陷的差异是成片的（S1 实测约 20–40%），
    // 容差之后残留的渲染噪声稀疏地散在整段文字上（约 2%）；按面积排序会让后者压过前者
    r.density = r.kind === 'diff' ? +(r.diffPx / Math.max(1, r.w * r.h)).toFixed(3) : 1;
    if (r.kind === 'diff' && r.density < 0.05 && ['unknown', 'font', 'shift'].includes(r.cause) && !r.heightDelta) { r.scattered = true; r.severity = 'low'; }
    const concentration = Math.min(1, Math.max(0.2, r.density / 0.1));
    r.weight = r.diffPx * (CAUSE_WEIGHT[r.cause] ?? 1) * (r.subpixel ? 0.2 : 1) * concentration;
  }
  // 级联：上方某处高度变了（字号变大、块变高、插入间距），下方被推开的内容、跟着变高变矮的段都是「果」。
  // 从上往下走，果的权重压到根的 0.9 倍以下，保证「先修根」排在前面（S1 实测：字号 +2 的段落
  // 引起的连带区域面积远大于它本身，按面积排它会掉到第 12 位）
  const changesHeight = (r) => r.kind === 'insert' || (r.kind === 'diff' && r.heightDelta) || r.kind === 'moved';
  let root = null;
  for (const r of [...regions].sort((a, b) => a.y - b.y)) {
    if (root && changesHeight(r) && r.y - (root.y + root.h) <= 2 * viewportHeight) {
      if (r.weight > root.weight * 0.9) r.weight = root.weight * 0.9;
      r.consequence = true;
      r.rootRef = root;
    } else if (changesHeight(r) && r.kind !== 'moved') root = r;
  }
  for (const r of regions) r.hint = hintOf(r);
  regions.sort((a, b) => b.weight - a.weight);
  regions.forEach((r, i) => { r.id = `r${viewport}-${String(i + 1).padStart(2, '0')}`; r.viewport = viewport; });
  for (const r of regions) if (r.rootRef) { r.consequenceOf = r.rootRef.id; delete r.rootRef; r.hint = `${r.hint}（可能是 ${r.consequenceOf} 的连带结果，先修它）`; }
  const t3 = performance.now();
  const insertedPx = ins.reduce((s, r) => s + r.diffPx, 0);
  const concentrated = regions.filter(r => !r.scattered && !r.subpixel);
  metrics.maxRegionPct = concentrated.length ? Math.max(...concentrated.map(r => r.areaPct)) : 0;
  metrics.highRegions = regions.filter(r => r.severity === 'high').length;
  metrics.notes = viewportNotes(metrics, regions);
  return {
    viewport,
    metrics: {
      ...metrics,
      pixelAligned: +(1 - (strictMask.n + insertedPx) / Math.max(1, ref.width * ref.height + insertedPx)).toFixed(5),
      pixelTolerant: +(1 - (dm.n + insertedPx) / Math.max(1, ref.width * ref.height + insertedPx)).toFixed(5),
      regionsTotal: regions.length,
      speckles: found.speckles,
    },
    alignment: {
      share: align.share, equalRows: align.equalRows,
      bands: align.bands.filter(b => !b.elastic).slice(0, 40).map(b => ({ kind: b.kind, ref: [b.r0, b.r1], cand: [b.c0, b.c1], delta: b.delta, anchor: b.anchor })),
      elasticBands: align.bands.filter(b => b.elastic).length,
      bandsTotal: align.bands.length,
    },
    regions,
    align,
    timing: { directMs: Math.round(t1 - t0), alignRegionsMs: Math.round(t2 - t1), classifyMs: Math.round(t3 - t2) },
  };
}

// ---------------------------------------------------------------------------
// 7. 裁剪图与修复包
// ---------------------------------------------------------------------------

export function writeCrop(file, region, ref, cand, align, { margin = 24, maxEdge = 1568 } = {}) {
  const W = ref.width;
  const x = Math.max(0, region.x - margin), x1 = Math.min(W, region.x + region.w + margin), w = x1 - x;
  let refRows, candRows;
  if (region.kind === 'insert') {
    const c = region.cand;
    const cy0 = Math.max(0, c.y - margin), cy1 = Math.min(cand.height, c.y + c.h + margin);
    candRows = Array.from({ length: cy1 - cy0 }, (_, i) => cy0 + i);
    const ry0 = Math.max(0, region.y - margin), ry1 = Math.min(ref.height, region.y + margin);
    refRows = Array.from({ length: ry1 - ry0 }, (_, i) => ry0 + i);
  } else {
    const y0 = Math.max(0, region.y - margin), y1 = Math.min(ref.height, region.y + region.h + margin);
    refRows = Array.from({ length: y1 - y0 }, (_, i) => y0 + i);
    candRows = refRows.map(y => region.kind === 'moved' ? bandRowTop(align, y) : region.kind === 'pairshift' ? y + region.pair.off : align.candRow[y]);
  }
  const a = cropRows(ref, refRows, x, w);
  const b = cropRows(cand, candRows, x, w);
  const parts = region.kind === 'insert' ? [a, b] : [a, b, diffOverlay(a, b)];
  const composite = stack(parts, w >= Math.max(a.height, b.height) ? 'vertical' : 'horizontal');
  const out = downscale(composite, maxEdge);
  writePng(file, out);
  return { width: out.width, height: out.height, scaledFrom: composite.width !== out.width ? { width: composite.width, height: composite.height } : undefined };
}

/** 门禁阈值（PRD 05 §1.1；maxRegionPct 为 Phase 0 新增维度与建议值，Bench v0 复核） */
export const GATES = Object.freeze({
  bronze: Object.freeze({ pixel: 0.95, maxBlobPct: 1.5, maxRegionPct: 0.5 }),
  silver: Object.freeze({ pixel: 0.97, maxBlobPct: 0.5, maxRegionPct: 0.1 }),
  gold: Object.freeze({ pixel: 0.99, maxBlobPct: 0.2, maxRegionPct: 0.05 }),
});

const meetsLevel = (v, g) => v.pixelSimilarity >= g.pixel && v.maxBlobPct <= g.maxBlobPct && (v.maxRegionPct ?? 0) <= g.maxRegionPct;

/**
 * 快速裁判的判定（附录 C §6）：没有 passed。
 *   fail            任一视口低于 bronze
 *   pass-candidate  所有视口达到目标等级、且没有 high 区域（仍须正式裁判确认）
 *   near            距目标等级的像素阈值 ≤ 1 个百分点、且没有 high 区域
 *   needs-work      其余
 */
export function verdictOf(perViewport, target = 'silver') {
  const t = GATES[target] ?? GATES.silver;
  const vps = Object.values(perViewport);
  const reached = ['gold', 'silver', 'bronze'].find(level => vps.every(v => meetsLevel(v, GATES[level]))) ?? null;
  if (vps.some(v => !meetsLevel(v, GATES.bronze))) return { status: 'fail', target, reached };
  const high = vps.some(v => v.highRegions > 0);
  if (vps.every(v => meetsLevel(v, t)) && !high) return { status: 'pass-candidate', target, reached, note: '快速裁判不能宣布 passed，须正式裁判确认' };
  const near = vps.every(v => v.pixelSimilarity >= t.pixel - 0.01) && !high;
  return { status: near ? 'near' : 'needs-work', target, reached };
}

/**
 * 修复包的文本视图（给代理读）。只含 Heimdall 生成的字段、区域 / 元素 ID 与选择器安全的锚点；
 * 网页文字不出现在这里（需要时看 JSON 里的 element.text，它已列入 trust.untrustedPaths）。
 */
export function packetText(packet, { maxPerViewport = 6 } = {}) {
  const lines = [];
  for (const vp of packet.viewports) {
    const v = packet.perViewport[vp];
    if (!v) continue;
    lines.push(`## ${vp}  像素 ${(v.pixelSimilarity * 100).toFixed(2)}% · 最大块 ${v.maxBlobPct}%（占整页 ${v.maxBlobPagePct}%）· 最大集中区域 ${v.maxRegionPct}% · 高度 参考 ${v.size.ref.h} / 候选 ${v.size.cand.h}`);
    const regions = packet.regions.filter(r => r.viewport === vp).slice(0, maxPerViewport);
    for (const r of regions) {
      const b = r.bbox;
      lines.push(`[${r.id}] bbox(${b.x},${b.y},${b.w},${b.h}) · 面积 ${r.areaPct}% · ${r.severity} · cause=${r.cause}${r.causeConfidence !== undefined ? ` (${r.causeConfidence})` : ''}`
        + (r.shift ? ` · d=(${r.shift.dx},${r.shift.dy})` : '') + (r.heightDelta ? ` · Δh=${r.heightDelta}` : '') + (r.sectionId ? ` · ${r.sectionId}` : ''));
      const e = r.element?.best?.[0];
      if (e?.ref || e?.anchor) lines.push(`     参考元素: ${[e.ref, e.anchor].filter(Boolean).join(' ')}`);
      if (r.crops?.composite) lines.push(`     裁剪: ${r.crops.composite}（自上而下 / 自左而右：参考 · 候选 · 差异）`);
      lines.push(`     建议: ${r.hint}`);
    }
    for (const note of v.notes ?? []) lines.push(`     说明: ${note}`);
  }
  if (packet.anticheat?.findings?.length) {
    lines.push('反作弊:');
    for (const f of packet.anticheat.findings.slice(0, 6)) lines.push(`  ${f.severity === 'error' ? '✗' : '!'} ${f.code}: ${f.detail}`);
  }
  lines.push(`判定: ${packet.verdict.status}（目标 ${packet.verdict.target}${packet.verdict.reached ? `，当前达到 ${packet.verdict.reached}` : ''}）`
    + (packet.verdict.anticheat ? ' · 反作弊命中，像素分不作数' : '')
    + (packet.order.length ? ` · 下一步: 按顺序修 ${packet.order.slice(0, 3).join('、')}，然后重新 compare` : ''));
  return lines.join('\n') + '\n';
}

/**
 * 每个视口的补充说明：没有区域但分数不满时给残差摘要；高度只差 1 行时注明多半是取整。
 * S2 里 Opus 指出：两者都不说明时，模型会去追不存在的问题。
 */
export function viewportNotes(metrics, regions) {
  const notes = [];
  if (Math.abs(metrics.heightDelta) === 1) notes.push('页面高度只差 1 行，多半是小数高度取整造成的，不必为它改布局。');
  if (!regions.length && metrics.pixelSimilarity < 1) {
    notes.push(`没有区域通过筛选：剩余 ${((1 - metrics.pixelSimilarity) * 100).toFixed(2)}% 的差异是零散的抗锯齿 / 亚像素差别，不必再追。`);
  } else if (regions.length && regions.every(r => r.scattered || r.subpixel)) {
    notes.push('剩下的都是零散差异（多为渲染差别），先确认门禁是否已过，再决定要不要继续。');
  }
  return notes;
}
