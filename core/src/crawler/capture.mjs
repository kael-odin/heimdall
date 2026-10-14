/**
 * capture — 任意 URL 的渲染态捕获
 *
 * 输出（OUT 目录）:
 *   dom.html          渲染后 DOM（结构骨架来源）
 *   cssom.css         CSSOM 最终状态序列化（唯一样式源，含注入式样式）
 *   cssom-refs.json   CSSOM url() 引用清单 + origin + adapter 名
 *   manifest.json     DOM 内 CSS/图片/图标清单
 *   asset-map.json    原始URL -> 本地路径 映射（imgMap 序号命名）
 *   shot-src.png      原站首屏截图（冻结策略下）
 *
 * 用法: node src/crawler/capture.mjs <url> <outdir>
 */
import { chromium } from 'playwright';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pickAdapter } from '../adapters/index.mjs';
import { loadProfile, sanitizeHost } from '../site-profile.mjs';
import { extFrom, isSoftHtml } from '../asset-ext.mjs';
import { collectCssRefs } from '../css-refs.mjs';
import { MOTION_PROBE, MOTION_INIT, classifyMotion } from './motion.mjs';
import { sessionContext } from '../session/store.mjs';
import { requireArg } from '../args.mjs';
import { asUrl } from '../url-canon.mjs';
import { freezeCss, stripFreeze } from '../freeze.mjs';
import { UA } from '../ua.mjs';
import { countOpaquePng } from '../png-stat.mjs';
import { WORKSPACE, isInside } from '../paths.mjs';
import { assertSiteOrigin, siteIdForOrigin } from '../site-origin.mjs';

const RAW_TARGET = requireArg(process.argv[2], 'node src/crawler/capture.mjs <url> <outdir>', '目标 URL');
const TARGET = asUrl(RAW_TARGET);   // 直接跑这个脚本时也允许省略协议
if (!TARGET) { console.error(`不是有效的网址：${RAW_TARGET}`); process.exit(2); }
const OUT = requireArg(process.argv[3], 'node src/crawler/capture.mjs <url> <outdir>', '输出目录');
const outputPath = resolve(OUT);
const expectedOrigin = new URL(TARGET).origin;
let siteDir = null, pageName = null;
if (isInside(WORKSPACE, outputPath)) {
  const [site, section, name] = relative(WORKSPACE, outputPath).split(sep);
  if (section === 'pages') {
    const targetSiteId = siteIdForOrigin(WORKSPACE, TARGET);
    if (site.toLowerCase() !== targetSiteId) {
      throw new Error(`捕获目录 ${site} 与目标站点 ${targetSiteId} 不一致`);
    }
    siteDir = join(WORKSPACE, targetSiteId);
    pageName = name;
    assertSiteOrigin(siteDir, TARGET, { pageName });
  }
}
const VIEWPORT = { width: 1440, height: 900 };
// 站点配方：捕获策略（等待策略/静置时间/弹窗选择器）全部来自这里，不再写死在代码里
const profile = loadProfile(sanitizeHost(new URL(TARGET).hostname));
const CAP = profile.capture;

// 冻结策略：两侧截图同条件。CSS 动画全冻 + 轮播回初始位 + 输入框清空（打字机 JS 动画两边归零）
// ⚠ 它是**截图装置**，不是产物内容：dom.html 落盘时会把这份注入样式剥掉（见下面 stripFreeze），
//   否则它会跟着 dom.html 进到交互镜像里，把"能看动效"的产物冻成静止的（见 freeze.mjs 顶部注释）
const FREEZE_CSS = freezeCss({ swiper: true });

const browser = await chromium.launch();
// 登录态：需要登录的站点先在控制台/CLI 里人工登一次（session/login.mjs），
// 之后这里自动带上 —— 没有会话时 sessionContext() 返回空对象，不影响公开站点
const session = sessionContext(new URL(TARGET).hostname);
if (session.storageState) console.log('    session: 已带登录态（workspace/<host>/session.json）');
// 全网络录制：HAR 供交互镜像 v2 做本地资源回放（原站重新部署后旧 chunk 仍可用）
// 导航落地前不能触碰站点产物；HAR 先写独立临时目录，校验后再归档。
const harTempDir = mkdtempSync(join(tmpdir(), 'heimdall-capture-har-'));
const harTempPath = join(harTempDir, 'network.har');
process.once('exit', () => { try { rmSync(harTempDir, { recursive: true, force: true }); } catch {} });
let context;
try {
  context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: UA,
    recordHar: { path: harTempPath, content: 'embed' },
    ...session,
  });
} catch (e) {
  console.warn('  HAR recording unavailable:', String(e).slice(0, 100));
  context = await browser.newContext({ viewport: VIEWPORT, userAgent: UA, ...session });
}
const page = await context.newPage();
function assertLandedOrigin() {
  const landed = page.url();
  let actual;
  try { actual = new URL(landed).origin; } catch { actual = landed; }
  if (actual !== expectedOrigin) {
    const error = new Error(`捕获重定向跨 origin：请求 ${expectedOrigin}，落地 ${actual}；已拒绝写入 ${OUT}`);
    error.code = 'origin-conflict';
    throw error;
  }
  if (siteDir) assertSiteOrigin(siteDir, landed, { pageName });
  return landed;
}
// 动效累计观测器要在页面脚本之前装：它靠 animationstart/transitionrun 事件累计
// "这页上曾经跑过什么动画"，而不是靠运气在某一帧撞见（时间线见 crawler/motion.mjs）
await page.addInitScript(MOTION_INIT).catch(() => {});

