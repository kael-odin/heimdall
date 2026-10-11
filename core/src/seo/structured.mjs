/**
 * seo/structured — JSON-LD 深度校验（字段级）
 *
 * 此前只做两件事：能不能解析、@type 在不在。但结构化数据实际失效的原因
 * 几乎都是**字段级**的 —— Google 判断一个 Product 能不能出富结果，
 * 看的是 name + image + (offers|review|aggregateRating)，不是「有没有 Product 这个词」。
 * 一个只写了 `{"@type":"Product"}` 的脚本，在旧实现的眼里和一份完整 Product 等价。
 *
 * 纯函数、无 IO —— 规则表可以对照 Google 的富结果文档逐条核，单测直接喂对象。
 *
 * 边界：这里只做**必填字段存在性**与基本格式（日期可解析、图片是绝对地址），
 * 不做业务正确性（价格是否真实、评分是否来自真实评价）—— 那需要站点自己的数据。
 */

/**
 * 各类型的必填字段（对照 Google 富结果文档）。
 * 内层数组表示「至少其一」—— 例如 Product 必须有 offers / review / aggregateRating 之一。
 */
export const REQUIRED_FIELDS = {
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

const isAbsUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
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

  // 必填字段：按类型聚合，一个类型一条，避免每个实体刷一条
  const byType = new Map();
  for (const n of nodes) {
    for (const t of typesOf(n)) {
      if (!REQUIRED_FIELDS[t]) continue;
      const missing = REQUIRED_FIELDS[t].filter(group => !group.some(k => has(n[k])));
      if (!missing.length) continue;
      if (!byType.has(t)) byType.set(t, { missing: new Set(), count: 0 });
      const rec = byType.get(t);
      rec.count++;
      for (const g of missing) rec.missing.add(describeGroup(g));
    }
  }
  for (const [type, rec] of byType) {
    out.push({
      id: 'structured-required-missing', severity: 'medium',
      title: `${type} 缺少必填字段`,
      message: `${rec.count} 个 ${type} 实体缺 ${[...rec.missing].join('、')}`,
      evidence: `Google 依据这些字段决定是否展示富结果；缺了通常等于白写。类型 ${type} 的必填：${REQUIRED_FIELDS[type].map(describeGroup).join('、')}`,
      suggestion: `补齐：${[...rec.missing].join('、')}`,
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

  // 图片：相对地址在富结果里取不到图
  const relImgs = [];
  for (const n of nodes) {
    const imgs = [].concat(n.image ?? []).flatMap(x => (typeof x === 'string' ? [x] : (x && typeof x === 'object' ? [x.url] : [])));
    for (const u of imgs) if (has(u) && !isAbsUrl(u)) relImgs.push(String(u).slice(0, 60));
  }
  if (relImgs.length) {
    out.push({
      id: 'structured-image-relative', severity: 'low',
      title: '结构化数据的图片用了相对地址',
      message: `${relImgs.length} 处 image 不是绝对 URL`,
      evidence: relImgs.slice(0, 5).join('\n'),
      suggestion: '改为绝对地址（含 https:// 与域名），富结果抓取时不解析相对路径',
    });
  }

  return out;
}
