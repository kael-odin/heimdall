/**
 * seo/baseline — SEO 回归基线（把「报告」变成「回归保护」）
 *
 * audit 每次都把当前状态全量重述一遍：人看不过来，CI 更判断不了。
 * 基线只回答一个问题：**跟上次比，哪里变差了**。
 *
 * 三个必须处理的实际问题 —— 不处理的话，门禁会在几天内被 `continue-on-error` 关掉：
 *
 *   1. **波动规则**。LCP/CLS/FCP 每次跑都在抖，同一个上报几次能差出几百毫秒。
 *      把它们当回归，CI 会随机变红，团队的第一反应是加豁免，第二反应是删掉门禁。
 *      → 波动规则不进入判定，只作为「观测」上报。（用**稳定分**比较，见 stableScore）
 *
 *   2. **页面集合会变**。新页面上线是正常的，不该报回归；
 *      但**上次能访问、这次 404 的页面**是最容易漏、后果最重的一类回归
 *      （改版删了着陆页 / 路由改错），必须报，且必须单列。
 *
 *   3. **计数会漂移**。同一条规则出现在 2 个页还是 20 个页上是两件事，
 *      而站点总问题数会因为页面总数变化而整体浮动。
 *      → 基线键是 **(page, ruleId) 对**，不是规则计数。
 *
 * 纯函数，无 IO —— 读写基线文件由 CLI 层负责。
 *
 * ── 为什么没有「分数下降」这条回归 ──
 * 分数是从问题列表**派生**的：新增一条 critical，分数必然掉 25。
 * 如果把「分数下降」也记成一条回归，同一个原因会被计两次，
 * `blocking` 计数虚高，报告里同一条问题出现两遍，且调 tolerance 会同时影响两处。
 * 所以：**回归 = 具名问题差异**（页面消失 / 新增问题 / 严重度上升），分数只作为顶栏数字如实展示。
 * `tolerance` 留给一个显式的可选项：`--tolerance N > 0` 时额外启用「总分跌幅门禁」。
 */
import { SEVERITY_PENALTY, SEVERITY_LABEL } from './rules.mjs';
import { canonUrl } from '../url-canon.mjs';

/** 波动规则：跑一次一个值，不能作为回归判据 */
export const VOLATILE_RULES = [/^perf-(lcp|cls|fcp)\b/];

/** 波动规则是否命中 */
export function isVolatile(ruleId) {
  return VOLATILE_RULES.some(re => re.test(String(ruleId ?? '')));
}

export const BASELINE_VERSION = 1;

/** 门禁默认拦下的严重度 */
export const DEFAULT_FAIL_ON = ['critical', 'high'];

const normUrl = (u) => (canonUrl(u) ?? String(u ?? '')).replace(/\/$/, '');
const round1 = (n) => Math.round(Number(n) * 10) / 10;

/**
 * 稳定分：剔除波动规则后的惩罚分。
 * 报告里的 `score` 是给人和趋势看的；门禁只认稳定分，否则 LCP 一抖就误报。
 */
export function stableScore(issues = []) {
  return Math.max(0, round1(100 - stablePenalty(issues)));
}

/** 一条 issue 的稳定身份：page + ruleId（证据/文案会随内容变，不能进 key） */
export function issueKey(pageUrl, ruleId) {
  return `${pageUrl == null ? '~site' : normUrl(pageUrl)}::${ruleId}`;
}

/**
 * 从 audit 的 report 生成基线快照。
 * 只保留判定需要的字段 —— 基线是要进 git、要在 PR 里 diff 的文件，
 * 把整份 seo.json（几百 KB，含全部证据文本）塞进去就没人看了。
 *
 * 问题记成 `{ ruleId: severity }` 而**不是字符串数组**：严重度决定了它是否阻断，
 * 让快照自带严重度，比对时就不依赖外部传入的映射。
 * （早先版本靠 `severityOf` 回调，默认返回 medium —— 一条 critical 会被静默降级成放行。）
 */
/**
 * 站点稳定分：与 audit.mjs 的 siteScore 同口径 —— **页均**再减站点级扣分（站点扣分也按页数摊）。
 *
 * 以前这里是全站扣分直接求和：一页 12 分扣减，3 页的站就是 100-36=64，10 页以上恒为 0，
 * 于是 `--tolerance` 的"总分跌幅"门禁在多页站上等于永远触发、在少页站上又偏松。
 * 页均口径下"每页扣 12 分"在任何页数上都得到 88，和报告里展示的总分一致。
 */
