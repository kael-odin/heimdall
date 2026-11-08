#!/usr/bin/env node
/**
 * watch — 站点变更监控
 *
 * 用法:
 *   node src/watch/watch.mjs <host> [--max 20] [--accept] [--fail-on-change]
 *
 * 产物（workspace/<host>/watch/）:
 *   baseline.json      当前基线（--accept 时更新）
 *   watch.json         本次快照 + 差异
 *   watch.html         变更报告（双击即看）
 *   history/<ts>.json  历史快照（保留最近 30 份）
 *
 * 事件: {kind:'watch-start'} / {kind:'watch-done', changes, bySeverity}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { assertSiteOrigin, siteIdForOrigin } from '../site-origin.mjs';
import { fetchRobotsAndSitemaps, discoverTargets, collectSite } from '../seo/collect.mjs';
import { snapshotFromPages, diffSnapshots } from './diff.mjs';
import { renderWatchHtml } from './report.mjs';
import { emit } from '../emit.mjs';
import { makeArgs } from '../args.mjs';

const log = (...a) => console.error('[watch]', ...a);

const argv = process.argv.slice(2);
const { has, num } = makeArgs(argv);
const target = argv.find(a => !a.startsWith('--'));
if (!target) { console.error('usage: node src/watch/watch.mjs <host|url> [--max 20] [--accept] [--fail-on-change]'); process.exit(2); }

const targetUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`;
let origin; try { origin = new URL(targetUrl).origin; } catch { console.error('invalid target'); process.exit(2); }
const host = new URL(origin).hostname.replace(/^www\./, '');
const siteId = siteIdForOrigin(WORKSPACE, origin);
const MAX = Math.max(1, Math.min(num('max', 20), 200));
const BASE = join(WORKSPACE, siteId);
assertSiteOrigin(BASE, origin, { claim: true });
const OUT = join(BASE, 'watch');
mkdirSync(join(OUT, 'history'), { recursive: true });

try {
  // ---------- 目标页面 ----------
  let targets = [];
  const atlasPath = join(BASE, 'recon', 'atlas.json');
  if (existsSync(atlasPath)) {
    try {
      const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
      targets = (atlas.nodes ?? []).filter(n => !['auth', 'legal'].includes(n.type)).slice(0, MAX).map(n => ({ url: n.url, depth: n.depth ?? 0 }));
    } catch {}
  }
  if (targets.length < 2) {
    const sitemap = await fetchRobotsAndSitemaps(origin);
    if (!['complete', 'not_found'].includes(sitemap.coverage)) {
      throw new Error(`sitemap discovery incomplete (${sitemap.coverage}: ${sitemap.reasons.join(', ')}); watch comparison and baseline update skipped`);
    }
    const browser = await chromium.launch();
    try { targets = await discoverTargets(browser, origin, { max: MAX, sitemapUrls: sitemap.sitemapUrls }); }
    finally { await browser.close(); }
  }
  const seen = new Set();
  targets = targets.filter(t => { const k = t.url.replace(/\/$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
  if (!targets.length) throw new Error('no pages discovered');
  emit({ kind: 'watch-start', host, origin, targets: targets.length });
  log(`collecting ${targets.length} pages of ${origin}`);

  // ---------- 采集（默认两次采样：识别动态内容，排除计数/轮播等噪声） ----------
  const STABILITY = !has('no-stability');
  const browser = await chromium.launch();
  let pages, sampleB = [];
  try {
    pages = await collectSite(origin, targets, {
      concurrency: 2, browser,
      onProgress: (p, i, total) => emit({ kind: 'watch-page', url: p.url, index: i, total }),
    });
    if (STABILITY) {
      log('stability sample (2/2)...');
      sampleB = await collectSite(origin, targets, { concurrency: 2, browser });
    }
  } finally { await browser.close(); }

  const FIELDS = ['status', 'finalUrl', 'title', 'description', 'canonical', 'robotsMeta', 'lang', 'h1Joined', 'jsonldTypes', 'wordCount', 'textHash'];
  const signalOf = (p) => ({
    status: p.status, finalUrl: p.finalUrl, title: p.title, description: p.description, canonical: p.canonical,
    robotsMeta: p.robotsMeta, lang: p.lang, h1Joined: (p.h1 ?? []).join(' | '),
    jsonldTypes: [...new Set((p.jsonld ?? []).flatMap(j => j.types ?? []))].join(','),
    wordCount: p.wordCount, textHash: p.textHash,
  });
  const unstableMap = {};
  if (STABILITY && sampleB.length) {
    const bByUrl = new Map(sampleB.map(p => [p.url, signalOf(p)]));
    for (const p of pages) {
      const a = signalOf(p), b = bByUrl.get(p.url);
      if (!b) continue;
      const diffs = FIELDS.filter(f => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
      if (diffs.length) unstableMap[p.url] = diffs;
    }
    const noisy = Object.keys(unstableMap).length;
    log('stability: ' + noisy + '/' + pages.length + ' pages have dynamic fields' + (noisy ? ' (' + [...new Set(Object.values(unstableMap).flat())].join(', ') + ')' : ''));
    emit({ kind: 'watch-stability', unstablePages: noisy });
  }

  const snapshot = snapshotFromPages(host, pages, new Date().toISOString(), unstableMap);
  const baselinePath = join(OUT, 'baseline.json');
  const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : null;
  const diff = baseline ? diffSnapshots(baseline, snapshot) : { added: [], removed: [], changed: [], unchanged: pages.length, bySeverity: { high: 0, medium: 0, low: 0, info: 0 }, hasChanges: false };

  const report = {
    host, origin, generatedAt: snapshot.generatedAt, baselineAt: baseline?.generatedAt ?? null,
    summary: { total: pages.length, changedTotal: diff.added.length + diff.removed.length + diff.changed.length, firstRun: !baseline },
    diff, snapshot,
  };
  writeFileSync(join(OUT, 'watch.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT, 'watch.html'), renderWatchHtml(report));

  // 历史快照（保留最近 30）
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(OUT, 'history', ts + '.json'), JSON.stringify({ host, generatedAt: snapshot.generatedAt, pages: snapshot.pages }));
  const history = readdirSync(join(OUT, 'history')).filter(f => f.endsWith('.json')).sort();
  for (const f of history.slice(0, Math.max(0, history.length - 30))) { try { unlinkSync(join(OUT, 'history', f)); } catch {} }

  if (!baseline) {
    writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2));
    log(`first run: baseline created (${pages.length} pages) -> ${join(OUT, 'watch.html')}`);
  } else if (has('accept')) {
    writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2));
    log(`baseline updated (${pages.length} pages)`);
  }

  log(`changes: added ${diff.added.length} / removed ${diff.removed.length} / changed ${diff.changed.length} (high ${diff.bySeverity.high})`);
  log(`report -> ${join(OUT, 'watch.html')}`);
  emit({ kind: 'watch-done', host, pages: pages.length, changes: diff.added.length + diff.removed.length + diff.changed.length, bySeverity: diff.bySeverity, reportPath: join(OUT, 'watch.html') });

  if (has('fail-on-change') && diff.hasChanges) { log('FAIL: changes detected'); process.exit(1); }
} catch (e) {
  log('FATAL', String(e?.stack ?? e).slice(0, 500));
  emit({ kind: 'watch-error', error: String(e).slice(0, 300) });
  process.exit(1);
}
