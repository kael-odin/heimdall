/**
 * capability: site_assessment -- one conservative status package for a site.
 *
 * It reads only public summaries already written by Heimdall. Raw HAR files,
 * sessions, operation plans and adapter modules are never opened here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { measurementCoverage, scanMeasurementsAsync } from '../../../verify/measurement-status.mjs';
import { summarizeObservedApiContract } from '../../../live/contract.mjs';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { listPages, pageDir, siteDir } from '../../workspace.mjs';
import { listRuns, openWorkspace, relPath } from '../../../qa/run.mjs';

const MAX_PUBLIC_REPORT_BYTES = 4 * 1024 * 1024;
const SEO_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

function readJson(file) {
  try {
    if (statSync(file).size > MAX_PUBLIC_REPORT_BYTES) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

function reportPath(siteId, suffix) {
  return `workspace/${siteId}/${suffix}`;
}

function originOf(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function gradeOf(score) {
  return typeof score === 'number' ? (score >= 90 ? 'A' : score >= 75 ? 'B' : 'C') : null;
}

function scoreRows(siteId, pages) {
  return pages.map(page => readJson(join(pageDir(siteId, page), 'score.json')))
    .filter(score => typeof score?.total === 'number' && Number.isFinite(score.total));
}

function cloneSummary(siteId, pages, scan) {
  const mirrors = pages.filter(page => existsSync(join(pageDir(siteId, page), 'clone', 'index.html')));
  const coverage = measurementCoverage(scan, pages.length);
  const scores = scoreRows(siteId, mirrors);
  const measured = scan.pages.filter(row => row.status === 'verified' && row.result);
  const worst = measured.reduce((current, row) => {
    const candidate = row.result.minViewport;
    if (!candidate || typeof candidate.score !== 'number') return current;
    return !current || candidate.score < current.score ? { name: candidate.name, score: candidate.score } : current;
  }, null);
  return {
    status: pages.length ? 'captured' : 'not_captured',
    pages: pages.length,
    mirrors: mirrors.length,
    verified: coverage.verified,
    unmeasured: coverage.unmeasured,
    verificationStatus: coverage.status,
    averageScore: scores.length ? +(scores.reduce((sum, score) => sum + score.total, 0) / scores.length).toFixed(2) : null,
    averageOverall: coverage.average,
    worstViewport: worst,
    samplePages: mirrors.slice(0, 10),
  };
}

function seoSummary(siteId, root) {
  const file = join(root, 'seo', 'seo.json');
  if (!existsSync(file)) return { status: 'missing', report: null };
  const report = readJson(file);
  if (!report || typeof report !== 'object') return { status: 'invalid', report: null };
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const bySeverity = Object.fromEntries(SEO_SEVERITIES.map(key => [key, Number(summary.bySeverity?.[key] ?? 0)]));
  const categories = Object.fromEntries(Object.entries(report.categories ?? {}).slice(0, 20).map(([key, value]) => [key, {
    score: typeof value?.score === 'number' ? value.score : null,
    issues: typeof value?.issues === 'number' ? value.issues : null,
  }]));
  const actionPlan = Array.isArray(report.geo?.actionPlan) ? report.geo.actionPlan : [];
  const priorities = {};
  for (const item of actionPlan) {
    const priority = typeof item?.priority === 'string' ? item.priority : 'unknown';
    priorities[priority] = (priorities[priority] ?? 0) + 1;
  }
  const html = existsSync(join(root, 'seo', 'seo.html')) ? reportPath(siteId, 'seo/seo.html') : null;
  const csv = existsSync(join(root, 'seo', 'seo.csv')) ? reportPath(siteId, 'seo/seo.csv') : null;
  return {
    status: 'observed',
    generatedAt: typeof report.generatedAt === 'string' ? report.generatedAt : null,
    origin: originOf(report.origin),
    score: typeof report.score === 'number' ? report.score : null,
    grade: gradeOf(report.score),
    pages: typeof summary.pages === 'number' ? summary.pages : null,
    issues: typeof summary.issues === 'number' ? summary.issues : null,
    bySeverity,
    categories,
    geo: {
      actionItems: actionPlan.length,
      priorities,
      score: typeof report.geo?.score === 'number' ? report.geo.score : null,
    },
    completeness: {
      sitemapCoverage: summary.sitemapCoverage ?? null,
      failedPages: Number(summary.failedPages ?? 0),
      initialHtmlUnchecked: Number(summary.initialHtmlUnchecked ?? 0),
      baselineEligible: summary.baselineEligible === true,
      baselineCompared: summary.baselineCompared === true,
    },
    reports: { json: reportPath(siteId, 'seo/seo.json'), html, csv },
  };
}

function publicContract(root, siteId) {
  const candidates = ['api-contract.json', 'deliver/api-contract.json', 'deliverable/api-contract.json'];
  for (const suffix of candidates) {
    const file = join(root, suffix);
    if (!existsSync(file)) continue;
    const contract = readJson(file);
    if (!contract || typeof contract !== 'object') return { status: 'invalid', path: reportPath(siteId, suffix) };
    const summary = summarizeObservedApiContract(contract);
    const origin = originOf(contract.origin) ?? originOf(contract.openapi?.servers?.[0]?.url);
    return { status: summary.endpoints ? 'observed' : 'no_observed_api', path: reportPath(siteId, suffix), origin,
      summary: { tier: summary.tier, endpoints: summary.endpoints, withResponseSchema: summary.withResponseSchema,
        withRequestSchema: summary.withRequestSchema, authSchemes: summary.authSchemes, errorSamples: summary.errorSamples,
        unknowns: summary.unknowns } };
  }
  return { status: 'missing', path: null, origin: null, summary: null };
}

function adapterSummary(root, siteId) {
  const dir = join(root, 'runtime-adapter');
  const manifestFile = join(dir, 'manifest.json');
  const moduleFile = join(dir, 'index.mjs');
  const present = existsSync(manifestFile) && existsSync(moduleFile);
  if (!present) return { status: 'missing', present: false, routes: null, sessions: null, validation: null, report: null };
  const manifest = readJson(manifestFile);
  const reportFile = join(root, 'adapter-report.json');
  const report = existsSync(reportFile) ? readJson(reportFile) : null;
  const validation = report?.results && typeof report.results === 'object' ? {
    status: report.results.status ?? 'not_validated',
    equivalence: typeof report.results.equivalence === 'number' ? report.results.equivalence : null,
    heldout: Number(report.results.heldout ?? 0),
    passed: Number(report.results.passed ?? 0),
    failed: Number(report.results.failed ?? 0),
    unverified: Number(report.results.unverified ?? 0),
  } : null;
  return {
    status: validation?.status === 'passed' ? 'validated' : validation ? 'observed' : 'not_validated',
    present: true,
    routes: Array.isArray(manifest?.routes) ? manifest.routes.length : null,
    sessions: manifest?.sessions && typeof manifest.sessions === 'object' ? Object.keys(manifest.sessions).length : 0,
    validation,
    report: existsSync(reportFile) ? reportPath(siteId, 'adapter-report.json') : null,
  };
}

function apiSummary(root, siteId) {
  const contract = publicContract(root, siteId);
  const adapter = adapterSummary(root, siteId);
  const unknowns = [];
  if (contract.status === 'missing') unknowns.push('api-contract-missing');
  if (contract.status === 'observed' || contract.status === 'no_observed_api') {
    unknowns.push('auth-permissions-state-unknown', 'business-rules-and-side-effects-unknown');
    if (contract.summary?.unknowns) unknowns.push(`api-contract-unknowns:${contract.summary.unknowns}`);
  }
  if (adapter.present && !adapter.validation) unknowns.push('adapter-validation-missing');
  if (adapter.present && adapter.validation?.status !== 'passed') unknowns.push('adapter-not-validated');
  return {
    status: adapter.status === 'validated' ? 'adapter_validated'
      : adapter.present ? 'adapter_observed'
        : contract.status === 'observed' ? 'contract_observed'
          : contract.status,
    contract,
    adapter,
    unknowns,
  };
}

function runSummary(run) {
  const summary = run?.summary && typeof run.summary === 'object' ? run.summary : null;
  if (!summary) return null;
  return Object.fromEntries(['total', 'fileable', 'environment', 'checkNeedsFix', 'tolerable', 'suppressed', 'knownBug', 'reopened']
    .filter(key => Number.isFinite(summary[key])).map(key => [key, summary[key]]));
}

function qaSummary(args, ctx, siteId, origin) {
  if (!args.qaWorkspace) return { status: 'not_configured', latest: null, site: null };
  let ws;
  try { ws = openWorkspace(args.qaWorkspace, ctx); } catch { return { status: 'unavailable', latest: null, site: null }; }
  const sites = Object.values(ws.sites);
  const qaSite = sites.find(site => site.name === siteId || site.origin === origin || originOf(site.url) === origin) ?? sites[0] ?? null;
  if (!qaSite) return { status: 'configured', latest: null, site: null };
  const run = listRuns(ws, 100).find(item => item.site === qaSite.name) ?? null;
  if (!run) return { status: 'no_runs', latest: null, site: { name: qaSite.name, environment: qaSite.environment, pages: qaSite.pages.length } };
  const runDir = join(ws.dataDir, run.runId);
  return {
    status: 'observed',
    site: { name: qaSite.name, environment: qaSite.environment, pages: qaSite.pages.length },
    latest: {
      runId: run.runId,
      startedAt: run.startedAt ?? null,
      summary: runSummary(run),
      report: relPath(ws, join(runDir, 'report.md')),
      bugs: relPath(ws, join(runDir, 'bugs.md')),
    },
  };
}

function siteOrigin(root, pages, seo, api) {
  if (seo.origin) return seo.origin;
  if (api.contract.origin) return api.contract.origin;
  for (const page of pages.slice(0, 20)) {
    const manifest = readJson(join(root, 'pages', page, 'manifest.json'));
    const origin = originOf(manifest?.target);
    if (origin) return origin;
  }
  return null;
}

function claimsOf(siteId, clone, seo, api, qa, unknowns) {
  const verified = [];
  const observed = [];
  if (clone.verified > 0) verified.push(`clone.multi_viewport:${clone.verified}`);
  if (api.adapter.validation?.status === 'passed') verified.push(`api.adapter_holdout:${api.adapter.validation.equivalence ?? 'n/a'}`);
  if (clone.mirrors > 0) observed.push(`clone.mirrors:${clone.mirrors}/${clone.pages}`);
  if (seo.status === 'observed') observed.push(`seo.report:${seo.score ?? 'n/a'}`);
  if (api.contract.status === 'observed') observed.push(`api.contract:${api.contract.summary?.endpoints ?? 0}`);
  if (api.adapter.present) observed.push(`api.adapter:${api.adapter.routes ?? 'n/a'} routes`);
  if (qa.status === 'observed') observed.push(`qa.latest_run:${qa.latest.runId}`);
  return { verified, observed, unknown: unknowns.map(item => item.id), siteId };
}

export default {
  id: 'site_assessment',
  title: '站点评估：证据、能力与下一步',
  description: 'Read one site workspace and return a conservative assessment for an AI agent: clone coverage and multi-viewport evidence, the latest SEO/GEO report, public API contract and replay-adapter validation, and an optional QA workspace run. It reads only sanitized public summaries; it never reads raw HAR, sessions, operation plans or adapter source. Verified, observed and unknown claims stay separate. Read-only and works without the engine.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false, required: ['siteId'],
    properties: {
      siteId: { type: 'string', minLength: 1, maxLength: 253, description: 'Site id from heimdall_overview or the workspace directory' },
      qaWorkspace: { type: 'string', minLength: 1, maxLength: 1000, description: 'Optional QA workspace containing .heimdall/qa.json; credentials are never returned' },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Maximum sample pages returned' },
    },
  },
  cli: { usage: 'site-assessment <siteId> [--qa-workspace DIR] [--limit N]', positional: ['siteId'] },
  async handler(args, ctx) {
    const root = siteDir(args.siteId);
    if (!existsSync(root)) throw new CapabilityError('not_found', `没有站点工作区 ${args.siteId}`, { hint: '`heimdall overview` 列出已有站点或先运行 `heimdall clone`' });
    const pages = existsSync(join(root, 'pages')) ? listPages(args.siteId) : [];
    const scan = await scanMeasurementsAsync(root, pages);
    const clone = cloneSummary(args.siteId, pages, scan);
    const seo = seoSummary(args.siteId, root);
    const api = apiSummary(root, args.siteId);
    const origin = siteOrigin(root, pages, seo, api);
    const qa = qaSummary(args, ctx, args.siteId, origin);
    const unknowns = [];
    if (!clone.pages) unknowns.push({ id: 'clone-not-captured', detail: '没有页面目录，克隆与多视口验证都未知。' });
    else if (!clone.mirrors) unknowns.push({ id: 'clone-mirror-missing', detail: '发现页面但没有镜像入口。' });
    if (clone.unmeasured > 0) unknowns.push({ id: 'clone-unmeasured-pages', detail: `${clone.unmeasured} 页没有当前有效的多视口验证。` });
    if (clone.verificationStatus !== 'checked') unknowns.push({ id: 'clone-verification-unavailable', detail: `验证扫描状态为 ${clone.verificationStatus}。` });
    if (seo.status === 'missing') unknowns.push({ id: 'seo-report-missing', detail: '没有本地 SEO/GEO 报告。' });
    if (seo.status === 'invalid') unknowns.push({ id: 'seo-report-invalid', detail: 'SEO 报告存在但无法读取。' });
    if (seo.status === 'observed' && (seo.completeness.failedPages > 0 || seo.completeness.initialHtmlUnchecked > 0)) {
      unknowns.push({ id: 'seo-collection-incomplete', detail: 'SEO 报告包含未成功采集或未核对页面。' });
    }
    for (const id of api.unknowns) unknowns.push({ id, detail: 'API 行为、认证、权限、状态机或副作用仍未被该摘要证明。' });
    if (qa.status === 'not_configured') unknowns.push({ id: 'qa-not-configured', detail: '没有提供 QA 工作区，最近一次 QA 运行未知。' });
    if (qa.status === 'no_runs') unknowns.push({ id: 'qa-not-run', detail: 'QA 工作区存在，但还没有匹配站点的运行记录。' });
    if (qa.status === 'unavailable') unknowns.push({ id: 'qa-workspace-unavailable', detail: '提供的 QA 工作区无法读取。' });
    const overall = clone.mirrors > 0 ? 'ready_for_ai_review' : 'needs_capture';
    const nextActions = [];
    if (!clone.mirrors) nextActions.push(nextAction('heimdall_clone', origin ? { url: `${origin}/`, scope: 'site', level: 'verified' } : { siteId: args.siteId, scope: 'site', level: 'verified' }, '先取得参考镜像并做多视口验证'));
    else if (clone.unmeasured > 0) nextActions.push(nextAction('heimdall_clone', { siteId: args.siteId, scope: 'site', level: 'verified' }, '补齐未测页面的当前验证证据'));
    if (seo.status !== 'observed' && origin) nextActions.push(nextAction('heimdall_seo_audit', { url: `${origin}/` }, '补一份 SEO/GEO 报告'));
    if (api.contract.status === 'observed' && !api.adapter.present) nextActions.push(nextAction('cli:shell', { command: `heimdall probe adapter --site ${args.siteId} --include-api-bodies` }, '契约存在但还没有本地适配器，先显式生成观察回放草稿'));
    if (qa.status === 'no_runs') nextActions.push(nextAction('heimdall_qa_run', { workspace: args.qaWorkspace, site: qa.site?.name }, '运行一次只读 QA'));
    if (qa.latest?.summary?.fileable > 0) nextActions.push(nextAction('heimdall_qa_findings', { workspace: args.qaWorkspace, action: 'show', runId: qa.latest.runId }, '逐条复核最近一次 QA 建议提单'));
    const evidence = [];
    if (seo.status === 'observed') evidence.push({ kind: 'file', path: seo.reports.json });
    if (api.contract.path) evidence.push({ kind: 'file', path: api.contract.path });
    if (api.adapter.report) evidence.push({ kind: 'file', path: api.adapter.report });
    return ok({ siteId: args.siteId, origin, overall, clone: { ...clone, samplePages: clone.samplePages.slice(0, args.limit) }, seo, api, qa,
      claims: claimsOf(args.siteId, clone, seo, api, qa, unknowns), unknowns }, {
      summary: `${args.siteId}：${clone.mirrors}/${clone.pages} 页有镜像；多视口验证 ${clone.verified ?? 0} 页；SEO ${seo.status}；API ${api.status}；QA ${qa.status}。`,
      nextActions: nextActions.slice(0, 5), evidence,
    });
  },
};
