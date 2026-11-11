/**
 * qa/metrics - aggregate QA evidence without rerunning a browser.
 *
 * The input may be a sanitized aggregate report or QA run summaries. Raw
 * findings are never returned; percentages are always recomputed here.
 */
import { quantile } from '../agent/bench/score.mjs';

const LABEL_KEYS = ['truePositive', 'falsePositive', 'unknown'];

const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const round = (value, digits = 2) => typeof value === 'number' && Number.isFinite(value)
  ? +value.toFixed(digits) : null;

function countOf(value, key) {
  return isCount(value?.[key]) ? value[key] : null;
}

function labelCounts(value) {
  if (!isRecord(value)) return null;
  const counts = Object.fromEntries(LABEL_KEYS.map(key => [key, countOf(value, key)]));
  return Object.values(counts).every(v => v !== null) ? counts : null;
}

function sumCounts(rows) {
  const valid = rows.map(labelCounts);
  if (!valid.length || valid.some(row => !row)) return null;
  return Object.fromEntries(LABEL_KEYS.map(key => [key, valid.reduce((sum, row) => sum + row[key], 0)]));
}

function labelsOf(input, runs) {
  if (input.labels !== undefined) return labelCounts(input.labels);
  return sumCounts(runs.map(run => run.labels));
}

function elapsedOf(run) {
  if (typeof run.elapsedMs === 'number' && Number.isFinite(run.elapsedMs) && run.elapsedMs >= 0) return run.elapsedMs;
  const start = Date.parse(String(run.startedAt ?? ''));
  const end = Date.parse(String(run.endedAt ?? ''));
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function runtimeOf(runs) {
  const values = runs.map(elapsedOf).filter(value => typeof value === 'number');
  if (!values.length) return { count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, totalMs: null };
  return {
    count: values.length,
    minMs: Math.min(...values),
    p50Ms: round(quantile(values, 0.5), 0),
    p95Ms: round(quantile(values, 0.95), 0),
    maxMs: Math.max(...values),
    totalMs: round(values.reduce((sum, value) => sum + value, 0), 0),
  };
}

function pageViewportChecksOf(run) {
  if (typeof run.pageViews === 'number' && Number.isFinite(run.pageViews) && run.pageViews >= 0) return run.pageViews;
  if (Array.isArray(run.coverage?.pages)) return run.coverage.pages.length;
  return 0;
}

function viewportsOf(input, runs) {
  const values = input.scope?.viewports ?? runs.flatMap(run => run.viewports ?? run.coverage?.viewports ?? []);
  const normalized = [...new Set(values.map(value => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const text = String(value);
    const width = text.match(/^([0-9]+)(?:x[0-9]+)?$/)?.[1];
    return width ? Number(width) : text;
  }))];
  return normalized.sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
}

function coverageOf(input, runs) {
  const sites = new Set(runs.map(run => typeof run.site === 'string' ? run.site : null).filter(Boolean));
  const cohorts = new Set(runs.map(run => typeof run.cohort === 'string' ? run.cohort : null).filter(Boolean));
  return {
    runs: runs.length,
    sites: input.scope?.sites ?? (sites.size || null),
    cohorts: cohorts.size || null,
    pageViewportChecks: runs.reduce((sum, run) => sum + pageViewportChecksOf(run), 0),
    viewports: viewportsOf(input, runs),
  };
}

function addFailure(map, kind, amount = 1) {
  if (typeof kind !== 'string' || !kind.trim() || !isCount(amount) || amount === 0) return;
  map[kind] = (map[kind] ?? 0) + amount;
}

function failureMapOf(value) {
  if (!isRecord(value)) return null;
  const result = {};
  let invalidEntries = 0;
  for (const [kind, count] of Object.entries(value)) {
    if (!isCount(count)) { invalidEntries++; continue; }
    if (count > 0) result[kind] = count;
  }
  return { result, invalidEntries };
}

