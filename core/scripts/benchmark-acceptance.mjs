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
import { localizeAcceptanceRun, localizationMarkdown } from '../src/acceptance/localize.mjs';
import { exploreAcceptanceBaseline } from '../src/acceptance/explore.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const desktop = { name: 'desktop', width: 1280, height: 800 };
const mobile = { name: 'mobile', width: 390, height: 844 };
const tablet = { name: 'tablet', width: 768, height: 1024 };
const scope = '离线复现：固定注入缺陷夹具，仅证明本基准中声明的案例与观察窗口；不代表真实站点业务验收或通用检出率。';
const ratio = (numerator, denominator) => denominator ? +(numerator / denominator).toFixed(4) : null;
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const pct = value => value === null ? '无分母' : `${(value * 100).toFixed(2)}%`;
const LEVEL_TEXT = { source: '源码', element: '仅元素', miss: '未命中' };

/** Where each injected defect lives: the finding kind, the element and the authored text the localizer must point at. */
export const LOCALIZATION_TRUTH = Object.freeze({
  'visual-shift': { kind: 'style', selector: 'main', text: 'translateY(160px)' },
  'mobile-menu': { kind: 'hidden', selector: '#menu-toggle', text: '#menu-toggle{display:none}' },
  'menu-state': { kind: 'handler', selector: '#menu-toggle', text: "addEventListener('click'" },
  'missing-field': { kind: 'missing', selector: '#quota', text: 'class="metric"' },
  'wrong-link': { kind: 'attribute', selector: '#details-link', text: 'href="pricing"' },
  'runtime-error': { kind: 'script-error', text: 'throw new Error' },
  'missing-resource': { kind: 'resource', text: 'missing-widget.js' },
  'title-change': { kind: 'text', selector: 'title', text: 'Heimdall 验收演示 · 新版' },
  'heading-change': { kind: 'text', selector: 'h1 #1', text: '团队项目总览' },
  'aria-label-change': { kind: 'attribute', selector: '#menu-toggle', text: 'aria-label="主菜单"' },
  'overflow-mobile': { kind: 'overflow', selector: '#wide', text: 'width:1600px' },
  'broken-link': { kind: 'attribute', selector: '#details-link', text: 'href="gone"' },
  'tablet-shift': { kind: 'style', selector: 'main', text: 'translateY(120px)' },
});

/** Source hit: a finding of the declared kind on the declared element whose authored excerpt holds the injected text at a line. */
export function localizationHit(truth, localization) {
  if (!truth || !localization) return null;
  const findings = (localization.checks ?? []).flatMap(check => (check.findings ?? []).map(finding => ({ ...finding, checkId: check.checkId })));
  const onTarget = findings.filter(finding => finding.kind === truth.kind && (!truth.selector || [finding.selector, finding.element].includes(truth.selector)));
  const authored = finding => [finding.source?.declaration, finding.source?.excerpt].some(value => String(value ?? '').includes(truth.text));
  const matched = onTarget.find(finding => finding.source?.line > 0 && authored(finding));
  const pick = finding => finding && { checkId: finding.checkId, kind: finding.kind, selector: finding.selector ?? null, detail: finding.detail ?? null,
    source: finding.source ? { url: finding.source.url ?? null, line: finding.source.line ?? null, column: finding.source.column ?? null,
      excerpt: finding.source.excerpt ?? finding.source.declaration ?? null } : null };
  if (matched) return { level: 'source', finding: pick(matched) };
  return onTarget.length ? { level: 'element', finding: pick(onTarget[0]) } : { level: 'miss', finding: null };
}

/** Nearest-rank percentiles; with a dozen samples P95 is the slowest case, which is the honest reading. */
function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const rank = p => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return { samples: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? null };
}

