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

const TARGET = process.argv[2] ?? 'https://apify.com';
const OUT = process.argv[3] ?? join('workspace', 'apify.com', 'pages', 'home');
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
const page = await browser.newPage({ viewport: VIEWPORT, userAgent: UA });

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
    if (i.src) imgs.add(abs(i.currentSrc || i.src));
    i.srcset?.split(',').forEach(s => { const u = s.trim().split(/\s+/)[0]; if (u) imgs.add(abs(u)); });
  });
  document.querySelectorAll('source[srcset]').forEach(s =>
    s.getAttribute('srcset').split(',').forEach(t => { const u = t.trim().split(/\s+/)[0]; if (u) imgs.add(abs(u)); }));
  const favicon = [...document.querySelectorAll('link[rel*="icon"]')].map(l => abs(l.getAttribute('href'))).filter(Boolean);
  return { css, imgs: [...imgs], favicon };
});
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
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

// 渲染后 DOM（清场后定格版 —— 与克隆页同状态）
const html = await page.content();
writeFileSync(join(OUT, 'dom.html'), html);
console.log(`    dom.html ${(html.length / 1024).toFixed(0)}KB`);

await browser.close();

// 下载 DOM 引用的图片资产（序号命名，防 /_next/image 同名覆盖）
console.log('    download assets');
let okImg = 0, failImg = 0;
const imgMap = {};
const extOf = (ct) =>
  ct.includes('webp') ? 'webp' : ct.includes('avif') ? 'avif' : ct.includes('svg') ? 'svg'
  : ct.includes('png') ? 'png' : ct.includes('jpeg') ? 'jpg' : ct.includes('gif') ? 'gif'
  : ct.includes('icon') ? 'ico' : 'bin';
for (const u of manifest.imgs) {
  try {
    const res = await fetch(u, { headers: { 'User-Agent': UA, Referer: TARGET } });
    if (!res.ok) throw new Error(res.status);
    const name = `img${String(okImg).padStart(3, '0')}.${extOf(res.headers.get('content-type') || '')}`;
    writeFileSync(join(OUT, 'assets', name), Buffer.from(await res.arrayBuffer()));
    imgMap[u] = `assets/${name}`;
    okImg++;
  } catch (e) { failImg++; console.warn('    FAIL', u, String(e)); }
}
const cssMap = {};
for (const u of manifest.css) {
  // link CSS 仅存档参考；克隆页唯一样式源是 cssom.css
  cssMap[u] = 'styles/' + (new URL(u).pathname.split('/').pop() || 'link.css');
}
writeFileSync(join(OUT, 'asset-map.json'), JSON.stringify({ cssMap, imgMap, css: manifest.css, imgs: manifest.imgs, favicon: manifest.favicon }, null, 2));
console.log(`\nDONE imgs ${okImg}/${manifest.imgs.length} (fail ${failImg}) -> ${OUT}`);
