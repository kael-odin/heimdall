/**
 * motion-replay 单测 —— 纯函数层（不起浏览器、不联网）
 *
 * 这一批断言里有两条是**防回归的方向性**断言，不只是"跑通"：
 *   · 生成的 CSS **不能出现 `transform:`** —— 原站把元素定位写在行内 transform 上，
 *     用 transform 做揭示动画会把它整个盖掉，是"弄坏版面"级别的错误。
 *   · 注入必须**幂等** —— 重跑整站很容易发生，追加第二份等于动效播两遍、且标签越滚越多。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { markersIn, buildReplayCss, buildWaapiCss, injectReplayLink, hasReplay, applyToPage, MARKERS, REPLAY_MARK, REPLAY_FILE } =
  await import('../src/crawler/motion-replay.mjs');
const { MOTION_INIT } = await import('../src/crawler/motion.mjs');

test('markersIn: 只认已知标记，且顺序由 MARKERS 决定（同样输入得到同样输出）', () => {
  const motion = {
    drivers: { scrollReveal: { examples: ['[data-framer-appear-id] × 72', '[class*="reveal"] × 4', '[data-foo] × 9'] } },
  };
  assert.deepEqual(markersIn(motion), ['[data-framer-appear-id]', '[class*="reveal"]']);
  // 反序输入也要得到同一个结果
  const shuffled = { drivers: { scrollReveal: { examples: ['[class*="reveal"] × 4', '[data-framer-appear-id] × 72'] } } };
  assert.deepEqual(markersIn(shuffled), markersIn(motion));
});

test('markersIn: 认第二种形状（reveal 表），并且不把没出现过的标记塞进来', () => {
  assert.deepEqual(markersIn({ reveal: { '[data-aos]': 3 } }), ['[data-aos]']);
  assert.deepEqual(markersIn({}), []);
  assert.deepEqual(markersIn(null), []);
});

test('buildReplayCss: 没有标记就返回空串（调用方据此"什么都不做"）', () => {
  assert.equal(buildReplayCss({ markers: [] }), '');
  assert.equal(buildReplayCss({ markers: ['[data-nope]'] }), '');
});

test('buildReplayCss: 只写命中的标记 —— 不把整张清单都糊上去', () => {
  const css = buildReplayCss({ markers: ['[data-aos]'], page: 'home', host: 'a.test' });
  assert.ok(css.includes('[data-aos]'));
  for (const m of MARKERS) if (m !== '[data-aos]') assert.ok(!css.includes(m), `不该出现 ${m}`);
  assert.ok(css.includes(REPLAY_MARK), 'CSS 里要带标记，便于人工辨认');
  assert.ok(css.includes('a.test · home'));
});

test('buildReplayCss: 登场类走时间驱动，滚动类走滚动时间线 —— 两组不能混', () => {
  // 实测依据见 motion-replay.mjs 顶部：原站 t≈0.3s 全部 opacity 0、t≈1.8s 大多已到 1，
  // 也就是"加载时登场"。给它挂滚动时间线会让首屏以下的内容**不滚动就永远不出现**。
  const appearCss = buildReplayCss({ markers: ['[data-framer-appear-id]'] });
  assert.ok(appearCss.includes('heimdall-reveal-in'));
  assert.ok(!appearCss.includes('animation-timeline'), '登场类不能挂滚动时间线');
  const scrollCss = buildReplayCss({ markers: ['[data-aos]'] });
  assert.ok(scrollCss.includes('animation-timeline: view()'));
  assert.ok(!scrollCss.includes('[data-framer-appear-id]'));
});

test('buildReplayCss: 只动 opacity 与 translate —— 绝不出现 transform（会盖掉原站的行内定位）', () => {
  const css = buildReplayCss({ markers: MARKERS });
  assert.ok(css.includes('opacity: 0') && css.includes('opacity: 1'));
  assert.ok(css.includes('translate: 0 22px') && css.includes('translate: none'));
  assert.ok(!/[\s;{]transform\s*:/i.test(css), 'transform 一旦出现在这里，就等着把版面弄坏');
  // 滚动驱动 + 纯 CSS：这两条是"静态镜像不带脚本"承诺的技术前提
  assert.ok(css.includes('animation-timeline: view()'));
  assert.ok(!/<script/i.test(css));
  // 尊重减弱动效偏好
  assert.ok(css.includes('prefers-reduced-motion: no-preference'));
});

test('injectReplayLink: 插在 </head> 之前；没有 head 就放最前面', () => {
  const out = injectReplayLink('<html><head><title>t</title></head><body>x</body></html>');
  assert.ok(out.indexOf(REPLAY_MARK) < out.indexOf('</head>'));
  assert.ok(out.includes(`href="${REPLAY_FILE}"`));
  const noHead = injectReplayLink('<div>x</div>');
  assert.ok(noHead.startsWith('<!-- ' + REPLAY_MARK));
});

test('injectReplayLink: 幂等 —— 注入两次与一次完全相同（重跑整站是常态）', () => {
  const once = injectReplayLink('<html><head></head><body></body></html>');
  const twice = injectReplayLink(once);
  assert.equal(twice, once);
  assert.equal((twice.match(new RegExp(REPLAY_MARK, 'g')) || []).length, 1);
});

test('injectReplayLink: 能把上一版的内联 <style> 换成 <link>，不留下半截标签', () => {
  const inline = injectReplayLink('<html><head></head></html>', { inline: 'body{color:red}' });
  assert.ok(inline.includes('<style>body{color:red}</style>'));
  const swapped = injectReplayLink(inline);
  assert.equal(swapped, injectReplayLink('<html><head></head></html>'));
  assert.ok(!swapped.includes('color:red'), '旧的块要被整段替换掉');
  assert.ok(!/<\/style>\s*<\/head>/.test(swapped) || !swapped.includes('<style>'));
});

test('hasReplay: 认得出自己注入过的产物', () => {
  assert.equal(hasReplay(injectReplayLink('<head></head>')), true);
  assert.equal(hasReplay('<head></head>'), false);
});

test('applyToPage: 没有 motion.json / 没有标记 / 没有 clone 时如实说明，不写盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-replay-'));
  const page = join(dir, 'home');
  mkdirSync(page, { recursive: true });
  assert.match(applyToPage(page).note, /没有 motion\.json/);

  writeFileSync(join(page, 'motion.json'), JSON.stringify({ drivers: { scrollReveal: { examples: [] } } }));
  assert.match(applyToPage(page).note, /没有可重演的动效/);

  writeFileSync(join(page, 'motion.json'), JSON.stringify({ drivers: { scrollReveal: { examples: ['[data-aos] × 2'] } } }));
  assert.match(applyToPage(page).note, /没有 clone/);

  mkdirSync(join(page, 'clone'), { recursive: true });
  writeFileSync(join(page, 'clone', 'index.html'), '<html><head></head><body></body></html>');
  const r = applyToPage(page);
  assert.equal(r.wrote, true);
  assert.ok(existsSync(join(page, 'clone', REPLAY_FILE)));
  assert.ok(hasReplay(readFileSync(join(page, 'clone', 'index.html'), 'utf8')));
  // 再跑一次：文件内容不变（幂等）
  const before = readFileSync(join(page, 'clone', 'index.html'), 'utf8');
  applyToPage(page);
  assert.equal(readFileSync(join(page, 'clone', 'index.html'), 'utf8'), before);

  // dry-run 不写盘
  rmSync(join(page, 'clone', REPLAY_FILE));
  const dry = applyToPage(page, { dry: true });
  assert.equal(dry.wrote, false);
  assert.ok(!existsSync(join(page, 'clone', REPLAY_FILE)));
  rmSync(dir, { recursive: true, force: true });
});

test('applyToPage: 多视口克隆（index-1440.html）也要注入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-replay-mv-'));
  const page = join(dir, 'home', 'clone');
  mkdirSync(page, { recursive: true });
  writeFileSync(join(dir, 'home', 'motion.json'), JSON.stringify({ drivers: { scrollReveal: { examples: ['[data-aos] × 1'] } } }));
  writeFileSync(join(page, 'index.html'), '<head></head>');
  writeFileSync(join(page, 'index-1440.html'), '<head></head>');
  writeFileSync(join(page, 'assets.txt'), 'not html');
  const r = applyToPage(join(dir, 'home'));
  assert.match(r.note, /注入了 2 份 HTML/);
  assert.ok(hasReplay(readFileSync(join(page, 'index-1440.html'), 'utf8')));
  assert.ok(!hasReplay(readFileSync(join(page, 'assets.txt'), 'utf8')));
  rmSync(dir, { recursive: true, force: true });
});

/* ───────────── 脚本动效（WAAPI）重写 ───────────── */

