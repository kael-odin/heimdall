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
