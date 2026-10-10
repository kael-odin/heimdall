/**
 * 探针：服务端 HTML vs 渲染后 —— 顺带评估站点是否适合克隆
 * 用法: node probe-render-mode.mjs <url> [url...]
 */
import { chromium } from 'playwright';
import { analyzeRawHtml } from '../src/seo/raw-html.mjs';

const urls = process.argv.slice(2);
if (!urls.length) { console.error('usage: node probe-render-mode.mjs <url> [url...]'); process.exit(2); }

const browser = await chromium.launch();
const rows = [];

for (const url of urls) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const row = { url };
  try {
    const started = Date.now();
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    row.status = res?.status() ?? 0;
    await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const rendered = await page.evaluate(() => {
      const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      return {
        title: (document.title || '').trim(),
        wordCount: (text.match(/[一-鿿]/g) || []).length + (text.match(/[A-Za-z0-9]+/g) || []).length,
        imgs: document.querySelectorAll('img').length,
        canvases: document.querySelectorAll('canvas').length,
        scripts: document.querySelectorAll('script').length,
      };
    });

    const rawHtml = await page.evaluate(async (u) => {
      try { return await (await fetch(u, { credentials: 'same-origin', cache: 'no-store' })).text(); } catch { return ''; }
    }, page.url());
    const raw = analyzeRawHtml(rawHtml);

    row.ms = Date.now() - started;
    row.renderedWords = rendered.wordCount;
    row.rawWords = raw.wordCount;
    row.ratio = rendered.wordCount ? Math.round((raw.wordCount / rendered.wordCount) * 100) : -1;
    row.titleInRaw = !!raw.title;
    row.imgs = rendered.imgs;
    row.canvases = rendered.canvases;
    row.scripts = rendered.scripts;
    row.rawKB = Math.round(raw.bytes / 1024);
    row.verdict = row.ratio >= 0 && row.ratio < 30 ? 'JS 依赖' : (row.titleInRaw ? '服务端直出' : '标题也靠 JS');
  } catch (e) {
    row.error = String(e).slice(0, 90);
  }
  rows.push(row);
  await ctx.close();
}

const pad = (s, n) => String(s ?? '').padEnd(n);
console.log(pad('站点', 34) + pad('码', 5) + pad('渲染词', 8) + pad('服务端词', 9) + pad('留存%', 7) + pad('HTML', 7) + pad('img', 5) + pad('canvas', 7) + pad('脚本', 5) + '判定');
for (const r of rows) {
  if (r.error) { console.log(pad(r.url, 34) + '  ' + r.error); continue; }
  console.log(
    pad(r.url.replace(/^https?:\/\//, '').slice(0, 32), 34)
    + pad(r.status, 5) + pad(r.renderedWords, 8) + pad(r.rawWords, 9) + pad(r.ratio >= 0 ? r.ratio + '%' : '-', 7)
    + pad(r.rawKB + 'KB', 7) + pad(r.imgs, 5) + pad(r.canvases, 7) + pad(r.scripts, 5) + r.verdict,
  );
}
await browser.close();
