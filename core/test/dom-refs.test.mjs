/**
 * dom-refs — HTML 资产引用的识别与清理
 *
 * 两个坑都是实测踩出来的，所以每个都单独钉一个用例：
 *   · rel 是**空格分隔的 token 列表**，整串比较会漏掉 rel="preload stylesheet"
 *   · **根相对路径（/foo.css）也是残留** —— 克隆挂在 /static/<host>/pages/<page>/clone/
 *     下，/foo.css 会打到引擎根，一样 404
 *
 * 真实来源：vitest.dev 首页克隆后有两个 <link> 指向原站根路径、本地 404，
 * 而当时的自检报的是 "leftover: 0"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { relTokens, stripAssetLinkTags, findStrayRefs, isStrayRef, rasterizeCanvases, applyVideoPosters, materializeMediaPosters, dropCrossoriginOnLocalRefs, neutralizeBaseTag, replaceRefTable, rewriteMappedHtmlRefs, DROP_RELS, ASSET_RELS } =
  await import('../src/dom-refs.mjs');

/**
 * 整表替换。原实现是 `for (k in table) html = html.split(k).join(v)` ——
 * 一个资源地址是另一个的前缀时（版本参数、A/B 变体），短的先命中就把长的改坏，
 * 而长的那条随后再也匹配不上自己：**这个变体悄悄指向了另一个文件的字节**。
 * 下游自检抓不到（findStrayRefs 只认"还留在绝对地址"，不认"指到了错的本地文件"）。
 */
test('replaceRefTable: 长键优先 —— 前缀键不会被短的先吃掉', () => {
  const html = '<img src="https://cdn.test/a.png?v=2"><img src="https://cdn.test/a.png">';
  const table = { 'https://cdn.test/a.png': 'assets/a.png', 'https://cdn.test/a.png?v=2': 'assets/a-v2.png' };
  assert.equal(replaceRefTable(html, table), '<img src="assets/a-v2.png"><img src="assets/a.png">');

  // 反例：这正是原来的写法（按插入顺序逐条 split/join）。
  // 短的 `.../a.png` 是长的前缀，先替换就把 `.../a.png?v=2` 改成了 `assets/a.png?v=2` ——
  // 那个文件并不存在，而静态服务会忽略查询串、拿 `assets/a.png` 顶上：
  // 于是这个变体**静默拿到了另一个资源的字节**，长键那条再也匹配不上。
  let naive = html;
  for (const [k, v] of Object.entries(table)) naive = naive.split(k).join(v);
  assert.equal(naive, '<img src="assets/a.png?v=2"><img src="assets/a.png">', '前提：旧写法确实会改错');
  assert.notEqual(naive, replaceRefTable(html, table));
});

test('replaceRefTable: 常见情形与逐条替换结果一致（不是"顺手改了行为"）', () => {
  const html = '<link href="https://cdn.test/x.css"><img src="https://cdn.test/y.png"><img src="/local.png">';
  const table = { 'https://cdn.test/x.css': 'styles/x.css', 'https://cdn.test/y.png': 'assets/y.png' };
  let naive = html;
  for (const [k, v] of Object.entries(table)) naive = naive.split(k).join(v);
  assert.equal(replaceRefTable(html, table), naive);
  assert.equal(replaceRefTable(html, table), '<link href="styles/x.css"><img src="assets/y.png"><img src="/local.png">');
});

test('replaceRefTable: 空表 / 无命中 / 特殊字符都是恒等或安全行为', () => {
  const html = '<img src="https://cdn.test/a+b(1).png">';
  assert.equal(replaceRefTable(html, {}), html, '空表原样返回');
  assert.equal(replaceRefTable(html, { 'https://other.test/z.png': 'assets/z.png' }), html, '没命中的原样返回');
  // 键里有正则元字符：必须当字面量处理，否则 . ( ) + 会被当成量词/分组
  assert.equal(replaceRefTable(html, { 'https://cdn.test/a+b(1).png': 'assets/p.png' }), '<img src="assets/p.png">');
  assert.equal(replaceRefTable('', { 'https://cdn.test/a.png': 'assets/a.png' }), '');
});

