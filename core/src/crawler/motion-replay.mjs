#!/usr/bin/env node
/**
 * motion-replay — 把静态镜像里"停住"的**揭示类**动效，用纯 CSS 重演一遍
 *
 * ══ 先把边界说清楚，免得下一个人以为我们在"逐帧复刻" ══
 *
 * 静态镜像是**脚本全剥**的那一份，所以 JS 驱动的动效在里面是死的一帧。这件事没法
 * 靠"把脚本搬回来"解决 —— 那等于把静态镜像变成交互镜像，两条产物的承诺就混了。
 *
 * 能做的是**重演（replay）**：把原站动效的**可观察形态**重新写成 CSS。
 * 对揭示类动效这件事是成立的，因为两头都是确定的：
 *   · 终态 —— 就是我们捕获到的那一帧（原站自己在行内样式里写着 `opacity:1; transform:none`）；
 *   · 起始态 —— 揭示类动效的约定就是"从不可见/下移一点进来"。
 * 我们给出的是**形状**，不是原站那条曲线的还原。
 *
 * 能做到的两类（都已实现）：
 *
 *   A · **揭示类**（fade/slide in）—— 两头都是确定的：终态就是我们捕获到的那一帧
 *       （原站自己在行内样式里写着 `opacity:1; transform:none`），起始态是这类动效的约定。
 *   B · **脚本创建的动画**（`Element.animate()`）—— 它的关键帧是**以数据形式**传进来的，
 *       捕获那一刻记下来（见 motion.mjs 的 MOTION_INIT），就能原样改写成 CSS 关键帧。
 *       打字机、自动轮播、一部分 Framer/GSAP 动效走的就是这条路。
 *
 * 仍然做不到的、以及为什么（不要假装能做到）：
 *   · **走行内样式或 setInterval 的脚本动效** —— Swiper 那类直接改 `style.transform`，
 *     连"有哪些动画"都采不到。要复刻它们必须先采"每帧长什么样"（双帧采样），不在这一版。
 *   · **画布 / WebGL / Lottie** —— 动的是像素，不是 DOM（画布已经由 capture 光栅化成了静态图）。
 *
 * ══ 三个刻意的技术选择 ══
 *
 * ① 只动 `opacity` 与 `translate`（**独立变换属性**），**不动 `transform`**。
 *    原站把元素定位写在行内 `transform` 上（实测 framer 的 appear 元素就是
 *    `transform: none` 之外还有大把真正带值的），用 transform 做动画会把它整个盖掉 ——
 *    那是"把版面弄坏"级别的错误。`translate`/`rotate`/`scale` 与 `transform` 是**相乘**关系，
 *    所以叠加是安全的。
 * ② `animation-timeline: view()` —— 滚动驱动，**纯 CSS，不引入任何脚本**。
 *    静态镜像"脚本全剥"的承诺不能破；这也是它和交互镜像的分界。
 *
 * ══ 为什么它不会影响保真度分数 ══
 *
 * 截图评分前会注入 FREEZE（`animation-duration:0s !important`，见 freeze.mjs），
 * 我们的揭示动画会被一次推进到**终态**（也就是捕获到的那一帧）。
 * 所以"镜像里动起来了"和"评分仍然准"两件事不冲突。
 *
 * 用法:
 *   node src/crawler/motion-replay.mjs <pageDir>           单页
 *   node src/crawler/motion-replay.mjs <host> --all        整站（只看已克隆的页）
 *   node src/crawler/motion-replay.mjs <host> --all --dry  只报告，不写盘
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';

/** 注入标记：幂等靠它（重跑时先按它把旧的一段换掉，而不是追加第二份） */
export const REPLAY_MARK = 'heimdall:motion-replay';
export const REPLAY_FILE = 'motion-replay.css';

