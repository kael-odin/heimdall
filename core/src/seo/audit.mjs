#!/usr/bin/env node
/**
 * seo/audit — 全站 SEO 审计（CLI / 引擎任务两用）
 *
 * 用法:
 *   node src/seo/audit.mjs <url|host> [--max 25] [--threshold 70]
 *
 * 产物（workspace/<host>/seo/）:
 *   seo.json   结构化结果（CI/接口消费）
 *   seo.csv    逐条问题（Excel 直开）
 *   seo.html   自包含报告（双击即看）
 *
 * 事件（@@EVENT@@ 行，engine-server 转发 SSE）:
 *   {kind:'audit-start', host, targets}
 *   {kind:'audit-page', url, index, total, score}
 *   {kind:'audit-done', host, score, pages, issues, reportPath}
 *   {kind:'audit-error', error}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { fetchRobotsAndSitemaps, discoverTargets, collectSite } from './collect.mjs';
import { evaluatePage, evaluateSite, scoreIssues, countBySeverity, CATEGORIES, SEVERITY_PENALTY } from './rules.mjs';
import { renderHtml, renderCsv } from './report.mjs';

const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
const log = (...a) => console.error('[seo]', ...a);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const target = argv.find(a => !a.startsWith('--')) ?? '';
const getNum = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i > -1 && argv[i + 1]) return Number(argv[i + 1]);
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  if (eq) return Number(eq.split('=')[1]);
  return def;
};
const MAX = Math.max(1, Math.min(getNum('max', 25), 200));
const THRESHOLD = getNum('threshold', 0);
if (!target) { console.error('usage: node src/seo/audit.mjs <url|host> [--max 25] [--threshold 70]'); process.exit(2); }

const targetUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`;
let origin; try { origin = new URL(targetUrl).origin; } catch { console.error('invalid target:', target); process.exit(2); }
const host = new URL(origin).hostname.replace(/^www\./, '');

try {
  const base = join(WORKSPACE, host);
  const outDir = join(base, 'seo');
  mkdirSync(outDir, { recursive: true });

  // ---------- 目标页面：优先复用 atlas，否则 sitemap/BFS ----------
  const atlasPath = join(base, 'recon', 'atlas.json');
  let targets = [];
  let sitemap = { sitemapUrls: new Set(), robots: { ok: false, sitemaps: [] } };
  if (existsSync(atlasPath)) {
    try {
      const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
      targets = (atlas.nodes ?? [])
        .filter(n => !['auth', 'legal'].includes(n.type))
        .slice(0, MAX)
        .map(n => ({ url: n.url, depth: n.depth ?? 0 }));
      log(`reuse atlas: ${targets.length} pages`);
    } catch {}
  }
  log('fetching robots/sitemap...');
  sitemap = await fetchRobotsAndSitemaps(origin);

  if (targets.length < 2) {
    log('discovering targets (sitemap/BFS)...');
    const browser = await chromium.launch();
    try {
      targets = await discoverTargets(browser, origin, { max: MAX, sitemapUrls: sitemap.sitemapUrls });
    } finally { await browser.close(); }
  }
  // 去重：/ 与无尾斜杠、以及 sitemap 中的重复 URL 只审计一次
  const seenTargets = new Set();
  targets = targets.filter(t => {
    const key = t.url.replace(/\/$/, '');
    if (seenTargets.has(key)) return false;
    seenTargets.add(key);
    return true;
  });
  if (!targets.length) throw new Error('no pages discovered for ' + origin);
  emit({ kind: 'audit-start', host, origin, targets: targets.length });
  log(`auditing ${targets.length} pages of ${origin}`);

  // ---------- 采集 ----------
  const browser = await chromium.launch();
  let pages;
  try {
    pages = await collectSite(origin, targets, {
      concurrency: 2,
      browser,
      onProgress: (page, i, total) => {
        const issues = evaluatePage(page, { host, sitemapUrls: sitemap.sitemapUrls, noindexIntent: true });
        emit({ kind: 'audit-page', url: page.url, index: i, total, status: page.status, score: scoreIssues(issues) });
      },
    });
  } finally { await browser.close(); }

  // ---------- 站点聚合 ----------
  const inlinks = new Map();
  const known = new Set(pages.map(p => p.url.replace(/\/$/, '')));
  for (const p of pages) {
    for (const href of p.internalHrefs ?? []) {
      const key = href.replace(/\/$/, '');
      if (known.has(key) && key !== p.url.replace(/\/$/, '')) inlinks.set(key, (inlinks.get(key) ?? 0) + 1);
    }
  }
  const orphans = pages.filter(p => (p.depth ?? 0) > 0 && (inlinks.get(p.url.replace(/\/$/, '')) ?? 0) === 0).map(p => p.url);

  const group = (keyFn) => {
    const map = {};
    for (const p of pages) { const k = keyFn(p); if (!k) continue; (map[k] ??= []).push(p.url); }
    return map;
  };

  const site = {
    host, origin,
    pages,
    sitemapUrls: sitemap.sitemapUrls,
    sitemapChecked: sitemap.checked,
    robots: sitemap.robots,
    duplicates: { title: group(p => p.title), description: group(p => p.description), h1: group(p => (p.h1 ?? []).join('|')) },
    orphans,
  };

  const allSiteIssues = evaluateSite(site);
  const pageIssues = new Map();
  for (const p of pages) pageIssues.set(p.url, evaluatePage(p, site));

  const pagesScored = pages.map(p => {
    const issues = pageIssues.get(p.url) ?? [];
    return { ...p, issues, score: scoreIssues(issues), counts: countBySeverity(issues) };
  });

  const avgPage = pagesScored.length ? pagesScored.reduce((a, p) => a + p.score, 0) / pagesScored.length : 100;
  const sitePenalty = allSiteIssues.reduce((a, i) => a + (SEVERITY_PENALTY[i.severity] ?? 0), 0) / Math.max(pages.length, 1);
  const siteScore = Math.max(0, Math.round((avgPage - sitePenalty) * 10) / 10);

  const allIssues = [...pagesScored.flatMap(p => p.issues), ...allSiteIssues];
  const bySeverity = countBySeverity(allIssues);
  const categories = {};
  for (const key of Object.keys(CATEGORIES)) {
    const penalty = allIssues.filter(i => i.category === key).reduce((a, i) => a + (SEVERITY_PENALTY[i.severity] ?? 0), 0);
    categories[key] = { score: Math.max(0, Math.round((100 - penalty / Math.max(pages.length, 1)) * 10) / 10), issues: allIssues.filter(i => i.category === key).length };
  }

  const report = {
    host, origin,
    generatedAt: new Date().toISOString(),
    config: { max: MAX, viewport: '1440x900', concurrency: 2, source: existsSync(atlasPath) && targets.length >= 2 ? 'atlas' : 'sitemap/bfs' },
    score: siteScore,
    summary: { pages: pages.length, issues: allIssues.length, bySeverity, pagesScored: pages.length },
    categories,
    siteIssues: allSiteIssues,
    pages: pagesScored,
  };

  const jsonPath = join(outDir, 'seo.json');
  const csvPath = join(outDir, 'seo.csv');
  const htmlPath = join(outDir, 'seo.html');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(csvPath, renderCsv(report));
  writeFileSync(htmlPath, renderHtml(report));

  log(`score ${siteScore} | pages ${pages.length} | issues ${allIssues.length} (critical ${bySeverity.critical}, high ${bySeverity.high})`);
  log(`report -> ${htmlPath}`);
  emit({ kind: 'audit-done', host, score: siteScore, pages: pages.length, issues: allIssues.length, bySeverity, reportPath: htmlPath });

  if (THRESHOLD > 0 && siteScore < THRESHOLD) {
    log(`FAIL: score ${siteScore} < threshold ${THRESHOLD}`);
    process.exit(1);
  }
} catch (e) {
  const msg = String(e?.stack ?? e).slice(0, 600);
  log('FATAL', msg);
  emit({ kind: 'audit-error', error: String(e).slice(0, 300) });
  process.exit(1);
}