function pointsFor(item) {
  const common = { id: `truth-${item.id}`, title: item.title, route: `/${item.id}`, severity: 'high' };
  if (item.id === 'mobile-menu') return [{ ...common, assertions: [{ kind: 'visible', selector: '#menu-toggle' }] }];
  if (item.id === 'menu-state') return [{ ...common, steps: [{ action: 'click', selector: '#menu-toggle' }], assertions: [
    { kind: 'attribute', selector: '#menu-toggle', attribute: 'aria-expanded', equals: 'true' },
    { kind: 'visible', selector: '#menu' },
  ] }];
  if (item.id === 'missing-field') return [{ ...common, assertions: [{ kind: 'text', selector: '#quota', contains: '128 个任务' }] }];
  if (item.id === 'wrong-link' || item.id === 'broken-link') return [{ ...common, steps: [{ action: 'click', selector: '#details-link' }], assertions: [{ kind: 'url', contains: '/details' }] }];
  return [];
}

export function acceptanceFixturePlan(item, fixture) {
  return normalizeAcceptancePlan({ schemaVersion: 1, name: `固定注入基准 · ${item.title}`, mode: 'mirror',
    baselineUrl: fixture.baselineUrl, targetUrl: fixture.targetUrl,
    routes: [`/${item.id}`], viewports: [item.viewport === 'mobile' ? mobile : item.viewport === 'tablet' ? tablet : desktop],
    // A pure translation on a low-contrast background changes ~1.5% of pixels; the default 0.97 gate needs a strict threshold to catch it.
    thresholds: { visual: item.id === 'tablet-shift' ? 0.995 : 0.97 }, timeoutMs: 2000, settleMs: 180,
    normalization: { maskSelectors: item.id === 'masked-noise' ? ['#dynamic-noise'] : [] },
    points: pointsFor(item) });
}

function evaluateCase(item, report, caseDir, { durationMs = null, localization = null, localizationMs = null,
  pointCount = pointsFor(item).length, requireLocalization = true } = {}) {
  const checks = report.checks ?? [];
  const expectedMinimumChecks = 6 + pointCount;
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
  const truth = LOCALIZATION_TRUTH[item.id] ?? null;
  const hit = requireLocalization && item.targetBug && predictedBug ? localizationHit(truth, localization ?? { checks: [] }) : null;
  if (requireLocalization) {
    if (item.targetBug && !truth) reasons.push('已知 BUG 案例缺少元素定位真值');
    if (localization?.status === 'error') reasons.push(`元素定位执行失败：${localization.error}`);
    else if (hit && hit.level !== 'source') reasons.push(`元素定位未命中注入点（${LEVEL_TEXT[hit.level]}）`);
  }
  return { id: item.id, title: item.title, targetBug: item.targetBug, predictedBug,
    expectedVerdict: item.expectedVerdict, expectedGate: item.expectedGate ?? 'failed', actualGate: report.gate,
    verdicts: [...new Set(checks.map(check => check.verdict))],
    checkCount: checks.length, bugChecks: bugs.map(check => check.id),
    complete, durationMs,
    localization: localization ? { status: localization.status, level: hit?.level ?? null, expected: hit ? truth : null, matched: hit?.finding ?? null,
      checks: localization.totals ?? null, durationMs: localizationMs, report: `${item.id}/localization.json`,
      markdown: localization.status === 'error' ? null : `${item.id}/localization.md` } : null,
    passed: reasons.length === 0, reasons, report: `${item.id}/report.json`, markdown: `${item.id}/report.md` };
}