console.log('[1/7] goto', TARGET);
// 默认 domcontentloaded 而非 networkidle：持续轮询/长连接的页面 networkidle 永不达成，
// 资源加载由后续扫掠兜底。站点可用配方 capture.waitUntil 覆盖。
try {
  await page.goto(TARGET, { waitUntil: CAP.waitUntil, timeout: CAP.timeoutMs });
  assertLandedOrigin();
} catch (error) {
  await browser.close().catch(() => {});
  throw error;
}

console.log('[2/7] cookie banner');
try {
  const consent = CAP.consentButton ? new RegExp(CAP.consentButton, 'i') : /accept|agree|allow all|consent|dismiss|接受|同意/i;
  await page.getByRole('button', { name: consent }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
} catch { /* 无 banner，跳过 */ }

console.log('[3/7] lazy-load sweep');
/**
 * 滚动扫描，**同时**把 <canvas> 光栅化。
 *
 * 为什么必须在滚动过程中抓，而不是扫完再抓：
 *  · 画布内容常由滚动触发（IntersectionObserver 之类）——不滚就永远空白；
 *  · 画布还可能是**动画**，内容会自己清空。实测 vitest.dev 首页两个画布：
 *    滚到位后立刻有 3.8 万个不透明像素，3 秒后其中一个归零。
 *
 * 这是静态镜像的一整类盲区：脚本被剥离后，画布上什么都没了。
 * 而像素分可能仍然很高（画布只占页面一小块），所以肉眼才看得见、报告看不见。
 * 抓到之后由 build_clone 换成 <img>，内容就成了普通的静态资源。
 */
// ① 先滚动（单独一次 evaluate），触发滚动相关的懒加载与画布绘制
if (CAP.scrollSweep) await page.evaluate(async ({ step, delay }) => {
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, delay));
  }
}, { step: CAP.scrollStep, delay: CAP.scrollDelayMs });

await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(CAP.settleMs);
try {
  const landed = assertLandedOrigin();
  if (siteDir) assertSiteOrigin(siteDir, landed, { claim: true, pageName });
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(OUT, 'styles'), { recursive: true });
  mkdirSync(join(OUT, 'assets'), { recursive: true });
} catch (error) {
  await browser.close().catch(() => {});
  throw error;
}

// 动效驱动采集。时机是刻意的：**在滚动扫掠之后**（滚动揭示类此时才创建，
// 见 framer-and-motion 那条"滚动后再点击"的纪律）、**在 FREEZE_CSS 注入之前**
// （[7/7] 才冻结，早采才看得到正在跑的动画）。
// 分类与判据见 crawler/motion.mjs；结果落 motion.json，控制台质检页直接引用。
console.log('[3.5/7] motion probe');
try {
  const motion = classifyMotion(await page.evaluate(MOTION_PROBE));
  writeFileSync(join(OUT, 'motion.json'), JSON.stringify(motion, null, 2));
  console.log(`    动效：${motion.summary}`);
} catch (e) { console.warn('    motion probe failed:', String(e).slice(0, 120)); }

/**
 * ② 再从 **Node 侧**循环采样画布。
 *
 * 为什么不能把"滚动 + 采样"塞进同一个 evaluate：
 * 实测过 —— 同一次 evaluate 内采样，两个画布全程都是 0 个不透明像素；
 * 而把它拆成"Node 侧循环、每轮一次 evaluate"，立刻拿到 3.8 万个。
 * 一次性跑完的长 evaluate 会占住渲染机会，画布根本没被真正绘制过。
 *
 * 画布还需要多轮采样：内容常是动画，单次采样容易正好撞在空帧上
 * （实测其中一个画布 3 秒后自行清空）。
 */