export function stableSiteScore(pages = [], siteIssues = []) {
  if (!pages.length) return 100;
  const avgPage = pages.reduce((sum, p) => sum + stableScore(p.issues ?? []), 0) / pages.length;
  const sitePenalty = stablePenalty(siteIssues) / pages.length;
  return Math.max(0, round1(avgPage - sitePenalty));
}

/** 与 stableScore 共用同一套"忽略波动规则、按严重度扣分"的口径 */
function stablePenalty(issues = []) {
  return (issues ?? [])
    .filter(i => !isVolatile(i?.id))
    .reduce((sum, i) => sum + (SEVERITY_PENALTY[i.severity] ?? 0), 0);
}

export function buildBaseline(report, { capturedAt } = {}) {
  if (!report || typeof report !== 'object') throw new Error('buildBaseline: report required');
  const pages = {};
  for (const p of report.pages ?? []) {
    if (!p?.url) continue;
    const issues = p.issues ?? [];
    pages[normUrl(p.url)] = {
      score: p.score ?? stableScore(issues),
      stable: stableScore(issues),
      issues: severityMap(issues),
    };
  }
  const siteIssues = severityMap(report.siteIssues ?? []);
  return {
    version: BASELINE_VERSION,
    scoreMethodVersion: report.scoreMethodVersion ?? null,
    host: report.host,
    origin: report.origin,
    capturedAt: capturedAt ?? report.generatedAt ?? new Date().toISOString(),
    score: report.score ?? null,
    stable: stableSiteScore(report.pages ?? [], report.siteIssues ?? []),
    categories: Object.fromEntries(
      Object.entries(report.categories ?? {}).map(([k, v]) => [k, v?.score ?? null]),
    ),
    pages,
    siteIssues,
    summary: {
      pages: Object.keys(pages).length,
      issues: (report.summary?.issues ?? null),
    },
    ...(report.summary?.baselineEligible === true ? {
      collection: { version: 1, sitemapCoverage: report.summary.sitemapCoverage },
    } : {}),
  };
}

/** 同一条规则取最严重的一次出现（同一页同一规则可能被多次触发） */
function severityMap(issues) {
  const out = {};
  for (const i of [...(issues ?? [])].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (!i?.id) continue;
    const cur = out[i.id];
    if (cur == null || (SEV_ORDER[i.severity] ?? 9) < (SEV_ORDER[cur] ?? 9)) out[i.id] = i.severity;
  }
  return out;
}

/** 从 report 抽出当前状态的同构视图，供 diff 使用（与 buildBaseline 共用形状） */
export function snapshotOf(report) {
  return buildBaseline(report, { capturedAt: null });
}

/**
 * 比对。返回结构化的回归/改进/观测，以及是否放行。
 *
 * @param {object} baseline 上一次的快照
 * @param {object} current  本次的快照（用 snapshotOf 生成）
 * @param {object} opts
 *   tolerance  — 总分跌幅门禁；**0（默认）表示不启用**，只看具名问题
 *   failOn     — 触发失败的严重度数组（默认 critical/high）
 */
