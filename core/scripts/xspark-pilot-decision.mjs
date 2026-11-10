export function matchesFrozenBatch(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== 20 || expected.length !== 20) return false;
  const keys = rows => rows.map(row => {
    const parts = [row?.cohort, row?.site, row?.runId];
    return parts.every(part => typeof part === 'string' && part.length > 0) ? JSON.stringify(parts) : null;
  });
  const expectedKeys = keys(expected);
  const actualKeys = keys(actual);
  const frozen = new Set(expectedKeys);
  return !frozen.has(null) && frozen.size === 20 && new Set(actualKeys).size === 20
    && actualKeys.every(key => frozen.has(key));
}

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
  const evidenceComplete = (evidence?.complete === undefined || evidence?.complete === true)
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
