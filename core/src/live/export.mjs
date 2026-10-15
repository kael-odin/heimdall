#!/usr/bin/env node
/**
 * live/export — 生成"可直接部署"的交互镜像包（L3）
 *
 * 用法:
 *   node src/live/export.mjs <host> [--out <dir>] [--offline] [--port 8080] [--rebuild] [--root landing|mirror] [--heal] [--materialize-har] [--strict]
 *
 * 产物（默认 DATA_ROOT/deliverable/<host>-live-<date>/）:
 *   serve.mjs / har.mjs / live-path.mjs   零依赖 Node 服务器
 *   heimdall-live.json         配置（host/origin/port/offline/replayApi）
 *   har.json                   清洗后的 HAR（本地资源与 API 回放）
 *   site/live/**               build_live 的交互镜像页面
 *   site/static/<host>/**      克隆页 / CSS / 资产 / 档案 / 对比
 *   landing.html               落地页（镜像/档案/报告入口）
 *   Dockerfile / docker-compose.yml / README.md / checksums.json / changes.json
 *
 * 部署:
 *   node serve.mjs --port 8080
 *   docker compose up -d
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, lstatSync, copyFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, DELIVERABLE, localDateStamp } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { buildEditManifest, renderEditManifestMd } from '../deliver/edit-manifest.mjs';
import { sanitizeHar, harStats, indexHar, harKey } from './har.mjs';
import { listLivePageRoutes, scanLiveBundle } from './health.mjs';
import { healReferencedAssets, materializeHar, localizeQueryEntries, rewriteLocalRefs, isStaticAsset } from './heal.mjs';
import { diffChecksums, changesLine } from './changes.mjs';
import { mb } from '../fsutil.mjs';
import { makeArgs } from '../args.mjs';
import { assertExportTarget, promoteCandidate } from './export-path.mjs';
import { probeOfflineBundle, probeOfflineBrowserBundle, probeOfflineOperations } from './probe.mjs';
import { liveSnapshotPath, liveSnapshotCandidates } from './live-path.mjs';
import { buildCoverageLedger } from './coverage.mjs';
import { readOperationPlan } from './operation-plan.mjs';
import { readDataPlan } from './read-data-plan.mjs';
import { captureSourceOperations } from '../crawler/source-operations.mjs';
import { addReadOnlyFlowEvidence, compareReadOnlyFlowEvidence } from '../crawler/source-read-data.mjs';
import { createOperationDependencyEvidence, compareOperationDependencyEvidence } from '../crawler/operation-dependency-parity.mjs';
import { loadSession } from '../session/store.mjs';
import { auditBundlePrivacy } from './privacy-audit.mjs';
import { sanitizeStaticHtml, isStaticCloneChooserHtml, staticCloneChooserHtml } from '../static-html-safety.mjs';
import { availableCloneVariantWidths } from '../clone-doc.mjs';
import { readSiteIdentity, assertSiteOrigin } from '../site-origin.mjs';
import { rewriteSnapshotMount } from './site-routing.mjs';
import { inspectRuntimeAdapter } from './adapter-runtime.mjs';

const CORE = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const { argOf, has } = makeArgs(argv);
const host = argv.find(a => !a.startsWith('--'));
if (!host) { console.error('usage: node src/live/export.mjs <host> [--out <deliverable-subdir>] [--offline] [--port 8080] [--rebuild] [--root landing|mirror] [--heal] [--materialize-har] [--strict] [--compare-source] [--include-readonly-data] [--include-api-har] [--include-adapter] [--allow-private-export]'); process.exit(2); }
if (!/^(?!\.\.?$)[a-z0-9.-]+$/i.test(host)) { console.error('[export] invalid host:', host); process.exit(2); }

const BASE = join(WORKSPACE, host);
if (!existsSync(BASE)) { console.error('no workspace for host:', host); process.exit(1); }
const identity = readSiteIdentity(WORKSPACE, host);
if (!identity) { console.error('[export] site origin is missing:', host); process.exit(2); }
const { origin } = identity;
const PORT = Number(argOf('port', 8080));
const OFFLINE = has('offline');
const ROOT = argOf('root', 'landing') === 'mirror' ? 'mirror' : 'landing';
const HEAL = has('heal');
const STRICT = has('strict');
const COMPARE_SOURCE = has('compare-source');
const INCLUDE_READONLY_DATA = has('include-readonly-data');
const MATERIALIZE = has('materialize-har');
const INCLUDE_API_HAR = has('include-api-har');
const INCLUDE_ADAPTER = has('include-adapter');
const ALLOW_PRIVATE_EXPORT = has('allow-private-export');
const dataPlan = INCLUDE_READONLY_DATA ? readDataPlan(BASE, origin) : { status: 'not-requested', urls: [] };
if (STRICT && !OFFLINE) {
  console.error('[export] --strict requires --offline so the validated bundle cannot proxy to the source site');
  process.exit(2);
}
if (COMPARE_SOURCE && !STRICT) {
  console.error('[export] --compare-source requires --offline --strict');
  process.exit(2);
}
if (INCLUDE_READONLY_DATA && !STRICT) {
  console.error('[export] --include-readonly-data requires --offline --strict');
  process.exit(2);
}
if (STRICT && INCLUDE_API_HAR) {
  console.error('[export] --include-api-har is too broad for strict offline export');
  process.exit(2);
}
if (INCLUDE_ADAPTER && (!OFFLINE || !STRICT)) {
  console.error('[export] --include-adapter requires --offline --strict');
  process.exit(2);
}
let adapterRoutes = new Set();
if (INCLUDE_ADAPTER) {
  try {
    const inspected = inspectRuntimeAdapter(BASE);
    const syntax = spawnSync(process.execPath, ['--check', inspected.moduleFile], {
      encoding: 'utf8', timeout: 10_000,
    });
    if (syntax.status !== 0) throw new Error('invalid adapter module syntax');
    adapterRoutes = inspected.routes;
  } catch {
    console.error('[export] invalid runtime adapter; expected only regular manifest.json and index.mjs with valid routes');
    process.exit(2);
  }
}
const SESSION_PRESENT = existsSync(join(BASE, 'session.json'));
if (SESSION_PRESENT && !ALLOW_PRIVATE_EXPORT) {
  console.error('[export] saved login session detected; use --allow-private-export only for a controlled private bundle');
  process.exit(2);
}
const OUT_ARG = argOf('out', '');
const FINAL_OUT = OUT_ARG
  ? resolve(process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), OUT_ARG)
  : join(DELIVERABLE, host + '-live-' + localDateStamp());
try { assertExportTarget(DELIVERABLE, FINAL_OUT); }
catch (e) { console.error('[export]', e.message); process.exit(2); }

// ---------- 1. 确保 live/ 已生成 ----------
if (has('rebuild') || !existsSync(join(BASE, 'live'))) {
  emit({ kind: 'live-stage', stage: 'build', status: 'running' });
  console.log('[export] building live pages (build_live)...');
  const r = spawnSync(process.execPath, [join('src', 'crawler', 'build_live.mjs'), host], { cwd: CORE, stdio: 'inherit' });
  if (r.status !== 0) { console.error('[export] build_live failed'); process.exit(1); }
  emit({ kind: 'live-stage', stage: 'build', status: 'done' });
}

// ---------- 2. 目录准备 ----------
mkdirSync(DELIVERABLE, { recursive: true });
const OUT = mkdtempSync(join(DELIVERABLE, `.candidate-${host}-`));
const siteDir = join(OUT, 'site');
// 候选包与旧包并存；差异始终与上一次已提交的包比较。
let prevChecksums = null;
try { prevChecksums = JSON.parse(readFileSync(join(FINAL_OUT, 'checksums.json'), 'utf8')); } catch { /* 首次导出 */ }
mkdirSync(siteDir, { recursive: true });

