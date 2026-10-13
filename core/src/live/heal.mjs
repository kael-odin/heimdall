/**
 * live/heal — 导出期自愈：把离线缺失的同站资源补进 site/live
 *
 * 背景：活动页/老页面可能没留下 network.har，导致交互镜像离线时
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
import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { UA } from '../ua.mjs';

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

/**
 * 哪些响应体值得落盘成"本地资源"—— **看类型，不看域名**。
 *
 * 这条判据是一次实测换来的：交付包断网时 1.5 秒内像素变化 **0.00%**（联网是 6.13%），
 * 因为页面把**整个应用的 JS + 字体 + WebGL 驱动**放在另一个域上（moonshot 的
 * `statics.kimi.ai`，另有 `unpkg.com` 的 wasm）。而旧判据写的是
 * `!sameOrigin && !isImage → continue`，理由"追踪脚本等留在外网"——
 * 它把**站外**当成了**第三方**，可"静态域名分离 / CDN 子域"是很常见的做法，
 * 于是整套应用被跳过，离线只剩一张不会动的照片。
 *
 * 现在的判据：静态资源类型（脚本/样式/字体/图片/媒体/wasm）就落盘。
 * 这些请求**本来就是原站页面自己发出的** —— HAR 就是这份记录，不需要再猜。
 * 追踪脚本顺带也会被落盘：无害，而且断网时它本来也只是失败。
 *
 * 明确不碰的两类：`text/html`（那是页面/iframe 本身）与 XHR/JSON（那是**数据**）——
 * 跨域 API 在离线时本质上无法伪造，HAR 回放也只覆盖走 serve.mjs 的同源那部分。
 */
const STATIC_MIME = /^(?:text\/css|text\/javascript|application\/(?:javascript|ecmascript|x-javascript|wasm|font|vnd\.ms-fontobject|font-woff|x-font)|font\/|image\/|video\/|audio\/)/i;
const STATIC_EXT = /\.(?:js|mjs|cjs|css|woff2?|ttf|otf|eot|wasm|riv|glb|gltf|svg|png|jpe?g|gif|webp|avif|ico|mp4|webm|mov|mp3|wav|ogg|pdf)$/i;

/** `entry` 是 sanitizeHar 的形状（method/url/status/mimeType/body）。 */
export function isStaticAsset(entry) {
  const mime = String(entry?.mimeType ?? '').split(';')[0].trim();
  if (STATIC_MIME.test(mime)) return true;
  // CDN 上的 .riv / .wasm / .woff2 常被发成 application/octet-stream（甚至不给 content-type）
  if (!mime || /^application\/octet-stream$/i.test(mime)) {
    try { return STATIC_EXT.test(new URL(entry.url).pathname); } catch { return false; }
  }
  return false;
}

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
              'user-agent': UA,
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

/**
 * 把 HAR 中可回放的响应体落盘为 site/live 实体文件（离线更稳，且能覆盖同路径的其它查询变体）。
 * 只处理：同源 GET 200 有 body、无查询串、非目录路径。带查询的（如 /_next/image?…）继续走 HAR 回放。
 */
export function materializeHar({ liveDir, origin, entries = [] } = {}) {
  const out = { written: 0, skipped: 0, bytes: 0 };
  const seen = new Set();
  for (const e of entries) {
    if (e.method !== 'GET' || !e.body || e.status !== 200) continue;
    let u;
    try { u = new URL(e.url); } catch { continue; }
    if (u.origin !== origin) continue;
    if (u.search) { out.skipped++; continue; }
    const path = u.pathname;
    if (!path || path === '/' || path.endsWith('/')) { out.skipped++; continue; }
    if (seen.has(path)) continue;
    seen.add(path);
    const file = join(liveDir, path.replace(/^\/+/, ''));
    if (existsSync(file)) { out.skipped++; continue; }
    const buf = Buffer.from(e.body, 'base64');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
    out.written++;
    out.bytes += buf.length;
  }
  return out;
}

