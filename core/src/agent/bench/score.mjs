/**
 * agent/bench/score — Heimdall-Bench 的测量核心（E14-01 ~ E14-03，PRD 09 §1）
 *
 * 一次「候选 × 夹具」的测量：跑快速对比、组合六维门禁、读账本里的迭代数。
 * 纯测量，不依赖模型；模型臂（A1–A3）在 bench/agent.mjs 里驱动它。
 * 结论只覆盖所测夹具，失败与未测范围如实写进报告（PRD 09 §2.6）。
 */
import { readLedger, decisionsFor } from '../loops/ledger.mjs';
import { fastCompare } from '../evidence/compare.mjs';
import { composeGate } from '../gate/report.mjs';

const r5 = (v) => (typeof v === 'number' ? +v.toFixed(5) : null);

/** 量一个候选目录 */
export async function scoreCandidate({ siteId, page, candidateDir, level = 'silver', viewports, browser, label = null }) {
  const t0 = Date.now();
  const r = await fastCompare({ siteId, page, candidate: { dir: candidateDir }, viewports }, { ...(browser ? { browser } : {}), record: false });
  const gate = composeGate(r.packet, { level });
  const entries = readLedger(candidateDir).filter(e => e.type === 'iter');
  const decisions = decisionsFor(entries);
  const pixel = Object.fromEntries(Object.entries(r.packet.perViewport).map(([w, v]) => [w, r5(v.pixelSimilarity)]));
  const values = Object.values(pixel).filter(v => typeof v === 'number');
  return {
    label: label ?? candidateDir,
    dir: candidateDir,
    runId: r.packet.runId,
    pixel,
    minPixel: values.length ? Math.min(...values) : null,
    gate: {
      status: gate.status,
      reached: gate.reached,
      failed: gate.dimensions.filter(d => d.status === 'fail').map(d => d.id),
      notMeasured: gate.dimensions.filter(d => d.status === 'not_measured').map(d => d.id),
    },
    antitheft: r.packet.anticheat?.status ?? null,
    iterations: entries.length,
    compareMs: Date.now() - t0,
    budget: decisions.filter(d => d.action === 'accept-residual').length ? 'exhausted-sections' : 'ok',
  };
}

const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(2)}%`);

/** 分位数（线性插值）；PRD 09 §1.5 要求中位数与极值，n 小时 IQR 很粗，所以两个都给 */
export function quantile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return null;
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * 同一臂多次重复 → 每个视口的中位数 / 最小 / 最大（n 小于 3 时报告里要写明）。
 * @param {Array<{label, pixel}>} runs
 */
export function summarizeRuns(runs) {
  const byLabel = new Map();
  for (const r of runs) {
    const entry = byLabel.get(r.label) ?? { label: r.label, n: 0, viewports: {} };
    entry.n += 1;
    for (const [w, v] of Object.entries(r.pixel ?? {})) {
      if (typeof v !== 'number') continue;
      (entry.viewports[w] ??= []).push(v);
    }
    byLabel.set(r.label, entry);
  }
  return [...byLabel.values()].map(e => ({
    label: e.label, n: e.n,
    viewports: Object.fromEntries(Object.entries(e.viewports).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([w, vs]) => [w, { median: r5(quantile(vs, 0.5)), min: r5(Math.min(...vs)), max: r5(Math.max(...vs)) }])),
  }));
}

/** 重复测量的表：中位数（最小–最大），并标注 n */
export function summaryTable(summary) {
  const viewports = [...new Set(summary.flatMap(s => Object.keys(s.viewports)))].sort((a, b) => Number(a) - Number(b));
  const lines = ['| 臂 | n | ' + viewports.map(w => `${w}px 中位数（min–max）`).join(' | ') + ' |',
    '| --- | --- | ' + viewports.map(() => '---').join(' | ') + ' |'];
  for (const s of summary) {
    const cells = viewports.map(w => {
      const v = s.viewports[w];
      return v ? `${pct(v.median)}（${pct(v.min)}–${pct(v.max)}）` : '—';
    });
    lines.push(`| ${s.label} | ${s.n} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

/** 报告对象 */
export function benchReport({ fixture, level, rows, model = null, note = null }) {
  return {
    schema: 'heimdall.bench/1',
    generatedAt: new Date().toISOString(),
    fixture: { ...fixture, level },
    ...(model ? { model } : {}),
    ...(note ? { note } : {}),
    rows,
  };
}

/** Markdown 表：给人看的那张 */
export function benchTable(report) {
  const { fixture } = report;
  const head = `# Heimdall-Bench · ${fixture.siteId}/${fixture.page} · ${fixture.level}`;
  const lines = [head, '', `生成于 ${report.generatedAt}${report.model ? ` · 模型 ${report.model}` : ''}`, ''];
  const viewports = [...new Set(report.rows.flatMap(r => Object.keys(r.pixel ?? {})))].sort((a, b) => Number(a) - Number(b));
  lines.push(`| 候选 | ${viewports.map(w => `${w}px`).join(' | ')} | 门禁 | 迭代 | 对比耗时 |`);
  lines.push(`| --- | ${viewports.map(() => '---').join(' | ')} | --- | --- | --- |`);
  for (const r of report.rows) {
    const gate = r.gate.status === 'passed' ? `passed${r.gate.reached ? ` (${r.gate.reached})` : ''}`
      : `${r.gate.status}${r.gate.failed.length ? `: ${r.gate.failed.join(',')}` : ''}`;
    lines.push(`| ${r.label} | ${viewports.map(w => pct(r.pixel?.[w])).join(' | ')} | ${gate} | ${r.iterations} | ${(r.compareMs / 1000).toFixed(1)}s |`);
  }
  if (report.note) lines.push('', `说明：${report.note}`);
  lines.push('', '结论只覆盖所测夹具；快速裁判的 passed 不是正式裁判的通过。');
  return lines.join('\n') + '\n';
}
