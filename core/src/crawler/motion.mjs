/**
 * 动效采集：把"这个页面在动"拆成"**是谁在驱动它**"
 *
 * 来源（吸收自 ai-website-cloner-template 的 framer-and-motion.md，重组进我们的确定性管线）：
 * 动效按驱动源分五类 —— 时间 / 滚动揭示 / 连续滚动 / 状态变化 / 指针画布。
 * 分对类才有意义：滚动揭示要采"揭示前 / 揭示后"两点，时间循环要采多帧，
 * 指针画布只能光栅化。此前我们只有一句 `dynamicShare: 0.68`（"68% 是动态噪声"），
 * 那是对**我们抓不到的东西**的总结，而不是对它是什么的描述。
 *
 * 判据只用**浏览器里可见的证据**，不读源码：
 *   · Web Animations API（`getAnimations()`）—— CSS 动画/过渡与脚本动画都在这里
 *   · 类名标记（`[data-aos]`、`[data-framer-appear-id]`、`[class*="reveal"]` …）
 *   · 全局变量（Lenis / GSAP / Swiper / THREE …）
 *
 * 这是**启发式**，不是事实：滚动揭示类动画常在滚动时才创建，探针按标记计数而不是
 * 按正在跑的动画计数，所以数字偏保守；反过来，一个 `[data-aos]` 元素也可能永远不会
 * 被触发。报告里要连采集口径一起说。
 */

/**
 * 在页面脚本之前装上的**累计观测器**。传给 `page.addInitScript()`。
 *
 * 为什么必须有它：`document.getAnimations()` 只返回**此刻**处于 running/pending 的动画。
 * 而我们的采集时机（滚动扫掠 + 静置之后）恰好是入场动画都播完、什么都没在跑的那一刻 ——
 * 实测 svelte.dev 用瞬时快照采出来是"零动效"，那是**采样方法**的错，不是页面没有动效。
 * animationstart / transitionrun 会冒泡到 document（capture 相），于是"这页上曾经跑过
 * 什么动画"就能被累计下来，而不是靠运气撞上某一帧。
 */
export const MOTION_INIT = () => {
  const seen = { animations: {}, transitions: {} };
  const key = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const c = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + c;
  };
  const bump = (bag, k, extra) => {
    const cur = bag[k] ?? { count: 0, looped: false };
    cur.count++;
    if (extra) cur.looped = true;
    bag[k] = cur;
  };
  document.addEventListener('animationstart', (e) => {
    bump(seen.animations, `${e.animationName || '?'} @ ${key(e.target)}`);
  }, true);
  // animationiteration 只会在同一动画第二次开始时触发 → 这就是"循环动画"的证据
  document.addEventListener('animationiteration', (e) => {
    bump(seen.animations, `${e.animationName || '?'} @ ${key(e.target)}`, true);
  }, true);
  document.addEventListener('transitionrun', (e) => {
    bump(seen.transitions, `${e.propertyName || '?'} @ ${key(e.target)}`);
  }, true);
  // 全局兜底：任何脚本创建的动画（Web Animations API）也记一笔
  try {
    const create = document.createElement.bind(document);
    void create;
    if (window.Element?.prototype?.animate) {
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (...a) {
        try { bump(seen.animations, `[waapi] @ ${key(this)}`); } catch { /* 记不上也不能影响页面 */ }
        return orig.apply(this, a);
      };
    }
  } catch { /* 环境不支持就只靠事件 */ }
  window.__heimdallMotion = seen;
};

/**
 * 再采一次瞬时快照（在滚动扫掠之后）。传给 page.evaluate，**不能闭包引用外部变量**。
 *
 * 刻意不去 `canvas.getContext(...)` 探类型：那会给还没建上下文的画布**真的建一个**，
 * 一页十几个画布就会撞上浏览器的 WebGL 上下文上限，把页面本身搞坏。
 * 只记 canvas 的存在、尺寸与 `data-engine`（three.js 会写）。
 */