let files = 0, copied = 0, bytes = 0;
function copyTree(src, dst) {
  if (!existsSync(src)) return;
  const st = lstatSync(src);
  if (st.isSymbolicLink()) throw new Error('refusing to package workspace symlink: ' + src);
  if (st.isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    if (existsSync(dst)) return;
    const rel = relative(join(siteDir, 'static', host, 'pages'), dst).replaceAll('\\', '/');
    const cloneHtml = /^[^/]+\/clone\/.+\.html?$/i.test(rel);
    const sourceHtml = cloneHtml ? readFileSync(src, 'utf8') : null;
    const variants = cloneHtml && rel.endsWith('/clone/index.html') && isStaticCloneChooserHtml(sourceHtml)
      ? availableCloneVariantWidths(dirname(src)) : [];
    if (variants.length) {
      const trusted = staticCloneChooserHtml(variants);
      writeFileSync(dst, trusted);
      bytes += Buffer.byteLength(trusted);
    } else if (cloneHtml) {
      const clean = sanitizeStaticHtml(sourceHtml);
      writeFileSync(dst, clean);
      bytes += Buffer.byteLength(clean);
    } else if (src.startsWith(join(BASE, 'live') + '/') || src.startsWith(join(BASE, 'live') + '\\')) {
      if (/\.(?:html?|css|m?js)$/i.test(src)) {
        const text = rewriteSnapshotMount(readFileSync(src, 'utf8'), { siteId: host, origin, mount: '/lm/' + host });
        writeFileSync(dst, text);
        bytes += Buffer.byteLength(text);
      } else { copyFileSync(src, dst); bytes += st.size; }
    } else {
      copyFileSync(src, dst);
      bytes += st.size;
    }
    copied++;
    files++;
    return;
  }
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name));
}

// 2a) live 页面
copyTree(join(BASE, 'live'), join(siteDir, 'live'));
// 2b) 克隆页 / CSS / 资产（build_live 的 HTML 引用 /static/<host>/pages/<name>/clone/**）
// 这是导出里最重的一步（整站资产拷贝），进度必须按页报，否则用户只看到"约 2-5 分钟"。
const pagesDir = join(BASE, 'pages');
const pageNames = existsSync(pagesDir) ? readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'clone', 'index.html'))) : [];
emit({ kind: 'live-stage', stage: 'copy', status: 'running', total: pageNames.length });
for (let i = 0; i < pageNames.length; i++) {
  copyTree(join(pagesDir, pageNames[i], 'clone'), join(siteDir, 'static', host, 'pages', pageNames[i], 'clone'));
  emit({ kind: 'live-stage', stage: 'copy', index: i + 1, total: pageNames.length });
}
// 2c) 站点级报告（档案 / 对比 / 情报 / SEO）
// **白名单式拷贝，故意的**：`session.json`（登录态）与 `network.har` 的原始件都不在这份
// 清单里；recon/atlas.json 也含原始 URL、标题和失败原因，覆盖摘要另见 health.json。
for (const item of ['index.html', 'compare.html', 'intel', 'seo']) {
  if (existsSync(join(BASE, item))) copyTree(join(BASE, item), join(siteDir, 'static', host, item));
}
for (const name of pageNames) {
  for (const item of ['score.json', 'intel']) {
    if (existsSync(join(pagesDir, name, item))) copyTree(join(pagesDir, name, item), join(siteDir, 'static', host, 'pages', name, item));
  }
}
// Older compare reports embedded raw page metadata in a script. Rebuild that
// one data literal in the candidate bundle without changing workspace files.
const bundledCompare = join(siteDir, 'static', host, 'compare.html');
if (existsSync(bundledCompare)) {
  const original = readFileSync(bundledCompare, 'utf8');
  const start = original.indexOf('const PAGES = ');
  const end = start < 0 ? -1 : original.indexOf('\nconst PORT = ', start);
  if (end > start) {
    const comparePages = pageNames.map(name => {
      const pageDir = join(pagesDir, name);
      let score = {}, semantic = {}, manifest = {};
      try { score = JSON.parse(readFileSync(join(pageDir, 'score.json'), 'utf8')); } catch {}
      try { semantic = JSON.parse(readFileSync(join(pageDir, 'intel', 'semantic.json'), 'utf8')); } catch {}
      try { manifest = JSON.parse(readFileSync(join(pageDir, 'manifest.json'), 'utf8')); } catch {}
      return { name, path: semantic.pageType ?? '', target: manifest.target ?? '', score: score.total ?? 0 };
    }).sort((a, b) => b.score - a.score)
      .map(({ name, path, target }) => ({ name, path, target }));
    const data = JSON.stringify(comparePages)
      .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
    const compareHtml = (original.slice(0, start) + 'const PAGES = ' + data + ';' + original.slice(end))
      .replace(/document\.getElementById\('inter'\)\.href = [\s\S]*?;/,
        `document.getElementById('inter').href = '/lm/${host}' + t.pathname + t.search;`);
    writeFileSync(bundledCompare, compareHtml);
  } else {
    console.warn('[export] compare report has no known data marker; its inline script will be blocked by the delivery server');
  }
}
emit({ kind: 'live-stage', stage: 'copy', status: 'done', total: pageNames.length });

for (const name of pageNames) {
  assertSiteOrigin(BASE, origin, { pageName: name });
}
const queryPages = pageNames.flatMap(name => {
  try {
    const target = new URL(JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target);
    return target.origin === origin && target.search ? [target.pathname + target.search] : [];
  } catch { return []; }
});

