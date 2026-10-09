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
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pickAdapter } from '../adapters/index.mjs';
import { WORKSPACE } from '../paths.mjs';

const TARGET = process.argv[2] ?? 'https://apify.com';
const OUT = process.argv[3] ?? join(WORKSPACE, 'apify.com', 'pages', 'home');
const VIEWPORT = { width: 1440, height: 900 };
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// 冻结策略：两侧截图同条件。CSS 动画全冻 + 轮播回初始位 + 输入框清空（打字机 JS 动画两边归零）
const FREEZE_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  .swiper-wrapper { transform: none !important; transition: none !important; }
`;

mkdirSync(OUT, { recursive: true });
mkdirSync(join(OUT, 'styles'), { recursive: true });
mkdirSync(join(OUT, 'assets'), { recursive: true });

const browser = await chromium.launch();
// 全网络录制：HAR 供活镜像 v2 做本地资源回放（原站重新部署后旧 chunk 仍可用）
let context;
try {
  context = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: UA,
    recordHar: { path: join(OUT, 'network.har'), content: 'embed' },
  });
} catch (e) {
  console.warn('  HAR recording unavailable:', String(e).slice(0, 100));
  context = await browser.newContext({ viewport: VIEWPORT, userAgent: UA });
}
const page = await context.newPage();

console.log('[1/7] goto', TARGET);
// domcontentloaded 而非 networkidle：持续轮询/长连接的页面 networkidle 永不达成，资源加载由后续扫掠兜底
await page.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 45_000 });

console.log('[2/7] cookie banner');
try {
  await page.getByRole('button', { name: /accept|agree|allow all|consent|dismiss/i }).first().click({ timeout: 5000 });
  await page.waitForTimeout(1000);
} catch { /* 无 banner，跳过 */ }

console.log('[3/7] lazy-load sweep');
await page.evaluate(async () => {
  const step = 800;
  for (let y = 0; y < document.body.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
});
await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(3000);

// DOM 探测栈 → 适配器
const domProbe = await page.content();
const adapter = pickAdapter(domProbe);
console.log('    adapter =', adapter.name);

console.log('[4/7] page cleanup (adapter:', adapter.name + ')');
await adapter.pageCleanup(page);
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
  const addRes = (u, kind) => {
    if (u == null) return;
    const s = String(u).trim();
    if (!s || s === 'null' || s === 'undefined' || s === 'about:blank') return;
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
  const refs = new Set();
  for (const s of sheets)
    for (const m of (s.css ?? '').matchAll(/url\((['"]?)([^'")]+)\1\)/g))
      if (!m[2].startsWith('data:')) refs.add(m[2]);
  return { sheets, refs: [...refs] };
});
const cssomCss = cssom.sheets.filter(s => s.css).map(s => s.css).join('\n');
writeFileSync(join(OUT, 'cssom.css'), cssomCss);
writeFileSync(join(OUT, 'cssom-refs.json'), JSON.stringify({
  origin: new URL(TARGET).origin, adapter: adapter.name, refs: cssom.refs, sheets: cssom.sheets,
}, null, 2));
console.log(`    sheets=${cssom.sheets.length} css=${(cssomCss.length / 1024).toFixed(0)}KB refs=${cssom.refs.length}`);

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

// 渲染后 DOM（清场后定格版 —— 与克隆页同状态）
const html = await page.content();
writeFileSync(join(OUT, 'dom.html'), html);
console.log(`    dom.html ${(html.length / 1024).toFixed(0)}KB`);

// 最终补采：截图/全页滚动后 DOM 可能新增懒加载图片、Vue 内联背景等（首采在 [5/7]）
console.log('    collect asset manifest (final pass)');
try {
  const extra = await page.evaluate(() => {
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
    const idx = new Map();
    const add = (u, kind) => {
      if (u == null) return;
      const s = String(u).trim();
      if (!s || s === 'null' || s === 'undefined' || s.startsWith('data:')) return;
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

await context.close().catch(() => {});
await browser.close();

// 下载资源矩阵（图片/图标/媒体/sprite/manifest；iframe/embed 保持在线引用）
console.log('    download resources');
let okRes = 0, failRes = 0;
const imgMap = {};
const resMap = {};
const failed = [];
const SKIP_KINDS = new Set(['iframe', 'embed']);
const extOfResource = (ct, url) => {
  const m = /\.(woff2?|ttf|otf|eot|png|jpe?g|webp|avif|svg|gif|ico|mp4|webm|mp3|wav|json|webmanifest)$/i.exec(new URL(url, 'https://x.local').pathname);
  if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('avif')) return 'avif';
  if (ct.includes('svg')) return 'svg';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg')) return 'jpg';
  if (ct.includes('gif')) return 'gif';
  if (ct.includes('icon')) return 'ico';
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('json') || ct.includes('manifest')) return 'json';
  return 'bin';
};
for (const r of manifest.resources ?? []) {
  const kind = r.kinds[0] ?? 'asset';
  if (SKIP_KINDS.has(kind)) continue;
  try {
    const res = await fetch(r.url, { headers: { 'User-Agent': UA, Referer: TARGET } });
    if (!res.ok) throw new Error(res.status);
    const safeKind = kind.replace(/[^a-z0-9-]/gi, '') || 'asset';
    const name = safeKind + String(okRes).padStart(3, '0') + '.' + extOfResource(res.headers.get('content-type') || '', r.url);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');   // 0 字节响应（追踪信标等）不落盘，交给 gaps.json
    writeFileSync(join(OUT, 'assets', name), buf);
    const rel = 'assets/' + name;
    resMap[r.url] = rel;
    if (r.kinds.some(k => k === 'image' || k === 'icon' || k.startsWith('preload'))) imgMap[r.url] = rel;
    okRes++;
  } catch (e) {
    failRes++; failed.push({ url: r.url, kinds: r.kinds, error: String(e).slice(0, 120) });
    console.warn('    FAIL', kind, r.url, String(e));
  }
}
const cssMap = {};
for (const u of manifest.css) {
  // link CSS 仅存档参考；克隆页唯一样式源是 cssom.css
  cssMap[u] = 'styles/' + (new URL(u).pathname.split('/').pop() || 'link.css');
}
writeFileSync(join(OUT, 'asset-map.json'), JSON.stringify({ cssMap, imgMap, resMap, resources: manifest.resources ?? [], css: manifest.css, imgs: manifest.imgs, favicon: manifest.favicon }, null, 2));
writeFileSync(join(OUT, 'gaps.json'), JSON.stringify({
  failed,
  notCaptured: (manifest.resources ?? []).filter(r => r.kinds.some(k => SKIP_KINDS.has(k))).map(r => ({ url: r.url, kinds: r.kinds })),
  notes: ['iframe/embed 保持在线引用（未本地化）', 'canvas/WebGL 与 WebSocket 不在静态捕获范围'],
}, null, 2));
console.log('DONE resources ok=' + okRes + ' fail=' + failRes + ' -> ' + OUT);
