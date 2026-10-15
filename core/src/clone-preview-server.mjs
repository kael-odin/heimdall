import { createReadStream, existsSync, lstatSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WORKSPACE, isInside, isSecretFile } from './paths.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf',
};

function regularFileUnder(root, segments) {
  let file = root;
  for (const segment of segments) {
    file = join(file, segment);
    let stat;
    try { stat = lstatSync(file); } catch { return null; }
    if (stat.isSymbolicLink()) return null;
  }
  try { return statSync(file).isFile() ? file : null; } catch { return null; }
}

/** A short-lived HTTP view of this process's workspace, independent of :8900. */
export async function startClonePreviewServer({ workspace = WORKSPACE } = {}) {
  const root = resolve(workspace);
  const server = createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${server.address().port}`) {
      res.writeHead(421); res.end(); return;
    }
    if (req.method !== 'GET' || !req.url) { res.writeHead(405); res.end(); return; }
    let segments;
    try {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (!pathname.startsWith('/static/')) throw new Error('outside static route');
      segments = pathname.slice('/static/'.length).split('/').map(decodeURIComponent);
      if (segments.some(part => !part || part === '.' || part === '..' || /[/\\]/.test(part))) {
        throw new Error('unsafe path');
      }
    } catch { res.writeHead(400); res.end(); return; }
    const candidate = resolve(root, ...segments);
    const file = isInside(root, candidate) ? regularFileUnder(root, segments) : null;
    if (!file || isSecretFile(file)) { res.writeHead(404); res.end(); return; }
    const stat = statSync(file);
    const mime = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
      ...(mime.startsWith('text/html') ? { 'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox' } : {}),
      ...(mime === 'image/svg+xml' ? { 'Content-Security-Policy': 'sandbox' } : {}),
    });
    createReadStream(file).pipe(res);
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    urlFor(file) {
      const path = resolve(file);
      if (!isInside(root, path) || !existsSync(path)) throw new Error('clone file outside current workspace: ' + path);
      const rel = relative(root, path);
      if (isAbsolute(rel)) throw new Error('clone file outside current workspace: ' + path);
      return `${origin}/static/${rel.split(sep).map(encodeURIComponent).join('/')}`;
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
    },
  };
}