async function runAutoArm({ fixture, item, plan, runDir, runId }) {
  const autoDir = join(runDir, 'auto', item.id);
  await mkdir(autoDir, { recursive: true });
  const started = Date.now();
  let exploration;
  try {
    // No plan points are passed: the arm measures what the explorer finds on its own, and plans the runner accepts.
    exploration = await exploreAcceptanceBaseline({ baselineUrl: fixture.baselineUrl, routes: plan.routes, viewports: plan.viewports,
      timeoutMs: plan.timeoutMs, settleMs: plan.settleMs, budgetMs: 90_000 });
  } catch (error) {
    exploration = { points: [], summary: { candidates: 0, skipped: {} }, routes: [], error: String(error?.message ?? error) };
  }
  const points = exploration.points ?? [];
  const autoPlan = { ...plan, name: `${plan.name} · 自动生成验收点`, points };
  await writeFile(join(autoDir, 'plan.json'), JSON.stringify(autoPlan, null, 2));
  await writeFile(join(autoDir, 'exploration.json'), JSON.stringify(exploration, null, 2));
  const writeReport = async (report, name) => {
    await writeFile(join(autoDir, name + '.json'), JSON.stringify(report, null, 2));
    await writeFile(join(autoDir, name + '.md'), acceptanceMarkdown(report));
  };
  let autoReport;
  try {
    const raw = await runAcceptance(autoPlan, { runId: `${runId}-auto-${item.id}`, outputDir: autoDir });
    raw.scope = scope;
    raw.checks = (raw.checks ?? []).map(check => ({ ...check, evidenceLevel: 'offline-reproduced' }));
    autoReport = summarizeAcceptanceReport(raw);
  } catch (error) {
    autoReport = summarizeAcceptanceReport({ runId: `${runId}-auto-${item.id}`, name: autoPlan.name, mode: autoPlan.mode,
      baselineUrl: autoPlan.baselineUrl, targetUrl: autoPlan.targetUrl, status: 'failed', scope,
      startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
      coverage: { planned: 1, completed: 0 }, checks: [], error: String(error?.message ?? error) });
  }
  await writeReport(autoReport, 'report');
  const evaluation = evaluateCase(item, autoReport, autoDir, { durationMs: Date.now() - started, pointCount: points.length, requireLocalization: false });
  const skipped = exploration.summary?.skipped ?? {};
  return { ...evaluation, points: points.length,
    exploration: { candidates: points.length, skipped, routes: (exploration.routes ?? []).map(route => ({ route: route.route, status: route.status })),
      ...(exploration.error ? { error: exploration.error } : {}) },
    report: `auto/${item.id}/report.json`, markdown: `auto/${item.id}/report.md`, explorationReport: `auto/${item.id}/exploration.json` };
}

const ms = value => value === null ? '-' : `${value} ms`;
const pathOf = url => { try { return new URL(url).pathname; } catch { return url ?? '?'; } };
const pointer = finding => {
  if (!finding) return '-';
  const source = finding.source;
  const where = source?.line ? `${pathOf(source.url)}:${source.line}:${source.column}` : '无源码行';
  return `${finding.kind} ${finding.selector ?? ''} → ${where}${source?.excerpt ? ` \`${String(source.excerpt).replaceAll('`', "'").slice(0, 90)}\`` : ''}`;
};

