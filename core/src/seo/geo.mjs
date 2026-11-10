/**
 * seo/geo — AI 可回答、可抽取、可引用的页面准备度启发式。
 *
 * 这不是搜索排名预测，也不声称模型一定会引用页面。它只使用 SEO 采集证据，
 * 把可观察信号分成四个维度，并保留 unknown / not-applicable，避免把缺证据当成通过。
 */

import { GEO_METHOD_VERSION } from './method.mjs';
export { GEO_METHOD_VERSION };

export const GEO_DIMENSIONS = Object.freeze({
  answerability: { label: '可回答性', weight: 30 },
  extractability: { label: '可抽取性', weight: 25 },
  entity: { label: '实体清晰度', weight: 25 },
  citation: { label: '引用准备度', weight: 20 },
});

const ENTITY_TYPES = new Set([
  'Article', 'BlogPosting', 'NewsArticle', 'Report', 'Book', 'FAQPage', 'HowTo',
  'Organization', 'Corporation', 'LocalBusiness', 'Person', 'Product', 'Service',
  'SoftwareApplication', 'WebPage', 'WebSite', 'Event',
]);
const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'Report']);

const text = value => typeof value === 'string' ? value.trim() : '';
const nonEmpty = value => {
  if (Array.isArray(value)) return value.some(nonEmpty);
  if (value && typeof value === 'object') return Object.values(value).some(nonEmpty);
  return text(value).length > 0;
};
const hasField = (items, keys) => items.some(item => keys.some(key => nonEmpty(item?.[key])));
const round = value => Math.round(value * 10) / 10;
const gradeOf = score => score == null ? null : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';

function schemaInfo(page) {
  const types = new Set((page.jsonld ?? []).flatMap(entry => entry.types ?? []).filter(Boolean));
  const items = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    items.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const entry of page.jsonld ?? []) for (const item of entry.items ?? []) visit(item);
  return {
    types,
    items,
    hasEntityType: [...types].some(type => ENTITY_TYPES.has(type)),
    articleLike: [...types].some(type => ARTICLE_TYPES.has(type)),
    hasName: hasField(items, ['name', 'headline', 'title']),
    hasDescription: hasField(items, ['description']),
    hasAttribution: hasField(items, ['author', 'publisher', 'provider', 'sameAs']),
    hasDate: hasField(items, ['datePublished', 'dateModified', 'datePosted', 'uploadDate']),
  };
}

function check(id, weight, status, title, message, evidence, suggestion, severity = 'medium') {
  return { id, weight, status, title, message, evidence: evidence ?? '', suggestion: suggestion ?? '', severity };
}

function observedChecks(checks) {
  return checks.filter(item => item.status === 'pass' || item.status === 'fail');
}

function dimensionResult(key, checks) {
  const observed = observedChecks(checks);
  const observedWeight = observed.reduce((sum, item) => sum + item.weight, 0);
  const earned = observed.filter(item => item.status === 'pass').reduce((sum, item) => sum + item.weight, 0);
  const definition = GEO_DIMENSIONS[key];
  return {
    label: definition.label,
    weight: definition.weight,
    score: observedWeight ? round(earned / observedWeight * 100) : null,
    observedWeight,
    status: observedWeight === 0 ? 'unknown' : observedWeight < definition.weight ? 'partial' : 'complete',
    checks,
  };
}