/**
 * 会被重演的标记选择器，按**驱动方式**分成两组 —— 这个划分是实测出来的，不是猜的。
 *
 * 拿 framer.com/cms 的真站量了一次（视口 1440×900）：
 *   t≈0.3s  所有 151 个 appear 元素 opacity 都是 0.00（含视口外 57 个）
 *   t≈1.8s  视口内的多数已到 1.00，视口外也有 42/57 变成了可见
 *   滚动后  剩下的一并reveal
 * 也就是说 Framer 的 appear **主要在加载时登场**（带一点滚动兜底），
 * 而不是"滚到哪儿才动哪儿"。所以对它用滚动时间线是**错的**：
 * 那会让首屏以下的内容在★不滚动的情况下永远不出现★，而原站 1.8 秒后就有了。
 *
 * A 组 = 加载时登场（时间驱动）；B 组 = 滚动揭示（滚动时间线驱动）。
 */
export const APPEAR_MARKERS = ['[data-framer-appear-id]', '[data-animate]', '[class*="animate-in"]'];
export const SCROLL_MARKERS = ['[data-aos]', '[data-sal]', '[data-scroll]', '.wow', '[class*="reveal"]'];
export const MARKERS = [...APPEAR_MARKERS, ...SCROLL_MARKERS];

/** 展示用的中文名，报告里出现 */
const MARKER_CN = {
  '[data-framer-appear-id]': 'Framer 登场',
  '[data-animate]': 'data-animate 登场',
  '[class*="animate-in"]': 'animate-in 入场',
  '[data-aos]': 'AOS 滚动揭示',
  '[data-sal]': 'Sal 滚动揭示',
  '[data-scroll]': 'data-scroll 揭示',
  '.wow': 'WOW.js 揭示',
  '[class*="reveal"]': '类名含 reveal',
};

/** 一条揭示动画的节拍与形状（两组共用，保证"动起来的观感"一致） */
const DUR = '700ms';
const EASE = 'cubic-bezier(.16, 1, .3, 1)';

/**
 * 从 motion.json 里挑出**实际出现过**的标记。
 * motion.json 的 examples 形如 `[data-framer-appear-id] × 72`；解析失败就丢掉那条。
 * @returns {string[]} 按 MARKERS 的顺序（保证同样输入得到同样输出）
 */
export function markersIn(motion) {
  const seen = new Set();
  for (const ex of motion?.drivers?.scrollReveal?.examples ?? []) {
    if (typeof ex !== 'string') continue;
    const sel = ex.split(' ×')[0].trim();
    if (MARKERS.includes(sel)) seen.add(sel);
  }
  // 老产物的 motion.json 可能是按选择器名直接给的，两种形状都认
  for (const k of Object.keys(motion?.reveal ?? {})) if (MARKERS.includes(k)) seen.add(k);
  return MARKERS.filter(m => seen.has(m));
}

/**
 * 生成重演样式表。没有可重演的标记时返回空串（调用方据此"什么都不做"）。
 * @param {{markers: string[], page?: string, host?: string}} opts
 */
