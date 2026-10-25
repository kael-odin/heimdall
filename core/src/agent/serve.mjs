/**
 * agent/serve — 只读、只听回环、不加 CSP 的静态服务（评估器与快速裁判用）
 *
 * 为什么不用 clone-preview-server：它给 HTML 加 `Content-Security-Policy: sandbox`
 * （不含 allow-same-origin），页面成了不透明源，Web 字体按跨源被拦、cssRules 读不了。
 * Phase 0 实测（PRD 05 §1.5、10 §4 R18）：thordata.com 首页在它下面只加载得到 iconfont，
 * 参考截图退回 Microsoft YaHei，候选与参考于是用了不同的字体。
 *
 * 这个服务每次用完即关、随机端口、只认 127.0.0.1 的 Host，源上没有任何接口，
 * 放开 same-origin 的风险可控。deny() 用来挡住不该被候选页读到的目录（如参考图）。
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { isSecretPath } from './secrets.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.avif': 'image/avif', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm' };

export async function serveStatic(dir, { deny = () => false } = {}) {
  const root = normalize(dir).replace(/[\\/]+$/, '');
  let port = 0;
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(421); res.end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    let path;
    try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    const file = normalize(join(root, path.endsWith('/') ? path + 'index.html' : path));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile() || isSecretPath(file) || deny(file)) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(file).pipe(res);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
  };
}