function markdownFor(result) {
  const m = result.metrics;
  const l = m.localization;
  const a = m.auto;
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
    `| 单案验收耗时 P50 / P95 | ${ms(m.timing.acceptance.p50)} / ${ms(m.timing.acceptance.p95)} |`,
    `| 运行耗时 | ${result.durationMs} ms |`, '',
    '## 元素定位', '',
    `对每个检出的已知 BUG 案例，在验收结束后重新渲染双方页面，把失败检查落到元素和源码行（旁路 \`localization.json\`，不改报告与核验指纹）。分母是检出的已知 BUG 案例 ${l.detectedBugCases} 个。`, '',
    '- 命中源码：定位结果里有与注入点同类、同元素的发现，且其源码摘录含注入文本、带行号。',
    '- 仅元素：找到了同类同元素的发现，但源码位置或摘录不对。',
    '- 未命中：没有同类同元素的发现，或定位执行失败。', '',
    '| 指标 | 数值 |', '| --- | ---: |',
    `| 命中源码 / 仅元素 / 未命中 | ${l.sourceHits} / ${l.elementOnly} / ${l.misses} |`,
    `| 源码命中率 = 命中源码 / 检出的已知 BUG 案例 | ${pct(l.sourceHitRate)} |`,
    `| 单案定位耗时 P50 / P95 | ${ms(m.timing.localization.p50)} / ${ms(m.timing.localization.p95)} |`, '',
    '| 案例 | 定位结果 | 指向 |', '| --- | --- | --- |',
    ...result.cases.filter(item => item.localization?.level).map(item => `| ${cell(item.id)} | ${LEVEL_TEXT[item.localization.level]} | ${cell(pointer(item.localization.matched))} |`), '',
    '## 自动生成验收点', '',
    '第二个基准臂只使用**自动生成的验收点**：在每条案例的基线上逐页探索可见控件，把单步点击/填写前后可观察的变化写成断言，按执行器语义在计划视口上重放，只保留稳定成立的断言；不加入任何手写验收点。默认检查（导航、运行健康、结构、视觉）仍然执行。回放证据在 `auto/<案例>/`。', '',
    `该臂共生成 ${a.points} 个验收点；已知目标 BUG 案例 ${a.detected} 个被检出，非目标 BUG 案例误报 ${a.falsePositives} 个，案例校验通过 ${a.passed}/${a.cases}。`, '',
    '| 案例 | 自动点 | 检出 | 门禁 | 案例校验 | 问题 |', '| --- | ---: | --- | --- | --- | --- |',
    ...result.cases.map(item => `| ${cell(item.id)} | ${item.auto?.points ?? '-'} | ${item.auto?.predictedBug ? 'BUG' : '无 BUG'} | ${cell(item.auto?.actualGate)} | ${item.auto?.passed ? '通过' : '失败'} | ${cell((item.auto?.reasons ?? []).join('；'))} |`), '',
    '## 案例结果', '', '| 案例 | 真值 | 检出 | 门禁 | 案例校验 | 问题 |', '| --- | --- | --- | --- | --- | --- |',
    ...result.cases.map(item => `| ${cell(item.id)} · ${cell(item.title)} | ${item.targetBug ? '目标 BUG' : cell(item.expectedVerdict)} | ${item.predictedBug ? 'BUG' : '无 BUG'} | ${cell(item.actualGate)} | ${item.passed ? '通过' : '失败'} | ${cell(item.reasons.join('；'))} |`), '',
    '## 证据', '', ...result.cases.map(item => `- [${item.id} 报告](${item.markdown})：双方截图、重复截图、DOM/网络/console 摘要、差异图与操作步骤见同目录。${item.localization?.markdown && item.localization.status === 'completed' ? `[元素定位](${item.localization.markdown})。` : ''}`), '',
    'fixture、truth 和检测器均属于仓库内的固定演示材料，样本没有代表性抽样。这里的 precision / recall 只适用于这组注入案例，不可对外描述为真实项目检出率。基线错误及只读阻塞必须维持非通过状态；遮罩规则由计划显式声明。', ''].join('\n');
}