function inferredFailureKinds(runs) {
  const result = {};
  for (const run of runs) {
    const summary = run.summary ?? {};
    const coverage = run.coverage ?? {};
    const navigationFailures = Number.isFinite(run.navigationFailures)
      ? run.navigationFailures
      : Array.isArray(coverage.pages) ? coverage.pages.filter(page => page?.navError).length : 0;
    const detectorFailures = Array.isArray(coverage.detection?.failedPages) ? coverage.detection.failedPages.length : 0;
    const checkFailures = Number.isFinite(summary.checkNeedsFix) ? summary.checkNeedsFix
      : Array.isArray(coverage.checks) ? coverage.checks.filter(check => check?.pass === false || check?.error).length : 0;
    const clientBlocked = Number.isFinite(run.clientBlocked)
      ? run.clientBlocked
      : Array.isArray(coverage.pages) ? coverage.pages.reduce((sum, page) => sum + Number(page?.counts?.clientBlocked ?? 0), 0) : 0;
    addFailure(result, 'navigation', navigationFailures);
    addFailure(result, 'detector', detectorFailures);
    addFailure(result, 'check', checkFailures);
    addFailure(result, 'client-blocked', clientBlocked);
    addFailure(result, 'login', Number(summary.environment ?? 0));
  }
  return result;
}

function failureKindCategory(kind) {
  return String(kind).split(':', 1)[0] || 'unknown';
}

function failuresOf(input, runs) {
  const supplied = input.supplementalEvidence?.failureKinds ?? input.failureKinds;
  const parsed = supplied === undefined ? null : failureMapOf(supplied);
  const byKind = parsed?.result ?? inferredFailureKinds(runs);
  const invalidEntries = supplied === undefined ? 0 : parsed?.invalidEntries ?? 1;
  const categories = {};
  for (const [kind, count] of Object.entries(byKind)) {
    const category = failureKindCategory(kind);
    categories[category] = (categories[category] ?? 0) + count;
  }
  const unclassified = Object.entries(byKind)
    .filter(([kind, count]) => count > 0 && (kind === 'network' || /(?:^|:)(?:unknown|unclassified)$/.test(kind)))
    .map(([kind]) => kind);
  const blockingKinds = Object.entries(byKind)
    .filter(([kind, count]) => count > 0 && (unclassified.includes(kind) || /^(?:login|detector|check|client-blocked|measurement-incomplete)$/.test(kind)))
    .map(([kind]) => kind);
  if (invalidEntries > 0) {
    unclassified.push('invalid-input');
    blockingKinds.push('invalid-input');
  }
  return {
    total: Object.values(byKind).reduce((sum, count) => sum + count, 0),
    byKind,
    categories,
    unclassified,
    blockingKinds,
    invalidEntries,
  };
}

function runIsComplete(run) {
  const summary = run.summary ?? {};
  const coverage = run.coverage ?? {};
  return run.verified !== false
    && run.measurementComplete !== false
    && !run.navigationFailures
    && !summary.environment
    && !summary.checkNeedsFix
    && !(coverage.detection?.failedPages?.length)
    && !(coverage.pages?.some(page => page?.navError || page?.detectorError));
}

function derivedEvidence(runs, failures) {
  const runCount = runs.length;
  const verified = runs.filter(run => runIsComplete(run)).length;
  return {
    complete: runCount > 0,
    runCount,
    verified: { true: verified, false: runCount - verified, unknown: 0 },
    measurementComplete: { true: verified, false: runCount - verified, unknown: 0 },
    failureKinds: { ...failures.byKind, ...(failures.invalidEntries ? { 'failure:unclassified': failures.invalidEntries } : {}) },
  };
}

function rate(numerator, denominator, reason = null) {
  return {
    numerator,
    denominator,
    percent: denominator > 0 ? round(numerator / denominator * 100, 2) : null,
    ...(reason ? { reason } : {}),
  };
}

