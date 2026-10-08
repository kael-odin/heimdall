#!/usr/bin/env node
/**
 * crawler/repair-empty-assets — 修复 0 字节资产引用（静默裂图）
 *
 * 背景：抓取阶段个别追踪信标（如 bat.bing.com/action/0）以 <img> 形式请求，
 * 被当作资产落盘但内容为空；clone 引用空文件 → 浏览器裂图。
 *
 * 规则：
 *   - 追踪域名 → 替换为 1×1 透明 GIF data URI（离线不产生请求、无视觉影响）
 *   - 其它 → 回退原始 URL（离线不可用但诚实，资产扫描会标记）
 *   - 删除 0 字节文件；HTML/CSS 内引用同步改写；幂等
 *
 * 用法: node src/crawler/repair-empty-assets.mjs <host> [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const argv = process.argv.slice(2);
const host = argv.find(a => !a.startsWith('--'));
const DRY = argv.includes('--dry-run');
if (!host) { console.error('usage: node src/crawler/repair-empty-assets.mjs <host> [--dry-run]'); process.exit(2); }
const PAGES = join(WORKSPACE, host, 'pages');
if (!existsSync(PAGES)) { console.error('no pages for host:', host); process.exit(1); }

const TRACKING = /(bat\.bing\.com|t\.co|analytics\.twitter|facebook\.|doubleclick\.net|googletagmanager\.com|google-analytics\.com|clarity\.ms|hotjar\.|segment\.(io|com)|mixpanel\.com|hs-scripts\.com|hs-banner\.com|hsadspixel|linkedin\.com\/px|cookiepro|cookiebot)/i;
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const zeroFiles = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.size === 0) out.push(p);
    }
  };
  walk(dir);
  return out;
};

let pages = 0, files = 0, rewrites = 0;
for (const name of readdirSync(PAGES).sort()) {
  const cloneDir = join(PAGES, name, 'clone');
  if (!existsSync(cloneDir)) continue;
  const zeros = zeroFiles(cloneDir);
  if (!zeros.length) continue;
  pages++;
  const pageDir = join(PAGES, name);
  let map = {};
  try { map = JSON.parse(readFileSync(join(pageDir, 'asset-map.json'), 'utf8')); } catch {}
  const localToUrl = new Map();
  for (const k of Object.keys(map.resMap ?? {})) localToUrl.set(String(map.resMap[k]), k);
  for (const k of Object.keys(map.imgMap ?? {})) localToUrl.set(String(map.imgMap[k]), k);

  for (const f of zeros) {
    const rel = relative(cloneDir, f).split('\\').join('/');
    const srcUrl = localToUrl.get(rel) ?? localToUrl.get(rel.replace(/^assets\//, 'assets/'));
    const replacement = srcUrl && TRACKING.test(srcUrl) ? PIXEL : (srcUrl || null);
    const refFiles = [];
    const walkRefs = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walkRefs(p);
        else if (/\.(html?|css)$/i.test(n)) refFiles.push(p);
      }
    };
    walkRefs(cloneDir);
    let hits = 0;
    const base = rel.split('/').pop();
    for (const rf of refFiles) {
      let text; try { text = readFileSync(rf, 'utf8'); } catch { continue; }
      const needle = text.includes(rel) ? rel : (text.includes(base) ? base : null);
      if (!needle) continue;
      const to = replacement ?? PIXEL;   // 未知来源用透明像素兜底，避免留下空引用
      const n = text.split(needle).join(to);
      if (n !== text) { if (!DRY) writeFileSync(rf, n); hits += 1; }
    }
    rewrites += hits;
    // 只在确实改写了引用时才删文件；未被引用的空文件保留（可能被 live 页/其它文件引用，如 agents.md 的空 cssom.css）
    if (hits > 0) {
      files++;
      if (!DRY) { try { unlinkSync(f); } catch {} }
    }
    console.log('  ', name, rel, hits ? ('refs:' + hits) : 'kept (no refs)', replacement && replacement.startsWith('data:') ? '-> transparent-pixel' : '');
  }
}
console.log(`[repair-empty-assets] host=${host} pages=${pages} files=${files} rewrites=${rewrites}${DRY ? ' (dry-run)' : ''}`);
