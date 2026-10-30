/**
 * element-style — 参考侧与候选侧共用的样式键、压缩、差异计算。
 *
 * 修复包要像编译器报错一样说清楚差在哪：只给「字号不对」没有用，得同时给出
 * 参考值与候选值。这里集中定义两侧都采集的键，避免参考索引和候选索引漂移。
 */

export const INDEX_STYLE_PROPS = Object.freeze([
  'display', 'position', 'width', 'height', 'maxWidth', 'minHeight',
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap', 'gridTemplateColumns', 'flexDirection', 'justifyContent', 'alignItems',
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
  'color', 'backgroundColor', 'borderRadius', 'border',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'boxShadow', 'opacity',
]);

const DROP = new Set(['', 'none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)']);

/** 只留非默认、非空的值，省体积也省模型的注意力（参考索引与候选索引共用） */
export function compactStyle(style) {
  const out = {};
  for (const [k, v] of Object.entries(style ?? {})) {
    if (v === undefined || v === null || DROP.has(String(v))) continue;
    out[k] = String(v).slice(0, 120);
  }
  return Object.keys(out).length ? out : null;
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const ZERO_DEFAULT = new Set([
  'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'margin', 'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
  'gap', 'rowGap', 'columnGap',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderRadius',
]);

const DEFAULT_VALUE = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  border: '0px none rgb(0, 0, 0)',
};

/**
 * 候选侧被 compactStyle 丢掉的值 = CSS 默认值。参考有、候选没有时，
 * 那也是一处真实差异（背景被删成透明、padding 归零、宽度退回 auto），不能静默跳过。
 */
const CANDIDATE_DEFAULT = {
  backgroundColor: 'rgba(0, 0, 0, 0)',
  border: '0px none rgb(0, 0, 0)',
  gap: 'normal', rowGap: 'normal', columnGap: 'normal',
  letterSpacing: 'normal',
  width: 'auto', height: 'auto', maxWidth: 'none', minHeight: '0px',
  boxShadow: 'none',
};

/** 差异的展示顺序：先字体/颜色，再间距，再尺寸与布局 */
const DIFF_ORDER = [
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'color', 'backgroundColor',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'padding',
  'marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'margin',
  'gap', 'rowGap', 'columnGap',
  'width', 'height', 'maxWidth', 'minHeight',
  'display', 'flexDirection', 'justifyContent', 'alignItems', 'textAlign', 'textTransform',
  'borderRadius', 'border', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'gridTemplateColumns', 'boxShadow', 'opacity',
];

const px = (v) => {
  const m = /^(-?\d+(?:\.\d+)?)px$/.exec(String(v ?? '').trim());
  return m ? Number(m[1]) : null;
};
const colour = (v) => String(v ?? '').replace(/\s+/g, '').toLowerCase();
const firstFamily = (v) => String(v ?? '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();

function same(prop, a, b) {
  if (a === b) return true;
  // 0px / 0px 0px / 0 是同一个默认值，别把 shorthand 的写法差异当问题
  const zeroish = (v) => /^0(?:px)?(?:\s+0(?:px)?)*$/.test(String(v ?? '').trim());
  if (zeroish(a) && zeroish(b)) return true;
  if (prop === 'fontFamily') return firstFamily(a) === firstFamily(b);
  if (/color$/i.test(prop)) return colour(a) === colour(b);
  return false;
}

/**
 * 参考样式 vs 候选样式。只返回值得模型动手的差异：
 *   - 长度差 ≥ 0.25px；颜色/字体族不同；display 等枚举不同。
 *   - 参考侧缺失的 padding/margin/gap 按 0px 处理（compactStyle 丢掉了默认值）。
 * @returns {{prop:string, ref:string, cand:string, delta?:number}[]}
 */
export function styleDiffOf(refStyle = {}, candStyle = {}) {
  const out = [];
  const seen = new Set();
  const props = [...DIFF_ORDER, ...Object.keys({ ...refStyle, ...candStyle }).filter(k => !DIFF_ORDER.includes(k))];
  for (const prop of props) {
    if (seen.has(prop)) continue;
    seen.add(prop);
    let a = refStyle?.[prop];
    let b = candStyle?.[prop];
    const missingA = a === undefined || a === null || a === '';
    const missingB = b === undefined || b === null || b === '';
    if (missingA && missingB) continue;
    if (missingA) {
      if (ZERO_DEFAULT.has(prop)) a = '0px';
      else if (DEFAULT_VALUE[prop]) a = DEFAULT_VALUE[prop];
      else continue;
    }
    if (missingB) {
      if (ZERO_DEFAULT.has(prop)) b = '0px';
      else if (CANDIDATE_DEFAULT[prop]) b = CANDIDATE_DEFAULT[prop];
      else continue;
    }
    if (same(prop, a, b)) continue;
    const na = px(a), nb = px(b);
    if (na !== null && nb !== null) {
      const delta = +(nb - na).toFixed(2);
      if (Math.abs(delta) >= 0.25) out.push({ prop, ref: a, cand: b, delta });
    } else {
      out.push({ prop, ref: a, cand: b });
    }
    if (out.length >= 12) break;
  }
  return out;
}

export function boxDiffOf(refBox, candBox) {
  if (!refBox || !candBox) return null;
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    x: r1(candBox.x - refBox.x), y: r1(candBox.y - refBox.y),
    w: r1(candBox.w - refBox.w), h: r1(candBox.h - refBox.h),
  };
}

export const basename = (value) => {
  try {
    const s = String(value ?? '').split(/[?#]/)[0];
    return s.split('/').filter(Boolean).at(-1) ?? '';
  } catch { return ''; }
};
