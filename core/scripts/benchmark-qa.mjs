#!/usr/bin/env node
/**
 * benchmark-qa — 无参照物检测的固定注入评测
 *
 * 口径与赛题一致：检出率（recall）、误报率、耗时。统计单位是案例，
 * 一个页面命中多个检测器仍按案例计。缺陷页一次运行覆盖全部注入点；
 * 健康页各自运行，任何检测器发现都算误报。
 *
 *   node core/scripts/benchmark-qa.mjs [输出目录]
 *
 * 默认输出到 core/workspace/_runs/qa-benchmark/<时间戳>/（被 Git 忽略）。
 * 有漏检或误报时退出码为 1。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFECT_CASES, CLEAN_CASES, INTERACTION_CASES, INTERACTION_CLEAN, startQaDefectFixture } from '../test/fixtures/qa-defect-site.mjs';
import { loadWorkspace } from '../src/qa/workspace.mjs';
import { runQa } from '../src/qa/run.mjs';
import { DETECTOR_META } from '../src/qa/detect.mjs';
import { diffSnapshots } from '../src/qa/explore.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const scope = '离线复现：固定注入夹具，仅证明本组缺陷与观察窗口；不代表真实站点或任意项目的检出率。';
const ratio = (a, b) => b ? +(a / b).toFixed(4) : null;
const pct = (v) => v === null ? '无分母' : `${(v * 100).toFixed(1)}%`;
const cell = (v) => String(v ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');

export function assertBenchmarkCoverage(coverage, expectedPath) {
  const detection = coverage?.detection;
  const pages = coverage?.pages;
  if (!detection?.enabled || !Array.isArray(detection.failedPages) || detection.failedPages.length
    || !Array.isArray(pages) || !pages.length || detection.pages !== pages.length
    || pages.some(p => !p || p.navError || p.unavailableReason || p.detectorError)
    || (expectedPath && (pages.length !== 1 || pages[0].path !== expectedPath))) {
    throw new Error('固定夹具检测未完成，不能计算检出率或误报率');
  }
}

export function assertInteractionBenchmarkCoverage(coverage, clicks, targets) {
  const explore = coverage?.explore;
  const page = explore?.pages?.[0];
  const expected = new Set(Array.isArray(targets) ? targets : []);
  if (!explore?.enabled || !Array.isArray(explore.pages) || explore.pages.length !== 1
    || !page || page.path !== '/interact' || page.controls !== expected.size || page.clicked !== expected.size
    || page.budgetExhausted !== false || !page.skipped || Array.isArray(page.skipped) || Object.keys(page.skipped).length
    || !Array.isArray(targets) || !targets.length || expected.size !== targets.length || !Array.isArray(clicks) || clicks.length !== expected.size
    || new Set(clicks).size !== expected.size || clicks.some(target => !expected.has(target))) {
    throw new Error('固定夹具交互探索未完成，不能计算检出率或误报率');
  }
}

export function matchBenchmarkFinding(item, findings) {
  return findings.find(f => {
    if (f.kind !== item.kind || f.target !== item.target || (item.detector && f.detector !== item.detector)
      || (item.basis && f.basis !== item.basis)
      || (item.observedIncludes && !f.observed?.includes(item.observedIncludes))) return false;
    const evidence = f.evidence ?? {};
    if (item.evidenceType === 'unchanged') {
      const complete = snapshot => snapshot && typeof snapshot.url === 'string' && typeof snapshot.title === 'string'
        && typeof snapshot.expanded === 'string'
        && ['textLength', 'textHash', 'visibleElements', 'bodyHeight', 'overlays'].every(key => Number.isFinite(snapshot[key]));
      return complete(evidence.before) && complete(evidence.after) && diffSnapshots(evidence.before, evidence.after).length === 0;
    }
    if (item.evidenceType === 'error') return Array.isArray(evidence.errors) && evidence.errors.some(error => String(error).includes(item.errorIncludes));
    if (item.evidenceType === 'http') {
      try { return evidence.status === item.status && new URL(evidence.failedUrl).pathname === item.failedPath; } catch { return false; }
    }
    return !item.evidenceType;
  });
}

function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const rank = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return { samples: sorted.length, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? null };
}

/** 一个临时工作区：一个站点、一个页面，检测器全开、链接检查关闭（夹具没有站内链接之外的东西） */
function workspaceFor(origin, path) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-bench-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    schema: 'heimdall.qa/1',
    project: 'QA 缺陷夹具',
    sites: { web: { label: '夹具', url: `${origin}/`, environment: 'test', pages: [path], writes: 'block' } },
    defaults: { viewport: { width: 1440, height: 900 }, settleMs: 1200, timeoutMs: 20_000 },
  }));
  return root;
}

