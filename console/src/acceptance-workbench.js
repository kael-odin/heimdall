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
  if (typeof value === 'string') return value;
  if (value?.width && value?.height) return `${value.width} × ${value.height}`;
  return value?.name || '全部视口';
}
