/**
 * agent/gate/report — 门禁定义与逐维报告（E7-06，PRD 05 §1.5、§1.1）
 *
 * 一份 `heimdall.gate/1` 报告回答一件事：这一页在 bronze / silver / gold 哪一档上站得住，
 * 每一维差多少。维度与真值来源：
 *
 *   visual     三视口像素、最大连通块、最大集中区域（快速裁判与评估器同一套口径）
 *   structure  缺失分段数、参考正文的覆盖率（覆盖率为空时记 not_measured，不猜）
 *   style      字体 / 字号 / 颜色这三类「关键元素样式」区域数
 *   assets     外部请求来源数、失败请求数、坏图数（原件资产的本地化程度）
 *   health     控制台错误、未捕获异常、横向溢出像素
 *   anticheat  反作弊（E7-18）命中即整页不过
 *
 * 注意：这是**快速裁判**的口径，它的 passed 只是「按确定性规则没发现不合格」，
 * 正式裁判（验收 Mirror + 评估器，E7-07）才有资格对外宣布 passed。报告里写明了这一点。
 */

export const LEVELS = Object.freeze(['gold', 'silver', 'bronze']);
const EACH = (bronze, silver, gold) => Object.freeze({ bronze, silver, gold });

export const DEFAULT_THRESHOLDS = Object.freeze({
  visual: Object.freeze({ pixel: EACH(0.95, 0.97, 0.99), maxBlobPct: EACH(1.5, 0.5, 0.2), maxRegionPct: EACH(0.5, 0.1, 0.05) }),
  structure: Object.freeze({ minTextCoverage: EACH(0.80, 0.90, 0.95), maxMissingSections: EACH(0, 0, 0) }),
  style: Object.freeze({ maxStyleRegions: EACH(3, 1, 0) }),
  assets: Object.freeze({ maxExternalHosts: EACH(0, 0, 0), maxFailedRequests: EACH(2, 0, 0), maxBrokenImages: EACH(0, 0, 0) }),
  health: Object.freeze({ maxConsoleErrors: EACH(2, 0, 0), maxPageErrors: EACH(0, 0, 0), maxOverflowPx: EACH(4, 1, 0) }),
});

/** 关键元素样式：字体、字号、颜色。位移与间距算布局，不在这里重复扣分 */
export const STYLE_CAUSES = Object.freeze(new Set(['font', 'size', 'color']));

const pick = (table, level) => table?.[level];
const mergeDeep = (base, extra) => {
  if (!extra) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(base?.[k] ?? {}, v) : v;
  }
  return out;
};

export function thresholdsFor(level = 'silver', overrides = null) {
  const merged = mergeDeep(DEFAULT_THRESHOLDS, overrides);
  const limits = {};
  for (const [dim, table] of Object.entries(merged)) {
    limits[dim] = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, typeof v === 'object' ? pick(v, level) : v]));
  }
  return limits;
}

/** 某一维「过了几档」：从 gold 往下试 */
function levelReached(checkAt) {
  for (const l of LEVELS) if (checkAt(l)) return l;
  return null;
}

function dim(id, ok, { measured = true, value = {}, limit = {}, detail = '', notes = [] }) {
  return { id, status: !measured ? 'not_measured' : (ok ? 'pass' : 'fail'), value, limit, detail, ...(notes.length ? { notes } : {}) };
}

/**
 * 组合一份门禁报告。
 * @param {object} packet  fastCompare 的修复包（含 perViewport / regions / anticheat / pagehealth）
 * @param {object} opts { level='silver', thresholds=null, scope='page' }
 */
