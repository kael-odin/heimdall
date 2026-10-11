#!/usr/bin/env node
/**
 * live/export — 生成"可直接部署"的交互镜像包（L3）
 *
 * 用法:
 *   node src/live/export.mjs <host> [--out <dir>] [--offline] [--port 8080] [--rebuild] [--root landing|mirror] [--heal] [--materialize-har] [--strict]
 *
 * 产物（默认 DATA_ROOT/deliverable/<host>-live-<date>/）:
 *   serve.mjs / har.mjs        零依赖 Node 服务器
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
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, linkSync, rmSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, DELIVERABLE, localDateStamp } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { buildEditManifest, renderEditManifestMd } from '../deliver/edit-manifest.mjs';
import { sanitizeHar, harStats, indexHar, harKey } from './har.mjs';
import { scanLiveBundle } from './health.mjs';
import { healBundle, materializeHar, localizeQueryEntries, rewriteHtmlRefs } from './heal.mjs';
import { diffChecksums, changesLine } from './changes.mjs';
import { mb } from '../fsutil.mjs';

const CORE = fileURLToPath(new URL('../..', import.meta.url));
const argv = process.argv.slice(2);
const host = argv.find(a => !a.startsWith('--'));
const argOf = (name, def) => {
  const i = argv.indexOf('--' + name);
  if (i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find(a => a.startsWith('--' + name + '='));
  return eq ? eq.split('=').slice(1).join('=') : def;
};
const has = (n) => argv.includes('--' + n);
if (!host) { console.error('usage: node src/live/export.mjs <host> [--out <dir>] [--offline] [--port 8080] [--rebuild] [--root landing|mirror] [--heal] [--materialize-har] [--strict]'); process.exit(2); }

const BASE = join(WORKSPACE, host);
if (!existsSync(BASE)) { console.error('no workspace for host:', host); process.exit(1); }
const PORT = Number(argOf('port', 8080));
const OFFLINE = has('offline');
const ROOT = argOf('root', 'landing') === 'mirror' ? 'mirror' : 'landing';
const HEAL = has('heal');
const STRICT = has('strict');
const MATERIALIZE = has('materialize-har');
const OUT_ARG = argOf('out', '');
const OUT = OUT_ARG
  ? resolve(process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), OUT_ARG)
  : join(DELIVERABLE, host + '-live-' + localDateStamp());

// ---------- 1. 确保 live/ 已生成 ----------
if (has('rebuild') || !existsSync(join(BASE, 'live'))) {
  emit({ kind: 'live-stage', stage: 'build', status: 'running' });
  console.log('[export] building live pages (build_live)...');
  const r = spawnSync(process.execPath, [join('src', 'crawler', 'build_live.mjs'), host], { cwd: CORE, stdio: 'inherit' });
  if (r.status !== 0) { console.error('[export] build_live failed'); process.exit(1); }
  emit({ kind: 'live-stage', stage: 'build', status: 'done' });
}

// ---------- 2. 目录准备 ----------
const siteDir = join(OUT, 'site');
// 上一次导出的校验和**必须在这里读**：下面 rmSync 会把整个目录清掉，
// 而同一天重复导出落的又是同一个目录 —— 清完再读就只能和自己比（表现为永远"首次导出"）。
let prevChecksums = null;
try { prevChecksums = JSON.parse(readFileSync(join(OUT, 'checksums.json'), 'utf8')); } catch { /* 首次导出 */ }
if (existsSync(OUT)) {
  const resolved = OUT.toLowerCase();
  if (!resolved.startsWith(DELIVERABLE.toLowerCase())) { console.error('[export] refusing to clean outside deliverable:', OUT); process.exit(1); }
  rmSync(OUT, { recursive: true, force: true });
}
mkdirSync(siteDir, { recursive: true });

