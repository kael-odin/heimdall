/**
 * seo/rules — SEO 规则引擎（纯函数：无 IO、无浏览器）
 *
 * 输入：collect.mjs 产出的页面信号 + 站点聚合上下文
 * 输出：issues[]（每条含 证据 / 修复建议 / 严重度）与分数
 *
 * 规则命名：<category>-<slug>，便于报告筛选与 CI 基线对比。
 */
import { validateStructuredData } from './structured.mjs';
import { paginationPageIssues, paginationSiteIssues, samePaginationSeries } from './pagination.mjs';
import { canonUrl, httpResourceUrl } from '../url-canon.mjs';

export const CATEGORIES = {
  index: '抓取与索引',
  content: '内容与语义',
  structured: '结构化数据与社交',
  perf: '性能与体验',
  links: '链接与架构',
  security: '安全与合规',
};

export const SEVERITY_PENALTY = { critical: 25, high: 12, medium: 6, low: 2, info: 0 };
export const SEVERITY_LABEL = { critical: '严重', high: '高', medium: '中', low: '低', info: '提示' };

const mk = (page, id, category, severity, title, message, evidence, suggestion) =>
  ({ page, id, category, severity, title, message, evidence: evidence ?? '', suggestion: suggestion ?? '' });

const trim = (s, n = 90) => (s == null ? '' : String(s).replace(/\s+/g, ' ').slice(0, n));