export async function benchmarkAcceptance({ outputDir = join(CORE, 'workspace', '_runs', 'acceptance-benchmark') } = {}) {
  const started = Date.now();
  const runId = `benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  outputDir = resolve(outputDir);
  const runDir = join(outputDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'truth.json'), JSON.stringify({ scope, cases: ACCEPTANCE_FIXTURE_CASES, localization: LOCALIZATION_TRUTH }, null, 2));
  const fixture = await startAcceptanceFixture();
  const cases = [];
  try {
    for (const item of ACCEPTANCE_FIXTURE_CASES) {
      const caseDir = join(runDir, item.id);
      await mkdir(caseDir, { recursive: true });
      const plan = acceptanceFixturePlan(item, fixture);
      await writeFile(join(caseDir, 'plan.json'), JSON.stringify(plan, null, 2));
      const caseStarted = Date.now();
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
      const durationMs = Date.now() - caseStarted;
      await writeFile(join(caseDir, 'report.json'), JSON.stringify(report, null, 2));
      await writeFile(join(caseDir, 'report.md'), acceptanceMarkdown(report));
      // Localization is a post-run sidecar: it re-renders against the same fixture and never touches the report.
      let localization = null, localizationMs = null;
      if ((report.checks ?? []).some(check => check.verdict === 'bug')) {
        const localizeStarted = Date.now();
        try { localization = await localizeAcceptanceRun(caseDir, { report, plan }); }
        catch (error) { localization = { status: 'error', error: String(error?.message ?? error) }; }
        localizationMs = Date.now() - localizeStarted;
        await writeFile(join(caseDir, 'localization.json'), JSON.stringify(localization, null, 2));
        if (localization.status !== 'error') await writeFile(join(caseDir, 'localization.md'), localizationMarkdown(localization));
      }
      const result = evaluateCase(item, report, caseDir, { durationMs, localization, localizationMs });
      // Second arm: only points proposed by exploring the baseline, no hand-written acceptance points.
      result.auto = await runAutoArm({ fixture, item, plan, runDir, runId });
      cases.push(result);
      console.log(`[acceptance-benchmark] ${item.id}: ${result.passed ? 'PASS' : 'FAIL'}; targetBug=${item.targetBug}; detected=${result.predictedBug}; gate=${report.gate}${result.localization?.level ? `; localized=${result.localization.level}` : ''}; auto=${result.auto.points} point(s), detected=${result.auto.predictedBug}, gate=${result.auto.actualGate}${result.reasons.length ? '; ' + result.reasons.join('; ') : ''}${result.auto.reasons.length ? '; auto: ' + result.auto.reasons.join('; ') : ''}`);
    }
  } finally { await fixture.close(); }
  const truePositive = cases.filter(item => item.targetBug && item.predictedBug).length;
  const falsePositive = cases.filter(item => !item.targetBug && item.predictedBug).length;
  const falseNegative = cases.filter(item => item.targetBug && !item.predictedBug).length;
  const trueNegative = cases.filter(item => !item.targetBug && !item.predictedBug).length;
  const knownBugCases = cases.filter(item => item.targetBug).length;
  const nonBugCases = cases.length - knownBugCases;
  const detected = cases.filter(item => item.targetBug && item.predictedBug);
  const levels = detected.map(item => item.localization?.level ?? 'miss');
  const sourceHits = levels.filter(level => level === 'source').length;
  const localization = { unit: 'case', detectedBugCases: detected.length, sourceHits, elementOnly: levels.filter(level => level === 'element').length,
    misses: levels.filter(level => level === 'miss').length, sourceHitRate: ratio(sourceHits, detected.length) };
  const timing = { unit: 'ms', acceptance: percentiles(cases.map(item => item.durationMs)),
    localization: percentiles(cases.map(item => item.localization?.durationMs ?? null)) };
  const autoCases = cases.map(item => item.auto).filter(Boolean);
  const auto = { arm: 'auto-points-only', cases: autoCases.length, points: autoCases.reduce((sum, item) => sum + item.points, 0),
    detected: autoCases.filter(item => item.targetBug && item.predictedBug).length,
    falsePositives: autoCases.filter(item => !item.targetBug && item.predictedBug).length,
    passed: autoCases.filter(item => item.passed).length };
  const result = { schemaVersion: 1, runId, generatedAt: new Date().toISOString(), scope, outputDir: runDir,
    durationMs: Date.now() - started,
    passed: cases.length === ACCEPTANCE_FIXTURE_CASES.length && cases.every(item => item.passed && item.auto?.passed),
    metrics: { unit: 'case', totalCases: cases.length, knownBugCases, nonBugCases, truePositive, falsePositive, falseNegative, trueNegative,
      precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, knownBugCases), falsePositiveRate: ratio(falsePositive, nonBugCases),
      localization, timing, auto }, cases };
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
