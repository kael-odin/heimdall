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
  'Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'Report', 'Book', 'FAQPage', 'HowTo',
  'Organization', 'Corporation', 'LocalBusiness', 'Person', 'Product', 'Service',
  'SoftwareApplication', 'WebPage', 'WebSite', 'Event',
]);
const ARTICLE_TYPES = new Set(['Article', 'BlogPosting', 'NewsArticle', 'TechArticle', 'Report']);

const text = value => typeof value === 'string' ? value.trim() : '';
const nonEmpty = value => {
  if (Array.isArray(value)) return value.some(nonEmpty);
  if (value && typeof value === 'object') return Object.values(value).some(nonEmpty);
  return text(value).length > 0;
};
const hasField = (items, keys) => items.some(item => keys.some(key => nonEmpty(item?.[key])));
const round = value => Math.round(value * 10) / 10;
const gradeOf = score => score == null ? null : score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : 'D';
const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3, info: 4 });
const EFFORT_BY_CHECK = Object.freeze({
  'geo-answer-body': 'large',
  'geo-answer-server-visible': 'large',
  'geo-answer-headings': 'medium',
  'geo-extract-structure': 'medium',
  'geo-entity-type': 'medium',
  'geo-entity-ownership': 'medium',
  'geo-citation-attribution': 'medium',
  'geo-citation-links': 'medium',
});

function priorityBand(severity) {
  return severity === 'critical' || severity === 'high' ? 'P0' : severity === 'medium' ? 'P1' : 'P2';
}

function estimatedEffort(id) {
  return EFFORT_BY_CHECK[id] ?? 'small';
}