async function runPage(origin, path, extraArgs = {}) {
  const root = workspaceFor(origin, path);
  const started = Date.now();
  try {
    const ws = loadWorkspace(root);
    const result = await runQa(ws, { site: 'web', viewports: [1440], linkCheck: false, ...extraArgs });
    assertBenchmarkCoverage(result.run.coverage, path);
    return {
      durationMs: Date.now() - started,
      findings: result.findings,
      detected: result.findings.filter(f => f.detector),
      interactions: result.findings.filter(f => f.kind === 'interaction'),
      coverage: result.run.coverage,
      runDir: relative(CORE, result.dir).replace(/\\/g, '/'),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const evidenceOf = (f) => ({
  detector: f.detector ?? null, kind: f.kind, tier: f.tier, target: f.target ?? null,
  basis: f.basis ?? null, title: f.title, observed: f.observed ?? null,
  ...(f.kind === 'interaction' ? { evidence: f.evidence ?? null } : {}),
});

export async function benchmarkQa({ outputDir = join(CORE, 'workspace', '_runs', 'qa-benchmark'), keepRuns = false,
  startFixture = startQaDefectFixture } = {}) {
  const started = Date.now();
  outputDir = resolve(outputDir);
  const runDir = join(outputDir, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });
  const latestFile = join(outputDir, 'latest.json');
  const startedAt = new Date(started).toISOString();
  writeFileSync(latestFile, JSON.stringify({ runDir, status: 'running', passed: null, startedAt }, null, 2));
  try {
    writeFileSync(join(runDir, 'truth.json'), JSON.stringify({ scope, defectCases: DEFECT_CASES, cleanCases: CLEAN_CASES,
      interactionCases: INTERACTION_CASES, interactionClean: INTERACTION_CLEAN, detectors: Object.keys(DETECTOR_META) }, null, 2));

    const fixture = await startFixture();
    const cases = [];
    const durations = [];
    let interactionCoverage = null;
    let unmatchedDefectFindings = [];
    let unmatchedInteractionFindings = [];
    try {
      const defectRun = await runPage(fixture.origin, '/defects');
      durations.push(defectRun.durationMs);
      const matchedDefects = new Set();
      for (const item of DEFECT_CASES) {
        const hit = matchBenchmarkFinding(item, defectRun.detected);
        if (hit) matchedDefects.add(hit);
        cases.push({
          id: item.id, kind: 'defect', title: item.title, expectedDetector: item.detector, expectedKind: item.kind,
          expectedTarget: item.target, detected: !!hit, matched: hit ? evidenceOf(hit) : null,
          reasons: hit ? [] : [`没有产出匹配 ${item.detector}、${item.kind} 和 ${item.target} 的预期发现`],
        });
      }
      unmatchedDefectFindings = defectRun.detected.filter(f => !matchedDefects.has(f)).map(evidenceOf);
      for (const item of CLEAN_CASES) {
        const cleanRun = await runPage(fixture.origin, `/${item.id}`);
        durations.push(cleanRun.durationMs);
        const falsePositives = cleanRun.detected;
        cases.push({
          id: item.id, kind: 'clean', title: item.title,
          detected: falsePositives.length > 0,
          falsePositives: falsePositives.map(f => ({ detector: f.detector, title: f.title, target: f.target ?? null })),
          reasons: falsePositives.length ? [`健康页出现 ${falsePositives.length} 条检测发现（误报）`] : [],
        });
      }

      // 交互段：只有显式开启探索才会点页面；正常的按钮点击有变化，不应被报。
      const interactRun = await runPage(fixture.origin, '/interact', { explore: true });
      durations.push(interactRun.durationMs);
      const clicks = fixture.recordedClicks();
      assertInteractionBenchmarkCoverage(interactRun.coverage, clicks, [...INTERACTION_CASES, ...INTERACTION_CLEAN].map(item => item.target));
      const matchedInteractions = new Set();
      for (const item of INTERACTION_CASES) {
        const hit = matchBenchmarkFinding(item, interactRun.interactions);
        if (hit) matchedInteractions.add(hit);
        cases.push({
          id: item.id, kind: 'defect', scope: 'interaction', title: item.title, expectedDetector: 'interaction',
          expectedTarget: item.target, detected: !!hit, matched: hit ? evidenceOf(hit) : null,
          reasons: hit ? [] : [`没有产出符合 ${item.target} 及预期问题证据的交互发现`],
        });
      }
      unmatchedInteractionFindings = interactRun.interactions.filter(f => !matchedInteractions.has(f)).map(evidenceOf);
      for (const item of INTERACTION_CLEAN) {
        const falsePositive = interactRun.interactions.find(f => f.target === item.target);
        cases.push({
          id: item.id, kind: 'clean', scope: 'interaction', title: item.title,
          detected: !!falsePositive,
          falsePositives: falsePositive ? [{ detector: 'interaction', title: falsePositive.title, target: falsePositive.target }] : [],
          reasons: falsePositive ? ['正常按钮被报为交互问题（误报）'] : [],
        });
      }
      interactionCoverage = { ...interactRun.coverage.explore, fixtureClicks: clicks };
    } finally {
      await fixture.close();
    }

    const defects = cases.filter(c => c.kind === 'defect');
    const cleans = cases.filter(c => c.kind === 'clean');
    const truePositive = defects.filter(c => c.detected).length;
    const falseNegative = defects.length - truePositive;
    const falsePositive = cleans.filter(c => c.detected).length;
    const trueNegative = cleans.length - falsePositive;
    const precision = ratio(truePositive, truePositive + falsePositive);
    const recall = ratio(truePositive, defects.length);
    const f1 = precision !== null && recall !== null && precision + recall > 0
      ? +((2 * precision * recall) / (precision + recall)).toFixed(4) : null;
    const timing = percentiles(durations);

    const result = {
      schemaVersion: 2, scope, generatedAt: new Date().toISOString(), durationMs: Date.now() - started, outputDir: runDir,
      metrics: {
        unit: 'case', defects: defects.length, cleans: cleans.length,
        truePositive, falsePositive, falseNegative, trueNegative,
        precision, recall, falsePositiveRate: ratio(falsePositive, cleans.length), f1, timing, interaction: interactionCoverage,
      },
      cases: cases.filter(c => c.kind !== 'timing'), unmatchedDefectFindings, unmatchedInteractionFindings,
    };
    result.passed = falseNegative === 0 && falsePositive === 0;

    const md = [
      '# 无参照物检测基准', '', `运行：${runDir}`, '',
      `**${scope}**`, '',
      `基准门禁：${result.passed ? '通过' : '失败'}；缺陷检出 ${truePositive}/${defects.length}，健康页误报 ${falsePositive}/${cleans.length}。`, '',
      '## 指标', '',
      '| 指标 | 数值 |', '| --- | ---: |',
      `| 案例级 Precision = TP / (TP + 健康案例 FP) | ${pct(precision)} |`,
      `| Recall = TP / 缺陷案例 | ${pct(recall)} |`,
      `| F1 | ${f1 === null ? '无分母' : f1.toFixed(3)} |`,
      `| 误报率 = FP / 健康案例 | ${pct(ratio(falsePositive, cleans.length))} |`,
      `| 单次页面运行耗时 P50 / P95（含缺陷、健康和交互页） | ${timing.p50 ?? '-'} ms / ${timing.p95 ?? '-'} ms |`, '',
      `缺陷页另有 ${unmatchedDefectFindings.length} 条未匹配固定真值的发现，需要单独复核；它们不计入此处的健康案例 FP，不能据此判断全部报警的准确率。交互页有 ${unmatchedInteractionFindings.length} 条未匹配缺陷真值的交互发现，详见 JSON。`, '',
      '## 案例', '',
      '| 案例 | 范围 | 类别 | 预期 | 检出 | 命中证据 | 问题 |', '| --- | --- | --- | --- | --- | --- | --- |',
      ...cases.filter(c => c.kind !== 'timing').map(c => `| ${cell(c.id)} | ${c.scope === 'interaction' ? '交互' : '静态'} | ${c.kind === 'defect' ? '缺陷' : '健康'} | ${cell(c.expectedDetector ?? '-')} | ${c.detected ? (c.kind === 'defect' ? '是' : '误报') : (c.kind === 'defect' ? '漏检' : '无')} | ${cell(c.matched ? `${c.matched.target ?? ''} · ${c.matched.observed ?? ''}`.slice(0, 120) : '-')} | ${cell(c.reasons.join('；'))} |`),
      '',
      '## 交互探索覆盖', '',
      interactionCoverage
        ? `交互段显式开启探索：` + (interactionCoverage.pages ?? []).map(p => `${p.path} 发现 ${p.controls} 个控件、实际点击 ${p.clicked} 个`).join('；') + `。夹具独立记录的点击：${interactionCoverage.fixtureClicks.join('、')}。`
        : '交互段未执行。',
      '',
      '探索会改变页面状态，生产站点默认关闭；`qa run --explore` 显式开启，写请求仍按站点的只读策略拦截。', '', '夹具、真值和检测器都在仓库内；样本没有代表性抽样，本页数字只适用于这组注入案例，不能描述为真实项目检出率。', '',
    ].join('\n');
    writeFileSync(join(runDir, 'benchmark.json'), JSON.stringify(result, null, 2));
    writeFileSync(join(runDir, 'benchmark.md'), md);
    writeFileSync(latestFile, JSON.stringify({ runDir, status: 'complete', passed: result.passed, metrics: result.metrics, startedAt, generatedAt: result.generatedAt }, null, 2));
    if (!keepRuns) { /* 运行目录保留：错误要能复查，清理由使用者显式做 */ }
    return result;
  } catch (error) {
    try { writeFileSync(latestFile, JSON.stringify({ runDir, status: 'incomplete', passed: null, startedAt, endedAt: new Date().toISOString() }, null, 2)); } catch { /* preserve the original failure */ }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: node core/scripts/benchmark-qa.mjs [outputDir]');
    process.exitCode = process.argv.length > 3 ? 2 : 0;
  } else {
    try {
      const result = await benchmarkQa({ outputDir: process.argv[2] });
      console.log(`[qa-benchmark] ${JSON.stringify({ ...result.metrics, passed: result.passed, outputDir: result.outputDir })}`);
      process.exitCode = result.passed ? 0 : 1;
    } catch (error) {
      console.error('[qa-benchmark]', error?.stack ?? error);
      process.exitCode = 1;
    }
  }
}