export const MOTION_PROBE = () => {
  const short = (el) => {
    if (!el || el.nodeType !== 1) return '?';
    const c = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    return el.tagName.toLowerCase() + c;
  };

  // 1) 正在跑/已排队的动画
  const anims = [];
  try {
    for (const a of Array.from(document.getAnimations?.() ?? []).slice(0, 300)) {
      const t = (() => { try { return a.effect?.getTiming?.() ?? {}; } catch { return {}; } })();
      anims.push({
        kind: a.constructor?.name ?? 'Animation',
        name: a.animationName ?? a.transitionProperty ?? null,
        target: short(a.effect?.target),
        duration: typeof t.duration === 'number' ? t.duration : null,
        iterations: t.iterations === Infinity ? 'infinite' : (t.iterations ?? null),
        scrollTimeline: /Scroll/i.test(a.timeline?.constructor?.name ?? ''),
        state: a.playState ?? null,
      });
    }
  } catch { /* getAnimations 不可用就当没采到 */ }

  // 2) 揭示类动效的标记（它们通常滚动时才创建，快照里抓不到"正在跑"）
  const reveal = {};
  for (const s of ['[data-aos]', '[data-framer-appear-id]', '[data-framer-name]', '.wow', '[class*="reveal"]', '[class*="animate-in"]', '[data-scroll]', '[data-sal]', '[data-animate]']) {
    try { const n = document.querySelectorAll(s).length; if (n) reveal[s] = n; } catch { /* 选择器不合法就跳过 */ }
  }

  // 3) 页面级脚本：平滑滚动/光标跟随/页面过渡会改变**每一次交互**的行为
  const libs = {};
  for (const k of ['lenis', 'AOS', 'Swiper', 'gsap', 'ScrollTrigger', 'THREE', 'locomotiveScroll', 'ScrollMagic', 'barba', 'anime', 'Lottie']) {
    if (window[k]) libs[k] = true;
  }
  if (document.documentElement.classList.contains('lenis')) libs['html.lenis'] = true;

  // 4) 画布与媒体
  const canvas = Array.from(document.querySelectorAll('canvas')).slice(0, 20).map((c) => ({
    px: c.width + 'x' + c.height,
    css: (c.clientWidth || 0) + 'x' + (c.clientHeight || 0),
    engine: c.dataset?.engine ?? null,
  }));
  const video = Array.from(document.querySelectorAll('video')).slice(0, 20).map((v) => ({
    autoplay: !!v.autoplay, loop: !!v.loop, muted: !!v.muted, poster: !!v.poster,
  }));

  return {
    anims, reveal, libs, canvas, video,
    observed: window.__heimdallMotion ?? null,   // 装脚本之前起就开始累计的那份（见 MOTION_INIT）
    smooth: getComputedStyle(document.documentElement).scrollBehavior,
    url: location.href,
  };
};

/** 五类驱动 + 判据说明。顺序即报告里的顺序。 */
export const DRIVERS = ['time', 'scrollReveal', 'scrollContinuous', 'stateChange', 'pointerCanvas'];

const DRIVER_CN = {
  time: '时间驱动',
  scrollReveal: '滚动揭示',
  scrollContinuous: '连续滚动',
  stateChange: '状态变化',
  pointerCanvas: '指针 / 画布',
};

/** 每一类在我们管线里的处置方式 —— 报告里必须说清"所以我们做了什么" */
const HANDLING = {
  time: '冻结（animation/transition duration 0s）+ 多帧采样，取与克隆最接近的一帧计分',
  scrollReveal: '滚动扫掠后采集（避免截到未揭示的状态）；揭示时序差计入动态噪声',
  scrollContinuous: '滚动进度类无法冻结，计入动态噪声并建议用交互镜像看',
  stateChange: '冻结过渡时长，只保留终态；悬停/展开态不体现在静态镜像里。这里只统计**真的跑过**的过渡 —— 只在悬停时才存在的过渡，不交互就采不到',
  pointerCanvas: '光栅化为图片（canvas-N.png）后写入静态镜像',
};

/**
 * 纯函数：原始信号 → 分类结果。可单测。
 * @param {object} raw MOTION_PROBE 的返回值
 */
