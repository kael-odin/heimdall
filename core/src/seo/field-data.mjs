/**
 * seo/field-data — 真实用户指标（field data）
 *
 * 我们此前量的**全是实验室数据**：本机 Playwright 跑一遍，LCP/CLS 都是这一台机器
 * 这一次的结果。它回答"这台机器上快不快"，不回答"真实用户觉得快不快"。
 * 真实用户指标的权威来源是 CrUX（Chrome 用户体验报告），经 PageSpeed Insights API 取。
 *
 * **需要自备 API Key**：无 Key 的匿名配额是全局共享的，实测直接 429
 * （"Quota exceeded ... for consumer project_number:583797351490"）。
 * 所以这里做成**可选接入** —— 配了 HEIMDALL_PSI_KEY 才取，没配就在报告里说清楚
 * "我们只有实验室数据"，而不是假装有实时数据。
 *
 * 解析是纯函数（parsePsiResponse），单测直接喂响应体；取数那一步依赖外网，
 * 没有 Key 就无法在这里验证 —— 文档里如实标注，不写成"已验证"。
 */
import { getEnv } from '../env.mjs';

const PSI_ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

/** CrUX 的指标名 → 我们的短名。CLS 在 API 里是「百分之一」为单位的整数。 */
const METRIC_MAP = {
  LARGEST_CONTENTFUL_PAINT_MS: { key: 'lcp', unit: 'ms' },
  CUMULATIVE_LAYOUT_SHIFT_SCORE: { key: 'cls', unit: 'score', scale: 0.01 },
  INTERACTION_TO_NEXT_PAINT: { key: 'inp', unit: 'ms' },
  FIRST_CONTENTFUL_PAINT_MS: { key: 'fcp', unit: 'ms' },
  EXPERIMENTAL_TIME_TO_FIRST_BYTE: { key: 'ttfb', unit: 'ms' },
};

const CATEGORY_CN = { FAST: '快', AVERAGE: '一般', SLOW: '慢' };
export const categoryCn = (c) => CATEGORY_CN[c] ?? c ?? '—';

/**
 * 把 PSI 响应里的真实用户数据抽出来。纯函数。
 * 没有 field data（新站/流量太小）时返回 `{ available: false, reason }` —— 这是常态，不是错误。
 */
export function parsePsiResponse(json) {
  const le = json?.loadingExperience;
  if (!le || !le.metrics || !Object.keys(le.metrics).length) {
    return { available: false, reason: le ? 'CrUX 没有这个源的数据（流量不足）' : '响应里没有 loadingExperience（未启用真实用户数据）' };
  }
  const metrics = {};
  for (const [raw, def] of Object.entries(METRIC_MAP)) {
    const m = le.metrics[raw];
    if (!m || typeof m.percentile !== 'number') continue;
    const p75 = def.scale ? +(m.percentile * def.scale).toFixed(3) : m.percentile;
    metrics[def.key] = { p75, unit: def.unit, category: m.category ?? null };
  }
  return {
    available: true,
    overall: le.overall_category ?? null,
    metrics,
  };
}

/** 取一个站点的真实用户指标。没配 Key 直接返回 could-not，不发请求。 */
export async function fetchFieldData(url, { key = getEnv().HEIMDALL_PSI_KEY, strategy = 'mobile', timeoutMs = 25_000 } = {}) {
  if (!key) return { ok: false, available: false, reason: '未配置 HEIMDALL_PSI_KEY（无 Key 的匿名配额是全局共享的，实测 429）' };
  const qs = new URLSearchParams({ url, strategy });
  if (key) qs.set('key', key);
  try {
    const res = await fetch(`${PSI_ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message ?? `HTTP ${res.status}`;
      return { ok: false, available: false, reason: String(msg).slice(0, 160) };
    }
    return { ok: true, strategy, ...parsePsiResponse(json) };
  } catch (e) {
    return { ok: false, available: false, reason: String(e).slice(0, 140) };
  }
}

/** 实验室值 vs 真实用户 p75 的一句话对照 —— 两者差得远时，说明实验室数字骗人 */
export function compareLabToField(labVitals = {}, field = {}) {
  if (!field.available) return null;
  const rows = [];
  const pairs = [
    ['lcp', labVitals.lcp, 'LCP'],
    ['cls', labVitals.cls, 'CLS'],
  ];
  for (const [k, labVal, label] of pairs) {
    const f = field.metrics?.[k];
    if (f == null || labVal == null) continue;
    const ratio = f.p75 ? labVal / f.p75 : null;
    rows.push({ key: k, label, lab: labVal, field: f.p75, category: f.category, ratio });
  }
  if (!rows.length) return null;
  // ratio = 实验室值 / 真实用户 p75。这两个指标都是**越小越好**，所以
  //   ratio 明显小于 1 → 实验室数字比真实用户漂亮（本机偏乐观）
  //   ratio 明显大于 1 → 实验室数字比真实用户难看（本机偏悲观）
  const optimistic = rows.filter(r => r.ratio != null && r.ratio <= 0.67);
  const pessimistic = rows.filter(r => r.ratio != null && r.ratio >= 1.5);
  const name = (arr) => arr.map(r => r.label).join('/');
  let note = '实验室数据与真实用户量级一致。';
  if (optimistic.length && pessimistic.length) {
    note = `实验室与真实用户各有一项对不上（${name(optimistic)} 偏乐观、${name(pessimistic)} 偏悲观）—— 单机结果不能直接当用户体验结论`;
  } else if (optimistic.length) {
    note = `实验室数据比真实用户好（${name(optimistic)}）—— 本机跑的分数偏乐观，别拿它当"用户体验"结论`;
  } else if (pessimistic.length) {
    note = `实验室数据比真实用户差（${name(pessimistic)}）—— 本机环境（网络/机型）比真实用户更吃力`;
  }
  return { rows, note };
}
