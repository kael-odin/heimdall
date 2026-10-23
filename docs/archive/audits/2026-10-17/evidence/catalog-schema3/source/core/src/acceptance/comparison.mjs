/** Conservative, read-only comparison of two explicitly selected acceptance runs. */
const STATES = new Set(['passed', 'failed', 'blocked', 'needs_review']);
const VERDICTS = new Set(['match', 'bug', 'baseline_failed', 'environment', 'needs_review']);
const HASH_FIELDS = ['caseKey', 'contextKey', 'ruleKey', 'oracleKey', 'environmentKey'];
const COUNTERS = {
  still_failed: 'stillFailed', verified_passed: 'verifiedPassed', new_failure: 'newFailure',
  observed_failure: 'observedFailure', unchanged_passed: 'unchangedPassed',
  observed_passed: 'observedPassed', unverified: 'unverified', incomparable: 'incomparable',
};
const LABELS = {
  still_failed: '仍失败', verified_passed: '可靠复验通过', new_failure: '新增失败',
  observed_failure: '本次观测失败', unchanged_passed: '持续通过',
  observed_passed: '本次观测通过', unverified: '未复验', incomparable: '不可比',
};
const INTEGRITY_MESSAGES = {
  FILE_UNAVAILABLE: '运行文件缺失或超出本次目录。', FILE_UNREADABLE: '运行文件不可读取。',
  INTEGRITY_BUDGET: '文件数量或字节超过完整性验证预算。', INVALID_JSON: '运行记录不是有效 JSON 对象。',
  RUN_IDENTITY_MISMATCH: '运行身份与报告不一致。', RUN_NOT_COMPLETE: '运行未完整结束。',
  REPORT_DIGEST_UNAVAILABLE: '旧运行没有报告字节指纹，请重新运行。', REPORT_DIGEST_MISMATCH: '报告字节已变化。',
  PLAN_DIGEST_MISMATCH: '报告与保存的验收计划不一致。', RUN_TARGET_MISMATCH: '运行入口与报告不一致。',
  INVALID_CHECKS: '检查清单无效或超过验证预算。', SUMMARY_MISMATCH: '保存的门禁或统计与检查不一致。',
  INVALID_EVIDENCE_MANIFEST: '证据索引无效、重复或超过验证预算。',
  INVALID_EVIDENCE_REFERENCE: '检查包含无效证据引用。', EVIDENCE_NOT_INDEXED: '检查引用的证据未登记。',
  EVIDENCE_DIGEST_MISMATCH: '证据字节与完成时的索引不一致。',
};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (value, max = 240) => typeof value === 'string' ? value.slice(0, max) : '';
const reason = (code, message) => ({ code, message });
const validState = check => record(check) && !!short(check.id) && STATES.has(check.status) && VERDICTS.has(check.verdict)
  && !(check.status === 'passed' && check.verdict !== 'match')
  && !(check.verdict === 'bug' && check.status !== 'failed');
const isBug = check => check?.status === 'failed' && check.verdict === 'bug';

function integritySummary(snapshot) {
  const integrity = snapshot?.integrity;
  return {
    valid: integrity?.valid === true, evidenceVerified: integrity?.evidenceVerified === true,
    verifiedFiles: Number.isSafeInteger(integrity?.verifiedFiles) && integrity.verifiedFiles >= 0 ? integrity.verifiedFiles : 0,
    verifiedBytes: Number.isSafeInteger(integrity?.verifiedBytes) && integrity.verifiedBytes >= 0 ? integrity.verifiedBytes : 0,
    errors: (Array.isArray(integrity?.errors) ? integrity.errors : []).slice(0, 40).map(item => {
      const code = typeof item?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(item.code) ? item.code : 'INTEGRITY_ERROR';
      const file = typeof item?.file === 'string' && /^[a-z0-9][a-z0-9_.-]{0,234}\.(?:png|json)$/i.test(item.file) ? item.file : null;
      return { code, message: INTEGRITY_MESSAGES[code] ?? '完整性验证未通过，请检查原运行并重新执行。', ...(file ? { file } : {}) };
    }),
  };
}

