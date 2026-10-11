/**
 * motion-css — 从**已有的** cssom.css 里把 CSS 动效原样抽出来（纯函数，不起浏览器、不联网）
 *
 * 为什么需要它：`motion.json`（crawler/motion.mjs）回答的是"这页在动吗、谁在驱动"，
 * 需要真浏览器探测；而"拿去做自己的站"的人真正想要的是**那段动效代码本身**。
 * CSS 动效的代码就在我们已经存下来的 cssom.css 里 —— 不需要重爬、不需要重克隆，
 * 对着几十个历史产物离线跑一遍就有结果。
 *
 * 划分口径（写进交付包，别让读者猜）：
 *   · CSS 动效（`@keyframes` + `animation:`）—— **静态镜像里是活的**：脚本被剥掉了，
 *     但 CSS 动画本来就由样式表驱动，打开 clone/index.html 就会播。这部分是真复刻。
 *   · JS 动效（GSAP / Framer / 打字机 / 轮播）—— 静态镜像停在被捕获的那一帧；
 *     交互镜像里原脚本保留、URL 重指到代理，所以**在那边是活的**。
 *   · 只认 `@keyframes` 与合成属性之外的滚动/悬停过渡不在这里统计 —— 见 motion.json。
 *
 * CSS 解析不引入依赖：本文件里的扫描器只认括号配对与字符串转义，够用且可单测。
 */

/** 跳过 `/* *​/` 注释 —— 注释里可以有花括号，不剥掉会把配对算错 */
export function stripComments(css) {
  return String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 从 `s[i] === '{'` 找到配对的 `}`，返回其下标；找不到返回 -1。会跳过字符串字面量 */
export function matchBrace(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return k; }
    else if (c === '"' || c === "'") {
      const q = c;
      while (++k < s.length && s[k] !== q) if (s[k] === '\\') k++;
    }
  }
  return -1;
}

/**
 * 把样式表扫成一串"规则块"。返回 `{ path, prelude, decls }`：
 * `path` 是外层 at-rule 前奏（如 `@media (min-width:…)`），`prelude` 是本块的选择器。
 * 关键帧里的 `0% { … }` 也会被收进来，`path` 里带着 `@keyframes x` —— 调用方据此过滤。
 */
export function scanRules(css) {
  const src = stripComments(css);
  const rules = [];
  const stack = [];
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { stack.push(buf.trim()); buf = ''; }
    else if (c === '}') {
      const prelude = stack.pop() ?? '';
      const decls = buf.trim();
      if (decls) rules.push({ path: [...stack], prelude, decls });
      buf = '';
    } else buf += c;
  }
  return rules;
}

/** 所有 `@keyframes <name>` 块：名字 → `{ name, body, vendor }`（body 含 `@keyframes name {…}` 全量） */
export function extractKeyframes(css) {
  const src = stripComments(css);
  const out = new Map();
  const re = /@(-[a-z]+-)?keyframes\s+([A-Za-z0-9_\\-]+)\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const at = m.index;
    const end = matchBrace(src, re.lastIndex - 1);
    if (end < 0) continue;
    const name = m[2].replace(/\\/g, '');
    if (!out.has(name)) out.set(name, { name, body: src.slice(at, end + 1), vendor: !!m[1] });
  }
  return out;
}

/**
 * 从 dom.html 里再捞一遍动效：`style="animation: …"` 这种**内联**写法不在样式表里，
 * 只扫 cssom.css 会把它们误判成"定义了没人用"。
 * 实测 thordata 首页 18 组关键帧里有 15 组就是靠内联样式挂上去的（Vue/React 常这么干）。
 */
export function inlineMotion(dom) {
  const out = [];
  const re = /<([a-zA-Z][\w-]*)\b[^>]*?\bstyle="([^"]*)"/g;
  let m;
  while ((m = re.exec(String(dom ?? '')))) {
    for (const v of animationValues(m[2])) {
      if (!v.name || v.name === 'none') continue;
      out.push({
        selector: `inline:${m[1].toLowerCase()}`,
        at: 'inline style',
        inline: true,
        name: v.name,
        duration: v.duration ?? null,
        delay: v.delay ?? null,
        timing: v.timing ?? null,
        iterations: v.iterations ?? null,
        defined: null,          // 由调用方对着关键帧表回填
      });
    }
  }
  return out;
}

const TIMING_KEYWORDS = new Set(['ease', 'ease-in', 'ease-out', 'ease-in-out', 'linear', 'step-start', 'step-end']);
const DIRECTION_KEYWORDS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILL_KEYWORDS = new Set(['none', 'forwards', 'backwards', 'both']);
const PLAY_KEYWORDS = new Set(['running', 'paused']);
const TIME_RE = /^[+-]?(\d+\.?\d*|\.\d+)(ms|s)$/i;

/** 把 `animation:` 简写按空格切开，但 `cubic-bezier(a, b, c, d)` / `steps(…)` 不拆 */
function splitShorthand(v) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of v) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && !depth) { if (cur) parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * 解析一条 `animation:` 简写。顺序无关（CSS 简写的规则就是"看值的形态"），
 * 两个时间值分别是 duration / delay，剩下的按关键字归类，认不出的那个当动画名。
 * `fill-mode: none` 与"没写"无法区分，所以只在有多个候选时才认它是 fill。
 */
export function parseShorthand(value) {
  const out = { name: null, duration: null, delay: null, timing: null, iterations: null, direction: null, fill: null, playState: null, unknown: [] };
  const tokens = splitShorthand(String(value).trim());
  const times = [];
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (TIME_RE.test(low)) { times.push(low); continue; }
    if (low === 'infinite' || /^\d+\.?\d*$/.test(low)) { out.iterations = low; continue; }
    if (low.startsWith('cubic-bezier(') || low.startsWith('steps(') || low.startsWith('linear(') || TIMING_KEYWORDS.has(low)) { out.timing = low; continue; }
    if (DIRECTION_KEYWORDS.has(low) && out.direction === null) { out.direction = low; continue; }
    if (FILL_KEYWORDS.has(low) && out.fill === null && low !== 'none') { out.fill = low; continue; }
    if (PLAY_KEYWORDS.has(low)) { out.playState = low; continue; }
    if (low === 'none' && out.fill === null) { out.fill = 'none'; continue; }
    if (!out.name) { out.name = t; continue; }
    out.unknown.push(t);
  }
  out.duration = times[0] ?? null;
  out.delay = times[1] ?? null;
  return out;
}