const MIME_EXT = [
  [/^image\/webp/i, 'webp'], [/^image\/png/i, 'png'], [/^image\/jpe?g/i, 'jpg'], [/^image\/avif/i, 'avif'],
  [/^image\/gif/i, 'gif'], [/^image\/svg/i, 'svg'], [/^image\/x-icon|vnd\.microsoft\.icon/i, 'ico'],
  [/^font\/woff2/i, 'woff2'], [/^font\/woff/i, 'woff'], [/^font\/ttf/i, 'ttf'], [/^font\/otf/i, 'otf'],
  [/^application\/vnd\.ms-fontobject/i, 'eot'],
  [/^text\/css/i, 'css'], [/^text\/html/i, 'html'], [/^text\/plain/i, 'txt'],
  // 后缀决定 serve.mjs 的 Content-Type（它按扩展名查表）：.js 落成 .bin 会被
  // 浏览器以 MIME 不符**拒绝执行**，模块脚本直接不跑 —— 这条路以前踩过。
  [/^text\/javascript|application\/(?:javascript|ecmascript|x-javascript)/i, 'js'],
  [/^application\/wasm/i, 'wasm'], [/^application\/json/i, 'json'],
  [/^video\/mp4/i, 'mp4'], [/^video\/webm/i, 'webm'], [/^audio\/mpeg/i, 'mp3'],
];
export const mimeExt = (mime, url = '') => {
  const m = String(mime || '');
  for (const [re, ext] of MIME_EXT) if (re.test(m)) return ext;
  // mime 缺失或 octet-stream 时按 URL 后缀兜底（CDN 上 .riv/.js 常被这么发）
  try {
    const hit = new URL(url).pathname.match(/\.([a-z0-9]{1,5})$/i);
    if (hit) return hit[1].toLowerCase();
  } catch { /* 相对 URL 或坏 URL：交给最后的兜底 */ }
  return 'bin';
};

/**
 * 把 HAR 里的响应体落盘为 `_ext/<sha1>.<ext>`，返回 url → 公共路径 的改写表。
 *
 * 走这里的两种情况：
 *   ① 同源**带查询**（典型 `/_next/image?url=…&w=…&q=…`）—— 查询串落不成文件路径，只能哈希命名；
 *   ② **站外**的静态资源（判据见 isStaticAsset）—— 整份搬进来，名字带哈希是为了
 *      同一路径出现在不同域上时不互相覆盖。
 * 同源无查询的仍走 materializeHar（按原路径落盘）。
 */
/**
 * 站外资源的落盘路径：**必须保留原始目录结构**。
 *
 * 这是一次实测逼出来的：站外的 JS 之间是靠**相对路径**互相引用的（Vite 的 preload
 * 清单里全是 `./chunk-X.js` / `../chunks/chunk-Y.js`）。早先一律拍平成
 * `_ext/<sha1>.js`，于是从 `_ext/entry-client-routing.js` 出发的
 * `../chunks/chunk-Y.js` 解析成了 `/lm/<host>/chunks/chunk-Y.js` —— 404，
 * 模块链从中间断掉，WebGL hero 起不来（同源那侧不受影响，因为同源本来就走原路径）。
 *
 * 目录里带上 host，是为了不同域上的同路径不互相覆盖；查询串变体（`?v=1` 之类）
 * 没法落成文件路径，在扩展名前插一段短哈希各自落一份。
 */
