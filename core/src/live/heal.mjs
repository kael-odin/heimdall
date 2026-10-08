/**
 * live/heal — 导出期自愈：把离线缺失的同站资源补进 site/live
 *
 * 背景：活动页/老页面可能没留下 network.har，导致活镜像离线时
 * chunk / 字体 / favicon / tab 图标 404。导出时（--heal）从原站抓取
 * 这些仍然可用的资源并落盘，使离线包尽量自包含。
 *
 * 规则：
 *   - 只处理同站、非 /static/<host>/（克隆件已在包里）、非动态端点（/_next/image 等）
 *   - 同一路径可能带多个部署变体（?dpl=…）：逐个尝试直到命中，落盘位置只按路径
 *   - 200 且体积 ≤ maxBytes 才写入；并发受控；失败不阻断导出，计入 failed
 *
 * 入口：healBundle({ liveDir, host, origin, targets, fetchImpl?, concurrency?, maxBytes? })
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DYNAMIC_ENDPOINT = /^\/(?:_next\/image|_next\/data|api\/|cdn-cgi\/)/;

const extOk = (path, mime) => {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!m) return true;
  if (/\.js$/i.test(path)) return /javascript|ecmascript|text\/plain|application\/octet-stream/.test(m);
  if (/\.css$/i.test(path)) return /text\/css|text\/plain|application\/octet-stream/.test(m);
  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return /font|application\/octet-stream/.test(m);
  if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/i.test(path)) return /image|application\/octet-stream/.test(m);
  if (/\.json$/i.test(path)) return /json|text\/plain|application\/octet-stream/.test(m);
  return true;
};

export async function healBundle({
  liveDir, host, origin, targets = [],
  fetchImpl = globalThis.fetch,
  concurrency = 6,
  maxBytes = 20 * 1024 * 1024,
  timeoutMs = 20_000,
} = {}) {
  const results = { fetched: 0, failed: 0, skipped: 0, bytes: 0, variants: 0, reasons: {}, items: [] };
  const bump = (k) => { results.reasons[k] = (results.reasons[k] ?? 0) + 1; };
  const byPath = new Map();
  for (const raw of targets) {
    const t = String(raw ?? '').trim();
    if (!t || !t.startsWith('/')) continue;
    const path = t.split('?')[0].split('#')[0];
    if (!path || path.endsWith('/')) { results.skipped++; bump('not-a-file'); continue; }
    if (DYNAMIC_ENDPOINT.test(path)) { results.skipped++; bump('dynamic-endpoint'); continue; }
    const list = byPath.get(path) ?? [];
    if (list.length < 4 && !list.includes(t)) list.push(t);
    byPath.set(path, list);
  }
  const queue = [...byPath.entries()];
  results.variants = queue.reduce((a, [, v]) => a + v.length, 0);
  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const [path, variants] = queue[idx++];
      let done = false;
      for (const target of variants) {
        try {
          const res = await fetchImpl(origin + target, {
            headers: {
              'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
              accept: '*/*',
              referer: origin + '/',
            },
            signal: AbortSignal.timeout(timeoutMs),
            redirect: 'follow',
          });
          if (!res.ok) { bump('http-' + res.status); continue; }
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > maxBytes) { results.skipped++; bump('too-large'); done = true; break; }
          if (!extOk(path, res.headers.get('content-type'))) { results.skipped++; bump('mime-mismatch'); done = true; break; }
          const file = join(liveDir, path.replace(/^\/+/, ''));
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, buf);
          results.fetched++;
          results.bytes += buf.length;
          results.items.push({ path, url: target, status: res.status, bytes: buf.length });
          done = true;
          break;
        } catch (e) {
          bump('error');
          results.items.push({ path, url: target, error: String(e).slice(0, 120) });
        }
      }
      if (!done) results.failed++;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, worker));
  return results;
}