test('buildWaapiCss: 把捕获到的关键帧原样改写成 @keyframes + animation', () => {
  const css = buildWaapiCss([{
    selector: 'span.typewriter-caret', frames: [{ opacity: 1 }, { opacity: 0 }],
    duration: 900, delay: 0, iterations: 'infinite', easing: 'steps(2, end)', direction: null, fill: null,
  }]);
  assert.ok(css.includes('@keyframes heimdall-waapi-0'));
  assert.ok(css.includes('0% { opacity: 1; }') && css.includes('100% { opacity: 0; }'));
  assert.ok(css.includes('span.typewriter-caret { animation: heimdall-waapi-0 900ms steps(2, end) infinite both; }'));
  assert.ok(css.includes('prefers-reduced-motion: no-preference'));
});

test('buildWaapiCss: 骨架屏 / 转圈 / cookie 提示刻意不重演（内容早就加载完了）', () => {
  const specs = [
    { selector: '.skeleton-pulse', frames: [{ opacity: .4 }, { opacity: 1 }], duration: 1200, iterations: 'infinite' },
    { selector: '.spinner', frames: [{ rotate: '0deg' }, { rotate: '360deg' }], duration: 800, iterations: 'infinite' },
    { selector: '.CookiebotWidget', frames: [{ opacity: 0 }, { opacity: 1 }], duration: 300 },
    { selector: '.hero-ticker', frames: [{ translate: '0 0' }, { translate: '-100% 0' }], duration: 9000, iterations: 'infinite' },
  ];
  const css = buildWaapiCss(specs);
  for (const bad of ['.skeleton-pulse', '.spinner', '.CookiebotWidget']) assert.ok(!css.includes(bad), bad + ' 不该被重演');
  assert.ok(css.includes('.hero-ticker'), '真正的内容动效要留下');
});

