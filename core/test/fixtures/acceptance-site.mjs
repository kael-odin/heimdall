#!/usr/bin/env node
/** Local, deterministic truth fixtures. No real account, service or business data. */
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTANCE_FIXTURE_CASES = Object.freeze([
  { id: 'visual-shift', title: '目标主要内容布局偏移', targetBug: true, viewport: 'desktop', expectedVerdict: 'bug' },
  { id: 'mobile-menu', title: '移动端菜单按钮缺失', targetBug: true, viewport: 'mobile', expectedVerdict: 'bug' },
  { id: 'menu-state', title: '菜单展开但 aria-expanded 未更新', targetBug: true, viewport: 'mobile', expectedVerdict: 'bug' },
  { id: 'missing-field', title: '套餐配额文字字段缺失', targetBug: true, viewport: 'desktop', expectedVerdict: 'bug' },
  { id: 'wrong-link', title: '查看详情跳向错误页面', targetBug: true, viewport: 'desktop', expectedVerdict: 'bug' },
  { id: 'runtime-error', title: '目标脚本抛出异常', targetBug: true, viewport: 'desktop', expectedVerdict: 'bug' },
  { id: 'missing-resource', title: '目标静态资源返回 404', targetBug: true, viewport: 'desktop', expectedVerdict: 'bug' },
  { id: 'identical', title: '稳定一致页面', targetBug: false, viewport: 'desktop', expectedVerdict: 'match', expectedGate: 'passed' },
  { id: 'baseline-error', title: '基线与目标共有基线脚本异常', targetBug: false, viewport: 'desktop', expectedVerdict: 'baseline_failed', expectedGate: 'not_passed' },
  { id: 'masked-noise', title: '动态刷新区按已声明规则遮罩', targetBug: false, viewport: 'desktop', expectedVerdict: 'match', expectedGate: 'passed' },
  { id: 'blocked-write', title: '依赖写请求的流程被只读策略阻断', targetBug: false, viewport: 'desktop', expectedVerdict: 'environment', expectedGate: 'not_passed' },
]);

const caseIds = new Set(ACCEPTANCE_FIXTURE_CASES.map(item => item.id));
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const CSS = `
*{box-sizing:border-box}body{margin:0;background:#f3f5fa;color:#17223a;font:16px/1.5 Arial,sans-serif}
header{height:72px;padding:0 28px;display:flex;align-items:center;justify-content:space-between;background:#17223a;color:#fff}
.brand{font-size:20px;font-weight:700;letter-spacing:1px}button,a{font:inherit}button{border:0;border-radius:6px;padding:10px 16px;background:#dbeafe;color:#17223a;cursor:pointer}
main{max-width:1000px;margin:36px auto;padding:0 24px}h1{font-size:34px;line-height:1.2;margin:0 0 12px}.subtitle{color:#576379;margin:0 0 26px}
.panel{border:1px solid #d3dbea;border-radius:12px;background:#fff;padding:28px;min-height:260px;box-shadow:0 4px 20px #17223a0a}
.badge{display:inline-block;background:#e6f7f0;color:#116b49;padding:4px 10px;border-radius:20px;font-size:13px}.metric{font-size:36px;font-weight:bold;margin:20px 0 4px}
.quota{margin:0 0 24px;color:#576379}.cta{color:#244bb5;text-decoration:underline}.menu{background:#fff;border:1px solid #c9d3e4;padding:20px;margin:16px 0}.menu[hidden]{display:none}
.noise{width:100%;height:100px;margin-top:18px;padding:20px;background:#eef2ff;color:#334da0;font-size:24px;font-variant-numeric:tabular-nums}
footer{margin-top:28px;color:#576379;font-size:13px}@media(max-width:600px){header{padding:0 18px}main{margin:24px auto;padding:0 16px}h1{font-size:27px}.panel{padding:20px}}
`;

