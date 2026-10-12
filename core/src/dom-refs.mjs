/**
 * dom-refs — HTML 里的资产引用识别与清理
 *
 * 抽成独立模块是因为这两个判断都是**纯字符串逻辑**、且都踩过坑，
 * 需要一个能被单测直接喂输入的地方（build_clone.mjs 是 CLI，import 即执行）。
 *
 * 两个真实的坑：
 *
 * ① **rel 是空格分隔的 token 列表，不是单个值**（HTML 规范）。
 *    原实现用 `/<link[^>]*rel="stylesheet"[^>]*>/` 精确匹配，
 *    漏掉了 `rel="preload stylesheet"`。实测 vitest.dev 首页就有
 *    `<link rel="preload stylesheet" href="/assets/style.C-kOEMgT.css" as="style">`，
 *    于是它被原样留进克隆、指向原站根路径、本地 404。
 *    像素分仍是 99.96%（最终样式已在 cssom.css 里），所以肉眼完全看不出来。
 *
 * ② **根相对路径（/foo.css）也算"残留"**。它不带域名，看起来"像是本站的"，
 *    但克隆是挂在 /static/<host>/pages/<page>/clone/ 下服务的 ——
 *    /foo.css 会打到引擎根，一样 404。
 *    原自检只统计 `href.startsWith(origin)`，于是对上面那两条报 "0"。
 *    一个会撒谎的自检比没有自检更糟：它让人相信交付物是干净的。
 */

/** <link> 标签的 rel token 列表（小写，已去空） */
export function relTokens(tag) {
  const m = /\brel\s*=\s*"([^"]*)"/i.exec(String(tag ?? ''));
  return m ? m[1].toLowerCase().split(/\s+/).filter(Boolean) : [];
}

/** 样式表与各类资源提示：这些 <link> 的内容已由 styles/<cssom> 提供，应当摘除 */
export const DROP_RELS = new Set(['stylesheet', 'preload', 'preconnect', 'dns-prefetch', 'modulepreload', 'prefetch']);

/** 属于资产类的 rel（canonical / alternate / next / prev 不算） */
export const ASSET_RELS = new Set([
  'stylesheet', 'icon', 'shortcut', 'apple-touch-icon', 'mask-icon', 'manifest',
  'preload', 'modulepreload', 'prefetch', 'preconnect', 'dns-prefetch',
]);

/**
 * 摘掉样式表与资源提示的 <link>（按 token 判断，不是整串比较）。
 * @param {string} html
 * @param {Set<string>} [dropRels]
 */
export function stripAssetLinkTags(html, dropRels = DROP_RELS) {
  return String(html ?? '').replace(/<link\b[^>]*>/gi, (tag) => (
    relTokens(tag).some(t => dropRels.has(t)) ? '' : tag
  ));
}

/**
 * 把 <base href> 改成文档相对（`./`）。
 *
 * 克隆页位于 `/static/<host>/pages/<page>/clone/`，但 Angular 之类的应用会带
 * `<base href="/">` —— 浏览器据此把**所有相对引用**改基到站点根，于是
 * `styles/cssom.css` 被解析成 `/styles/cssom.css` 而 404，
 * `assets/image000.svg` 同理。整页样式与图片一起失效（实测 angular.dev 首页
 * 裸奔成无样式 HTML，像素掉到 89.7%）。
 *
 * 保留元素本身（有些脚本会检测它存在），只把 href 改成 `./` —— 相对文档解析，
 * 无论通过 /static 还是 file:// 打开都成立。没有 href 的 `<base target="...">` 原样保留。
 *
 * 为什么之前没暴露：VitePress / Docusaurus / 多数营销站不带 <base>，
 * 换到 Angular 才第一次踩到。
 */
export function neutralizeBaseTag(html) {
  return String(html ?? '').replace(/<base\b[^>]*>/gi, (tag) => {
    if (!/\bhref\s*=/i.test(tag)) return tag;
    return tag.replace(/\bhref\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'href="./"');
  });
}

/**
 * 把已光栅化的 <canvas> 换成 <img>。
 *
 * 静态镜像会剥离全部 <script>，所以画布上什么都不剩 —— 那是一整类盲区。
 * capture 阶段负责在滚动扫描时把画布像素存成 assets/canvas-<i>.png，
 * 并在元素上打 data-heimdall-canvas="<i>"；这里据此替换。
 *
 * **没抓到的保持原样**：空白画布（从未绘制）或跨域污染（读不到像素）不该
 * 被换成一张空图 —— 那样只是把"缺失"伪装成"已处理"。
 *
 * **原有属性除标记外一律保留**（实测教训，见下）。光栅图是"这个元素在那一刻长什么样"
 * 的替身，凡是决定它长什么样的东西都得跟着走：
 *   · inline style —— vercel.com 首页的三角画布类名是 `opacity-0`（设计上由脚本淡入），
 *     真正让它可见的是脚本写上去的 `style="opacity: 1;"`。旧实现只搬 class/width/height，
 *     style 一丢，类名里的 opacity-0 就赢了：图抓得好好的，镜像里却是一块空白。
 *   · id —— `#hero-canvas{…}` 这种选择器真实存在
 *   · aria-*  —— 决定它作为无障碍节点读出来是什么
 *
 * @returns {{ html: string, count: number }}
 */
