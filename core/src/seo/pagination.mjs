/**
 * seo/pagination — 分页与分面导航
 *
 * 这一类问题在电商/列表类站点上最高频，而它**天生跨页**：单看一页看不出毛病，
 * 要连起来看才知道"参数页生成了多少可抓 URL""分页页的 title 是不是全都一样"。
 *
 * 纯函数、无 IO。返回不带 page 字段的 issue 描述，由 rules.mjs 套上页面/站点上下文，
 * 这样这一模块不依赖规则引擎，单测直接喂 URL 与页面数组。
 */

/** 常见分页参数名（同一站通常只用一种，这里求全） */
const PAGE_PARAM = ['page', 'p', 'pg', 'paged', 'pagenum', 'pagenumber', 'page_num', 'pageNumber'];

/**
 * 分面（facet）参数名：筛选/排序/规格，组合后会指数级放大可抓 URL。
 * 注意 sort/order 也算 —— 同一份内容按不同顺序再出一遍，正是重复内容的来源。
 */
const FACET_KEYS = new Set([
  'color', 'colour', 'size', 'sort', 'order', 'orderby', 'order_by', 'filter', 'filterby',
  'tag', 'tags', 'category', 'categoryid', 'cat', 'brand', 'price', 'min', 'max', 'range',
  'style', 'material', 'gender', 'view', 'layout', 'type', 'producttype', 'availability', 'rating',
]);

/** 跟踪参数：内链里带着它们，等于把同一页以多个 URL 暴露给爬虫 */
const TRACKING_KEYS = new Set(['gclid', 'fbclid', 'msclkid', 'yclid', 'dclid', 'ref', 'source', 'campaign']);
const isTracking = (k) => k.startsWith('utm_') || TRACKING_KEYS.has(k);

const parse = (u) => { try { return new URL(u); } catch { return null; } };

/** 这一页是不是分页 URL（`?page=2` 或 `/page/2` 两种常见形态） */
export function parsePagination(url) {
  const u = parse(url);
  if (!u) return { isPaginated: false, param: null, num: null };
  const param = PAGE_PARAM.find(k => u.searchParams.has(k));
  if (param) return { isPaginated: true, param, num: Number(u.searchParams.get(param)) || null };
  const m = /\/(?:page|p)\/(\d+)\/?$/i.exec(u.pathname);
  if (m) return { isPaginated: true, param: '(路径)', num: Number(m[1]) };
  return { isPaginated: false, param: null, num: null };
}

/** 这一页 URL 上带的分面参数 */
export function facetParams(url) {
  const u = parse(url);
  if (!u) return [];
  return [...u.searchParams.keys()].filter(k => FACET_KEYS.has(k.toLowerCase()) && !isTracking(k.toLowerCase()));
}

/** 这一页 URL 上带的跟踪参数 */
export function trackingParams(url) {
  const u = parse(url);
  if (!u) return [];
  return [...u.searchParams.keys()].filter(k => isTracking(k.toLowerCase()));
}

/**
 * 单页规则。
 * @param {object} page collect.mjs 的页面信号
 * @returns {Array<{id,severity,title,message,evidence,suggestion}>}
 */
export function paginationPageIssues(page) {
  const out = [];
  const pg = parsePagination(page.url);

  // 分页用 JS 按钮而不是链接：爬虫拿不到下一页的 URL。
  // 实测 blog.jetbrains.com 首页——HTML 里一个 page 链接都没有，只有"加载更多"这类按钮。
  const jsPager = page.jsPagination ?? [];
  const crawlable = (page.internalHrefs ?? []).some(h => isStructuralUrl(h));
  if (jsPager.length && !crawlable) {
    out.push({
      id: 'links-pagination-js-only', severity: 'medium',
      title: '分页只有 JS 按钮，没有可爬的链接',
      message: `页面上有「${jsPager.join('」「')}」这类控件，但没有任何指向下一页的可抓链接`,
      evidence: '按钮触发的分页对不执行 JS 的爬虫不存在：后续页的内容与内链一并看不到',
      suggestion: '把分页渲染成真实的 <a href="…?page=2"> 链接（可以同时保留按钮），确保后续页可被发现',
    });
  }

  // 分页页被 noindex：后续页的内容与内链都进不了索引，是这套做法里代价最大的一种
  if (pg.isPaginated && page.meta?.noindex) {
    out.push({
      id: 'index-pagination-noindex', severity: 'high',
      title: '分页页被标记 noindex',
      message: `第 ${pg.num ?? '?'} 页（参数 ${pg.param}）不允许索引`,
      evidence: page.url,
      suggestion: '分页页不要用 noindex：后续页的内容与链接会一并消失。要收敛重复内容请用 canonical 指向自身，或只对无价值的排序/筛选组合加 robots 规则',
    });
  }

  // 内链带跟踪参数：爬虫会把同一页当成多个 URL 反复抓
  const withTracking = (page.internalHrefs ?? []).filter(h => trackingParams(h).length);
  if (withTracking.length) {
    out.push({
      id: 'links-tracking-params', severity: 'low',
      title: '站内链接带跟踪参数',
      message: `${withTracking.length} 个站内链接带 utm/gclid 等跟踪参数`,
      evidence: withTracking.slice(0, 5).join('\n'),
      suggestion: '内链去掉跟踪参数（只在外链/广告用），否则同一页会以多个 URL 被抓取，稀释抓取预算',
    });
  }

  return out;
}

