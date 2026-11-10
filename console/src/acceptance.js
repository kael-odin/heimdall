/** Build a site handoff snapshot from the same persisted artifacts the console reads. */
const numberOrNull = value => Number.isFinite(value) && value >= 0 ? value : null;
export const ACCEPTANCE_SOURCES = {
  atlas: { label: '侦察', path: 'recon/atlas.json' },
  queue: { label: '计划队列', path: 'queue.json' },
  scope: { label: '队列范围', path: null },
  pages: { label: '克隆产物', path: null },
  verify: { label: '多视口验证', path: 'verify/verify-summary.json' },
  assets: { label: '资产扫描', path: 'audit/asset-gaps.json' },
  linker: { label: '站内接线', path: 'linker-report.json' },
};
export const VERIFICATION_LABELS = {
  missing: '未生成全站验证', error: '验证证据读取失败', stale: '全站摘要与当前证据不一致',
  legacy: '历史评分口径', sample: '仅抽样验证', failed: '已验证失败',
  passed: '多视口验证通过', incomplete: '验证覆盖不完整',
};

export function pageKey(value, fallback = '') {
  try {
    const url = new URL(value);
    url.hash = '';
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch { return fallback; }
}

function usable(source, valid) {
  return source?.status === 'ok' && valid(source.data) ? source.data : null;
}

function sourceState(source, valid) {
  if (!source || source.status === 'missing') return 'missing';
  if (source.status !== 'ok' || !valid(source.data)) return 'error';
  return 'ok';
}

function timeOf(source) {
  const timestamp = source?.data?.generatedAt ?? source?.mtime;
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp ?? '');
  return Number.isFinite(time) ? time : 0;
}

function isStale(source, latestCloneAt) {
  return source?.status === 'ok' && latestCloneAt > 0
    && timeOf(source) > 0 && timeOf(source) + 1000 < latestCloneAt;
}

const sum = (rows, key) => rows.reduce((total, row) => total + (numberOrNull(row?.[key]) ?? 0), 0);
const short = value => String(value ?? '').replace(/\s+/g, ' ').slice(0, 180);
const count = value => Number.isInteger(value) && value >= 0;
function validScopeResponse(data) {
  const scope = data?.scope;
  if (!['ok', 'missing', 'invalid'].includes(scope?.status)) return false;
  if (scope.status !== 'ok') return true;
  return ['discovered', 'eligible', 'inQueue', 'notQueued', 'excludedByDefault']
    .every(key => count(scope[key]))
    && scope.discovered === scope.eligible + scope.excludedByDefault
    && scope.discovered === scope.inQueue + scope.notQueued;
}