test('buildWaapiCss: 没有稳定类名的目标不重演 —— 指错元素比不做更糟', () => {
  assert.equal(buildWaapiCss([{ selector: null, frames: [{ opacity: 0 }, { opacity: 1 }], duration: 300 }]), '');
  assert.equal(buildWaapiCss([{ selector: '.x', frames: [{ opacity: 0 }], duration: 300 }]), '', '不足两帧的不算动画');
  assert.equal(buildWaapiCss([]), '');
  assert.equal(buildWaapiCss(null), '');
});

test('buildWaapiCss: 同一份输入得到同一份输出 —— 就算记录的先后顺序不同', () => {
  const a = { selector: '.aaa', frames: [{ opacity: 0 }, { opacity: 1 }], duration: 300 };
  const b = { selector: '.bbb', frames: [{ translate: '0 10px' }, { translate: 'none' }], duration: 500 };
  assert.equal(buildWaapiCss([a, b]), buildWaapiCss([b, a]));
});

test('buildWaapiCss: 条数有上限（一页几百条会写出一份没人看得懂的样式表）', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ selector: '.e' + i, frames: [{ opacity: 0 }, { opacity: 1 }], duration: 300 }));
  const n = (buildWaapiCss(many, { max: 5 }).match(/@keyframes/g) || []).length;
  assert.equal(n, 5);
});