function snapshotProblems(snapshot, side) {
  const problems = [];
  const report = snapshot?.report, manifest = snapshot?.manifest;
  if (!record(report) || !Array.isArray(report.checks) || !record(manifest)) {
    return [reason(`${side}-snapshot-invalid`, `${side} 运行快照或检查清单不可用。`)];
  }
  if (manifest.status !== 'completed' || report.status !== 'completed') {
    problems.push(reason(`${side}-run-incomplete`, `${side} 运行尚未可靠完成。`));
  }
  if (!short(manifest.runId) || report.runId !== manifest.runId) {
    problems.push(reason(`${side}-run-id-mismatch`, `${side} 运行与报告身份不一致。`));
  }
  if (!['mirror', 'regression', 'spec'].includes(report.mode) || report.mode !== manifest.mode) {
    problems.push(reason(`${side}-mode-invalid`, `${side} 模式缺失或与运行声明不一致。`));
  }
  const integrity = snapshot?.integrity;
  if (integrity?.valid !== true || integrity.evidenceVerified !== true || !Array.isArray(integrity.errors) || integrity.errors.length) {
    const codes = Array.isArray(integrity?.errors) ? [...new Set(integrity.errors.map(item => item?.code)
      .filter(code => typeof code === 'string' && /^[A-Z0-9_]{1,80}$/.test(code)))].slice(0, 5) : [];
    problems.push(reason(`${side}-evidence-integrity`, `${side} 当前报告及引用证据未通过完整性验证${codes.length ? `（${codes.join('、')}）` : ''}。`));
  }
  const coverage = report.coverage;
  if (!record(coverage) || !Number.isSafeInteger(coverage.planned) || !Number.isSafeInteger(coverage.completed)
    || coverage.planned < 1 || coverage.planned !== report.checks.length || coverage.completed !== report.checks.length
    || coverage.capped !== false || (report.summary?.missing ?? 0) !== 0) {
    problems.push(reason(`${side}-coverage-incomplete`, `${side} 声明覆盖缺失、未完成或达到执行上限。`));
  }
  if (report.checks.some(check => !validState(check))
    || new Set(report.checks.map(check => check?.id)).size !== report.checks.length || (report.summary?.invalid ?? 0) !== 0) {
    problems.push(reason(`${side}-invalid-check-state`, `${side} 报告存在不一致的检查状态。`));
  }
  if (report.mode === 'spec' && report.specApproval?.approved !== true) {
    problems.push(reason(`${side}-spec-unapproved`, `${side} 契约清单未获批准。`));
  }
  return problems;
}

function usableIdentity(check) {
  const identity = check?.identity;
  if (!record(identity) || identity.version !== 1 || !['browser', 'spec'].includes(identity.kind) || !short(identity.facet)
    || HASH_FIELDS.some(key => !/^[a-f0-9]{64}$/.test(identity[key] ?? ''))) return null;
  const viewport = identity.viewport;
  if (viewport !== 'api' && (!record(viewport) || !Number.isSafeInteger(viewport.width)
    || !Number.isSafeInteger(viewport.height) || viewport.width <= 0 || viewport.height <= 0)) return null;
  if ((identity.kind === 'spec') !== (viewport === 'api')) return null;
  return identity;
}

function passProblems(check) {
  const actual = record(check?.actual) ? check.actual : {};
  const expected = record(check?.expected) ? check.expected : {};
  const sides = ['baseline', 'target'].map(side => actual.capture?.[side]);
  const masks = ['baseline', 'target'].map(side => actual.maskCoverage?.[side]);
  const limited = check?.evaluationLimited === true || actual.evaluationLimited === true
    || actual.requested === false || actual.eligible === false || actual.captureLimited === true
    || check?.coverage?.capped === true || check?.reliability?.eligible === false
    || sides.some(side => side?.captureLimited === true)
    || masks.some(mask => mask?.samplingCapped === true || mask?.maskedRatio > 0.8)
    || ['baselineStability', 'targetStability'].some(key => typeof actual[key] === 'number' && actual[key] < 0.9995)
    || actual.policyAffected === true || actual.stepsComplete === false || expected.stepsComplete === false
    || (Array.isArray(actual.blockedRequests) && actual.blockedRequests.length > 0)
    || ['error', 'errorCode', 'navigationError', 'stepError', 'parseError'].some(key => !!actual[key])
    || ['assertions', 'mismatches', 'schemaFailures'].some(key => Array.isArray(actual[key])
      && (key === 'assertions' ? actual[key].some(item => item?.passed !== true) : actual[key].length > 0))
    || (Array.isArray(expected.assertions) && expected.assertions.some(item => item?.passed !== true));
  const problems = [];
  const identity = usableIdentity(check);
  const requiredEvidence = identity?.kind === 'spec' ? ['contract', 'request', 'response']
    : ['baselineScreenshot', 'targetScreenshot', 'baselineDetails', 'targetDetails', 'baselineRepeat', 'targetRepeat',
      ...(identity?.facet === 'visual' ? ['diff'] : [])];
  if (requiredEvidence.some(key => typeof check?.evidence?.[key] !== 'string' || !check.evidence[key])) {
    problems.push(reason('evidence-reference-missing', '此检查缺少对应模式的必要证据引用，不能证明可靠通过。'));
  }
  if (limited) problems.push(reason('evaluation-limited', '此检查存在未执行、受限或不可靠观测，不能证明可靠通过。'));
  return problems;
}