function alarmMetrics(labels, input) {
  if (!labels) {
    return {
      available: false,
      truePositive: null,
      falsePositive: null,
      unknown: null,
      reviewed: null,
      falseDiscoveryRate: null,
      falsePositiveRate: rate(null, null, '没有提供完整的报警复核标签。'),
    };
  }
  const reviewed = labels.truePositive + labels.falsePositive;
  const trueNegative = countOf(input.labels, 'trueNegative');
  const exhaustive = input.labels?.normalExhaustive === true;
  const fpr = exhaustive && trueNegative !== null
    ? rate(labels.falsePositive, labels.falsePositive + trueNegative)
    : rate(labels.falsePositive, null, '没有穷举正常样本 TN，不能计算经典 FPR。');
  return {
    available: true,
    ...labels,
    reviewed,
    falseDiscoveryRate: rate(labels.falsePositive, reviewed),
    falsePositiveRate: fpr,
  };
}

function oracleMetrics(oracle) {
  if (oracle === undefined) return { status: 'not_provided', cases: 0, falseNegativeRate: null };
  const cases = Array.isArray(oracle?.cases) ? oracle.cases : [];
  const complete = cases.length > 0 && cases.every(item => isRecord(item)
    && typeof item.expected === 'boolean' && typeof item.detected === 'boolean');
  if (!complete) return { status: 'incomplete', cases: cases.length, falseNegativeRate: null };
  const counts = { truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0 };
  for (const item of cases) {
    if (item.expected && item.detected) counts.truePositive++;
    else if (!item.expected && item.detected) counts.falsePositive++;
    else if (item.expected && !item.detected) counts.falseNegative++;
    else counts.trueNegative++;
  }
  const positives = counts.truePositive + counts.falseNegative;
  const predictedPositive = counts.truePositive + counts.falsePositive;
  return {
    status: 'complete',
    cases: cases.length,
    ...counts,
    falseNegativeRate: rate(counts.falseNegative, positives),
    recall: rate(counts.truePositive, positives),
    precision: rate(counts.truePositive, predictedPositive),
    falsePositiveRate: rate(counts.falsePositive, counts.falsePositive + counts.trueNegative),
  };
}

/**
 * The decision rule is deliberately conservative and is shared by Xspark's
 * frozen-batch script and the generic QA metrics capability.
 */