export function composeGate(packet, { level = 'silver', thresholds = null } = {}) {
  const limits = thresholdsFor(level, thresholds);
  const vps = Object.entries(packet.perViewport ?? {});
  const dimensions = {};

  // visual
  const visualChecks = (t) => vps.every(([, v]) => v.pixelSimilarity >= t.pixel && (v.maxBlobPct ?? 0) <= t.maxBlobPct && (v.maxRegionPct ?? 0) <= t.maxRegionPct);
  if (!vps.length) dimensions.visual = dim('visual', false, { measured: false, detail: '没有可比的视口' });
  else {
    const t = limits.visual;
    const worst = vps.reduce((a, [, v]) => Math.min(a, v.pixelSimilarity), 1);
    const blob = Math.max(...vps.map(([, v]) => v.maxBlobPct ?? 0));
    const region = Math.max(...vps.map(([, v]) => v.maxRegionPct ?? 0));
    const ok = visualChecks(t);
    dimensions.visual = dim('visual', ok, {
      value: { minPixel: +worst.toFixed(5), maxBlobPct: +blob.toFixed(3), maxRegionPct: +region.toFixed(3), viewports: vps.length },
      limit: t,
      detail: `三视口最低像素 ${(worst * 100).toFixed(2)}%，最大连通块 ${blob}%，最大集中区域 ${region}%`,
      notes: vps.filter(([, v]) => v.pixelSimilarity < t.pixel).map(([w, v]) => `${w}: ${(v.pixelSimilarity * 100).toFixed(2)}% < ${(t.pixel * 100).toFixed(0)}%`),
    });
    dimensions.visual.reached = levelReached(l => vps.length > 0 && visualChecks(thresholdsFor(l, thresholds).visual));
  }

  // structure
  const missing = (packet.regions ?? []).filter(r => r.kind === 'missing-section').length;
  const coverage = packet.anticheat?.stats?.textCoverage ?? null;
  {
    const t = limits.structure;
    const okMissing = missing <= t.maxMissingSections;
    const okText = coverage === null ? null : coverage >= t.minTextCoverage;
    const measured = okText !== null;
    dimensions.structure = dim('structure', okMissing && okText === true, {
      measured,
      value: { missingSections: missing, textCoverage: coverage },
      limit: t,
      detail: measured
        ? `缺失分段 ${missing} 个，正文覆盖 ${(coverage * 100).toFixed(0)}%`
        : `缺失分段 ${missing} 个；单段对比不判正文覆盖率`,
      notes: okText === true || okText === null ? [] : [`正文覆盖 ${(coverage * 100).toFixed(0)}% < ${(t.minTextCoverage * 100).toFixed(0)}%`],
    });
    dimensions.structure.reached = levelReached(l => {
      const lt = thresholdsFor(l, thresholds).structure;
      return missing <= lt.maxMissingSections && (coverage === null || coverage >= lt.minTextCoverage);
    });
  }

  // style
  {
    const t = limits.style;
    const styleRegions = (packet.regions ?? []).filter(r => STYLE_CAUSES.has(r.cause)).length;
    dimensions.style = dim('style', styleRegions <= t.maxStyleRegions, {
      value: { styleRegions }, limit: t,
      detail: `字体 / 字号 / 颜色类区域 ${styleRegions} 个`,
      notes: styleRegions > t.maxStyleRegions ? (packet.regions ?? []).filter(r => STYLE_CAUSES.has(r.cause)).slice(0, 3).map(r => `${r.id} ${r.cause}`) : [],
    });
    dimensions.style.reached = levelReached(l => styleRegions <= thresholdsFor(l, thresholds).style.maxStyleRegions);
  }

  // assets / health（来自 compare 现场采集的 pagehealth）
  const ph = packet.pagehealth ?? null;
  if (!ph) {
    dimensions.assets = dim('assets', false, { measured: false, detail: '本次对比没有采集页面健康数据' });
    dimensions.health = dim('health', false, { measured: false, detail: '本次对比没有采集页面健康数据' });
  } else {
    const ta = limits.assets;
    const okAssets = ph.externalHosts.length <= ta.maxExternalHosts && ph.failedRequests <= ta.maxFailedRequests && ph.brokenImages <= ta.maxBrokenImages;
    dimensions.assets = dim('assets', okAssets, {
      value: { externalHosts: ph.externalHosts.length, failedRequests: ph.failedRequests, brokenImages: ph.brokenImages },
      limit: ta,
      detail: `外部来源 ${ph.externalHosts.length} 个、失败请求 ${ph.failedRequests} 个、坏图 ${ph.brokenImages} 张`,
      notes: [...ph.externalHosts.slice(0, 3)],
    });
    dimensions.assets.reached = levelReached(l => {
      const lt = thresholdsFor(l, thresholds).assets;
      return ph.externalHosts.length <= lt.maxExternalHosts && ph.failedRequests <= lt.maxFailedRequests && ph.brokenImages <= lt.maxBrokenImages;
    });

    const th = limits.health;
    const okHealth = ph.consoleErrors <= th.maxConsoleErrors && ph.pageErrors <= th.maxPageErrors && ph.overflowPx <= th.maxOverflowPx;
    dimensions.health = dim('health', okHealth, {
      value: { consoleErrors: ph.consoleErrors, pageErrors: ph.pageErrors, overflowPx: ph.overflowPx },
      limit: th,
      detail: `控制台错误 ${ph.consoleErrors}、未捕获异常 ${ph.pageErrors}、横向溢出 ${ph.overflowPx}px`,
    });
    dimensions.health.reached = levelReached(l => {
      const lt = thresholdsFor(l, thresholds).health;
      return ph.consoleErrors <= lt.maxConsoleErrors && ph.pageErrors <= lt.maxPageErrors && ph.overflowPx <= lt.maxOverflowPx;
    });
  }

  // anticheat
  const anti = packet.anticheat ?? null;
  dimensions.anticheat = anti
    ? dim('anticheat', anti.status === 'clean', {
      value: { status: anti.status, findings: anti.findings?.length ?? 0 },
      limit: { maxFindings: 0 },
      detail: anti.status === 'clean' ? '未发现以参考截图充当内容' : `命中 ${anti.findings.filter(f => f.severity === 'error').length} 项`,
      notes: (anti.findings ?? []).filter(f => f.severity === 'error').slice(0, 3).map(f => `${f.code}: ${String(f.detail).slice(0, 120)}`),
    })
    : dim('anticheat', false, { measured: false, detail: '本次对比没有跑反作弊检查' });

  const order = ['visual', 'structure', 'style', 'assets', 'health', 'anticheat'];
  const status = order.some(k => dimensions[k].status === 'fail') ? 'failed'
    : order.some(k => dimensions[k].status === 'not_measured') ? 'incomplete' : 'passed';
  const reached = status === 'passed' ? levelReached(l => {
    const limitsL = thresholdsFor(l, thresholds);
    return order.every(k => {
      const d = dimensions[k];
      if (d.status !== 'pass') return false;
      if (k === 'anticheat') return true;
      return d.reached ? LEVELS.indexOf(d.reached) <= LEVELS.indexOf(l) : false;
    });
  }) : null;

  return {
    schema: 'heimdall.gate/1',
    judge: 'fast',
    verdictAuthority: 'fast judge reports "passed" for rule compliance only; only the formal judge (E7-07) may announce it',
    runId: packet.runId ?? null,
    siteId: packet.siteId, page: packet.page, generatedAt: new Date().toISOString(),
    level, status, reached: reached ?? dimensions.visual?.reached ?? null,
    thresholds: limits,
    dimensions: order.map(k => ({ id: k, ...dimensions[k] })),
  };
}

/** 报告 → 人话表格 */
export function gateText(report) {
  const icon = (s) => (s === 'pass' ? '✓' : s === 'fail' ? '✗' : '—');
  const lines = [`门禁 ${report.level}：${report.status}${report.reached ? `（达到 ${report.reached}）` : ''} · ${report.siteId}/${report.page}`];
  for (const d of report.dimensions) {
    lines.push(` ${icon(d.status)} ${d.id.padEnd(9)} ${d.detail}`);
    for (const n of d.notes ?? []) lines.push(`     · ${n}`);
  }
  lines.push(' 说明：快速裁判的 passed 只代表「按确定性规则没发现不合格」，正式裁判才能对外宣布通过。');
  return lines.join('\n') + '\n';
}