const canvasInfo = { total: 0, best: [], found: [] };
if (CAP.scrollSweep) {
  // 记**内容最全的那一帧**，不是第一帧有内容的。
  // 画布多是动画：实测 vitest.dev 的 Vite Powered 画布在不同帧里画 1~2 个六边形，
  // 抓第一帧就少一个图形 —— 肉眼一看就知道不对。
  const bestUrl = new Map();    // i -> dataUrl（该画布见过的最满帧）
  const bestPx = new Map();     // i -> 该帧的不透明像素数
  // 再滚一遍：画布动画多由 IntersectionObserver 触发，而上面那次滚动
  // 发生在页面水合之前（waitUntil 默认 domcontentloaded），可能什么都没触发到。
  await page.evaluate(async ({ step, delay }) => {
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, delay));
    }
  }, { step: CAP.scrollStep, delay: CAP.scrollDelayMs });
  let allCaptured = false;
  for (let round = 0; round < 20 && !allCaptured; round++) {
    const snap = await page.evaluate(() => {
      const out = [];
      [...document.querySelectorAll('canvas')].forEach((c, i) => {
        let opaque = 0, dim = 0, err = '';
        try {
          const t = document.createElement('canvas');
          t.width = c.width; t.height = c.height;
          dim = t.width * t.height;
          if (dim) {
            const g = t.getContext('2d');
            g.drawImage(c, 0, 0);
            const d = g.getImageData(0, 0, t.width, t.height).data;
            for (let k = 3; k < d.length; k += 4) if (d[k] > 8) opaque++;
          }
        } catch (e) { err = String(e).slice(0, 60); }
        out.push({ i, opaque, dim, err, dataUrl: opaque > 300 ? c.toDataURL('image/png') : '' });
      });
      return out;
    });
    canvasInfo.total = snap.length;
    for (const c of snap) {
      if (c.err) { canvasInfo.best[c.i] = -2; continue; }
      if ((canvasInfo.best[c.i] ?? -1) < c.opaque) canvasInfo.best[c.i] = c.opaque;
      if (c.dataUrl && c.opaque > (bestPx.get(c.i) ?? 0)) { bestPx.set(c.i, c.opaque); bestUrl.set(c.i, c.dataUrl); }
    }
    allCaptured = snap.length > 0 && bestUrl.size >= snap.length;   // 全抓到就停
    await page.waitForTimeout(220);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  canvasInfo.found = [...bestUrl.entries()].map(([i, dataUrl]) => ({ i, dataUrl }));
}

/**
 * 读不出像素的画布 → 退一步**截屏**。
 *
 * 为什么非做不可：`drawImage`/`toDataURL` 读的是**绘制缓冲区**，而 WebGL 上下文
 * 只要没开 `preserveDrawingBuffer`，合成之后缓冲区就是空的 —— 读回来全透明、
 * `opaque = 0`，被上面那道 `opaque > 300` 的闸门挡掉，**而且一声不响**。
 * 实测 moonshot.cn 首页：整条 hero 动画带（Unicorn Studio 的 WebGL2 场景，
 * 含那个横向滚动的 "Moonshot AI" 字标）就是这么没的 —— 首屏 7.8% 的像素，
 * 缺口清单里一个字都没写（它甚至不属于"资源失败"，资源一个都没少）。
 *
 * Playwright 的元素截图走**合成器**，看到的就是屏幕上真正画出来的东西，
 * 与绘制缓冲区无关。所以这条路能救回 WebGL 画布，也能救回被跨域污染的 2D 画布
 * （那种连 drawImage 都会抛 SecurityError）。
 *
 * 上一轮撤掉"媒体组件光栅化"的教训这里必须守住：**量不准框就别做**。
 * 所以先量两次框，动了就不做（轮播/滚动驱动的元素正是上一轮翻车的地方）；
 * 尺寸塌陷、不可见的也不做。最后还要用 countOpaquePng 自证截到的不是一张空图 ——
 * 拿空白冒充内容比缺了更糟。
 */