// ---------- 3. HAR 清洗与合并（流式：仅同源 + 去重，避免多页 GB 级峰值） ----------
emit({ kind: 'live-stage', stage: 'har', status: 'running', total: pageNames.length });
const harMap = new Map();
const readOnlyKeys = new Set(dataPlan.urls.map(url => harKey('GET', url)));
let readOnlyDataConflicts = 0;
let harPages = 0;
const privacy = { excluded: { invalid: 0, privateUrl: 0, authenticated: 0, nonStatic: 0, privateBody: 0 }, examples: [], includeApiBodies: INCLUDE_API_HAR, sessionPresent: SESSION_PRESENT, privateExportApproved: ALLOW_PRIVATE_EXPORT };
for (let i = 0; i < pageNames.length; i++) {
  const name = pageNames[i];
  const p = join(pagesDir, name, 'network.har');
  if (!existsSync(p)) continue;
  harPages++;
  try {
    const rawHar = JSON.parse(readFileSync(p, 'utf8'));
    const rawReadOnlyCounts = new Map();
    for (const entry of rawHar?.log?.entries ?? []) {
      const key = harKey(entry?.request?.method, entry?.request?.url);
      if (readOnlyKeys.has(key)) rawReadOnlyCounts.set(key, (rawReadOnlyCounts.get(key) ?? 0) + 1);
    }
    const sanitized = sanitizeHar(rawHar, {
      includeApiBodies: INCLUDE_API_HAR,
      readOnlyOrigin: origin,
      readOnlyGetUrls: dataPlan.urls,
    });
    for (const entry of sanitized.entries) {
      if (entry.kind !== 'public-read-only-data') continue;
      const key = harKey(entry.method, entry.url);
      if (rawReadOnlyCounts.has(key)) rawReadOnlyCounts.set(key, rawReadOnlyCounts.get(key) - 1);
    }
    for (const remaining of rawReadOnlyCounts.values()) readOnlyDataConflicts += remaining;
    for (const [reason, count] of Object.entries(sanitized.privacy.excluded)) privacy.excluded[reason] += count;
    for (const sample of sanitized.privacy.examples) if (privacy.examples.length < 30) privacy.examples.push(sample);
    for (const e of sanitized.entries) {
      let x; try { x = new URL(e.url); } catch { continue; }
      // 站外**静态资源**也收：导出时会被本地化（判据见 heal.isStaticAsset）。
      // 以前这里只收站外图片（`!/^image\//`），于是把应用自己的 JS/字体/WebGL 驱动
      // 全丢在 CDN 上 —— 交付包断网时动效直接没了（实测 0.00% 像素变化）。
      // 站外的 XHR/JSON 仍然不收：它们离线时本质上无法伪造，收了也只是体积。
      if (x.origin !== origin && !isStaticAsset(e)) continue;
      const k = harKey(e.method, e.url);
      const prior = harMap.get(k);
      if (!prior) harMap.set(k, e);
      else if (readOnlyKeys.has(k) && (prior.kind !== e.kind || prior.status !== e.status
        || prior.mimeType !== e.mimeType || prior.body !== e.body)) readOnlyDataConflicts++;
    }
  } catch (e) { console.warn('[export] HAR parse failed:', name, String(e).slice(0, 80)); }
  emit({ kind: 'live-stage', stage: 'har', index: i + 1, total: pageNames.length });
}
const preflightRoutes = listLivePageRoutes(join(siteDir, 'live'), origin, queryPages);
const operationPlan = readOperationPlan(BASE, origin, preflightRoutes);
let earlySource = null;
let earlySourceError = null;
const currentSourceReadOnlyKeys = new Set();
const sourceFlowReadOnlyEvidence = new Map();
const sourceDependencyEvidence = createOperationDependencyEvidence(origin);
if (COMPARE_SOURCE && INCLUDE_READONLY_DATA && dataPlan.status === 'ok'
  && operationPlan.status === 'ok' && operationPlan.flows.length) {
  try {
    earlySource = await captureSourceOperations({
      origin, flows: operationPlan.flows, session: loadSession(host),
      readOnlyGetUrls: dataPlan.urls,
      onReadOnlyData: entry => {
        const key = harKey(entry.method, entry.url);
        const prior = harMap.get(key);
        if (prior && (prior.kind !== entry.kind || prior.status !== entry.status
          || prior.mimeType !== entry.mimeType || prior.body !== entry.body)) {
          readOnlyDataConflicts++;
          throw new Error('read-only response conflict');
        }
        if (!prior) harMap.set(key, entry);
        currentSourceReadOnlyKeys.add(key);
      },
      onReadOnlyObservation: (entry, flowIndex) => {
        addReadOnlyFlowEvidence(sourceFlowReadOnlyEvidence, flowIndex, entry);
      },
      onObservedRequest: (flowIndex, request) => sourceDependencyEvidence.observe(flowIndex, request),
    });
  } catch (error) { earlySourceError = error; }
}
const har = { version: 1, generatedAt: new Date().toISOString(), entries: [...harMap.values()] };
writeFileSync(join(OUT, 'har-privacy.json'), JSON.stringify(privacy, null, 2));
const stats = harStats(har.entries);
console.log('[export] HAR pages=' + harPages + ' entries=' + stats.entries + ' bytes~' + (stats.bytes / 1024 / 1024).toFixed(1) + 'MB (same-origin deduped)');
emit({ kind: 'live-stage', stage: 'har', status: 'done', entries: stats.entries, mb: +(stats.bytes / 1048576).toFixed(1) });

// ---------- 4. 服务器与配置 ----------
const liveSrc = fileURLToPath(new URL('.', import.meta.url));
copyFileSync(join(liveSrc, 'serve.mjs'), join(OUT, 'serve.mjs'));
copyFileSync(join(liveSrc, 'har.mjs'), join(OUT, 'har.mjs'));
copyFileSync(join(liveSrc, 'live-path.mjs'), join(OUT, 'live-path.mjs'));
if (INCLUDE_ADAPTER) {
  const source = join(BASE, 'runtime-adapter');
  const target = join(OUT, 'runtime-adapter');
  mkdirSync(target);
  copyFileSync(join(liveSrc, 'adapter-runtime.mjs'), join(OUT, 'adapter-runtime.mjs'));
  copyFileSync(join(source, 'manifest.json'), join(target, 'manifest.json'));
  copyFileSync(join(source, 'index.mjs'), join(target, 'index.mjs'));
  inspectRuntimeAdapter(OUT);
}

const siteId = host;
const config = { host: siteId, siteId, origin, port: PORT, offline: OFFLINE, replayApi: true, root: ROOT, bind: '0.0.0.0',
  ...(INCLUDE_ADAPTER ? { adapter: true } : {}) };
writeFileSync(join(OUT, 'heimdall-live.json'), JSON.stringify(config, null, 2));