test('rewriteMappedHtmlRefs: deep page resolves relative assets, srcset, SVG fragment and inline CSS', () => {
  const base = 'https://hobix.com/learn/examples/A01/walk?view=1';
  const table = {
    'https://hobix.com/learn/examples/A01/assets/canal.svg': 'assets/image000.svg',
    'https://hobix.com/learn/examples/A01/assets/canal.svg?v=2': 'assets/image001.svg',
    'https://cdn.hobix.com/icons.svg': 'assets/sprite.svg',
  };
  const html = '<!doctype html><html><head></head><body>'
    + '<img src="assets/canal.svg" srcset="assets/canal.svg 1x, assets/canal.svg?v=2 2x" data-src="assets/canal.svg">'
    + '<svg><use href="https://cdn.hobix.com/icons.svg#pin"></use></svg>'
    + '<div style="background-image:url(&quot;assets/canal.svg&quot;)"></div>'
    + '<a href="next">Next</a><img src="assets/unknown.svg"></body></html>';
  const out = rewriteMappedHtmlRefs(html, table, base);
  assert.match(out, /src="assets\/image000\.svg"/);
  assert.match(out, /srcset="assets\/image000\.svg 1x, assets\/image001\.svg 2x"/);
  assert.match(out, /data-src="assets\/image000\.svg"/);
  assert.match(out, /href="assets\/sprite\.svg#pin"/);
  assert.match(out, /url\(&quot;assets\/image000\.svg&quot;\)/);
  assert.match(out, /<a href="next">/);
  assert.match(out, /src="assets\/unknown\.svg"/);
});

test('rewriteMappedHtmlRefs: HTML entity encoded query variants keep their exact asset mapping', () => {
  const out = rewriteMappedHtmlRefs(
    '<img src="assets/canal.svg?v=2&amp;w=640" srcset="assets/canal.svg?v=2&amp;w=640 1x">',
    { 'https://site.test/deep/assets/canal.svg?v=2&w=640': 'assets/image002.svg' },
    'https://site.test/deep/walk',
  );
  assert.match(out, /src="assets\/image002\.svg"/);
  assert.match(out, /srcset="assets\/image002\.svg 1x"/);
});

test('rewriteMappedHtmlRefs: empty asset map leaves source HTML untouched', () => {
  const html = '<!DOCTYPE html><img src="assets/missing.svg">';
  assert.equal(rewriteMappedHtmlRefs(html, {}, 'https://site.test/deep/walk'), html);
});

test('rewriteMappedHtmlRefs: HTML base takes precedence; untrusted base and non-asset refs stay inert', () => {
  const page = 'https://site.test/deep/page';
  const table = {
    'https://site.test/shared/a.svg': 'assets/shared.svg',
    'https://site.test/deep/a.svg': 'assets/deep.svg',
    'https://cdn.site.test/shared/a.svg': 'assets/cdn.svg',
  };
  const sameOrigin = rewriteMappedHtmlRefs('<head><base href="/shared/"></head><img src="a.svg">', table, page);
  assert.match(sameOrigin, /src="assets\/shared\.svg"/);
  const trusted = rewriteMappedHtmlRefs('<head><base href="https://cdn.site.test/shared/"></head><img src="a.svg">', table, page);
  assert.match(trusted, /src="assets\/cdn\.svg"/);
  const untrusted = rewriteMappedHtmlRefs('<head><base href="https://other.test/shared/"></head><img src="a.svg">', table, page);
  assert.match(untrusted, /src="assets\/deep\.svg"/);
  const unsafe = rewriteMappedHtmlRefs('<head><base href="javascript:alert(1)"></head><img src="a.svg"><img src="data:image/svg+xml,%3Csvg%3E"><a href="#top">top</a>', table, page);
  assert.match(unsafe, /src="assets\/deep\.svg"/);
  assert.match(unsafe, /src="data:image\/svg\+xml,%3Csvg%3E"/);
  assert.match(unsafe, /href="#top"/);
});

const ORIGIN = 'https://vitest.dev';

// ---------- rel token 解析 ----------
test('relTokens: rel 是空格分隔的 token 列表', () => {
  assert.deepEqual(relTokens('<link rel="preload stylesheet" href="/a.css">'), ['preload', 'stylesheet']);
  assert.deepEqual(relTokens('<link rel="stylesheet">'), ['stylesheet']);
  assert.deepEqual(relTokens('<link rel=Stylesheet>'), [], '无引号属性不支持，但不能崩');
  assert.deepEqual(relTokens('<link href="x">'), []);
  assert.deepEqual(relTokens('<link rel="  PRELOAD   stylesheet  ">'), ['preload', 'stylesheet']);
});

