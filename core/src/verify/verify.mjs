#!/usr/bin/env node
/**
 * verify — 多视口全页保真验证（视觉回归）
 *
 * 用法:
 *   node src/verify/verify.mjs <host> <page>
 *   node src/verify/verify.mjs <host> --all [--max 10]
 *   可选: --viewports 375x812,768x1024,1440x900  --threshold 85
 *
 * 产物: workspace/<host>/verify/<page>/
 *   verify.json         每个视口的 score/grade/heightDelta + 综合分
 *   diff-<vp>.png       差异热图（证据；全页截图在比较后删除以控制体积）
 *
 * 说明：全页截图在冻结动画/清空输入框后拍摄；超长页（>25000px）跳过并记录原因。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { sessionContext } from '../session/store.mjs';
import { comparePngBuffers, overallScore, worstViewport, gradeOf } from './compare.mjs';
import { verifyInteractions, scoreInteractions } from './interactions.mjs';
import { emit } from '../emit.mjs';

const log = (...a) => console.error('[verify]', ...a);
const MAX_PAGE_HEIGHT = 25_000;
const FREEZE_CSS = `
  *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }
  .swiper-wrapper { transform: none !important; transition: none !important; }
  /* 同意弹层随访问状态变化，会造成评分抖动：两侧统一隐藏 */
  [class*="cookie" i], [id*="cookie" i], [class*="consent" i], [id*="consent" i], [class*="gdpr" i], [id*="gdpr" i] { display: none !important; }
