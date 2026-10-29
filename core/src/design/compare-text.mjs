/**
 * design/compare-text — 设计稿文字与线上文字的比对（纯函数）
 *
 * 约束：
 *   · 设计稿是意图不是真值：只判 found / changed / missing，不判位置与样式。
 *   · 归一化：NFKC（全角字母数字与 ASCII 标点转半角）→ 去零宽字符 → 中文标点映射到 ASCII → 空白折叠，
 *     挨着汉字、假名、标点、符号的空白去掉（折行、中英文间距、「: 」与「：」不算差异）→ 小写。
 *   · 「包含」与开窗都守边界：两端是拉丁字母或数字时，紧邻的字符不能也是（数字还看 9.9 / 1,000 里的分隔符），
 *     免得 99 被 199 当成 found、pro 在 approve 里拿满分。
 *   · 相似度用字符二元组的 Dice 系数，对中文同样有效；线上长文按设计稿长度 ±1 开窗取最好的一段，
 *     免得长段落把短标签的分数稀释掉。开窗只在有望过 0.6 时才做，所以 missing 的 similarity 只作参考。
 */

const PUNCT = {
  '。': '.', '、': ',', '，': ',', '．': '.', '：': ':', '；': ';', '！': '!', '？': '?',
  '“': '"', '”': '"', '„': '"', '‘': "'", '’': "'", '「': '"', '」': '"', '『': '"', '』': '"',
  '（': '(', '）': ')', '【': '[', '】': ']', '〔': '[', '〕': ']', '《': '<', '》': '>', '〈': '<', '〉': '>',
  '—': '-', '–': '-', '―': '-', '～': '~', '〜': '~', '…': '...', '•': '·', '・': '·', '￥': '¥', '＄': '$',
};
const PUNCT_RE = new RegExp(`[${Object.keys(PUNCT).join('')}]`, 'g');
const ZERO_WIDTH_RE = /[\u00ad\u200b-\u200d\u2060\ufeff]/g;
const TIGHT = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{P}\\p{S}';
const TIGHT_SPACE_RE = new RegExp(`\\s+(?=[${TIGHT}])|(?<=[${TIGHT}])\\s+`, 'gu');
const WORD_RE = /[\p{Script=Latin}\p{Nd}]/u;
const DIGIT_RE = /\d/;
const CHANGED_MIN = 0.6;
const SHORT_LABEL = 8;
const WINDOW_MAX_LIVE = 20_000;

/** NFKC + 去零宽 + 标点统一 + 空白折叠（汉字、标点、符号旁的空白去掉）+ 小写 */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(PUNCT_RE, (c) => PUNCT[c])
    .replace(/\s+/g, ' ')
    .replace(TIGHT_SPACE_RE, '')
    .trim()
    .toLowerCase();
}

/** 按码点切开，二元组多重集；单字时用单字本身 */
function gramsOf(s) {
  const chars = [...s], grams = new Map();
  if (chars.length === 1) grams.set(chars[0], 1);
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = chars[i] + chars[i + 1];
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return { chars, grams, size: chars.length === 1 ? 1 : Math.max(0, chars.length - 1) };
}

function overlap(a, b) {
  const [small, big] = a.grams.size <= b.grams.size ? [a, b] : [b, a];
  let n = 0;
  for (const [g, c] of small.grams) n += Math.min(c, big.grams.get(g) ?? 0);
  return n;
}