test('relTokens: 大小写不敏感、多余的空白被吃掉', () => {
  assert.deepEqual(relTokens('<LINK REL="Preload Stylesheet">'), ['preload', 'stylesheet']);
});

// ---------- 摘除 ----------
test('stripAssetLinkTags: 摘掉样式表与资源提示', () => {
  const html = [
    '<link rel="stylesheet" href="/a.css">',
    '<link rel="preload" href="/b.woff2" as="font">',
    '<link rel="preconnect" href="https://cdn.example">',
    '<link rel="modulepreload" href="/c.js">',
  ].join('\n');
  const out = stripAssetLinkTags(html);
  assert.equal(out.replace(/\s+/g, ''), '', '全部应被摘除');
});

test('stripAssetLinkTags: **多 token rel 也要摘**（这是真实缺陷的那一条）', () => {
  const html = '<link rel="preload stylesheet" href="/assets/style.C-kOEMgT.css" as="style">';
  assert.equal(stripAssetLinkTags(html).trim(), '', 'rel="preload stylesheet" 此前被整串比较漏掉');
});

test('stripAssetLinkTags: canonical / alternate 必须保留（指向原站是正确的 SEO 归属）', () => {
  const html = '<link rel="canonical" href="https://vitest.dev/">\n<link rel="alternate" type="application/rss+xml" href="/feed.xml">';
  assert.equal(stripAssetLinkTags(html), html);
});

test('stripAssetLinkTags: 不影响非 link 标签', () => {
  const html = '<img src="/a.png"><a href="/b">x</a><script src="/c.js"></script>';
  assert.equal(stripAssetLinkTags(html), html);
});

// ---------- 残留识别 ----------
test('isStrayRef: 原站绝对地址算残留', () => {
  assert.equal(isStrayRef('https://vitest.dev/a.css', ORIGIN), true);
  assert.equal(isStrayRef('https://vitest.dev', ORIGIN), true);
});

test('isStrayRef: **根相对路径也算残留**（克隆不在站点根上服务）', () => {
  assert.equal(isStrayRef('/assets/style.css', ORIGIN), true, '根相对 → 打到引擎根 → 404');
  assert.equal(isStrayRef('/vp-icons.css', ORIGIN), true);
});

test('isStrayRef: 相对路径与站外地址不算', () => {
  assert.equal(isStrayRef('assets/a.png', ORIGIN), false, '相对路径在克隆目录内，是对的');
  assert.equal(isStrayRef('./a.png', ORIGIN), false);
  assert.equal(isStrayRef('https://cdn.jsdelivr.net/x.js', ORIGIN), false, '站外是作者的选择');
  assert.equal(isStrayRef('//cdn.example.com/x.js', ORIGIN), false, '协议相对是站外');
  assert.equal(isStrayRef('#frag', ORIGIN), false);
  assert.equal(isStrayRef('data:image/png;base64,AAA', ORIGIN), false);
  assert.equal(isStrayRef('', ORIGIN), false);
});

test('isStrayRef: 同域名不同路径前缀不能误判', () => {
  // https://vitest.dev.evil.com 不应被当成同域
  assert.equal(isStrayRef('https://vitest.dev.evil.com/a.css', ORIGIN), false);
});

test('findStrayRefs: 找出真实场景里那两条（vitest.dev 首页）', () => {
  const html = [
    '<link rel="preload stylesheet" href="/assets/style.C-kOEMgT.css" as="style">',
    '<link rel="preload stylesheet" href="/vp-icons.css" as="style">',
    '<link rel="preload" href="/assets/Inter.woff2" as="font" crossorigin>',
    '<link rel="canonical" href="https://vitest.dev/">',
    '<img src="assets/logo.svg">',
  ].join('\n');
  const refs = findStrayRefs(html, ORIGIN);
  assert.deepEqual(refs.map(r => r.ref).sort(), ['/assets/Inter.woff2', '/assets/style.C-kOEMgT.css', '/vp-icons.css']);
});

test('findStrayRefs: srcset 逐个判（第一段是 URL，后面是描述符）', () => {
  const html = '<img srcset="/a.png 1x, assets/b.png 2x, https://vitest.dev/c.png 3x">';
  const refs = findStrayRefs(html, ORIGIN);
  assert.deepEqual(refs.map(r => r.ref).sort(), ['/a.png', 'https://vitest.dev/c.png']);
});

