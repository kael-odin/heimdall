#!/usr/bin/env node
/**
 * crawler/responsive-upgrade — 低分页响应式升级（多视口快照 + verify 门槛）
 *
 * 流程（逐页）：multi-snapshot(375/768) → build_clone → verify(三视口)
 *   保留条件：最差视口提升 > 0.5% 且综合分下降不超过 0.5%；否则回退（变体移入 _variants-backup-<ts> 并重建）。
 *
 * 用法: node src/crawler/responsive-upgrade.mjs <host> [--threshold 0.97] [--max N] [--force]
 * 依赖: workspace/<host>/verify/verify-summary.json（先跑 verify --all）
 * 产物: workspace/<host>/audit/responsive-upgrade.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { snapPage } from './multi-snapshot.mjs';
import { makeArgs } from '../args.mjs';

const argv = process.argv.slice(2);
const { argOf } = makeArgs(argv);
const host = argv.find(a => !a.startsWith('--'));
const THRESHOLD = Number(argOf('threshold', 0.97));
const MAX = Number(argOf('max', 99));
const FORCE = argv.includes('--force');
if (!host) { console.error('usage: node src/crawler/responsive-upgrade.mjs <host> [--threshold 0.97] [--max N] [--force]'); process.exit(2); }

const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const summaryPath = join(BASE, 'verify', 'verify-summary.json');
if (!existsSync(summaryPath)) { console.error('missing verify-summary.json — run: verify ' + host + ' --all --max N'); process.exit(1); }
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
const candidates = (summary.pages ?? [])
  .filter(p => p.minViewport && p.minViewport.score < THRESHOLD)
  .filter(p => FORCE || !existsSync(join(PAGES, p.page, 'dom-375.html')))
  .sort((a, b) => a.minViewport.score - b.minViewport.score)
  .slice(0, MAX);
console.log('[upgrade] host=' + host + ' threshold=' + THRESHOLD + ' candidates=' + candidates.length);

const runNode = (args, timeout = 600000) => spawnSync(process.execPath, args, { cwd: new URL('../../', import.meta.url).pathname.replace(/^\//, ''), encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
const verifyOnce = (page) => {
  const r = runNode(['src/verify/verify.mjs', host, page, '--no-interactions']);
  const line = String(r.stdout || '').split('\n').find(l => l.includes('"kind":"verify-page"'));
  try { return JSON.parse(line.slice(9)); } catch { return null; }
};
const backupVariants = (page, stamp) => {
  const dir = join(PAGES, page);
  const bak = join(dir, '_variants-backup-' + stamp);
  let moved = 0;
  for (const n of readdirSync(dir)) {
    if (/^(dom-(375|768)\.html|cssom-(375|768)\.css|cssom-refs-(375|768)\.json)$/.test(n)) {
      mkdirSync(bak, { recursive: true });
      renameSync(join(dir, n), join(bak, n));
      moved++;
    }
  }
  return moved;
};

const browser = await chromium.launch();
const results = [];
try {
  for (const c of candidates) {
    const page = c.page;
    const before = { overall: c.overall, min: c.minViewport.score, minVp: c.minViewport.name };
    try {
      await snapPage(browser, host, page, [375, 768]);
      const b = runNode(['src/crawler/build_clone.mjs', join(PAGES, page)]);
      if (b.status !== 0) throw new Error('build_clone failed');
      const after = verifyOnce(page);
      if (!after) throw new Error('verify failed');
      const keep = after.minViewport && after.minViewport.score > before.min + 0.005 && after.overall >= before.overall - 0.005;
      if (keep) {
        results.push({ page, before, after: { overall: after.overall, min: after.minViewport.score, minVp: after.minViewport.name }, kept: true });
        console.log('[upgrade] KEEP ' + page + ' ' + (before.overall * 100).toFixed(1) + '/' + (before.min * 100).toFixed(1) + ' -> ' + (after.overall * 100).toFixed(1) + '/' + (after.minViewport.score * 100).toFixed(1));
      } else {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupVariants(page, stamp);
        runNode(['src/crawler/build_clone.mjs', join(PAGES, page)]);
        results.push({ page, before, after: { overall: after.overall, min: after.minViewport?.score ?? null, minVp: after.minViewport?.name ?? null }, kept: false, backup: '_variants-backup-' + stamp });
        console.log('[upgrade] REVERT ' + page + ' ' + (before.overall * 100).toFixed(1) + '/' + (before.min * 100).toFixed(1) + ' -> ' + (after.overall * 100).toFixed(1) + '/' + ((after.minViewport?.score ?? 0) * 100).toFixed(1));
      }
      emit({ kind: 'upgrade-page', page, kept: keep });
    } catch (e) {
      results.push({ page, before, error: String(e).slice(0, 160), kept: false });
      console.error('[upgrade] FAIL ' + page + ': ' + String(e).slice(0, 160));
    }
  }
} finally { await browser.close(); }

if (results.some(r => r.kept)) {
  console.log('[upgrade] linker + asset scan');
  runNode(['src/crawler/linker.mjs', host]);
  runNode(['src/audit/assets.mjs', host]);
}
const report = { host, generatedAt: new Date().toISOString(), threshold: THRESHOLD, candidates: candidates.length, kept: results.filter(r => r.kept).length, reverted: results.filter(r => !r.kept && !r.error).length, failed: results.filter(r => r.error).length, results };
mkdirSync(join(BASE, 'audit'), { recursive: true });
writeFileSync(join(BASE, 'audit', 'responsive-upgrade.json'), JSON.stringify(report, null, 2));
console.log('[upgrade] DONE kept=' + report.kept + ' reverted=' + report.reverted + ' failed=' + report.failed + ' -> audit/responsive-upgrade.json');
