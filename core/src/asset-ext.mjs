/**
 * asset-ext — 资产扩展名判定（唯一定义，capture 与 build_clone 共用）
 *
 * 判定优先级：**magic bytes > Content-Type > URL 后缀 > 'bin'**
 *
 * 背景（2026-10-09 实测）：build_clone 旧实现用 `extOf('', url)` 只靠 URL 后缀猜，
 * 于是带查询串的 CDN 图（`?w=1000&q=80`、`?_next/image`）一律落成 `refNNN.bin`。
 * 实测 Chrome 下仍可嗅探渲染（不是保真事故），但跨浏览器未验证、直接打开会触发下载、
 * 导出包里 JPEG 叫 .bin 语义脏 —— 因此按响应体真实类型落盘。
 */

/** 文本型资源的前缀判定（magic 之外） */
const TEXT_EXT = [
  [/^\s*<(\?xml|svg)/i, 'svg'],
  [/^\s*(<!doctype html|<html)/i, 'html'],
  [/^\s*[[{]/ , 'json'],
];

const BINARY_MAGIC = [
  [[0xff, 0xd8, 0xff], 'jpg'],
  [[0x89, 0x50, 0x4e, 0x47], 'png'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
  [[0x00, 0x00, 0x01, 0x00], 'ico'],
  [[0x25, 0x50, 0x44, 0x46], 'pdf'],
  [[0x77, 0x4f, 0x46, 0x46], 'woff'],       // 'wOFF'
  [[0x77, 0x4f, 0x46, 0x32], 'woff2'],      // 'wOF2'
  [[0x4f, 0x54, 0x54, 0x4f], 'otf'],        // 'OTTO'
  [[0x00, 0x01, 0x00, 0x00], 'ttf'],
  [[0x66, 0x74, 0x72, 0x75], 'ttf'],        // 'tru'
  [[0x1a, 0x45, 0xdf, 0xa3], 'webm'],       // EBML（webm/mkv）
];

const CT_EXT = [
  [/image\/jpe?g/, 'jpg'],
  [/image\/png/, 'png'],
  [/image\/webp/, 'webp'],
  [/image\/avif/, 'avif'],
  [/image\/gif/, 'gif'],
  [/image\/svg/, 'svg'],
  [/image\/x-icon|image\/vnd\.microsoft\.icon/, 'ico'],
  [/image\/bmp/, 'bmp'],
  [/font\/woff2|application\/font-woff2/, 'woff2'],
  [/font\/woff|application\/font-woff/, 'woff'],
  [/font\/ttf|application\/x-font-ttf/, 'ttf'],
  [/font\/otf|application\/x-font-otf/, 'otf'],
  [/font\/(sfnt|collection)/, 'ttf'],
  [/video\/mp4/, 'mp4'],
  [/video\/webm/, 'webm'],
  [/video\/(quicktime)/, 'mov'],
  [/audio\/mpeg/, 'mp3'],
  [/audio\/(wav|x-wav)/, 'wav'],
  [/audio\/ogg/, 'ogg'],
  [/application\/json|application\/manifest\+json/, 'json'],
  [/text\/css/, 'css'],
  [/text\/html/, 'html'],
  [/text\/plain/, 'txt'],
  [/application\/xml|text\/xml/, 'xml'],
];

const URL_EXT = /\.(woff2|woff|ttf|otf|eot|png|jpe?g|webp|avif|svg|gif|ico|bmp|mp4|webm|mov|mp3|wav|ogg|json|webmanifest|css|js|mjs|txt|xml|map|pdf)$/i;

const bufStartsWith = (buf, bytes) => {  if (!buf || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
};

/** URL 路径里的 4 字节 ASCII（如 'RIFF'/'ftyp'） */
const asciiAt = (buf, at, s) => {
  if (!buf || buf.length < at + s.length) return false;
  for (let i = 0; i < s.length; i++) if (buf[at + i] !== s.charCodeAt(i)) return false;
  return true;
};

/**
 * 不是外部资产引用：页内锚点、内联数据、伪协议。
 *
 * `#id` 可以是 SVG filter/mask/clipPath 的文档内引用，也可以是百分号编码形式 `%23id`
 * （某些压缩器会这么写）——两者都不能当文件去抓，否则会把内联 SVG 的 mask 引用改坏。
 *
 * 判之前先做**实体解码 + 去引号**，这一步是必须的：
 * 链接器处理的是序列化后的 HTML 文本，属性里的引号是 `&quot;`、
 * 内联 SVG 的尖括号是 `&lt;`。实测 framer.com 的 `url(&quot;data:image/svg+xml,&lt;svg…&gt;&quot;)`
 * 解码后以 `"` 开头，于是 `data:` **不在开头**，被判成"外部资产"——
 * 一页 55 处、整站 233 处全去抓 `https://www.framer.com/%22data:…`，必然 404，
 * 记成 233 条资源本地化失败。真相是这些本来就是内联 data URI，一个字节都不用抓。
 */
export function isNonAssetRef(raw) {
  const s = String(raw ?? '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim()
    .replace(/^["']+|["']+$/g, '')      // CSS 里那层引号可能被实体编码过，去除后才是真值
    .trim();
  if (!s) return true;
  if (s.startsWith('#')) return true;
  if (/^%23/i.test(s)) return true;
  return /^(data|about|blob|javascript|mailto|tel|file):/i.test(s);
}

/** 响应体是 HTML 却不是 HTML 资源 → 几乎必然是软 404 / SPA 兜底页，不能当资产落盘 */
export function isSoftHtml(contentType, url = '') {
  if (!/text\/html/i.test(String(contentType ?? ''))) return false;
  try { return !/\.html?$/i.test(new URL(url, 'https://x.local').pathname); } catch { return true; }
}

/**
 * @param {string|null} url         资产 URL（可空）
 * @param {string} contentType      响应 Content-Type（可空）
 * @param {Buffer|Uint8Array|null} buf  响应体前若干字节（可空）
 * @returns {string} 扩展名（不含点）；无法判定时 'bin'
 */
export function extFrom(url = '', contentType = '', buf = null) {
  const ct = String(contentType ?? '').toLowerCase();

  if (buf && buf.length >= 4) {
    for (const [magic, ext] of BINARY_MAGIC) if (bufStartsWith(buf, magic)) return ext;
    if (asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WEBP')) return 'webp';
    if (asciiAt(buf, 4, 'ftyp')) {
      const brand = String.fromCharCode(...buf.slice(8, 12));
      return brand.startsWith('avif') || brand.startsWith('avis') ? 'avif'
        : brand.startsWith('qt') ? 'mov' : 'mp4';
    }
    if (ct.includes('image') || ct.includes('font')) { /* magic 未命中但类型已知，交给 CT */ }
    else {
      const head = Buffer.from(buf.slice(0, 64)).toString('latin1');
      for (const [re, ext] of TEXT_EXT) if (re.test(head)) return ext;
    }
  }

  for (const [re, ext] of CT_EXT) if (re.test(ct)) return ext;

  if (url) {
    try {
      const p = decodeURIComponent(new URL(url, 'https://x.local').pathname);
      const m = URL_EXT.exec(p);
      if (m) return m[1].toLowerCase().replace('jpeg', 'jpg');
    } catch { /* 非法 URL：落到 bin */ }
  }
  return 'bin';
}