const SHOT_FALLBACK_MAX = 6;
if (CAP.scrollSweep) {
  const missed = [];
  for (let i = 0; i < canvasInfo.total; i++) if (!canvasInfo.found.some(f => f.i === i)) missed.push(i);
  if (missed.length) {
    mkdirSync(join(OUT, 'assets'), { recursive: true });
    let recovered = 0;
    for (const i of missed.slice(0, SHOT_FALLBACK_MAX)) {
      try {
        const boxOf = () => page.evaluate((idx) => {
          const c = document.querySelectorAll('canvas')[idx];
          if (!c) return null;
          const st = getComputedStyle(c);
          const r = c.getBoundingClientRect();
          return {
            w: Math.round(r.width), h: Math.round(r.height),
            x: Math.round(r.x), y: Math.round(r.y),
            hidden: st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0,
          };
        }, i);
        const a = await boxOf();
        if (!a || a.hidden || a.w < 8 || a.h < 8) continue;
        await page.waitForTimeout(120);
        const b = await boxOf();
        // 两次量到的框必须一模一样：会动的元素截出来是"某一瞬间的错位图"
        if (!b || a.w !== b.w || a.h !== b.h || a.x !== b.x || a.y !== b.y) continue;
        const buf = await page.locator('canvas').nth(i).screenshot({ timeout: 15_000 });
        const opaque = countOpaquePng(buf);
        if (opaque <= 300) continue;      // -1（读不懂）与 0（全透明）都**不要**：不拿空白冒充内容
        writeFileSync(join(OUT, 'assets', `canvas-${i}.png`), buf);
        canvasInfo.found.push({ i, dataUrl: '', shot: true });
        recovered++;
      } catch (e) {
        console.warn(`    canvas ${i} 截图兜底跳过:`, String(e).slice(0, 80));
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    if (recovered) console.log(`    canvas 截图兜底：补回 ${recovered}/${missed.length} 张（读不出绘制缓冲区的，多为 WebGL）`);
    if (missed.length > SHOT_FALLBACK_MAX) console.log(`    （还有 ${missed.length - SHOT_FALLBACK_MAX} 张未尝试，超出单页上限）`);
  }
}
const canvases = canvasInfo;
console.log(`    canvas diag: total=${canvases.total} bestOpaque=${JSON.stringify(canvases.best)}`);

// 把光栅化结果落盘，并在 DOM 上打标记 —— build_clone 据此把 <canvas> 换成 <img>
if (canvases.found.length) {
  mkdirSync(join(OUT, 'assets'), { recursive: true });
  let kept = 0, bytes = 0;
  for (const c of canvases.found) {
    if (c.shot) { kept++; try { bytes += statSync(join(OUT, 'assets', `canvas-${c.i}.png`)).size; } catch { /* 刚写的，读不到就只不计字节 */ } continue; }
    const b64 = String(c.dataUrl).split(',')[1] ?? '';
    if (!b64) continue;
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) continue;
    writeFileSync(join(OUT, 'assets', `canvas-${c.i}.png`), buf);
    kept++; bytes += buf.length;
  }
  await page.evaluate((idxs) => {
    const list = [...document.querySelectorAll('canvas')];
    for (const i of idxs) if (list[i]) list[i].setAttribute('data-heimdall-canvas', String(i));
  }, canvases.found.map(c => c.i));
  console.log(`    canvases rasterized: ${kept}/${canvases.found.length} (${(bytes / 1024).toFixed(0)}KB)`);
}

// 视频 poster：`<video preload="metadata">` 没有 poster 时浏览器**什么都不画**（纯黑），
// 而原站那一帧是脚本 play() 之后才有的 —— 镜像里没有脚本，于是整块黑。
// 实测 linear.app/customers-ramp：客户故事视频独占 386,303 像素的差异，像素分被压到 64.7%。
//
// 归零到第 0 帧再截：海报要是**可复现的那一帧**，不是随便撞上的某一帧。
// 顺带让原站主截图也停在第 0 帧 —— 两边同为第 0 帧，比"各截各的正在播的某一帧"更确定。
const posterIdx = [];
{
  const videoCount = await page.evaluate(() => document.querySelectorAll('video').length);
  for (let i = 0; i < Math.min(videoCount, 8); i++) {
    try {
      await page.evaluate((idx) => {
        const v = document.querySelectorAll('video')[idx];
        if (!v) return;
        try { v.pause(); v.currentTime = 0; } catch { /* 直播流 / 无 src 的视频会抛，跳过 */ }
      }, i);
      await page.waitForTimeout(300);
      const buf = await page.locator('video').nth(i).screenshot({ timeout: 15_000 });
      if (!buf?.length) continue;
      mkdirSync(join(OUT, 'assets'), { recursive: true });
      writeFileSync(join(OUT, 'assets', `video-${i}.png`), buf);
      posterIdx.push(i);
    } catch (e) {
      console.warn(`    video ${i} poster skipped:`, String(e).slice(0, 80));
    }
  }
  if (videoCount) {
    await page.evaluate((idxs) => {
      const list = document.querySelectorAll('video');
      for (const i of idxs) if (list[i]) list[i].setAttribute('data-heimdall-poster', String(i));
    }, posterIdx);
    await page.evaluate(() => window.scrollTo(0, 0));
    console.log(`    video posters: ${posterIdx.length}/${videoCount}`);
  }
}

// 注：还试过把 JS 渲染的媒体组件（`<mux-player>` 之类，靠脚本建 shadow DOM，
// 脚本一剥就什么都不画）也光栅化成静态图。代码写得出来，但**量不准框** ——
// Playwright 对带 shadow DOM 的自定义元素测出的包围盒不可靠，同一页三次跑出
// 46% / 73% / 58% 三个不同分数。宁可留着空白，也不要一个时好时坏的结果。
// 详见 docs/ROADMAP.md 的已知限制。

// DOM 探测栈 → 适配器（配方可用 adapter 字段强制指定）
const domProbe = await page.content();
const adapter = pickAdapter(domProbe, profile);
console.log('    adapter =', adapter.name, profile.adapter !== 'auto' ? '(配方强制)' : '(自动探测)');

console.log('[4/7] page cleanup (adapter:', adapter.name + ')');
const removeSelectors = [...(adapter.removeSelectors ?? []), ...(CAP.removeSelectors ?? [])];
if (removeSelectors.length) {
  await page.evaluate((sels) => {
    for (const s of sels) { try { document.querySelectorAll(s).forEach(e => e.remove()); } catch { /* 无效选择器 */ } }
  }, removeSelectors);
}
// 通用清场：输入框值清零（打字机/搜索预填两边归零，同帧公平）
await page.evaluate(() => {
  document.querySelectorAll('input, textarea').forEach(el => { el.value = ''; });
});

console.log('[5/7] collect asset manifest');
const manifest = await page.evaluate(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
  const css = [...document.querySelectorAll('link[rel="stylesheet"]')].map(l => abs(l.getAttribute('href'))).filter(Boolean);
  const imgs = new Set();
  document.querySelectorAll('img').forEach(i => {
    // currentSrc 只反映当前断点命中项；<picture> 的 fallback src / srcset / data-* 也要收
    if (i.currentSrc) imgs.add(abs(i.currentSrc));
    if (i.getAttribute('src')) imgs.add(abs(i.getAttribute('src')));
    for (const s of (i.getAttribute('srcset') || '').split(',')) { const u = s.trim().split(/\s+/)[0]; if (u) imgs.add(abs(u)); }
    for (const s of (i.getAttribute('data-srcset') || '').split(',')) { const u = s.trim().split(/\s+/)[0]; if (u) imgs.add(abs(u)); }
    if (i.getAttribute('data-src')) imgs.add(abs(i.getAttribute('data-src')));
  });
  document.querySelectorAll('source[srcset]').forEach(s =>
    s.getAttribute('srcset').split(',').forEach(t => { const u = t.trim().split(/\s+/)[0]; if (u) imgs.add(abs(u)); }));
  const favicon = [...document.querySelectorAll('link[rel*="icon"]')].map(l => abs(l.getAttribute('href'))).filter(Boolean);
  // ---- v2 资源矩阵：图片/图标/媒体/字体预载/sprite/manifest（按 URL 去重，保留 kinds）----
  const resIndex = new Map();
  // 页内锚点（#id / %23id，SVG filter/mask 常用）与伪协议不是外部资产，不能进清单
  const skipRef = (u) => { const s = String(u ?? '').trim(); return !s || s[0] === '#' || /^%23/i.test(s) || /^(data|about|blob|javascript|mailto|tel):/i.test(s); };
  const addRes = (u, kind) => {
    if (u == null) return;
    const s = String(u).trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'about:blank') return;
    if (skipRef(s)) return;
    const a = abs(s);
    if (!a || a.startsWith('data:')) return;
    const key = a.split('#')[0];
    if (!resIndex.has(key)) resIndex.set(key, { url: key, kinds: [] });
    const r = resIndex.get(key);
    if (!r.kinds.includes(kind)) r.kinds.push(kind);
  };
  document.querySelectorAll('img').forEach(i => {
    if (i.currentSrc) addRes(i.currentSrc, 'image');
    if (i.getAttribute('src')) addRes(i.getAttribute('src'), 'image');
    (i.getAttribute('srcset') || '').split(',').forEach(s => { const u = s.trim().split(/\s+/)[0]; if (u) addRes(u, 'image'); });
    (i.getAttribute('data-srcset') || '').split(',').forEach(s => { const u = s.trim().split(/\s+/)[0]; if (u) addRes(u, 'image'); });
    if (i.getAttribute('data-src')) addRes(i.getAttribute('data-src'), 'image');
  });
  document.querySelectorAll('source').forEach(s => {
    if (s.getAttribute('srcset')) s.getAttribute('srcset').split(',').forEach(t => { const u = t.trim().split(/\s+/)[0]; if (u) addRes(u, 'image'); });
    if (s.getAttribute('src')) addRes(s.getAttribute('src'), 'media');
  });
  document.querySelectorAll('video').forEach(v => { if (v.getAttribute('src')) addRes(v.getAttribute('src'), 'media'); if (v.getAttribute('poster')) addRes(v.getAttribute('poster'), 'image'); });
  // 任何元素上的 poster 都收，不只是 <video>：`<mux-player poster="…">` 这类自定义媒体组件
  // 的画面就是这张图，漏收它 = 静态镜像里整块空白（实测 vercel.com/customers，41 万像素的差异）
  document.querySelectorAll('[poster]').forEach(e => { const p = e.getAttribute('poster'); if (p) addRes(p, 'image'); });
  document.querySelectorAll('audio[src]').forEach(a2 => addRes(a2.getAttribute('src'), 'media'));
  document.querySelectorAll('link[rel*="icon"]').forEach(l => addRes(l.getAttribute('href'), 'icon'));
  document.querySelectorAll('link[rel="manifest"]').forEach(l => addRes(l.getAttribute('href'), 'manifest'));
  document.querySelectorAll('link[rel="preload"][as]').forEach(l => addRes(l.getAttribute('href'), 'preload-' + (l.getAttribute('as') || 'other')));
  document.querySelectorAll('svg use').forEach(u => { const h = u.getAttribute('href') || u.getAttribute('xlink:href'); if (h && !h.startsWith('#')) addRes(h, 'svg-sprite'); });
  document.querySelectorAll('[style*="url("]').forEach(el => { const m = /url\(([^)]+)\)/.exec(el.getAttribute('style') || ''); if (m) addRes(m[1].replace(/['"]/g, ''), 'image'); });
  document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach(m2 => addRes(m2.getAttribute('content'), 'image'));
  const resources = [...resIndex.values()];
  return { css, imgs: [...imgs], favicon, resources };
});
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ ...manifest, target: TARGET }, null, 2));
console.log(`    css=${manifest.css.length} imgs=${manifest.imgs.length} icons=${manifest.favicon.length}`);