test('MOTION_INIT 自足 —— 它要经 addInitScript 送进页面，不能引用模块作用域', () => {
  const src = MOTION_INIT.toString();
  assert.ok(src.includes('Element.prototype.animate'), '前提：这确实是那个挂钩子');
  assert.doesNotThrow(() => new Function(`return (${src})`));
  const moduleSrc = readFileSync(new URL('../src/crawler/motion.mjs', import.meta.url), 'utf8');
  const topLevel = [...moduleSrc.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(m => m[1])
    .filter(n => n !== 'MOTION_INIT');
  const leaked = topLevel.filter(n => new RegExp(`\b${n}\b`).test(src));
  assert.deepEqual(leaked, [], 'MOTION_INIT 会被序列化后送进页面执行，不能引用模块作用域的：' + leaked.join(', '));
});

/**
 * MOTION_INIT 的捕获逻辑跑一个**假的 DOM**（不起浏览器）。
 * 这条针对的是一个真踩到的坑：关键帧有**两种形状** ——
 *   数组 `[{opacity:0},{opacity:1}]` 与 字典 `{opacity:[0,1]}`（实测 linear.app/agents 20 条全是后者）。
 * 上一版只认数组形式，于是整条 WAAPI 路径**一条都没记下来**，而报告上一切看起来正常。
 */
function captureWith(frames, options, el = { nodeType: 1, tagName: 'SPAN', className: 'j9EdOW_title' }) {
  const win = { Element: { prototype: { animate() { return {}; } } } };
  const doc = { addEventListener() {} };
  const body = `(${MOTION_INIT.toString()})(); return window.__heimdallMotion;`;
  // MOTION_INIT 里 `window.Element` 与裸 `Element` 两种写法都有（页面上都成立），
  // 所以这个假环境两个都得给 —— 少给一个会静默落进它的 try/catch，测试看起来'什么都没发生'
  const run = new Function('document', 'window', 'self', 'CSS', 'Element', body);
  const seen = run(doc, win, win, { escape: (s) => s }, win.Element);
  win.Element.prototype.animate.call(el, frames, options);
  return seen.waapi;
}

test('MOTION_INIT: 认得字典形式的关键帧 {opacity:[0,1]}', () => {
  const specs = captureWith({ opacity: [0, 1], filter: ['blur(10px)', 'blur(0px)'] }, { duration: 1000, iterations: 1 });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].selector, 'span.j9EdOW_title');
  assert.equal(specs[0].frames.length, 2);
  assert.equal(specs[0].frames[0].opacity, '0');
  assert.equal(specs[0].frames[1].filter, 'blur(0px)');
  assert.equal(specs[0].duration, 1000);
});

test('MOTION_INIT: 数组形式照旧认（{offset} 也带出来）', () => {
  const specs = captureWith([{ opacity: 0, offset: 0 }, { opacity: 1, offset: 1 }], 400);
  assert.equal(specs.length, 1);
  assert.deepEqual(specs[0].frames, [{ offset: 0, opacity: '0' }, { offset: 1, opacity: '1' }]);
  assert.equal(specs[0].duration, 400, 'options 是数字时当成 duration');
});

test('MOTION_INIT: transform 拆成独立属性 —— 不把 transform 原样抄下来', () => {
  const specs = captureWith({ transform: ['translateY(20%)', 'none'], opacity: [0, 1] }, { duration: 1000 });
  assert.equal(specs.length, 1);
  assert.equal(specs[0].frames[0].translate, '0 20%', 'translateY 要落到 translate 上');
  assert.equal(specs[0].frames[0].transform, undefined, '不允许出现 transform');
  assert.equal(specs[0].frames[1].translate, 'none');
  const scale = captureWith({ transform: ['scale(0.8)', 'scale(1)'] }, 300);
  assert.equal(scale[0].frames[0].scale, '0.8');
  const rot = captureWith({ transform: ['rotate(0deg)', 'rotate(90deg)'] }, 300);
  assert.equal(rot[0].frames[1].rotate, '90deg');
});

