/**
 * fullshot — 为已有克隆页批量补拍原站全页快照（不重跑整条流水线）
 *
 * compare.html 的原站侧需要 shot-src-full.png；旧版产物缺失时此工具补拍。
 * 并发 2，每页 ~20s。
 *
 * 用法: node src/crawler/fullshot.mjs <host>        （补全部缺图页）
 *       node src/crawler/fullshot.mjs <host> <name> （补指定页）
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const host = process.argv[2] ?? 'thordata.com';
const only = process.argv[3];
const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const targets = [];
for (const name of existsSync(PAGES) ? readdirSync(PAGES) : []) {
  if (only && name !== only) continue;
  const mPath = join(PAGES, name, 'manifest.json');
  const shotPath = join(PAGES, name, 'shot-src-full.png');
  if (!existsSync(mPath) || existsSync(shotPath)) continue;
  targets.push({ name, url: JSON.parse(readFileSync(mPath, 'utf8')).target });
}
if (!targets.length) { console.log('nothing to shoot'); process.exit(0); }
console.log(`fullshot ${host}: ${targets.length} pages`);

const browser = await chromium.launch();
let done = 0, failed = 0;
async function shoot({ name, url }) {
  const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, userAgent: UA });
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // cookie banner（有则关）
    try { await p.getByRole('button', { name: /accept|dismiss|agree|consent/i }).first().click({ timeout: 4000 }); } catch {}
    await p.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100)); }
      window.scrollTo(0, 0);
    });
    await p.waitForTimeout(1500);
    await p.screenshot({ path: join(PAGES, name, 'shot-src-full.png'), fullPage: true, timeout: 90_000 });
    done++;
    console.log(`  ✓ ${name}`);
  } catch (e) { failed++; console.log(`  ✗ ${name}:`, String(e).slice(0, 80)); }
  finally { await p.close(); }
}
const queue = [...targets];
await Promise.all([1, 2].map(async () => { while (queue.length) { const t = queue.shift(); if (t) await shoot(t); } }));
await browser.close();
console.log(`fullshot DONE: ${done} ok, ${failed} failed`);
