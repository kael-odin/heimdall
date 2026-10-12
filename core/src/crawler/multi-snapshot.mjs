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
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { collectCssRefs } from '../css-refs.mjs';
import { WORKSPACE } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { sessionContext } from '../session/store.mjs';
import { freezeCss } from '../freeze.mjs';
import { UA } from '../ua.mjs';
import { runScript } from '../child-run.mjs';
import { resolveCloneUrl } from '../clone-doc.mjs';

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

const FREEZE = freezeCss({ consent: true });

export async function snapPage(browser, host, page, widths = WIDTHS) {
  const dir = join(WORKSPACE, host, 'pages', page);
  const mf = join(dir, 'manifest.json');
  if (!existsSync(mf)) throw new Error('no manifest: ' + page);
  const target = JSON.parse(readFileSync(mf, 'utf8')).target;
  const out = [];
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, userAgent: UA, ...sessionContext(host) });
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
        emit({ kind: 'snapshot-page', page, widths: r.map(x => x.width) });
      } catch (e) {
        console.error('[multi-snapshot] FAIL ' + page + ': ' + String(e).slice(0, 120));
        emit({ kind: 'snapshot-error', page, error: String(e).slice(0, 120) });
      }
    }
    if (ALL && done.length) {
      // 顺序与 pipeline 的 stage 顺序**必须一致**：重建 → 截图+评分 → 接线。
      // linker 会把站内 <a href> 改写成档案内相对路径，而分数里的 data.links
      // 量的是"原站的数据字段有没有搬过来" —— 接线之后再测那一项就没有意义了。
      const CORE = fileURLToPath(new URL('../../', import.meta.url));
      const rebuilt = [];
      for (const page of done) {
        const dir = join(WORKSPACE, host, 'pages', page);
        try {
          await runScript('crawler/build_clone.mjs', [dir], { cwd: CORE });
          rebuilt.push(page);
        } catch (e) {
          console.error('[multi-snapshot] 重建失败 ' + page + '：' + String(e?.message ?? e).slice(0, 200));
          emit({ kind: 'snapshot-error', page, error: 'rebuild: ' + String(e?.message ?? e).slice(0, 160) });
        }
      }
      // **重建之后必须重算分数**。不重算的话，score.json 里那一份描述的是一个
      // 已经不存在的产物 —— 多视口升级前测的，而升级后 index.html 变成了 372 字节的
      // 视口选择器（diff 若直接读它会得到 DOM 0 / 数据 0）。实测 apify 12 页的分数
      // 全都停留在升级之前，apify/store 一度被算成 41.8%（真值 99.2%）。
      for (const page of rebuilt) {
        const dir = join(WORKSPACE, host, 'pages', page);
        try {
          const { url, via } = await resolveCloneUrl(host, page, dir);
          await runScript('crawler/shot_clone.mjs', [url, join(dir, 'shot-clone.png')], { cwd: CORE, quiet: true });
          await runScript('differ/diff.mjs', [dir], { cwd: CORE, quiet: true });
          const s = JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'));
          console.log('[multi-snapshot] 重算 ' + page + ' → ' + s.total + ' ' + s.grade + ' (via ' + via + ')');
          emit({ kind: 'snapshot-rescore', page, total: s.total, grade: s.grade });
        } catch (e) {
          console.error('[multi-snapshot] 重算失败 ' + page + '：' + String(e?.message ?? e).slice(0, 200));
        }
      }
      try {
        await runScript('crawler/linker.mjs', [host], { cwd: CORE });
      } catch (e) {
        console.error('[multi-snapshot] 接线失败：' + String(e?.message ?? e).slice(0, 200));
      }
    }
    console.log('[multi-snapshot] done pages=' + done.length + '/' + pages.length);
  } finally { await browser.close(); }
}