export function rasterizeCanvases(html, { assetDir = 'assets' } = {}) {
  let count = 0;
  const out = String(html ?? '').replace(/<canvas\b([^>]*?)(?:\/>|>([\s\S]*?)<\/canvas>)/gi, (tag, attrs) => {
    const m = /data-heimdall-canvas\s*=\s*"(\d+)"/i.exec(attrs);
    if (!m) return tag;
    count++;
    const kept = attrs.replace(/\s*data-heimdall-canvas\s*=\s*"\d+"/i, '').trim();
    // 有 aria-label / aria-labelledby 的元素已经有名字了，再塞 alt="" 会把名字抹掉
    const named = /\balt\s*=/i.test(kept) || /\baria-label(?:ledby)?\s*=/i.test(kept);
    // 记录来源：这是画面快照，不是原元素。排查"这图哪来的"时省事。
    return `<img src="${assetDir}/canvas-${m[1]}.png"${kept ? ' ' + kept : ''}`
      + `${named ? '' : ' alt=""'} data-heimdall-raster="1">`;
  });
  return { html: out, count };
}

/** 自定义元素（标签名带连字符）—— HTML 规范里只有它们需要脚本才能建出画面 */
const CUSTOM_EL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/i;

/**
 * 换掉元素时要丢掉的那些属性：它们的含义**由被换掉的那个媒体元素定义**，
 * 挂到 <img> 上没有任何意义（`<img muted loop playsinline preload="none">` 读起来像 bug）。
 * 保留的是一切与"它长什么样/它是什么"有关的：class / style / id / aria-* / data-*。
 * poster 不在此列 —— 它已经被消费成 src 了，由调用处的 replace 单独摘掉。
 */
const MEDIA_ONLY_ATTRS = [
  'preload', 'loop', 'muted', 'autoplay', 'playsinline', 'controls', 'crossorigin',
  'playback-id', 'default-hidden-captions', 'player-software-name', 'player-software-version',
  'player-init-time', 'stream-type', 'env-key',
];

/**
 * 把属性串拆成 token（名字 + 原样的值片段）。
 *
 * 为什么不能拿正则直接在整串上删：`muted` / `loop` 这类布尔属性名的正则会在
 * **别的属性的值里**命中 —— `class="a muted b"` 被删一下就成了 `class="a  b"`（还是好的），
 * 更糟的是删成 `class="a"`。按 token 走，引号内的内容整体是一个值，动不到。
 */
function splitAttrs(s) {
  const out = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let m;
  while ((m = re.exec(s))) out.push({ name: m[1], value: m[3] ?? null, raw: m[0] });
  return out;
}

/**
 * 摘掉「引用已经本地化」的 `<img>` 上的 `crossorigin`。
 *
 * `crossorigin="anonymous"` 的意思是"以 CORS 模式取这个资源"。资产本地化之后，
 * 引用已经指向同目录的本地文件，没有跨域可言 —— 这个属性只剩副作用：
 *
 *   **用 `file://` 打开克隆页时（就是我们承诺的"双击即看"）图片会被拦掉。**
 *   浏览器对 file:// 文档给出 opaque origin，本地文件也没有 CORS 响应头，
 *   于是请求失败、img 变成裂图占位框。而占位框还是有布局尺寸的 ——
 *   它会把标题挤到第二列、把文案截断。
 *   实测 apify.com/home：一排 Actor 头像卡全裂，像素分从 100% 掉到 84.8%。
 *   同一份产物经 http（引擎的 /static）打开则完全正常 —— 所以这个坑
 *   只在"离线打开"时显形，一条在线自检永远看不见它。
 *
 * 仍是外链的（http(s):// 或协议相对 `//`）**不动**：那边的 CORS 是真的要谈的。
 * 只处理 `<img>` —— video/script 的 crossorigin 影响的是别的东西（画布污染、
 * 错误栈、SRI），语义不同，不该顺手改。
 *
 * @returns {{ html: string, count: number }}
 */