let files = 0, linked = 0, copied = 0, bytes = 0;
function copyTree(src, dst) {
  if (!existsSync(src)) return;
  const st = statSync(src);
  if (st.isFile()) {
    mkdirSync(dirname(dst), { recursive: true });
    if (existsSync(dst)) return;
    try { linkSync(src, dst); linked++; } catch { copyFileSync(src, dst); copied++; }
    files++; bytes += st.size;
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
// 清单里 —— 交付包是要交给别人的，绝不能夹带本机的登录凭据。
for (const item of ['index.html', 'compare.html', 'intel', 'recon', 'seo']) {
  if (existsSync(join(BASE, item))) copyTree(join(BASE, item), join(siteDir, 'static', host, item));
}
for (const name of pageNames) {
  for (const item of ['score.json', 'intel']) {
    if (existsSync(join(pagesDir, name, item))) copyTree(join(pagesDir, name, item), join(siteDir, 'static', host, 'pages', name, item));
  }
}
emit({ kind: 'live-stage', stage: 'copy', status: 'done', total: pageNames.length });

let origin = 'https://' + host.replace(/^www\./, '');
for (const name of pageNames) {
  try { const t = JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target; if (t) { origin = new URL(t).origin; break; } } catch {}
}

// ---------- 3. HAR 清洗与合并（流式：仅同源 + 去重，避免多页 GB 级峰值） ----------
emit({ kind: 'live-stage', stage: 'har', status: 'running', total: pageNames.length });
const harMap = new Map();
let harPages = 0;
for (let i = 0; i < pageNames.length; i++) {
  const name = pageNames[i];
  const p = join(pagesDir, name, 'network.har');
  if (!existsSync(p)) continue;
  harPages++;
  try {
    const sanitized = sanitizeHar(JSON.parse(readFileSync(p, 'utf8')));
    for (const e of sanitized.entries) {
      let x; try { x = new URL(e.url); } catch { continue; }
      if (x.origin !== origin && !/^image\//i.test(e.mimeType || '')) continue;   // 站外图片也收：导出时本地化
      const k = harKey(e.method, e.url);
      if (!harMap.has(k)) harMap.set(k, e);
    }
  } catch (e) { console.warn('[export] HAR parse failed:', name, String(e).slice(0, 80)); }
  emit({ kind: 'live-stage', stage: 'har', index: i + 1, total: pageNames.length });
}
const har = { version: 1, generatedAt: new Date().toISOString(), entries: [...harMap.values()] };
const stats = harStats(har.entries);
console.log('[export] HAR pages=' + harPages + ' entries=' + stats.entries + ' bytes~' + (stats.bytes / 1024 / 1024).toFixed(1) + 'MB (same-origin deduped)');
emit({ kind: 'live-stage', stage: 'har', status: 'done', entries: stats.entries, mb: +(stats.bytes / 1048576).toFixed(1) });

// ---------- 4. 服务器与配置 ----------
const liveSrc = fileURLToPath(new URL('.', import.meta.url));
copyFileSync(join(liveSrc, 'serve.mjs'), join(OUT, 'serve.mjs'));
copyFileSync(join(liveSrc, 'har.mjs'), join(OUT, 'har.mjs'));

const config = { host, origin, port: PORT, offline: OFFLINE, replayApi: true, root: ROOT };
writeFileSync(join(OUT, 'heimdall-live.json'), JSON.stringify(config, null, 2));

// ---------- 4b. 离线体检（health.json）+ 可选自愈（--heal） ----------
const liveDir = join(siteDir, 'live');
const staticDir = join(siteDir, 'static');
const harIndex = indexHar(har.entries);
emit({ kind: 'live-stage', stage: 'health', status: 'running' });
let health = scanLiveBundle({ liveDir, host, origin, harIndex, staticDir });
const assetsBefore = { ...health.assets };
if (HEAL && health.assets.unresolved > 0) {
  const targets = health.unresolvedPaths ?? [...new Set(health.details.flatMap(d => d.unresolved))];
  console.log('[heal] unresolved=' + health.assets.unresolved + ' unique=' + targets.length + ' -> fetching from ' + origin);
  emit({ kind: 'live-stage', stage: 'heal', status: 'running', targets: targets.length });
  const healed = await healBundle({ liveDir, host, origin, targets });
  console.log('[heal] fetched=' + healed.fetched + ' failed=' + healed.failed + ' skipped=' + healed.skipped + ' bytes~' + (healed.bytes / 1024 / 1024).toFixed(1) + 'MB');
  emit({ kind: 'live-stage', stage: 'heal', status: 'done', fetched: healed.fetched, failed: healed.failed });
  health = scanLiveBundle({ liveDir, host, origin, harIndex, staticDir });
  health.healed = { attempted: targets.length, fetched: healed.fetched, failed: healed.failed, skipped: healed.skipped, bytes: healed.bytes };
}
if (MATERIALIZE) {
  emit({ kind: 'live-stage', stage: 'materialize', status: 'running' });
  const mat = materializeHar({ liveDir, origin, entries: har.entries });
  const loc = localizeQueryEntries({ entries: har.entries, liveDir, host, origin });
  const rw = rewriteHtmlRefs({ liveDir, map: loc.map });
  let trimmed = 0;
  for (const e of har.entries) {
    if (!e.body) continue;
    let x; try { x = new URL(e.url); } catch { e.body = null; trimmed++; continue; }
    if (!x.search) { e.body = null; trimmed++; }   // 无查询条目已 materialize 落盘；带查询的保留回放体（覆盖 JS 动态请求）
  }
  console.log('[materialize] files=' + mat.written + ' (' + (mat.bytes / 1024 / 1024).toFixed(1) + 'MB) localized=' + loc.written + ' (' + (loc.bytes / 1024 / 1024).toFixed(1) + 'MB) html=' + rw.files + ' files/' + rw.rewrites + ' refs');
  health = scanLiveBundle({ liveDir, host, origin, harIndex, staticDir });
  health.materialized = { ...mat, localized: loc.written, localizedBytes: loc.bytes, htmlRewrites: rw.rewrites, htmlFiles: rw.files, harTrimmed: trimmed };
  emit({ kind: 'live-stage', stage: 'materialize', status: 'done' });
}
writeFileSync(join(OUT, 'har.json'), JSON.stringify(har));   // 瘦身后的 HAR（materialize 时仅剩必要回放体）

health.assetsBefore = assetsBefore;
health.forgedPages = pageNames.length;
health.liveMissing = Math.max(0, pageNames.length - health.pages);
health.strict = STRICT;
writeFileSync(join(OUT, 'health.json'), JSON.stringify(health, null, 2));
emit({ kind: 'live-stage', stage: 'health', status: 'done', livePages: health.pages, unresolved: health.assets.unresolved });
console.log('[health] forgedPages=' + pageNames.length + ' livePages=' + health.pages + (health.liveMissing ? ' (missing ' + health.liveMissing + ')' : '') + ' assets=' + health.assets.total + ' local=' + health.assets.local + ' har=' + health.assets.har + ' unresolved=' + health.assets.unresolved + ' externalRefs=' + health.assets.external + '(静态资源 ' + health.assets.externalAssets + ') | linksMissing=' + health.links.missing);
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
<div class="meta">${OFFLINE ? '离线模式（仅本地快照 + HAR 回放）' : '在线模式（本地优先 · 未捕获资源回源）'} · HAR ${stats.entries} 条 · 离线资源 ${health.assets.unresolved === 0 ? '全量可用' : health.assets.unresolved + ' 条未覆盖'} · 端口 ${PORT}</div>
<div class="grid">
<a class="card" href="/lm/${host}/"><b>打开交互镜像</b><span>本地快照优先 · 未锻造页回源原站 · 支持 HAR 回放</span></a>
${hasArchive ? `<a class="card" href="/static/${host}/index.html"><b>克隆档案</b><span>逐页还原度与卡片墙</span></a>` : ''}
${hasCompare ? `<a class="card" href="/static/${host}/compare.html"><b>同步滚动对比</b><span>原站快照 vs 镜像</span></a>` : ''}
${hasSeo ? `<a class="card" href="/static/${host}/seo/seo.html"><b>SEO 审计报告</b><span>六分类评分与逐页问题</span></a>` : ''}
</div>
<div class="note">本产物仅供内部分析使用，请勿公开部署或商用。启动方式：<code>node serve.mjs --port ${PORT}</code> 或 <code>docker compose up -d</code>。<br/>drop-in 部署（镜像直接占据站点根路径）：export 时加 <code>--root mirror</code>，或部署后 <code>node serve.mjs --root mirror</code>。<br/>健康检查：<code>/__heimdall/health</code></div>
</div></body></html>`;
writeFileSync(join(OUT, 'landing.html'), landing);

writeFileSync(join(OUT, 'Dockerfile'), `FROM node:22-alpine\nWORKDIR /app\nCOPY . /app\nEXPOSE ${PORT}\nCMD ["node","serve.mjs","--port","${PORT}"]\n`);
writeFileSync(join(OUT, 'docker-compose.yml'), `services:\n  heimdall-live:\n    build: .\n    ports:\n      - "${PORT}:${PORT}"\n    restart: unless-stopped\n`);
writeFileSync(join(OUT, 'README.md'), `# Heimdall Live Mirror · ${host}

可直接部署的交互镜像包（L3）：本地快照优先 → HAR 回放 → 原站代理。

## 运行

\`\`\`bash
node serve.mjs --port ${PORT}                 # 落地页 + /lm/${host}/ 镜像（默认）
node serve.mjs --port ${PORT} --root mirror   # drop-in：镜像直接挂到 /
docker compose up -d                   # Docker 部署
\`\`\`

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
assets.unresolved        同源但没抓到本地副本 → 离线 404。**这是真正需要处理的缺口**
assets.externalAssets    站外静态资源（图片/CSS/脚本）→ 离线也裂，需本地化才能进离线包
assets.external          站外引用总数（含 YouTube 嵌入、地图、统计脚本）
                         external − externalAssets 的差额 = 嵌入类内容，**无法本地化，属固有边界**
links.missing            指向未镜像页面的站内链接 → 点了会跳出镜像
\`\`\`

**放在任何公网服务器上时，站外引用都能正常加载** —— 只有完全离线才需要考虑它们。
如果你要的是"断网也能跑"的包，优先处理 \`assets.unresolved\`，
再看 \`externalAssets\` 里有没有值得本地化的（字体、图标这类小文件通常值得）。

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

- 资产与克隆页在打包时优先使用硬链接（同卷）；把整个目录复制走即为独立副本。
- HAR 已清洗（不含 cookie/authorization/set-cookie），仅用于资源与 API 回放。
- 未捕获的第三方接口在在线模式下回源；离线模式下会明确 404。
- 仅供内部分析，禁止公开部署或商用。
`);

// ---------- 5. 校验和清单 + 与上一次导出的差异 ----------
// prevChecksums 在"目录准备"那一步就已经读好了（那里会把旧目录清掉）
emit({ kind: 'live-stage', stage: 'package', status: 'running' });

// ---------- 4c. 改站起点清单（换域名 / 图片 / 文案的第一入口） ----------
// 放在校验和之前算，这两份文件才会被一起纳入 manifest 与 changes.json。
try {
  const manifest = buildEditManifest(host);
  writeFileSync(join(OUT, 'edit-manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(OUT, 'edit-manifest.md'), renderEditManifestMd(manifest));
  console.log(`[edit-manifest] assets=${manifest.counts.assets} remoteVisual=${manifest.counts.remoteVisual} domainFiles=${manifest.counts.domainFiles}`);
} catch (e) { console.warn('[edit-manifest] skipped:', String(e).slice(0, 120)); }
const manifestFiles = [];
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
walk(OUT);
writeFileSync(join(OUT, 'checksums.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), files: manifestFiles }, null, 0));
const changes = diffChecksums(prevChecksums, manifestFiles);
writeFileSync(join(OUT, 'changes.json'), JSON.stringify(changes, null, 2));
console.log(`[export] ${changesLine(changes)}`);
console.log(`[export] bundle -> ${OUT}`);
emit({ kind: 'live-stage', stage: 'package', status: 'done', files: manifestFiles.length, bytes });
console.log(`[export] pages=${pageNames.length} liveFiles=${files} (linked=${linked} copied=${copied}) bytes=${mb(bytes)} | bundleFiles=${manifestFiles.length} | root=${ROOT} | unresolved=${health.assets.unresolved}`);
if (STRICT && health.assets.unresolved > 0) {
  console.error('[export] strict: ' + health.assets.unresolved + ' unresolved assets in offline mode (see health.json)');
  process.exitCode = 1;
}
console.log(`[export] run: cd "${OUT}" && node serve.mjs --port ${PORT}${OFFLINE ? ' --offline' : ''}`);
if (ROOT === 'mirror') console.log(`[export] root=mirror：部署后 / 即镜像（drop-in），/lm/${host}/ 为别名`);