export function evaluateGeoPage(page = {}) {
  const schema = schemaInfo(page);
  const h1 = Array.isArray(page.h1) ? page.h1 : [];
  const headings = Array.isArray(page.headings) ? page.headings : [];
  const wordCount = Number.isFinite(page.wordCount) ? page.wordCount : null;
  const raw = page.raw;
  const rawKnown = raw?.ok === true && Number.isFinite(raw.wordCount);
  const meta = page.meta ?? {};
  const links = page.links ?? {};

  const checks = {
    answerability: [
      check('geo-answer-title', 6, page.title && h1.length ? 'pass' : 'fail', '主题入口清晰',
        page.title && h1.length ? '页面同时提供 title 和 H1。' : '页面缺少 title 或 H1，回答引擎难以确认主题。',
        `${page.title ? 'title 有值' : 'title 缺失'}；H1 ${h1.length} 个`, '补齐唯一、具体的 title 和 H1。', 'high'),
      check('geo-answer-body', 10, wordCount == null ? 'unknown' : wordCount >= 120 ? 'pass' : 'fail', '正文足够回答问题',
        wordCount == null ? '正文长度未采集。' : wordCount >= 120 ? '可见正文达到启发式最低长度。' : '可见正文过短，难以支撑完整回答。',
        wordCount == null ? '' : `可见正文约 ${wordCount} 词`, '围绕一个明确问题补充事实、步骤、限制和例子。', 'medium'),
      check('geo-answer-headings', 6, headings.length >= 2 ? 'pass' : 'fail', '内容有可导航分段',
        headings.length >= 2 ? '页面有多个带文字的标题。' : '页面缺少足够的分段标题。',
        `${headings.length} 个标题`, '用描述性 H2/H3 拆分主题，不要只用视觉样式模拟标题。', 'medium'),
      check('geo-answer-server-visible', 8, rawKnown ? ((wordCount ?? 0) === 0 || raw.wordCount >= Math.max(40, (wordCount ?? 0) * 0.3) ? 'pass' : 'fail') : 'unknown', '服务端可直接读到正文',
        !rawKnown ? '初始 HTML 正文未核实。' : raw.wordCount >= Math.max(40, (wordCount ?? 0) * 0.3) ? '初始 HTML 包含足够正文。' : '初始 HTML 正文明显少于渲染后正文。',
        rawKnown ? `初始 HTML 约 ${raw.wordCount} 词，渲染后约 ${wordCount ?? 0} 词` : '', '让核心答案在 SSR/SSG 初始 HTML 中可见。', 'high'),
    ],
    extractability: [
      check('geo-extract-canonical', 6, page.canonical ? 'pass' : 'fail', '页面有规范地址',
        page.canonical ? '已提供 canonical，便于合并同一内容的地址。' : '缺少 canonical，内容主地址不明确。',
        page.canonical || '', '为页面提供本域、稳定的自指 canonical。', 'medium'),
      check('geo-extract-language', 4, page.lang ? 'pass' : 'fail', '页面声明语言',
        page.lang ? `页面语言为 ${page.lang}。` : '缺少 html lang。', page.lang || '', '设置准确的 html lang。', 'low'),
      check('geo-extract-structure', 8, schema.hasEntityType || page.microdataCount > 0 ? 'pass' : 'fail', '页面有结构化实体线索',
        schema.hasEntityType || page.microdataCount > 0 ? '发现带类型的结构化数据。' : '没有发现可识别的 JSON-LD 类型或 microdata。',
        schema.types.size ? [...schema.types].join(', ') : `microdata ${page.microdataCount ?? 0} 个`, '按页面类型补充可验证的 Schema.org 结构化数据。', 'medium'),
      check('geo-extract-sections', 7, headings.filter(h => text(h?.text)).length >= 2 ? 'pass' : 'fail', '标题文本可抽取',
        headings.filter(h => text(h?.text)).length >= 2 ? '标题包含可读文本。' : '标题文本不足，页面结构难以分段。',
        headings.slice(0, 5).map(h => text(h?.text)).filter(Boolean).join(' | '), '让每个主要章节有准确的文字标题。', 'medium'),
    ],
    entity: [
      check('geo-entity-type', 10, schema.hasEntityType ? 'pass' : 'fail', '实体类型明确',
        schema.hasEntityType ? '发现可识别的页面、组织、产品或文章实体类型。' : '没有发现明确的实体类型。',
        schema.types.size ? [...schema.types].join(', ') : '', '选择与页面真实内容匹配的 Schema.org 实体类型。', 'medium'),
      check('geo-entity-name', 5, schema.hasName || !!page.title || h1.length > 0 ? 'pass' : 'fail', '实体有名称',
        schema.hasName || page.title || h1.length ? '页面或结构化实体有名称。' : '缺少可识别的实体名称。',
        schema.hasName ? '结构化数据含 name/headline/title' : page.title || h1[0] || '', '补充稳定的品牌、产品或主题名称。', 'medium'),
      check('geo-entity-ownership', 5, schema.hasAttribution ? 'pass' : 'fail', '来源或归属可追溯',
        schema.hasAttribution ? '发现 author、publisher、provider 或 sameAs。' : '没有发现作者、发布者、提供方或 sameAs 线索。',
        schema.hasAttribution ? '结构化数据含归属字段' : '', '补充真实作者/组织、发布者和可信的 sameAs 关系。', 'medium'),
      check('geo-entity-social', 5, (page.og?.title || page.og?.description || page.description || schema.hasDescription) ? 'pass' : 'fail', '实体有摘要描述',
        page.og?.title || page.og?.description || page.description || schema.hasDescription ? '发现页面摘要或社交摘要。' : '缺少可复用的实体摘要。',
        page.description || page.og?.description || '', '为页面写清楚对象是谁、解决什么问题和适用边界。', 'low'),
    ],
    citation: [
      check('geo-citation-description', 4, page.description && page.description.length >= 50 ? 'pass' : 'fail', '有可引用摘要',
        page.description && page.description.length >= 50 ? 'description 足够概括页面主题。' : 'description 缺失或过短。',
        page.description || '', '写一个独立、事实化、少营销套话的摘要。', 'medium'),
      check('geo-citation-attribution', 4, schema.hasAttribution ? 'pass' : 'fail', '引用带来源线索',
        schema.hasAttribution ? '结构化数据包含来源归属线索。' : '缺少可用于引用归因的来源线索。',
        schema.hasAttribution ? 'author/publisher/provider/sameAs 已发现' : '', '公开作者、组织或发布者身份，并保持页面与组织资料一致。', 'medium'),
      check('geo-citation-freshness', 4, schema.articleLike ? (schema.hasDate ? 'pass' : 'fail') : 'na', '内容时间可核验',
        schema.articleLike ? (schema.hasDate ? '文章实体含发布时间或修改时间。' : '文章实体缺少时间字段。') : '非文章类页面不强制要求文章时间字段。',
        schema.articleLike ? (schema.hasDate ? 'datePublished/dateModified 等字段已发现' : '') : '', '对文章、新闻和报告补充真实的发布日期与更新时间。', 'low'),
      check('geo-citation-discoverable', 4, meta.noindex === true ? 'fail' : page.canonical ? 'pass' : 'unknown', '公开内容可发现',
        meta.noindex === true ? '页面明确限制索引，公开发现能力受限。' : page.canonical ? '没有发现 noindex，且有 canonical。' : '没有足够证据确认公开主地址。',
        meta.noindex === true ? page.robotsMeta || page.xRobots || 'noindex' : page.canonical || '', '确认页面是否应公开；需要公开时移除错误的 noindex。', 'high'),
      check('geo-citation-links', 4, links.external > 0 ? 'pass' : 'unknown', '有外部参考线索',
        links.external > 0 ? '发现外部链接，可作为引用线索。' : '没有发现外部参考链接，暂不据此判定为缺陷。',
        links.external > 0 ? `${links.external} 个外部链接` : '', '需要引用时提供指向一手资料的稳定链接；外链存在不等于模型一定采信。', 'low'),
    ],
  };

  const dimensions = Object.fromEntries(Object.entries(checks).map(([key, values]) => [key, dimensionResult(key, values)]));
  const all = Object.values(dimensions);
  const observedWeight = all.reduce((sum, dimension) => sum + dimension.observedWeight, 0);
  const earned = all.reduce((sum, dimension) => sum + (dimension.score == null ? 0 : dimension.score * dimension.observedWeight / 100), 0);
  const totalWeight = Object.values(GEO_DIMENSIONS).reduce((sum, dimension) => sum + dimension.weight, 0);
  const issues = Object.values(checks).flat().filter(item => item.status === 'fail').map(item => ({
    page: page.url, id: item.id, dimension: Object.keys(checks).find(key => checks[key].includes(item)), severity: item.severity,
    title: item.title, message: item.message, evidence: item.evidence, suggestion: item.suggestion,
  }));
  const unknown = Object.values(checks).flat().filter(item => item.status === 'unknown').map(item => ({ id: item.id, title: item.title, message: item.message }));
  const recommendations = [...new Set(issues.map(issue => issue.suggestion).filter(Boolean))].slice(0, 8);
  const score = observedWeight ? round(earned / observedWeight * 100) : null;
  return {
    methodVersion: GEO_METHOD_VERSION,
    score,
    grade: gradeOf(score),
    confidence: observedWeight / totalWeight >= 0.8 ? 'high' : observedWeight / totalWeight >= 0.5 ? 'medium' : 'low',
    coverage: { observedWeight, totalWeight, ratio: round(observedWeight / totalWeight) },
    dimensions,
    issues,
    unknown,
    recommendations,
  };
}

