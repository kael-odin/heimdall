/**
 * capability: site_assessment -- one conservative status package for a site.
 *
 * It reads only public summaries already written by Heimdall. Raw HAR files,
 * sessions, operation plans and adapter modules are never opened here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { measurementCoverage, scanMeasurementsAsync } from '../../../verify/measurement-status.mjs';
import { summarizeObservedApiContract } from '../../../live/contract.mjs';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { redactText } from '../../redact.mjs';
import { summarizeGeoReport } from '../../geo-summary.mjs';
import { qaFindingDigest, safeSummaryText } from '../../qa-finding-summary.mjs';
import { listPages, pageDir, siteDir } from '../../workspace.mjs';
import { listRuns, openWorkspace, relPath, runsDir } from '../../../qa/run.mjs';
import { analyzeQaMetrics } from '../../../qa/metrics.mjs';
import { qaIncompleteReasons } from '../../../qa/ci.mjs';
import { readCurrentScore } from '../../../score-status.mjs';
import { validateDeploymentReport, verifyBundleChecksums } from '../../../live/deployment-verify.mjs';

const MAX_PUBLIC_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_BACKEND_TASK_ENDPOINTS = 200;
const SEO_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const BROWSER_FAILURE_KINDS = new Set(['http', 'pageError', 'navigation', 'requestFailed', 'externalRequest', 'websocketUnsupported', 'observationDeadline', 'pageCrash', 'probeError']);
const BROWSER_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other']);
const BINARY_DOWNLOAD_PATH = /\.(?:db|sqlite3?|zip|tar|tgz|gz|bz2|xz|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp)(?:$|[?#])/i;

function readJson(file) {
  try {
    if (statSync(file).size > MAX_PUBLIC_REPORT_BYTES) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

function gapLedgerSummary(root, siteId, report) {
  const sidecar = readJson(join(root, 'adapter-gap-ledger.json'));
  const source = sidecar?.schema === 'heimdall.adapter-gap-ledger/1' ? sidecar
    : report?.gapLedger?.schema === 'heimdall.adapter-gap-ledger/1' ? report.gapLedger : null;
  if (!source) return null;
  const safePath = value => {
    let pathname;
    try { pathname = new URL(String(value ?? '/'), 'http://adapter.local').pathname; } catch { return '/[invalid]'; }
    return '/' + pathname.split('/').filter(Boolean).map(segment => {
      let decoded = segment;
      try { decoded = decodeURIComponent(segment); } catch {}
      if (/^\d+$/.test(decoded)) return '{n}';
      if (decoded.length > 64 || /@/.test(decoded) || /^[a-z0-9_-]{24,}$/i.test(decoded)) return '{value}';
      return decoded.slice(0, 128);
    }).join('/');
  };
  const safeNames = value => Array.isArray(value) ? [...new Set(value.map(name => String(name).trim().toLowerCase())
    .filter(name => /^[a-z0-9_.:[\]~-]{1,128}$/i.test(name)).slice(0, 50))].sort() : [];
  const safeLabels = value => Array.isArray(value) ? value.map(label => String(label)).filter(label => /^[a-z0-9:_-]{1,80}$/i.test(label)).slice(0, 10) : [];
  const safeRoute = item => item && typeof item === 'object' ? {
    method: String(item.method ?? '').toUpperCase().slice(0, 10), path: safePath(item.path),
    queryParams: safeNames(item.queryParams), responseBody: item.responseBody === 'observed' ? 'observed' : 'unavailable',
    writeVerification: item.writeVerification === 'unverified' ? 'unverified' : 'not_applicable',
  } : null;
  const summary = source.summary && typeof source.summary === 'object' ? source.summary : {};
  return {
    schema: 'heimdall.adapter-gap-ledger/1', source: source.source ?? 'unknown', status: source.status ?? 'unknown',
    summary: Object.fromEntries(['runtimeRequests', 'uniqueGaps', 'unobservedPaths', 'unobservedQueryVariants', 'uncoveredQueryParameters', 'missingResponseBodies', 'unverifiedWrites']
      .map(key => [key, Number(summary[key] ?? 0)])),
    knownRoutes: Array.isArray(source.knownRoutes) ? source.knownRoutes.slice(0, MAX_BACKEND_TASK_ENDPOINTS).map(safeRoute).filter(Boolean) : [],
    gaps: Array.isArray(source.gaps) ? source.gaps.slice(0, 50).map(item => ({
      method: String(item.method ?? '').toUpperCase().slice(0, 10), path: safePath(item.path), queryParams: safeNames(item.queryParams),
      count: Number(item.count ?? 0), categories: safeLabels(item.categories),
      nearestRoutes: Array.isArray(item.nearestRoutes) ? item.nearestRoutes.slice(0, 3).map(safeRoute).filter(Boolean) : [],
    })) : [],
    unknowns: safeLabels(source.unknowns).slice(0, 20),
    report: source === report?.gapLedger ? reportPath(siteId, 'adapter-report.json') : reportPath(siteId, 'adapter-gap-ledger.json'),
  };
}

function observedEndpointSummaries(contract) {
  const paths = contract?.openapi?.paths;
  if (!paths || typeof paths !== 'object') return [];
  const hasSchema = item => typeof item?.schema === 'boolean'
    || (item?.schema !== null && typeof item?.schema === 'object' && !Array.isArray(item.schema));
  return Object.entries(paths).flatMap(([path, pathItem]) => Object.entries(pathItem ?? {})
    .filter(([method]) => HTTP_METHODS.has(method.toLowerCase()))
    .map(([method, operation]) => {
      const observations = operation?.['x-heimdall-observations'] ?? {};
      const content = (value) => value && typeof value === 'object' ? value.content ?? {} : {};
      const responseShapes = Object.entries(operation?.responses ?? {})
        .filter(([status]) => /^\d+$/.test(status))
        .map(([status, response]) => {
          const responseContent = content(response);
          return {
            status: Number(status),
            mimeTypes: Object.keys(responseContent).sort(),
            withSchema: Object.values(responseContent).some(hasSchema),
            samples: Number.isFinite(Number(response?.['x-heimdall-samples'])) ? Number(response['x-heimdall-samples']) : null,
            basis: 'observed',
          };
        });
      const requestContent = content(operation?.requestBody);
      return {
        method: method.toUpperCase(),
        path,
        samples: Number.isFinite(Number(observations.samples)) ? Number(observations.samples) : null,
        queryParams: Array.isArray(observations.queryParams) ? [...observations.queryParams].sort() : [],
        authSchemes: Array.isArray(observations.authSchemes) ? [...observations.authSchemes].sort() : [],
        requestBody: operation?.requestBody ? {
          observed: true,
          mimeTypes: Object.keys(requestContent).sort(),
          withSchema: Object.values(requestContent).some(hasSchema),
          basis: 'observed',
        } : { observed: false, mimeTypes: [], withSchema: false, basis: 'unknown' },
        responseShapes,
        basis: 'observed',
      };
    }))
    .sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`))
    .slice(0, MAX_BACKEND_TASK_ENDPOINTS);
}

function reportPath(siteId, suffix) {
  return `workspace/${siteId}/${suffix}`;
}

function safeBrowserFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = { kind: BROWSER_FAILURE_KINDS.has(value.kind) ? value.kind : 'unknown' };
  for (const key of ['page', 'target', 'error', 'message', 'resourceType']) {
    if (typeof value[key] !== 'string') continue;
    if (key === 'resourceType') result.resourceType = BROWSER_RESOURCE_TYPES.has(value[key]) ? value[key] : 'other';
    else result[key] = safeSummaryText(value[key]);
  }
  if (Number.isInteger(value.status)) result.status = value.status;
  if (Number.isInteger(value.pageIndex) && value.pageIndex >= 0) result.pageIndex = value.pageIndex;
  return result;
}

function safeBinaryDownloadGap(value) {
  if (!value || typeof value !== 'object' || typeof value.path !== 'string') return null;
  let pathname;
  try { pathname = new URL(value.path, 'http://health.local').pathname; } catch { return null; }
  if (!BINARY_DOWNLOAD_PATH.test(pathname)) return null;
  return {
    path: redactText(pathname, { profile: 'strict' }).text.slice(0, 240),
    kind: typeof value.kind === 'string' ? value.kind.slice(0, 64) : 'unknown',
    references: Number.isInteger(value.references) && value.references >= 0 ? value.references : 0,
    pages: Array.isArray(value.pages) ? value.pages.filter(page => typeof page === 'string').slice(0, 10)
      .map(page => redactText(page, { profile: 'strict' }).text.slice(0, 160)) : [],
  };
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

function safeSeoIssuePath(value) {
  try { return new URL(String(value), 'http://seo.local').pathname.slice(0, 240); }
  catch { return safeSummaryText(value, 240); }
}

function seoRepairCandidates(report) {
  const groups = new Map();
  const add = (issue, page = null) => {
    if (!issue || !['critical', 'high'].includes(issue.severity) || typeof issue.id !== 'string') return;
    const current = groups.get(issue.id) ?? {
      id: issue.id.slice(0, 96), category: safeSummaryText(issue.category, 48), severity: issue.severity,
      title: safeSummaryText(issue.title, 240), suggestion: safeSummaryText(issue.suggestion, 360),
      affectedPages: 0, pages: [],
    };
    if (issue.severity === 'critical') current.severity = 'critical';
    if (page) {
      current.affectedPages++;
      const path = safeSeoIssuePath(page);
      if (path !== '/' && current.pages.length < 20 && !current.pages.includes(path)) current.pages.push(path);
    }
    groups.set(issue.id, current);
  };
  for (const page of Array.isArray(report?.pages) ? report.pages : []) {
    for (const issue of Array.isArray(page?.issues) ? page.issues : []) add(issue, page.url);
  }
  for (const issue of Array.isArray(report?.siteIssues) ? report.siteIssues : []) add(issue);
  const all = [...groups.values()].sort((a, b) => (a.severity === 'critical' ? -1 : 1) - (b.severity === 'critical' ? -1 : 1) || a.id.localeCompare(b.id));
  return { items: all.slice(0, 20), total: all.length, truncated: all.length > 20 };
}

function adapterEgressVerification(root, siteId) {
  const report = reportPath(siteId, 'adapter-egress-verification.json');
  const file = join(root, 'adapter-egress-verification.json');
  if (!existsSync(file)) return null;
  const source = readJson(file);
  const dataRoot = resolve(root, '..', '..');
  const bundle = typeof source?.bundle === 'string' ? source.bundle : '';
  const bundlePath = resolve(dataRoot, bundle);
  const bundleRel = relative(dataRoot, bundlePath).replaceAll('\\', '/');
  if (!bundle || bundleRel !== bundle || !bundleRel.startsWith('deliverable/')) {
    return { status: 'invalid', report };
  }
  let checksumsSha256 = null;
  try { checksumsSha256 = verifyBundleChecksums(bundlePath); }
  catch { return { status: 'invalid', report }; }
  if (!validateDeploymentReport(source, { siteId, checksumsSha256 })) return { status: 'invalid', report };
  const safeChecks = value => value && typeof value === 'object' && !Array.isArray(value) ? {
    checked: Number.isSafeInteger(value.checked) && value.checked >= 0 ? value.checked : 0,
    passed: Number.isSafeInteger(value.passed) && value.passed >= 0 ? value.passed : 0,
    results: Array.isArray(value.results) ? value.results.slice(0, 100).map(item => ({
      id: typeof item?.id === 'string' ? item.id.slice(0, 64) : 'unknown',
      status: Number.isInteger(item?.status) ? item.status : null,
    })) : [],
  } : null;
  const rawHttpChecks = source.httpChecks;
  return {
    status: 'verified', report, generatedAt: source.generatedAt,
    bundle: bundleRel, bundleChecksumsSha256: checksumsSha256,
    adapter: source.adapter && typeof source.adapter === 'object' ? {
      declaredRoutes: Number(source.adapter.declaredRoutes ?? 0),
      exercisedRoutes: Number(source.adapter.exercisedRoutes ?? 0),
      untestedRoutes: Number(source.adapter.untestedRoutes ?? 0),
    } : null,
    httpChecks: rawHttpChecks && typeof rawHttpChecks === 'object' ? {
      beforeRestart: safeChecks(rawHttpChecks.beforeRestart), afterRestart: safeChecks(rawHttpChecks.afterRestart),
    } : null,
  };
}

function liveExportSummary(root, siteId) {
  const file = join(root, 'live-export.json');
  if (!existsSync(file)) return { status: 'not_recorded', report: null };
  const report = reportPath(siteId, 'live-export.json');
  const invalid = { status: 'invalid', report };
  const source = readJson(file);
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (source?.schema !== 'heimdall.live-export/1' || source.siteId !== siteId
    || !['blocked', 'passed', 'unverified'].includes(source.status)
    || !['published', 'offline', 'strict'].every(key => typeof source[key] === 'boolean')
    || !count(source.pages) || !count(source.blockingCount)
    || typeof source.generatedAt !== 'string' || source.generatedAt.length > 40 || !Number.isFinite(Date.parse(source.generatedAt))
    || !source.blockers || typeof source.blockers !== 'object' || Array.isArray(source.blockers)) return invalid;
  const entries = Object.entries(source.blockers);
  if (entries.length > 100 || entries.some(([, value]) => !count(value))
    || entries.reduce((sum, [, value]) => sum + value, 0) !== source.blockingCount) return invalid;
  const browser = source.browser && ['checked', 'failed', 'untested', 'totalPages'].every(key => count(source.browser[key]))
    ? Object.fromEntries(['checked', 'failed', 'untested', 'totalPages'].map(key => [key, source.browser[key]])) : null;
  if ((source.browser !== null && !browser) || (source.strict && !source.offline)
    || (source.status === 'blocked' && (source.published || !source.strict || !source.blockingCount))
    || (source.status === 'unverified' && (!source.published || source.strict))
    || (source.status === 'passed' && (!source.published || !source.offline || !source.strict || source.blockingCount
      || !source.pages || !browser || browser.failed || browser.untested || browser.checked !== source.pages || browser.totalPages !== source.pages))) return invalid;
  const names = new Set(['unresolved', 'dynamic', 'externalAssets', 'unsupportedRuntimeServices', 'missingLinks',
    'runtimeMissing', 'browserFailed', 'browserUntested', 'missingLivePages', 'discoveredUncloned', 'discoveredUndelivered',
    'privacyIssues', 'privacyIncomplete', 'coverageInvalid', 'scanTruncated', 'operationFailed', 'operationUntested',
    'readOnlyDataInvalid', 'readOnlyDataMissing', 'readOnlyDataShadowed', 'readOnlyDataConflicts',
    'readOnlyBinarySourceUntested', 'offlineReadOnlyRequestMissing', 'offlineReadOnlyCaptureFailed',
    'readOnlyFlowMismatch', 'readOnlyFlowUntested', 'sourceReadOnlyCurrentMissing', 'sourceReadOnlyCaptureFailed',
    'unsupportedExternalRedirects', 'unsupportedExternalRedirectReferences']);
  const blockers = Object.fromEntries(entries.filter(([name]) => names.has(name)));
  const candidatePrefix = `deliverable/.candidate-${siteId}-`;
  const healthReport = typeof source.healthReport === 'string' && source.healthReport.startsWith(candidatePrefix)
    && /^[a-z0-9]{6}\/health\.json$/i.test(source.healthReport.slice(candidatePrefix.length)) ? source.healthReport : null;
  const health = healthReport ? readJson(join(root, healthReport)) : null;
  const browserFailures = Array.isArray(health?.browserProbe?.failures)
    ? health.browserProbe.failures.slice(0, 50).map(safeBrowserFailure).filter(Boolean) : [];
  const binaryDownloadGaps = Array.isArray(health?.missingLinkDetails)
    ? health.missingLinkDetails.slice(0, 100).map(safeBinaryDownloadGap).filter(Boolean) : [];
  const rawReadOnlyData = health?.readOnlyData;
  const readOnlyData = rawReadOnlyData && typeof rawReadOnlyData === 'object' && !Array.isArray(rawReadOnlyData)
    ? {
      status: typeof rawReadOnlyData.status === 'string' ? rawReadOnlyData.status.slice(0, 32) : 'unknown',
      ...Object.fromEntries(['declared', 'included', 'missing', 'binaryDeclared', 'binaryIncluded', 'conflicts']
        .filter(key => Number.isSafeInteger(rawReadOnlyData[key]) && rawReadOnlyData[key] >= 0)
        .map(key => [key, rawReadOnlyData[key]])),
      ...(typeof rawReadOnlyData.issue === 'string' ? { issue: rawReadOnlyData.issue.slice(0, 96) } : {}),
      ...(typeof rawReadOnlyData.binarySourceStatus === 'string'
        ? { binarySourceStatus: rawReadOnlyData.binarySourceStatus.slice(0, 32) } : {}),
    } : null;
  const egressVerification = adapterEgressVerification(root, siteId);
  const rawAdapter = health?.adapter;
  const adapterSource = rawAdapter ?? egressVerification?.adapter;
  const adapter = adapterSource && typeof adapterSource === 'object' && !Array.isArray(adapterSource)
    ? {
      serverEgress: egressVerification?.status === 'verified' ? 'verified'
        : ['not-tested', 'blocked', 'failed'].includes(adapterSource.serverEgress)
          ? adapterSource.serverEgress : 'unknown',
      ...(Number.isSafeInteger(adapterSource.declaredRoutes) && adapterSource.declaredRoutes >= 0
        ? { declaredRoutes: adapterSource.declaredRoutes } : {}),
      ...(Number.isSafeInteger(adapterSource.exercisedRoutes) && adapterSource.exercisedRoutes >= 0
        ? { exercisedRoutes: adapterSource.exercisedRoutes } : {}),
      ...(Number.isSafeInteger(adapterSource.untestedRoutes) && adapterSource.untestedRoutes >= 0
        ? { untestedRoutes: adapterSource.untestedRoutes } : {}),
    } : null;
  return {
    status: source.status, generatedAt: new Date(source.generatedAt).toISOString(), report, healthReport,
    offline: source.offline, strict: source.strict, root: source.root === 'mirror' ? 'mirror' : 'landing',
    published: source.published, pages: source.pages, adapter, adapterEgressVerification: egressVerification,
    blockingCount: source.blockingCount, blockers,
    otherBlockers: source.blockingCount - Object.values(blockers).reduce((sum, value) => sum + value, 0),
    browser, browserFailures, binaryDownloadGaps, readOnlyData, coverage: {
      scope: ['captured-only', 'recon-discovered', 'untrusted-recon'].includes(source.coverage?.scope) ? source.coverage.scope : 'unknown',
      scopeLimited: source.coverage?.scope !== 'recon-discovered' || source.coverage?.scopeLimited !== false,
    },
    freshness: 'last_completed_export',
  };
}

function cloneSummary(siteId, pages, scan) {
  const mirrors = pages.filter(page => existsSync(join(pageDir(siteId, page), 'clone', 'index.html')));
  const coverage = measurementCoverage(scan, pages.length);
  const measurements = new Map(scan.pages.map(row => [row.page, row]));
  const scoreStates = mirrors.map(page => readCurrentScore(pageDir(siteId, page), measurements.get(page)?.inputSha256));
  const scores = scoreStates.map(state => state.score)
    .filter(score => typeof score?.total === 'number' && Number.isFinite(score.total));
  const scoreStatuses = Object.fromEntries(['verified', 'stale', 'legacy', 'missing', 'invalid']
    .map(status => [status, scoreStates.filter(state => state.status === status).length]));
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
    scoreStatuses,
    averageOverall: coverage.average,
    worstViewport: worst,
    delivery: liveExportSummary(siteDir(siteId), siteId),
    samplePages: mirrors.slice(0, 10),
  };
}

function seoSummary(siteId, root) {
  const file = join(root, 'seo', 'seo.json');
  if (!existsSync(file)) return { status: 'missing', report: null };
  const report = readJson(file);
  if (!report || typeof report !== 'object') return { status: 'invalid', report: null };
  const repairCandidates = seoRepairCandidates(report);
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const bySeverity = Object.fromEntries(SEO_SEVERITIES.map(key => [key, Number(summary.bySeverity?.[key] ?? 0)]));
  const categories = Object.fromEntries(Object.entries(report.categories ?? {}).slice(0, 20).map(([key, value]) => [key, {
    score: typeof value?.score === 'number' ? value.score : null,
    issues: typeof value?.issues === 'number' ? value.issues : null,
  }]));
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
    geo: summarizeGeoReport(report.geo),
    repairCandidates: repairCandidates.items,
    repairCandidatesMeta: { total: repairCandidates.total, returned: repairCandidates.items.length, truncated: repairCandidates.truncated },
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
    const observedEndpoints = observedEndpointSummaries(contract);
    return { status: summary.endpoints ? 'observed' : 'no_observed_api', path: reportPath(siteId, suffix), origin,
      summary: { tier: summary.tier, endpoints: summary.endpoints, withResponseSchema: summary.withResponseSchema,
        withRequestSchema: summary.withRequestSchema, authSchemes: summary.authSchemes, errorSamples: summary.errorSamples,
        unknowns: summary.unknowns }, observedEndpoints };
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
  const gapLedger = gapLedgerSummary(root, siteId, report);
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
    gapLedger,
    report: existsSync(reportFile) ? reportPath(siteId, 'adapter-report.json') : null,
  };
}

function backendScaffoldSummary(root, siteId) {
  const dir = join(root, 'backend-scaffold');
  const required = ['package.json', 'server.mjs', 'checks.mjs', 'api-contract.json', 'state-rules.json'];
  const files = required.filter(name => {
    try { return statSync(join(dir, name)).isFile(); } catch { return false; }
  });
  const status = files.length === required.length ? 'present' : files.length ? 'incomplete' : 'missing';
  const checkFile = join(dir, 'backend-check.json');
  const checkReport = existsSync(checkFile) ? readJson(checkFile) : null;
  const checkResults = Array.isArray(checkReport?.results) ? checkReport.results : [];
  const checkStatus = ['passed', 'incomplete', 'failed'].includes(checkReport?.overall) ? checkReport.overall : checkReport ? 'invalid' : 'not_run';
  const safeRepairTask = task => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) return null;
    const value = {
      id: typeof task.id === 'string' ? task.id.slice(0, 128) : 'backend-repair',
      kind: typeof task.kind === 'string' ? task.kind.slice(0, 64) : 'backend-repair',
      target: typeof task.target === 'string' ? task.target.slice(0, 256) : 'backend-scaffold',
      instruction: typeof task.instruction === 'string' ? task.instruction.slice(0, 300) : '修复该检查项后重新运行 npm run check。',
      requiresHumanApproval: task.requiresHumanApproval === true,
    };
    const evidence = task.evidence && typeof task.evidence === 'object' && !Array.isArray(task.evidence) ? {} : null;
    if (evidence) {
      for (const key of ['httpStatus', 'missingObservedRoutes', 'schemaPath', 'actualMimeType', 'uniqueGaps', 'unobservedQueryVariants', 'uncoveredQueryParameters', 'unverifiedWrites']) {
        const source = task.evidence[key];
        if (typeof source === 'string') evidence[key] = source.slice(0, 128);
        else if (Number.isFinite(Number(source))) evidence[key] = Number(source);
      }
      for (const key of ['expectedStatuses', 'expectedMimeTypes']) {
        if (Array.isArray(task.evidence[key])) evidence[key] = task.evidence[key].slice(0, 30).map(item => String(item).slice(0, 128));
      }
      if (Object.keys(evidence).length) value.evidence = evidence;
    }
    return value;
  };
  const issueRows = checkResults.filter(item => ['failed', 'incomplete', 'not_implemented', 'skipped'].includes(item?.status)).slice(0, 50).map(item => {
    const repairTask = safeRepairTask(item?.repairTask);
    return {
      id: typeof item?.id === 'string' ? item.id.slice(0, 128) : 'unknown',
      status: typeof item?.status === 'string' ? item.status.slice(0, 32) : 'unknown',
      ...(typeof item?.reason === 'string' ? { reason: item.reason.slice(0, 256) } : {}),
      ...(Number.isInteger(item?.httpStatus) ? { httpStatus: item.httpStatus } : {}),
      ...(Number.isFinite(Number(item?.uniqueGaps)) ? { uniqueGaps: Number(item.uniqueGaps) } : {}),
      ...(Number.isFinite(Number(item?.uncoveredQueryParameters)) ? { uncoveredQueryParameters: Number(item.uncoveredQueryParameters) } : {}),
      ...(Number.isFinite(Number(item?.unverifiedWrites)) ? { unverifiedWrites: Number(item.unverifiedWrites) } : {}),
      ...(typeof item?.schemaError?.path === 'string' ? { schemaPath: item.schemaError.path.slice(0, 128) } : {}),
      ...(repairTask ? { repairTask } : {}),
    };
  });
  const check = {
    status: checkStatus,
    overall: checkStatus === 'invalid' || checkStatus === 'not_run' ? null : checkStatus,
    generatedAt: typeof checkReport?.generatedAt === 'string' ? checkReport.generatedAt : null,
    resultCount: checkResults.length,
    failed: checkResults.filter(item => item?.status === 'failed').length,
    incomplete: checkResults.filter(item => ['incomplete', 'not_implemented', 'skipped'].includes(item?.status)).length,
    issues: issueRows,
    repairTasks: issueRows.map(item => item.repairTask).filter(Boolean),
    path: existsSync(checkFile) ? reportPath(siteId, 'backend-scaffold/backend-check.json') : null,
  };
  return {
    status,
    present: status === 'present',
    files: files.length,
    requiredFiles: required.length,
    path: status === 'missing' ? null : reportPath(siteId, 'backend-scaffold'),
    check,
  };
}

function apiSummary(root, siteId) {
  const contract = publicContract(root, siteId);
  const adapter = adapterSummary(root, siteId);
  const scaffold = backendScaffoldSummary(root, siteId);
  const unknowns = [];
  if (contract.status === 'missing') unknowns.push('api-contract-missing');
  if (contract.status === 'observed' || contract.status === 'no_observed_api') {
    unknowns.push('auth-permissions-state-unknown', 'business-rules-and-side-effects-unknown');
    if (contract.summary?.unknowns) unknowns.push(`api-contract-unknowns:${contract.summary.unknowns}`);
  }
  if (adapter.present && !adapter.validation) unknowns.push('adapter-validation-missing');
  if (adapter.present && adapter.validation?.status !== 'passed') unknowns.push('adapter-not-validated');
  if (adapter.gapLedger?.summary?.uniqueGaps > 0) unknowns.push(`adapter-runtime-gaps:${adapter.gapLedger.summary.uniqueGaps}`);
  if (adapter.gapLedger?.summary?.missingResponseBodies > 0) unknowns.push('adapter-response-body-missing');
  if (adapter.gapLedger?.summary?.unverifiedWrites > 0) unknowns.push('adapter-writes-unverified');
  if (scaffold.present && scaffold.check.status === 'not_run') unknowns.push('backend-check-not-run');
  if (scaffold.present && scaffold.check.status === 'invalid') unknowns.push('backend-check-invalid');
  if (scaffold.present && scaffold.check.status === 'failed') unknowns.push('backend-check-failed');
  if (scaffold.present && scaffold.check.status === 'incomplete') unknowns.push('backend-check-incomplete');
  return {
    status: adapter.status === 'validated' ? 'adapter_validated'
      : adapter.present ? 'adapter_observed'
        : contract.status === 'observed' ? 'contract_observed'
          : contract.status,
    contract,
    adapter,
    scaffold,
    unknowns,
  };
}

function runSummary(run) {
  const summary = run?.summary && typeof run.summary === 'object' ? run.summary : null;
  if (!summary) return null;
  return Object.fromEntries(['total', 'fileable', 'environment', 'checkNeedsFix', 'tolerable', 'suppressed', 'knownBug', 'reopened']
    .filter(key => Number.isFinite(summary[key])).map(key => [key, summary[key]]));
}

function readQaFindingDigest(runDir, run) {
  const source = readJson(join(runDir, 'findings.json'));
  return qaFindingDigest(source, run.runId, { reportedTotal: run?.summary?.fileable ?? null });
}

function qaSummary(args, ctx, siteId, origin) {
  if (!args.qaWorkspace) return { status: 'not_configured', latest: null, metrics: null, site: null };
  let ws;
  try { ws = openWorkspace(args.qaWorkspace, ctx); } catch { return { status: 'unavailable', latest: null, metrics: null, site: null }; }
  const sites = Object.values(ws.sites);
  const qaSite = sites.find(site => site.name === siteId || site.origin === origin || originOf(site.url) === origin) ?? sites[0] ?? null;
  if (!qaSite) return { status: 'configured', latest: null, metrics: null, site: null };
  const runs = listRuns(ws, 100).filter(item => item.site === qaSite.name);
  const run = runs[0] ?? null;
  if (!run) return { status: 'no_runs', latest: null, metrics: null, site: { name: qaSite.name, environment: qaSite.environment, pages: qaSite.pages.length } };
  const runDir = join(runsDir(ws), run.runId);
  let metrics = null;
  try { metrics = analyzeQaMetrics({ runs }); } catch { /* malformed run summaries stay unavailable */ }
  const summary = runSummary(run);
  const coverage = run.coverage;
  const pages = Array.isArray(coverage?.pages) ? coverage.pages : [];
  const checks = Array.isArray(coverage?.checks) ? coverage.checks : [];
  const incompleteReasons = qaIncompleteReasons({ summary,
    clientBlocked: pages.reduce((n, p) => n + (p?.counts?.clientBlocked ?? 0), 0) + checks.reduce((n, c) => n + (c?.clientBlocked ?? 0), 0),
    detection: coverage?.detection, navigation: { failedPages: pages.filter(p => p?.navError) }, baseline: { status: coverage?.baseline?.status },
  });
  const known = summary && ['fileable', 'environment', 'checkNeedsFix'].every(key => Number.isInteger(summary[key]) && summary[key] >= 0)
    && pages.length > 0 && pages.every(p => typeof p?.path === 'string' && typeof p?.viewport === 'string')
    && Array.isArray(coverage?.checks) && checks.every(c => typeof c?.pass === 'boolean');
  return {
    status: 'observed',
    site: { name: qaSite.name, environment: qaSite.environment, pages: qaSite.pages.length },
    metrics,
    latest: {
      runId: run.runId,
      startedAt: run.startedAt ?? null,
      summary,
      completeness: { status: incompleteReasons.length ? 'incomplete' : known ? 'complete' : 'unknown', incompleteReasonCount: incompleteReasons.length },
      findings: readQaFindingDigest(runDir, run),
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
  if (clone.delivery.report) observed.push(`clone.offline_export:${clone.delivery.status}`);
  if (seo.status === 'observed') observed.push(`seo.report:${seo.score ?? 'n/a'}`);
  if (api.contract.status === 'observed') observed.push(`api.contract:${api.contract.summary?.endpoints ?? 0}`);
  if (api.adapter.present) observed.push(`api.adapter:${api.adapter.routes ?? 'n/a'} routes`);
  if (api.scaffold?.present) observed.push('api.backend_scaffold:B3');
  if (qa.status === 'observed') observed.push(`qa.latest_run:${qa.latest.runId}`);
  return { verified, observed, unknown: unknowns.map(item => item.id), siteId };
}

function plannedAction(tool, args, reason, { canAutoRun = false, requiresHumanApproval = true } = {}) {
  return { tool, ...(args ? { args } : {}), reason, canAutoRun, requiresHumanApproval };
}

function planVerification(siteId, condition) {
  return { tool: 'heimdall_site_assessment', args: { siteId }, condition };
}

function qaRepairTask(finding, qa, qaWorkspace) {
  const id = String(finding?.id ?? finding?.fingerprint ?? 'finding').replace(/[^a-z0-9_-]/gi, '-').slice(0, 64) || 'finding';
  const target = typeof finding?.target === 'string' && finding.target ? finding.target : finding?.path || '/';
  const confirmed = finding?.triage === 'known-bug';
  const evidence = Object.fromEntries([
    ['findingId', finding?.id], ['fingerprint', finding?.fingerprint], ['runId', qa.latest?.runId],
    ['kind', finding?.kind], ['basis', finding?.basis], ['tier', finding?.tier], ['path', finding?.path],
    ['triage', finding?.triage], ['report', qa.latest?.report], ['bugs', qa.latest?.bugs],
  ].filter(([, value]) => typeof value === 'string' && value));
  return {
    id: `repair-qa-${id}`, kind: 'qa-finding-repair', target,
    status: confirmed ? 'ready_for_fix' : 'blocked_on_human_verdict',
    instruction: confirmed
      ? '该问题已经人工确认；修复目标后，用同一站点和检查点重跑 QA。'
      : '先用 heimdall_qa_findings 确认这是需要修复的真实问题；确认后修复目标，再用同一站点和检查点重跑 QA。',
    requiresHumanApproval: !confirmed, evidence,
    verification: {
      tool: 'heimdall_qa_run',
      args: { ...(qaWorkspace ? { workspace: qaWorkspace } : {}), site: qa.site?.name },
      condition: '新的完整 QA 运行中，该 finding fingerprint 不再属于 fileable findings。',
    },
  };
}

function seoGeoRepairTask(action, seo) {
  const actionId = String(action?.id || action?.rank || 'action').replace(/[^a-z0-9_-]/gi, '-').slice(0, 64) || 'action';
  const checkId = typeof action?.validation?.checkId === 'string' && action.validation.checkId
    ? action.validation.checkId : actionId;
  return {
    id: `repair-geo-${actionId}`, kind: 'seo-geo-action', target: checkId,
    status: 'ready_for_fix',
    instruction: `${action?.action || action?.title || '按 GEO 行动项优化页面'}；完成后重新运行 SEO/GEO 审计。`,
    requiresHumanApproval: true,
    evidence: {
      actionId, dimension: action?.dimension || 'unknown', priority: action?.priority || 'P2',
      checkWeight: Number(action?.impact?.checkWeight ?? 0), affectedPages: Number(action?.impact?.affectedPages ?? 0),
      occurrences: Number(action?.impact?.occurrences ?? 0), estimatedEffort: action?.estimatedEffort || 'unknown',
      report: seo.reports?.json,
    },
    verification: {
      tool: 'heimdall_seo_audit',
      args: seo.origin ? { url: `${seo.origin}/` } : null,
      condition: `完整 SEO/GEO 报告中不再出现 action ${checkId}。`,
    },
  };
}

function seoRepairTask(issue, seo) {
  const id = String(issue?.id || 'seo-issue').replace(/[^a-z0-9_-]/gi, '-').slice(0, 64) || 'seo-issue';
  return {
    id: `repair-seo-${id}`, kind: 'seo-action', target: issue.id,
    status: 'ready_for_fix',
    instruction: `${issue.suggestion || issue.title || '修复 SEO 问题'}；完成后重新运行 SEO 审计。`,
    requiresHumanApproval: true,
    evidence: {
      category: issue.category, severity: issue.severity, affectedPages: issue.affectedPages,
      pages: issue.pages, report: seo.reports?.json,
    },
    verification: {
      tool: 'heimdall_seo_audit',
      args: seo.origin ? { url: `${seo.origin}/` } : null,
      condition: `完整 SEO 报告中不再出现 critical/high 问题 ${issue.id}。`,
    },
  };
}

function repairTasksFromGapLedger(siteId, gapLedger) {
  const summary = gapLedger?.summary;
  if (!summary) return [];
  const uniqueGaps = Number(summary.uniqueGaps || 0);
  const unobservedPaths = Number(summary.unobservedPaths || 0);
  const unverifiedWrites = Number(summary.unverifiedWrites || 0);
  const unobservedQueryVariants = Number(summary.unobservedQueryVariants || 0);
  const uncoveredQueryParameters = Number(summary.uncoveredQueryParameters || 0);
  const missingResponseBodies = Number(summary.missingResponseBodies || 0);
  if (uniqueGaps <= 0 && missingResponseBodies <= 0 && unverifiedWrites <= 0
    && unobservedQueryVariants <= 0 && uncoveredQueryParameters <= 0) return [];
  const evidence = { uniqueGaps, unobservedPaths, unobservedQueryVariants, uncoveredQueryParameters, missingResponseBodies, unverifiedWrites };
  const tasks = [];
  const add = (kind, instruction, condition, requiresHumanApproval = false) => tasks.push({
    id: 'repair-' + kind, kind, target: 'runtime-adapter/index.mjs', instruction, requiresHumanApproval, evidence,
    verification: planVerification(siteId, condition),
  });
  if (missingResponseBodies > 0) add('response-body-evidence', '先补充有授权的响应正文证据，再实现或修正适配器；没有正文证据时不要臆造业务数据。', 'api.adapter.gapLedger.summary.missingResponseBodies === 0', true);
  if (unverifiedWrites > 0) add('write-verification', '先用授权测试旅程验证写入、回读和清理，再修改适配器。', 'api.adapter.gapLedger.summary.unverifiedWrites === 0', true);
  if (unobservedQueryVariants > 0) add('query-variant-gap', '为已知查询参数补齐未观察到的值或组合；先用独立留出请求验证，再运行 npm run check。', 'api.adapter.gapLedger.summary.unobservedQueryVariants === 0');
  if (uncoveredQueryParameters > 0) add('query-parameter-gap', '补齐查询参数名对应的路由分支，再运行 npm run check。', 'api.adapter.gapLedger.summary.uncoveredQueryParameters === 0');
  if (unobservedPaths > 0 || uniqueGaps > 0 && tasks.length === 0) add('runtime-gap', '补齐运行时发现但契约未声明的路由，再运行 npm run check。', 'api.adapter.gapLedger.summary.uniqueGaps === 0');
  return tasks;
}

function buildBackendCompletionTask(siteId, api, delivery = null) {
  const observed = api.contract.status === 'observed';
  const endpoints = api.contract.observedEndpoints ?? [];
  const responseShapes = endpoints.flatMap(endpoint => endpoint.responseShapes);
  const shapedResponses = responseShapes.filter(shape => shape.withSchema);
  const hasWrite = endpoints.some(endpoint => endpoint.method !== 'GET');
  const validationStatus = api.adapter.validation?.status ?? 'not-validated';
  const adapterServerEgress = delivery?.adapter?.serverEgress ?? 'unknown';
  const gapLedger = api.adapter.gapLedger;
  const scaffold = api.scaffold ?? { status: 'missing', present: false, path: null };
  const repairTasks = Array.isArray(scaffold.check?.repairTasks) ? [...scaffold.check.repairTasks] : [];
  for (const gapRepairTask of repairTasksFromGapLedger(siteId, gapLedger)) {
    if (!repairTasks.some(task => task?.kind === gapRepairTask.kind)) repairTasks.push(gapRepairTask);
  }
  const scaffoldAction = observed && !scaffold.present
    ? plannedAction('cli:shell', {
      command: `heimdall backend scaffold ${siteId}${scaffold.status === 'incomplete' ? ' --force' : ''}`,
    }, '把观察型契约落成可启动的 B3 后端起点', { requiresHumanApproval: true })
    : null;
  const humanJourneys = observed ? [
    {
      id: 'anonymous-read', basis: 'inferred', status: 'required', requiresHumanApproval: true,
      goal: '用匿名或明确的只读身份走通一个真实读取流程，并记录页面结果与 API 结果如何对应。',
      checkpoints: ['请求成功与失败状态', '分页/筛选参数', '刷新或重新进入后的结果是否一致'],
    },
    {
      id: 'authentication-and-permission', basis: 'inferred', status: 'required', requiresHumanApproval: true,
      goal: '用独立测试账号验证登录、退出、凭据失效和至少两种权限边界。',
      checkpoints: ['未登录访问', '已登录访问', '无权限访问', '凭据刷新或失效后的行为'],
    },
    {
      id: 'state-and-side-effects', basis: 'inferred', status: 'required', requiresHumanApproval: true,
      goal: '确认一次业务操作前后状态如何变化，以及是否产生可观察副作用。',
      checkpoints: ['操作前状态', '提交后的响应', '再次读取或刷新后的状态', '失败时是否回滚'],
    },
  ] : [];
  if (hasWrite) humanJourneys.push({
    id: 'write-and-cleanup', basis: 'inferred', status: 'required', requiresHumanApproval: true,
    goal: '在明确许可的测试数据范围内验证写入、重复提交、异常输入和清理路径。',
    checkpoints: ['请求体校验', '重复/幂等行为', '持久化后读取', '测试数据清理'],
  });

  return {
    schema: 'heimdall.backend-completion-task/1',
    status: observed ? 'needs_human_journey' : 'blocked_on_observation',
    target: {
      requestedLevel: 'B2',
      currentLevel: observed ? (api.adapter.present ? 'B1_to_B2_bridge' : 'B1_observed_contract') : 'B0_or_lower',
    },
    observedEndpoints: endpoints,
    verifiedResponseShapes: {
      count: shapedResponses.length,
      items: shapedResponses,
      verificationStatus: validationStatus === 'passed' ? 'replay_holdout_passed' : 'observation_only',
      basis: 'observed',
    },
    scaffold: {
      level: 'B3-scaffold',
      status: scaffold.present ? 'present' : observed ? 'available' : 'blocked_on_observation',
      basis: scaffold.present ? 'observed' : observed ? 'inferred' : 'unknown',
      path: scaffold.path,
      action: scaffoldAction,
      check: scaffold.check,
    },
    repairTasks,
    adapterEgress: {
      status: adapterServerEgress,
      basis: adapterServerEgress === 'not-tested' || adapterServerEgress === 'verified' ? 'observed' : 'unknown',
      evidence: delivery?.adapterEgressVerification?.status === 'verified'
        ? [delivery.adapterEgressVerification.report] : [],
      httpChecks: delivery?.adapterEgressVerification?.httpChecks ?? null,
    },
    gapLedger,
    unknowns: [
      { id: 'authentication', basis: 'unknown', detail: '哪些端点强制认证、凭据如何刷新和失效，尚未由摘要证明。' },
      { id: 'permissions', basis: 'unknown', detail: '不同账号、角色或资源边界的允许/拒绝矩阵尚未验证。' },
      { id: 'state-machine', basis: 'unknown', detail: '创建、更新、删除、回滚和刷新后的状态转换尚未验证。' },
      { id: 'business-rules', basis: 'unknown', detail: '边界条件、幂等、限流、排序和业务校验规则尚未验证。' },
      { id: 'side-effects', basis: 'unknown', detail: '持久化、消息、邮件、支付、Webhook 等副作用尚未验证。' },
      ...(gapLedger?.summary?.uniqueGaps > 0 ? [{ id: 'runtime-gaps', basis: 'observed', detail: `运行时记录了 ${gapLedger.summary.uniqueGaps} 个脱敏请求缺口，需要补路由或补录制。` }] : []),
      ...(gapLedger?.summary?.missingResponseBodies > 0 ? [{ id: 'missing-response-body', basis: 'observed', detail: `${gapLedger.summary.missingResponseBodies} 条已声明路由没有可回放的响应体。` }] : []),
      ...(gapLedger?.summary?.unverifiedWrites > 0 ? [{ id: 'unverified-write', basis: 'unknown', detail: `${gapLedger.summary.unverifiedWrites} 条写入路由只有回放证据，尚未证明真实写入和清理。` }] : []),
      ...(api.adapter.present && adapterServerEgress !== 'verified' ? [{
        id: 'adapter-server-egress', basis: adapterServerEgress === 'not-tested' ? 'observed' : 'unknown',
        detail: adapterServerEgress === 'not-tested'
          ? '适配器服务端外联尚未在无外联部署中验证；留出回放通过不等于独立部署安全。'
          : '没有可用的适配器服务端外联证据。',
      }] : []),
    ],
    humanJourneys,
    suggestedLocalFiles: [
      { path: `workspace/${siteId}/runtime-adapter/index.mjs`, purpose: 'AI 生成的本地路由与状态实现草稿。', status: api.adapter.present ? 'observed_adapter_exists' : 'suggested', basis: api.adapter.present ? 'observed' : 'inferred' },
      { path: `workspace/${siteId}/runtime-adapter/manifest.json`, purpose: '适配器路由、会话和协议边界。', status: api.adapter.present ? 'observed_manifest_exists' : 'suggested', basis: api.adapter.present ? 'observed' : 'inferred' },
      { path: `workspace/${siteId}/backend-state-rules.json`, purpose: '记录状态转换、前置条件、回滚和副作用的 AI 草稿。', status: 'suggested', basis: 'inferred' },
      { path: `workspace/${siteId}/backend-checks.mjs`, purpose: '把旅程检查点转成可重复的本地验证。', status: 'suggested', basis: 'inferred' },
    ],
    testData: [
      { id: 'observed-contract', status: observed ? 'available' : 'missing', basis: observed ? 'observed' : 'unknown', source: api.contract.path ?? 'api-contract.json', detail: '只含脱敏接口形状、状态码、MIME 和 Schema 摘要。' },
      { id: 'independent-test-account', status: 'required', basis: 'unknown', source: 'human_authorized_test', detail: '需要独立、可回收的测试账号和明确授权范围。' },
      { id: 'state-transition-fixtures', status: 'required', basis: 'inferred', source: 'human_authorized_test', detail: '需要操作前/后状态、异常输入和清理方案；不能从观察型契约自动发明。' },
    ],
    verification: {
      commands: [
        `heimdall probe contract --site ${siteId}`,
        `heimdall probe adapter --site ${siteId} --include-api-bodies --force`,
        ...(observed ? [`heimdall backend scaffold ${siteId}`, 'npm start', 'npm run check'] : []),
        `heimdall site-assessment ${siteId} --json`,
      ],
      deterministicChecks: [
        { id: 'response-shape', status: observed ? 'observed' : 'blocked', basis: observed ? 'observed' : 'unknown', condition: '契约中的响应状态码、MIME 和脱敏 JSON 形状可被本地适配器复现。' },
        { id: 'adapter-holdout', status: validationStatus, basis: validationStatus === 'passed' ? 'verified' : 'unknown', condition: 'adapter-report.json 的留出集等价度达到阈值且无未验证项。' },
        { id: 'adapter-gap-ledger', status: gapLedger ? (gapLedger.summary.uniqueGaps ? 'open' : 'observed') : 'blocked', basis: gapLedger ? 'observed' : 'unknown', condition: '运行适配器并读取 /__heimdall/adapter-gaps，确认没有新的未声明路径或未覆盖查询参数。' },
        { id: 'backend-scaffold-check', status: api.scaffold?.check?.status ?? 'not_run', basis: api.scaffold?.check?.status && api.scaffold.check.status !== 'not_run' ? 'observed' : 'unknown', condition: '运行脚手架 npm run check，确认观察路由覆盖、状态码、MIME、响应结构和缺口账本都没有未完成项。' },
        { id: 'state-consistency', status: 'blocked', basis: 'unknown', condition: '同一业务流程中操作后再次读取/刷新仍保持预期状态。' },
        { id: 'offline-egress', status: adapterServerEgress === 'verified' ? 'passed' : 'blocked',
          basis: adapterServerEgress === 'verified' || adapterServerEgress === 'not-tested' ? 'observed' : 'unknown',
          condition: '最终适配器在无外联部署中通过断网浏览器验收。' },
      ],
      humanChecks: humanJourneys.map(journey => ({ id: journey.id, basis: journey.basis, requiresHumanApproval: true, condition: journey.goal })),
    },
    provenance: {
      observed: observed ? ['api-contract.json', ...(api.adapter.present ? ['runtime-adapter/manifest.json', 'adapter-report.json'] : [])] : [],
      inferred: ['B2 目标', '业务旅程清单', '本地状态规则文件', '检查脚本和测试数据需求'],
      invented: [],
    },
    limitations: [
      '观察到的接口形状不等于认证、权限、状态机、业务规则或真实副作用。',
      '建议文件只是任务包，不代表这些文件已经生成或通过验证。',
    ],
  };
}

function buildDeliveryPlan({ siteId, origin, clone, seo, api, qa, qaWorkspace }) {
  const items = [];
  const backendCompletion = buildBackendCompletionTask(siteId, api, clone.delivery);
  const add = (item) => items.push({
    evidence: [],
    ...(item.action ? { action: item.action } : {}),
    ...(item.verify ? { verify: item.verify } : {}),
    ...item,
  });
  const capture = origin
    ? plannedAction('heimdall_clone', { url: `${origin}/`, scope: 'site', level: 'verified' }, '先取得参考镜像并做多视口验证')
    : plannedAction('heimdall_clone', { siteId, scope: 'site', level: 'verified' }, '先取得参考镜像并做多视口验证');

  if (!clone.pages) {
    add({
      id: 'clone-capture', kind: 'page_asset_gap', basis: 'unknown', status: 'blocked',
      title: '没有页面目录，无法开始站点交付', detail: '当前没有已发现页面，镜像、资源和视觉证据都未知。',
      action: capture, verify: planVerification(siteId, 'clone.mirrors > 0'),
    });
  } else if (clone.mirrors < clone.pages) {
    add({
      id: 'clone-mirror-coverage', kind: 'page_asset_gap', basis: 'observed', status: 'open',
      title: '镜像覆盖不完整', detail: `${clone.pages - clone.mirrors} 页已发现但没有镜像入口。`,
      evidence: [`clone.mirrors:${clone.mirrors}/${clone.pages}`], action: capture,
      verify: planVerification(siteId, 'clone.mirrors === clone.pages'),
    });
  }
  if (clone.pages && (clone.unmeasured > 0 || clone.verificationStatus !== 'checked')) {
    add({
      id: 'clone-visual-verification', kind: 'visual_verification_gap', basis: 'unknown', status: 'open',
      title: '多视口验证不完整', detail: clone.unmeasured > 0
        ? `${clone.unmeasured} 页没有当前有效的多视口验证。`
        : `验证扫描状态为 ${clone.verificationStatus}。`,
      evidence: [`clone.verification:${clone.verificationStatus}`, `clone.unmeasured:${clone.unmeasured}`],
      action: plannedAction('heimdall_clone', { siteId, scope: 'site', level: 'verified' }, '补齐页面的当前多视口验证'),
      verify: planVerification(siteId, 'clone.unmeasured === 0 && clone.verificationStatus === "checked"'),
    });
  }

  if (clone.mirrors && clone.delivery.status !== 'passed') {
    const blocked = clone.delivery.status === 'blocked';
    add({
      id: 'clone-offline-delivery', kind: 'offline_delivery_gap', basis: clone.delivery.report ? 'observed' : 'unknown',
      status: blocked ? 'blocked' : 'open', title: blocked ? '最近严格离线交付被阻断' : '严格离线交付证据待补齐',
      detail: blocked ? `上次完成的导出有 ${clone.delivery.blockingCount} 个阻断计数；修复后须重新严格导出。`
        : '当前没有可用的严格离线通过记录；多视口测量只覆盖视觉证据。',
      evidence: [clone.delivery.report, clone.delivery.healthReport].filter(Boolean),
      action: plannedAction('cli:shell', { command: `heimdall live ${siteId} --offline --strict${clone.delivery.root === 'mirror' ? ' --root mirror' : ''}` },
        '按已审核的资源策略修复候选包 health.json 阻断，再用同一根路径严格导出', { canAutoRun: true, requiresHumanApproval: false }),
      verify: planVerification(siteId, 'rerun strict offline export for current inputs; clone.delivery.status === "passed"'),
    });
  }
  if (clone.delivery.browserFailures?.length) {
    const examples = clone.delivery.browserFailures.slice(0, 4).map(failure => {
      const target = failure.target ? ` ${failure.target}` : '';
      const reason = failure.message || failure.error || failure.kind;
      return `${failure.page ?? '/'}: ${failure.kind}${target} — ${reason}`;
    }).join('；');
    add({
      id: 'clone-browser-failures', kind: 'frontend_runtime_gap', basis: 'observed', status: 'blocked',
      title: '离线浏览器发现前端运行时错误',
      detail: `${clone.delivery.browserFailures.length} 条失败证据：${examples}`,
      evidence: [clone.delivery.healthReport].filter(Boolean),
      action: plannedAction('cli:shell', {
        command: `heimdall live ${siteId} --offline --strict${clone.delivery.root === 'mirror' ? ' --root mirror' : ''}`,
      }, '修复候选页面运行时错误后重新严格导出和复测', { requiresHumanApproval: true }),
      verify: planVerification(siteId, 'clone.delivery.browserFailures.length === 0'),
    });
  }
  if (clone.delivery.binaryDownloadGaps?.length) {
    const examples = clone.delivery.binaryDownloadGaps.slice(0, 5).map(gap => gap.path).join('、');
    add({
      id: 'clone-binary-downloads', kind: 'binary_distribution_gap', basis: 'observed', status: 'blocked',
      title: '存在未覆盖的二进制下载链接',
      detail: `${clone.delivery.binaryDownloadGaps.length} 个候选下载链接未进入离线交付：${examples}。授权后将路径加入 read-data-plan.json 的 binaryPaths，并用 --include-readonly-data --include-readonly-binaries --offline --strict 复测；二进制正文仍需人工审核，--compare-source 不证明二进制源站对照。`,
      evidence: [clone.delivery.healthReport].filter(Boolean),
      verify: { method: 'human_authorized_binary_review', condition: '确认公开权限、内容安全和分发策略后，再用支持该类型的导出路径复测' },
    });
  }

  const seoIncomplete = seo.status === 'observed'
    && (seo.completeness.failedPages > 0 || seo.completeness.initialHtmlUnchecked > 0 || seo.geo.status !== 'complete');
  const seoHasIssues = seo.status === 'observed'
    && (seo.bySeverity.critical > 0 || seo.bySeverity.high > 0 || seo.geo.actionItems > 0);
  if (seo.status !== 'observed') {
    add({
      id: 'seo-report', kind: 'seo_geo_gap', basis: 'unknown', status: 'open',
      title: '没有可用的 SEO/GEO 报告', detail: seo.status === 'invalid' ? '报告存在但无法读取。' : '当前站点还没有本地 SEO/GEO 证据。',
      evidence: [], action: origin ? plannedAction('heimdall_seo_audit', { url: `${origin}/` }, '补一份 SEO/GEO 报告') : null,
      verify: planVerification(siteId, 'seo.status === "observed"'),
    });
  } else if (seoIncomplete || seoHasIssues) {
    add({
      id: 'seo-geo-follow-up', kind: 'seo_geo_gap', basis: 'observed', status: 'open',
      title: seoIncomplete ? 'SEO/GEO 采集不完整' : 'SEO/GEO 报告还有待处理项',
      detail: seoIncomplete
        ? '报告包含未成功采集或未核对页面，分数不能当成完整站点结论。'
        : `发现 critical=${seo.bySeverity.critical}、high=${seo.bySeverity.high}，GEO 待办 ${seo.geo.actionItems} 项。`,
      evidence: [seo.reports.json],
      action: origin ? plannedAction('heimdall_seo_audit', { url: `${origin}/` }, '补采完整报告并复核 SEO/GEO 待办') : null,
      verify: planVerification(siteId, 'seo.completeness.failedPages === 0 && seo.completeness.initialHtmlUnchecked === 0 && seo.geo.status === "complete" && seo.geo.actionItems === 0 && seo.bySeverity.critical === 0 && seo.bySeverity.high === 0'),
      repairTasks: [
        ...seo.repairCandidates.map(issue => seoRepairTask(issue, seo)),
        ...seo.geo.actionPlan.map(action => seoGeoRepairTask(action, seo)),
      ],
      repairTasksTruncated: seo.repairCandidatesMeta.truncated || seo.geo.actionPlanMeta.truncated,
    });
  }

  if (api.contract.status === 'missing' || api.contract.status === 'invalid' || api.contract.status === 'no_observed_api') {
    add({
      id: 'api-contract', kind: 'api_contract_gap', basis: 'unknown', status: 'open',
      title: 'API 契约证据不足', detail: api.contract.status === 'missing'
        ? '没有观察型 API 契约，后端边界和响应口径未知。'
        : '契约文件存在，但没有可用的端点观察摘要。',
      evidence: api.contract.path ? [api.contract.path] : [],
      action: plannedAction('cli:shell', { command: `heimdall probe contract --site ${siteId}` }, '先生成观察型 API 契约草稿', { requiresHumanApproval: false }),
      verify: planVerification(siteId, 'api.contract.status === "observed"'),
    });
  }
  if (api.contract.status === 'observed' && !api.adapter.present) {
    add({
      id: 'api-adapter', kind: 'b2_adapter_gap', basis: 'observed', status: 'open',
      title: '有 API 契约但没有观察回放适配器', detail: '可以开始生成适配器草稿，但它仍不能代表认证、权限、状态机或真实副作用。',
      evidence: [api.contract.path],
      action: plannedAction('cli:shell', { command: `heimdall probe adapter --site ${siteId} --include-api-bodies` }, '按观察样本生成适配器草稿', { requiresHumanApproval: false }),
      verify: planVerification(siteId, 'api.adapter.present === true && api.adapter.validation.status === "passed"'),
    });
  } else if (api.adapter.present && api.adapter.validation?.status !== 'passed') {
    add({
      id: 'api-adapter-validation', kind: 'b2_adapter_gap', basis: 'observed', status: 'open',
      title: '适配器还没有通过留出验证', detail: '当前适配器只能算已观察到，留出集未通过或未完成。',
      evidence: api.adapter.report ? [api.adapter.report] : [],
      action: plannedAction('cli:shell', { command: `heimdall probe adapter --site ${siteId} --include-api-bodies --force` }, '重新生成并验证观察回放适配器', { requiresHumanApproval: false }),
      verify: planVerification(siteId, 'api.adapter.validation.status === "passed"'),
    });
  }
  if (api.contract.status === 'observed' && api.scaffold?.present !== true) {
    const action = plannedAction('cli:shell', {
      command: `heimdall backend scaffold ${siteId}${api.scaffold?.status === 'incomplete' ? ' --force' : ''}`,
    }, '把观察型契约落成可启动的 B3 后端起点', { requiresHumanApproval: true });
    add({
      id: 'backend-scaffold', kind: 'b3_scaffold_gap', basis: 'observed', status: 'open',
      title: '还没有可启动的后端起点',
      detail: api.scaffold?.status === 'incomplete'
        ? '默认 B3 输出目录只有部分文件，需要确认后用 --force 补齐。'
        : '已有观察型 API 契约，可以先生成 B3 脚手架；它不会自动编造认证、权限或业务副作用。',
      evidence: [api.contract.path, api.scaffold?.path].filter(Boolean), action,
      verify: planVerification(siteId, 'api.scaffold.present === true'),
    });
  }
  if (api.scaffold?.present === true && api.scaffold.check?.status !== 'passed') {
    const check = api.scaffold.check;
    add({
      id: 'backend-scaffold-check', kind: 'b3_scaffold_gap', basis: check?.status === 'not_run' ? 'unknown' : 'observed', status: 'open',
      title: check?.status === 'not_run' ? '后端脚手架还没有跑本地检查' : '后端脚手架检查没有完成',
      detail: check?.status === 'not_run'
        ? '脚手架已经生成，但还没有运行 npm run check；当前不能确认路由覆盖、响应结构和缺口账本。'
        : `最近一次检查状态为 ${check?.status}，失败 ${check?.failed ?? 0} 项，未完成 ${check?.incomplete ?? 0} 项。${check?.repairTasks?.length ? ` 已生成 ${check.repairTasks.length} 个可执行修复任务。` : ''}`,
      evidence: [check?.path].filter(Boolean),
      action: plannedAction('cli:shell', { command: 'npm run check', cwd: `workspace/${siteId}/backend-scaffold` }, '运行脚手架自带的确定性检查并回写 backend-check.json', { requiresHumanApproval: true }),
      verify: planVerification(siteId, 'api.scaffold.check.status === "passed"'),
    });
  }
  if (api.adapter.gapLedger && (api.adapter.gapLedger.summary.uniqueGaps > 0
    || api.adapter.gapLedger.summary.missingResponseBodies > 0
    || api.adapter.gapLedger.summary.unverifiedWrites > 0)) {
    add({
      id: 'api-adapter-gap-ledger', kind: 'b2_adapter_gap', basis: 'observed', status: 'open',
      title: '适配器缺口账本还有待处理项',
      detail: `未声明/未覆盖请求 ${api.adapter.gapLedger.summary.uniqueGaps} 个；未观察查询变体 ${api.adapter.gapLedger.summary.unobservedQueryVariants ?? 0} 个；缺响应体 ${api.adapter.gapLedger.summary.missingResponseBodies} 条；未验证写入 ${api.adapter.gapLedger.summary.unverifiedWrites ?? 0} 条。`,
      evidence: [api.adapter.gapLedger.report].filter(Boolean),
      action: plannedAction('cli:shell', { command: `heimdall probe adapter --site ${siteId} --include-api-bodies --force` }, '按最新脱敏观察重新生成适配器，再复核缺口账本', { requiresHumanApproval: false }),
      verify: planVerification(siteId, 'api.adapter.gapLedger.summary.uniqueGaps === 0 && api.adapter.gapLedger.summary.missingResponseBodies === 0 && api.adapter.gapLedger.summary.unverifiedWrites === 0'),
    });
  }

  if (api.contract.status !== 'missing' || api.adapter.present) {
    add({
      id: 'api-behavior-unknown', kind: 'auth_permission_state_unknown', basis: 'unknown', status: 'blocked',
      title: '认证、权限、状态机和副作用仍未证明', detail: '观察型契约或适配器只说明捕获到的样本，不能证明真实用户权限、写入业务、持久化和状态转换。',
      evidence: [api.contract.path, api.adapter.report].filter(Boolean),
      verify: { method: 'human_authorized_test', condition: '用独立测试账号和明确许可的检查点验证认证、权限、状态机与副作用' },
    });
  }

  if (qa.status === 'not_configured' || qa.status === 'unavailable' || qa.status === 'configured') {
    add({
      id: 'qa-workspace', kind: 'qa_business_checkpoint_gap', basis: 'unknown', status: 'blocked',
      title: '没有可用的 QA 工作区', detail: '页面能否打开不等于业务流程和无参照物问题已经检查。',
      evidence: [], action: plannedAction('heimdall_qa_status', qaWorkspace ? { workspace: qaWorkspace } : null, '先准备 QA 工作区并读取测试须知'),
      verify: { tool: 'heimdall_qa_status', condition: 'workspace contains matching site and guidance' },
    });
  } else if (qa.status === 'no_runs') {
    add({
      id: 'qa-first-run', kind: 'qa_business_checkpoint_gap', basis: 'observed', status: 'open',
      title: 'QA 工作区还没有运行记录', detail: '当前没有巡检、检查点或无参照物检测结果。',
      evidence: [], action: plannedAction('heimdall_qa_run', { ...(qaWorkspace ? { workspace: qaWorkspace } : {}), site: qa.site?.name }, '运行一次只读 QA'),
      verify: { tool: 'heimdall_qa_run', condition: 'matching site has a completed run' },
    });
  } else if (qa.latest?.completeness?.status !== 'complete') {
    add({
      id: 'qa-incomplete', kind: 'qa_business_checkpoint_gap', basis: qa.latest?.completeness?.status === 'incomplete' ? 'observed' : 'unknown', status: 'blocked',
      title: 'QA 检查未完成或完整性证据不足', detail: '先核实环境、检查点、导航、检测器与基线证据；没有可提单问题不代表检查已完成。',
      evidence: [qa.latest?.report].filter(Boolean),
      action: plannedAction('heimdall_qa_run', { ...(qaWorkspace ? { workspace: qaWorkspace } : {}), site: qa.site?.name }, '修复未完成原因并重跑 QA'),
      verify: { tool: 'heimdall_qa_run', condition: 'matching run has complete QA evidence' },
    });
  }
  if (qa.latest?.summary?.fileable > 0) {
    add({
      id: 'qa-findings', kind: 'qa_business_checkpoint_gap', basis: 'observed', status: 'open',
      title: 'QA 有待人工复核的问题', detail: `最近一次运行有 ${qa.latest.summary.fileable} 条达到提单门槛的发现。`,
      evidence: [qa.latest.bugs, qa.latest.report].filter(Boolean),
      action: plannedAction('heimdall_qa_findings', { ...(qaWorkspace ? { workspace: qaWorkspace } : {}), action: 'show', runId: qa.latest.runId }, '逐条复核 QA 建议提单的问题'),
      verify: { tool: 'heimdall_qa_findings', condition: 'each finding has a human verdict' },
      repairTasks: qa.latest.findings.items.map(finding => qaRepairTask(finding, qa, qaWorkspace)),
    });
  }

  const counts = {
    total: items.length,
    open: items.filter(item => item.status === 'open').length,
    blocked: items.filter(item => item.status === 'blocked').length,
    unknown: items.filter(item => item.basis === 'unknown').length,
    canAutoRun: items.filter(item => item.action?.canAutoRun === true).length,
    requiresHumanApproval: items.filter(item => item.action?.requiresHumanApproval === true || item.status === 'blocked').length,
  };
  const nextStage = !clone.mirrors ? 'capture' : counts.blocked ? 'human_review' : counts.open ? 'ai_review_with_open_actions' : 'ready';
  return {
    schema: 'heimdall.site-delivery-plan/1',
    decision: {
      basis: 'inferred',
      stage: nextStage,
      reason: nextStage === 'capture' ? '先补齐参考镜像。' : nextStage === 'human_review' ? '存在尚未通过的交付门禁，或需要人工确认的业务与 QA 前置条件。' : counts.open ? '已有足够证据进入 AI 处理，但仍有明确的补证或复核动作。' : '现有摘要覆盖了已声明的交付能力，可进入实现或复测。',
    },
    counts,
    items,
    backendCompletion,
  };
}

function overallForStage(stage) {
  return {
    capture: 'needs_capture',
    human_review: 'needs_human_review',
    ai_review_with_open_actions: 'ready_for_ai_review',
    ready: 'ready',
  }[stage] ?? 'needs_human_review';
}

function buildReadiness({ clone, seo, api, qa, deliveryPlan }) {
  const item = (...ids) => ids.map(id => deliveryPlan.items.find(candidate => candidate.id === id)).find(Boolean);
  const entry = (status, basis, evidence, actionItem) => ({
    status, basis, evidence: evidence.filter(Boolean), nextAction: actionItem?.action ?? null,
  });
  const cloneComplete = clone.pages > 0 && clone.mirrors === clone.pages
    && clone.unmeasured === 0 && clone.verificationStatus === 'checked';
  const cloneStatus = !clone.pages || !clone.mirrors ? 'needs_capture' : cloneComplete ? 'ready' : 'needs_verification';
  const cloneItem = item('clone-capture', 'clone-mirror-coverage', 'clone-visual-verification');
  const seoComplete = seo.status === 'observed'
    && seo.completeness.failedPages === 0 && seo.completeness.initialHtmlUnchecked === 0
    && seo.bySeverity.critical === 0 && seo.bySeverity.high === 0 && seo.geo.status === 'complete' && seo.geo.actionItems === 0;
  const seoStatus = seo.status !== 'observed' ? 'needs_report' : seoComplete ? 'ready' : 'needs_follow_up';
  const seoItem = item('seo-report', 'seo-geo-follow-up');
  const geoStatus = seo.status !== 'observed' || seo.geo.status === 'unknown' ? 'needs_report'
    : seo.geo.status !== 'complete' || seo.geo.actionItems ? 'needs_follow_up' : 'ready';
  const backendObserved = api.contract.status !== 'missing' || api.adapter.present;
  const backendItem = item('api-contract', 'api-adapter', 'backend-scaffold', 'backend-scaffold-check', 'api-adapter-validation', 'api-adapter-gap-ledger', 'api-behavior-unknown');
  const qaItem = item('qa-workspace', 'qa-first-run', 'qa-incomplete', 'qa-findings');
  const qaReady = qa.status === 'observed' && qa.latest?.completeness?.status === 'complete' && qa.latest.summary.fileable === 0;
  return {
    schema: 'heimdall.site-readiness/1',
    stage: deliveryPlan.decision.stage,
    overall: overallForStage(deliveryPlan.decision.stage),
    clone: entry(cloneStatus, cloneStatus === 'ready' ? 'verified' : clone.pages || clone.mirrors ? 'observed' : 'unknown',
      [`clone.mirrors:${clone.mirrors}/${clone.pages}`, `clone.verification:${clone.verificationStatus}`], cloneItem),
    delivery: entry(clone.delivery.status === 'passed' ? 'last_check_passed'
      : clone.delivery.status === 'blocked' ? 'blocked' : clone.delivery.status === 'unverified' ? 'needs_strict_verification' : 'needs_export',
      clone.delivery.report ? 'observed' : 'unknown', [clone.delivery.report, clone.delivery.healthReport], item('clone-offline-delivery')),
    seo: entry(seoStatus, seo.status === 'observed' ? 'observed' : 'unknown', [seo.reports?.json], seoItem),
    geo: entry(geoStatus, seo.status === 'observed' && seo.geo.status !== 'unknown' ? 'observed' : 'unknown', [seo.reports?.json], seoItem),
    backend: entry(backendObserved ? 'needs_human_review' : 'needs_observation', backendObserved ? 'observed' : 'unknown',
      [api.contract.path, api.adapter.report, api.scaffold?.path], backendItem),
    qa: entry(qaReady ? 'ready' : qa.status === 'no_runs' ? 'needs_run' : 'needs_human_review',
      qa.status === 'observed' || qa.status === 'no_runs' ? 'observed' : 'unknown',
      [qa.latest?.report, qa.latest?.bugs], qaItem),
  };
}

export default {
  id: 'site_assessment',
  title: '站点评估：证据、能力与下一步',
  description: 'Read one site workspace and return a conservative assessment for an AI agent: clone coverage and multi-viewport evidence, the latest SEO/GEO report, public API contract and replay-adapter validation, an optional QA workspace run with derived coverage/runtime/failure metrics, and a structured delivery plan. It reads only sanitized public summaries; it never reads raw HAR, sessions, operation plans or adapter source. Verified, observed, inferred and unknown claims stay separate. Read-only and works without the engine.',
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
    const unavailableScores = clone.mirrors - clone.scoreStatuses.verified;
    if (unavailableScores > 0) unknowns.push({ id: 'clone-score-not-current', detail: `${unavailableScores} 页没有当前克隆输入的已核实单页辅助分数，当前平均分已排除。` });
    if (clone.delivery.status !== 'passed') unknowns.push({ id: 'offline-delivery-' + clone.delivery.status,
      detail: '严格离线交付尚未通过；旧版本缺少结果记录时须重新导出。' });
    if (seo.status === 'missing') unknowns.push({ id: 'seo-report-missing', detail: '没有本地 SEO/GEO 报告。' });
    if (seo.status === 'invalid') unknowns.push({ id: 'seo-report-invalid', detail: 'SEO 报告存在但无法读取。' });
    if (seo.status === 'observed' && (seo.completeness.failedPages > 0 || seo.completeness.initialHtmlUnchecked > 0)) {
      unknowns.push({ id: 'seo-collection-incomplete', detail: 'SEO 报告包含未成功采集或未核对页面。' });
    }
    for (const id of api.unknowns) unknowns.push({ id, detail: 'API 行为、认证、权限、状态机或副作用仍未被该摘要证明。' });
    if (qa.status === 'not_configured') unknowns.push({ id: 'qa-not-configured', detail: '没有提供 QA 工作区，最近一次 QA 运行未知。' });
    if (qa.status === 'no_runs') unknowns.push({ id: 'qa-not-run', detail: 'QA 工作区存在，但还没有匹配站点的运行记录。' });
    if (qa.status === 'unavailable') unknowns.push({ id: 'qa-workspace-unavailable', detail: '提供的 QA 工作区无法读取。' });
    if (qa.status === 'observed' && qa.latest.completeness.status !== 'complete') {
      unknowns.push({ id: 'qa-run-incomplete', detail: '最近一次 QA 运行存在未完成检查，或缺少完整性证据。' });
    }
    const deliveryPlan = buildDeliveryPlan({ siteId: args.siteId, origin, clone, seo, api, qa, qaWorkspace: args.qaWorkspace });
    const readiness = buildReadiness({ clone, seo, api, qa, deliveryPlan });
    const overall = readiness.overall;
    const nextActions = deliveryPlan.items
      .filter(item => item.action)
      .map(item => nextAction(item.action.tool, item.action.args, item.action.reason))
      .slice(0, 5);
    const evidence = [];
    if (seo.status === 'observed') evidence.push({ kind: 'file', path: seo.reports.json });
    if (api.contract.path) evidence.push({ kind: 'file', path: api.contract.path });
    if (api.adapter.report) evidence.push({ kind: 'file', path: api.adapter.report });
    if (clone.delivery.report) evidence.push({ kind: 'file', path: clone.delivery.report });
    return ok({ siteId: args.siteId, origin, overall, readiness, clone: { ...clone, samplePages: clone.samplePages.slice(0, args.limit) }, seo, api, qa,
      deliveryPlan, claims: claimsOf(args.siteId, clone, seo, api, qa, unknowns), unknowns }, {
      summary: `${args.siteId}：${clone.mirrors}/${clone.pages} 页有镜像；多视口验证 ${clone.verified ?? 0} 页；离线交付 ${clone.delivery.status}；SEO ${seo.status}；API ${api.status}；QA ${qa.status}。`,
      nextActions: nextActions.slice(0, 5), evidence,
    });
  },
};