// ---------- 4b. 离线体检（health.json）+ 可选自愈（--heal） ----------
const liveDir = join(siteDir, 'live');
const staticDir = join(siteDir, 'static');
const harIndex = indexHar(har.entries);
emit({ kind: 'live-stage', stage: 'health', status: 'running' });
let health = scanLiveBundle({ liveDir, host, origin, harIndex, staticDir, queryPages });
const assetsBefore = { ...health.assets };
let materialized = null;
const assetUrlMap = new Map();
if (MATERIALIZE) {
  emit({ kind: 'live-stage', stage: 'materialize', status: 'running' });
  const staticEntries = har.entries.filter(entry => entry.kind !== 'public-read-only-data');
  const mat = materializeHar({ liveDir, origin, entries: staticEntries });
  // hostPrefixes: 离线包把站外 CDN 的整站前缀也接进本地镜像树（运行时拼出来的地址抓不到，
  // 详见 heal.localizeQueryEntries 里那段注释）。在线镜像不接 —— 它的承诺是"未捕获的实时回源"。
  const loc = localizeQueryEntries({ entries: staticEntries, liveDir, host, origin, hostPrefixes: OFFLINE });
  const localPrefix = '/lm/' + host + '/_ext/';
  for (const entry of staticEntries) {
    if (entry.method !== 'GET' || entry.status !== 200 || !entry.body || !isStaticAsset(entry)) continue;
    let sourceUrl;
    try { sourceUrl = new URL(entry.url); } catch { continue; }
    if (sourceUrl.origin === origin) continue;
    const localPath = loc.map.get(entry.url);
    if (typeof localPath !== 'string' || !localPath.startsWith(localPrefix)) continue;
    const file = resolve(liveDir, localPath.slice(('/lm/' + host + '/').length));
    const fileRel = relative(liveDir, file);
    if (fileRel === '..' || fileRel.startsWith('../') || fileRel.startsWith('..\\') || isAbsolute(fileRel)) continue;
    try {
      const saved = statSync(file);
      if (saved.isFile() && saved.size > 0) assetUrlMap.set(entry.url, localPath);
    }
    catch { /* A missing candidate file cannot justify dependency parity. */ }
  }
  const rw = rewriteLocalRefs({ liveDir, map: loc.map });
  let trimmed = 0;
  for (const e of har.entries) {
    if (!e.body || e.kind === 'public-read-only-data') continue;
    let x; try { x = new URL(e.url); } catch { e.body = null; trimmed++; continue; }
    if (!x.search) { e.body = null; trimmed++; }   // 无查询条目已 materialize 落盘；带查询的保留回放体（覆盖 JS 动态请求）
  }
  console.log('[materialize] files=' + mat.written + ' (' + (mat.bytes / 1024 / 1024).toFixed(1) + 'MB) localized=' + loc.written + ' (' + (loc.bytes / 1024 / 1024).toFixed(1) + 'MB) rewrote=' + rw.files + ' files/' + rw.rewrites + ' refs');
  health = scanLiveBundle({ liveDir, host, origin, harIndex, staticDir, queryPages });
  materialized = { ...mat, localized: loc.written, localizedBytes: loc.bytes, refRewrites: rw.rewrites, refFiles: rw.files, harTrimmed: trimmed };
  emit({ kind: 'live-stage', stage: 'materialize', status: 'done' });
}
if (HEAL && health.assets.unresolved > 0) {
  console.log('[heal] unresolved=' + health.assets.unresolved + ' unique=' + health.unresolvedPaths.length + ' -> fetching from ' + origin);
  emit({ kind: 'live-stage', stage: 'heal', status: 'running', targets: health.unresolvedPaths.length });
  const result = await healReferencedAssets({ liveDir, host, origin, harIndex, staticDir, queryPages });
  health = result.health;
  health.healed = result.healed;
  console.log('[heal] fetched=' + result.healed.fetched + ' failed=' + result.healed.failed + ' skipped=' + result.healed.skipped + ' passes=' + result.healed.passes + ' bytes~' + (result.healed.bytes / 1024 / 1024).toFixed(1) + 'MB');
  emit({ kind: 'live-stage', stage: 'heal', status: 'done', fetched: result.healed.fetched, failed: result.healed.failed });
}
if (materialized) health.materialized = materialized;
writeFileSync(join(OUT, 'har.json'), JSON.stringify(har));   // 瘦身后的 HAR（materialize 时仅剩必要回放体）

health.assetsBefore = assetsBefore;
health.forgedPages = pageNames.length;
const missingLivePages = [];
for (const name of pageNames) {
  try {
    const target = new URL(JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target);
    if (target.origin !== origin || !existsSync(join(liveDir, liveSnapshotPath(target.pathname, target.search)))) missingLivePages.push(name);
  } catch { missingLivePages.push(name); }
}
health.liveMissing = missingLivePages.length;
health.missingLivePages = missingLivePages.slice(0, 100);
health.coverage = buildCoverageLedger({ baseDir: BASE, bundleDir: OUT, host, origin, pageNames });
const includedDataUrls = new Set(har.entries
  .filter(entry => entry.kind === 'public-read-only-data')
  .map(entry => entry.url));
const missingData = dataPlan.urls.filter(url => !includedDataUrls.has(url));
const shadowedData = dataPlan.urls.filter(value => {
  const url = new URL(value);
  return liveSnapshotCandidates(url.pathname, url.search).some(candidate => {
    try { return statSync(join(liveDir, candidate)).isFile(); } catch { return false; }
  });
});
health.readOnlyData = {
  status: dataPlan.status,
  declared: dataPlan.urls.length,
  included: includedDataUrls.size,
  missing: missingData.length,
  ...(shadowedData.length ? { shadowed: shadowedData.length } : {}),
  ...(readOnlyDataConflicts ? { conflicts: readOnlyDataConflicts } : {}),
  ...(earlySource?.readOnlyData ? { sourceCapture: earlySource.readOnlyData } : {}),
  ...(COMPARE_SOURCE && INCLUDE_READONLY_DATA ? {
    sourceCurrentAccepted: currentSourceReadOnlyKeys.size,
    sourceCurrentMissing: dataPlan.urls.filter(url => !currentSourceReadOnlyKeys.has(harKey('GET', url))).length,
    flowParity: { status: 'not-tested', checkedFlows: 0, mismatchedFlows: 0 },
  } : {}),
  ...(dataPlan.issue ? { issue: dataPlan.issue } : {}),
};
const finalOperationPlan = readOperationPlan(BASE, origin, health.pageRoutes);
const operationPlanChanged = JSON.stringify(operationPlan) !== JSON.stringify(finalOperationPlan)
  || JSON.stringify(preflightRoutes) !== JSON.stringify(health.pageRoutes);
health.operationPlan = {
  status: operationPlan.status, declaredFlows: operationPlan.flows.length,
  ...(operationPlan.issue ? { issue: operationPlan.issue } : {}),
};
health.operationProbe = {
  status: operationPlan.status === 'missing' ? 'not-configured' : 'not-run',
  planned: operationPlan.flows.length, checked: 0, failed: 0, untested: operationPlan.flows.length,
};
health.adapter = INCLUDE_ADAPTER
  ? { status: 'included', declaredRoutes: adapterRoutes.size, exercisedRoutes: 0,
    untestedRoutes: adapterRoutes.size, serverEgress: 'not-tested' }
  : { status: 'not-included', declaredRoutes: 0, exercisedRoutes: 0, untestedRoutes: 0 };