// CSSOM 最终状态：styled-components/构造样式表/内联 style 全部逃不出 document.styleSheets
console.log('[6/7] capture CSSOM final state');
// 引用扫描放在 Node 侧：唯一实现、且能正确跳过 data URI 内嵌的 url(...)
const cssom = await page.evaluate(() => {
  const sheets = [];
  const collect = (list) => {
    for (const sheet of list) {
      let css = '';
      try { for (const rule of sheet.cssRules) css += rule.cssText + '\n'; }
      catch { sheets.push({ href: sheet.href, error: 'cross-origin cssRules denied' }); continue; }
      sheets.push({ href: sheet.href ?? null, css });
    }
  };
  collect(document.styleSheets);
  if (document.adoptedStyleSheets) collect(document.adoptedStyleSheets);
  return { sheets, base: document.baseURI };
});

/**
 * 跨域样式表补取 —— 一次差点让整站复刻静默失败的坑。
 *
 * 同源策略下 `sheet.cssRules` 对跨域样式表**直接抛异常**，于是这些表被跳过。
 * 而现代站点很爱把 CSS 放独立域名（`static.linear.app` 之类），放进去的恰恰是
 * reset / 设计变量 / 布局这些"地基"。实测 linear.app：**58 份样式表被丢掉**，
 * 克隆页渲染成一堆默认样式的竖排链接，而 DOM 分依然是 100%（DOM 确实没错）。
 * 只有像素分掉到 59% 才露馅 —— 而它当时被读成"这个站动画多"。
 *
 * 用 Playwright 的 request 上下文按 URL 取原文补回来：它不受 CORS 限制，且带同一份 cookie。
 * 注意口径：这些表是**原文**而非 CSSOM 序列化（`fetchedRaw: true` 标出来），
 * 但对跨域表我们本来就拿不到序列化结果，原文正是想要的那份。
 * 相对 `url()` 仍按该表自身的 URL 解析 —— collectCssRefs 用 `sheet.href` 做基准，这点天然成立。
 */