export function dropCrossoriginOnLocalRefs(html) {
  let count = 0;
  const out = String(html ?? '').replace(/<img\b([^>]*?)\/?>/gi, (tag, attrs) => {
    const tokens = splitAttrs(attrs);
    const ref = tokens.find(t => /^(src|srcset)$/i.test(t.name))?.value;
    if (!ref) return tag;
    const first = ref.replace(/^["']|["']$/g, '').split(',')[0].trim().split(/\s+/)[0];
    if (!first) return tag;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(first) || /^data:/i.test(first)) return tag;   // 仍是外链 / 内联
    if (!tokens.some(t => t.name.toLowerCase() === 'crossorigin')) return tag;
    count++;
    return '<img ' + tokens.filter(t => t.name.toLowerCase() !== 'crossorigin').map(t => t.raw).join(' ') + '>';
  });
  return { html: out, count };
}

/**
 * 把"带 poster 的自定义媒体元素"换成 <img>。
 *
 * 为什么需要：`<mux-player>` / `<video-player>` 这类组件的画面是**脚本建的 shadow DOM**。
 * 静态镜像剥了脚本，元素、类名、渐变遮罩、文案全都还在，**只有画面没了** ——
 * 肉眼一看就是"图裂了"，而 DOM 分依然是 100%。实测 vercel.com/customers：
 * 首屏五张客户故事卡都是 `<mux-player poster="…">`，一个 412,755 像素的差异块
 * 独占该页 99.8% 的差异，像素分掉到 46%。
 *
 * 为什么这次能做而"媒体组件光栅化"那次不能：那次要**量框**（Playwright 对 shadow DOM
 * 自定义元素测出的包围盒不可靠，同一页三次跑出 46%/73%/58%），而 poster 是
 * **声明在属性里的**，不用量框、不用截图、结果逐次一致。
 *
 * 与 canvas 的规矩一致：**没有可用的替身就不动它**。所以只处理
 * 「标签是自定义元素 + 带 poster + 没有真实子内容（纯壳）」这一种情况；
 * 标准元素的 poster 归 applyVideoPosters 管。
 *
 * @returns {{ html: string, count: number, remote: number }}
 *   remote = poster 仍是原站绝对地址的个数（离线不干净，得让 clone-gaps 看得见）
 */
export function materializeMediaPosters(html) {
  let count = 0, remote = 0;
  // 属性段允许引号里出现 `>`（class="a>b" 这种），否则会在标签中间断句。
  // 分两遍：自闭合写法与成对写法。HTML 里自定义元素不会自闭合，但序列化结果里见过。
  const ATTRS = '(?:[^>"\']|"[^"]*"|\'[^\']*\')*?';
  const toImg = (name, attrs) => {
    if (!CUSTOM_EL.test(name)) return null;
    const tokens = splitAttrs(attrs);
    const poster = tokens.find(t => t.name.toLowerCase() === 'poster')?.value;
    if (!poster) return null;
    const posterValue = poster.replace(/^["']|["']$/g, '');
    if (!posterValue) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(posterValue)) remote++;
    // 换掉元素时，被换掉那个元素的**行为属性**没有意义（`<img muted loop playsinline>` 读起来像 bug）；
    // 一切与"长什么样 / 是什么"有关的都留着（见 MEDIA_ONLY_ATTRS 的注释）
    const kept = tokens
      .filter(t => t.name.toLowerCase() !== 'poster' && !MEDIA_ONLY_ATTRS.includes(t.name.toLowerCase()))
      .map(t => t.raw);
    // 原站就是用这两个自定义属性声明"这张图该怎么铺"的，照搬是最忠实的做法：
    // 自适应到 <img> 的 object-fit / object-position，不然 size-full 会把图画拉变形
    const style = tokens.find(t => t.name.toLowerCase() === 'style')?.value ?? '';
    const fit = /--media-object-fit\s*:\s*([a-z-]+)/i.exec(style)?.[1];
    const pos = /--media-object-position\s*:\s*([a-z -]+?)\s*(?:;|$)/i.exec(style)?.[1];
    const extra = [fit && `object-fit:${fit}`, pos && `object-position:${pos}`].filter(Boolean).join(';');
    if (extra) {
      const i = kept.findIndex(t => /^style\s*=/i.test(t));
      if (i < 0) kept.push(`style="${extra}"`);
      else kept[i] = kept[i].replace(/"\s*$/, '').replace(/[;\s]*$/, '') + ';' + extra + '"';
    }
    count++;
    return `<img src="${posterValue}"${kept.length ? ' ' + kept.join(' ') : ''} alt="" data-heimdall-media="1">`;
  };
  let out = String(html ?? '');
  // ① 成对写法 —— 有真实子内容的不动（可能只是恰好带了个 poster，替身会丢东西）
  out = out.replace(new RegExp(`<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\\b(${ATTRS})>([\\s\\S]*?)<\\/\\1\\s*>`, 'gi'),
    (tag, name, attrs, inner) => (inner.trim() ? tag : (toImg(name, attrs) ?? tag)));
  // ② 自闭合写法
  out = out.replace(new RegExp(`<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\\b(${ATTRS})\\/>`, 'gi'),
    (tag, name, attrs) => (toImg(name, attrs) ?? tag));
  return { html: out, count, remote };
}

/**
 * 给 `<video>` 补上 poster。
 *
 * 为什么必须补：`<video preload="metadata">` 且没有 poster 时，浏览器**什么都不画** ——
 * 不是画第一帧，是纯黑。而原站那一帧是脚本调 `.play()` 之后才有的，镜像里没有脚本。
 * 结果就是整块黑：实测 linear.app/customers-ramp 的客户故事视频占 386,303 个像素的差异，
 * 占满整个"最大差异块"，像素分被压到 64.7% —— 而它跟"复刻得像不像"毫无关系，
 * 纯粹是"我们没给它一张静态图"。
 *
 * poster 在 capture 阶段截（见 capture.mjs 的 video poster 步骤）：把视频归零到第 0 帧，
 * 截图存成 `assets/video-<n>.png`。两边都是第 0 帧，所以**还更确定**了。
 *
 * 已经有 poster 的不动（原站自己的 poster 更权威），只把标记清掉。
 */
export function applyVideoPosters(html, { assetDir = 'assets' } = {}) {
  let count = 0;
  const out = String(html ?? '').replace(/<video\b([^>]*?)(\/?)>/gi, (tag, attrs, slash) => {
    const m = /data-heimdall-poster\s*=\s*"(\d+)"/i.exec(attrs);
    if (!m) return tag;
    const cleaned = attrs.replace(/\s*data-heimdall-poster\s*=\s*"\d+"/i, '');
    // 必须用 `(^|\s)poster=` 而不是 `\bposter=`：后者会被 `data-heimdall-poster` 自己命中，
    // 于是"原站已有 poster"永远为真，海报一张也补不上（这个 bug 一写出来就被单测逮住了）
    if (/(?:^|\s)poster\s*=/i.test(attrs)) return `<video${cleaned}${slash}>`;   // 原站有自己的 poster
    count++;
    return `<video${cleaned} poster="${assetDir}/video-${m[1]}.png"${slash}>`;
  });
  return { html: out, count };
}

/**
 * 这个引用在本地服务下会不会 404？
 * @param {string} value 引用原文
 * @param {string} origin 原站 origin（如 https://vitest.dev）
 * @param {string} [originRegex] 预转义的 origin（省去每次重建）
 */
export function isStrayRef(value, origin, originRegex) {
  const s = String(value ?? '').trim();
  if (!s) return false;
  if (s.startsWith(origin + '/') || s === origin) return true;
  // 根相对（单个 /）—— 裸协议相对 //cdn/x 不算，那是站外
  return s.startsWith('/') && !s.startsWith('//');
}

/**
 * 统计"指向原站或根路径、因而在本地必然 404"的资产引用数。
 *
 * 口径：
 *   · src / poster —— 单值，直接判
 *   · srcset       —— 逗号分隔的多值，逐个判（每段第一段是 URL）
 *   · <link href>  —— 仅资产类 rel；canonical/alternate 指向原站**是对的**，不算残留
 *   · <a href>     —— 不算：指向未克隆页的链接本就该回原站（由 linker 接线）
 */
export function findStrayRefs(html, origin) {
  const s = String(html ?? '');
  const re = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const out = [];
  for (const m of s.matchAll(/\b(src|poster)\s*=\s*"([^"]*)"/gi)) {
    if (isStrayRef(m[2], origin, re)) out.push({ kind: m[1], ref: m[2] });
  }
  for (const m of s.matchAll(/\bsrcset\s*=\s*"([^"]*)"/gi)) {
    for (const part of m[1].split(',')) {
      const url = part.trim().split(/\s+/)[0];
      if (url && isStrayRef(url, origin, re)) out.push({ kind: 'srcset', ref: url });
    }
  }
  for (const m of s.matchAll(/<link\b[^>]*>/gi)) {
    if (!relTokens(m[0]).some(t => ASSET_RELS.has(t))) continue;
    const href = /\bhref\s*=\s*"([^"]*)"/i.exec(m[0])?.[1];
    if (href && isStrayRef(href, origin, re)) out.push({ kind: 'link:' + relTokens(m[0]).join(' '), ref: href });
  }
  return out;
}
