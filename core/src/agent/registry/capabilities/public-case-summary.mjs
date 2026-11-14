/**
 * capability: public_case_summary - summarize one checked-in public case.
 *
 * It reads only the manifest and the four small public summaries we know how to
 * interpret. Raw findings, screenshots, HAR files, sessions and credentials are
 * never opened or returned.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { REPO_ROOT } from '../../installation.mjs';
import { isInside } from '../../../paths.mjs';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { qaFindingDigest } from '../../qa-finding-summary.mjs';

const PUBLIC_CASES = join(REPO_ROOT, 'docs', 'cases');
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const KNOWN_EVIDENCE = ['evidence/run.json', 'evidence/qa-ci.json', 'evidence/seo.json'];

function readJson(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_JSON_BYTES) return { status: 'invalid', value: null };
    return { status: 'observed', value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { status: existsSync(file) ? 'invalid' : 'missing', value: null };
  }
}

function resolveCaseDir(value, ctx) {
  const raw = String(value ?? '').trim();
  const base = resolve(ctx.cwd ?? process.env.HEIMDALL_INVOKE_CWD ?? process.cwd());
  const candidates = isAbsolute(raw) ? [resolve(raw)] : [resolve(base, raw), resolve(REPO_ROOT, raw)];
  let publicRoot;
  try { publicRoot = realpathSync(PUBLIC_CASES); } catch { publicRoot = resolve(PUBLIC_CASES); }
  for (const candidate of [...new Set(candidates)]) {
    try {
      if (!statSync(candidate).isDirectory()) continue;
      const real = realpathSync(candidate);
      if (isInside(publicRoot, real)) return real;
    } catch {}
  }
  throw new CapabilityError('invalid_args', 'casePath 必须指向仓库 docs/cases 下的公开案例目录', {
    hint: '传入例如 docs/cases/xspark/2026-11-04，不要传原始工作区或任意文件路径',
  });
}

function numberOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function unique(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))].sort();
}

function safePage(value) {
  const page = String(value ?? '');
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]{0,240}$/.test(page) ? page : null;
}

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function safeText(value, max = 240) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : null;
}

function compareNumber(mismatches, label, left, right) {
  if (left !== null && left !== undefined && right !== null && right !== undefined && Number(left) !== Number(right)) {
    mismatches.push({ field: label, manifest: Number(left), evidence: Number(right) });
  }
}

function compareValue(mismatches, label, left, right) {
  if (left !== null && left !== undefined && right !== null && right !== undefined && String(left) !== String(right)) {
    mismatches.push({ field: label, manifest: String(left), evidence: String(right) });
  }
}

function qaSummary(manifest, run, ci, caseRel) {
  const manifestRun = manifest.run ?? {};
  const runCoverage = run?.coverage ?? {};
  const runPages = Array.isArray(runCoverage.pages) ? runCoverage.pages : [];
  const ciResult = ci?.result ?? {};
  const ciSummary = ciResult.summary ?? run?.summary ?? {};
  const detection = ciResult.detection ?? runCoverage.detection ?? {};
  const baseline = ciResult.baseline ?? runCoverage.baseline ?? {};
  const pageNames = unique(runPages.map(page => safePage(page.path)).filter(Boolean));
  const viewports = unique((runCoverage.viewports ?? runPages.map(page => page.viewport)).map(value => safeText(value, 32)).filter(Boolean));
  const started = Date.parse(run?.startedAt ?? '');
  const ended = Date.parse(run?.endedAt ?? '');
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? ended - started : null;
  const byKind = detection.byKind && typeof detection.byKind === 'object'
    ? Object.fromEntries(Object.entries(detection.byKind).slice(0, 20).map(([key, value]) => [safeText(key, 80), numberOrNull(value)]))
    : {};
  return {
    status: run && ci ? 'observed' : 'partial',
    runId: safeText(run?.runId ?? manifestRun.id, 80),
    environment: safeText(run?.environment, 80),
    pages: pageNames.length || numberOrNull(manifest.target?.pages?.length) || 0,
    pageViewportChecks: runPages.length || numberOrNull(manifestRun.renders) || 0,
    viewports,
    durationMs,
    findings: numberOrNull(ciSummary.total ?? manifestRun.findings),
    fileable: numberOrNull(ciSummary.fileable ?? manifestRun.fileable),
    suppressed: numberOrNull(ciSummary.suppressed ?? manifestRun.suppressed),
    tolerable: numberOrNull(ciSummary.tolerable ?? manifestRun.tolerable),
    environmentFailures: numberOrNull(ciSummary.environment),
    detectorHits: numberOrNull(detection.findings ?? manifestRun.detectorHits),
    detectors: unique((detection.detectors ?? []).map(value => safeText(value, 80)).filter(Boolean)),
    failureCategories: byKind,
    findingDigest: qaFindingDigest(ciResult.fileable, run?.runId ?? manifestRun.id, { reportedTotal: ciSummary.fileable }),
    baseline: {
      compared: numberOrNull(baseline.compared ?? manifestRun.baselinePairs),
      regressions: numberOrNull(manifestRun.regressions),
      gate: safeText(ci?.gate?.status ?? manifestRun.ciGate, 40),
    },
    pagesObserved: pageNames,
    evidence: KNOWN_EVIDENCE.slice(0, 2).map(path => `${caseRel}/${path}`),
  };
}

function seoSummary(manifest, seo, caseRel) {
  const summary = seo?.summary ?? {};
  const bySeverity = summary.bySeverity && typeof summary.bySeverity === 'object'
    ? Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map(key => [key, numberOrNull(summary.bySeverity[key]) ?? 0]))
    : {};
  const fieldData = seo?.field && typeof seo.field === 'object' ? seo.field : {};
  return {
    status: seo ? 'observed' : 'missing',
    origin: safeUrl(seo?.origin ?? manifest.target?.origin),
    score: numberOrNull(seo?.score ?? manifest.seo?.score),
    grade: safeText(manifest.seo?.grade, 10),
    pages: numberOrNull(summary.pages ?? manifest.seo?.pages),
    issues: numberOrNull(summary.issues ?? manifest.seo?.issues),
    bySeverity,
    fieldData: { available: fieldData.available === true, reason: safeText(fieldData.reason, 160) },
    reports: seo ? [`${caseRel}/evidence/seo.json`] : [],
  };
}

export default {
  id: 'public_case_summary',
  title: '公开案例：读取脱敏验收摘要',
  description: 'Read one checked-in public case and return a compact, evidence-bounded summary of page and viewport coverage, QA findings and gate status, baseline regressions, SEO results, proven capabilities, limits and evidence paths. It reads only docs/cases/<case>/manifest.json plus evidence/run.json, evidence/qa-ci.json and evidence/seo.json; it never opens raw findings, screenshots, HAR files, sessions, tokens or login state. This is a public-case summary, not a claim about generic accuracy or a fresh website run.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false, required: ['casePath'],
    properties: {
      casePath: { type: 'string', minLength: 1, maxLength: 1000, description: '公开案例目录，例如 docs/cases/xspark/2026-11-04' },
    },
  },
  cli: { usage: 'public-case-summary --case-path DIR', positional: [] },
  async handler(args, ctx) {
    const caseDir = resolveCaseDir(args.casePath, ctx);
    const caseRel = relative(REPO_ROOT, caseDir).replaceAll('\\', '/');
    const manifestFile = join(caseDir, 'manifest.json');
    const manifestRead = readJson(manifestFile);
    if (manifestRead.status === 'missing') throw new CapabilityError('not_found', `公开案例缺少 manifest.json：${caseRel}`);
    if (manifestRead.status !== 'observed' || manifestRead.value?.schema !== 'heimdall.public-case/1') {
      throw new CapabilityError('invalid_args', `不是有效的 Heimdall 公开案例：${caseRel}`);
    }
    const manifest = manifestRead.value;
    const runRead = readJson(join(caseDir, 'evidence', 'run.json'));
    const ciRead = readJson(join(caseDir, 'evidence', 'qa-ci.json'));
    const seoRead = readJson(join(caseDir, 'evidence', 'seo.json'));
    const run = runRead.status === 'observed' ? runRead.value : null;
    const ci = ciRead.status === 'observed' ? ciRead.value : null;
    const seo = seoRead.status === 'observed' ? seoRead.value : null;
    const mismatches = [];
    compareValue(mismatches, 'run.id', manifest.run?.id, run?.runId);
    compareNumber(mismatches, 'run.findings', manifest.run?.findings, ci?.result?.summary?.total ?? run?.summary?.total);
    compareNumber(mismatches, 'run.fileable', manifest.run?.fileable, ci?.result?.summary?.fileable);
    compareNumber(mismatches, 'run.detectorHits', manifest.run?.detectorHits, ci?.result?.detection?.findings);
    compareNumber(mismatches, 'run.baselinePairs', manifest.run?.baselinePairs, ci?.result?.baseline?.compared);
    compareValue(mismatches, 'run.ciGate', manifest.run?.ciGate, ci?.gate?.status);
    compareNumber(mismatches, 'seo.score', manifest.seo?.score, seo?.score);
    compareNumber(mismatches, 'seo.issues', manifest.seo?.issues, seo?.summary?.issues);

    const targetPages = unique((manifest.target?.pages ?? []).map(safePage).filter(Boolean));
    const qa = qaSummary(manifest, run, ci, caseRel);
    const seoResult = seoSummary(manifest, seo, caseRel);
    const limitations = Array.isArray(manifest.limitations)
      ? manifest.limitations.map(value => safeText(value)).filter(Boolean).slice(0, 20)
      : [];
    const proven = [
      `${targetPages.length || qa.pages} 个公开页面，${qa.pageViewportChecks} 次页面/视口检查`,
      `QA 门禁 ${qa.baseline.gate ?? '未知'}，可提单 ${qa.fileable ?? '未知'} 条`,
      `视觉基线比较 ${qa.baseline.compared ?? '未知'} 对，回归 ${qa.baseline.regressions ?? '未知'} 条`,
      `SEO ${seoResult.score ?? '未知'}${seoResult.grade ? ` / ${seoResult.grade}` : ''}，critical/high ${seoResult.bySeverity.critical ?? 0}/${seoResult.bySeverity.high ?? 0}`,
    ];
    const unknowns = [
      ...(limitations.length ? limitations : ['案例限制信息缺失']),
      ...(seoResult.fieldData.available ? [] : ['真实用户 PageSpeed 数据不可用']),
    ];
    const evidence = [
      { kind: 'file', path: `${caseRel}/manifest.json` },
      ...(runRead.status === 'observed' ? [{ kind: 'file', path: `${caseRel}/evidence/run.json` }] : []),
      ...(ciRead.status === 'observed' ? [{ kind: 'file', path: `${caseRel}/evidence/qa-ci.json` }] : []),
      ...(seoRead.status === 'observed' ? [{ kind: 'file', path: `${caseRel}/evidence/seo.json` }] : []),
    ];
    const nextActions = [];
    if (mismatches.length) nextActions.push(nextAction('heimdall_public_case_summary', { casePath: caseRel }, '先修正案例摘要与证据文件不一致，再引用数字'));
    if (!run || !ci) nextActions.push(nextAction('heimdall_public_case_summary', { casePath: caseRel }, '补齐公开案例的 QA 运行与 CI 摘要'));
    if (!seo) nextActions.push(nextAction('heimdall_public_case_summary', { casePath: caseRel }, '补齐公开案例的 SEO 摘要'));
    return ok({
      schema: 'heimdall.public-case-summary/1',
      case: { id: safeText(manifest.case, 120), project: safeText(manifest.project, 120), capturedAt: safeText(manifest.capturedAt, 80),
        target: { site: safeText(manifest.target?.site, 80), origin: safeUrl(manifest.target?.origin), pages: targetPages,
          viewports: unique((manifest.target?.viewports ?? []).map(value => safeText(value, 32)).filter(Boolean)),
          login: manifest.target?.login ? 'present' : 'none', writes: manifest.target?.writes === 'block' ? 'block' : 'unknown' } },
      integrity: { status: mismatches.length ? 'needs_review' : 'consistent', mismatches, evidence: {
        manifest: manifestRead.status, run: runRead.status, qaCi: ciRead.status, seo: seoRead.status,
      } },
      coverage: { pages: targetPages.length || qa.pages, pageViewportChecks: qa.pageViewportChecks, viewports: qa.viewports, baselinePairs: qa.baseline.compared, regressions: qa.baseline.regressions },
      qa, seo: seoResult, proven, unknowns,
    }, {
      summary: `${safeText(manifest.project, 80) ?? '公开案例'}：${targetPages.length || qa.pages} 页、${qa.pageViewportChecks} 次检查；QA ${qa.baseline.gate ?? '未知'}，SEO ${seoResult.score ?? '未知'}。`,
      nextActions: nextActions.slice(0, 3), evidence,
    });
  },
};