test('findStrayRefs: canonical 不算残留，但 icon/manifest 算', () => {
  const html = '<link rel="canonical" href="https://vitest.dev/">\n<link rel="icon" href="/favicon.ico">';
  const refs = findStrayRefs(html, ORIGIN);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, '/favicon.ico');
});

test('findStrayRefs: 指向未克隆页的 <a href> 不算（linker 负责接线）', () => {
  const html = '<a href="/guide/">Guide</a><a href="https://vitest.dev/api/">API</a>';
  assert.deepEqual(findStrayRefs(html, ORIGIN), []);
});

test('findStrayRefs: poster 与 src 都覆盖', () => {
  const html = '<video src="/v.mp4" poster="/p.jpg"></video>';
  assert.deepEqual(findStrayRefs(html, ORIGIN).map(r => r.kind).sort(), ['poster', 'src']);
});

test('findStrayRefs: 干净页面返回空', () => {
  const html = '<link rel="stylesheet" href="styles/cssom.css"><img src="assets/a.png"><a href="/x">x</a>';
  assert.deepEqual(findStrayRefs(html, ORIGIN), []);
});

test('findStrayRefs: origin 里的正则元字符被正确转义', () => {
  const weird = 'https://a.b.co';
  assert.equal(findStrayRefs('<img src="https://aXb.co/x.png">', weird).length, 0, 'a.b.co 的点不应作为通配');
  assert.equal(findStrayRefs('<img src="https://a.b.co/x.png">', weird).length, 1);
});

test('集合内容自洽', () => {
  assert.ok(DROP_RELS.has('stylesheet') && DROP_RELS.has('preload'));
  assert.ok(!DROP_RELS.has('canonical'));
  assert.ok(ASSET_RELS.has('icon') && ASSET_RELS.has('manifest'));
  assert.ok(!ASSET_RELS.has('canonical') && !ASSET_RELS.has('alternate'));
});

// ---------- 画布光栅化替换 ----------
test('rasterizeCanvases: 已光栅化的 canvas 换成 img，保留尺寸与类名', () => {
  const html = '<div class="wrap"><canvas width="718" height="331" class="w-full" data-heimdall-canvas="0"></canvas></div>';
  const { html: out, count } = rasterizeCanvases(html);
  assert.equal(count, 1);
  assert.match(out, /<img src="assets\/canvas-0\.png"/);
  assert.match(out, /class="w-full"/);
  assert.match(out, /width="718"/);
  assert.match(out, /height="331"/);
  assert.match(out, /alt=""/);
  assert.doesNotMatch(out, /<canvas/);
});

test('rasterizeCanvases: **没抓到的保持原样**，不伪装成已处理', () => {
  // 空白画布（从未绘制）或跨域污染（读不到像素）不该被换成一张空图 ——
  // 那样只是把"缺失"藏起来。
  const html = '<canvas width="10" height="10"></canvas>';
  const { html: out, count } = rasterizeCanvases(html);
  assert.equal(count, 0);
  assert.equal(out, html);
});

test('rasterizeCanvases: 混合场景只替换抓到的那些', () => {
  const html = '<canvas data-heimdall-canvas="0" width="1" height="1"></canvas><canvas width="2" height="2"></canvas>';
  const { html: out, count } = rasterizeCanvases(html);
  assert.equal(count, 1);
  assert.equal((out.match(/<canvas/g) ?? []).length, 1, '未抓到的那个要留着');
  assert.equal((out.match(/<img/g) ?? []).length, 1);
});

test('rasterizeCanvases: 自闭合写法也能处理', () => {
  const { count } = rasterizeCanvases('<canvas width="4" height="4" data-heimdall-canvas="2" />');
  assert.equal(count, 1);
});

test('rasterizeCanvases: 不影响其它元素与既有 img', () => {
  const html = '<img src="assets/a.png"><canvas data-heimdall-canvas="1"></canvas><div>x</div>';
  const { html: out } = rasterizeCanvases(html);
  assert.ok(out.startsWith('<img src="assets/a.png">'));
  assert.ok(out.endsWith('<div>x</div>'));
});