function crossOriginRel(u, entry) {
  const ext = mimeExt(entry.mimeType, entry.url);
  let p = u.pathname.replace(/^\/+/, '');
  // Windows 不允许的字符（`:` 在路径里合法，所以 URL 里真的会出现）换成 `_`
  p = p.replace(/[<>:"|?*\x00-\x1f]/g, '_');
  if (!p || p.endsWith('/')) p += 'index';
  // 没有后缀的端点（如 /wasm）补一个：serve.mjs 靠扩展名决定 Content-Type
  if (!/\.[a-z0-9]{1,5}$/i.test(p)) p += '.' + ext;
  if (u.search) {
    const h = createHash('sha1').update(u.href).digest('hex').slice(0, 8);
    p = p.replace(/(\.[a-z0-9]{1,5})$/i, '~' + h + '$1');
  }
  return '_ext/' + u.host + '/' + p;
}

export function localizeQueryEntries({ entries = [], liveDir, host, origin, hostPrefixes = false } = {}) {
  const map = new Map();
  const out = { written: 0, skipped: 0, bytes: 0 };
  const extHosts = new Set();
  for (const e of entries) {
    if (e.method !== 'GET' || !e.body || e.status !== 200) continue;
    let u;
    try { u = new URL(e.url); } catch { continue; }
    const sameOrigin = u.origin === origin;
    if (sameOrigin && !u.search) continue;          // 同源无查询：materializeHar 已落盘
    if (!sameOrigin && !isStaticAsset(e)) continue; // 站外只搬静态资源（数据类 API 离线无法伪造）
    // 同源带查询的是动态端点（/_next/image?…），与谁都不构成相对关系 → 拍平成哈希名即可；
    // 站外的要保住目录结构（见 crossOriginRel）
    const rel = sameOrigin
      ? '_ext/' + createHash('sha1').update(e.url).digest('hex').slice(0, 16) + '.' + mimeExt(e.mimeType, e.url)
      : crossOriginRel(u, e);
    // 页面 <base> 是页面级作用域（/lm/<host>/<page>/），相对路径会指错目录 → 用 /lm/<host>/_ext/... 绝对路径
    const publicPath = '/lm/' + host + '/' + rel;
    const file = join(liveDir, rel);
    if (!existsSync(file)) {
      const buf = Buffer.from(e.body, 'base64');
      // 建到文件自己那一层：站外资源保留了原始目录结构（`_ext/<host>/a/b/c.js`），
      // 只建 `_ext/` 一层会 ENOENT —— 这是 `_ext/<sha1>` 改成保留结构时漏掉的一处
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, buf);
      out.written++;
      out.bytes += buf.length;
    } else out.skipped++;
    map.set(e.url, publicPath);
    if (sameOrigin) {
      map.set(u.pathname + u.search, publicPath);
      if (host) map.set('/lm/' + host + u.pathname + u.search, publicPath);
    } else {
      // 协议相对写法在页面里极常见（实测 moonshot 的字体/图标就是 `//statics.kimi.ai/…`），
      // 而 HAR 里记的是绝对 URL —— 少这一条，HTML 里那些引用会原样留在外网。
      map.set('//' + u.host + u.pathname + u.search, publicPath);
      extHosts.add(u.host);
    }
  }
  /**
   * 站外站点的**整站前缀**也接过来。
   *
   * 因为应用在运行时是用"CDN 基址 + 相对路径"拼地址的（Vite 的 preload 清单就是
   * `assets/chunks/chunk-X.js`、`../chunks/chunk-Y.js` 这种），那些拼出来的 URL
   * **在文本里根本不存在**，字符串替换抓不到 —— 实测断网时它们以 `http://statics.kimi.ai/…`
   * 的形式被请求出来（协议相对 + http 页面）。而我们把站外资源**按原路径**存进了
   * `_ext/<host>/`，于是把 `//<host>/` 整体接到 `_ext/<host>/` 上，
   * 运行时拼出来的任何地址都自然落进本地镜像树。
   *
   * 只在离线包里做：在线镜像的承诺是"未捕获的资源实时回源"，把前缀接到本地
   * 会让那些资源从"能回源"变成"本地 404"。
   */
  if (hostPrefixes) {
    for (const h of extHosts) {
      const to = '/lm/' + host + '/_ext/' + h + '/';
      for (const p of ['https://', 'http://', '//']) map.set(p + h + '/', to);
    }
  }
  return { map, ...out };
}

/**
 * 把 site/live 里所有**文本资源**中的外域 URL 换成改写表里的本地路径。
 *
 * 为什么不能只改 HTML：实测（moonshot 首页）当天最要命的那份资源
 * `unicornStudio-2.1.4.umd.js`（WebGL 驱动）以及其余 chunk，都是**应用自己的 JS**
 * 从 `https://statics.kimi.ai/…` 拉起来的 —— 页面 HTML 里根本没有这些 URL，
 * 只改 HTML 等于把这些请求原样留给了外网，断网时 hero 就是一帧静止画面。
 *
 * 明确的能力边界：这里做的是**字符串替换**，只对"出现在文本里的绝对 URL"有效。
 * 运行时拼出来的地址（`base + 'chunks/' + name`）替换不到 —— 那需要运行期拦截，
 * 是另一层的事。改完实测剩余外链数（health 的 externalAssets）会说话。
 */
export function rewriteLocalRefs({ liveDir, map }) {
  const out = { files: 0, rewrites: 0 };
  if (!map?.size) return out;
  const keys = [...map.keys()].sort((a, b) => b.length - a.length);
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (/\.(?:html?|js|mjs|cjs|css|json)$/i.test(n)) {
        let text = readFileSync(p, 'utf8');
        let hits = 0;
        const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const k of keys) {
          const to = map.get(k);
          for (const variant of [k, k.replace(/&/g, '&amp;')]) {
            // 边界感知：避免命中更长 URL 的子串（如 /lm/www.host/_next/… 里的 /_next/…）
            const re = new RegExp('(?<![\\w.-])' + esc(variant), 'g');
            const n2 = (text.match(re) || []).length;
            if (!n2) continue;
            hits += n2;
            text = text.replace(re, to);
          }
        }
        // 写时复制：导出包与 workspace 是硬链接，直接写会连带改坏源文件 → 先写临时文件再改名断链
        if (hits) { writeFileSync(p + '.heimdall-tmp', text); renameSync(p + '.heimdall-tmp', p); out.files++; out.rewrites += hits; }
      }
    }
  };
  walk(liveDir);
  return out;
}