health.sourceOperationProbe = {
  status: COMPARE_SOURCE ? 'not-run' : 'not-requested',
  planned: operationPlan.flows.length, checked: 0, failed: 0, untested: operationPlan.flows.length,
};
health.dependencyParity = {
  status: COMPARE_SOURCE ? 'not-run' : 'not-requested', checkedFlows: 0, mismatchedFlows: 0,
};
health.strictBlockers = {
  unresolved: health.assets.unresolved,
  dynamic: health.assets.dynamic,
  externalAssets: health.assets.externalAssets,
  missingLinks: health.links.missing,
  missingLivePages: health.liveMissing,
  discoveredUncloned: health.coverage.missingClone,
  discoveredUndelivered: health.coverage.missingLive,
  coverageInvalid: health.coverage.sourceStatus === 'invalid' || health.coverage.unmappedClones ? 1 : 0,
  reconFailures: health.coverage.reconFailures,
  operationPlanInvalid: operationPlan.status === 'invalid' ? 1 : 0,
  operationPlanChanged: operationPlanChanged ? 1 : 0,
  emptyBundle: health.pages === 0 ? 1 : 0,
  scanTruncated: health.scanTruncated ? 1 : 0,
  runtimeMissing: 0,
  browserFailed: 0,
  browserUntested: 0,
  operationFailed: 0,
  operationUntested: 0,
  adapterRoutesUntested: 0,
  adapterRelocationFailed: 0,
  sourceOperationFailed: 0,
  sourceOperationUntested: 0,
  dependencyParityMismatch: 0,
  dependencyParityUntested: 0,
  readOnlyDataInvalid: INCLUDE_READONLY_DATA && dataPlan.status !== 'ok' ? 1 : 0,
  readOnlyDataMissing: missingData.length,
  readOnlyDataShadowed: shadowedData.length,
  readOnlyDataConflicts,
  sourceReadOnlyCurrentMissing: COMPARE_SOURCE && INCLUDE_READONLY_DATA
    ? health.readOnlyData.sourceCurrentMissing : 0,
  offlineReadOnlyRequestMissing: 0,
  offlineReadOnlyCaptureFailed: 0,
  readOnlyFlowMismatch: 0,
  readOnlyFlowUntested: 0,
  sourceReadOnlyCaptureFailed: earlySource
    ? (earlySource.readOnlyData?.rejected ?? 0) + (earlySource.readOnlyData?.oversized ?? 0)
      + (earlySource.readOnlyData?.failed ?? 0)
    : earlySourceError ? 1 : 0,
  privacyIssues: 0,
  privacyIncomplete: 0,
};
health.strict = STRICT;
let relocatedProbeRoot = null;
let probeBundleDir = OUT;
if (STRICT && INCLUDE_ADAPTER && !Object.values(health.strictBlockers).some(Boolean)) {
  try {
    relocatedProbeRoot = mkdtempSync(join(tmpdir(), 'heimdall-adapter-bundle-'));
    probeBundleDir = join(relocatedProbeRoot, 'bundle');
    cpSync(OUT, probeBundleDir, { recursive: true });
  } catch {
    health.strictBlockers.adapterRelocationFailed = 1;
  }
}
try {
if (STRICT) {
  health.browserProbe = {
    checked: 0, failed: 0, totalPages: health.pageRoutes.length,
    untested: health.pageRoutes.length, skipped: 'earlier strict blockers',
  };
  if (!Object.values(health.strictBlockers).some(Boolean)) {
    try {
      health.runtimeProbe = await probeOfflineBundle(probeBundleDir, health.probePaths);
      health.strictBlockers.runtimeMissing = health.runtimeProbe.failed;
    } catch (e) {
      health.runtimeProbe = { checked: 0, failed: 1, error: String(e?.message ?? e) };
      health.strictBlockers.runtimeMissing = 1;
    }
    if (!health.strictBlockers.runtimeMissing) {
      try {
        health.browserProbe = await probeOfflineBrowserBundle(probeBundleDir, health.pageRoutes);
        health.strictBlockers.browserFailed = health.browserProbe.failed;
      } catch (e) {
        health.browserProbe = {
          checked: 0, failed: 1, totalPages: health.pageRoutes.length,
          untested: health.pageRoutes.length, error: e?.name === 'Error' ? 'probe error' : 'browser unavailable',
        };
        health.strictBlockers.browserFailed = 1;
      }
    } else health.browserProbe.skipped = 'HTTP probe failed';
  }
  health.strictBlockers.browserUntested = health.browserProbe.untested;
  const offlineReadOnlyKeys = new Set();
  const offlineFlowReadOnlyEvidence = new Map();
  const exercisedAdapterRoutes = new Set();
  let offlineDependencyEvidence = null;
  let sourceCapture = earlySource;
  if (operationPlan.flows.length && !health.strictBlockers.browserFailed
    && !health.strictBlockers.browserUntested
    && !Object.entries(health.strictBlockers).some(([key, value]) =>
      key !== 'operationUntested' && key !== 'operationFailed' && !!value)) {
    try {
      health.operationProbe = await probeOfflineOperations(probeBundleDir, operationPlan.flows, {
        readOnlyGetUrls: COMPARE_SOURCE && INCLUDE_READONLY_DATA ? dataPlan.urls : [],
        onReadOnlyGet: url => offlineReadOnlyKeys.add(harKey('GET', url)),
        onReadOnlyObservation: (url, entry, flowIndex) => {
          addReadOnlyFlowEvidence(offlineFlowReadOnlyEvidence, flowIndex, entry, url);
        },
        onObservedRequest: (flowIndex, request, base) => {
          offlineDependencyEvidence ??= createOperationDependencyEvidence(base);
          offlineDependencyEvidence.observe(flowIndex, request);
          if (INCLUDE_ADAPTER) {
            try {
              const target = new URL(request.url);
              const key = request.method + ' ' + target.pathname;
              if (target.origin === base && adapterRoutes.has(key)) exercisedAdapterRoutes.add(key);
            } catch { /* An invalid request cannot prove adapter route coverage. */ }
          }
        },
      });
      health.strictBlockers.operationFailed = health.operationProbe.failed;
    } catch (error) {
      health.operationProbe = {
        status: 'probe-error', planned: operationPlan.flows.length, checked: 0,
        failed: 1, untested: operationPlan.flows.length,
        error: error?.name === 'Error' ? 'probe error' : 'browser unavailable',
      };
      health.strictBlockers.operationFailed = 1;
    }
  } else if (operationPlan.flows.length) health.operationProbe.status = 'skipped';
  health.strictBlockers.operationUntested = health.operationProbe.untested;
  if (INCLUDE_ADAPTER) {
    health.adapter.exercisedRoutes = exercisedAdapterRoutes.size;
    health.adapter.untestedRoutes = adapterRoutes.size - exercisedAdapterRoutes.size;
    health.strictBlockers.adapterRoutesUntested = health.adapter.untestedRoutes;
  }
  if (COMPARE_SOURCE && INCLUDE_READONLY_DATA) {
    health.readOnlyData.offlineRequested = offlineReadOnlyKeys.size;
    health.readOnlyData.offlineMissing = dataPlan.urls.filter(url => !offlineReadOnlyKeys.has(harKey('GET', url))).length;
    health.readOnlyData.offlineStatus = health.operationProbe.status === 'checked' ? 'checked' : 'not-tested';
    health.strictBlockers.offlineReadOnlyRequestMissing = health.readOnlyData.offlineMissing;
    if (health.operationProbe.readOnlyData) {
      health.readOnlyData.offlineCapture = health.operationProbe.readOnlyData;
      health.strictBlockers.offlineReadOnlyCaptureFailed =
        health.operationProbe.readOnlyData.rejected + health.operationProbe.readOnlyData.oversized
        + health.operationProbe.readOnlyData.failed;
    }
  }
  if (COMPARE_SOURCE) {
    if (operationPlan.status !== 'ok' || !operationPlan.flows.length) {
      health.sourceOperationProbe.status = 'not-configured';
      health.strictBlockers.sourceOperationUntested = 1;
    } else {
      try {
        if (earlySourceError) throw earlySourceError;
        const source = earlySource ?? await captureSourceOperations({
          origin, flows: operationPlan.flows, session: loadSession(host),
          onObservedRequest: (flowIndex, request) => sourceDependencyEvidence.observe(flowIndex, request),
        });
        sourceCapture = source;
        health.sourceOperationProbe = {
          status: source.status, planned: source.planned, checked: source.checked,
          failed: source.failed, untested: source.untested, sessionUsed: source.sessionUsed,
          ...(source.readOnlyData ? { readOnlyData: source.readOnlyData } : {}),
          flows: source.flows.map(flow => ({
            index: flow.index, passed: flow.passed,
            plannedActions: flow.plannedActions, executedActions: flow.executedActions,
            sourceDependencies: flow.dependencies.length,
            sourceDynamicData: flow.dependencies.filter(item => item.category === 'dynamic-data').length,
            bundleDependencies: health.operationProbe.flows?.[flow.index]?.dependencies?.length ?? null,
            bundleDynamicData: health.operationProbe.flows?.[flow.index]?.categories?.['dynamic-data'] ?? null,
            assertions: flow.assertions,
            issueKinds: [...new Set(flow.issues.map(issue => issue.kind))],
            omittedIssues: flow.omittedIssues,
          })),
        };
        health.strictBlockers.sourceOperationFailed = source.failed;
        health.strictBlockers.sourceOperationUntested = source.untested;
      } catch (error) {
        health.sourceOperationProbe = {
          status: 'capture-error', planned: operationPlan.flows.length,
          checked: 0, failed: 1, untested: operationPlan.flows.length,
          errorType: ['Error', 'TimeoutError', 'TypeError'].includes(error?.name) ? error.name : 'Error',
        };
        health.strictBlockers.sourceOperationFailed = 1;
        health.strictBlockers.sourceOperationUntested = operationPlan.flows.length;
      }
    }
  }
  if (COMPARE_SOURCE) {
    const comparable = sourceCapture?.status === 'checked' && sourceCapture.failed === 0
      && sourceCapture.untested === 0 && health.operationProbe.status === 'checked'
      && health.operationProbe.failed === 0 && health.operationProbe.untested === 0
      && offlineDependencyEvidence;
    if (comparable) {
      health.dependencyParity = compareOperationDependencyEvidence(
        sourceDependencyEvidence, offlineDependencyEvidence, operationPlan.flows.length,
        { assetUrlMap },
      );
      health.strictBlockers.dependencyParityMismatch = health.dependencyParity.mismatchedFlows;
    } else {
      health.dependencyParity.status = 'not-tested';
      health.strictBlockers.dependencyParityUntested = operationPlan.flows.length || 1;
    }
  }
  if (COMPARE_SOURCE && INCLUDE_READONLY_DATA) {
    const comparable = earlySource?.status === 'checked' && earlySource.failed === 0
      && earlySource.untested === 0 && health.operationProbe.status === 'checked'
      && health.operationProbe.failed === 0 && health.operationProbe.untested === 0
      && health.operationProbe.readOnlyData;
    if (comparable) {
      health.readOnlyData.flowParity = compareReadOnlyFlowEvidence(
        sourceFlowReadOnlyEvidence, offlineFlowReadOnlyEvidence, operationPlan.flows.length,
      );
      health.strictBlockers.readOnlyFlowMismatch = health.readOnlyData.flowParity.mismatchedFlows;
    } else health.strictBlockers.readOnlyFlowUntested = operationPlan.flows.length || 1;
  }
}
} finally {
  if (relocatedProbeRoot) rmSync(relocatedProbeRoot, { recursive: true, force: true });
}
// 健康报告只需路径定位问题，查询参数可能含临时凭据。
health.unresolvedPaths = health.unresolvedPaths.map(path => path.split('?')[0]);
for (const detail of health.details) detail.unresolved = detail.unresolved.map(path => path.split('?')[0]);
delete health.probePaths;
delete health.pageRoutes;
writeFileSync(join(OUT, 'health.json'), JSON.stringify(health, null, 2));
emit({ kind: 'live-stage', stage: 'health', status: 'done', livePages: health.pages, unresolved: health.assets.unresolved });
console.log('[health] forgedPages=' + pageNames.length + ' livePages=' + health.pages + (health.liveMissing ? ' (missing ' + health.liveMissing + ')' : '') + ' assets=' + health.assets.total + ' local=' + health.assets.local + ' har=' + health.assets.har + ' unresolved=' + health.assets.unresolved + ' externalRefs=' + health.assets.external + '(静态资源 ' + health.assets.externalAssets + ') | linksMissing=' + health.links.missing);
console.log('[coverage] scope=' + health.coverage.scope + ' denominator=' + (health.coverage.denominator ?? 'unknown') + ' cloned=' + health.coverage.cloned + ' delivered=' + health.coverage.delivered + ' missingClone=' + health.coverage.missingClone + ' missingLive=' + health.coverage.missingLive);
for (const d of health.details.slice(0, 5)) console.log('[health]   ' + d.page + ' -> ' + d.unresolvedCount + ' unresolved (e.g. ' + (d.unresolved[0] ?? '-') + ')');