export function decideDetectorExpansion({ labels, oracle, evidence } = {}) {
  const counts = [labels?.truePositive, labels?.falsePositive, labels?.unknown];
  const validCounts = counts.every(value => Number.isSafeInteger(value) && value >= 0)
    && Number.isSafeInteger(counts[0] + counts[1]);
  const reviewedAlarms = validCounts ? labels.truePositive + labels.falsePositive : 0;
  const falseDiscoveryRate = reviewedAlarms
    ? Math.round(labels.falsePositive / reviewedAlarms * 10000) / 100 : null;
  const labelsComplete = validCounts && labels.unknown === 0;
  const cases = Array.isArray(oracle?.cases) ? oracle.cases : [];
  const families = ['business-display-rule', 'generic-accessible-name'];
  const oracleComplete = cases.length > 0 && cases.every(item => item && families.includes(item.family)
    && typeof item.expected === 'boolean' && typeof item.detected === 'boolean');
  const allTrue = group => Number.isSafeInteger(evidence?.runCount) && evidence.runCount > 0
    && group?.true === evidence.runCount && group?.false === 0 && group?.unknown === 0;
  const failures = evidence?.failureKinds;
  const failuresClassified = failures && typeof failures === 'object' && !Array.isArray(failures)
    && Object.entries(failures).every(([kind, count]) => Number.isSafeInteger(count) && count >= 0
      && (count === 0 || (kind !== 'network' && !/(?:^|:)(?:unknown|unclassified)$/.test(kind))));
  const evidenceComplete = (evidence?.complete === undefined || evidence.complete === true)
    && allTrue(evidence?.verified) && allTrue(evidence?.measurementComplete) && failuresClassified;
  const business = cases.filter(item => item?.family === 'business-display-rule' && item.expected === true && typeof item.detected === 'boolean');
  const generic = cases.filter(item => item?.family === 'generic-accessible-name' && item.expected === true && typeof item.detected === 'boolean');
  const businessMisses = business.filter(item => item.detected === false).length;
  const genericMisses = generic.filter(item => item.detected === false);
  const missedProjects = new Set(genericMisses.filter(item => typeof item.projectId === 'string' && item.projectId.trim())
    .map(item => item.projectId.trim().toLowerCase()));
  const genericMissesAreRepeatable = missedProjects.size >= 3;
  const highFalseDiscovery = reviewedAlarms >= 10 && falseDiscoveryRate !== null && falseDiscoveryRate >= 25;
  const reasons = [];
  const secondaryActions = [];
  let primaryAction;
  let detectorExpansion;

  if (!evidenceComplete || !labelsComplete || !oracleComplete) {
    primaryAction = 'collect-more-evidence';
    detectorExpansion = 'blocked';
    if (!evidenceComplete) reasons.push('补充复测存在未完成、未验证或未知情况，不能据此决定扩展检测器。');
    if (!labelsComplete) reasons.push('报警复核计数缺失或存在未知标签。');
    if (!oracleComplete) reasons.push('定向样本缺失或未完成裁决。');
  } else if (businessMisses > 0) {
    primaryAction = 'add-business-check';
    detectorExpansion = 'do-not-add';
    reasons.push(`业务规则定向样本漏报 ${businessMisses} 项，适合用声明式业务检查点承接。`);
  } else if (highFalseDiscovery) {
    primaryAction = 'fix-existing-detectors';
    detectorExpansion = 'do-not-add';
    reasons.push(`已复核报警中的误报占比为 ${falseDiscoveryRate}%，先修正已有规则边界。`);
  } else if (genericMissesAreRepeatable && reviewedAlarms < 10) {
    primaryAction = 'collect-more-evidence';
    detectorExpansion = 'blocked';
    reasons.push('已复核报警不足 10 条，不能据此判断现有规则的误报情况。');
  } else if (genericMissesAreRepeatable) {
    primaryAction = 'consider-generic-detector';
    detectorExpansion = 'consider';
    reasons.push(`通用问题在 ${missedProjects.size} 个声明不同项目中漏报，仍需人工核对独立性和样本。`);
  } else {
    primaryAction = 'hold';
    detectorExpansion = 'do-not-add';
    reasons.push('现有样本没有同时满足新增通用检测器的证据门槛。');
  }

  if (oracleComplete && businessMisses > 0 && primaryAction !== 'add-business-check') secondaryActions.push('add-business-check');
  if (labelsComplete && highFalseDiscovery && primaryAction !== 'fix-existing-detectors') secondaryActions.push('fix-existing-detectors');
  if (oracleComplete && genericMisses.length > 0 && !genericMissesAreRepeatable) secondaryActions.push('collect-generic-samples');

  return { schema: 'xspark.detector-decision/2', primaryAction, detectorExpansion, confidence: 'low',
    secondaryActions, reasons, metrics: { reviewedAlarms, falseDiscoveryRate,
      business: { cases: business.length, falseNegative: businessMisses },
      generic: { cases: generic.length, falseNegative: genericMisses.length } } };
}

/** Analyze a sanitized aggregate or an array of QA run summaries. */
export function analyzeQaMetrics(input) {
  if (Array.isArray(input)) input = { runs: input };
  if (!isRecord(input)) throw new TypeError('指标输入必须是 JSON 对象或运行数组');
  const runs = Array.isArray(input.runs) ? input.runs.filter(isRecord)
    : input.runId ? [input] : [];
  const failures = failuresOf(input, runs);
  const labels = labelsOf(input, runs);
  const evidence = input.supplementalEvidence ?? derivedEvidence(runs, failures);
  const decision = decideDetectorExpansion({ labels, oracle: input.oracle, evidence });
  const oracle = oracleMetrics(input.oracle);
  return {
    schema: 'heimdall.qa-metrics/1',
    ...(typeof input.dataLevel === 'string' ? { dataLevel: input.dataLevel } : {}),
    coverage: coverageOf(input, runs),
    alarms: alarmMetrics(labels, input),
    oracle,
    runtime: runtimeOf(runs),
    failures,
    decision,
  };
}