`;

const argv = process.argv.slice(2);
const host = argv[0] ?? '';
const pageArg = argv[1];
const all = argv.includes('--all');
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx > -1 ? Number(argv[maxIdx + 1]) : 10;
const vpIdx = argv.indexOf('--viewports');
const VIEWPORTS = (vpIdx > -1 ? argv[vpIdx + 1] : '375x812,768x1024,1440x900')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => { const [w, h] = s.split('x').map(Number); return { name: s, width: w, height: h }; });
const thrIdx = argv.indexOf('--threshold');
const THRESHOLD = thrIdx > -1 ? Number(argv[thrIdx + 1]) : 0;
// 交互回放（功能保真）：单页默认开启；--all 需显式 --interactions；--no-interactions 关闭
const RUN_IX = !argv.includes('--no-interactions') && (!all || argv.includes('--interactions'));

if (!host || (!pageArg && !all)) {
  console.error('usage: node src/verify/verify.mjs <host> <page>|--all [--max 10] [--viewports 375x812,768x1024,1440x900] [--threshold 85]');
  process.exit(2);
}

const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const pages = existsSync(PAGES) ? readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html')) && existsSync(join(PAGES, n, 'manifest.json'))) : [];
const targets = all ? pages.slice(0, MAX) : pages.filter(n => n === pageArg);
if (!targets.length) { console.error('no matching forged pages under', PAGES); process.exit(1); }

async function shoot(page, url, viewport, file) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForLoadState('load', { timeout: 20_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.addStyleTag({ content: FREEZE_CSS });
  await page.evaluate(() => { document.querySelectorAll('input, textarea').forEach(el => { el.value = ''; }); });
  // 先滚全页触发懒加载，再回到顶部（两侧一致，避免整页截图期间才加载造成的抖动）
  await page.evaluate(async () => {
    const h = Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0);
    for (let y = 0; y < h; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const height = await page.evaluate(() => Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0));
  if (height > MAX_PAGE_HEIGHT) return { skipped: 'page too tall: ' + height + 'px' };
  await page.screenshot({ path: file, fullPage: true, timeout: 90_000 });
  return { ok: true, height };
}

const browser = await chromium.launch();
const results = [];
try {
  for (const name of targets) {
    const dir = join(PAGES, name);
    const target = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).target;
    const outDir = join(BASE, 'verify', name);
    mkdirSync(outDir, { recursive: true });
    log('page', name, '->', target);
    const srcCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', ...sessionContext(new URL(target).hostname) });
    const cloneCtx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' });
    const srcPage = await srcCtx.newPage();
    const clonePage = await cloneCtx.newPage();
    const cloneUrl = 'http://127.0.0.1:' + (process.env.HEIMDALL_PORT ?? 8900) + '/static/' + host + '/pages/' + name + '/clone/index.html';
    const viewports = [];
    for (const vp of VIEWPORTS) {
      const srcFile = join(outDir, 'src-' + vp.name + '.png');
      const cloneFile = join(outDir, 'clone-' + vp.name + '.png');
      try {
        const s = await shoot(srcPage, target, vp, srcFile);
        const c = await shoot(clonePage, cloneUrl, vp, cloneFile);
        if (s.skipped) { viewports.push({ name: vp.name, skipped: s.skipped }); continue; }
        if (c.skipped) { viewports.push({ name: vp.name, skipped: c.skipped }); continue; }
        const cmp = comparePngBuffers(readFileSync(srcFile), readFileSync(cloneFile));
        // 只保留 diff 热图 + JSON，临时全页截图删除（控制磁盘占用；CAS 已对资产去重）
        writeFileSync(join(outDir, 'diff-' + vp.name + '.png'), cmp.diffPng);
        try { unlinkSync(srcFile); } catch {}
        try { unlinkSync(cloneFile); } catch {}
        viewports.push({ name: vp.name, width: vp.width, score: cmp.score, grade: gradeOf(cmp.score), mismatched: cmp.mismatched, heightDelta: cmp.heightDelta, sourceHeight: cmp.sourceSize.height, cloneHeight: cmp.cloneSize.height });
        emit({ kind: 'verify-viewport', page: name, viewport: vp.name, score: cmp.score });
      } catch (e) {
        viewports.push({ name: vp.name, error: String(e).slice(0, 200) });
        emit({ kind: 'verify-error', page: name, viewport: vp.name, error: String(e).slice(0, 200) });
      }
    }
    await srcCtx.close(); await cloneCtx.close();
    const overall = overallScore(viewports) ?? 0;
    const minViewport = worstViewport(viewports);

    // 功能保真：交互回放（按钮/折叠/标签页），状态签名 + 视口像素
    let interactions = [];
    if (RUN_IX) {
      try {
        interactions = await verifyInteractions(browser, { sourceUrl: target, cloneUrl, max: 3 });
        interactions.forEach((r, i) => { if (r.diffPng) { try { writeFileSync(join(outDir, 'ix-' + (i + 1) + '.png'), r.diffPng); } catch {} delete r.diffPng; } });
        emit({ kind: 'verify-interactions', page: name, ...(scoreInteractions(interactions) ?? { total: 0, passed: 0, score: null }) });
      } catch (e) {
        interactions = [{ pass: false, error: String(e).slice(0, 160) }];
        emit({ kind: 'verify-error', page: name, viewport: 'interactions', error: String(e).slice(0, 160) });
      }
    }
    const functional = scoreInteractions(interactions);

    const result = { page: name, target, generatedAt: new Date().toISOString(), overall, grade: gradeOf(overall), minViewport, viewports, functional, interactions };
    writeFileSync(join(outDir, 'verify.json'), JSON.stringify(result, null, 2));
    results.push({ page: name, overall, grade: result.grade, minViewport, functional });
    log(name, 'overall', (overall * 100).toFixed(1) + '%', result.grade, minViewport ? '| 最低 ' + minViewport.name + ' ' + (minViewport.score * 100).toFixed(1) + '%' : '', functional ? '| 交互 ' + functional.passed + '/' + functional.total : '| 交互 n/a');
    emit({ kind: 'verify-page', page: name, overall, grade: result.grade, minViewport, functional });
  }
} finally { await browser.close(); }

if (all) {
  const avg = results.length ? results.reduce((a, r) => a + r.overall, 0) / results.length : 0;
  const worst = results.reduce((a, r) => (r.minViewport && (!a || r.minViewport.score < a.score) ? { page: r.page, ...r.minViewport } : a), null);
  writeFileSync(join(BASE, 'verify', 'verify-summary.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), pages: results, average: +avg.toFixed(4), worst }, null, 2));
  log('site average', (avg * 100).toFixed(1) + '%', worst ? '| 最差 ' + worst.page + ' ' + worst.name + ' ' + (worst.score * 100).toFixed(1) + '%' : '');
  emit({ kind: 'verify-done', host, pages: results.length, average: +avg.toFixed(4) });
  if (THRESHOLD > 0 && avg * 100 < THRESHOLD) { log('FAIL below threshold', THRESHOLD); process.exit(1); }
} else {
  emit({ kind: 'verify-done', host, pages: results.length, average: results[0]?.overall ?? 0 });
}