export function buildReplayCss({ markers = [], page = '', host = '' } = {}) {
  const appear = APPEAR_MARKERS.filter(m => markers.includes(m));
  const scroll = SCROLL_MARKERS.filter(m => markers.includes(m));
  if (!appear.length && !scroll.length) return '';
  const head = [
    `/* ${REPLAY_MARK} · v1`,
    ` * ${host}${page ? ' · ' + page : ''} —— 揭示类动效的纯 CSS 重演（无脚本）。`,
    ' * 起始态由我们给，终态就是捕获到的那一帧；动的是 opacity 与 translate（独立变换属性），',
    ' * 不碰 transform —— 原站把定位写在 transform 上，覆盖它会弄坏版面。',
    ' * 截图评分时会被 FREEZE 一次推到终态，因此不影响分数（实测同页注入前后 total / pixel / data 三项完全一致）。',
    ` * A 组（加载时登场）：${appear.join(' ') || '无'}`,
    ` * B 组（滚动揭示）：${scroll.join(' ') || '无'}`,
    ' */',
    '@media (prefers-reduced-motion: no-preference) {',
  ];
  if (appear.length) {
    head.push(
      '  /* A · 加载时登场。实测原站：t≈0.3s 全部 opacity 0，t≈1.8s 大多已到 1 —— 是登场不是滚动触发 */',
      `  ${appear.join(', ')} {`,
      `    animation: heimdall-reveal-in ${DUR} ${EASE} both;`,
      '  }',
    );
  }
  if (scroll.length) {
    head.push(
      '  /* B · 滚动揭示。纯 CSS 滚动时间线，不引入脚本（静态镜像"脚本全剥"的承诺不能破） */',
      '  @supports (animation-timeline: view()) {',
      `    ${scroll.join(', ')} {`,
      `      animation: heimdall-reveal-in ${DUR} ${EASE} both;`,
      '      animation-timeline: view();',
      '      animation-range: entry 0% cover 35%;',
      '    }',
      '  }',
    );
  }
  head.push('}', '@keyframes heimdall-reveal-in {', '  from { opacity: 0; translate: 0 22px; }', '  to   { opacity: 1; translate: none; }', '}');
  return head.join('\n') + '\n';
}

/**
 * 这些选择器上**不重演** —— 它们描述的正是"还没加载完"或"临时通知"，
 * 在静态镜像里复刻它们是错的：内容早就加载完了，把骨架屏的呼吸动画放进去只会骗人。
 */
const WAAPI_DENY = /spinner|skeleton|loading|shimmer|pulse|ripple|cookie|consent|toast|tooltip|dropdown|accordion/i;

/** 把 WAAPI 记录的关键帧偏移归一成百分比 */
function offsetPct(f, i, n) {
  const o = f?.offset;
  if (typeof o === 'number') return (o * 100).toFixed(1) + '%';
  if (typeof o === 'string') return /%$/.test(o.trim()) ? o.trim() : (Number(o) * 100).toFixed(1) + '%';
  return i === 0 ? '0%' : (i === n - 1 ? '100%' : ((i / (n - 1)) * 100).toFixed(1) + '%');
}

/**
 * 只放行**完整**的缓动函数。
 *
 * 实测踩到：脚本给的 easing 可能是 `linear(0, 0.0016, 0.0062, …, 100ms, …)` 这种
 * **多停靠点**写法（CSS `linear()` 缓动）。上一版按 40 字符截断，正好切在函数中间 ——
 * 生成出来的是一条括号不配对的 CSS 声明，整条 `animation` 都作废，
 * 而且**不报错**：浏览器只是安静地不播那个动画。校验里"括号必须配对"这一条就是为它立的。
 */
function safeEasing(e) {
  if (typeof e !== 'string') return 'linear';
  const s = e.trim();
  if (/^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(s)) return s;
  const m = /^(cubic-bezier|steps|linear)\(([^()]*)\)$/.exec(s);
  if (!m) return 'linear';
  if (!/^[\w\s.,%+-]*$/.test(m[2])) return 'linear';   // 只允许数字/逗号/百分号/关键字
  return s;
}

/**
 * 把捕获到的 WAAPI 动效（脚本创建的动画的**关键帧 + 时序**）改写成 CSS。
 *
 * 这是"打字机 / 自动轮播也能复刻"的那条路：它们的动画不是写在样式表里，
 * 而是以数据形式传给 `Element.animate()`，所以只有捕获那一刻能记下来（见 motion.mjs）。
 * 记下来的东西足够原样重写成 `@keyframes` + `animation:`。
 *
 * 明确**不做**的两类（不是做不到，是不该做）：
 *   · 命中 WAAPI_DENY 的（骨架屏呼吸、加载转圈、cookie 提示）——内容早就加载完了，重演是骗人。
 *   · 没有稳定类名的目标 —— 捕获之后 DOM 会被改写（剥 link、canvas 换 img），
 *     路径选择器会指到错的元素上。**指错比不做更糟**。
 */