export function diffBaseline(baseline, current, opts = {}) {
  const tolerance = Number(opts.tolerance ?? 0);
  const failOn = new Set(opts.failOn ?? DEFAULT_FAIL_ON);

  if (!baseline) {
    return { ok: true, firstRun: true, regressions: [], improvements: [], observations: [], score: null, counts: {} };
  }
  if (Number(baseline.version) !== BASELINE_VERSION) {
    // 版本不认就**不要**拿旧数据判新代码 —— 报错比误判安全
    throw new Error(`baseline version ${baseline.version} != ${BASELINE_VERSION}，请重新生成基线`);
  }
  if (!Number.isSafeInteger(baseline.scoreMethodVersion) || baseline.scoreMethodVersion < 1
      || baseline.scoreMethodVersion !== current?.scoreMethodVersion) {
    throw new Error('baseline score method is missing or incompatible; preserve it and establish a new baseline');
  }

  const regressions = [];
  const improvements = [];
  const observations = [];

  // ---------- 1. 消失的页面（最重） ----------
  const curPages = current.pages ?? {};
  const basePages = baseline.pages ?? {};
  for (const url of Object.keys(basePages)) {
    if (!curPages[url]) {
      regressions.push({
        type: 'page-missing', severity: 'critical', url,
        title: '页面消失',
        detail: `上次审计存在，本次未出现在结果中（404/不可达/不再被发现）`,
      });
    }
  }

  // ---------- 2. 新增页面（中性，仅记录） ----------
  const addedPages = Object.keys(curPages).filter(u => !basePages[u]);

  // ---------- 3. 逐页问题差异 ----------
  // 严重度一律取自快照本身（见 buildBaseline），不依赖外部回调 —— 少一个能静默出错的接缝。
  const sevFrom = (bag, id, fallback = 'medium') => bag?.[id] ?? fallback;
  for (const [url, cur] of Object.entries(curPages)) {
    const prev = basePages[url];
    if (!prev) continue;                       // 新页面不判回归
    const prevBag = prev.issues ?? {};
    const curBag = cur.issues ?? {};

    for (const id of Object.keys(curBag)) {
      const sev = sevFrom(curBag, id);
      if (id in prevBag) {
        const previous = sevFrom(prevBag, id);
        if ((SEV_ORDER[sev] ?? 9) < (SEV_ORDER[previous] ?? 9)) {
          const item = {
            type: 'issue-worsened', severity: sev, url, ruleId: id,
            title: SEVERITY_LABEL[sev] ?? sev,
            detail: `严重度上升：${id}（${previous} → ${sev}）`,
          };
          if (isVolatile(id)) observations.push(item); else regressions.push(item);
        } else if ((SEV_ORDER[sev] ?? 9) > (SEV_ORDER[previous] ?? 9)) {
          improvements.push({ type: 'issue-improved', severity: sev, url, ruleId: id,
            detail: `严重度下降：${id}（${previous} → ${sev}）` });
        }
        continue;
      }
      const item = {
        type: 'new-issue', severity: sev, url, ruleId: id,
        title: SEVERITY_LABEL[sev] ?? sev,
        detail: `新出现：${id}`,
      };
      // 波动规则不判回归，只观测
      if (isVolatile(id)) observations.push(item); else regressions.push(item);
    }
    for (const id of Object.keys(prevBag)) {
      if (id in curBag) continue;
      improvements.push({ type: 'resolved-issue', severity: sevFrom(prevBag, id), url, ruleId: id, detail: `已修复：${id}` });
    }
  }

  // ---------- 4. 站点级问题 ----------
  const prevSite = baseline.siteIssues ?? {};
  const curSite = current.siteIssues ?? {};
  for (const id of Object.keys(curSite)) {
    const sev = sevFrom(curSite, id);
    if (id in prevSite) {
      const previous = sevFrom(prevSite, id);
      if ((SEV_ORDER[sev] ?? 9) < (SEV_ORDER[previous] ?? 9)) {
        const item = { type: 'site-issue-worsened', severity: sev, url: null, ruleId: id,
          detail: `严重度上升（站点级）：${id}（${previous} → ${sev}）` };
        if (isVolatile(id)) observations.push(item); else regressions.push(item);
      } else if ((SEV_ORDER[sev] ?? 9) > (SEV_ORDER[previous] ?? 9)) {
        improvements.push({ type: 'site-issue-improved', severity: sev, url: null, ruleId: id,
          detail: `严重度下降（站点级）：${id}（${previous} → ${sev}）` });
      }
      continue;
    }
    const item = { type: 'new-site-issue', severity: sev, url: null, ruleId: id, detail: `新出现（站点级）：${id}` };
    if (isVolatile(id)) observations.push(item); else regressions.push(item);
  }
  for (const id of Object.keys(prevSite)) {
    if (id in curSite) continue;
    improvements.push({ type: 'resolved-site-issue', severity: sevFrom(prevSite, id), url: null, ruleId: id, detail: `已修复（站点级）：${id}` });
  }

  // ---------- 5. 总分（派生量，只展示；可选门禁） ----------
  const beforeTotal = baseline.stable ?? 0;
  const afterTotal = current.stable ?? 0;
  const totalDelta = round1(afterTotal - beforeTotal);
  // tolerance > 0 才启用：默认 0 = 不拿分数当判据（分数是问题列表的函数，不是独立信号）
  if (tolerance > 0 && totalDelta < -tolerance) {
    regressions.push({
      type: 'score-drop', severity: 'high', url: null,
      title: '站点稳定分跌幅超容忍度', detail: `${beforeTotal} → ${afterTotal}（${totalDelta}，容忍度 ${tolerance}）`,
      before: beforeTotal, after: afterTotal, delta: totalDelta,
    });
  }

  // ---------- 判定 ----------
  const blocking = regressions.filter(r => failOn.has(r.severity));
  const ok = blocking.length === 0;

  return {
    ok,
    firstRun: false,
    tolerance,
    failOn: [...failOn],
    score: { before: beforeTotal, after: afterTotal, delta: totalDelta },
    rawScore: { before: baseline.score ?? null, after: current.score ?? null },
    regressions: sortRegressions(regressions),
    improvements,
    observations,
    addedPages,
    counts: {
      regressions: regressions.length,
      blocking: blocking.length,
      improvements: improvements.length,
      observations: observations.length,
      addedPages: addedPages.length,
    },
  };
}