function metadata(snapshot) {
  const report = snapshot?.report ?? {}, manifest = snapshot?.manifest ?? {};
  return {
    runId: short(manifest.runId || report.runId, 100), name: short(manifest.name || report.name, 160),
    mode: short(manifest.mode || report.mode, 30), gate: short(manifest.gate, 30),
    targetUrl: short(manifest.targetUrl || report.targetUrl, 4096),
    createdAt: short(manifest.createdAt, 50), endedAt: short(report.endedAt || manifest.endedAt, 50),
    verifierFingerprint: short(report.verifierFingerprint, 128),
    reportSha256: short(snapshot?.integrity?.reportSha256, 128),
  };
}

function reference(check) {
  return check ? { checkId: short(check.id, 240), status: short(check.status, 30), verdict: short(check.verdict, 30) } : null;
}

function comparisonProblems(before, after, beforeReport, afterReport) {
  const a = usableIdentity(before), b = usableIdentity(after);
  if (!a || !b) return [reason('identity-unavailable', '缺少完整的稳定检查身份；不解析旧展示 ID 推断同一检查。')];
  const problems = [];
  if (beforeReport.mode !== afterReport.mode || a.kind !== b.kind) problems.push(reason('mode-changed', '两次验收模式或检查种类不同。'));
  if (a.facet !== b.facet || a.caseKey !== b.caseKey) problems.push(reason('case-changed', '检查语义身份不兼容。'));
  const sameViewport = a.viewport === 'api' && b.viewport === 'api'
    || record(a.viewport) && record(b.viewport) && a.viewport.width === b.viewport.width && a.viewport.height === b.viewport.height;
  if (a.contextKey !== b.contextKey || !sameViewport) problems.push(reason('context-changed', '实际视口或检查上下文变化。'));
  if (before.route !== after.route || ['method', 'pointId', 'contractId'].some(key => a[key] !== b[key])) {
    problems.push(reason('case-metadata-changed', '路由、方法或显式检查标识变化，不能由相同摘要绕过。'));
  }
  if (a.ruleKey !== b.ruleKey) problems.push(reason('definition-changed', '检查定义、阈值、操作、断言或执行策略变化。'));
  if (a.oracleKey !== b.oracleKey) problems.push(reason('oracle-changed', '参考内容或批准规格发生变化，不能计为修复。'));
  if (a.environmentKey !== b.environmentKey) problems.push(reason('environment-changed', '实际执行环境不同。'));
  if (!short(beforeReport.verifierFingerprint) || !short(afterReport.verifierFingerprint)) {
    problems.push(reason('verifier-unknown', '缺少验证器指纹，不能证明执行规则相同。'));
  } else if (beforeReport.verifierFingerprint !== afterReport.verifierFingerprint) {
    problems.push(reason('verifier-changed', '验证器版本变化。'));
  }
  return problems;
}

function row(before, after, key, relation, reasons) {
  const check = after ?? before ?? {}, identity = usableIdentity(check);
  const viewport = identity?.viewport ?? check.viewport;
  return {
    key, title: short(check.title || check.id, 240), route: short(check.route, 2048),
    viewport: record(viewport) ? { width: viewport.width, height: viewport.height } : short(viewport, 80),
    facet: short(identity?.facet || check.dimension, 80),
    before: reference(before), after: reference(after), relation, reasons,
  };
}