export function buildWaapiCss(specs = [], { max = 12 } = {}) {
  const usable = [];
  const taken = new Set();
  // 按选择器排序：同一份输入必须得到同一份输出（这个项目的硬要求）
  for (const s of [...(Array.isArray(specs) ? specs : [])].sort((a, b) => String(a?.selector).localeCompare(String(b?.selector)))) {
    if (!s?.selector || !Array.isArray(s.frames) || s.frames.length < 2) continue;
    if (WAAPI_DENY.test(s.selector)) continue;
    if (taken.has(s.selector)) continue;
    taken.add(s.selector);
    usable.push(s);
    if (usable.length >= max) break;
  }
  if (!usable.length) return '';
  const out = [
    `/* ${REPLAY_MARK} · 脚本动效重写（WAAPI）`,
    ' * 这些动画原本由脚本创建（不在样式表里），关键帧是捕获时从 Element.animate() 记下来的。',
    ' * 骨架屏 / 加载转圈 / cookie 提示一类**刻意不重演** —— 静态镜像里内容早就加载完了。',
    ' */',
  ];
  const rules = [];
  usable.forEach((s, i) => {
    const name = 'heimdall-waapi-' + i;
    const n = s.frames.length;
    out.push(`@keyframes ${name} {`);
    s.frames.forEach((f, k) => {
      const decls = Object.entries(f).filter(([p]) => p !== 'offset').map(([p, v]) => `${p}: ${v};`).join(' ');
      if (decls) out.push(`  ${offsetPct(f, k, n)} { ${decls} }`);
    });
    out.push('}');
    const timing = [
      `${Number.isFinite(s.duration) ? s.duration : 400}ms`,
      safeEasing(s.easing),
      s.delay ? `${s.delay}ms` : null,
      s.iterations === 'infinite' ? 'infinite' : (s.iterations && s.iterations > 1 ? String(s.iterations) : null),
      s.direction && s.direction !== 'normal' ? s.direction : null,
      'both',
    ].filter(Boolean).join(' ');
    rules.push(`  ${s.selector} { animation: ${name} ${timing}; }`);
  });
  out.push('@media (prefers-reduced-motion: no-preference) {', ...rules, '}');
  return out.join('\n') + '\n';
}

/**
 * 把样式表链接插进一份 clone HTML 的 `<head>` 里。**幂等**：已经有了就原地替换。
 * 支持 `<link>`（外部文件，优先）与 `<style>`（内联兜底，file:// 打开某些环境更稳）。
 */
export function injectReplayLink(html, { file = REPLAY_FILE, inline = null } = {}) {
  const src = String(html ?? '');
  const block = inline == null
    ? `<!-- ${REPLAY_MARK} --><link rel="stylesheet" href="${file}">`
    : `<!-- ${REPLAY_MARK} --><style>${inline}</style>`;
  // 已经把标记 + 紧跟其后的那一个标签一起吃掉（只吃标记、留下旧的 `>` 会拼出坏标签）
  const existing = new RegExp(`<!--\\s*${REPLAY_MARK}\\s*-->\\s*(?:<style\\b[^>]*>[\\s\\S]*?</style>|<link\\b[^>]*>)`, 'gi');
  if (existing.test(src)) return src.replace(existing, block);
  if (/<\/head>/i.test(src)) return src.replace(/<\/head>/i, block + '</head>');
  // 没有 head（罕见的骨架）就放在最前面 —— 样式表在后面才生效也不迟
  return block + src;
}

/** 一份 HTML 里还有没有我们注入的块 */
export const hasReplay = (html) => new RegExp(`<!--\\s*${REPLAY_MARK}\\s*-->`).test(String(html ?? ''));