/**
 * 站点级规则：把整站的 URL 连起来看。
 * @param {{pages: Array}} site
 */
export function paginationSiteIssues(site) {
  const out = [];
  const pages = (site.pages ?? []).filter(p => p.status < 400 && !p.meta?.noindex);
  if (!pages.length) return out;

  const paged = pages.filter(p => parsePagination(p.url).isPaginated);

  // canonical 缺失是**逐页**问题，不该被"至少两页"挡住 ——
  // 实测 news.ycombinator.com 只采到一个分页 URL（/?p=2），这条就此失效了
  const noCanon = paged.filter(p => !p.canonical);
  if (noCanon.length) {
    out.push({
      id: 'links-pagination-canonical-missing', severity: 'low',
      title: '分页页缺少 canonical',
      message: `${noCanon.length} 个分页 URL 没有 canonical`,
      evidence: noCanon.slice(0, 5).map(p => p.url).join('\n'),
      suggestion: '给分页页补自指 canonical，明确它不是别的页面的副本',
    });
  }

  if (paged.length >= 2) {
    // title 全都一样：用户与搜索引擎都无法区分第几页
    const byTitle = new Map();
    for (const p of paged) {
      const t = (p.title ?? '').trim();
      if (!t) continue;
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(p.url);
    }
    const dups = [...byTitle.entries()].filter(([, urls]) => urls.length >= 2);
    if (dups.length) {
      out.push({
        id: 'links-pagination-title-duplicate', severity: 'medium',
        title: '分页页共用同一个 title',
        message: `${dups.length} 组分页页 title 完全相同`,
        evidence: dups.slice(0, 3).map(([t, urls]) => `「${t.slice(0, 50)}」× ${urls.length} 页`).join('\n'),
        suggestion: '在 title 里带页码或范围（如「博客 – 第 3 页」），让每页可区分',
      });
    }

    // canonical 用法不一致：一半自指、一半指向列表页 —— 搜索引擎无法判断意图
    const selfCanon = paged.filter(p => p.canonical && sameUrl(p.canonical, p.finalUrl ?? p.url)).length;
    const baseCanon = paged.filter(p => p.canonical && !sameUrl(p.canonical, p.finalUrl ?? p.url)).length;
    if (selfCanon && baseCanon) {
      out.push({
        id: 'links-pagination-canonical-mixed', severity: 'low',
        title: '分页页的 canonical 用法不一致',
        message: `${selfCanon} 页自指、${baseCanon} 页指向别处`,
        evidence: noCanon.length ? `另有 ${noCanon.length} 页根本没有 canonical` : '',
        suggestion: '统一策略：分页页通常自指 canonical（第 2 页指向第 2 页），不要一半一半',
      });
    }
  }

  // 分面导航：参数组合会指数级放大可抓 URL，是列表类站点最常见的问题
  const faceted = pages.filter(p => facetParams(p.url).length);
  if (faceted.length >= 3) {
    const facetedNoCanon = faceted.filter(p => !p.canonical).length;
    const facetedSelf = faceted.filter(p => p.canonical && sameUrl(p.canonical, p.finalUrl ?? p.url)).length;
    const controlled = faceted.length - facetedNoCanon - facetedSelf;   // canonical 指向了别处 = 有收敛策略
    const groups = new Map();
    for (const p of faceted) for (const k of facetParams(p.url)) groups.set(k, (groups.get(k) ?? 0) + 1);
    const topKeys = [...groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    out.push({
      id: 'links-faceted-params', severity: controlled ? 'info' : 'medium',
      title: '分面参数生成了大量可抓 URL',
      message: `${faceted.length} 个 URL 带筛选/排序参数${controlled ? `，其中 ${controlled} 个已用 canonical 收敛` : '，且都没有收敛策略'}`,
      evidence: `参数出现次数：${topKeys.map(([k, n]) => `${k}×${n}`).join('、')}
${faceted.slice(0, 5).map(p => p.url).join('\n')}`,
      suggestion: '分面页各自 canonical 到主列表页（或加 robots 规则只放行有价值的组合），否则组合数会吃掉抓取预算',
    });
  }

  return out;
}

/**
 * 归一化成 host+path+**query** 比较，忽略尾斜杠与 www。
 * 必须带上 query：分面页 canonical 到主列表页时，两者 path 相同、只有参数不同 ——
 * 只看 path 会把"已收敛"误判成"自指"，severity 就降不下来。
 */
function sameUrl(a, b) {
  try {
    const A = new URL(a), B = new URL(b);
    return A.hostname.replace(/^www\./, '') === B.hostname.replace(/^www\./, '')
      && A.pathname.replace(/\/$/, '') === B.pathname.replace(/\/$/, '')
      && A.search === B.search;
  } catch { return false; }
}

/**
 * 这一页是不是"结构性 URL"（分页或分面）。
 *
 * 用途是**抓取排序**：发现阶段按 DOM 顺序排队时，分页/分面链接通常排在页尾
 * （"下一页"按钮在底部），于是最容易被页数配额挤掉 —— 而它们恰恰是审计最该看的。
 * 实测 news.ycombinator.com：30 页配额全被首页的条目链接占满，`/?p=2` 一个都没进来。
 */
export function isStructuralUrl(url) {
  return parsePagination(url).isPaginated || facetParams(url).length > 0;
}
