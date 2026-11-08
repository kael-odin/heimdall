#!/usr/bin/env node
/**
 * seo/audit — 全站 SEO 审计（CLI / 引擎任务两用）
 *
 * 用法:
 *   node src/seo/audit.mjs <url|host> [--max 25] [--threshold 70]
 *                          [--baseline <file>] [--update-baseline]
 *                          [--fail-on-regression] [--tolerance N]
 *
 * 产物（workspace/<host>/seo/）:
 *   seo.json      结构化结果（CI/接口消费）
 *   seo.csv       逐条问题（Excel 直开）
 *   seo.html      自包含报告（双击即看）
 *   baseline.json 回归基线（--update-baseline 时写入，进 git）
 *   diff.md       回归对比（PR 评论可直接贴）
 *
 * 基线门禁（--fail-on-regression）：与 baseline.json 比对，出现阻断级回归则 exit 1。
 *   --tolerance N（默认 0）额外启用「总分跌幅」门禁；默认 0 表示只看具名问题。
 *   波动规则（LCP/CLS/FCP）不计入判定。
 *   --fail-on-regression / --require-baseline 都要求基线**必须存在** ——
 *   基线丢了当成首次运行直接绿灯，是门禁最隐蔽的失效方式。
 *
 * 事件（@@EVENT@@ 行，engine-server 转发 SSE）:
 *   {kind:'audit-start', host, targets}
 *   {kind:'audit-page', url, index, total, score}
 *   {kind:'audit-done', host, score, pages, issues, reportPath}
 *   {kind:'audit-regression', ok, blocking, regressions, score, markdownPath}
 *   {kind:'audit-error', error}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { chromium } from 'playwright';
import { WORKSPACE } from '../paths.mjs';
import { assertSiteOrigin, siteIdForOrigin } from '../site-origin.mjs';
import { fetchRobotsAndSitemaps, discoverTargets, collectSite } from './collect.mjs';
import { evaluatePage, evaluateSite, scoreIssues, countBySeverity, CATEGORIES, SEVERITY_PENALTY } from './rules.mjs';
import { appendHistory } from './history.mjs';
import { fetchFieldData, compareLabToField } from './field-data.mjs';
import { renderHtml, renderCsv } from './report.mjs';
import { buildBaseline, snapshotOf, diffBaseline, renderDiffText, renderDiffMarkdown, BASELINE_VERSION } from './baseline.mjs';
import { readBaselineFile } from './baseline-file.mjs';
import { isSameOriginUrl } from '../url-canon.mjs';
import { emit } from '../emit.mjs';
import { parseAuditArgs } from './cli-args.mjs';

const log = (...a) => console.error('[seo]', ...a);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let parsedArgs;
try { parsedArgs = parseAuditArgs(argv); }
catch (error) { console.error(String(error?.message ?? error)); process.exit(2); }
const {
  target, max: MAX, threshold: THRESHOLD, tolerance: TOLERANCE,
  baseline: BASELINE_ARG, updateBaseline: UPDATE_BASELINE,
  failOnRegression: FAIL_ON_REGRESSION, requireBaseline: REQUIRE_BASELINE,
} = parsedArgs ?? {};
// 基线必须进 git 才有意义（否则 CI 每次都是首次运行，门禁形同虚设）。
// 默认放在 workspace 下，由 --baseline 指定仓库内路径覆盖。

const targetUrl = /^https?:\/\//i.test(target) ? target : `https://${target}`;
let origin;
try {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) && !/^https?:\/\//i.test(target)) throw new Error('unsupported protocol');
  const parsed = new URL(targetUrl);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsupported target URL');
  origin = parsed.origin;
} catch { console.error('invalid HTTP(S) target:', target); process.exit(2); }
const host = new URL(origin).hostname.replace(/^www\./, '');
const siteId = siteIdForOrigin(WORKSPACE, origin);

try {
  const base = join(WORKSPACE, siteId);
  assertSiteOrigin(base, origin, { claim: true });
  const outDir = join(base, 'seo');
  mkdirSync(outDir, { recursive: true });

  // 前置条件在抓取**之前**检查：基线路径写错不该先白抓一遍全站（CI 里就是白等几十秒）。
  // 同时「文件没了 → 当成首次运行 → 绿灯」是门禁最隐蔽的失效方式 ——
  // 它看起来和正常通过一模一样，没人会发现。所以要求比对时必须硬失败。
  const baselinePath = resolveUserPath(BASELINE_ARG ?? join(outDir, 'baseline.json'));
  let baseline;
  try {
    baseline = readBaselineFile(baselinePath, {
      required: REQUIRE_BASELINE || FAIL_ON_REGRESSION,
      expectedOrigin: origin,
      expectedHost: host,
    });
  } catch (error) {
    log(`FATAL ${error.message}`);
    emit({ kind: 'audit-error', error: error.message });
    process.exit(1);
  }

  // ---------- 目标页面：优先复用 atlas，否则 sitemap/BFS ----------
  const atlasPath = join(base, 'recon', 'atlas.json');
  let targets = [];
  let sitemap = { sitemapUrls: new Set(), robots: { ok: false, sitemaps: [] } };
  if (existsSync(atlasPath)) {
    try {
      const atlas = JSON.parse(readFileSync(atlasPath, 'utf8'));
      targets = (atlas.nodes ?? [])
        .filter(n => isSameOriginUrl(n.url, origin) && !['auth', 'legal'].includes(n.type))
        .slice(0, MAX)
        .map(n => ({ url: n.url, depth: n.depth ?? 0 }));
      log(`reuse atlas: ${targets.length} pages`);
    } catch {}
  }
  // **必须在回退之前记下来**：下面那句 `if (targets.length < 2)` 会把 targets 整个换成
  // sitemap/BFS 发现的结果，之后再去看 `targets.length >= 2` 就永远为真 ——
  // 于是"atlas 里只有 1 个节点、实际靠 BFS 抓的"这种运行也会被标成 source: 'atlas'，
  // 而这个字段是写进 seo.json 交付出去的（报告口径不能靠猜）。
  const discoverySource = existsSync(atlasPath) && targets.length >= 2 ? 'atlas' : 'sitemap/bfs';

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
  // 基线里记过的页面必须“真的被查过”才算消失。否则 --max 截断、或这次 atlas 恰好没扫到
  // 某个老页面时，diff 会报 critical 的 "页面消失" —— 页面还在，只是这轮没去看它。
  // 并入后仍受 MAX 约束，且不改变 source 口径（它只说明"目标从哪来"）。
  const baselinePages = Object.keys(baseline?.pages ?? {});
  let baselineOnly = 0;
  for (const url of baselinePages) {
    if (targets.length >= MAX) break;
    if (!isSameOriginUrl(url, origin)) continue;
    const key = url.replace(/\/$/, '');
    if (seenTargets.has(key)) continue;
    seenTargets.add(key); targets.push({ url, depth: 0 }); baselineOnly++;
  }
  if (baselineOnly) log(`+${baselineOnly} baseline page(s) added to this run so "page-missing" means really missing`);
  if (!targets.length) throw new Error('no pages discovered for ' + origin);
  emit({ kind: 'audit-start', host, origin, targets: targets.length });
  log(`auditing ${targets.length} pages of ${origin}`);

  // ---------- 采集 ----------
  const browser = await chromium.launch();
  // 页面级评测上下文：进度流与报告**共用这一份**。
  // 分头写就会漂移 —— 以前进度流多传了 `noindexIntent: true`，于是 noindex 页
  // 在进度里比报告里高最多 12 分（那是条 high 级规则），同一个页面两个分数。
  // 下面 site 用 `...pageCtx` 展开，两处因此不可能不一致。
  const pageCtx = { host, sitemapUrls: sitemap.sitemapUrls };

  let pages;
  try {
    pages = await collectSite(origin, targets, {
      concurrency: 2,
      browser,
      onProgress: (page, i, total) => {
        // **与报告那一遍同一套判据**。这里以前多传了一个 `noindexIntent: true`，
        // 而报告用的是站点对象（没有这个字段）—— 于是 noindex 页在进度流里比报告里
        // 高最多 12 分（那条规则是 high 级），同一个页面两个分数对不上，
        // 而 CI 基线取的是报告那个更严的数。差异只在 `noindexIntent` 与 `host`，
        // 两个在爬取期都拿得到，没有理由两套。
        const issues = evaluatePage(page, pageCtx);
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
    ...pageCtx,          // host / sitemapUrls 与进度流同源，见 pageCtx 的注释
    origin,
    pages,
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

  // 浏览器未拿到页面或被 HTTP 错误页替代时，不能将错误画面更新为基线。
  // 普通审计仍保留报告，方便定位原因；门禁和基线更新必须返回失败。
  const failedPages = pagesScored.filter(p =>
    !Number.isInteger(p.status) || p.status < 200 || p.status >= 400
    || !isSameOriginUrl(p.finalUrl, origin));
  const uncheckedInitialHtml = pagesScored.filter(p => p.robotsEvidence?.initialHtml !== 'checked');
  const gateRequested = FAIL_ON_REGRESSION || REQUIRE_BASELINE || UPDATE_BASELINE || THRESHOLD > 0;

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

  // 分数走势：追加一条（原子写）。历史是增强项，失败不影响本次审计。
  if (!failedPages.length && !uncheckedInitialHtml.length) {
    appendHistory(siteId, {
      kind: 'audit', score: siteScore,
      grade: siteScore >= 90 ? 'A' : siteScore >= 75 ? 'B' : 'C',
      pages: pages.length, issues: allIssues.length,
      critical: bySeverity.critical ?? 0, high: bySeverity.high ?? 0,
    });
  }

  const report = {
    host, origin,
    generatedAt: new Date().toISOString(),
    config: { max: MAX, viewport: '1440x900', concurrency: 2, source: discoverySource },
    score: siteScore,
    summary: { pages: pages.length, issues: allIssues.length, bySeverity, pagesScored: pages.length, initialHtmlUnchecked: uncheckedInitialHtml.length },
    categories,
    siteIssues: allSiteIssues,
    pages: pagesScored,
  };

  // 真实用户指标（可选）：需自备 HEIMDALL_PSI_KEY。没配就如实记下"只有实验室数据"，
  // 不假装有实时数据 —— 报告里宁可写清楚缺什么，也不要让人误以为那是真实用户体验。
  {
    const field = await fetchFieldData(origin);
    const lcps = pages.map(p => p.vitals?.lcp).filter(v => typeof v === 'number').sort((a, b) => a - b);
    const clss = pages.map(p => p.vitals?.cls).filter(v => typeof v === 'number');
    const lab = {
      lcp: lcps.length ? lcps[Math.floor(lcps.length / 2)] : null,          // 中位数，抗离群
      cls: clss.length ? +(clss.reduce((a, b) => a + b, 0) / clss.length).toFixed(3) : null,
    };
    report.field = { ...field, lab, compare: compareLabToField(lab, field) };
  }

  const jsonPath = join(outDir, 'seo.json');
  const csvPath = join(outDir, 'seo.csv');
  const htmlPath = join(outDir, 'seo.html');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(csvPath, renderCsv(report));
  writeFileSync(htmlPath, renderHtml(report));

  log(`score ${siteScore} | pages ${pages.length} | issues ${allIssues.length} (critical ${bySeverity.critical}, high ${bySeverity.high})`);
  log(`report -> ${htmlPath}`);
  emit({ kind: 'audit-done', host, score: siteScore, pages: pages.length, issues: allIssues.length, bySeverity, reportPath: htmlPath, initialHtmlUnchecked: uncheckedInitialHtml.length });

  // A refetch can differ from the navigation response, so it cannot prove that an initial noindex disappeared.
  if (uncheckedInitialHtml.length) {
    const sample = uncheckedInitialHtml.slice(0, 3).map(p => p.url).join('; ');
    log(`INCOMPLETE: ${uncheckedInitialHtml.length}/${pagesScored.length} 页未核对初始 HTML，跳过基线比对和更新。${sample}`);
    emit({ kind: 'audit-incomplete', reason: 'initial-html-unavailable', pages: uncheckedInitialHtml.length });
    if (failedPages.length && gateRequested) log(`FAIL: ${failedPages.length}/${pagesScored.length} 页未从目标来源成功采集。`);
    if (gateRequested) process.exit(1);
    process.exit(0);
  }

  // ---------- 回归基线 ----------
  const current = snapshotOf(report);

  let diff = null;
  try {
    diff = diffBaseline(baseline, current, { tolerance: TOLERANCE });
  } catch (e) {
    log(`FATAL 基线比对失败：${e.message}`);
    emit({ kind: 'audit-error', error: String(e).slice(0, 300) });
    process.exit(1);
  }

  if (!diff.firstRun) {
    const text = renderDiffText(diff);
    log('\n' + text);
    const mdPath = join(outDir, 'diff.md');
    writeFileSync(mdPath, renderDiffMarkdown(diff));
    emit({
      kind: 'audit-regression', ok: diff.ok, blocking: diff.counts.blocking,
      regressions: diff.regressions.length, score: diff.score,
      markdownPath: mdPath, reportPath: htmlPath,
    });
  }

  // 有页面采集失败时**不写基线**：错误页的画面不该被记成"现状"。
  if ((UPDATE_BASELINE || diff.firstRun) && failedPages.length === 0) {
    writeFileSync(baselinePath, JSON.stringify(current, null, 2) + '\n');
    log(`${diff.firstRun ? '首次运行，已建立' : '已更新'}基线 -> ${baselinePath}`);
    emit({ kind: 'audit-baseline', path: baselinePath, created: diff.firstRun, version: BASELINE_VERSION });
  }

  // 采集失败只在**门禁模式**下才算失败。普通审计（引擎点"审计"、matrix 首次刷新）本来就该
  // 把 404 当作发现报告出来 —— 以前这里带着 diff.firstRun，于是站点上只要有一个坏链接，
  // 普通审计就 exit 1、基线也永远建不起来（每次都是"首次运行"）。
  if (failedPages.length && gateRequested) {
    const sample = failedPages.slice(0, 3).map(p => `${p.status}: ${p.url}${isSameOriginUrl(p.finalUrl, origin) ? '' : ` -> ${p.finalUrl}`}`).join('; ');
    log(`FAIL: ${failedPages.length}/${pagesScored.length} 页未从目标来源成功采集，拒绝通过门禁或更新基线。${sample}`);
    process.exit(1);
  }

  if (THRESHOLD > 0 && siteScore < THRESHOLD) {
    log(`FAIL: score ${siteScore} < threshold ${THRESHOLD}`);
    process.exit(1);
  }
  if (FAIL_ON_REGRESSION && diff && !diff.ok) {
    log(`FAIL: ${diff.counts.blocking} 项阻断级回归`);
    process.exit(1);
  }
} catch (e) {
  const msg = String(e?.stack ?? e).slice(0, 600);
  log('FATAL', msg);
  emit({ kind: 'audit-error', error: String(e).slice(0, 300) });
  process.exit(1);
}

/** 用户给的相对路径按「敲命令的目录」解析（CLI 会把 cwd 塞进 HEIMDALL_INVOKE_CWD），
 *  否则会落到 core/ 下 —— 那是脚本自己的目录，不是用户的。 */
function resolveUserPath(p) {
  if (!p) return p;
  return isAbsolute(p) ? p : resolve(process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), p);
}
