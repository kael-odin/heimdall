/** Pure input / presentation helpers for the project acceptance workbench. */
export const DIMENSIONS = [
  { id: 'visual', label: '视觉还原' },
  { id: 'structure', label: '页面结构' },
  { id: 'behavior', label: '交互行为' },
  { id: 'health', label: '运行健康' },
];
export const STATUS_LABELS = {
  running: '验收中', completed: '已完成', failed: '失败', interrupted: '已中断',
  passed: '通过', blocked: '受阻', needs_review: '待复核',
};
export const GATE_LABELS = { passed: '验收通过', failed: '发现缺陷', needs_review: '需要复核', blocked: '验收受阻' };
export const VERDICT_LABELS = {
  match: '一致', bug: '目标缺陷', baseline_failed: '基线失败', environment: '环境受阻', needs_review: '待复核',
};

function httpUrl(value, label) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error(`${label}需要完整的 http:// 或 https:// URL。`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${label}仅支持不含用户名和密码的 HTTP / HTTPS 地址。`);
  }
  if (url.hash) throw new Error(`${label}请移除 # 后的片段；页面路径填写在路由列表中。`);
  return url.href;
}

function jsonArray(value, label) {
  if (!String(value ?? '').trim()) return [];
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error(`${label}不是有效 JSON，请检查括号、引号和逗号。`); }
  if (!Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 数组。`);
  return parsed;
}

export function buildAcceptanceInput(form) {
  if (form.mode === 'spec') return buildSpecInput(form);
  const baselineUrl = httpUrl(form.baselineUrl, '基线 URL');
  const targetUrl = httpUrl(form.targetUrl, '目标 URL');
  if (baselineUrl === targetUrl) throw new Error('基线与目标需要使用不同的地址。');
  const routes = [...new Set(String(form.routes ?? '').split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
  if (!routes.length) throw new Error('至少填写一条路由，例如 /。');
  if (routes.length > 8) throw new Error('每次验收最多填写 8 条路由，请拆分任务。');
  for (const route of routes) {
    let decoded = route;
    try { for (let i = 0; i < 3; i++) decoded = decodeURIComponent(decoded); } catch { throw new Error(`路由「${route}」含有无效的 URL 编码。`); }
    if (!route.startsWith('/') || decoded.startsWith('//') || /[\\\s#\u0000-\u001f]/.test(decoded)
      || decoded.split(/[/?]/).some(segment => segment === '.' || segment === '..')) {
      throw new Error(`路由「${route}」无效；请使用 / 开头的相对路径，一行一条。`);
    }
  }
  const points = jsonArray(form.points, '验收点');
  if (points.some(point => !point || typeof point !== 'object' || Array.isArray(point))) {
    throw new Error('每个验收点必须是 JSON 对象。');
  }
  const maskSelectors = jsonArray(form.maskSelectors, '忽略区域');
  if (maskSelectors.some(selector => typeof selector !== 'string' || !selector.trim())) {
    throw new Error('忽略区域中的每一项都需要是非空的 CSS 选择器字符串。');
  }
  if (!['mirror', 'regression'].includes(form.mode)) throw new Error('请选择还原验收或回归验收。');
  const name = String(form.name ?? '').trim() || (form.mode === 'regression' ? '项目回归验收' : '项目还原验收');
  return { name, mode: form.mode, baselineUrl, targetUrl, routes,
    ...(points.length ? { points } : {}),
    ...(maskSelectors.length ? { normalization: { maskSelectors } } : {}),
  };
}

export const SPEC_CHECK_EXAMPLE = [{
  id: 'QUOTA-CONTRACT', title: '额度接口符合需求', path: '/api/quota', method: 'GET', severity: 'high',
  expect: { status: 200, contentType: 'application/json', json: [
    { pointer: '/code', kind: 'equals', value: 0 },
    { pointer: '/data/quota', kind: 'required' },
    { pointer: '/data/quota', kind: 'type', type: 'number' },
  ] },
}];

/** Approval is bound to the exact draft, including its target and source identity. */
export function acceptanceSpecFingerprint(form) {
  return JSON.stringify([form.mode, form.targetUrl, form.specSourceId, form.specRevision, form.specSourceTitle,
    form.specSourceType, form.specSourceSha256, form.specChecks, form.specOmissions, form.openApiDocument]);
}

function specPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\#\s]/.test(value)) {
    throw new Error('接口 path 需要是 / 开头的相对路径，不能包含域名、空格或片段。');
  }
}

function buildSpecInput(form) {
  const targetUrl = httpUrl(form.targetUrl, '目标 URL');
  const id = String(form.specSourceId ?? '').trim();
  const revision = String(form.specRevision ?? '').trim();
  if (!id || !revision) throw new Error('请填写需求来源 ID 与版本，以便追溯验收依据。');
  const checks = jsonArray(form.specChecks, '接口契约');
  const omissions = jsonArray(form.specOmissions, '未覆盖清单');
  if (!checks.length && !omissions.length) throw new Error('至少声明一条接口契约或明确的未覆盖项。');
  const ids = new Set();
  for (const check of checks) {
    if (!check || typeof check !== 'object' || Array.isArray(check) || !check.id || !check.title) throw new Error('每条接口契约需要 id 与 title。');
    if (ids.has(check.id)) throw new Error(`接口契约 ID「${check.id}」重复。`);
    ids.add(check.id);
    if (!['GET', 'HEAD'].includes(check.method)) throw new Error('接口契约只支持 GET 或 HEAD。');
    specPath(check.path);
    const expect = check.expect;
    if (!expect || typeof expect !== 'object' || Array.isArray(expect)) throw new Error(`接口契约「${check.id}」需要 expect 对象。`);
    if (!Number.isInteger(expect.status) || expect.status < 100 || expect.status > 599) throw new Error('预期 HTTP status 需要是 100 到 599 的整数。');
    if (expect.schema !== undefined && typeof expect.schema !== 'boolean'
      && (!expect.schema || typeof expect.schema !== 'object' || Array.isArray(expect.schema))) throw new Error('预期 schema 需要是 JSON 对象或布尔值。');
    if (expect.json !== undefined && !Array.isArray(expect.json)) throw new Error('expect.json 需要是断言数组。');
    if (check.method === 'HEAD' && ((expect.json?.length ?? 0) > 0 || expect.schema !== undefined)) throw new Error('HEAD 契约不能检查响应体，请使用 GET。');
    for (const assertion of expect.json ?? []) {
      if (!assertion || typeof assertion !== 'object' || !['equals', 'required', 'type', 'enum'].includes(assertion.kind)) throw new Error('JSON 断言 kind 支持 equals、required、type、enum。');
      if (typeof assertion.pointer !== 'string' || (assertion.pointer && !assertion.pointer.startsWith('/'))) throw new Error('JSON 断言需要使用 / 开头的 pointer；空字符串代表整个响应。');
      if (assertion.kind === 'equals' && !Object.hasOwn(assertion, 'value')) throw new Error('equals 断言需要 value。');
      if (assertion.kind === 'type' && !['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'].includes(assertion.type)) throw new Error('type 断言需要有效的 JSON 类型。');
      if (assertion.kind === 'enum' && (!Array.isArray(assertion.values) || !assertion.values.length)) throw new Error('enum 断言需要非空 values 数组。');
    }
  }
  if (omissions.some(item => !item || typeof item !== 'object' || !item.id || !item.path || !item.method || !item.reason)) throw new Error('每条未覆盖记录需要 id、path、method 与 reason。');
  if (form.specApproved !== true || form.specApprovedFingerprint !== acceptanceSpecFingerprint(form)) {
    throw new Error('请核对当前接口契约与未覆盖项，并明确批准；修改后需要重新批准。');
  }
  const type = form.specSourceType === 'openapi' ? 'openapi' : 'manual';
  const title = String(form.specSourceTitle ?? '').trim();
  const sha256 = String(form.specSourceSha256 ?? '').trim();
  const document = type === 'openapi' ? parseOpenApiDocument(form.openApiDocument) : undefined;
  return { schemaVersion: 1, name: String(form.name ?? '').trim() || '项目需求验收', mode: 'spec', targetUrl,
    spec: { source: { id, revision, type, ...(title ? { title } : {}), ...(sha256 ? { sha256 } : {}) },
      ...(document ? { document } : {}), approved: true, checks, omissions } };
}

function parseOpenApiDocument(value) {
  let document;
  try { document = JSON.parse(value); } catch { throw new Error('OpenAPI 文档不是有效 JSON。'); }
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('OpenAPI 文档需要是 JSON 对象。');
  return document;
}

export function buildOpenApiPreviewInput(form) {
  const targetUrl = httpUrl(form.targetUrl, '目标 URL');
  const document = parseOpenApiDocument(form.openApiDocument);
  return { document, targetUrl, name: String(form.name ?? '').trim() || 'OpenAPI 需求验收' };
}

export function filterAcceptanceChecks(checks = [], { dimension = 'all', verdict = 'attention', query = '' } = {}) {
  const text = String(query).trim().toLocaleLowerCase();
  const verdictMatches = check => verdict === 'all'
    || (verdict === 'attention' ? check.status !== 'passed' : check.verdict === verdict);
  return checks.filter(check => (dimension === 'all' || check.dimension === dimension)
    && verdictMatches(check)
    && (!text || [check.id, check.title, check.route, check.severity, check.expected, check.actual]
      .map(value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).join(' ').toLocaleLowerCase().includes(text)));
}

/** Evidence API only accepts a single relative file name; never follow server-provided URLs. */
export function acceptanceEvidenceFilename(value) {
  return typeof value === 'string' && value !== '.' && value !== '..'
    && /^[\w.-]+\.(?:png|json)$/i.test(value) && !value.includes('..') ? value : '';
}

export function acceptanceEvidenceEntries(check) {
  const source = check?.evidence ?? {};
  const rows = [
    ['baselineScreenshot', '基线截图'], ['targetScreenshot', '目标截图'], ['diff', '差异图'],
    ['baselineDetails', '基线采集详情'], ['targetDetails', '目标采集详情'], ['details', '采集详情'],
    ['request', '请求证据'], ['response', '响应证据'], ['contract', '契约依据'], ['source', '需求源文档'],
  ].map(([key, label]) => ({ key, label, filename: acceptanceEvidenceFilename(source[key]) }));
  // Keep older persisted reports with paired details readable as the evidence contract evolves.
  if (source.details && typeof source.details === 'object') {
    rows.push({ key: 'baselineDetails', label: '基线采集详情', filename: acceptanceEvidenceFilename(source.details.baseline) },
      { key: 'targetDetails', label: '目标采集详情', filename: acceptanceEvidenceFilename(source.details.target) });
  }
  return rows.filter((row, index) => row.filename && rows.findIndex(other => other.filename === row.filename) === index);
}

export function acceptanceScore(value) {
  if (!Number.isFinite(value)) return '未测量';
  return `${(value <= 1 ? value * 100 : value).toFixed(1)}%`;
}

export function acceptanceViewport(value) {
  if (value === 'api') return 'API';
  if (typeof value === 'string') return value;
  if (value?.width && value?.height) return `${value.width} × ${value.height}`;
  return value?.name || '全部视口';
}
