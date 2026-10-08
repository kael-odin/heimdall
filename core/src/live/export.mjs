#!/usr/bin/env node
/**
 * live/export — 生成"可直接部署"的活镜像包（L3）
 *
 * 用法:
 *   node src/live/export.mjs <host> [--out <dir>] [--offline] [--port 8080] [--rebuild]
 *
 * 产物（默认 DATA_ROOT/deliverable/<host>-live-<date>/）:
 *   serve.mjs / har.mjs        零依赖 Node 服务器
 *   heimdall-live.json         配置（host/origin/port/offline/replayApi）
 *   har.json                   清洗后的 HAR（本地资源与 API 回放）
 *   site/live/**               build_live 的活镜像页面
 *   site/static/<host>/**      克隆页 / CSS / 资产 / 档案 / 对比
 *   landing.html               落地页（镜像/档案/报告入口）
 *   Dockerfile / docker-compose.yml / README.md / checksums.json
 *
 * 部署:
 *   node serve.mjs --port 8080
 *   docker compose up -d
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync, linkSync, rmSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, DELIVERABLE } from '../paths.mjs';
import { sanitizeHar, mergeHar, harStats } from './har.mjs';

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
if (!host) { console.error('usage: node src/live/export.mjs <host> [--out <dir>] [--offline] [--port 8080] [--rebuild]'); process.exit(2); }

const BASE = join(WORKSPACE, host);
if (!existsSync(BASE)) { console.error('no workspace for host:', host); process.exit(1); }
const PORT = Number(argOf('port', 8080));
const OFFLINE = has('offline');
const OUT = argOf('out', join(DELIVERABLE, host + '-live-' + new Date().toISOString().slice(0, 10)));

// ---------- 1. 确保 live/ 已生成 ----------
if (has('rebuild') || !existsSync(join(BASE, 'live'))) {
  console.log('[export] building live pages (build_live)...');
  const r = spawnSync(process.execPath, [join('src', 'crawler', 'build_live.mjs'), host], { cwd: CORE, stdio: 'inherit' });
  if (r.status !== 0) { console.error('[export] build_live failed'); process.exit(1); }
}

// ---------- 2. 目录准备 ----------
const siteDir = join(OUT, 'site');
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
const pagesDir = join(BASE, 'pages');
const pageNames = existsSync(pagesDir) ? readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'clone', 'index.html'))) : [];
for (const name of pageNames) {
  copyTree(join(pagesDir, name, 'clone'), join(siteDir, 'static', host, 'pages', name, 'clone'));
}
// 2c) 站点级报告（档案 / 对比 / 情报 / SEO）
for (const item of ['index.html', 'compare.html', 'intel', 'recon', 'seo']) {
  if (existsSync(join(BASE, item))) copyTree(join(BASE, item), join(siteDir, 'static', host, item));
}
for (const name of pageNames) {
  for (const item of ['score.json', 'intel']) {
    if (existsSync(join(pagesDir, name, item))) copyTree(join(pagesDir, name, item), join(siteDir, 'static', host, 'pages', name, item));
  }
}

// ---------- 3. HAR 清洗与合并 ----------
const hars = [];
for (const name of pageNames) {
  const p = join(pagesDir, name, 'network.har');
  if (!existsSync(p)) continue;
  try { hars.push(sanitizeHar(JSON.parse(readFileSync(p, 'utf8')))); } catch (e) { console.warn('[export] HAR parse failed:', name, String(e).slice(0, 80)); }
}
const har = mergeHar(hars);
writeFileSync(join(OUT, 'har.json'), JSON.stringify(har));
const stats = harStats(har.entries);
console.log(`[export] HAR pages=${hars.length} entries=${stats.entries} bytes~${(stats.bytes / 1024 / 1024).toFixed(1)}MB`);

// ---------- 4. 服务器与配置 ----------
const liveSrc = fileURLToPath(new URL('.', import.meta.url));
copyFileSync(join(liveSrc, 'serve.mjs'), join(OUT, 'serve.mjs'));
copyFileSync(join(liveSrc, 'har.mjs'), join(OUT, 'har.mjs'));

let origin = 'https://' + host.replace(/^www\./, '');
for (const name of pageNames) {
  try { const t = JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target; if (t) { origin = new URL(t).origin; break; } } catch {}
}
const config = { host, origin, port: PORT, offline: OFFLINE, replayApi: true };
writeFileSync(join(OUT, 'heimdall-live.json'), JSON.stringify(config, null, 2));

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
<div class="meta">${OFFLINE ? '离线模式（仅本地快照 + HAR 回放）' : '在线模式（本地优先 · 未捕获资源回源）'} · HAR ${stats.entries} 条 · 端口 ${PORT}</div>
<div class="grid">
<a class="card" href="/lm/${host}/"><b>打开活镜像</b><span>本地快照优先 · 未锻造页回源原站 · 支持 HAR 回放</span></a>
${hasArchive ? `<a class="card" href="/static/${host}/index.html"><b>克隆档案</b><span>逐页还原度与卡片墙</span></a>` : ''}
${hasCompare ? `<a class="card" href="/static/${host}/compare.html"><b>同步滚动对比</b><span>原站快照 vs 镜像</span></a>` : ''}
${hasSeo ? `<a class="card" href="/static/${host}/seo/seo.html"><b>SEO 审计报告</b><span>六分类评分与逐页问题</span></a>` : ''}
</div>
<div class="note">本产物仅供内部分析使用，请勿公开部署或商用。启动方式：<code>node serve.mjs --port ${PORT}</code> 或 <code>docker compose up -d</code>。<br/>健康检查：<code>/__heimdall/health</code></div>
</div></body></html>`;
writeFileSync(join(OUT, 'landing.html'), landing);

writeFileSync(join(OUT, 'Dockerfile'), `FROM node:22-alpine\nWORKDIR /app\nCOPY . /app\nEXPOSE ${PORT}\nCMD ["node","serve.mjs","--port","${PORT}"]\n`);
writeFileSync(join(OUT, 'docker-compose.yml'), `services:\n  heimdall-live:\n    build: .\n    ports:\n      - "${PORT}:${PORT}"\n    restart: unless-stopped\n`);
writeFileSync(join(OUT, 'README.md'), `# Heimdall Live Mirror · ${host}

可直接部署的活镜像包（L3）：本地快照优先 → HAR 回放 → 原站代理。

## 运行

\`\`\`bash
node serve.mjs --port ${PORT}          # 或：node serve.mjs --port ${PORT} --offline
docker compose up -d                   # Docker 部署
\`\`\`

- 镜像入口：http://127.0.0.1:${PORT}/lm/${host}/
- 落地页：http://127.0.0.1:${PORT}/
- 健康检查：http://127.0.0.1:${PORT}/__heimdall/health
- 模式：\`offline: ${OFFLINE}\`（\`heimdall-live.json\`）+ HAR ${stats.entries} 条回放

## 路由

| 路由 | 行为 |
|---|---|
| \`/lm/${host}/**\` | 本地 live 快照 → HAR 回放 → 原站代理（离线时 404） |
| \`/static/${host}/**\` | 克隆页 / CSS / 资产 / 档案 / SEO 报告 |
| \`/__heimdall/health\` | 健康检查 |

## 说明

- 资产与克隆页在打包时优先使用硬链接（同卷）；把整个目录复制走即为独立副本。
- HAR 已清洗（不含 cookie/authorization/set-cookie），仅用于资源与 API 回放。
- 未捕获的第三方接口在在线模式下回源；离线模式下会明确 404。
- 仅供内部分析，禁止公开部署或商用。
`);

// ---------- 5. 校验和清单 ----------
const manifestFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (st.isFile() && !p.endsWith('checksums.json')) manifestFiles.push({ p: p.slice(OUT.length + 1).split('\\').join('/'), s: st.size, h: createHash('sha256').update(readFileSync(p)).digest('hex') });
  }
};
walk(OUT);
writeFileSync(join(OUT, 'checksums.json'), JSON.stringify({ host, generatedAt: new Date().toISOString(), files: manifestFiles }, null, 0));

const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
console.log(`[export] bundle -> ${OUT}`);
console.log(`[export] pages=${pageNames.length} liveFiles=${files} (linked=${linked} copied=${copied}) bytes=${mb(bytes)} | bundleFiles=${manifestFiles.length}`);
console.log(`[export] run: cd "${OUT}" && node serve.mjs --port ${PORT}${OFFLINE ? ' --offline' : ''}`);
