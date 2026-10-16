#!/usr/bin/env node
/** Fixed-injection evaluation; reports case denominators rather than check counts. */
import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startAcceptanceFixture, ACCEPTANCE_FIXTURE_CASES } from '../test/fixtures/acceptance-site.mjs';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { summarizeAcceptanceReport, acceptanceMarkdown } from '../src/acceptance/report.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const desktop = { name: 'desktop', width: 1280, height: 800 };
const mobile = { name: 'mobile', width: 390, height: 844 };
const scope = '离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。';
const ratio = (numerator, denominator) => denominator ? +(numerator / denominator).toFixed(4) : null;
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const pct = value => value === null ? '无分母' : `${(value * 100).toFixed(2)}%`;

function pointsFor(item) {
  const common = { id: `truth-${item.id}`, title: item.title, route: `/${item.id}`, severity: 'high' };
  if (item.id === 'mobile-menu') return [{ ...common, assertions: [{ kind: 'visible', selector: '#menu-toggle' }] }];
  if (item.id === 'menu-state') return [{ ...common, steps: [{ action: 'click', selector: '#menu-toggle' }], assertions: [
    { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
    { kind: 'visible', selector: '#menu' },
  ] }];
  if (item.id === 'missing-field') return [{ ...common, assertions: [{ kind: 'text', selector: '#quota', contains: '128 个任务' }] }];
  if (item.id === 'wrong-link') return [{ ...common, steps: [{ action: 'click', selector: '#details-link' }], assertions: [{ kind: 'url', contains: '/details' }] }];
  return [];
}

export function acceptanceFixturePlan(item, fixture) {
  return normalizeAcceptancePlan({ schemaVersion: 1, name: `固定注入基准 · ${item.title}`, mode: 'mirror',
    baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl,
    routes: [`/${item.id}`], viewports: [item.viewport === 'mobile' ? mobile : desktop],
    thresholds: { visual: 0.97 }, timeoutMs: 2000, settleMs: 180,
    normalization: { maskSelectors: item.id === 'masked-noise' ? ['#dynamic-noise'] : [] },
    points: pointsFor(item) });
}

function evaluateCase(item, report, caseDir) {
  const checks = report.checks ?? [];
  const expectedMinimumChecks = 6 + pointsFor(item).length;
  const complete = report.coverage?.planned >= expectedMinimumChecks
    && report.coverage?.completed === report.coverage?.planned
    && report.coverage?.completed === checks.length && !report.coverage?.capped;
  const bugs = checks.filter(check => check.verdict === 'bug');
  const predictedBug = bugs.length > 0;
  const reasons = [];
  if (predictedBug !== item.targetBug) reasons.push(item.targetBug ? '已知目标缺陷漏检' : '非目标缺陷被误报为 BUG');
  if (!checks.some(check => check.verdict === item.expectedVerdict)) reasons.push(`没有产出预期分类 ${item.expectedVerdict}`);
  if (item.expectedGate === 'passed' && report.gate !== 'passed') reasons.push(`预期通过，实际门禁 ${report.gate}`);
  if (item.expectedGate === 'not_passed' && report.gate === 'passed') reasons.push('基线失败或阻塞被误算为通过');
  if (item.targetBug && report.gate !== 'failed') reasons.push(`已知 BUG 应阻断门禁，实际 ${report.gate}`);
  if (!complete || report.summary?.missing || report.summary?.invalid) reasons.push('执行覆盖缺失、截断或结果状态无效');
  for (const bug of bugs) {
    if (bug.status !== 'failed') reasons.push(`${bug.id} 的 BUG 状态不合法`);
    if (!bug.evidence?.baselineScreenshot || !bug.evidence?.targetScreenshot || !bug.evidence?.baselineDetails
      || !bug.evidence?.targetDetails || !bug.reproduction?.length) reasons.push(`${bug.id} 缺少双方截图、DOM 摘要或复现步骤`);
    for (const key of ['baselineScreenshot', 'targetScreenshot', 'baselineDetails', 'targetDetails']) {
      const file = bug.evidence?.[key];
      const rel = typeof file === 'string' ? relative(caseDir, resolve(caseDir, file)) : '..';
      let exists = false;
      try { exists = !!rel && !rel.startsWith('..') && !isAbsolute(rel) && statSync(resolve(caseDir, file)).isFile(); } catch { /* Missing evidence must fail this benchmark. */ }
      if (!exists) reasons.push(`${bug.id} 的 ${key} 证据文件缺失或越界`);
    }
  }
  return { id: item.id, title: item.title, targetBug: item.targetBug, predictedBug,
    expectedVerdict: item.expectedVerdict, expectedGate: item.expectedGate ?? 'failed', actualGate: report.gate,
    verdicts: [...new Set(checks.map(check => check.verdict))],
    checkCount: checks.length, bugChecks: bugs.map(check => check.id),
    complete,
    passed: reasons.length === 0, reasons, report: `${item.id}/report.json`, markdown: `${item.id}/report.md` };
}

function markdownFor(result) {
  const m = result.metrics;
  return [`# 固定注入缺陷基准`, '', `运行：${result.runId}`, `生成时间：${result.generatedAt}`, '',
    `**${scope}**`, '', `基准门禁：${result.passed ? '通过' : '失败'}；案例验收通过 ${result.cases.filter(item => item.passed).length}/${result.cases.length}。`, '',
    '## 计算口径', '',
    `统计单位是独立案例；一个案例产生多条检查或多张截图，仍只计一个样本。已知目标 BUG 分母 ${m.knownBugCases}，非目标 BUG 分母 ${m.nonBugCases}，总案例 ${m.totalCases}。`, '',
    '- TP：已知目标 BUG 案例中至少一条检查归因为 BUG。',
    '- FP：非目标 BUG 案例被至少一条检查归因为 BUG。',
    '- FN：已知目标 BUG 案例没有被识别；执行失败、未测与阻塞均不能免除漏检。',
    '- TN：非目标 BUG 案例没有被误报为 BUG。TN 只表示无误报，仍须通过案例预期分类和门禁校验。', '',
    '| 指标 | 数值 |', '| --- | ---: |',
    `| TP / FP / FN / TN | ${m.truePositive} / ${m.falsePositive} / ${m.falseNegative} / ${m.trueNegative} |`,
    `| Precision = TP / (TP + FP) | ${pct(m.precision)} |`,
    `| Recall = TP / 已知目标 BUG 案例 | ${pct(m.recall)} |`,
    `| False positive rate = FP / 非目标 BUG 案例 | ${pct(m.falsePositiveRate)} |`,
    `| 运行耗时 | ${result.durationMs} ms |`, '',
    '## 案例结果', '', '| 案例 | 真值 | 检出 | 门禁 | 案例校验 | 问题 |', '| --- | --- | --- | --- | --- | --- |',
    ...result.cases.map(item => `| ${cell(item.id)} · ${cell(item.title)} | ${item.targetBug ? '目标 BUG' : cell(item.expectedVerdict)} | ${item.predictedBug ? 'BUG' : '无 BUG'} | ${cell(item.actualGate)} | ${item.passed ? '通过' : '失败'} | ${cell(item.reasons.join('；'))} |`), '',
    '## 证据', '', ...result.cases.map(item => `- [${item.id} 报告](${item.markdown})：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。`), '',
    'fixture、truth 和检测器均属于仓库内的固定演示材料，样本没有代表性抽样。这里的 precision / recall 只适用于这组注入案例，不可对外描述为真实项目检出率。基线错误及只读阻塞必须维持非通过状态；遮罩规则由计划显式声明。', ''].join('\n');
}

export async function benchmarkAcceptance({ outputDir = join(CORE, 'workspace', '_runs', 'acceptance-benchmark') } = {}) {
  const started = Date.now();
  const runId = `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  outputDir = resolve(outputDir);
  const runDir = join(outputDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'truth.json'), JSON.stringify({ scope, cases: ACCEPTANCE_FIXTURE_CASES }, null, 2));
  const fixture = await startAcceptanceFixture();
  const cases = [];
  try {
    for (const item of ACCEPTANCE_FIXTURE_CASES) {
      const caseDir = join(runDir, item.id);
      await mkdir(caseDir, { recursive: true });
      const plan = acceptanceFixturePlan(item, fixture);
      await writeFile(join(caseDir, 'plan.json'), JSON.stringify(plan, null, 2));
      let report;
      try {
        const raw = await runAcceptance(plan, { runId: `${runId}-${item.id}`, outputDir: caseDir });
        raw.scope = scope;
        raw.checks = (raw.checks ?? []).map(check => ({ ...check, evidenceLevel: 'offline-reproduced' }));
        report = summarizeAcceptanceReport(raw);
      } catch (error) {
        report = summarizeAcceptanceReport({ runId: `${runId}-${item.id}`, name: plan.name, mode: plan.mode,
          baselineUrl: plan.baselineUrl, targetUrl: plan.targetUrl, status: 'failed', scope,
          startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
          coverage: { planned: 1, completed: 0 }, checks: [], error: String(error?.message ?? error) });
      }
      await writeFile(join(caseDir, 'report.json'), JSON.stringify(report, null, 2));
      await writeFile(join(caseDir, 'report.md'), acceptanceMarkdown(report));
      const result = evaluateCase(item, report, caseDir);
      cases.push(result);
      console.log(`[acceptance-benchmark] ${item.id}: ${result.passed ? 'PASS' : 'FAIL'}; targetBug=${item.targetBug}; detected=${result.predictedBug}; gate=${report.gate}${result.reasons.length ? '; ' + result.reasons.join('; ') : ''}`);
    }
  } finally { await fixture.close(); }
  const truePositive = cases.filter(item => item.targetBug && item.predictedBug).length;
  const falsePositive = cases.filter(item => !item.targetBug && item.predictedBug).length;
  const falseNegative = cases.filter(item => item.targetBug && !item.predictedBug).length;
  const trueNegative = cases.filter(item => !item.targetBug && !item.predictedBug).length;
  const knownBugCases = cases.filter(item => item.targetBug).length;
  const nonBugCases = cases.length - knownBugCases;
  const result = { schemaVersion: 1, runId, generatedAt: new Date().toISOString(), scope, outputDir: runDir,
    durationMs: Date.now() - started, passed: cases.length === ACCEPTANCE_FIXTURE_CASES.length && cases.every(item => item.passed),
    metrics: { unit: 'case', totalCases: cases.length, knownBugCases, nonBugCases, truePositive, falsePositive, falseNegative, trueNegative,
      precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, knownBugCases), falsePositiveRate: ratio(falsePositive, nonBugCases) }, cases };
  await writeFile(join(runDir, 'benchmark.json'), JSON.stringify(result, null, 2));
  await writeFile(join(runDir, 'benchmark.md'), markdownFor(result));
  await writeFile(join(outputDir, 'latest.json'), JSON.stringify({ runId, outputDir: runDir, passed: result.passed, metrics: result.metrics, generatedAt: result.generatedAt }, null, 2));
  console.log(`[acceptance-benchmark] ${JSON.stringify({ ...result.metrics, passed: result.passed, outputDir: runDir })}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: node core/scripts/benchmark-acceptance.mjs [outputDir]');
    process.exitCode = process.argv.length > 3 ? 2 : 0;
  } else {
    try { const result = await benchmarkAcceptance({ outputDir: process.argv[2] }); process.exitCode = result.passed ? 0 : 1; }
    catch (error) { console.error('[acceptance-benchmark]', error?.stack ?? error); process.exitCode = 1; }
  }
}
