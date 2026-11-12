/**
 * seo/structured — JSON-LD 浅层格式检查与常见字段提示。
 * 字段表不代表特定搜索功能的资格要求；不解析完整上下文、实体引用或业务真实性。
 */

/**
 * 各类型常见字段，仅作不扣分的完善提示；按目标搜索功能另行核实。
 * 内层数组表示替代项，任一有内容就不提示该组。
 */
export const COMMON_FIELDS = {
  Product: [['name'], ['image'], ['offers', 'review', 'aggregateRating']],
  Article: [['headline'], ['image'], ['datePublished'], ['author']],
  BlogPosting: [['headline'], ['image'], ['datePublished'], ['author']],
  NewsArticle: [['headline'], ['image'], ['datePublished'], ['author']],
  BreadcrumbList: [['itemListElement']],
  Organization: [['name'], ['url']],
  WebSite: [['name'], ['url']],
  FAQPage: [['mainEntity']],
  ItemList: [['itemListElement']],
  Recipe: [['name'], ['image']],
  Event: [['name'], ['startDate'], ['location']],
  LocalBusiness: [['name'], ['address']],
  VideoObject: [['name'], ['thumbnailUrl'], ['uploadDate']],
  Person: [['name']],
  Service: [['name']],
  Course: [['name'], ['provider']],
  JobPosting: [['title'], ['datePosted'], ['hiringOrganization']],
  SoftwareApplication: [['name'], ['offers']],
  HowTo: [['name'], ['step']],
  Review: [['itemReviewed'], ['reviewRating']],
  AggregateRating: [['ratingValue'], ['ratingCount', 'reviewCount']],
  Offer: [['price'], ['priceCurrency']],
};

/** 值是否算「有内容」：空串、空数组、空对象都不算 */
function has(v) {
  if (v == null) return false;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

const typesOf = (node) => [].concat(node?.['@type'] ?? []).filter(t => typeof t === 'string');

/** 把 @graph 摊平，得到"真正在描述实体"的那些节点 */
export function flattenNodes(items) {
  const out = [];
  for (const it of items ?? []) {
    if (!it || typeof it !== 'object') continue;
    if (Array.isArray(it['@graph'])) { for (const g of it['@graph']) if (g && typeof g === 'object') out.push(g); }
    else out.push(it);
  }
  return out;
}

/** 缺失字段的人话描述：`image、offers|review|aggregateRating（至少其一）` */
const describeGroup = (g) => (g.length === 1 ? g[0] : `${g.join(' / ')}（至少其一）`);

const isIsoDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}/.test(v);
const DATE_KEYS = ['datePublished', 'dateModified', 'datePosted', 'uploadDate', 'startDate', 'endDate'];

/**
 * 校验一组 JSON-LD 顶层对象。
 * @param {Array<object>} items 解析后的顶层节点（可能含 @graph）
 * @returns {Array<{id,severity,title,message,evidence,suggestion}>}
 */
export function validateStructuredData(items) {
  const out = [];
  const list = (items ?? []).filter(x => x && typeof x === 'object');
  if (!list.length) return out;

  // @context：只有顶层的需要（@graph 内的节点继承）
  const missingContext = list.filter(x => !has(x['@context']) && !Array.isArray(x['@graph']));
  if (missingContext.length) {
    out.push({
      id: 'structured-context-missing', severity: 'low',
      title: 'JSON-LD 缺 @context',
      message: `${missingContext.length} 段脚本没有 @context`,
      evidence: '缺少 @context 的脚本不会被视为 schema.org 数据，等于没写',
      suggestion: '在顶层对象加 "@context": "https://schema.org"',
    });
  }

  const nodes = flattenNodes(list);
  const noType = nodes.filter(n => typesOf(n).length === 0);
  if (noType.length) {
    out.push({
      id: 'structured-type-missing', severity: 'low',
      title: 'JSON-LD 节点缺 @type',
      message: `${noType.length} 个节点没有可识别的 @type`,
      evidence: '',
      suggestion: '为每个实体补上 @type（Product / Article / FAQPage …）',
    });
  }

  // shortcut: 不展开 JSON-LD 上下文或 @id 引用；需要判定搜索功能资格时接入对应验证器。
  const byType = new Map();
  for (const n of nodes) {
    for (const t of typesOf(n)) {
      if (!Object.hasOwn(COMMON_FIELDS, t)) continue;
      const missing = COMMON_FIELDS[t].filter(group => !group.some(k => has(n[k])));
      if (!missing.length) continue;
      if (!byType.has(t)) byType.set(t, { missing: new Set(), count: 0 });
      const rec = byType.get(t);
      rec.count++;
      for (const g of missing) rec.missing.add(describeGroup(g));
    }
  }
  for (const [type, rec] of byType) {
    out.push({
      id: 'structured-common-fields', severity: 'info',
      title: `${type} 常见字段待核查`,
      message: `${rec.count} 个 ${type} 实体未直接提供 ${[...rec.missing].join('、')}`,
      evidence: `浅层字段提示，不是必填或富结果资格判定；未解析上下文和实体引用。${type} 的参考字段：${COMMON_FIELDS[type].map(describeGroup).join('、')}`,
      suggestion: `按目标搜索功能的官方指南和 Rich Results Test 复核；仅在与可见内容一致时补充 ${[...rec.missing].join('、')}，勿虚构数据`,
    });
  }

  // 日期格式：写成人能看懂但机器解析不了的形式是最常见的低级错误
  const badDates = [];
  for (const n of nodes) {
    for (const k of DATE_KEYS) {
      if (has(n[k]) && !isIsoDate(n[k])) badDates.push(`${k}=${String(n[k]).slice(0, 40)}`);
    }
  }
  if (badDates.length) {
    out.push({
      id: 'structured-date-format', severity: 'low',
      title: '结构化数据里的日期格式不规范',
      message: `${badDates.length} 处日期不是 ISO 8601`,
      evidence: badDates.slice(0, 5).join('\n'),
      suggestion: '用 ISO 8601（如 2026-10-11 或 2026-10-11T09:00:00+08:00）',
    });
  }

  return out;
}