/** clone 目录里所有需要注入的 HTML（多视口克隆会有 index-375/768/1440.html） */
function cloneHtmls(cloneDir) {
  if (!existsSync(cloneDir)) return [];
  return readdirSync(cloneDir)
    .filter(n => /^index(-[0-9]+)?\.html$/i.test(n))
    .sort()
    .map(n => join(cloneDir, n));
}

/**
 * 对一页执行重演：读 motion.json → 生成 CSS → 写文件 + 注入链接。
 * @returns {{page: string, markers: string[], wrote: boolean, note: string}}
 */
export function applyToPage(pageDir, { dry = false } = {}) {
  const page = pageDir.split(/[\\/]/).filter(Boolean).pop();
  const motionPath = join(pageDir, 'motion.json');
  if (!existsSync(motionPath)) return { page, markers: [], wrote: false, note: '没有 motion.json（这一页没采过动效）' };
  let motion;
  try { motion = JSON.parse(readFileSync(motionPath, 'utf8')); } catch { return { page, markers: [], wrote: false, note: 'motion.json 读不动' }; }
  const markers = markersIn(motion);
  const waapi = Array.isArray(motion.waapi) ? motion.waapi : [];
  const css = buildReplayCss({ markers, page }) + buildWaapiCss(waapi);
  if (!css.trim()) {
    return { page, markers, wrote: false, note: '没有可重演的动效（揭示标记与脚本关键帧都没有）' };
  }

  const cloneDir = join(pageDir, 'clone');
  const htmls = cloneHtmls(cloneDir);
  if (!htmls.length) return { page, markers, wrote: false, note: '没有 clone/index.html' };

  const waapiUsed = (css.match(/@keyframes heimdall-waapi-/g) ?? []).length;
  if (dry) return { page, markers, wrote: false, note: `dry-run：揭示 ${markers.length} 个标记 · 脚本动效 ${waapiUsed} 条` };

  writeFileAtomic(join(cloneDir, REPLAY_FILE), css);
  let n = 0;
  for (const h of htmls) {
    const before = readFileSync(h, 'utf8');
    const after = injectReplayLink(before);
    if (after !== before) { writeFileAtomic(h, after); n++; }
  }
  return { page, markers, wrote: true, note: `注入了 ${n} 份 HTML · 揭示 ${markers.length} 个标记 · 脚本动效 ${waapiUsed} 条` };
}

/** 整站：只看已克隆的页（有 clone/index.html 的） */
export function applyToHost(host, { dry = false } = {}) {
  const base = join(WORKSPACE, host);
  const pagesDir = join(base, 'pages');
  if (!existsSync(pagesDir)) return [];
  const out = [];
  for (const name of readdirSync(pagesDir).sort()) {
    const pageDir = join(pagesDir, name);
    if (!statSync(pageDir).isDirectory()) continue;
    if (!existsSync(join(pageDir, 'clone', 'index.html'))) continue;
    out.push(applyToPage(pageDir, { dry }));
  }
  return out;
}

// ---------- CLI ----------
const isMain = process.argv[1] && /motion-replay\.mjs$/.test(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  const target = requireArg(process.argv[2], 'node src/crawler/motion-replay.mjs <pageDir|host> [--all] [--dry]', '页面目录或站点 host');
  const all = process.argv.includes('--all');
  const dry = process.argv.includes('--dry');
  const rows = all ? applyToHost(target, { dry }) : [applyToPage(target, { dry })];
  let wrote = 0, marks = 0;
  for (const r of rows) {
    if (r.wrote) { wrote++; marks += r.markers.length; console.log(`  ✓ ${r.page.padEnd(34)} ${r.note}`); }
    else if (dry && r.markers.length) console.log(`  · ${r.page.padEnd(34)} ${r.note}`);
  }
  console.log(`[motion-replay] ${wrote}/${rows.length} 页写入 · 重演标记合计 ${marks} 个`);
}