/** 把失败检查聚合成 AI 可以直接执行和复测的待办，不把 unknown 当成缺陷。 */
export function buildGeoActionPlan(issues = [], { limit = 12 } = {}) {
  const grouped = new Map();
  for (const issue of issues) {
    if (!issue || !issue.id) continue;
    const current = grouped.get(issue.id) ?? {
      id: issue.id,
      dimension: issue.dimension ?? null,
      severity: issue.severity ?? 'medium',
      title: issue.title ?? issue.id,
      action: issue.suggestion ?? '',
      weight: Number.isFinite(issue.weight) ? issue.weight : 0,
      occurrences: 0,
      pages: new Set(),
      evidence: [],
    };
    current.occurrences++;
    if (issue.page) current.pages.add(issue.page);
    current.evidence.push({
      url: issue.page ?? null,
      message: issue.message ?? '',
      detail: issue.evidence ?? '',
    });
    grouped.set(issue.id, current);
  }

  const rows = [...grouped.values()].map(item => {
    const affectedPages = [...item.pages];
    const impactScore = item.weight * affectedPages.length;
    return {
      ...item,
      priority: priorityBand(item.severity),
      impactScore,
      impact: {
        checkWeight: item.weight,
        affectedPages: affectedPages.length,
        occurrences: item.occurrences,
      },
      affectedPages,
      evidenceLevel: 'observed',
      evidence: item.evidence.slice(0, 5),
      estimatedEffort: estimatedEffort(item.id),
      validation: {
        method: 'rerun-geo-audit',
        checkId: item.id,
        expectedStatus: 'pass',
      },
    };
  }).sort((a, b) =>
    (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
    || b.impactScore - a.impactScore
    || a.id.localeCompare(b.id));

  return rows.slice(0, Math.max(0, limit)).map((item, index) => {
    const { pages: _pages, ...publicItem } = item;
    return { rank: index + 1, ...publicItem };
  });
}

function schemaInfo(page) {
  const entries = page.jsonld ?? [];
  const resolved = entries.filter(entry => entry.semanticStatus === 'complete');
  const types = new Set(resolved.flatMap(entry => entry.types ?? []).filter(Boolean));
  const items = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    items.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const entry of resolved) for (const item of entry.items ?? []) visit(item);
  return {
    types,
    items,
    typesKnown: resolved.length === entries.length && !resolved.some(entry => entry.typesTruncated),
    fieldsKnown: resolved.length === entries.length && !resolved.some(entry => entry.truncated),
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
  const totalWeight = checks.filter(item => item.status !== 'na').reduce((sum, item) => sum + item.weight, 0);
  const earned = observed.filter(item => item.status === 'pass').reduce((sum, item) => sum + item.weight, 0);
  const definition = GEO_DIMENSIONS[key];
  return {
    label: definition.label,
    weight: definition.weight,
    score: observedWeight ? round(earned / observedWeight * 100) : null,
    observedWeight,
    totalWeight,
    status: observedWeight === 0 ? 'unknown' : observedWeight < totalWeight ? 'partial' : 'complete',
    checks,
  };
}

export function evaluateGeoPage(page = {}) {
  const schema = schemaInfo(page);
  const h1 = Array.isArray(page.h1) ? page.h1 : [];
  const headings = Array.isArray(page.headings) ? page.headings : [];
  const wordCount = Number.isFinite(page.wordCount) ? page.wordCount : null;
  const raw = page.raw;
  const rawKnown = raw?.ok === true && raw.source === 'navigation' && Number.isFinite(raw.wordCount);
  const bodyComparable = rawKnown && wordCount != null;
  const serverVisible = bodyComparable && raw.wordCount > 0 && raw.wordCount >= wordCount * 0.3;
  const meta = page.meta ?? {};
  const robots = page.robotsEvidence;
  const robotsKnown = rawKnown && robots?.target === 'googlebot' && robots.initialHtml === 'checked'
    && Array.isArray(robots.noindex) && Array.isArray(robots.nosnippet)
    && typeof meta.noindex === 'boolean' && typeof meta.nosnippet === 'boolean';
  const googleRestricted = meta.noindex === true || meta.nosnippet === true;
  const links = page.links ?? {};

  const checks = {
    answerability: [
      check('geo-answer-title', 6, page.title && h1.length ? 'pass' : 'fail', '主题入口清晰',
        page.title && h1.length ? '页面同时提供 title 和 H1。' : '页面缺少 title 或 H1，回答引擎难以确认主题。',
        `${page.title ? 'title 有值' : 'title 缺失'}；H1 ${h1.length} 个`, '补齐唯一、具体的 title 和 H1。', 'high'),
      check('geo-answer-body', 10, wordCount == null ? 'unknown' : wordCount >= 120 ? 'pass' : 'fail', '正文长度参考',
        wordCount == null ? '正文长度未采集。' : '以 120 个分词单位作准备度启发式，不能据此判断答案质量或引用效果。',
        wordCount == null ? '' : `可见正文约 ${wordCount} 个分词单位`, '按用户问题核对答案完整性，长度仅为人工检查提示。', 'medium'),
      check('geo-answer-headings', 6, headings.length >= 2 ? 'pass' : 'fail', '内容有可导航分段',
        headings.length >= 2 ? '页面有多个带文字的标题。' : '页面缺少足够的分段标题。',
        `${headings.length} 个标题`, '用描述性 H2/H3 拆分主题，不要只用视觉样式模拟标题。', 'medium'),
      check('geo-answer-server-visible', 8, bodyComparable ? (serverVisible ? 'pass' : 'fail') : 'unknown', '服务端正文长度覆盖',
        !bodyComparable ? '初始 HTML 或渲染后正文长度未核实。' : serverVisible ? '初始 HTML 非空且达到渲染后正文分词数的 30%；未核对内容等价。' : '初始 HTML 正文缺失或分词数低于渲染后正文的 30%。',
        bodyComparable ? `初始 HTML 约 ${raw.wordCount}，渲染后约 ${wordCount} 个分词单位` : '', '核对核心答案是否在初始 HTML 中可见；长度比例不能证明内容一致。', 'high'),
    ],
    extractability: [
      check('geo-extract-canonical', 6, page.canonical ? 'pass' : 'fail', '页面有规范地址',
        page.canonical ? '已提供 canonical，便于合并同一内容的地址。' : '页面未显式声明 canonical。',
        page.canonical || '', '根据重复页面与索引意图确认规范地址，再决定是否补充 canonical。', 'medium'),
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
      check('geo-citation-discoverable', 4, googleRestricted ? 'fail' : robotsKnown ? 'pass' : 'unknown', 'Google 页面级索引与摘要限制',
        meta.noindex === true ? '已发现适用于 Google 网页搜索的索引限制。'
          : meta.nosnippet === true ? '已发现适用于 Google 网页搜索的 nosnippet 或 max-snippet:0。'
            : robotsKnown ? '本次初始 HTML 与响应头未发现索引或全量摘要限制；实际抓取、收录与 AI 引用仍未验证。' : '初始索引与摘要指令尚未完整核对。',
        googleRestricted ? [...(robots?.noindex ?? []), ...(robots?.nosnippet ?? [])].join(' | ') || page.robotsMeta || page.xRobots || '索引或摘要限制'
          : robotsKnown ? 'Googlebot：noindex=false，nosnippet=false；canonical 独立检查' : '',
        '确认是否希望参与 Google 搜索摘要与 AI 搜索；仅在限制与发布意图不符时调整相关指令，再重新审计。', 'high'),
      check('geo-citation-links', 4, links.external > 0 ? 'pass' : 'unknown', '有外部参考线索',
        links.external > 0 ? '发现外部链接，可作为引用线索。' : '没有发现外部参考链接，暂不据此判定为缺陷。',
        links.external > 0 ? `${links.external} 个外部链接` : '', '需要引用时提供指向一手资料的稳定链接；外链存在不等于模型一定采信。', 'low'),
    ],
  };

  const schemaKnown = {
    'geo-extract-structure': schema.typesKnown,
    'geo-entity-type': schema.typesKnown,
    'geo-entity-name': schema.fieldsKnown,
    'geo-entity-ownership': schema.fieldsKnown,
    'geo-entity-social': schema.fieldsKnown,
    'geo-citation-attribution': schema.fieldsKnown,
    'geo-citation-freshness': schema.typesKnown && (!schema.articleLike || schema.fieldsKnown),
  };
  for (const item of Object.values(checks).flat()) {
    if (Object.hasOwn(schemaKnown, item.id) && !schemaKnown[item.id] && item.status !== 'pass') {
      item.status = 'unknown';
      item.message = 'JSON-LD 语义或字段投影未完整核实，不能据此判定缺失。';
      item.evidence = '';
      item.suggestion = '';
    }
  }

  // 采集失败时的空字段是占位值，不能据此建议用户修改页面内容。
  if (page.ok === false || !(page.status >= 200 && page.status < 400)) {
    for (const item of Object.values(checks).flat()) {
      item.status = 'unknown';
      item.message = '页面未成功采集，需先恢复访问并重新采集。';
      item.evidence = Number.isFinite(page.status) ? `HTTP ${page.status}` : 'HTTP 状态未核实';
      item.suggestion = '';
    }
  }

  const dimensions = Object.fromEntries(Object.entries(checks).map(([key, values]) => [key, dimensionResult(key, values)]));
  const all = Object.values(dimensions);
  const observedWeight = all.reduce((sum, dimension) => sum + dimension.observedWeight, 0);
  const earned = all.reduce((sum, dimension) => sum + (dimension.score == null ? 0 : dimension.score * dimension.observedWeight / 100), 0);
  const totalWeight = all.reduce((sum, dimension) => sum + dimension.totalWeight, 0);
  const issues = Object.values(checks).flat().filter(item => item.status === 'fail').map(item => ({
    page: page.url, id: item.id, dimension: Object.keys(checks).find(key => checks[key].includes(item)), severity: item.severity,
    title: item.title, message: item.message, evidence: item.evidence, suggestion: item.suggestion, weight: item.weight,
  }));
  const unknown = Object.values(checks).flat().filter(item => item.status === 'unknown').map(item => ({ id: item.id, title: item.title, message: item.message }));
  const actionPlan = buildGeoActionPlan(issues, { limit: 8 });
  const recommendations = actionPlan.map(item => item.action).filter(Boolean);
  const score = observedWeight ? round(earned / observedWeight * 100) : null;
  return {
    methodVersion: GEO_METHOD_VERSION,
    status: !observedWeight ? 'unavailable' : observedWeight < totalWeight ? 'partial' : 'complete',
    score,
    grade: gradeOf(score),
    confidence: observedWeight / totalWeight >= 0.8 ? 'high' : observedWeight / totalWeight >= 0.5 ? 'medium' : 'low',
    coverage: { observedWeight, totalWeight, ratio: Math.round(observedWeight / totalWeight * 1000) / 1000 },
    dimensions,
    issues,
    unknown,
    actionPlan,
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
    const totalWeight = pageResults.reduce((sum, entry) => sum + entry.result.dimensions[key].totalWeight, 0);
    const weightedScore = results.reduce((sum, dimension) => sum + dimension.score * dimension.observedWeight, 0);
    const definition = GEO_DIMENSIONS[key];
    dimensions[key] = {
      label: definition.label, weight: definition.weight, pages: results.length,
      score: observedWeight ? round(weightedScore / observedWeight) : null,
      observedWeight,
      totalWeight,
      status: observedWeight === 0 ? 'unknown' : observedWeight < totalWeight ? 'partial' : 'complete',
    };
  }
  const overallObserved = Object.values(dimensions).reduce((sum, dimension) => sum + dimension.observedWeight, 0);
  const overallWeighted = Object.values(dimensions).reduce((sum, dimension) => sum + (dimension.score == null ? 0 : dimension.score * dimension.observedWeight), 0);
  const totalWeight = Object.values(dimensions).reduce((sum, dimension) => sum + dimension.totalWeight, 0);
  const score = overallObserved ? round(overallWeighted / overallObserved) : null;
  const issueCounts = new Map();
  for (const entry of pageResults) for (const issue of entry.result.issues) issueCounts.set(issue.id, (issueCounts.get(issue.id) ?? 0) + 1);
  const allIssues = pageResults.flatMap(entry => entry.result.issues);
  const actionPlan = buildGeoActionPlan(allIssues);
  const recommendations = actionPlan.map(item => item.action).filter(Boolean);
  return {
    methodVersion: GEO_METHOD_VERSION,
    status: !overallObserved ? 'unavailable' : overallObserved < totalWeight ? 'partial' : 'complete',
    model: 'deterministic-readiness-heuristic',
    label: 'AI 可回答与可引用准备度',
    score,
    grade: gradeOf(score),
    confidence: overallObserved / Math.max(totalWeight, 1) >= 0.8 ? 'high' : overallObserved / Math.max(totalWeight, 1) >= 0.5 ? 'medium' : 'low',
    coverage: {
      pages: pages.length, pagesScored: pageResults.filter(entry => entry.result.score != null).length,
      pagesUnavailable: pageResults.filter(entry => entry.result.status === 'unavailable').length,
      observedWeight: overallObserved, totalWeight,
      ratio: totalWeight ? Math.round(overallObserved / totalWeight * 1000) / 1000 : 0,
    },
    dimensions,
    pages: pageResults.map(({ page, result }) => ({ url: page.url, status: result.status, coverage: result.coverage, score: result.score, grade: result.grade, confidence: result.confidence, dimensions: result.dimensions, issues: result.issues, unknown: result.unknown, actionPlan: result.actionPlan })),
    issues: [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).map(([id, count]) => ({ id, count })),
    actionPlan,
    actionPlanMeta: { total: new Set(allIssues.map(issue => issue.id)).size, returned: actionPlan.length, truncated: actionPlan.length < new Set(allIssues.map(issue => issue.id)).size },
    recommendations,
    caveats: [
      '这是基于已采集页面的可解释启发式，不是搜索排名或模型引用概率预测。',
      '没有执行真实模型问答、引用命中率实验或跨模型对照。',
      'Google 页面级指令检查不覆盖 robots.txt、实际收录、data-nosnippet 或单独授权例外，也不推断其他 AI 爬虫的策略。',
      'canonical 与结构化数据作为结构线索计分，不是 Google AI 搜索的特殊必备标记。',
      'JSON-LD 未成功展开或字段投影受限时，未观察到的相关信号保留未知；旧采集也需重新核实语义。',
      '未采集页面、登录后内容和未核实的初始 HTML 不进入本次 GEO 结论。',
      '预计成本是按改动面给出的 small / medium / large 启发式，不是工时报价。',
    ],
  };
}
