#!/usr/bin/env node
/**
 * qa-defect-site — 无参照物检测的固定夹具（离线、确定性）
 *
 * 两种页面：
 *   /clean   健康页面：每一项都应通过，用来量误报；
 *   /defects 按类别注入的缺陷，每个缺陷都有明确的预期检测器；
 *   /warn    只输出 console.warn 的页面：不应产生任何检测发现。
 *
 * 缺陷清单（id → 预期检测器）放在 DEFECT_CASES，基准脚本原样复制成 truth.json，
 * 检测器本身不读它。夹具里的 HTML 是手写的，源码行号与文件一致。
 */
import { createServer } from 'node:http';
import { PNG } from 'pngjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFECT_CASES = Object.freeze([
  { id: 'image-alt', detector: 'a11y-image-alt', kind: 'a11y', title: '图片缺少 alt' },
  { id: 'control-name', detector: 'a11y-control-name', kind: 'a11y', title: '图标按钮没有可访问名' },
  { id: 'form-label', detector: 'a11y-form-label', kind: 'a11y', title: '输入框没有标签' },
  { id: 'duplicate-id', detector: 'a11y-duplicate-id', kind: 'a11y', title: 'id 重复' },
  { id: 'heading', detector: 'a11y-heading', kind: 'a11y', title: '没有 h1' },
  { id: 'lang', detector: 'a11y-lang', kind: 'a11y', title: '缺少 lang' },
  { id: 'iframe-title', detector: 'a11y-iframe-title', kind: 'a11y', title: 'iframe 缺少 title' },
  { id: 'text-clipped', detector: 'layout-text-clipped', kind: 'layout', title: '文字被裁切' },
  { id: 'image-ratio', detector: 'layout-image-ratio', kind: 'layout', title: '图片被拉伸' },
  { id: 'tap-target', detector: 'layout-tap-target', kind: 'layout', title: '点击目标过小' },
  { id: 'placeholder', detector: 'content-placeholder', kind: 'content', title: '占位文案残留' },
  { id: 'template', detector: 'content-template', kind: 'content', title: '模板变量未替换' },
  { id: 'mojibake', detector: 'content-mojibake', kind: 'content', title: '乱码' },
  { id: 'invalid-value', detector: 'content-invalid-value', kind: 'content', title: 'Invalid Date' },
  { id: 'blank-target', detector: 'security-blank-target', kind: 'security', title: '新窗口缺 noopener' },
  { id: 'secret', detector: 'security-secret', kind: 'security', title: '页面里泄露密钥' },
  { id: 'oversized-image', detector: 'perf-oversized-image', kind: 'perf', title: '图片分辨率过大' },
  { id: 'layout-shift', detector: 'perf-cls', kind: 'perf', title: '布局偏移过大' },
]);

/** 不应报缺陷的页面（误报分母） */
export const CLEAN_CASES = Object.freeze([
  { id: 'clean', title: '健康页面' },
  { id: 'warn', title: '只有 console.warn 的页面' },
]);

/** 交互探索的注入案例：必须显式开启 --explore 才会被检测 */
export const INTERACTION_CASES = Object.freeze([
  { id: 'noop-click', target: '#noop-btn', kind: 'interaction', title: '点击没有反应' },
  { id: 'throw-click', target: '#throws-btn', kind: 'interaction', title: '点击触发脚本异常' },
  { id: 'gone-click', target: '#gone-link', kind: 'interaction', title: '点击跳到 404' },
]);

/** 交互探索的健康对照：点击有变化就不应报 */
export const INTERACTION_CLEAN = Object.freeze([
  { id: 'works-click', target: '#works-btn', title: '点击后正常显示内容的按钮' },
]);

const pngCache = new Map();
function solidPng(width, height, [r, g, b]) {
  const key = `${width}x${height}`;
  if (!pngCache.has(key)) {
    const png = new PNG({ width, height });
    for (let i = 0; i < png.data.length; i += 4) { png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; }
    pngCache.set(key, PNG.sync.write(png));
  }
  return pngCache.get(key);
}

const HEAD_OPEN = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA 缺陷夹具</title>';
const CSS = `body{margin:0;font:16px/1.5 Arial,sans-serif;color:#17223a;background:#f6f7fb}
main{max-width:860px;margin:24px auto;padding:0 20px}h1{font-size:30px}h2{font-size:22px}
.card{background:#fff;border:1px solid #d9e0ee;border-radius:10px;padding:16px;margin:12px 0}
.btn{border:0;border-radius:6px;padding:8px 14px;background:#dbeafe;color:#17223a;cursor:pointer}
.clip{width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.tiny{width:12px;height:12px;padding:0;border:0;background:#c7d2fe}
.field input{width:220px;padding:6px}
footer{margin:32px 0;color:#6b7280;font-size:13px}`;

