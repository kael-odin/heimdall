/**
 * clone-cssref — 端到端回归：CSS 引用的解析基准 与 资产扩展名判定
 *
 * 锁死两个真实缺陷（2026-10-09 实测）：
 *   ① `url(../fonts/X.woff2)` 必须按**样式表自身 URL** 解析，而不是页面 origin
 *      —— 旧实现会把 `https://host/css/../fonts/X.woff2` 算成 `https://host/fonts/...`
 *      还是对的，但 `https://host/_next/static/css/../media/X` 会被算成 `https://host/media/X`（404）。
 *      这里用 `/assets/css/main.css` 引用 `../fonts/Test.woff2`（真实地址是 `/assets/fonts/Test.woff2`）
 *      来钉死"基准 = 样式表"。
 *   ② 带查询串的 CDN 图必须以真实类型落盘（`.png`），不能再出现 `.bin`。
 *
 * 做法：起本地 fixture 站点 → 跑 capture + build_clone → 断言产物。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));

/** 1×1 红色 PNG（真实字节，供 magic 判定） */
function makePng() {
  const png = new PNG({ width: 2, height: 2 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 3] = 255; }
  return PNG.sync.write(png);
}

/** 假 woff2（magic 正确即可，浏览器不解析它，我们只断言本地化结果） */
const WOFF2 = Buffer.concat([Buffer.from('wOF2', 'latin1'), Buffer.alloc(28, 7)]);

/** 内联 SVG 的 data URI：内部 `mask='url(%23f)'` 曾被旧实现误当成外部引用并改写 */
const DATA_URI_SVG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3Cmask id='f'%3E%3C/g%3E%3C/defs%3E%3Cg mask='url(%23f)'/%3E%3C/svg%3E")`;

function startFixture() {
  const png = makePng();
  const css = `
@font-face { font-family: 'TestFace'; src: url(../fonts/Test.woff2) format('woff2'); }
body { font-family: 'TestFace', sans-serif; }
.hero { width: 40px; height: 40px; background-image: url(/img/photo?id=9&w=100); }
.icon { width: 16px; height: 16px; background-image: ${DATA_URI_SVG}; }
.gone { width: 8px; height: 8px; background-image: url(/missing-sprite.png); }
`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>CSS ref fixture</title>
<link rel="stylesheet" href="/assets/css/main.css">
</head><body><h1>Hi</h1><div class="hero"></div><i class="icon"></i><i class="gone"></i>
<img src="/img/photo?id=9&w=100" alt="x" width="40" height="40">
</body></html>`;
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const send = (ct, body) => { res.writeHead(200, { 'Content-Type': ct }); res.end(body); };
      if (url.pathname === '/') return send('text/html; charset=utf-8', html);
      if (url.pathname === '/assets/css/main.css') return send('text/css; charset=utf-8', css);
      if (url.pathname === '/assets/fonts/Test.woff2') return send('font/woff2', WOFF2);
      if (url.pathname === '/img/photo') return send('image/png', png);
      // SPA 式软 404：路径不存在却回 200 + HTML（真实站点极常见）
      if (url.pathname === '/missing-sprite.png') return send('text/html; charset=utf-8', '<!doctype html><html><body>not found</body></html>');
      res.writeHead(404); res.end('nf');
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, png }));
  });
}

/** 异步跑脚本：务必不能用 spawnSync —— 会阻塞本进程事件循环，fixture 服务器就无法应答 */
function run(script, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { cwd: CORE, env });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('clone: CSS url() 按样式表基准解析 + 按真实类型落盘', { timeout: 120_000 }, async () => {
  const { server, port } = await startFixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'hd-cssref-'));
  const pageDir = join(dataDir, 'site.test', 'pages', 'home');
  const env = { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_LLM: '0' };
  try {
    const origin = `http://127.0.0.1:${port}`;
    const cap = await run('src/crawler/capture.mjs', [origin + '/', pageDir], env);
    assert.equal(cap.code, 0, 'capture 失败:\n' + cap.out);

    const build = await run('src/crawler/build_clone.mjs', [pageDir], env);
    assert.equal(build.code, 0, 'build_clone 失败:\n' + build.out);

    const css = readFileSync(join(pageDir, 'clone', 'styles', 'cssom.css'), 'utf8');

    // ① 样式表基准：捕获期记录 refMap，`../fonts/Test.woff2` 应解析到样式表同级的 ../fonts 并本地化
    const meta = JSON.parse(readFileSync(join(pageDir, 'cssom-refs.json'), 'utf8'));
    assert.ok(meta.refMap, 'cssom-refs.json 应带 refMap（每 ref 的基准解析结果）');
    assert.deepEqual(meta.refMap['../fonts/Test.woff2'], [`${origin}/assets/fonts/Test.woff2`],
      'ref 必须按样式表自身 URL 解析');
    assert.doesNotMatch(css, /url\(['"]?\.\.\/fonts\//, 'CSS 里不得残留未本地化的相对字体引用');

    // 字体落在 styles/ 且是真 woff2
    const stylesDir = readdirSync(join(pageDir, 'clone', 'styles'));
    const woff2 = stylesDir.find(n => n.endsWith('.woff2'));
    assert.ok(woff2, '字体应本地化到 clone/styles/*.woff2，实际: ' + stylesDir.join(','));
    assert.equal(readFileSync(join(pageDir, 'clone', 'styles', woff2)).subarray(0, 4).toString('latin1'), 'wOF2');

    // ② 扩展名：带查询串的 CDN 图必须落成 .png（旧实现会落成 .bin）
    assert.doesNotMatch(css, /\.bin['"]?\)/, 'CSS 中不应再出现 .bin 资产引用');
    const assetsDir = readdirSync(join(pageDir, 'clone', 'assets'));
    assert.ok(assetsDir.some(n => n.endsWith('.png')), '带查询串的图片应落成 .png，实际: ' + assetsDir.join(','));
    assert.ok(!assetsDir.some(n => n.endsWith('.bin')), '不应再有 .bin 落盘，实际: ' + assetsDir.join(','));

    // ③ data URI 内嵌的 mask 引用必须原样保留（旧实现会把它改写成 refNNN.html）
    assert.match(css, /mask='url\(%23f\)'/, 'data URI 内嵌的 mask 引用不得被改写');
    assert.doesNotMatch(css, /ref\d+\.html/, 'CSS 里不得出现 refNNN.html');
    assert.ok(!assetsDir.some(n => n.endsWith('.html')), 'HTML 响应不得当成资产落盘，实际: ' + assetsDir.join(','));

    // ④ 软 404（要图片回 HTML）必须记为缺口，而不是"看起来有"的假资产
    const gaps = JSON.parse(readFileSync(join(pageDir, 'clone-gaps.json'), 'utf8'));
    assert.ok(gaps.cssRefsFailed >= 1, '软 404 应计入 cssRefsFailed');
    assert.ok(gaps.gaps.some(g => g.ref === '/missing-sprite.png'), '软 404 的引用应出现在缺口清单里');
  } finally {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