/** 单页规则：page = collect.mjs 的页面信号，site = 聚合上下文 */
export function evaluatePage(page, site = {}) {
  const out = [];
  const A = (id, category, severity, title, message, evidence, suggestion) =>
    out.push(mk(page.url, id, category, severity, title, message, evidence, suggestion));

  // ---------- 抓取与索引 ----------
  if (page.status >= 400) A('index-http-error', 'index', 'critical', '页面返回错误状态', `HTTP ${page.status}`, page.finalUrl, '修复服务端错误或从站点移除该链接');
  if (page.redirectCount > 0) A('index-redirect', 'index', page.redirectCount > 1 ? 'medium' : 'low', '页面存在重定向', `重定向 ${page.redirectCount} 次`, `${page.url} → ${page.finalUrl}`, '将链接直接指向最终 URL，减少跳转损耗');
  if (site.noindexIntent !== true && page.meta.noindex) A('index-noindex', 'index', 'high', '页面被标记 noindex', '通用或 Googlebot 指令含 noindex / none（Google 网页搜索口径）', page.robotsEvidence?.noindex?.join('\n') || page.robotsMeta || page.xRobots, '若页面需要收录，移除相关限制；若有意为之，请在报告中标注为豁免');
  if (!page.canonical) A('index-canonical-missing', 'index', 'medium', '缺少 canonical', '未找到 rel=canonical', '', '为每个可索引页面添加自指 canonical');
  else {
    const canonicalHost = safeHost(page.canonical);
    if (canonicalHost && canonicalHost !== site.host) A('index-canonical-cross-origin', 'index', 'high', 'canonical 指向其他域名', `canonical=${trim(page.canonical)}`, page.canonical, '确认是否为跨域归并；否则改回本域自指 canonical');
    if (canonicalHost === site.host && !samePath(page.canonical, page.finalUrl)) A('index-canonical-mismatch', 'index', 'low', 'canonical 与当前 URL 不一致', `canonical=${trim(page.canonical)}`, page.finalUrl, '确认规范化目标；自指页面应指向自身');
  }
  if (page.url.length > 115) A('index-url-long', 'index', 'low', 'URL 过长', `${page.url.length} 字符`, trim(page.url, 140), '精简路径层级与参数');
  if (/(\?|&)[a-z0-9_-]+=/i.test(page.url)) A('index-url-params', 'index', 'info', 'URL 含查询参数', trim(page.url, 140), '', '确认参数页的 canonical 与收录策略（参数页易产生重复内容）');
  if (!page.security.https) A('index-not-https', 'index', 'high', '页面未使用 HTTPS', page.finalUrl, '', '全站启用 HTTPS 并跳转');
  if (page.security.mixedContent.length) A('index-mixed-content', 'index', 'medium', 'HTTPS 页面加载了 HTTP 资源', `${page.security.mixedContent.length} 个混合内容资源`, page.security.mixedContent.slice(0, 5).join('\n'), '将资源切换为 HTTPS');

  // ---------- 国际定向（hreflang） ----------
  // 采集层一直在收 link[rel=alternate][hreflang]，但此前没有任何规则用它。
  // hreflang 地址、Google 标记形式与可选回退提示。
  const hl = page.hreflang ?? [];
  if (hl.length) {
    const selfUrls = new Set([page.finalUrl, page.url, page.canonical].map(httpResourceUrl).filter(Boolean));
    const hasSelf = hl.some(h => selfUrls.has(httpResourceUrl(h.href)));
    if (!hasSelf) {
      A('index-hreflang-no-self', 'index', 'medium', 'hreflang 缺少自指条目',
        `${hl.length} 条 hreflang，没有一条指回本页`,
        hl.slice(0, 3).map(h => `${h.lang} → ${h.href}`).join('\n'),
        '核对各语言版本的自指与双向链接；当前按访问地址和声明的 canonical 匹配，未验证目标或其他 URL 的等价关系');
    }
    // 采集层会把 href 绝对化，所以判"相对地址"要看标签原值 rawHref；没有 rawHref（原始 HTML 路径、手工构造）时退回 href。
    const rel = hl.filter(h => { const v = h.rawHref ?? h.href; return v && !/^https?:\/\//i.test(v); });
    if (rel.length) {
      A('index-hreflang-relative', 'index', 'medium', 'hreflang 使用了相对地址',
        `${rel.length} 条不是绝对 URL`,
        rel.slice(0, 3).map(h => `${h.lang} → ${h.rawHref ?? h.href}`).join('\n'),
        'hreflang 的 href 必须是完整的绝对 URL（含协议与域名）');
    }
    const bad = hl.filter(h => !hasGoogleHreflangSyntax(h.lang));
    if (bad.length) {
      A('index-hreflang-invalid-code', 'index', 'low', 'hreflang 标记形式不受 Google 支持',
        `${bad.length} 条不符合 Google 的语言、脚本、地区形式；不代表 BCP 47 非法`,
        bad.slice(0, 5).map(h => h.lang).join(', '),
        '按 Google 指南使用 ISO 639-1 语言、可选脚本及 ISO 3166-1 alpha-2 地区，回退页可用 x-default；本检查不核对代码表成员');
    }
    if (hl.length > 1 && !hl.some(h => String(h.lang).toLowerCase() === 'x-default')) {
      A('index-hreflang-xdefault-missing', 'index', 'info', '可按回退需求配置 hreflang x-default',
        `${hl.length} 条 hreflang 未提供默认版本`,
        '',
        'x-default 是未匹配语言的回退建议，不是通用必填项；先核对语言选择和跳转需求，再决定是否添加');
    }
  }

  // ---------- 内容是否依赖 JS 渲染 ----------
  // 依据是采集层额外取的**服务端原始 HTML**（未经脚本执行）。
  // 这一组规则回答的是一个此前完全没被检查的问题：
  // 用浏览器看到的页面很完整，但爬虫第一遍看到的是什么？
  // 渲染后审计对 SPA 一律给满分，因为它量的是浏览器里的样子。
  const raw = page.raw;
  if (raw?.ok) {
    const rawLabel = raw.source === 'navigation' ? '初始响应' : raw.source === 'refetch' ? '后续回取' : '服务端';
    if (page.title && !raw.title) {
      A('index-raw-title-missing', 'index', 'high', 'title 只存在于渲染后',
        '服务端 HTML 无 <title>，执行脚本后才出现',
        `${rawLabel} HTML 重编码 UTF-8 约 ${Math.round(raw.bytes / 1024)} KiB`,
        'title 应由服务端直出；依赖 JS 会让不执行脚本的抓取者读到空标题');
    }
    if (page.description && !raw.description) {
      A('index-raw-description-missing', 'index', 'medium', 'meta description 只存在于渲染后',
        '服务端 HTML 无 description',
        '',
        'description 应由服务端直出，否则社交预览与部分抓取者拿不到摘要');
    }
    // 正文体量对比：只有在"渲染后确实有内容"时才判，避免把空页也算进来
    if (page.wordCount >= 100 && raw.wordCount < page.wordCount * 0.3) {
      const pct = Math.round((raw.wordCount / Math.max(1, page.wordCount)) * 100);
      A('content-js-dependent', 'content', 'high', '正文依赖 JS 渲染',
        `服务端 HTML 分词数 ${raw.wordCount}，渲染后 ${page.wordCount}（${pct}%）`,
        `${rawLabel} HTML 重编码 UTF-8 约 ${Math.round(raw.bytes / 1024)} KiB，子资源 ${page.resources.requests} 个请求`,
        '正文应服务端直出（SSR/SSG）。只靠客户端渲染时，AI 爬虫与不执行脚本的抓取者读不到内容');
    }
  }

  // ---------- 内容与语义 ----------
  if (!page.title) A('content-title-missing', 'content', 'critical', '缺少 title', '未找到 <title>', '', '为每页设置唯一、包含核心关键词的 title');
  else if (page.titleLength < 10) A('content-title-short', 'content', 'medium', 'title 过短', `${page.titleLength} 字符`, page.title, '建议 10-60 字符，覆盖核心主题');
  else if (page.titleLength > 60) A('content-title-long', 'content', 'low', 'title 过长', `${page.titleLength} 字符`, page.title, 'SERP 截断风险，建议 ≤60 字符');
  if (!page.description) A('content-description-missing', 'content', 'high', '缺少 meta description', '', '', '为每页编写 50-160 字符的独特描述');
  else if (page.descriptionLength < 50) A('content-description-short', 'content', 'low', 'description 过短', `${page.descriptionLength} 字符`, page.description, '补充价值主张与差异化信息');
  else if (page.descriptionLength > 160) A('content-description-long', 'content', 'low', 'description 过长', `${page.descriptionLength} 字符`, page.description, '建议 ≤160 字符，避免截断');
  if (page.h1.length === 0) A('content-h1-missing', 'content', 'high', '缺少 H1', '', '', '每页保留一个描述主题的 H1');
  else if (page.h1.length > 1) A('content-h1-multiple', 'content', 'medium', '存在多个 H1', `${page.h1.length} 个`, page.h1.slice(0, 3).join(' | '), '合并为单一 H1，其余降级为 H2/H3');
  if (page.headingSkips > 0) A('content-heading-skip', 'content', 'low', '标题层级跳跃', `${page.headingSkips} 处`, (page.headingLevels || []).join(' → '), '保持 H1→H2→H3 的层级顺序');
  if (page.wordCount < 300) A('content-thin', 'content', 'info', '正文长度观察', `可见正文约 ${page.wordCount} 个分词单位`, '300 仅为人工检查提示线；Google 没有排名所需的固定最低字数。', '结合页面用途核对是否回答了用户问题，不为凑字数填充内容');
  // 旧样本的 htmlBytes 实际是代码单元；保留阈值口径，但不把经验比例视作 SEO 缺陷。
  const htmlCodeUnits = page.htmlCodeUnits ?? page.htmlBytes;
  if (page.textRatio < 0.08 && htmlCodeUnits > 20_000) A('content-text-ratio', 'content', 'info', '文本/DOM 比例观察', `${(page.textRatio * 100).toFixed(1)}%`, `渲染后 DOM ${htmlCodeUnits} 个 UTF-16 代码单元`, '仅供排查内容和标记结构，不代表搜索排名问题');
  if (!page.lang) A('content-lang-missing', 'content', 'medium', '缺少 html lang', '', '', '设置 <html lang="zh-CN"> 等语言属性');
  if (page.imgMissingAlt > 0) A('content-img-alt', 'content', 'medium', '图片缺少 alt', `${page.imgMissingAlt}/${page.imgTotal} 张`, '', '为内容图片补充 alt，装饰图使用 alt=""');
  if (page.imgBroken > 0) A('content-img-broken', 'content', 'high', '图片加载失败', `${page.imgBroken} 张`, '', '修复图片地址或移除坏链');
  if (page.links.emptyAnchor > 0) A('content-empty-anchor', 'content', 'low', '空锚文本链接', `${page.links.emptyAnchor} 个`, '', '为链接补充可读锚文本（图标链接加 aria-label）');

  // ---------- 结构化数据与社交 ----------
  // 分页 / 分面：天生跨页的一类问题，单看一页看不出来
  for (const s of paginationPageIssues(page, site)) A(s.id, 'links', s.severity, s.title, s.message, s.evidence, s.suggestion);

  const badJsonLd = (page.jsonld || []).filter(j => j.ok === false);
  if (badJsonLd.length) A('structured-jsonld-error', 'structured', 'medium', 'JSON-LD 解析失败', `${badJsonLd.length} 段`, badJsonLd[0].error, '修复 JSON 语法或 JSON-LD 语义格式并重新校验');
  const uncheckedJsonLd = (page.jsonld || []).filter(j => j.semanticStatus === 'unknown');
  if (uncheckedJsonLd.some(j => j.ok !== false)) A('structured-unchecked', 'structured', 'info', 'JSON-LD 语义尚未核实', `${uncheckedJsonLd.length} 段未能使用本地上下文展开`, '未自动访问其他远程上下文；超出采集限制时也保留未知。', '先核对上下文与采集限制，再重新审计；不能据此认定缺少结构化数据');
  const types = [...new Set((page.jsonld || []).flatMap(j => j.types || []))];
  if (!types.length && !page.microdataCount && !uncheckedJsonLd.length) A('structured-none', 'structured', 'info', '未检测到 JSON-LD 类型或 microdata 标记', '', '仅检查 JSON-LD 顶层和 @graph 的类型及 microdata 标记；未检查 RDFa。', '先人工核对页面的结构化数据，再按页面需求补充 Schema');
  // 浅层格式检查与字段提示，不判定搜索功能资格。
  for (const s of validateStructuredData((page.jsonld || []).flatMap(j => j.items ?? []))) {
    A(s.id, 'structured', s.severity, s.title, s.message, s.evidence, s.suggestion);
  }
  if (!page.og.title) A('structured-og-title', 'structured', 'low', '缺少 og:title', '', '', '补充 Open Graph 标签，提升分享卡片质量');
  if (!page.og.image) A('structured-og-image', 'structured', 'low', '缺少 og:image', '', '', '提供 1200×630 社交分享图');
  if (!page.twitter.card) A('structured-twitter-card', 'structured', 'info', '缺少 twitter:card', '', '', '补充 Twitter Card 元数据');

  // ---------- 性能与体验 ----------
  if (page.vitals.lcp != null && page.vitals.lcp > 4000) A('perf-lcp-poor', 'perf', 'high', 'LCP 过慢', `${(page.vitals.lcp / 1000).toFixed(2)}s（目标 ≤2.5s）`, '', '优化首屏主图/字体/阻塞资源');
  else if (page.vitals.lcp != null && page.vitals.lcp > 2500) A('perf-lcp-slow', 'perf', 'medium', 'LCP 偏慢', `${(page.vitals.lcp / 1000).toFixed(2)}s（目标 ≤2.5s）`, '', '优化 LCP 元素与关键路径');
  if (page.vitals.cls != null && page.vitals.cls > 0.25) A('perf-cls-poor', 'perf', 'high', 'CLS 严重', `${page.vitals.cls.toFixed(3)}（目标 ≤0.1）`, '', '为媒体设置尺寸、避免内容注入跳动');
  else if (page.vitals.cls != null && page.vitals.cls > 0.1) A('perf-cls-warn', 'perf', 'medium', 'CLS 偏高', `${page.vitals.cls.toFixed(3)}（目标 ≤0.1）`, '', '预留广告/图片/字体占位空间');
  if (page.vitals.fcp != null && page.vitals.fcp > 3000) A('perf-fcp-slow', 'perf', 'low', 'FCP 偏慢', `${(page.vitals.fcp / 1000).toFixed(2)}s`, '', '减少首屏阻塞资源');
  if (page.resources.transferBytes > 3 * 1024 * 1024) A('perf-weight-large', 'perf', 'medium', '已观测子资源体积较大', `${(page.resources.transferBytes / 1024 / 1024).toFixed(2)}MB`, `${page.resources.requests} 个资源条目；估算不含主文档，缓存及跨源资源可能影响结果`, '结合网络面板核实后，按需压缩或延迟加载资源');
  if (page.resources.jsBytes > 1024 * 1024) A('perf-js-large', 'perf', 'medium', '已识别 JS 资源体积较大', `${(page.resources.jsBytes / 1024).toFixed(0)}KB`, '按浏览器发起类型和页面预加载用途估算；受未分类、缓存及跨源资源影响，结果可能不完整', '核实资源后考虑代码分割、移除未使用依赖');
  if (page.resources.requests > 120) A('perf-requests-many', 'perf', 'low', '请求数过多', `${page.resources.requests} 个`, '', '合并请求、延迟非关键资源');
  if (page.resources.renderBlocking > 6) A('perf-render-blocking', 'perf', 'low', '阻塞渲染资源偏多', `${page.resources.renderBlocking} 个`, '', '内联关键 CSS、异步加载非关键 JS');
  if (!page.viewport) A('perf-viewport-missing', 'perf', 'high', '缺少 viewport', '', '', '添加 <meta name="viewport" content="width=device-width, initial-scale=1">');
  if (page.imgLegacy > 0 && page.imgLegacy > page.imgTotal * 0.5) A('perf-img-format', 'perf', 'info', '图片地址后缀以 JPG/PNG 为主', `${page.imgLegacy}/${page.imgTotal} 个图片元素的地址匹配 jpg/png 后缀`, '仅按 currentSrc 或 src 的地址匹配；可能包含重复或未加载的元素，未核验响应类型或图片编码', '先核对实际响应格式、体积与兼容性，再决定是否转换');

  // ---------- 安全与合规 ----------
  if (page.security.https && !page.security.headers.hsts) A('security-hsts', 'security', 'low', '缺少 HSTS', 'Strict-Transport-Security 未设置', '', '启用 HSTS（确认全站 HTTPS 后）');
  if (!page.security.headers.xcto) A('security-xcto', 'security', 'info', '缺少 X-Content-Type-Options', '', '', '设置 nosniff，降低 MIME 嗅探风险');

  return out;
}

/** 站点级规则：site = { pages, host, duplicates, orphans, sitemapUrls, robots } */
export function evaluateSite(site = {}) {
  const out = [];
  const S = (id, category, severity, title, message, evidence, suggestion) =>
    out.push(mk(null, id, category, severity, title, message, evidence, suggestion));

  const dupTitle = Object.entries(site.duplicates?.title ?? {}).filter(([, urls]) => urls.length > 1);
  for (const [value, urls] of dupTitle) {
    const pagination = samePaginationSeries(urls);
    S('content-title-duplicate', 'content', pagination ? 'info' : 'medium', 'title 重复', `${urls.length} 个页面使用同一 title`, `${trim(value, 70)}\n${urls.slice(0, 5).join('\n')}`,
      pagination ? '同一分页序列允许共用标题；可按读者区分页码的需求调整，不作为强制 SEO 修复' : '为每个页面编写独立 title');
  }
  const dupDesc = Object.entries(site.duplicates?.description ?? {}).filter(([, urls]) => urls.length > 1);
  for (const [, urls] of dupDesc) {
    const pagination = samePaginationSeries(urls);
    S('content-description-duplicate', 'content', pagination ? 'info' : 'medium', 'description 重复', `${urls.length} 个页面使用同一 description`, urls.slice(0, 5).join('\n'),
      pagination ? '同一分页序列允许共用描述；按内容和展示需求决定是否细分' : '为每个页面编写独立描述');
  }

  const pagesWithoutSitemap = site.sitemapCoverage === 'complete'
    ? (site.pages || []).filter(p => p.status >= 200 && p.status < 400 && !p.meta.noindex && !site.sitemapUrls?.has(canonUrl(p.finalUrl)) && !site.sitemapUrls?.has(canonUrl(p.url))) : [];
  if (pagesWithoutSitemap.length) S('index-sitemap-missing-page', 'index', 'low', '页面未出现在已检查的 sitemap', `${pagesWithoutSitemap.length} 个页面`, pagesWithoutSitemap.slice(0, 5).map(p => p.url).join('\n'), '核对已检查的 sitemap，确认页面是否应被列入');
  if ([404, 410].includes(site.robots?.status)) S('index-robots-missing', 'index', 'info', '本次未找到 robots.txt', `本次采集返回 HTTP ${site.robots.status}`, '未模拟 Googlebot；不存在 robots.txt 本身不表示页面不能被收录', '如需控制抓取或声明 sitemap，先确认站点需求，再决定是否配置');
  if (site.sitemapCoverage === 'not_found') S('index-sitemap-missing', 'index', 'info', '已检查的位置未发现 sitemap', '已检查 robots.txt 声明及常见地址', '其他位置或提交途径未检查；未发现 sitemap 不等于页面未被收录', '按页面规模和发现情况判断是否需要 sitemap；已有地图可通过 robots.txt 或搜索平台提交');

  for (const url of site.orphans ?? []) S('links-orphan', 'links', 'low', '孤儿页（无站内入链）', url, '', '从导航/相关页添加内链，提升发现与权重传递');

  // 分页 / 分面（站点级）：把整站 URL 连起来看才知道问题有多大
  for (const s of paginationSiteIssues(site)) S(s.id, 'links', s.severity, s.title, s.message, s.evidence, s.suggestion);
  return out;
}

export function scoreIssues(issues) {
  const penalty = issues.reduce((sum, i) => sum + (SEVERITY_PENALTY[i.severity] ?? 0), 0);
  return Math.max(0, Math.round((100 - penalty) * 10) / 10);
}

export function countBySeverity(issues) {
  const out = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const i of issues) out[i.severity] = (out[i.severity] ?? 0) + 1;
  return out;
}

function safeHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }
function samePath(a, b) { try { const A = new URL(a, b), B = new URL(b); return A.hostname.replace(/^www\./, '') === B.hostname.replace(/^www\./, '') && A.pathname.replace(/\/$/, '') === B.pathname.replace(/\/$/, ''); } catch { return false; } }

/** Google annotation syntax only, not BCP 47 validity or ISO code-table membership. */
function hasGoogleHreflangSyntax(code) {
  const s = String(code ?? '').trim();
  if (s.toLowerCase() === 'x-default') return true;
  return /^[a-z]{2}(?:-[a-z]{4})?(?:-[a-z]{2})?$/i.test(s);
}