test('rasterizeCanvases: 可自定义资产目录', () => {
  const { html: out } = rasterizeCanvases('<canvas data-heimdall-canvas="3"></canvas>', { assetDir: 'media' });
  assert.match(out, /src="media\/canvas-3\.png"/);
});

test('rasterizeCanvases: 空输入 / 无画布不炸', () => {
  assert.deepEqual(rasterizeCanvases('').count, 0);
  assert.equal(rasterizeCanvases('<div>hi</div>').html, '<div>hi</div>');
});

test('rasterizeCanvases: **inline style 必须留着** —— 它是"这个元素看得见"的唯一依据', () => {
  // 实测 vercel.com 首页：hero 的三角形画布类名是 `opacity-0 transition-opacity`
  // （设计上由脚本淡入），真正让它可见的是脚本写上去的 inline `style="opacity: 1;"`。
  // 旧实现只搬 class/width/height，style 一丢，类名里的 opacity-0 就赢了 ——
  // 画布光栅图抓得好好的，静态镜像里却是一块空白。
  const html = '<canvas data-heimdall-canvas="0" class="absolute inset-0 block h-full w-full opacity-0" style="opacity: 1;" width="1080" height="720"></canvas>';
  const { html: out } = rasterizeCanvases(html);
  assert.match(out, /style="opacity: 1;"/);
  assert.match(out, /class="absolute inset-0 block h-full w-full opacity-0"/);
});

test('rasterizeCanvases: id / aria-* / data-* 等原有属性一并保留', () => {
  // id 可能被 CSS 选中（#hero-canvas{…}），aria 决定它读出来是什么 —— 都不是装饰性信息
  const html = '<canvas id="hero" role="img" aria-label="示意图" data-v-app="" data-heimdall-canvas="7"></canvas>';
  const { html: out } = rasterizeCanvases(html);
  assert.match(out, /id="hero"/);
  assert.match(out, /aria-label="示意图"/);
  assert.match(out, /role="img"/);
  assert.equal((out.match(/data-heimdall-canvas/g) ?? []).length, 0, '标记本身要去掉，否则下次重建会重复处理');
});

test('rasterizeCanvases: 元素自带无障碍名时不再强塞 alt=""', () => {
  const { html: out } = rasterizeCanvases('<canvas aria-label="图表" data-heimdall-canvas="1"></canvas>');
  assert.doesNotMatch(out, /alt=""/);
  const plain = rasterizeCanvases('<canvas data-heimdall-canvas="1"></canvas>').html;
  assert.match(plain, /alt=""/, '没有无障碍名的装饰性插图仍要显式标装饰');
});

// ---------- 自定义媒体元素的 poster 兜底 ----------
// 实测 vercel.com/customers：首屏五张客户故事卡是 `<mux-player poster="…">`。
// 自定义元素的画面是**脚本建的 shadow DOM**，静态镜像剥了脚本，于是元素、类名、
// 渐变遮罩、文案全在，**只有画面没了** —— 一个 412,755 像素的差异块独占该页 99.8% 的差异。
// 光栅化量不准框（见 ROADMAP），但 poster 是**声明在属性里的**，根本不用量框。
test('materializeMediaPosters: 带 poster 的自定义元素换成 img', () => {
  const html = '<div class="aspect-video"><mux-player poster="assets/image012.png" playback-id="abc" class="size-full scale-105"></mux-player></div>';
  const { html: out, count } = materializeMediaPosters(html);
  assert.equal(count, 1);
  assert.match(out, /<img src="assets\/image012\.png"/);
  assert.match(out, /class="size-full scale-105"/);
  assert.doesNotMatch(out, /<mux-player/);
  assert.doesNotMatch(out, /poster=/, 'poster 已经是 src 了，留着是无效属性');
});

test('materializeMediaPosters: --media-object-fit / -position 映射到 object-fit / object-position', () => {
  // 原站就是用这两个自定义属性声明"这张图该怎么铺"的，照搬是最忠实的做法
  const html = '<mux-player poster="a.png" style="--media-object-fit:cover;--media-object-position:center;--controls:none"></mux-player>';
  const { html: out } = materializeMediaPosters(html);
  assert.match(out, /object-fit:cover/);
  assert.match(out, /object-position:center/);
  assert.match(out, /--controls:none/, '无关键的自定义属性不必删');
});

