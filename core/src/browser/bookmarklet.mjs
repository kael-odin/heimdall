#!/usr/bin/env node
/**
 * browser/bookmarklet — 浏览器一键入口（书签小工具）
 *
 * 在任意页面点击书签即可把当前 URL 送入 Heimdall（侦察/克隆/审计/监控）。
 * 说明：跨域提交使用 no-cors + text/plain（简单请求，不触发预检）；
 *       因此无法读取返回的 taskId——任务请到控制台「任务」页查看。
 *       token 通过 ?token= 传递（引擎已支持 query token）。
 *
 * 用法:
 *   node src/browser/bookmarklet.mjs [--api http://127.0.0.1:8900] [--token xxx]
 *
 * 产物：workspace/_browser/heimdall-bookmarklet.html（拖拽安装页）
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT } from '../paths.mjs';
import { makeArgs } from '../args.mjs';
import { esc } from '../html.mjs';

export const MODES = {
  recon: { path: '/api/recon', label: 'Heimdall 侦察', body: (url) => ({ url, maxPages: 40 }) },
  forge: { path: '/api/forge', label: 'Heimdall 克隆此页', body: (url) => ({ url }) },
  audit: { path: '/api/audit', label: 'Heimdall SEO 审计', body: (url) => ({ url, maxPages: 30 }) },
  watch: { path: '/api/watch', label: 'Heimdall 变更监控', body: (url) => ({ url, maxPages: 20 }) },
};

export function buildBookmarklet(mode = 'recon', { api = 'http://127.0.0.1:8900', token = '' } = {}) {
  const def = MODES[mode] ?? MODES.recon;
  const url = api.replace(/\/$/, '') + def.path + (token ? '?token=' + encodeURIComponent(token) : '');
  // location.href 以占位符注入，避免在 Node 侧求值
  const bodyExpr = JSON.stringify(def.body('__HM_URL__')).replace('"__HM_URL__"', 'location.href');
  const js = '(async()=>{try{await fetch(' + JSON.stringify(url) + ',{method:\'POST\',mode:\'no-cors\',headers:{\'Content-Type\':\'text/plain\'},body:JSON.stringify(' + bodyExpr + ')});alert(' + JSON.stringify(def.label + '：已提交 ') + ' + location.host + \'（在 Heimdall 控制台「任务」查看）\');}catch(e){alert(\'Heimdall 连接失败：\' + e.message);}})();';
  return 'javascript:' + encodeURIComponent(js);
}

export function renderInstallPage({ api, token } = {}) {
  const links = Object.entries(MODES).map(([mode, def]) => `<a class="bm" href="${esc(buildBookmarklet(mode, { api, token }))}" onclick="return false" draggable="true"><b>${esc(def.label)}</b><span>拖到书签栏</span></a>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Heimdall 书签入口</title>
<style>
body{margin:0;background:#0b0b10;color:#e2e8f0;font-family:'Segoe UI','Noto Sans SC',system-ui,sans-serif;line-height:1.6}
.wrap{max-width:820px;margin:0 auto;padding:44px 28px 90px}.brand{color:#22d3ee;letter-spacing:.28em;font-size:12px;font-weight:700}
h1{margin:8px 0 6px;font-size:28px}.meta{color:#94a3b8;font-size:13px;margin-bottom:26px}
.bms{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:20px 0 30px}
a.bm{display:block;padding:14px 16px;border:1px solid rgba(34,211,238,.35);border-radius:8px;background:linear-gradient(180deg,rgba(30,30,35,.9),rgba(20,20,26,.95));color:#22d3ee;text-decoration:none;cursor:grab}
a.bm span{display:block;color:#64748b;font-size:12px;margin-top:4px}
ol{color:#cbd5e1;font-size:14px}code{background:rgba(34,211,238,.1);color:#67e8f9;padding:1px 6px;border-radius:4px}
.note{margin-top:26px;color:#64748b;font-size:12.5px;border-top:1px dashed rgba(34,211,238,.25);padding-top:16px}
</style></head><body><div class="wrap">
<div class="brand">HEIMDALL · BROWSER ENTRY</div><h1>浏览器一键入口</h1>
<div class="meta">引擎地址：${esc(api)} ${token ? '· 已内嵌 Token' : '· 未设置 Token'} · 仅供内部分析</div>
<div class="bms">${links}</div>
<ol>
<li>把上面对应按钮拖到浏览器书签栏（或右键复制链接地址后新建书签）。</li>
<li>打开任意目标页面，点书签即可把当前 URL 送入 Heimdall。</li>
<li>到控制台「任务」页查看进度与结果（跨域提交无法回显 taskId）。</li>
</ol>
<div class="note">引擎需在 <code>${esc(api)}</code> 可访问；内网共享时请把 Token 一起生成（<code>--token</code>）。跨域提交使用简单请求（no-cors），不会触发浏览器预检。</div>
</div></body></html>`;
}

const isMain = !!process.argv[1] && process.argv[1].endsWith('bookmarklet.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
const { argOf } = makeArgs(argv);
  const api = argOf('api', process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900');
  const token = argOf('token', process.env.HEIMDALL_TOKEN ?? '');
  const outDir = join(DATA_ROOT, 'workspace', '_browser');
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, 'heimdall-bookmarklet.html');
  writeFileSync(file, renderInstallPage({ api, token }));
  console.log('[bookmarklet] install page ->', file);
  for (const mode of Object.keys(MODES)) console.log('  ' + mode + ':', buildBookmarklet(mode, { api, token }).slice(0, 90) + '...');
}