let recoveredSheets = 0;
const denied = cssom.sheets.filter(s => s.error && s.href);
for (const sheet of denied) {
  try {
    const res = await context.request.get(sheet.href, { timeout: 30_000 });
    if (!res.ok()) continue;
    const text = await res.text();
    if (!text) continue;
    delete sheet.error;
    sheet.css = text;
    sheet.fetchedRaw = true;
    recoveredSheets++;
  } catch { /* 网络层失败就保留错误标记，下游的缺口统计会把它算进去 */ }
}
if (denied.length) {
  console.log(`    跨域样式表补取 ${recoveredSheets}/${denied.length}（cors 下 cssRules 不可读，改按 URL 取原文）`);
}

const cssomCss = cssom.sheets.filter(s => s.css).map(s => s.css).join('\n');
const { refs: cssRefs, refMap } = collectCssRefs(cssom.sheets, cssom.base);
writeFileSync(join(OUT, 'cssom.css'), cssomCss);
writeFileSync(join(OUT, 'cssom-refs.json'), JSON.stringify({
  origin: new URL(TARGET).origin, adapter: adapter.name, refs: cssRefs, refMap, sheets: cssom.sheets,
}, null, 2));
console.log(`    sheets=${cssom.sheets.length} css=${(cssomCss.length / 1024).toFixed(0)}KB refs=${cssRefs.length}`);

console.log('[7/7] multi-frame source screenshots');
await page.addStyleTag({ content: FREEZE_CSS });
await page.evaluate(() => {
  document.querySelectorAll('input, textarea').forEach(el => { el.value = ''; });
});
await page.waitForTimeout(500);
// 三帧采样：JS 驱动的动效（打字机/轮播）不受 CSS 冻结，帧间差即"动态噪声"证据。
// differ 取与克隆最接近的帧评分，并把差异分为动态噪声 / 可修静态两类。
for (let i = 1; i <= 3; i++) {
  await page.screenshot({ path: join(OUT, `frame-${i}.png`) });
  await page.waitForTimeout(1200);
}
writeFileSync(join(OUT, 'shot-src.png'), readFileSync(join(OUT, 'frame-3.png')));
await page.screenshot({ path: join(OUT, 'shot-src.jpg'), type: 'jpeg', quality: 55 });   // 小图供 LLM 视觉调用
// 全页长图：同步滚动对比页的“原站侧”原料（超长页可能失败，失败不阻塞）
try { await page.screenshot({ path: join(OUT, 'shot-src-full.png'), fullPage: true, timeout: 90_000 }); }
catch (e) { console.warn('  fullpage shot skipped:', String(e).slice(0, 80)); }

