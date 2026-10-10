#!/usr/bin/env node
/**
 * crawler/multi-snapshot — 为页面补充 375/768 视口快照（DOM + CSSOM），并可选重建克隆
 *
 * 用法:
 *   node src/crawler/multi-snapshot.mjs <host> <page> [--widths 375,768]
 *   node src/crawler/multi-snapshot.mjs <host> --all [--max N] [--pages a,b,c]   # 批量：快照+build_clone+linker
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { collectCssRefs } from '../css-refs.mjs';
import { WORKSPACE } from '../paths.mjs';

const argv = process.argv.slice(2);
const host = argv[0];
const pageArg = argv[1] && !argv[1].startsWith('--') ? argv[1] : null;
const ALL = argv.includes('--all');
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx > -1 ? Number(argv[maxIdx + 1]) : 999;
const pagesIdx = argv.indexOf('--pages');
const PAGES = pagesIdx > -1 ? String(argv[pagesIdx + 1] || '').split(',').filter(Boolean) : [];
const widthsIdx = argv.indexOf('--widths');
const WIDTHS = (widthsIdx > -1 ? argv[widthsIdx + 1] : '375,768').split(',').map(Number).filter(Boolean);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FREEZE = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],[class*="gdpr" i],[id*="gdpr" i]{display:none!important}';

export async function snapPage(browser, host, page, widths = WIDTHS) {
  const dir = join(WORKSPACE, host, 'pages', page);
  const mf = join(dir, 'manifest.json');
  if (!existsSync(mf)) throw new Error('no manifest: ' + page);
  const target = JSON.parse(readFileSync(mf, 'utf8')).target;
  const out = [];
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, userAgent: UA });
    const p = await ctx.newPage();
    await p.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForLoadState('load', { timeout: 25000 }).catch(() => {});
    await p.evaluate(() => document.fonts?.ready).catch(() => {});
    await p.addStyleTag({ content: FREEZE }).catch(() => {});
    await p.waitForTimeout(1500);
    const snap = await p.evaluate(() => {
      const sheets = [];
      const collect = (list) => {
        for (const sheet of list) {
          let css = '';
          try { for (const rule of sheet.cssRules) css += rule.cssText + '\n'; } catch {}
          if (css) sheets.push({ href: sheet.href ?? null, css });
        }
      };
      collect(document.styleSheets);
      if (document.adoptedStyleSheets) collect(document.adoptedStyleSheets);
      return { html: '<!doctype html>\n' + document.documentElement.outerHTML, sheets, base: document.baseURI };
    });
    // 引用扫描在 Node 侧（css-refs）——与 capture.mjs 同一实现，且正确跳过 data URI 内嵌的 url()
    const { refs, refMap } = collectCssRefs(snap.sheets, snap.base);
    writeFileSync(join(dir, 'dom-' + width + '.html'), snap.html);
    writeFileSync(join(dir, 'cssom-' + width + '.css'), snap.sheets.map(s => s.css).join('\n'));
    writeFileSync(join(dir, 'cssom-refs-' + width + '.json'), JSON.stringify({ origin: new URL(target).origin, width, refs, refMap }, null, 2));
    const out2 = { width, html: snap.html.length, css: snap.sheets.reduce((n, s) => n + s.css.length, 0), refs: refs.length };
    out.push(out2);
    await ctx.close();
  }
  return out;
}

const isMain = process.argv[1] && process.argv[1].endsWith('multi-snapshot.mjs');
if (isMain) {
  if (!host || (!pageArg && !ALL)) { console.error('usage: node src/crawler/multi-snapshot.mjs <host> <page> | <host> --all [--max N] [--pages a,b]'); process.exit(2); }
  const browser = await chromium.launch();
  try {
    let pages = [];
    if (ALL) {
      const pagesDir = join(WORKSPACE, host, 'pages');
      pages = readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'manifest.json')));
      if (PAGES.length) pages = pages.filter(p => PAGES.includes(p));
      pages = pages.slice(0, MAX);
    } else {
      pages = [pageArg];
    }
    const done = [];
    for (const page of pages) {
      try {
        const r = await snapPage(browser, host, page, WIDTHS);
        done.push(page);
        console.log('[multi-snapshot] ' + page + ' ' + r.map(x => x.width + ':' + (x.html / 1024).toFixed(0) + 'KB').join(' '));
        process.stdout.write('@@EVENT@@' + JSON.stringify({ kind: 'snapshot-page', page, widths: r.map(x => x.width) }) + '\n');
      } catch (e) {
        console.error('[multi-snapshot] FAIL ' + page + ': ' + String(e).slice(0, 120));
        process.stdout.write('@@EVENT@@' + JSON.stringify({ kind: 'snapshot-error', page, error: String(e).slice(0, 120) }) + '\n');
      }
    }
    if (ALL && done.length) {
      for (const page of done) spawnSync(process.execPath, [join('src', 'crawler', 'build_clone.mjs'), join(WORKSPACE, host, 'pages', page)], { cwd: new URL('../../', import.meta.url).pathname.replace(/^\//, ''), stdio: 'ignore' });
      spawnSync(process.execPath, [join('src', 'crawler', 'linker.mjs'), host], { cwd: new URL('../../', import.meta.url).pathname.replace(/^\//, ''), stdio: 'inherit' });
    }
    console.log('[multi-snapshot] done pages=' + done.length + '/' + pages.length);
  } finally { await browser.close(); }
}
