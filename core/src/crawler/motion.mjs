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
  const seen = { animations: {}, transitions: {}, waapi: [] };
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

  /**
   * 把 `Element.animate()` 的**内容**记下来，而不只是"调用过一次"。
   *
   * 为什么值得记：这是**唯一**能拿到 JS 动效"长什么样"的地方 —— 脚本创建的动画
   * 不在样式表里，cssom.css 里没有它，抓完就永远丢了。而它的关键帧是**以数据形式**
   * 传进来的（`[{opacity:0},{opacity:1}]`），记下来就能原样改写成 CSS 重演。
   * （打字机、自动轮播、Framer/GSAP 的一部分都走这条路；走行内样式或 setInterval 的抓不到，
   *   那属于"双帧采样"该解决的事。）
   *
   * 三条自我约束：
   *   · 只记**安全属性**（opacity / translate / scale / rotate / filter）。`transform`
   *     刻意不记：它常与元素的行内定位耦合，重演时覆盖它会弄坏版面。
   *   · 只记**能定位到稳定类名**的目标。没有类名就丢掉 —— 路径选择器在捕获后 DOM 被
   *     改写过（剥 link、canvas 换 img）之后会指错元素，指错比不做更糟。
   *   · 条数有上限。整页几百个动画既写不完也没意义。
   */
  const SAFE_PROP = { opacity: 1, translate: 1, scale: 1, rotate: 1, filter: 1 };
  const MAX_SPECS = 24;   // 整页几百个动画既写不完也没意义

  /**
   * 把 `transform` 的常见写法搬到**独立变换属性**上（translate / scale / rotate）。
   *
   * 为什么不干脆记下 transform 原样重演：独立属性与 transform 是**相乘**关系，
   * 而 transform 会整个覆盖元素的行内定位 —— 一旦我们把 transform 写进 `@keyframes`
   * 并用 `fill: both` 挂在元素上，动画结束后元素就永久停在那个 transform 上，
   * 原站用来定位的那份 transform 被顶掉了。拆成独立属性就没有这个问题。
   * 认不出来的（matrix / skew / perspective / 混合多函数）返回 null —— **宁可不做，不可做错**。
   * 实测 linear.app/agents 的入场动效就是 `translateY(20%)` + `blur(10px)`，正好落在能认的这一类。
   */
  const tfToIndep = (v) => {
    const s = String(v).trim();
    if (!s) return null;
    if (s === 'none') return { translate: 'none', scale: 'none', rotate: 'none' };
    const out = {};
    const known = /^(translate3d|translateX|translateY|translate|scale3d|scaleX|scaleY|scale|rotate)$/i;
    let count = 0;
    const re = /([a-zA-Z0-9]+)\(\s*([^)]*)\)/g;
    let m;
    while ((m = re.exec(s))) {
      const fn = m[1], args = m[2].trim().replace(/\s*,\s*/g, ' ');
      if (!known.test(fn)) return null;
      const f = fn.toLowerCase();
      if (f === 'translate' || f === 'translated') out.translate = args;
      else if (f === 'translate3d') { const a = args.split(' '); out.translate = a[0] + ' ' + (a[1] ?? '0'); }
      else if (f === 'translatex') out.translate = args + ' 0';
      else if (f === 'translatey') out.translate = '0 ' + args;
      else if (f === 'scale') out.scale = args;
      else if (f === 'scale3d') { const a = args.split(' '); out.scale = a[0] + ' ' + (a[1] ?? a[0]); }
      else if (f === 'scalex') out.scale = args + ' 1';
      else if (f === 'scaley') out.scale = '1 ' + args;
      else if (f === 'rotate') out.rotate = args;
      count++;
    }
    // 有没被吃掉的字符 = 有认不出的函数（或 matrix 之类），放弃。
    // 注意**不能**用 `re.lastIndex` 来判断：exec 匹配失败时会把 lastIndex 归零，
    // 于是"循环结束"和"一个都没匹配到"看起来一模一样 —— 那会让这个函数永远返回 null。
    if (!count) return null;
    if (s.replace(/[a-zA-Z0-9]+\(\s*[^)]*\)/g, '').trim()) return null;
    return Object.keys(out).length ? out : null;
  };

  /**
   * 关键帧有两种形状，都得认：
   *   · 数组形式 `[{opacity:0, offset:0}, {opacity:1, offset:1}]`
   *   · **字典形式** `{opacity:[0,1], transform:['translateY(20%)','none'], offset:[0,1]}`
   * 字典形式是实际最常见的一种（实测 linear.app/agents 20 条全是它）——
   * 上一版只认数组形式，于是那条路径**一条都没记下来**，而报告上看起来一切正常。
   */
  const toFrameArray = (frames) => {
    if (Array.isArray(frames)) return frames;
    if (frames && typeof frames === 'object') {
      const keys = Object.keys(frames);
      let len = 1;
      for (const k of keys) if (Array.isArray(frames[k])) len = Math.max(len, frames[k].length);
      const arr = [];
      for (let i = 0; i < len; i++) {
        const o = {};
        for (const k of keys) {
          const v = frames[k];
          o[k] = Array.isArray(v) ? v[Math.min(i, v.length - 1)] : v;
        }
        arr.push(o);
      }
      return arr;
    }
    return null;
  };

  const normFrames = (frames) => {
    const arr = toFrameArray(frames);
    if (!arr) return null;
    const out = [];
    for (const f of arr.slice(0, 12)) {
      if (!f || typeof f !== 'object') continue;
      const o = {};
      if (typeof f.offset === 'number') o.offset = f.offset;
      for (const k of Object.keys(f)) {
        if (k === 'offset') continue;
        if (SAFE_PROP[k]) { o[k] = String(f[k]).slice(0, 60); continue; }
        if (k === 'transform') { const t = tfToIndep(f[k]); if (!t) return null; Object.assign(o, t); }
      }
      if (Object.keys(o).filter(k => k !== 'offset').length) out.push(o);
    }
    return out.length >= 2 ? out : null;
  };
  const selOf = (el) => {
    try {
      const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/)
        .filter(c => c && c.length <= 40).slice(0, 2);
      if (!cls.length) return null;
      const esc = (c) => (typeof self !== 'undefined' && self.CSS && self.CSS.escape ? self.CSS.escape(c) : c.replace(/[^\w-]/g, '\\$&'));
      return el.tagName.toLowerCase() + '.' + cls.map(esc).join('.');
    } catch { return null; }
  };
  const record = (el, frames, options) => {
    if (seen.waapi.length >= MAX_SPECS) return;
    const selector = selOf(el);
    if (!selector) return;
    const nf = normFrames(frames);
    if (!nf) return;
    const o = typeof options === 'number' ? { duration: options } : (options ?? {});
    seen.waapi.push({
      selector,
      frames: nf,
      duration: typeof o.duration === 'number' ? o.duration : null,
      delay: typeof o.delay === 'number' ? o.delay : null,
      iterations: o.iterations === Infinity ? 'infinite' : (typeof o.iterations === 'number' ? o.iterations : null),
      easing: typeof o.easing === 'string' ? o.easing.slice(0, 200) : null,
      direction: typeof o.direction === 'string' ? o.direction : null,
      fill: typeof o.fill === 'string' ? o.fill : null,
    });
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
  // 全局兜底：任何脚本创建的动画（Web Animations API）也记一笔，并尽量记下它的关键帧
  try {
    if (window.Element?.prototype?.animate) {
      const orig = Element.prototype.animate;
      Element.prototype.animate = function (frames, options) {
        try {
          bump(seen.animations, `[waapi] @ ${key(this)}`);
          record(this, frames, options);
        } catch { /* 记不上也绝不能影响页面本身 */ }
        return orig.apply(this, arguments);
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
  //    **不要再把 `[data-framer-name]` 放进来**：那是 Framer 给几乎每个图层都打的命名属性
  //    （实测 framer.com/cms 一页 1361 个），当标记用会把 scrollReveal 计数吹大两个数量级 ——
  //    而报告上那是一个看起来完全正常的错数字。真标记是 `[data-framer-appear-id]`。
  const reveal = {};
  for (const s of ['[data-aos]', '[data-framer-appear-id]', '.wow', '[class*="reveal"]', '[class*="animate-in"]', '[data-scroll]', '[data-sal]', '[data-animate]']) {
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
    // 脚本创建的动画的**内容**（关键帧 + 时序）。这是唯一能拿到"JS 动效长什么样"的地方 ——
    // 抓完不记就永远丢了。motion-replay 拿它把这类动效改写成 CSS 重演。
    waapi: Array.isArray(observed?.waapi) ? observed.waapi : [],
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