test('materializeMediaPosters: 有真实子内容的元素不动（可能只是恰好带了个 poster）', () => {
  const html = '<my-card poster="a.png"><p>标题</p></my-card>';
  const { html: out, count } = materializeMediaPosters(html);
  assert.equal(count, 0);
  assert.equal(out, html);
});

test('materializeMediaPosters: 没有 poster 的自定义元素不动 —— 没有可用的替身就别动它', () => {
  const html = '<my-chart data-values="1,2,3"></my-chart>';
  assert.equal(materializeMediaPosters(html).count, 0);
});

test('materializeMediaPosters: 标准元素不碰（video 的 poster 由 applyVideoPosters 负责）', () => {
  const html = '<video poster="assets/video-0.png" src="a.mp4"></video><img poster="x.png">';
  const { html: out, count } = materializeMediaPosters(html);
  assert.equal(count, 0);
  assert.equal(out, html);
});

test('materializeMediaPosters: poster 仍是原站绝对地址时也替换，但分开计数（离线不干净要看得见）', () => {
  const html = '<mux-player poster="https://assets.vercel.com/x.png"></mux-player>';
  const { html: out, count, remote } = materializeMediaPosters(html);
  assert.equal(count, 1);
  assert.equal(remote, 1);
  assert.match(out, /src="https:\/\/assets\.vercel\.com\/x\.png"/);
});

test('materializeMediaPosters: 只丢"被换掉那个元素的行为属性"，class 里同名的词不能碰', () => {
  // 布尔属性名的正则要是直接在整串上删，`class="a muted b"` 会被误伤。
  // 属性必须先按 token 拆开，引号内的内容整体是一个值。
  const html = '<mux-player poster="a.png" class="size-full muted loop" muted loop preload="none" playback-id="abc" player-software-name="mux-player-react" id="k1" data-x="1" aria-label="客户故事"></mux-player>';
  const { html: out } = materializeMediaPosters(html);
  assert.match(out, /class="size-full muted loop"/, 'class 的值一个字符都不能少');
  assert.match(out, /id="k1"/);
  assert.match(out, /data-x="1"/);
  assert.match(out, /aria-label="客户故事"/);
  assert.doesNotMatch(out, /muted=/, '原元素自己的 muted 属性要去掉');
  assert.doesNotMatch(out, /preload=|playback-id=|player-software-name=/);
});

// ---------- 本地化之后的 crossorigin ----------
// 实测 apify.com/home：Actor 头像卡是 `<img crossorigin="anonymous" src="assets/image005.webp">`。
// 资产已经本地化，但 crossorigin 留着 —— 于是**用 file:// 打开克隆页时（就是我们承诺的
// "双击即看"）浏览器以 CORS 模式去取一个没有 CORS 头的本地文件，图片被拦掉**：
// 屏幕上是一排裂图占位框，把标题挤成两列、截断文案。
// 同一份产物经 http 打开则一切正常 —— 所以这个坑只在"离线打开"时显形。
test('dropCrossoriginOnLocalRefs: 已本地化的引用去掉 crossorigin', () => {
  const html = '<img crossorigin="anonymous" src="assets/image005.webp" width="40" height="40" alt="avatar">';
  const { html: out, count } = dropCrossoriginOnLocalRefs(html);
  assert.equal(count, 1);
  assert.doesNotMatch(out, /crossorigin/);
  assert.match(out, /src="assets\/image005\.webp"/);
  assert.match(out, /alt="avatar"/);
});

test('dropCrossoriginOnLocalRefs: 仍是外链的不动 —— 那边的 CORS 是真的要谈的', () => {
  const remote = '<img crossorigin="anonymous" src="https://cdn.test/a.png">';
  assert.equal(dropCrossoriginOnLocalRefs(remote).count, 0);
  assert.equal(dropCrossoriginOnLocalRefs(remote).html, remote);
  const protoRel = '<img crossorigin="anonymous" src="//cdn.test/a.png">';
  assert.equal(dropCrossoriginOnLocalRefs(protoRel).count, 0);
  const dataUri = '<img crossorigin="anonymous" src="data:image/gif;base64,R0lGOD">';
  assert.equal(dropCrossoriginOnLocalRefs(dataUri).count, 0);
});

test('dropCrossoriginOnLocalRefs: srcset 里的第一项决定判断', () => {
  const { count } = dropCrossoriginOnLocalRefs('<img crossorigin="anonymous" srcset="assets/a.webp 1x, assets/b.webp 2x">');
  assert.equal(count, 1);
});