// 渲染后 DOM（清场后定格版 —— 与克隆页同状态）。
// 这里剥掉上面注入的冻结样式：它只是为了让截图可复现，写进 dom.html 就会被
// build_live 原样带进交互镜像，把镜像里的动画与过渡全部冻死。
const html = stripFreeze(await page.content());
writeFileSync(join(OUT, 'dom.html'), html);
console.log(`    dom.html ${(html.length / 1024).toFixed(0)}KB`);

// 最终补采：截图/全页滚动后 DOM 可能新增懒加载图片、Vue 内联背景等（首采在 [5/7]）
console.log('    collect asset manifest (final pass)');
try {
  const extra = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
    const idx = new Map();
    const skipRef = (u) => { const s = String(u ?? '').trim(); return !s || s[0] === '#' || /^%23/i.test(s) || /^(data|about|blob|javascript|mailto|tel):/i.test(s); };
    const add = (u, kind) => {
      if (u == null) return;
      const s = String(u).trim();
      if (!s || s === 'null' || s === 'undefined' || s.startsWith('data:')) return;
      if (skipRef(s)) return;
      const a = abs(s); if (!a) return;
      const key = a.split('#')[0];
      if (!idx.has(key)) idx.set(key, { url: key, kinds: [] });
      const r = idx.get(key);
      if (!r.kinds.includes(kind)) r.kinds.push(kind);
    };
    const srcsets = (v) => String(v || '').split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
    document.querySelectorAll('img').forEach(i => {
      add(i.currentSrc, 'image');
      add(i.getAttribute('src'), 'image');
      for (const u of srcsets(i.getAttribute('srcset'))) add(u, 'image');
      for (const u of srcsets(i.getAttribute('data-srcset'))) add(u, 'image');
      add(i.getAttribute('data-src'), 'image');
    });
    document.querySelectorAll('source').forEach(s => {
      for (const u of srcsets(s.getAttribute('srcset'))) add(u, 'image');
      for (const u of srcsets(s.getAttribute('data-srcset'))) add(u, 'image');
      add(s.getAttribute('src'), 'media');
    });
    document.querySelectorAll('[data-src],[data-srcset],[data-bg],[data-background]').forEach(el => {
      add(el.getAttribute('data-src'), 'image');
      for (const u of srcsets(el.getAttribute('data-srcset'))) add(u, 'image');
      add(el.getAttribute('data-bg'), 'image');
      add(el.getAttribute('data-background'), 'image');
    });
    document.querySelectorAll('video').forEach(v => { add(v.getAttribute('src'), 'media'); add(v.getAttribute('poster'), 'image'); });
    document.querySelectorAll('audio[src]').forEach(a => add(a.getAttribute('src'), 'media'));
    document.querySelectorAll('link[rel*="icon"]').forEach(l => add(l.getAttribute('href'), 'icon'));
    document.querySelectorAll('link[rel="manifest"]').forEach(l => add(l.getAttribute('href'), 'manifest'));
    document.querySelectorAll('link[rel="preload"][as]').forEach(l => add(l.getAttribute('href'), 'preload-' + (l.getAttribute('as') || 'other')));
    document.querySelectorAll('svg use').forEach(u => { const h = u.getAttribute('href') || u.getAttribute('xlink:href'); if (h && !h.startsWith('#')) add(h, 'svg-sprite'); });
    document.querySelectorAll('[style*="url("]').forEach(el => {
      for (const m of String(el.getAttribute('style') || '').matchAll(/url\(\s*(?:'|")?([^'")]+)(?:'|")?\s*\)/g)) add(m[1], 'image');
    });
    document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]').forEach(m => add(m.getAttribute('content'), 'image'));
    return { resources: [...idx.values()] };
  });
  if (extra?.resources?.length) {
    const merged = new Map((manifest.resources ?? []).map(r => [r.url, { url: r.url, kinds: [...(r.kinds ?? [])] }]));
    for (const r of extra.resources) {
      if (!merged.has(r.url)) merged.set(r.url, { url: r.url, kinds: [] });
      const t = merged.get(r.url);
      for (const k of r.kinds) if (!t.kinds.includes(k)) t.kinds.push(k);
    }
    manifest.resources = [...merged.values()];
    manifest.imgs = [...new Set([...manifest.imgs, ...manifest.resources.filter(r => r.kinds.some(k => k === 'image' || k === 'icon' || k.startsWith('preload'))).map(r => r.url)])];
    writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ ...manifest, target: TARGET }, null, 2));
    console.log('    final pass: +' + extra.resources.length + ' refs, total resources ' + manifest.resources.length);
  }
} catch (e) { console.warn('    final manifest pass skipped:', String(e).slice(0, 100)); }

try {
  await context.close().catch(() => {});
  if (existsSync(harTempPath)) copyFileSync(harTempPath, join(OUT, 'network.har'));
} finally {
  await browser.close();
  rmSync(harTempDir, { recursive: true, force: true });
}