/** 健康页面：每个检测器都应通过 */
function cleanPage() {
  return `${HEAD_OPEN}<style>${CSS}</style></head><body><main>
<h1>团队任务面板</h1>
<section class="card"><h2>待办</h2><p>今天有 3 个任务需要处理。</p>
<img src="/img/32-red.png" alt="红色状态标记" width="32" height="32">
<button class="btn">新建任务</button>
<a href="/clean" target="_blank" rel="noopener">打开帮助</a>
</section>
<section class="card"><h2>添加任务</h2>
<form action="/clean" method="get"><label for="task-name">任务名称</label><input id="task-name" name="name"><button class="btn" type="submit">保存</button></form>
</section>
<footer>固定离线夹具 · 不含真实数据</footer></main></body></html>`;
}

/** 每类缺陷一个区块，便于定位与复现 */
function defectPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QA 缺陷夹具</title><style>${CSS}</style></head><body><main>
<h2>任务概览</h2>
<section class="card" id="sec-image"><img src="/img/32-red.png" width="32" height="32"></section>
<section class="card"><button id="icon-only" class="btn"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect width="14" height="14" fill="#244bb5"/></svg></button></section>
<section class="card field"><input id="no-label" type="text"></section>
<section class="card"><div id="dup-id">第一块</div><div id="dup-id">第二块</div></section>
<section class="card"><iframe src="/frame" width="200" height="40"></iframe></section>
<section class="card"><p class="clip" id="clipped">这是一段很长的说明文字，本来应该完整显示给访客看，但现在被容器裁掉了大半内容。</p></section>
<section class="card"><img id="stretched" src="/img/64-square.png" width="256" height="64"></section>
<section class="card"><button id="tiny-btn" class="tiny" aria-label="关闭"></button></section>
<section class="card"><p id="todo-text">TODO: 接入支付回调</p></section>
<section class="card"><p id="template-text">你好，{{userName}}</p></section>
<section class="card"><p id="mojibake-text">cafÃ© au lait</p></section>
<section class="card"><p id="invalid-date">最近更新：Invalid Date</p></section>
<section class="card"><a id="blank-link" href="/clean" target="_blank">在新窗口打开</a></section>
<section class="card"><img id="oversized" src="/img/800-wide.png" width="100" height="25"></section>
<footer>固定离线夹具 · 不含真实数据</footer>
<span hidden id="leaked-secret">sk-abcdefghijklmnopqrstuvwx1234</span>
</main>
<script>
setTimeout(function () {
  var banner = document.createElement('div');
  banner.style.height = '480px';
  banner.style.background = '#e0e7ff';
  banner.textContent = '稍后插入的横幅';
  var target = document.querySelector('main');
  target.insertBefore(banner, target.firstChild);
}, 250);
</script></body></html>`;
}

/** 交互探索页：一个无反应按钮、一个点击抛错按钮、一个指向 404 的链接、一个正常按钮 */
function interactPage() {
  return `${HEAD_OPEN}<style>${CSS}</style></head><body><main>
<h1>交互检查</h1>
<section class="card"><button id="noop-btn" class="btn">立即刷新</button></section>
<section class="card"><button id="throws-btn" class="btn">展开详情</button></section>
<section class="card"><a id="gone-link" href="/gone">查看报告</a></section>
<section class="card"><button id="works-btn" class="btn">显示提示</button><p id="hint" hidden>已经显示</p></section>
<footer>固定离线夹具 · 不含真实数据</footer></main>
<script>
document.getElementById('throws-btn').addEventListener('click', function () {
  setTimeout(function () { throw new Error('fixture: detail panel failed to open'); }, 10);
});
document.getElementById('works-btn').addEventListener('click', function () {
  document.getElementById('hint').hidden = false;
});
</script></body></html>`;
}

export async function startQaDefectFixture({ port = 0 } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const path = url.pathname;
    if (path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ fixture: 'qa-defects', ok: true, cases: DEFECT_CASES.length }));
      return;
    }
    if (path === '/img/32-red.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(solidPng(32, 32, [220, 38, 38])); return; }
    if (path === '/img/64-square.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(solidPng(64, 64, [36, 75, 181])); return; }
    if (path === '/img/800-wide.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); res.end(solidPng(800, 200, [17, 107, 73])); return; }
    if (path === '/frame') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body>嵌入的内容</body></html>');
      return;
    }
    if (path === '/clean') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(cleanPage()); return; }
    if (path === '/interact') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(interactPage()); return; }
    if (path === '/warn') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(`${HEAD_OPEN}<style>${CSS}</style></head><body><main><h1>警告页</h1><p>这个页面只输出控制台警告，不是缺陷。</p><script>console.warn('deprecated widget: use widget v2');</script></main></body></html>`);
      return;
    }
    if (path === '/defects') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(defectPage()); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('fixture route not found');
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let closed = false;
  return {
    origin,
    url: (path) => `${origin}${path}`,
    close: () => new Promise((ready, reject) => {
      if (closed) { ready(); return; }
      closed = true;
      server.close(error => error ? reject(error) : ready());
      server.closeAllConnections();
    }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rawPort = process.argv[2] ?? '0';
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be an integer from 0 to 65535');
  const fixture = await startQaDefectFixture({ port });
  console.log(JSON.stringify({ origin: fixture.origin, pages: ['/clean', '/defects', '/warn'], cases: DEFECT_CASES, clean: CLEAN_CASES }, null, 2));
  const shutdown = async () => { await fixture.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