/** 排序：先按严重度，再按类型（页面消失优先），最后按 URL —— 报告要能从上往下读 */
const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const TYPE_ORDER = { 'page-missing': 0, 'score-drop': 1, 'site-issue-worsened': 2, 'issue-worsened': 3, 'new-site-issue': 4, 'new-issue': 5 };
function sortRegressions(list) {
  return [...list].sort((a, b) =>
    (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
    || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
    || String(a.url ?? '').localeCompare(String(b.url ?? '')));
}

/**
 * 把 diff 渲染成终端可读文本。
 * 修复建议按「影响 × 修复成本」排序，而不是按发现顺序 ——
 * 一份 200 条问题的清单没人会照着做，一份 8 条能照着做的才会被做掉。
 */
export function renderDiffText(diff, { limit = 20 } = {}) {
  if (diff.firstRun) return '基线：首次运行，已建立基线（无对比）\n';
  const L = [];
  const { score } = diff;
  const arrow = score.delta < 0 ? '▼' : score.delta > 0 ? '▲' : '=';
  L.push(`基线与本次对比  ${score.before} → ${score.after}  ${arrow} ${score.delta >= 0 ? '+' : ''}${score.delta}`);
  L.push(`判定口径：新增问题严重度 ∈ {${(diff.failOn ?? []).join(', ')}} 即阻断；${diff.tolerance > 0 ? `总分跌幅 > ${diff.tolerance} 也阻断` : '未启用分数门禁（--tolerance 0）'}`);
  L.push('');

  if (diff.regressions.length) {
    L.push(`回归 ${diff.regressions.length} 项（其中阻断 ${diff.counts.blocking} 项）:`);
    for (const r of diff.regressions.slice(0, limit)) {
      L.push(`  [${SEVERITY_LABEL[r.severity] ?? r.severity}] ${r.detail}${r.url ? `\n        ${r.url}` : ''}`);
    }
    if (diff.regressions.length > limit) L.push(`  ... 另有 ${diff.regressions.length - limit} 项`);
  } else {
    L.push('回归：无');
  }
  if (diff.improvements.length) L.push(`\n改进 ${diff.improvements.length} 项`);
  if (diff.observations.length) L.push(`波动观测 ${diff.observations.length} 项（不计入判定：LCP/CLS/FCP 每次跑都会抖）`);
  if (diff.addedPages.length) L.push(`新增页面 ${diff.addedPages.length} 个（中性）`);
  L.push('');
  L.push(diff.ok ? '结论：通过 ✅' : `结论：不通过 ❌ —— ${diff.counts.blocking} 项阻断级回归`);
  return L.join('\n') + '\n';
}

/** 生成一份可直接贴进 PR 评论的 Markdown（GitHub Action 用） */
export function renderDiffMarkdown(diff, { limit = 30 } = {}) {
  if (diff.firstRun) return '### Heimdall SEO 基线\n\n首次运行，已建立基线。\n';
  const L = [];
  const { score } = diff;
  L.push('### Heimdall SEO 回归检查');
  L.push('');
  L.push(`| 稳定分 | 本次 | 变化 |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| 站点 | ${score.after} | ${score.delta >= 0 ? '+' : ''}${score.delta} |`);
  L.push('');
  if (diff.ok) L.push(`**通过** ✅ 无阻断级回归。`);
  else L.push(`**不通过** ❌ ${diff.counts.blocking} 项阻断级回归。`);
  L.push('');
  if (diff.regressions.length) {
    L.push(`<details open><summary>回归 ${diff.regressions.length} 项</summary>`);
    L.push('');
    L.push('| 严重度 | 类型 | 目标 | 详情 |');
    L.push('| --- | --- | --- | --- |');
    for (const r of diff.regressions.slice(0, limit)) {
      L.push(`| ${SEVERITY_LABEL[r.severity] ?? r.severity} | ${r.type} | ${r.url ? '`' + r.url + '`' : '（站点级）'} | ${r.detail} |`);
    }
    L.push('</details>');
  }
  if (diff.counts.observations) L.push(`\n> 另有 ${diff.counts.observations} 项波动观测（LCP/CLS/FCP）不计入判定。`);
  return L.join('\n') + '\n';
}