// 下载资源矩阵（图片/图标/媒体/sprite/manifest；iframe/embed 保持在线引用）
// 逐条打印进度：一是让人看得见为什么这一步要几分钟（首页常有 5-10MB 的大图），
// 二是给引擎的单页熔断当心跳 —— 只在**开下之前**报一次，所以"沉默"就等于这一次
// 下载卡住了。单条给超时兜底：一个下不动的资源不该拖住整页。
const SKIP_KINDS = new Set(['iframe', 'embed']);
const RES_TIMEOUT = Number(process.env.HEIMDALL_ASSET_TIMEOUT_MS ?? 120_000);
const toDownload = (manifest.resources ?? []).filter(r => !SKIP_KINDS.has(r.kinds[0] ?? 'asset'));
console.log(`    download resources (${toDownload.length}, 单条超时 ${RES_TIMEOUT / 1000}s)`);
let okRes = 0, failRes = 0;
const imgMap = {};
const resMap = {};
const failed = [];
for (const [i, r] of toDownload.entries()) {
  const kind = r.kinds[0] ?? 'asset';
  const t0 = Date.now();
  process.stdout.write(`    [${i + 1}/${toDownload.length}] ${kind} `);
  try {
    const res = await fetch(r.url, { headers: { 'User-Agent': UA, Referer: TARGET }, signal: AbortSignal.timeout(RES_TIMEOUT) });
    if (!res.ok) throw new Error(res.status);
    const ct = res.headers.get('content-type') || '';
    // 软 404 / SPA 兜底：请求图片却返回 HTML —— 落盘会变成"看起来有、其实全错"的假资产
    if (isSoftHtml(ct, r.url)) throw new Error('soft-404 (text/html for asset)');
    const safeKind = kind.replace(/[^a-z0-9-]/gi, '') || 'asset';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');   // 0 字节响应（追踪信标等）不落盘，交给 gaps.json
    const name = safeKind + String(okRes).padStart(3, '0') + '.' + extFrom(r.url, ct, buf);
    writeFileSync(join(OUT, 'assets', name), buf);
    const rel = 'assets/' + name;
    resMap[r.url] = rel;
    if (r.kinds.some(k => k === 'image' || k === 'icon' || k.startsWith('preload'))) imgMap[r.url] = rel;
    okRes++;
    console.log(`${(buf.length / 1048576).toFixed(1)}MB ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    failRes++; failed.push({ url: r.url, kinds: r.kinds, error: String(e).slice(0, 120) });
    console.log(`失败 ${String(e).slice(0, 70)}`);
  }
}
const cssMap = {};
for (const u of manifest.css) {
  // link CSS 仅存档参考；克隆页唯一样式源是 cssom.css
  cssMap[u] = 'styles/' + (new URL(u).pathname.split('/').pop() || 'link.css');
}
writeFileSync(join(OUT, 'asset-map.json'), JSON.stringify({ cssMap, imgMap, resMap, resources: manifest.resources ?? [], css: manifest.css, imgs: manifest.imgs, favicon: manifest.favicon }, null, 2));
// 补取之后仍然读不到的跨域样式表。
// 这一项必须写进缺口清单：它以前只躺在 cssom-refs.json 的 sheets[].error 里，没有任何人看，
// 而丢掉的可能是整站的地基（reset / 设计变量 / 布局）—— 克隆页会静默退化成默认样式。
const unreadableSheets = cssom.sheets.filter(s => s.error).map(s => s.href ?? '(inline)');
if (unreadableSheets.length) {
  console.warn(`    ⚠ 仍有 ${unreadableSheets.length} 份样式表读不到（跨域且补取失败）—— 这几页的样式可能不完整`);
  for (const u of unreadableSheets.slice(0, 5)) console.warn(`      ${u}`);
}
writeFileSync(join(OUT, 'gaps.json'), JSON.stringify({
  failed,
  notCaptured: (manifest.resources ?? []).filter(r => r.kinds.some(k => SKIP_KINDS.has(k))).map(r => ({ url: r.url, kinds: r.kinds })),
  cssSheetsUnreadable: unreadableSheets,
  notes: ['iframe/embed 保持在线引用（未本地化）', 'canvas/WebGL 与 WebSocket 不在静态捕获范围'],
}, null, 2));

// 本次实跑观察到的参数（供 linker 汇总进 workspace/<host>/site.json 形成"学到的配方"）
writeFileSync(join(OUT, 'profile-observed.json'), JSON.stringify({
  host: sanitizeHost(new URL(TARGET).hostname),
  adapter: adapter.name,
  adapterForced: profile.adapter !== 'auto',
  waitUntil: CAP.waitUntil,
  settleMs: CAP.settleMs,
  scrollSweep: CAP.scrollSweep,
  removeSelectors,
  resources: { total: (manifest.resources ?? []).length, ok: okRes, fail: failRes },
  cssRefs: { total: cssRefs.length },
  observedAt: new Date().toISOString(),
}, null, 2));
console.log('DONE resources ok=' + okRes + ' fail=' + failRes + ' -> ' + OUT);
