/** Deterministic local pages for a manually operated acceptance demonstration.
 * These pages supply inputs only. They never import or produce detector results. */
import { createServer } from 'node:http';

export const ACCEPTANCE_DEMO_PATHS = Object.freeze(['/reference', '/bug', '/partial', '/fixed']);
const paths = new Set(ACCEPTANCE_DEMO_PATHS);
const CSS = `
*{box-sizing:border-box}body{margin:0;background:#f3f5f8;color:#1c293a;font:16px/1.5 Arial,"Microsoft YaHei",sans-serif}
button,a{font:inherit}header{height:76px;padding:0 32px;display:flex;align-items:center;justify-content:space-between;background:#17263c;color:white}
.brand{font-size:18px;font-weight:700;letter-spacing:2px}.brand span{color:#a6c8ff}button{border:1px solid #647894;border-radius:8px;padding:9px 18px;background:#233a59;color:white;cursor:pointer}
button:focus-visible,a:focus-visible{outline:3px solid #5089ef;outline-offset:4px}main{max-width:1040px;margin:44px auto;padding:0 28px}
.eyebrow{margin:0 0 8px;color:#536887;font-size:12px;font-weight:bold;letter-spacing:2px}h1{margin:0;font-size:36px;line-height:1.25;letter-spacing:-1px}
.subtitle{margin:12px 0 30px;color:#637187}nav{margin:0 0 24px;padding:16px 20px;border:1px solid #cbdaf0;border-radius:10px;background:#e7effc}nav[hidden]{display:none}a{color:#234e94;text-decoration:underline;text-underline-offset:3px}
.panel{padding:30px;border:1px solid #d2dbe7;border-radius:14px;background:white;box-shadow:0 8px 24px #17263c08}
.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:16px}h2{margin:0;font-size:20px}.badge{padding:4px 10px;border-radius:20px;background:#e6f3ee;color:#24624d;font-size:12px;white-space:nowrap}
.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:30px 0}.metric{border-right:1px solid #e0e6ef;padding-right:16px}.metric:last-child{border:0}.metric strong{display:block;margin-top:5px;font-size:34px;line-height:1.2}.metric span{color:#637187;font-size:13px}
.activity{border-top:1px solid #e0e6ef;padding-top:22px;display:flex;align-items:flex-end;gap:12px}.bars{height:84px;display:flex;align-items:flex-end;gap:7px;width:170px;flex-shrink:0}.bars i{display:block;width:26px;border-radius:4px 4px 0 0;background:#527bb7}.bars i:nth-child(1){height:38%}.bars i:nth-child(2){height:57%}.bars i:nth-child(3){height:48%}.bars i:nth-child(4){height:76%}.bars i:nth-child(5){height:100%}.activity p{margin:0;color:#637187;font-size:13px}.activity strong{display:block;color:#1c293a;font-size:16px;margin-bottom:5px}
footer{margin-top:28px;color:#6f7b8e;font-size:12px}@media(max-width:600px){header{height:68px;padding:0 18px}.brand{font-size:15px}main{margin:30px auto;padding:0 18px}h1{font-size:28px}.panel{padding:22px}.panel-heading{align-items:flex-start;gap:10px}.metrics{gap:12px;margin:26px 0}.metric{padding-right:8px}.metric strong{font-size:26px}.metric span{font-size:12px}.activity{flex-wrap:wrap;gap:16px}.bars{width:100%;height:74px}.bars i{width:30px}footer{line-height:1.8}}
`;
const HEALTHY_MENU = 'const menu=document.querySelector("#menu");menu.hidden=!menu.hidden;this.setAttribute("aria-expanded",String(!menu.hidden));';

export function acceptanceDemoHtml(path) {
  if (!paths.has(path)) throw new TypeError('Unknown acceptance demo page.');
  const visualBug = path === '/bug';
  const behaviorBug = path === '/bug' || path === '/partial';
  const extra = visualBug ? 'main{transform:translateY(100px)}.panel{background:#942f23;border-color:#78261d;color:white}.panel .metric span,.panel .activity p,.panel .activity strong{color:white}' : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>Northstar · 团队交付概览</title><style>${CSS}${extra}</style></head><body>
<header><div class="brand">NORTH<span>STAR</span></div><button id="menu-toggle" type="button" aria-label="菜单" aria-expanded="false" aria-controls="menu">菜单</button></header>
<main><p class="eyebrow">TEAM WORKSPACE</p><h1>团队交付概览</h1><p class="subtitle">让每一次交付，都有清晰可查的进展。</p>
<nav id="menu" aria-label="项目导航" hidden><a href="#delivery">交付状态</a> · <a href="#activity">任务趋势</a></nav>
<section id="delivery" class="panel"><div class="panel-heading"><h2>本周项目状态</h2><span class="badge">运行正常</span></div>
<div class="metrics"><div class="metric"><span>剩余任务配额</span><strong>128</strong></div><div class="metric"><span>已完成交付</span><strong>24</strong></div><div class="metric"><span>服务可用性</span><strong>99.8%</strong></div></div>
<div id="activity" class="activity"><div class="bars" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div><p><strong>团队正在稳步推进</strong>本周任务执行进展，已同步至项目空间。</p></div></section>
<footer>本地固定示例 · 不包含真实客户数据 · 菜单操作仅改变当前页面</footer></main>
<script>document.querySelector("#menu-toggle").addEventListener("click",function(){${behaviorBug ? 'return;' : HEALTHY_MENU}});</script></body></html>`;
}

/** Pure request projection. A query, encoded alias, trailing slash or another
 * method cannot create extra fixture routes or a business write endpoint. */
export function acceptanceDemoResponse(method, requestTarget) {
  const known = typeof requestTarget === 'string' && paths.has(requestTarget);
  const allowed = method === 'GET' || method === 'HEAD';
  const status = !known ? 404 : allowed ? 200 : 405;
  const content = status === 200 ? acceptanceDemoHtml(requestTarget)
    : status === 405 ? 'Only GET and HEAD are supported.\n' : 'Demo page not found.\n';
  const bytes = Buffer.from(content);
  const headers = { 'Content-Type': status === 200 ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
    ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) };
  return { status, headers, body: method === 'HEAD' ? Buffer.alloc(0) : bytes };
}

export async function startAcceptanceDemoPages({ port = 0, onRequest = () => {} } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Demo port must be an integer from 0 to 65535.');
  if (typeof onRequest !== 'function') throw new TypeError('onRequest must be a function.');
  const server = createServer((req, res) => {
    const value = acceptanceDemoResponse(req.method, req.url);
    try { onRequest({ at: new Date().toISOString(), method: req.method, path: req.url,
      status: value.status, responseBytes: value.body.length }); }
    catch { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('Demo request log unavailable.\n'); return; }
    res.writeHead(value.status, value.headers); res.end(value.body);
  });
  await new Promise((ready, reject) => {
    const fail = error => reject(error);
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); ready(); });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closing;
  return Object.freeze({ origin,
    pages: Object.freeze(Object.fromEntries(ACCEPTANCE_DEMO_PATHS.map(path => [path.slice(1), origin + path]))),
    close() {
      return closing ??= new Promise((ready, reject) => {
        server.close(error => error ? reject(error) : ready());
        server.closeAllConnections();
      });
    } });
}