/** No source/body/actual payload is copied; callers keep the original runs authoritative. */
export function compareAcceptanceSnapshots(before, after) {
  const beforeMeta = metadata(before), afterMeta = metadata(after);
  if (beforeMeta.runId && beforeMeta.runId === afterMeta.runId) {
    const error = new Error('请选择两次不同的验收运行。');
    error.code = 'SAME_RUN';
    throw error;
  }
  const beforeReport = before?.report ?? {}, afterReport = after?.report ?? {};
  const globalProblems = [...snapshotProblems(before, 'before'), ...snapshotProblems(after, 'after')];
  const beforeChecks = Array.isArray(beforeReport.checks) ? beforeReport.checks : [];
  const afterChecks = Array.isArray(afterReport.checks) ? afterReport.checks : [];
  const groups = new Map(), legacy = [];
  for (const [side, checks] of [['before', beforeChecks], ['after', afterChecks]]) {
    checks.forEach((check, index) => {
      const identity = usableIdentity(check);
      if (!identity) { legacy.push({ side, check, index }); return; }
      if (!groups.has(identity.contextKey)) groups.set(identity.contextKey, { before: [], after: [] });
      groups.get(identity.contextKey)[side].push(check);
    });
  }
  const checks = [];
  for (const [key, group] of groups) {
    if (group.before.length > 1 || group.after.length > 1) {
      for (const side of ['before', 'after']) group[side].forEach((check, index) => {
        checks.push(row(side === 'before' ? check : null, side === 'after' ? check : null,
          `${key}:conflict:${side}:${index}`, 'incomparable', [reason('identity-conflict', '同一运行存在重复上下文身份，不能唯一配对。'), ...globalProblems]));
      });
      continue;
    }
    const a = group.before[0], b = group.after[0];
    if (!a || !b) {
      const check = b ?? a, identity = usableIdentity(check);
      const other = b ? beforeChecks : afterChecks;
      const changedViewport = other.some(item => {
        const otherIdentity = usableIdentity(item);
        if (!otherIdentity || otherIdentity.caseKey !== identity.caseKey) return false;
        const otherGroup = groups.get(otherIdentity.contextKey);
        return !otherGroup.before.length || !otherGroup.after.length;
      });
      if (beforeReport.mode !== afterReport.mode) {
        checks.push(row(a, b, key, 'incomparable', [reason('mode-changed', '验收模式不同，不能据此推断新增或修复。'), ...globalProblems]));
      } else if (changedViewport) {
        checks.push(row(a, b, key, 'incomparable', [reason('viewport-changed', '同一检查存在不同实际视口，不能替代旧尺寸的复验。'), ...globalProblems]));
      } else if (globalProblems.length) {
        checks.push(row(a, b, key, 'unverified', globalProblems));
      } else if (!b) {
        checks.push(row(a, null, key, 'unverified', [reason('check-not-rerun', '本次没有同一上下文的检查；删除或缺测不能算修复。')]));
      } else if (isBug(b)) {
        checks.push(row(null, b, key, 'observed_failure', [reason('no-previous-pass', '此前没有同一检查的可靠通过事实，不能声称新增回归。')]));
      } else if (b.status === 'passed' && b.verdict === 'match' && !passProblems(b).length) {
        checks.push(row(null, b, key, 'observed_passed', [reason('no-previous-check', '仅有本次可靠通过观测，没有对应的此前检查。')]));
      } else {
        checks.push(row(null, b, key, 'unverified', [...passProblems(b), reason('check-not-reliably-passed', '本次检查未形成可靠通过事实。')]));
      }
      continue;
    }
    const incompatible = comparisonProblems(a, b, beforeReport, afterReport);
    if (incompatible.length) { checks.push(row(a, b, key, 'incomparable', [...incompatible, ...globalProblems])); continue; }
    if (globalProblems.length) { checks.push(row(a, b, key, 'unverified', globalProblems)); continue; }
    const priorPass = a.status === 'passed' && a.verdict === 'match' && !passProblems(a).length;
    const currentPassProblems = passProblems(b);
    let relation, reasons = [];
    if (isBug(b)) {
      relation = isBug(a) ? 'still_failed' : priorPass ? 'new_failure' : 'observed_failure';
      if (relation === 'observed_failure') reasons.push(reason('no-previous-pass', '此前检查没有可靠通过，不能声称新增回归。'));
    } else if (b.status === 'passed' && b.verdict === 'match' && !currentPassProblems.length) {
      relation = isBug(a) ? 'verified_passed' : priorPass ? 'unchanged_passed' : 'observed_passed';
      if (relation === 'observed_passed') reasons.push(reason('previous-not-reliable', '此前检查未形成可靠的通过或目标失败事实。'));
    } else {
      relation = 'unverified';
      reasons = [...currentPassProblems, reason('check-not-reliably-passed', '本次受阻、待复核或受限，不能证明此前失败已经修复。')];
    }
    checks.push(row(a, b, key, relation, reasons));
  }
  for (const { side, check, index } of legacy) {
    checks.push(row(side === 'before' ? check : null, side === 'after' ? check : null,
      `legacy:${side}:${index}`, 'incomparable', [reason('identity-unavailable', '缺少完整的稳定检查身份；原证据可查看，不根据旧 ID 推断。'), ...globalProblems]));
  }
  const summary = Object.fromEntries(['total', ...Object.values(COUNTERS)].map(key => [key, 0]));
  summary.total = checks.length;
  for (const check of checks) summary[COUNTERS[check.relation]]++;
  return {
    schemaVersion: 1, kind: 'acceptance-comparison', scope: 'explicit-pair',
    before: beforeMeta, after: afterMeta,
    integrity: { before: integritySummary(before), after: integritySummary(after) },
    status: globalProblems.length ? 'blocked' : 'completed', summary, checks,
    limitations: [
      '仅对比用户明确选择的两次运行；此前/本次是选择标签，不自动批准项目基线，也不改写原门禁。',
      '可靠复验通过针对整个相同合同、操作点或检查，不推断子失败根因相同，不自动关闭持久问题。',
      '未测、删除、受阻、待复核及不可比均不算修复；精确参考截图哈希变化会保守停止视觉趋势比较。',
      ...globalProblems.map(item => `${item.code}：${item.message}`),
    ],
  };
}