/** 一条声明块里所有 `animation` / `animation-name` 的取值（含逗号分隔的多条） */
function animationValues(decls) {
  const found = [];
  for (const decl of decls.split(';')) {
    const m = /^\s*animation(-name)?\s*:\s*(.+)$/i.exec(decl);
    if (!m) continue;
    const isNameOnly = !!m[1];
    // 逗号分隔的多条动画：只在括号外切
    let depth = 0, cur = '', parts = [];
    for (const ch of m[2]) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && !depth) { parts.push(cur); cur = ''; continue; }
      cur += ch;
    }
    parts.push(cur);
    for (const p of parts.map(s => s.trim()).filter(Boolean)) found.push(isNameOnly ? { name: p, fromNameOnly: true } : { ...parseShorthand(p), raw: p });
  }
  return found;
}

const keyframePath = (r) => r.path.some(p => /@(-[a-z]+-)?keyframes/.test(p));

/**
 * 主入口：一段 CSS（+ 可选的 dom.html）→ 动效清单。
 *
 * @param {string} css 通常就是 pages/<page>/cssom.css
 * @param {{dom?: string}} [opts] 传 dom.html 才能认出内联 `style="animation:…"` 的用法
 * @returns {{animations: Array, keyframes: Array, stats: object}}
 */
export function collectCssMotion(css, { dom = '' } = {}) {
  const rules = scanRules(css);
  const kfMap = extractKeyframes(css);
  const animations = [];
  for (const r of rules) {
    if (keyframePath(r)) continue;                       // 关键帧内部的 0%/100% 不是规则
    for (const v of animationValues(r.decls)) {
      const name = v.name ?? null;
      if (!name || name === 'none') continue;
      animations.push({
        selector: r.prelude,
        at: r.path.length ? r.path.join(' ').slice(0, 120) : null,
        inline: false,
        name,
        duration: v.duration ?? null,
        delay: v.delay ?? null,
        timing: v.timing ?? null,
        iterations: v.iterations ?? null,
      });
    }
  }
  for (const v of inlineMotion(dom)) animations.push(v);
  for (const a of animations) a.defined = kfMap.has(a.name);
  // 排序保证同样输入得到同样输出（同一条命令跑两次结果一致是这个项目的硬要求）
  animations.sort((a, b) => (a.name + a.selector).localeCompare(b.name + b.selector));
  const used = new Set(animations.filter(a => a.defined).map(a => a.name));
  const keyframes = [...kfMap.values()]
    .map(k => ({ name: k.name, body: k.body, used: used.has(k.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const looping = animations.filter(a => a.iterations === 'infinite').length;
  return {
    animations,
    keyframes,
    stats: {
      rules: animations.length,
      named: new Set(animations.map(a => a.name)).size,
      inline: animations.filter(a => a.inline).length,
      looping,
      definedKeyframes: keyframes.length,
      // 定义了却没有任何 animation 引用 —— 大半是"脚本按需挂上去"的入场动效
      unusedKeyframes: keyframes.filter(k => !k.used).map(k => k.name),
      missingKeyframes: [...new Set(animations.filter(a => !a.defined).map(a => a.name))],
    },
  };
}

/**
 * 把关键帧拼成一份可以**直接粘进自己项目**的样式表。
 *
 * 分成两段，**第二段往往比第一段值钱**：
 *   · 在用的 —— 常驻样式表里、打开镜像就在播的。
 *   · 定义了但捕获时没被引用的 —— 入场/滚动揭示类动效几乎都长这样：关键帧常驻，
 *     而引用它的那条规则（`.fadeInDown-enter-active{animation:…}`）只在过渡的那几百毫秒里
 *     存在，我们静止采样时它已经没了。实测 thordata 首页 18 组关键帧里 15 组属于这类。
 *     所以这不是"没人用的垃圾"，而是**我们抓不到引用、但代码已经在手**的那部分动效。
 */
export function renderMotionCss(motion, { host = '', page = '' } = {}) {
  const used = motion.keyframes.filter(k => k.used);
  const unused = motion.keyframes.filter(k => !k.used);
  const head = [
    `/* 动效关键帧 · ${host}${page ? ' · ' + page : ''}`,
    ' * 从原站 cssom.css 原样抽出，可直接粘进自己的样式表，再用 animation: 引用。',
    ` * A 段 ${used.length} 组：打开镜像就在播的。`,
    ` * B 段 ${unused.length} 组：定义了但捕获时没被引用 —— 多半是入场/滚动揭示动效，`,
    ' *   引用它的类只在过渡那几百毫秒里存在，静止采样看不到。',
    ' */',
    '',
  ].join('\n');
  const body = ['/* ── A · 在用的 ── */', ''];
  body.push(...(used.length ? used.map(k => `${k.body}\n`) : ['/* 无 */\n']));
  if (unused.length) {
    body.push('/* ── B · 定义了但捕获时没被引用（入场 / 揭示类动效） ── */', '');
    body.push(...unused.map(k => `${k.body}\n`));
  }
  return head + body.join('\n');
}
