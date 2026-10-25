#!/usr/bin/env node
/**
 * Heimdall-Bench 夹具 F1：静态营销页（PRD 09 §1.2–1.3、E14-13）
 *
 *   node test/fixtures/bench/f1/server.mjs [--port N] [--inject <caseId>]
 *
 * 也可以按请求注入：GET /?inject=<caseId>。注入清单在 truth/cases.json，只给评分器读。
 * 完全离线：字体（Source Code Pro，SIL OFL 1.1，许可证在 public/fonts/）、SVG 与两张位图都在本地；
 * 位图由代码确定性生成（同样的输入同样的字节），不入库二进制。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, 'public');
export const CASES = Object.freeze(JSON.parse(readFileSync(join(HERE, 'truth', 'cases.json'), 'utf8')).cases);
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

/** 确定性生成的位图：管道拓扑示意（560×420）与头像（240×240） */
function heroArt() {
  const W = 560, H = 420, png = new PNG({ width: W, height: H });
  const nodes = [[90, 110], [250, 80], [420, 130], [160, 270], [330, 250], [470, 320]];
  const edges = [[0, 1], [1, 2], [0, 3], [3, 4], [1, 4], [4, 5], [2, 5]];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, t = y / H;
    png.data[i] = 22 + 20 * t; png.data[i + 1] = 34 + 30 * t; png.data[i + 2] = 72 + 60 * t; png.data[i + 3] = 255;
    if ((x % 28 === 0 || y % 28 === 0)) { png.data[i] += 10; png.data[i + 1] += 12; png.data[i + 2] += 18; }
  }
  const plot = (x, y, r, g, b) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const i = (y * W + x) * 4; png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; };
  for (const [a, b] of edges) {
    const [x0, y0] = nodes[a], [x1, y1] = nodes[b];
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(x0 + (x1 - x0) * s / steps), y = Math.round(y0 + (y1 - y0) * s / steps);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) plot(x + dx, y + dy, 120, 150, 230);
    }
  }
  nodes.forEach(([cx, cy], k) => {
    const color = k % 3 === 0 ? [244, 162, 97] : k % 3 === 1 ? [255, 255, 255] : [42, 157, 143];
    for (let y = -18; y <= 18; y++) for (let x = -18; x <= 18; x++) if (x * x + y * y <= 18 * 18) plot(cx + x, cy + y, ...color);
  });
  return PNG.sync.write(png);
}

function avatar() {
  const S = 240, png = new PNG({ width: S, height: S });
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const d = Math.hypot(x - 120, y - 96);
    const body = Math.hypot((x - 120) / 1.3, y - 250) < 120;
    const [r, g, b] = d < 52 ? [238, 196, 160] : body ? [47, 91, 234] : [214, 222, 240 - y / 6];
    png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const GENERATED = { '/img/hero-art.png': heroArt, '/img/avatar.png': avatar };
const cache = new Map();

export function caseById(id) { return CASES.find(c => c.id === id) ?? null; }

/** 把注入应用到 HTML：CSS 类注入追加一段 <style>，图片 404 类改写资源路径 */
export function applyInject(html, c) {
  if (!c) return html;
  let out = html;
  if (c.rewrite) out = out.split(c.rewrite.from).join(c.rewrite.to);
  if (c.css) out = out.replace('</head>', `<style id="heimdall-inject">${c.css}</style>\n</head>`);
  return out;
}

export async function startFixture({ port = 0, inject = null } = {}) {
  const fixed = inject ? caseById(inject) : null;
  if (inject && !fixed) throw new Error(`unknown inject case: ${inject}`);
  const server = createServer((req, res) => {
    let u;
    try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); res.end(); return; }
    const c = fixed ?? (u.searchParams.get('inject') ? caseById(u.searchParams.get('inject')) : null);
    if (u.searchParams.get('inject') && !c) { res.writeHead(404); res.end('unknown inject'); return; }
    const path = u.pathname === '/' || u.pathname === '/index.html' ? '/index.html' : u.pathname;
    if (GENERATED[path]) {
      if (!cache.has(path)) cache.set(path, GENERATED[path]());
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(cache.get(path));
      return;
    }
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    let body = readFileSync(file);
    if (path === '/index.html') body = Buffer.from(applyInject(body.toString('utf8'), c));
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, url: origin + '/', close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (isMain) {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
  const f = await startFixture({ port: Number(arg('--port') ?? 0), inject: arg('--inject') ?? null });
  console.log(`F1 fixture @ ${f.url}${arg('--inject') ? ` (inject ${arg('--inject')})` : ''}`);
}