export function evaluateGeoSite(site = {}) {
  const pages = Array.isArray(site.pages) ? site.pages : [];
  const pageResults = pages.map(page => ({ page, result: evaluateGeoPage(page) }));
  const dimensions = {};
  for (const key of Object.keys(GEO_DIMENSIONS)) {
    const results = pageResults.map(entry => entry.result.dimensions[key]).filter(dimension => dimension.score != null);
    const observedWeight = results.reduce((sum, dimension) => sum + dimension.observedWeight, 0);
    const weightedScore = results.reduce((sum, dimension) => sum + dimension.score * dimension.observedWeight, 0);
    const definition = GEO_DIMENSIONS[key];
    dimensions[key] = {
      label: definition.label, weight: definition.weight, pages: results.length,
      score: observedWeight ? round(weightedScore / observedWeight) : null,
      observedWeight,
      status: results.length === 0 ? 'unknown' : results.length < pages.length ? 'partial' : 'complete',
    };
  }
  const overallObserved = Object.values(dimensions).reduce((sum, dimension) => sum + dimension.observedWeight, 0);
  const overallWeighted = Object.values(dimensions).reduce((sum, dimension) => sum + (dimension.score == null ? 0 : dimension.score * dimension.observedWeight), 0);
  const totalWeight = Object.values(GEO_DIMENSIONS).reduce((sum, dimension) => sum + dimension.weight, 0) * pages.length;
  const score = overallObserved ? round(overallWeighted / overallObserved) : null;
  const issueCounts = new Map();
  for (const entry of pageResults) for (const issue of entry.result.issues) issueCounts.set(issue.id, (issueCounts.get(issue.id) ?? 0) + 1);
  const recommendations = [...new Set(pageResults.flatMap(entry => entry.result.recommendations))].slice(0, 10);
  return {
    methodVersion: GEO_METHOD_VERSION,
    model: 'deterministic-readiness-heuristic',
    label: 'AI 可回答与可引用准备度',
    score,
    grade: gradeOf(score),
    confidence: overallObserved / Math.max(totalWeight, 1) >= 0.8 ? 'high' : overallObserved / Math.max(totalWeight, 1) >= 0.5 ? 'medium' : 'low',
    coverage: { pages: pages.length, pagesScored: pageResults.filter(entry => entry.result.score != null).length, observedWeight: overallObserved, totalWeight },
    dimensions,
    pages: pageResults.map(({ page, result }) => ({ url: page.url, score: result.score, grade: result.grade, confidence: result.confidence, dimensions: result.dimensions, issues: result.issues, unknown: result.unknown })),
    issues: [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    recommendations,
    caveats: [
      '这是基于已采集页面的可解释启发式，不是搜索排名或模型引用概率预测。',
      '没有执行真实模型问答、引用命中率实验或跨模型对照。',
      '未采集页面、登录后内容和未核实的初始 HTML 不进入本次 GEO 结论。',
    ],
  };
}