export function buildAcceptanceSummary({ site = null, sources = {} } = {}) {
  const atlas = usable(sources.atlas, x => Array.isArray(x?.nodes));
  const queue = usable(sources.queue, Array.isArray);
  const scopeResponse = usable(sources.scope, validScopeResponse);
  const scope = scopeResponse?.scope?.status === 'ok' ? scopeResponse.scope : null;
  const pagesData = usable(sources.pages, x => Array.isArray(x?.pages));
  const verify = usable(sources.verify, x => Array.isArray(x?.pages));
  const assets = usable(sources.assets, x => Array.isArray(x?.pages) && !!x.summary);
  const linker = usable(sources.linker, x => Array.isArray(x?.pages));
  const pages = pagesData?.pages ?? [];
  const latestCloneAt = Math.max(0, ...pages.map(p => numberOrNull(p?.updatedAt) ?? 0));
  const cloneNames = new Set(pages.map(p => p.name));
  const pageByName = new Map(pages.map(p => [p.name, p]));
  const coversClones = rows => !!pagesData && rows.length === cloneNames.size
    && new Set(rows.map(row => row.page ?? row.name)).size === cloneNames.size
    && rows.every(row => cloneNames.has(row.page ?? row.name));
  const summaryMismatch = !!pagesData && !!verify && verify.scoreVersion === 2 && verify.mode === 'all'
    && ((verify.passed === true && !coversClones(verify.pages)) || verify.pages.some(row => {
      const page = pageByName.get(row.page);
      if (row.measured !== true) return verify.passed === true || page?.verifyFresh === true;
      return !page || page.verifyFresh !== true || row.measuredAt !== page.verifyMeasuredAt
        || !row.measuredAt || row.overall !== page.verifyOverall
        || row.minViewport?.name !== page.minViewport?.name || row.minViewport?.score !== page.minViewport?.score;
    }));
  const stale = {
    verify: !!verify && (isStale(sources.verify, latestCloneAt) || summaryMismatch),
    assets: !!assets && (isStale(sources.assets, latestCloneAt) || !coversClones(assets.pages)
      || assets.summary.truncated === true),
    linker: !!linker && (isStale(sources.linker, latestCloneAt) || !coversClones(linker.pages)),
  };
  const states = {
    atlas: sourceState(sources.atlas, x => Array.isArray(x?.nodes)),
    queue: sourceState(sources.queue, Array.isArray),
    scope: sourceState(sources.scope, validScopeResponse),
    pages: sourceState(sources.pages, x => Array.isArray(x?.pages)),
    verify: sourceState(sources.verify, x => Array.isArray(x?.pages)),
    assets: sourceState(sources.assets, x => Array.isArray(x?.pages) && !!x.summary),
    linker: sourceState(sources.linker, x => Array.isArray(x?.pages)),
  };
  if (states.scope === 'ok' && scopeResponse.scope.status !== 'ok') {
    states.scope = scopeResponse.scope.status === 'missing' ? 'missing' : 'error';
  }

  const discoveredKeys = new Set(atlas?.nodes.map((n, i) => pageKey(n?.url, `atlas:${n?.id ?? i}`)) ?? []);
  const plannedKeys = new Set(queue?.map((q, i) => pageKey(q?.url, `queue:${q?.name ?? i}`)) ?? []);
  const clonedKeys = new Set(pages.map((p, i) => pageKey(p?.target, `clone:${p?.name ?? i}`)));
  const targetKeys = new Set([...discoveredKeys, ...plannedKeys, ...clonedKeys]);
  const verifiedRows = pages.filter(p => p.verifyFresh === true && p.verifyMeasured === true
    && p.verifyScoreVersion === 2 && Number.isFinite(p.minViewport?.score));
  const verifiedKeys = new Set(verifiedRows.map((p, i) => pageKey(p?.target, `verified:${p?.name ?? i}`)));
  const legacyRows = pages.filter(p => p.verifyStatus === 'legacy' || (p.verifyFresh === true
    && p.verifyScoreVersion !== null && p.verifyScoreVersion !== 2));
  const partialRows = pages.filter(p => p.verifyStatus === 'incomplete'
    || (p.verifyFresh === true && p.verifyScoreVersion === 2 && p.verifyMeasured !== true));
  const missingProducts = queue?.filter(q => q?.status === 'done' && !clonedKeys.has(pageKey(q?.url))) ?? [];
  const queuedFailures = queue?.filter(q => q?.status === 'failed') ?? [];
  const plannedCloned = queue && pagesData ? [...plannedKeys].filter(key => clonedKeys.has(key)).length : null;
  const verified = pagesData ? verifiedKeys.size : null;
  const untested = pagesData && (atlas || queue || pages.length)
    ? Math.max(0, targetKeys.size - verifiedKeys.size) : null;

  const currentVerify = !!verify && !stale.verify && verify.scoreVersion === 2 && verify.mode === 'all';
  let verificationState = 'missing';
  if (states.verify === 'error') verificationState = 'error';
  else if (verify && stale.verify) verificationState = 'stale';
  else if (verify && verify.scoreVersion !== 2) verificationState = 'legacy';
  else if (verify?.mode !== 'all' && verify) verificationState = 'sample';
  else if (currentVerify && verify.passed === false) verificationState = 'failed';
  else if (currentVerify && verify.passed === true && untested === 0) verificationState = 'passed';
  else if (currentVerify) verificationState = 'incomplete';

  const validAssetScan = assets && !stale.assets;
  const validLinker = linker && !stale.linker;
  const linkerPages = validLinker ? linker.pages : [];
  const failures = [];
  const add = (stage, page, reason, evidence) => failures.push({ stage, page: short(page), reason: short(reason) || '未记录原因', evidence });
  for (const row of atlas?.failures ?? []) add('侦察', row.url, row.reason, 'recon/atlas.json');
  for (const row of queuedFailures) add('克隆', row.name || row.url,
    `${row.error || '队列记录失败但未留原因'}${clonedKeys.has(pageKey(row.url)) ? '；当前另有克隆产物' : ''}`, 'queue.json');
  for (const row of missingProducts) add('产物', row.name || row.url, '队列标记完成，但当前没有克隆产物', 'queue.json');
  if (verify && verify.scoreVersion === 2 && !stale.verify) {
    if (verify.mode === 'all' && verify.passed === false) {
      const detail = [
        `完整测量 ${numberOrNull(verify.measured) ?? '未知'}/${numberOrNull(verify.targetTotal) ?? '未知'}`,
        numberOrNull(verify.threshold) ? `平均阈值 ${verify.threshold}%` : '',
      ].filter(Boolean).join('，');
      add('全站验证', '', `未通过：${detail}`, 'verify/verify-summary.json');
    }
    for (const row of verify.pages) {
      if (row.error) add('验证', row.page, row.error, 'verify/verify-summary.json');
      for (const vp of row.viewports ?? []) {
        if (vp.error || vp.skipped) add('视口', `${row.page} ${vp.name}`, vp.error || vp.skipped, `verify/${row.page}/verify.json`);
      }
    }
  }
  for (const row of partialRows) {
    add('验证', row.name, 'v2 已运行但未完整测量；逐页证据有具体视口原因', `verify/${row.name}/verify.json`);
  }
  if (validAssetScan) for (const row of assets.pages) {
    if ((numberOrNull(row?.visualGaps) ?? 0) > 0) add('资源', row.page, `${row.visualGaps} 个视觉资源缺口`, 'audit/asset-gaps.json');
  }
  for (const row of linkerPages) {
    if (row.assetFailed > 0) add('接线资产', row.name, `${row.assetFailed} 个本地化失败`, 'linker-report.json');
    if (row.missingLocal?.length) add('本地链接', row.name, `${row.missingLocal.length} 个本地引用不存在`, 'linker-report.json');
  }

  return {
    host: site?.host ?? sources.pages?.data?.host ?? '',
    generatedAt: new Date().toISOString(),
    states, stale,
    sourceErrors: Object.fromEntries(Object.entries(states).filter(([, state]) => state === 'error')
      .map(([key]) => [key, short(sources[key]?.reason || (key === 'scope' && sources.scope?.data?.scope?.issue === 'foreign-queue-url'
        ? '旧队列含站外或非 HTTP URL，请检查 queue.json'
        : key === 'scope' && sources.scope?.data?.scope?.status === 'invalid'
          ? '侦察或队列范围无效，请检查来源文件' : 'JSON 结构不符合预期'))])),
    discovered: atlas ? discoveredKeys.size : null,
    discoveredRaw: atlas?.nodes.length ?? null,
    reconCapped: !!atlas && numberOrNull(atlas.meta?.maxPages) !== null && atlas.nodes.length >= atlas.meta.maxPages,
    scopeDiscovered: scope?.discovered ?? null,
    scopeEligible: scope?.eligible ?? null,
    scopeInQueue: scope?.inQueue ?? null,
    scopeNotQueued: scope?.notQueued ?? null,
    scopeOutsideAtlas: scope?.outsideAtlas ?? null,
    scopeExcludedByDefault: scope?.excludedByDefault ?? null,
    scopeExcludedByType: numberOrNull(scope?.excludedByType),
    scopeExcludedByPageLimit: numberOrNull(scope?.excludedByPageLimit),
    scopeInvalidNodes: numberOrNull(scope?.invalidNodes),
    scopeForeignNodes: numberOrNull(scope?.foreignNodes),
    scopeReconFailures: numberOrNull(scope?.reconFailures),
    scopeLimitReached: scope?.maxPages == null ? null
      : typeof scope.limitReached === 'boolean' ? scope.limitReached : null,
    scopeMaxPages: numberOrNull(scope?.maxPages),
    scopeMaxDepth: numberOrNull(scope?.maxDepth),
    planned: queue ? plannedKeys.size : null,
    plannedRaw: queue?.length ?? null,
    plannedCloned,
    cloned: pagesData ? pages.length : null,
    clonedDistinct: pagesData ? clonedKeys.size : null,
    verified,
    untested,
    targetTotal: pagesData ? targetKeys.size : null,
    legacy: pagesData ? legacyRows.length : null,
    partial: pagesData ? partialRows.length : null,
    lowScore: pagesData ? verifiedRows.filter(p => typeof p.minViewport?.score === 'number' && p.minViewport.score < 0.85).length : null,
    queueFailed: queue ? queuedFailures.length : null,
    queueUnfinished: queue ? queue.filter(q => q?.status !== 'done').length : null,
    missingProducts: queue ? missingProducts.length : null,
    visualGaps: validAssetScan ? numberOrNull(assets.summary.visual) : null,
    resourceRefs: validAssetScan ? numberOrNull(assets.summary.gaps) : null,
    assetFailed: validLinker ? sum(linkerPages, 'assetFailed') : null,
    missingLocal: validLinker ? linkerPages.reduce((n, p) => n + (p.missingLocal?.length ?? 0), 0) : null,
    linksToLive: validLinker ? sum(linkerPages, 'linksToLive') : null,
    verificationState,
    scoreVersion: verify ? (verify.scoreVersion ?? 1) : null,
    failures,
  };
}