/** 字符二元组 Dice 系数（多重集），0–1；入参按原样比较，需要归一化先过 normalizeText */
export function diceCoefficient(a, b) {
  const x = String(a ?? ''), y = String(b ?? '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const ga = gramsOf(x), gb = gramsOf(y);
  return (2 * overlap(ga, gb)) / (ga.size + gb.size);
}

// 窗口两端切在拉丁词或数字中间就不算
const cutsWord = (chars, start, end) => glued(chars, start - 1, -1, chars[start]) || glued(chars, end, 1, chars[end - 1]);

/** 线上文字里与设计稿等长（±1 字）片段的最高 Dice；滑窗增量计数，单趟 O(线上长度) */
function windowDice(d, l) {
  let best = 0;
  for (const width of [d.chars.length - 1, d.chars.length, d.chars.length + 1]) {
    const n = width - 1;
    if (n < 1 || width > l.chars.length) continue;
    const counts = new Map();
    let hit = 0;
    const gram = (i) => l.chars[i] + l.chars[i + 1];
    const add = (g) => { const c = (counts.get(g) ?? 0) + 1; counts.set(g, c); if (c <= (d.grams.get(g) ?? 0)) hit++; };
    const drop = (g) => { const c = counts.get(g); if (c <= (d.grams.get(g) ?? 0)) hit--; counts.set(g, c - 1); };
    for (let i = 0; i < n; i++) add(gram(i));
    for (let start = 0; start + width <= l.chars.length && best < 1; start++) {
      if (start) { drop(gram(start - 1)); add(gram(start + n - 1)); }
      if (!cutsWord(l.chars, start, start + width)) best = Math.max(best, (2 * hit) / (d.size + n));
    }
  }
  return best;
}

// 开窗的上界是 2·重合数 / (2·设计稿二元组数 − 1)，到不了阈值就不开
function score(d, l) {
  const ov = overlap(d, l);
  const whole = (2 * ov) / (d.size + l.size);
  if (d.size < 2 || l.chars.length <= d.chars.length * 1.5 || l.chars.length > WINDOW_MAX_LIVE) return whole;
  if ((2 * ov) / (2 * d.size - 1) < CHANGED_MIN) return whole;
  return Math.max(whole, windowDice(d, l));
}

// hay[i] 是否与 needle 的边缘字符 edge 粘连成同一个词或数
function glued(hay, i, step, edge) {
  const c = hay[i];
  if (c === undefined || !WORD_RE.test(edge)) return false;
  if (WORD_RE.test(c)) return true;
  return DIGIT_RE.test(edge) && (c === '.' || c === ',') && DIGIT_RE.test(hay[i + step] ?? '');
}

function boundedIncludes(hay, needle) {
  if (!needle) return false;
  const first = needle[0], last = needle[needle.length - 1];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (!glued(hay, i - 1, -1, first) && !glued(hay, i + needle.length, 1, last)) return true;
  }
  return false;
}

/** 先找包含它的线上文字（取最短的）；短标签再反过来找被它包含的线上文字（取最长的，且不短于它的六成） */
function findContaining(d, norm, live, minLength) {
  let hit = null;
  for (const l of live) if (boundedIncludes(l.norm, norm) && (!hit || l.chars.length < hit.chars.length)) hit = l;
  if (hit || d.chars.length > SHORT_LABEL) return hit;
  const floor = Math.max(minLength, Math.ceil(d.chars.length * 0.6));
  for (const l of live) {
    if (l.chars.length >= floor && boundedIncludes(norm, l.norm) && (!hit || l.chars.length > hit.chars.length)) hit = l;
  }
  return hit;
}

const textOf = (item) => (typeof item === 'string' ? item : item?.characters ?? item?.text ?? '');
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * 每条设计稿文字（归一化后短于 minLength 的跳过）→ { design, status, live?, similarity, hasNumber }。
 * designTexts / liveTexts 可以是字符串，或带 characters / text 字段的对象；design / live 原样带回。
 */
export function compareDesignTexts(designTexts, liveTexts, { minLength = 2 } = {}) {
  const live = [];
  for (const item of liveTexts ?? []) {
    const norm = normalizeText(textOf(item));
    if (norm) live.push({ item, norm, ...gramsOf(norm) });
  }
  const results = [];
  for (const design of designTexts ?? []) {
    const norm = normalizeText(textOf(design));
    const d = gramsOf(norm);
    if (d.chars.length < minLength) continue;
    const hasNumber = DIGIT_RE.test(norm);
    const hit = findContaining(d, norm, live, minLength);
    if (hit) { results.push({ design, status: 'found', live: hit.item, similarity: 1, hasNumber }); continue; }
    let best = null, top = 0;
    for (const l of live) { const s = score(d, l); if (s > top) { top = s; best = l; } }
    results.push(best && top >= CHANGED_MIN
      ? { design, status: 'changed', live: best.item, similarity: round(top), hasNumber }
      : { design, status: 'missing', similarity: round(top), hasNumber });
  }
  return results;
}