test('dropCrossoriginOnLocalRefs: 没带 crossorigin 的不动；class 里的同名词不受影响', () => {
  const plain = '<img src="assets/a.png">';
  assert.equal(dropCrossoriginOnLocalRefs(plain).html, plain);
  const { html: out } = dropCrossoriginOnLocalRefs('<img crossorigin class="x crossorigin y" src="assets/a.png">');
  assert.match(out, /class="x crossorigin y"/, 'class 的值一个字符都不能少');
  assert.doesNotMatch(out, /<img crossorigin/);
});

test('dropCrossoriginOnLocalRefs: 只碰 <img>（video/script 的 crossorigin 语义不同）', () => {
  const html = '<video crossorigin="anonymous" src="assets/v.mp4"></video><script crossorigin="anonymous" src="a.js"></script>';
  assert.equal(dropCrossoriginOnLocalRefs(html).count, 0);
});

test('materializeMediaPosters: 空输入 / 自闭合写法不炸', () => {
  assert.equal(materializeMediaPosters('').count, 0);
  assert.equal(materializeMediaPosters('<mux-player poster="a.png" />').count, 1);
});

// ---------- <base href> 归一（Angular 类应用会把全站相对引用改基到根）----------

test('base: <base href="/"> 改成文档相对 —— 否则 styles/ 与 assets/ 全部 404', () => {
  assert.equal(neutralizeBaseTag('<head><base href="/"><title>x</title></head>'),
    '<head><base href="./"><title>x</title></head>');
});

test('base: 单引号与无引号写法都归一', () => {
  assert.equal(neutralizeBaseTag(`<base href='/sub/'>`), `<base href="./">`);
  assert.equal(neutralizeBaseTag('<base href=/>'), '<base href="./">');
});

test('base: 没有 href 的 <base target> 原样保留', () => {
  const t = '<base target="_blank">';
  assert.equal(neutralizeBaseTag(t), t);
});

test('base: 大小写与自闭合都认', () => {
  assert.equal(neutralizeBaseTag('<BASE HREF="/" />'), '<BASE href="./" />');
});

test('base: 没有 base 标签的 HTML 不变', () => {
  const html = '<html><head><link rel="stylesheet" href="styles/cssom.css"></head></html>';
  assert.equal(neutralizeBaseTag(html), html);
});

/**
 * applyVideoPosters —— 给没有 poster 的视频补一张静态图
 *
 * 回归背景：`<video preload="metadata">` 且无 poster 时浏览器**什么都不画**（纯黑），
 * 而原站那一帧是脚本 play() 之后才有的，镜像里没有脚本。
 * 实测 linear.app/customers-ramp 的视频独占 386,303 像素差异，像素分被压到 64.7%。
 */
test('applyVideoPosters: 带标记的 <video> 补上 poster，标记本身清掉', () => {
  const html = '<video preload="metadata" src="assets/media002.mp4" data-heimdall-poster="2" class="v"></video>';
  const { html: out, count } = applyVideoPosters(html);
  assert.equal(count, 1);
  assert.match(out, /poster="assets\/video-2\.png"/);
  assert.doesNotMatch(out, /data-heimdall-poster/, '标记只是交接用的，不该留在产物里');
  assert.match(out, /src="assets\/media002\.mp4"/, '原来的属性一个都不能丢');
  assert.match(out, /class="v"/);
});

test('applyVideoPosters: 原站自带 poster 的以原站为准，不覆盖', () => {
  const html = '<video poster="assets/poster.jpg" src="a.mp4" data-heimdall-poster="0"></video>';
  const { html: out, count } = applyVideoPosters(html);
  assert.equal(count, 0);
  assert.match(out, /poster="assets\/poster\.jpg"/);
  assert.doesNotMatch(out, /video-0\.png/);
  assert.doesNotMatch(out, /data-heimdall-poster/);
});

test('applyVideoPosters: 没标记的视频不动（没截到海报就保持原样，不假装处理过）', () => {
  const html = '<video src="a.mp4"></video>';
  const { html: out, count } = applyVideoPosters(html);
  assert.equal(count, 0);
  assert.equal(out, html);
  assert.deepEqual(applyVideoPosters(''), { html: '', count: 0 });
});