const cell = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const viewportLabel = value => value === 'api' ? 'API' : record(value) ? `${value.width} × ${value.height}` : value;

export function comparisonMarkdown(result) {
  const r = result ?? {}, summary = r.summary ?? {};
  const integrityLines = ['## 证据完整性', '', '| 运行 | 完整性 | 证据验证 | 通过文件数 | 已读字节数 |', '| --- | --- | --- | ---: | ---: |'];
  for (const side of ['before', 'after']) {
    const integrity = r.integrity?.[side];
    const label = side === 'before' ? '此前' : '本次';
    integrityLines.push(`| ${label} | ${integrity?.valid === true ? '通过' : '未通过'} | ${integrity?.evidenceVerified === true ? '通过' : '未通过'} | ${integrity?.verifiedFiles ?? 0} | ${integrity?.verifiedBytes ?? 0} |`);
  }
  const integrityErrors = ['before', 'after'].flatMap(side => (r.integrity?.[side]?.errors ?? [])
    .map(item => `- ${side === 'before' ? '此前' : '本次'} ${cell(item.code)}${item.file ? `（${cell(item.file)}）` : ''}：${cell(item.message)}`));
  return [
    '# 验收运行对比', '',
    `此前：${cell(r.before?.runId)} · ${cell(r.before?.name)} · 原门禁 ${cell(r.before?.gate)}`,
    `本次：${cell(r.after?.runId)} · ${cell(r.after?.name)} · 原门禁 ${cell(r.after?.gate)}`,
    `对比状态：${r.status === 'completed' ? '完成' : '受阻'}`, '',
    `检查 ${summary.total ?? 0}；仍失败 ${summary.stillFailed ?? 0}；可靠复验通过 ${summary.verifiedPassed ?? 0}；新增失败 ${summary.newFailure ?? 0}；本次观测失败 ${summary.observedFailure ?? 0}；持续通过 ${summary.unchangedPassed ?? 0}；本次观测通过 ${summary.observedPassed ?? 0}；未复验 ${summary.unverified ?? 0}；不可比 ${summary.incomparable ?? 0}。`, '',
    ...integrityLines, '', ...integrityErrors, '', '## 检查对比', '',
    '| 检查 | 路由 | 视口 | 维度 | 此前检查 | 本次检查 | 对比结果 | 原因 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...(r.checks ?? []).map(check => `| ${cell(check.title)} | ${cell(check.route)} | ${cell(viewportLabel(check.viewport))} | ${cell(check.facet)} | ${cell(check.before?.checkId || '—')} | ${cell(check.after?.checkId || '—')} | ${cell(LABELS[check.relation] || check.relation)} | ${cell(check.reasons?.map(item => `${item.code}: ${item.message}`).join('；'))} |`),
    '', '## 边界', '', ...(r.limitations ?? []).map(item => `- ${cell(item)}`), '',
  ].join('\n');
}
