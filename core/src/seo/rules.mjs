/**
 * seo/rules — SEO 规则引擎（纯函数：无 IO、无浏览器）
 *
 * 输入：collect.mjs 产出的页面信号 + 站点聚合上下文
 * 输出：issues[]（每条含 证据 / 修复建议 / 严重度）与分数
 *
 * 规则命名：<category>-<slug>，便于报告筛选与 CI 基线对比。
 */
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
  if (site.noindexIntent !== true && page.meta.noindex) A('index-noindex', 'index', 'high', '页面被标记 noindex', 'meta robots / X-Robots-Tag 含 noindex', page.robotsMeta || page.xRobots, '若页面需要收录，移除 noindex；若有意为之，请在报告中标注为豁免');
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
  // 多语言站点最常见的三类错误都在这里。
  const hl = page.hreflang ?? [];
  if (hl.length) {
    const selfPaths = new Set([normPath(page.finalUrl), normPath(page.url), normPath(page.canonical)]);
    const hasSelf = hl.some(h => selfPaths.has(normPath(h.href)));
    if (!hasSelf) {
      A('index-hreflang-no-self', 'index', 'medium', 'hreflang 缺少自指条目',
        `${hl.length} 条 hreflang，没有一条指回本页`,
        hl.slice(0, 3).map(h => `${h.lang} → ${h.href}`).join('\n'),
        'hreflang 集合必须包含指向自身的条目，否则整组会被忽略');
    }
    const rel = hl.filter(h => h.href && !/^https?:\/\//i.test(h.href));
    if (rel.length) {
      A('index-hreflang-relative', 'index', 'medium', 'hreflang 使用了相对地址',
        `${rel.length} 条不是绝对 URL`,
        rel.slice(0, 3).map(h => `${h.lang} → ${h.href}`).join('\n'),
        'hreflang 的 href 必须是完整的绝对 URL（含协议与域名）');
    }
    const bad = hl.filter(h => !isValidHreflang(h.lang));
    if (bad.length) {
      A('index-hreflang-invalid-code', 'index', 'low', 'hreflang 语言代码不合法',
        `${bad.length} 条无法解析为语言或语言-地区`,
        bad.slice(0, 5).map(h => h.lang).join(', '),
        '用 ISO 639-1 语言码，可选叠加 ISO 3166-1 alpha-2 地区（如 zh-CN、en），或多语言用 x-default');
    }
    if (hl.length > 1 && !hl.some(h => String(h.lang).toLowerCase() === 'x-default')) {
      A('index-hreflang-xdefault-missing', 'index', 'low', 'hreflang 缺少 x-default',
        `${hl.length} 条 hreflang 未提供默认版本`,
        '',
        'x-default 用于"语言都没匹配上"的访客，通常是语言选择页或英文版');
    }
  }

  // ---------- 内容是否依赖 JS 渲染 ----------
  // 依据是采集层额外取的**服务端原始 HTML**（未经脚本执行）。
  // 这一组规则回答的是一个此前完全没被检查的问题：
  // 用浏览器看到的页面很完整，但爬虫第一遍看到的是什么？
  // 渲染后审计对 SPA 一律给满分，因为它量的是浏览器里的样子。
  const raw = page.raw;
  if (raw?.ok) {
    if (page.title && !raw.title) {
      A('index-raw-title-missing', 'index', 'high', 'title 只存在于渲染后',
        '服务端 HTML 无 <title>，执行脚本后才出现',
        `原始 HTML ${Math.round(raw.bytes / 1024)}KB`,
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
        `服务端 HTML 约 ${raw.wordCount} 词，渲染后 ${page.wordCount} 词（${pct}%）`,
        `原始 HTML ${Math.round(raw.bytes / 1024)}KB，脚本 ${page.resources.requests} 个请求`,
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
  if (page.wordCount < 300) A('content-thin', 'content', 'medium', '内容偏薄', `可见正文约 ${page.wordCount} 词`, '', '补充对用户有价值的内容（≥300 词为参考线）');
  if (page.textRatio < 0.08 && page.htmlBytes > 20_000) A('content-text-ratio', 'content', 'low', '文本/HTML 比例偏低', `${(page.textRatio * 100).toFixed(1)}%`, `HTML ${Math.round(page.htmlBytes / 1024)}KB`, '减少无效标记，提高正文占比');
  if (!page.lang) A('content-lang-missing', 'content', 'medium', '缺少 html lang', '', '', '设置 <html lang="zh-CN"> 等语言属性');
  if (page.imgMissingAlt > 0) A('content-img-alt', 'content', 'medium', '图片缺少 alt', `${page.imgMissingAlt}/${page.imgTotal} 张`, '', '为内容图片补充 alt，装饰图使用 alt=""');
  if (page.imgBroken > 0) A('content-img-broken', 'content', 'high', '图片加载失败', `${page.imgBroken} 张`, '', '修复图片地址或移除坏链');
  if (page.links.emptyAnchor > 0) A('content-empty-anchor', 'content', 'low', '空锚文本链接', `${page.links.emptyAnchor} 个`, '', '为链接补充可读锚文本（图标链接加 aria-label）');

  // ---------- 结构化数据与社交 ----------
  const badJsonLd = (page.jsonld || []).filter(j => !j.ok);
  if (badJsonLd.length) A('structured-jsonld-error', 'structured', 'medium', 'JSON-LD 解析失败', `${badJsonLd.length} 段`, badJsonLd[0].error, '修复 JSON 语法并重新校验');
  const types = [...new Set((page.jsonld || []).flatMap(j => j.types || []))];
  if (!types.length && !page.microdataCount) A('structured-none', 'structured', 'info', '未发现结构化数据', '', '', '按页面类型补充 Organization / Product / FAQ / Breadcrumb 等 Schema');
  if (!page.og.title) A('structured-og-title', 'structured', 'low', '缺少 og:title', '', '', '补充 Open Graph 标签，提升分享卡片质量');
  if (!page.og.image) A('structured-og-image', 'structured', 'low', '缺少 og:image', '', '', '提供 1200×630 社交分享图');
  if (!page.twitter.card) A('structured-twitter-card', 'structured', 'info', '缺少 twitter:card', '', '', '补充 Twitter Card 元数据');

  // ---------- 性能与体验 ----------
  if (page.vitals.lcp != null && page.vitals.lcp > 4000) A('perf-lcp-poor', 'perf', 'high', 'LCP 过慢', `${(page.vitals.lcp / 1000).toFixed(2)}s（目标 ≤2.5s）`, '', '优化首屏主图/字体/阻塞资源');
  else if (page.vitals.lcp != null && page.vitals.lcp > 2500) A('perf-lcp-slow', 'perf', 'medium', 'LCP 偏慢', `${(page.vitals.lcp / 1000).toFixed(2)}s（目标 ≤2.5s）`, '', '优化 LCP 元素与关键路径');
  if (page.vitals.cls != null && page.vitals.cls > 0.25) A('perf-cls-poor', 'perf', 'high', 'CLS 严重', `${page.vitals.cls.toFixed(3)}（目标 ≤0.1）`, '', '为媒体设置尺寸、避免内容注入跳动');
  else if (page.vitals.cls != null && page.vitals.cls > 0.1) A('perf-cls-warn', 'perf', 'medium', 'CLS 偏高', `${page.vitals.cls.toFixed(3)}（目标 ≤0.1）`, '', '预留广告/图片/字体占位空间');
  if (page.vitals.fcp != null && page.vitals.fcp > 3000) A('perf-fcp-slow', 'perf', 'low', 'FCP 偏慢', `${(page.vitals.fcp / 1000).toFixed(2)}s`, '', '减少首屏阻塞资源');
  if (page.resources.transferBytes > 3 * 1024 * 1024) A('perf-weight-large', 'perf', 'medium', '页面体积过大', `${(page.resources.transferBytes / 1024 / 1024).toFixed(2)}MB`, `${page.resources.requests} 个请求`, '压缩/懒加载/按需加载资源');
  if (page.resources.jsBytes > 1024 * 1024) A('perf-js-large', 'perf', 'medium', 'JS 体积过大', `${(page.resources.jsBytes / 1024).toFixed(0)}KB`, '', '代码分割、移除未使用依赖');
  if (page.resources.requests > 120) A('perf-requests-many', 'perf', 'low', '请求数过多', `${page.resources.requests} 个`, '', '合并请求、延迟非关键资源');
  if (page.resources.renderBlocking > 6) A('perf-render-blocking', 'perf', 'low', '阻塞渲染资源偏多', `${page.resources.renderBlocking} 个`, '', '内联关键 CSS、异步加载非关键 JS');
  if (!page.viewport) A('perf-viewport-missing', 'perf', 'high', '缺少 viewport', '', '', '添加 <meta name="viewport" content="width=device-width, initial-scale=1">');
  if (page.imgLegacy > 0 && page.imgLegacy > page.imgTotal * 0.5) A('perf-img-format', 'perf', 'info', '图片格式偏旧', `${page.imgLegacy}/${page.imgTotal} 张为 jpg/png`, '', '优先 WebP/AVIF，保留兼容回退');

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
  for (const [value, urls] of dupTitle) S('content-title-duplicate', 'content', 'medium', 'title 重复', `${urls.length} 个页面使用同一 title`, `${trim(value, 70)}\n${urls.slice(0, 5).join('\n')}`, '为每个页面编写独立 title');
  const dupDesc = Object.entries(site.duplicates?.description ?? {}).filter(([, urls]) => urls.length > 1);
  for (const [, urls] of dupDesc) S('content-description-duplicate', 'content', 'medium', 'description 重复', `${urls.length} 个页面使用同一 description`, urls.slice(0, 5).join('\n'), '为每个页面编写独立描述');

  const pagesWithoutSitemap = (site.pages || []).filter(p => p.status < 400 && !p.meta.noindex && site.sitemapUrls?.size && !site.sitemapUrls.has(p.finalUrl) && !site.sitemapUrls.has(p.url));
  if (pagesWithoutSitemap.length) S('index-sitemap-missing-page', 'index', 'low', '可索引页面未出现在 sitemap', `${pagesWithoutSitemap.length} 个页面`, pagesWithoutSitemap.slice(0, 5).map(p => p.url).join('\n'), '更新 sitemap 或确认页面是否应被索引');
  if (site.robots && site.robots.status === 404) S('index-robots-missing', 'index', 'low', '缺少 robots.txt', 'robots.txt 返回 404', '', '提供 robots.txt 并声明 sitemap');
  if (site.sitemapChecked && site.sitemapUrls?.size === 0) S('index-sitemap-missing', 'index', 'medium', '未发现 sitemap', '已请求 sitemap 地址但未得到有效 XML', '', '提供 XML sitemap 并在 robots.txt 中声明');

  for (const url of site.orphans ?? []) S('links-orphan', 'links', 'low', '孤儿页（无站内入链）', url, '', '从导航/相关页添加内链，提升发现与权重传递');
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

/** 归一化成可比较的 "host/path"（去 www、去尾斜杠），用于 hreflang 自指判定 */
function normPath(u) {
  if (!u) return '';
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/+$/, '');
  } catch { return ''; }
}

/**
 * hreflang 取值是否合法。
 * 允许：x-default；ISO 639-1/2/3 语言码，可选叠加地区或文字系统
 * （en、zh-CN、pt-BR、sr-Latn、zh-Hant-HK）。
 * 不接受：空值、下划线分隔（zh_CN 是常见笔误）、单字母、地区在前。
 */
function isValidHreflang(code) {
  const s = String(code ?? '').trim();
  if (!s) return false;
  if (s.toLowerCase() === 'x-default') return true;
  if (s.includes('_')) return false;                 // 必须是连字符
  const parts = s.split('-');
  if (!/^[a-z]{2,3}$/i.test(parts[0])) return false; // 语言码
  for (const p of parts.slice(1)) {
    // 地区（两位字母 / 三位数字）或文字系统（四位字母，首字母大写）
    if (!/^([a-z]{2}|[0-9]{3}|[a-z]{4})$/i.test(p)) return false;
  }
  return parts.length <= 3;
}