test('MOTION_INIT: 认不出的 transform（matrix / skew）宁可不记，也不做错', () => {
  assert.equal(captureWith({ transform: ['matrix(1,0,0,1,0,0)', 'matrix(2,0,0,2,0,0)'] }, 300).length, 0);
  assert.equal(captureWith({ transform: ['skewX(10deg)', 'skewX(0deg)'] }, 300).length, 0);
  assert.equal(captureWith({ transform: ['skewY(4deg)'] }, 300).length, 0, '没有两帧就不算动画');
  // 认得出多个函数时照样要收下来（translateY + scale 都在白名单里）
  const multi = captureWith({ transform: ['translateY(10px) scale(2)', 'translateY(0) scale(1)'] }, 300);
  assert.equal(multi.length, 1);
  assert.equal(multi[0].frames[0].translate, '0 10px');
  assert.equal(multi[0].frames[0].scale, '2');
});

test('MOTION_INIT: 没有稳定类名的目标不记（指错元素比不做更糟）', () => {
  assert.equal(captureWith({ opacity: [0, 1] }, 300, { nodeType: 1, tagName: 'DIV', className: '' }).length, 0);
});

test('buildWaapiCss: 缓动被截断时不许生成坏 CSS —— 括号必须配对', () => {
  // 实测踩到：脚本给的是 CSS linear() 多停靠点缓动，上一版按 40 字符截断切在函数中间，
  // 整条 animation 声明作废，而浏览器不报错，只是安静地不播。
  const truncated = 'linear(0, 0.0016, 0.0062, 0.0135, 0.0231 100m';
  const css = buildWaapiCss([{ selector: '.a', frames: [{ opacity: 0 }, { opacity: 1 }], duration: 900, easing: truncated }]);
  assert.ok(!css.includes('linear(0, 0.0016'), '截断的缓动不能被写进去');
  assert.ok(css.includes('900ms linear '), '应该退回一个安全的缓动');
  assert.equal((css.match(/\(/g) || []).length, (css.match(/\)/g) || []).length, '括号必须配对');
});

test('buildWaapiCss: 合法的缓动原样保留；奇怪的丢掉', () => {
  const ok = (e) => buildWaapiCss([{ selector: '.a', frames: [{ opacity: 0 }, { opacity: 1 }], duration: 300, easing: e }]);
  assert.ok(ok('cubic-bezier(0.25, 0.1, 0.25, 1)').includes('cubic-bezier(0.25, 0.1, 0.25, 1)'));
  assert.ok(ok('linear(0, 0.5, 1)').includes('linear(0, 0.5, 1)'));
  assert.ok(ok('steps(4, end)').includes('steps(4, end)'));
  assert.ok(ok('ease-in-out').includes('ease-in-out'));
  assert.ok(ok('url(javascript:alert(1))').includes('300ms linear '), '来路不明的值一律降级');
  assert.ok(ok('var(--x)').includes('300ms linear '));
});

test('生成的所有 CSS 都必须是括号配对的（整份，不只是缓动那一处）', () => {
  const css = buildReplayCss({ markers: MARKERS })
    + buildWaapiCss([{ selector: '.t', frames: [{ opacity: 0, translate: '0 20%' }, { opacity: 1, translate: 'none' }], duration: 1000, easing: 'cubic-bezier(.16,1,.3,1)', iterations: 'infinite' }]);
  assert.equal((css.match(/\{/g) || []).length, (css.match(/\}/g) || []).length, '花括号配对');
  assert.equal((css.match(/\(/g) || []).length, (css.match(/\)/g) || []).length, '圆括号配对');
  assert.ok(!/transform\s*:/i.test(css));
});