export function classifyMotion(raw = {}) {
  const anims = Array.isArray(raw.anims) ? raw.anims : [];
  const reveal = raw.reveal ?? {};
  const buckets = Object.fromEntries(DRIVERS.map((d) => [d, []]));

  // 时间 / 状态变化两个桶优先用**累计观测**（曾经跑过的都算），
  // 没有观测数据时才退回瞬时快照 —— 瞬时快照在静置之后基本采不到东西。
  const observed = raw.observed ?? null;
  const observedAnims = Object.entries(observed?.animations ?? {});
  const observedTrans = Object.entries(observed?.transitions ?? {});

  for (const [k, v] of observedAnims) buckets.time.push(`${k} × ${v.count}${v.looped ? ' · 循环播放' : ''}`);
  for (const [k, v] of observedTrans) buckets.stateChange.push(`${k} × ${v.count}`);
  if (!observed) {
    for (const a of anims) {
      if (a.scrollTimeline || a.kind === 'CSSTransition') continue;
      buckets.time.push(`${a.target}${a.name ? ' · ' + a.name : ''}${a.iterations === 'infinite' ? ' · 无限循环' : ''}`);
    }
  }
  if (!observed) for (const a of anims) if (a.kind === 'CSSTransition') buckets.stateChange.push(`${a.target} · ${a.name}`);

  // 连续滚动：滚动时间线是最硬的证据（CSS animation-timeline: scroll()/view()）
  for (const a of anims) {
    if (a.scrollTimeline) buckets.scrollContinuous.push(`${a.target}${a.name ? ' · ' + a.name : ''}（滚动时间线）`);
  }

  // 揭示类：按标记计数（元素数），不是按正在跑的动画数
  for (const [sel, n] of Object.entries(reveal)) buckets.scrollReveal.push(`${sel} × ${n}`);

  // 连续滚动还有两个旁证：滚动驱动的时间线之外，平滑滚动库同样改变滚动行为
  if (raw.libs?.lenis || raw.libs?.['html.lenis'] || raw.smooth === 'smooth') {
    const why = raw.libs?.lenis || raw.libs?.['html.lenis'] ? 'Lenis 平滑滚动' : 'scroll-behavior: smooth';
    buckets.scrollContinuous.push(why + '（滚动行为被接管，滚动截图/回放会不同）');
  }
  if (raw.libs?.ScrollTrigger || raw.libs?.ScrollMagic) {
    buckets.scrollContinuous.push((raw.libs.ScrollTrigger ? 'ScrollTrigger' : 'ScrollMagic') + '（脚本驱动的滚动进度）');
  }

  for (const c of raw.canvas ?? []) buckets.pointerCanvas.push(`canvas ${c.css}${c.engine ? ' · ' + c.engine : ''}`);
  for (const v of raw.video ?? []) {
    if (v.autoplay || v.loop) buckets.pointerCanvas.push(`video ${v.autoplay ? 'autoplay' : 'loop'}${v.muted ? ' muted' : ''}`);
  }

  const counts = Object.fromEntries(DRIVERS.map((d) => [d, buckets[d].length]));
  const total = DRIVERS.reduce((s, d) => s + Math.min(counts[d], 99), 0);

  const rendered = DRIVERS.filter((d) => counts[d]).map((d) => `${DRIVER_CN[d]} ${counts[d]}`).join(' · ');

  return {
    at: new Date().toISOString(),
    url: raw.url ?? null,
    counts,
    drivers: Object.fromEntries(DRIVERS.map((d) => [d, {
      cn: DRIVER_CN[d],
      count: counts[d],
      handling: HANDLING[d],
      examples: buckets[d].slice(0, 8),
    }])),
    libs: raw.libs ?? {},
    smooth: raw.smooth ?? null,
    total,
    summary: total ? rendered : '未检出动效（页面是静态的）',
    why: '判据是浏览器可见的证据（Web Animations API / 类名标记 / 全局变量 / 媒体属性），不是源码。'
      + '滚动揭示类常在滚动时才创建，这里按标记计数，因此偏保守；反过来，带标记的元素未必真的会动。',
  };
}

/** 一句话给人看的结论，供控制台与报告直接引用 */
export function motionLine(motion) {
  if (!motion) return null;
  if (!motion.total) return '未检出动效';
  const parts = DRIVERS.filter((d) => motion.counts?.[d]).map((d) => `${DRIVER_CN[d]} ${motion.counts[d]}`);
  return parts.join(' · ');
}