const hasArchive = existsSync(join(siteDir, 'static', host, 'index.html'));
const hasCompare = existsSync(join(siteDir, 'static', host, 'compare.html'));
const hasSeo = existsSync(join(siteDir, 'static', host, 'seo', 'seo.html'));
const landing = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall Live · ${host}</title>
<style>
body{margin:0;background:#0b0b10;color:#e2e8f0;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
.wrap{max-width:760px;padding:48px 32px}.brand{color:#22d3ee;letter-spacing:.28em;font-size:12px;font-weight:700}
h1{margin:10px 0 6px;font-size:30px}.meta{color:#94a3b8;font-size:13px;margin-bottom:26px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}
a.card{display:block;padding:16px;border:1px solid rgba(34,211,238,.25);border-radius:8px;background:linear-gradient(180deg,rgba(30,30,35,.9),rgba(20,20,26,.95));color:inherit;text-decoration:none}
a.card:hover{border-color:rgba(34,211,238,.6)}a.card b{display:block;color:#22d3ee;margin-bottom:6px}a.card span{color:#94a3b8;font-size:12px}
.note{margin-top:24px;color:#64748b;font-size:12px;line-height:1.8;border-top:1px dashed rgba(34,211,238,.25);padding-top:14px}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · LIVE MIRROR</div>
<h1>${host}</h1>
<div class="meta">${OFFLINE ? '离线模式（仅本地快照 + HAR 回放）' : '在线模式（本地优先 · 未捕获资源回源）'} · HAR ${stats.entries} 条 · 离线门禁 ${STRICT ? '详见 health.json' : '未运行'} · 端口 ${PORT}</div>
<div class="grid">
<a class="card" href="/lm/${host}/"><b>打开交互镜像</b><span>本地快照优先 · ${OFFLINE ? '未捕获请求返回 404' : '未捕获请求回源'} · 支持 HAR 回放</span></a>
${hasArchive ? `<a class="card" href="/static/${host}/index.html"><b>克隆档案</b><span>逐页还原度与卡片墙</span></a>` : ''}
${hasCompare ? `<a class="card" href="/static/${host}/compare.html"><b>同步滚动对比</b><span>原站快照 vs 镜像</span></a>` : ''}
${hasSeo ? `<a class="card" href="/static/${host}/seo/seo.html"><b>SEO 审计报告</b><span>六分类评分与逐页问题</span></a>` : ''}
</div>
<div class="note">本产物仅供内部分析使用，请勿公开部署或商用。启动方式：<code>node serve.mjs --port ${PORT}</code> 或 <code>docker compose up -d</code>。<br/>drop-in 部署（镜像直接占据站点根路径）：export 时加 <code>--root mirror</code>，或部署后 <code>node serve.mjs --root mirror</code>。<br/>健康检查：<code>/__heimdall/health</code></div>
</div></body></html>`;
writeFileSync(join(OUT, 'landing.html'), landing);

writeFileSync(join(OUT, 'Dockerfile'), `FROM node:22-alpine\nWORKDIR /app\nCOPY . /app\n${INCLUDE_ADAPTER ? 'RUN mkdir -p /data\nENV HEIMDALL_RUNTIME_DATA_DIR=/data\nVOLUME ["/data"]\n' : ''}EXPOSE ${PORT}\nCMD ["node","serve.mjs","--port","${PORT}"]\n`);
writeFileSync(join(OUT, 'docker-compose.yml'), `services:\n  heimdall-live:\n    build: .\n    ports:\n      - "${PORT}:${PORT}"\n${INCLUDE_ADAPTER ? '    volumes:\n      - heimdall-runtime-data:/data\n' : ''}    restart: unless-stopped\n${INCLUDE_ADAPTER ? 'volumes:\n  heimdall-runtime-data:\n' : ''}`);
writeFileSync(join(OUT, 'README.md'), `# Heimdall Live Mirror · ${host}

可直接部署的交互镜像包（L3）：本地快照优先 → HAR 回放${OFFLINE ? ' → 未命中返回 404' : ' → 未命中回源'}。

## 运行

\`\`\`bash
${INCLUDE_ADAPTER ? 'mkdir -p ../heimdall-runtime-data\nexport HEIMDALL_RUNTIME_DATA_DIR="$(cd ../heimdall-runtime-data && pwd)"\n' : ''}node serve.mjs --port ${PORT}                 # 落地页 + /lm/${host}/ 镜像（默认）
node serve.mjs --port ${PORT} --root mirror   # drop-in：镜像直接挂到 /
node serve.mjs --port ${PORT} --host 127.0.0.1  # 只监听本机（默认监听所有网卡，为了容器/内网部署）
docker compose up -d                   # Docker 部署
\`\`\`

${INCLUDE_ADAPTER ? '适配器仅处理 manifest.json 中精确声明的路由；未捕获请求在离线模式下返回 404。Node 运行时须把 HEIMDALL_RUNTIME_DATA_DIR 指向包外目录。Docker Compose 用 heimdall-runtime-data 命名卷保存状态，容器重建后继续使用；单独 docker run 时须挂载持久卷到 /data。适配器是可信的逐站 Node 代码，并非沙箱；--compare-source 不证明写入业务与源站等价。严格探针未隔离适配器进程的网络，health.adapter.serverEgress=not-tested；逐站交付前仍须把实际候选包放入无外联容器，重跑已声明的操作并核对业务状态。\n\n' : ''}- **监听地址默认 0.0.0.0**（所有网卡）—— 交付包是拿去部署的，绑回环外面就访问不到。
  只在本机预览请加 \`--host 127.0.0.1\`。引擎本身默认绑回环，两者不同是有意的

- 镜像入口：http://127.0.0.1:${PORT}/lm/${host}/
- 落地页：http://127.0.0.1:${PORT}/（root=mirror 时根路径直接是镜像）
- 部署模式：root: ${ROOT}（mirror = drop-in 根路径部署；/lm/${host}/ 始终作为别名可用）
- **选哪种**：被镜像的站如果是**纯前端渲染**（Vue/React/VitePress/Docusaurus 等，
  路由读 location.pathname），部署时用 \`--root mirror\`。前缀入口 \`/lm/${host}/\`
  会被它自己的路由当成真实路径，页面会渲染成该站自己的 404。静态站/多页站两种都行。
- 健康检查：http://127.0.0.1:${PORT}/__heimdall/health
- 模式：\`offline: ${OFFLINE}\`（\`heimdall-live.json\`）+ HAR ${stats.entries} 条回放\n- 离线体检：health.json（资源 local/har/unresolved、未镜像链接、站外资产清单${HEAL ? '；本次已执行 --heal 自愈' : ''}）

### 离线时会缺什么（读 health.json）

\`\`\`
assets.unresolved        同源但没抓到本地副本 → 离线 404
assets.dynamic           动态资源端点未覆盖 → 离线 404
assets.externalAssets    站外静态资源（图片/CSS/脚本）→ 离线也裂，需本地化才能进离线包
assets.external          站外引用总数（含 YouTube 嵌入、地图、统计脚本）
                         external − externalAssets 的差额 = 嵌入类内容，**无法本地化，属固有边界**
links.missing            指向未镜像页面的站内链接 → 点了会跳出镜像
strictBlockers           离线验收的分项阻断计数（含缺页、扫描截断、HTTP 和浏览器首次加载探测）
coverage                 侦察 URL → 克隆页 → 交付包 live 路由的覆盖台账；缺口路径经脱敏，可按 sourceIndex 回查本机按 URL 排序的侦察图谱
browserProbe             逐页断外网首次加载结果；只观察短时间窗口，不证明点击、表单或登录可用
operationPlan            操作脚本声明数；missing 表示没有交互验收，脚本本身不进入交付包
operationProbe           逐条在断网浏览器中执行的操作、动态依赖与断言；未声明的流程不在验收范围
sourceOperationProbe     显式 --compare-source 时，源站同流程只读采集与脱敏对照；未运行不代表源站通过
dependencyParity         显式 --compare-source 时，按操作流程核对脚本、样式、媒体、文档和 API 的精确请求、状态与 MIME；仅报告类别和数量，不写入私有 URL。它不比较静态资源内容，也不证明业务等价
readOnlyData             显式许可的 GET 数据声明数、纳入数、缺口和冲突；源站操作采集需同时使用 --compare-source
privacyAudit             凭据特征扫描结果；incomplete 或 issues 都阻断严格发布
${INCLUDE_ADAPTER ? 'adapter                  声明路由数、操作探针实际触达路由数与未测路由数；未测路由阻断发布；serverEgress=not-tested 表示服务端外联尚未验证\n' : ''}
\`\`\`

在线部署时，站外引用是否可加载还取决于第三方服务、跨域规则和访问权限。
如果要声称已发现的页面可离线浏览，请使用 \`--offline --strict\` 并确认 \`health.json\` 的全部门禁为零。\`coverage.scope=captured-only\` 表示没有侦察数据，只能证明已捕获页；侦察触达页数上限时也不能据此声称覆盖整站。只有提供 \`workspace/<host>/operation-plan.json\` 并通过 \`operationProbe\` 的流程才算做过离线交互验收；未声明流程与独立登录服务仍未验证。

## 路由

| 路由 | 行为 |
|---|---|
| \`/lm/${host}/**\` | 本地 live 快照 → HAR 回放 → 原站代理（离线时 404） |
| \`/static/${host}/**\` | 克隆页 / CSS / 资产 / 档案 / SEO 报告 |
| \`/__heimdall/health\` | 健康检查 |

## 换成自己的站

这份包里有一份 \`edit-manifest.md\`：它列清了"换域名 / 换图片 / 换文案"各要动哪些文件
（同名 \`.json\` 是机器可读版）。多数改动集中在 \`site/static/${host}/pages/*/clone/\` 下。
换域名建议用 Heimdall 控制台的「改站起点」做（预览不改文件、替换前逐文件备份）。

## 说明

- 资产与克隆页按独立副本复制，构建通过后才替换目标目录；上一个版本保留为 \`.backup-*\`。
- HAR 默认只保留静态资源；API/HTML 正文不进入分发包。排除统计见 \`har-privacy.json\`。
- 原始 \`recon/atlas.json\` 不进入分发包；已发现页面的覆盖摘要见 \`health.json\`。
- 如确需公开只读 GET 数据回放，先在工作区配置 \`read-data-plan.json\`，再用 \`--include-readonly-data --offline --strict\` 精确许可；同时加 \`--compare-source\` 与已审核的操作计划，可受控采集点击后出现的响应。冲突、缺失与被拒响应会阻断发布，数据分发范围仍需人工审核。
- 宽泛的 \`--include-api-har\` 不允许与 \`--strict\` 同用，也不能让 POST 等写入型业务离线运行。
- 保存过登录会话的站点默认拒绝导出；受控环境里须显式加 \`--allow-private-export\`，且原始 \`session.json\` 仍不会复制进包。
- 未捕获的第三方接口在在线模式下回源；离线模式下会明确 404。
- 仅供内部分析，禁止公开部署或商用。
`);

// ---------- 5. 校验和清单 + 与上一次导出的差异 ----------
// prevChecksums 指向上一次已提交的包。
emit({ kind: 'live-stage', stage: 'package', status: 'running' });

// ---------- 4c. 改站起点清单（换域名 / 图片 / 文案的第一入口） ----------
// 放在校验和之前算，这两份文件才会被一起纳入 manifest 与 changes.json。
try {
  const manifest = buildEditManifest(host);
  writeFileSync(join(OUT, 'edit-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(OUT, 'edit-manifest.md'), renderEditManifestMd(manifest));
  console.log(`[edit-manifest] assets=${manifest.counts.assets} remoteVisual=${manifest.counts.remoteVisual} domainFiles=${manifest.counts.domainFiles}`);
} catch (e) { console.warn('[edit-manifest] skipped:', String(e).slice(0, 120)); }
let manifestFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    // 两个文件自身不入清单：它们是**关于这份清单**的元数据，
    // 算了会让每次重导都报"changes.json 变了"这种无意义的噪声
    else if (st.isFile() && !p.endsWith('checksums.json') && !p.endsWith('changes.json')) manifestFiles.push({ p: p.slice(OUT.length + 1).split('\\').join('/'), s: st.size, h: createHash('sha256').update(readFileSync(p)).digest('hex') });
  }
};
const packageMetadata = () => {
  manifestFiles = [];
  walk(OUT);
  writeFileSync(join(OUT, 'checksums.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), files: manifestFiles }));
  const changes = diffChecksums(prevChecksums, manifestFiles);
  writeFileSync(join(OUT, 'changes.json'), JSON.stringify(changes, null, 2));
  return changes;
};
packageMetadata();
health.privacyAudit = auditBundlePrivacy({ bundleDir: OUT });
health.strictBlockers.privacyIssues = health.privacyAudit.issueCount;
health.strictBlockers.privacyIncomplete = health.privacyAudit.status === 'incomplete' ? health.privacyAudit.failureCount : 0;
writeFileSync(join(OUT, 'health.json'), JSON.stringify(health, null, 2));
const changes = packageMetadata();
console.log(`[export] ${changesLine(changes)}`);
emit({ kind: 'live-stage', stage: 'package', status: 'done', files: manifestFiles.length, bytes });
console.log(`[export] pages=${pageNames.length} liveFiles=${files} (copied=${copied}) bytes=${mb(bytes)} | bundleFiles=${manifestFiles.length} | root=${ROOT} | unresolved=${health.assets.unresolved}`);
if (STRICT && Object.values(health.strictBlockers).some(Boolean)) {
  console.error('[export] strict: offline gaps ' + JSON.stringify(health.strictBlockers) + ' (see health.json); prior bundle preserved, candidate=' + OUT);
  process.exitCode = 1;
} else {
  const committed = promoteCandidate(DELIVERABLE, FINAL_OUT, OUT);
  console.log(`[export] bundle -> ${committed.out}`);
  if (committed.backup) console.log(`[export] previous bundle retained -> ${committed.backup}`);
}
if (!process.exitCode) console.log(`[export] run: cd "${FINAL_OUT}" && node serve.mjs --port ${PORT}${OFFLINE ? ' --offline' : ''}`);
if (ROOT === 'mirror') console.log(`[export] root=mirror：部署后 / 即镜像（drop-in），/lm/${host}/ 为别名`);