const display = value => value === null || value === undefined ? '未生成 / 不可统计' : String(value);
const markdownText = value => short(value).replace(/[\\`*_[\]<>]/g, '\\$&');
const sourceStatusText = { ok: '已生成', missing: '未生成', error: '读取失败' };
const sourcePath = (host, key, source) => key === 'pages'
  ? `GET /api/pages/${encodeURIComponent(host)}`
  : key === 'scope' ? `GET /api/queue/${encodeURIComponent(host)}`
    : `GET /static/${encodeURIComponent(host)}/${source.path}`;

export function acceptanceMarkdown(summary) {
  const rows = [
    ['侦察发现（唯一 URL）', summary.discovered], ['计划克隆（唯一 URL）', summary.planned],
    ['已发现有效同源 URL（范围分母）', summary.scopeDiscovered],
    ['新建默认队列可入队', summary.scopeEligible], ['新建默认队列排除（类型及页数上限）', summary.scopeExcludedByDefault],
    ['新队列类型过滤排除', summary.scopeExcludedByType], ['新队列页数上限排除', summary.scopeExcludedByPageLimit],
    ['已发现且已入队', summary.scopeInQueue], ['已发现但未入队', summary.scopeNotQueued],
    ['当前队列同源但不在本次侦察', summary.scopeOutsideAtlas],
    ['无效侦察节点（不计入分母）', summary.scopeInvalidNodes],
    ['站外侦察节点（不计入分母）', summary.scopeForeignNodes],
    ['侦察失败记录', summary.scopeReconFailures],
    ['侦察达到页数上限', summary.scopeLimitReached == null ? null : summary.scopeLimitReached ? '是' : '否'],
    ['侦察页数上限', summary.scopeMaxPages], ['侦察深度上限', summary.scopeMaxDepth],
    ['计划内已有克隆', summary.plannedCloned], ['实际克隆产物', summary.cloned],
    ['v2 完整验证', summary.verified], ['未完整验证（目标并集）', summary.untested],
    ['历史口径逐页结果', summary.legacy], ['v2 部分测量', summary.partial],
    ['最差视口低于 85% 的 v2 页面', summary.lowScore],
    ['视觉资源缺口', summary.visualGaps], ['全部资源引用缺口', summary.resourceRefs],
    ['本地化失败', summary.assetFailed], ['缺失本地引用', summary.missingLocal],
    ['回原站链接', summary.linksToLive], ['队列失败', summary.queueFailed],
  ];
  const lines = [
    `# ${summary.host || '未命名站点'} 验收摘要`, '',
    `生成时间：${summary.generatedAt}`, `当前目标多视口状态：${VERIFICATION_LABELS[summary.verificationState]}；评分版本：${display(summary.scoreVersion)}`, '',
    '| 指标 | 数值 |', '| --- | ---: |', ...rows.map(([label, value]) => `| ${label} | ${display(value)} |`), '',
    '未完整验证的目标 = 侦察、队列及当前克隆产物的唯一 URL 并集，减去当前产物对应的 v2 完整验证。',
    '队列范围仅统计当前侦察已发现的有效同源 URL，不代表站点全部页面。默认排除数按新建普通队列计算；旧队列续跑补页后可能超过默认上限，以当前已入队数为准。显式“克隆全部已发现页面”会纳入登录和法务页。',
    '本摘要不等同离线 strict、认证流程或外部部署验收。', '', '## 证据状态', '',
    '| 来源 | 状态 | 路径 |', '| --- | --- | --- |',
    ...Object.entries(ACCEPTANCE_SOURCES).map(([k, source]) => `| ${source.label} | ${summary.stale[k] ? '需重跑' : sourceStatusText[summary.states[k]] ?? '读取失败'}${summary.sourceErrors[k] ? `：${markdownText(summary.sourceErrors[k])}` : ''} | ${sourcePath(summary.host, k, source)} |`),
    '', '## 失败及缺口', '',
  ];
  if (!summary.failures.length) lines.push('当前可用证据没有记录失败原因；缺失或过期的证据仍需补跑。');
  else lines.push(...summary.failures.map(f => `- ${markdownText(f.stage)} · ${markdownText(f.page || '站点')}：${markdownText(f.reason)}（${markdownText(f.evidence)}）`));
  return lines.join('\n') + '\n';
}