function htmlFor(side, caseId) {
  const target = side === 'target';
  const shifted = target && caseId === 'visual-shift';
  const menuMissing = target && caseId === 'mobile-menu';
  const fieldMissing = target && caseId === 'missing-field';
  const link = target && caseId === 'wrong-link' ? 'pricing' : 'details';
  const scriptError = (target && caseId === 'runtime-error') || caseId === 'baseline-error';
  const noise = caseId === 'masked-noise';
  const extraCss = `${shifted ? 'main{transform:translateY(160px)}.panel{background:#8f2500;border-color:#6d1b00;color:#fff}' : ''}${menuMissing ? '@media(max-width:600px){#menu-toggle{display:none}}' : ''}`;
  const menuScript = `document.getElementById('menu-toggle').addEventListener('click',function(){const menu=document.getElementById('menu');menu.hidden=!menu.hidden;${target && caseId === 'menu-state' ? '' : "this.setAttribute('aria-expanded',String(!menu.hidden));"}});`;
  const errorScript = scriptError ? "setTimeout(()=>{throw new Error('fixture: approved runtime script failed')},20);" : '';
  const noiseScript = noise ? `let tick=${target ? 3000 : 1000};setInterval(()=>{const el=document.getElementById('dynamic-noise');el.textContent='同步批次 '+String(++tick);el.style.backgroundColor='hsl('+(tick%360)+',70%,85%)'},40);` : '';
  const blockedScript = caseId === 'blocked-write' ? "fetch('write-endpoint',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{});" : '';
  const missingResource = target && caseId === 'missing-resource' ? '<script src="missing-widget.js"></script>' : '';
  const detail = caseId === 'details' ? '详情页已打开' : caseId === 'pricing' ? '价格页已打开' : '团队项目概览';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Heimdall 验收演示</title><style>${CSS}${extraCss}</style></head><body>
<header><span class="brand">NORTHSTAR</span><button id="menu-toggle" type="button" aria-label="菜单" aria-expanded="false" aria-controls="menu">菜单</button></header>
<main><h1>${escapeHtml(detail)}</h1><p class="subtitle">面向团队的开发交付状态</p><nav id="menu" class="menu" hidden><a href="details">项目详情</a> · <a href="pricing">套餐价格</a></nav>
<section class="panel"><span class="badge">运行正常</span><div class="metric">128</div>${fieldMissing ? '' : '<p id="quota" class="quota">剩余配额：128 个任务</p>'}<a id="details-link" class="cta" href="${link}">查看详情</a>${noise ? '<div id="dynamic-noise" class="noise">正在同步</div>' : ''}</section>
<footer>固定离线夹具 · 不包含真实客户数据</footer></main>${missingResource}<script>${menuScript}${errorScript}${noiseScript}${blockedScript}</script></body></html>`;
}

/** Start one loopback server with separate baseline and target entry paths. */
export async function startAcceptanceFixture({ port = 0 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const [, side, caseId = 'identical'] = url.pathname.split('/');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ fixture: 'acceptance', status: 'ok', cases: ACCEPTANCE_FIXTURE_CASES.length }));
      return;
    }
    if (!['baseline', 'target'].includes(side)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('fixture route not found'); return;
    }
    if (caseId === 'write-endpoint') {
      res.writeHead(req.method === 'POST' ? 200 : 405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ fixtureOnly: true, accepted: req.method === 'POST' })); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
    }
    if (!caseIds.has(caseId) && !['details', 'pricing'].includes(caseId)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('intentionally missing fixture resource'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : htmlFor(side, caseId));
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', ready);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return { baselineUrl: `${origin}/baseline`, targetUrl: `${origin}/target`,
    close: () => new Promise((ready, reject) => {
      if (closed) { ready(); return; }
      closed = true;
      server.close(error => error ? reject(error) : ready());
      server.closeAllConnections();
    }) };
}

// node --test discovers .mjs files below test/. Only start a persistent server
// when the caller explicitly supplies a port; imports and discovery stay inert.
if (process.argv[1] && process.argv[2] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawPort = process.argv[2] ?? '0';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const fixture = await startAcceptanceFixture({ port });
  console.log(JSON.stringify({ baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl, cases: ACCEPTANCE_FIXTURE_CASES }, null, 2));
  const shutdown = async () => { await fixture.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
