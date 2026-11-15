/**
 * capability: site_assessment -- one conservative status package for a site.
 *
 * It reads only public summaries already written by Heimdall. Raw HAR files,
 * sessions, operation plans and adapter modules are never opened here.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { DATA_ROOT } from '../../../paths.mjs';
import { measurementCoverage, scanMeasurementsAsync } from '../../../verify/measurement-status.mjs';
import { summarizeObservedApiContract } from '../../../live/contract.mjs';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { redactText } from '../../redact.mjs';
import { summarizeGeoReport } from '../../geo-summary.mjs';
import { qaFindingDigest, safeSummaryText } from '../../qa-finding-summary.mjs';
import { listPages, pageDir, siteDir } from '../../workspace.mjs';
import { listRuns, openWorkspace, relPath, runsDir } from '../../../qa/run.mjs';
import { analyzeQaMetrics } from '../../../qa/metrics.mjs';
import { qaMetricsDecisionTask } from './qa-metrics.mjs';
import { qaIncompleteReasons } from '../../../qa/ci.mjs';
import { readCurrentScore } from '../../../score-status.mjs';
import { validateDeploymentReport, validateStaticDeploymentReport, verifyBundleChecksums } from '../../../live/deployment-verify.mjs';
import { SEO_MEASUREMENT_VERSION, SEO_SCORE_METHOD_VERSION } from '../../../seo/method.mjs';
import { summarizeOutcomeEvidence } from '../../../seo/outcome-evidence.mjs';

const MAX_PUBLIC_REPORT_BYTES = 4 * 1024 * 1024;
const MAX_BACKEND_TASK_ENDPOINTS = 200;
const SEO_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const BROWSER_FAILURE_KINDS = new Set(['http', 'pageError', 'navigation', 'requestFailed', 'externalRequest', 'websocketUnsupported', 'observationDeadline', 'pageCrash', 'probeError']);
const BROWSER_RESOURCE_TYPES = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'eventsource', 'websocket', 'manifest', 'other']);
const BINARY_DOWNLOAD_PATH = /\.(?:db|sqlite3?|zip|tar|tgz|gz|bz2|xz|7z|rar|pdf|doc|docx|xls|xlsx|ppt|pptx|odt|ods|odp)(?:$|[?#])/i;
const SITEMAP_REASONS = new Set(['budget-exhausted', 'time-limit', 'total-byte-limit', 'cross-origin-sitemap', 'robots-unavailable', 'sitemap-request-failed', 'unknown-sitemap-format', 'depth-limit', 'file-limit', 'url-limit', 'document-byte-limit']);
const CLONE_TASK_ITEM_IDS = new Set(['clone-capture', 'clone-mirror-coverage', 'clone-visual-verification', 'clone-offline-delivery', 'clone-scope-limited', 'clone-page-complexity', 'clone-external-runtime', 'clone-browser-failures', 'clone-runtime-data-gaps', 'clone-binary-downloads', 'independent-deployment']);
const DEPLOYMENT_ATTEMPT_SCHEMA = 'heimdall.deployment-verification-attempt/1';

function readJson(file) {
  try {
    if (statSync(file).size > MAX_PUBLIC_REPORT_BYTES) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

function methodStatus(value, current) {
  if (!Number.isSafeInteger(value)) return 'unknown';
  return value === current ? 'current' : value < current ? 'stale' : 'future';
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
  const rawKnownRoutes = Array.isArray(source.knownRoutes) ? source.knownRoutes : [];
  const rawGaps = Array.isArray(source.gaps) ? source.gaps : [];
  const rawUnknowns = Array.isArray(source.unknowns) ? source.unknowns : [];
  const knownRoutes = rawKnownRoutes.slice(0, MAX_BACKEND_TASK_ENDPOINTS).map(safeRoute).filter(Boolean);
  const gaps = rawGaps.slice(0, 50).map(item => ({
    method: String(item.method ?? '').toUpperCase().slice(0, 10), path: safePath(item.path), queryParams: safeNames(item.queryParams),
    count: Number(item.count ?? 0), categories: safeLabels(item.categories),
    nearestRoutes: Array.isArray(item.nearestRoutes) ? item.nearestRoutes.slice(0, 3).map(safeRoute).filter(Boolean) : [],
  }));
  const unknowns = safeLabels(rawUnknowns);
  return {
    schema: 'heimdall.adapter-gap-ledger/1', source: source.source ?? 'unknown', status: source.status ?? 'unknown',
    summary: Object.fromEntries(['runtimeRequests', 'uniqueGaps', 'unobservedPaths', 'unobservedQueryVariants', 'uncoveredQueryParameters', 'missingResponseBodies', 'unverifiedWrites']
      .map(key => [key, Number(summary[key] ?? 0)])),
    knownRoutes,
    knownRoutesMeta: { total: rawKnownRoutes.length, returned: knownRoutes.length, truncated: rawKnownRoutes.length > MAX_BACKEND_TASK_ENDPOINTS },
    gaps,
    gapsMeta: { total: rawGaps.length, returned: gaps.length, truncated: rawGaps.length > 50 },
    unknowns,
    unknownsMeta: { total: rawUnknowns.length, returned: unknowns.length, truncated: rawUnknowns.length > 10 },
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

function readHealthReport(root, report) {
  if (!report) return null;
  return readJson(join(DATA_ROOT, report)) ?? readJson(join(root, report));
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

function safeRuntimeDataGap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.target !== 'string' || !value.target.startsWith('/')
    || !['xhr', 'fetch'].includes(value.resourceType)
    || !['http', 'requestFailed'].includes(value.failureKind)) return null;
  const result = {
    page: typeof value.page === 'string' ? safeSummaryText(value.page, 240) : '/',
    target: safeSummaryText(value.target, 240), resourceType: value.resourceType, failureKind: value.failureKind,
  };
  if (Number.isInteger(value.status) && value.status >= 0) result.status = value.status;
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

function sitemapSummary(report) {
  const source = report?.sitemap;
  if (!source || typeof source !== 'object') return null;
  const stats = source.stats && typeof source.stats === 'object' ? source.stats : {};
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const safeReasons = value => Array.isArray(value)
    ? [...new Set(value.filter(item => typeof item === 'string' && SITEMAP_REASONS.has(item)))].slice(0, 10)
    : [];
  return {
    coverage: ['complete', 'not_found', 'partial', 'unavailable'].includes(source.coverage) ? source.coverage : null,
    reasons: safeReasons(source.reasons),
    truncated: safeReasons(stats.truncated),
    stats: {
      urlCount: integer(stats.urlCount),
      filesAttempted: integer(stats.sitemapFilesAttempted),
      filesRead: integer(stats.sitemapFilesRead),
      filesFailed: integer(stats.sitemapFilesFailed),
      maxUrls: integer(stats.limits?.maxUrls),
      maxFiles: integer(stats.limits?.maxFiles),
    },
  };
}

function gradeOf(score) {
  return typeof score === 'number' ? (score >= 90 ? 'A' : score >= 75 ? 'B' : 'C') : null;
}

function safeSeoIssuePath(value) {
  try { return new URL(String(value), 'http://seo.local').pathname.slice(0, 240); }
  catch { return safeSummaryText(value, 240); }
}

function seoRepairCandidates(report, severities = ['critical', 'high']) {
  const groups = new Map();
  const allowed = new Set(severities);
  const add = (issue, page = null) => {
    if (!issue || !allowed.has(issue.severity) || typeof issue.id !== 'string') return;
    const current = groups.get(issue.id) ?? {
      id: issue.id.slice(0, 96), category: safeSummaryText(issue.category, 48), severity: issue.severity,
      title: safeSummaryText(issue.title, 240), suggestion: safeSummaryText(issue.suggestion, 360),
      affectedPages: 0, pages: [],
    };
    if (issue.severity === 'critical') current.severity = 'critical';
    const issuePages = [...new Set(page ? [page] : Array.isArray(issue.pages) ? issue.pages : [])];
    for (const issuePage of issuePages) {
      current.affectedPages++;
      const path = safeSeoIssuePath(issuePage);
      if (current.pages.length < 20 && !current.pages.includes(path)) current.pages.push(path);
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
  const safeOperationProbe = value => {
    if (value === undefined || value === null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' };
    const count = key => Number.isSafeInteger(value[key]) && value[key] >= 0 ? value[key] : null;
    const planned = count('planned');
    const checked = count('checked');
    const failed = count('failed');
    const untested = count('untested');
    const valid = value.scope === 'final-image-filesystem'
      && /^[a-f0-9]{64}$/i.test(value.planSha256 ?? '')
      && planned !== null && checked !== null && failed !== null && untested !== null;
    if (!valid) return { status: 'invalid' };
    return {
      status: checked === planned && failed === 0 && untested === 0 ? 'passed' : 'blocked',
      scope: value.scope, planSha256: value.planSha256,
      planned, checked, failed, untested,
      passedFlows: count('passedFlows'),
    };
  };
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
    operationProbe: safeOperationProbe(source.checks?.operationProbe),
  };
}

function staticDeploymentVerification(root, siteId) {
  const report = reportPath(siteId, 'deployment-verification.json');
  const file = join(root, 'deployment-verification.json');
  if (!existsSync(file)) return null;
  const source = readJson(file);
  const dataRoot = resolve(root, '..', '..');
  const bundle = typeof source?.bundle === 'string' ? source.bundle : '';
  const bundlePath = resolve(dataRoot, bundle);
  const bundleRel = relative(dataRoot, bundlePath).replaceAll('\\', '/');
  if (!bundle || bundleRel !== bundle || !bundleRel.startsWith('deliverable/')) return { status: 'invalid', report };
  let checksumsSha256 = null;
  try { checksumsSha256 = verifyBundleChecksums(bundlePath); }
  catch { return { status: 'invalid', report }; }
  if (!validateStaticDeploymentReport(source, { siteId, checksumsSha256 })) return { status: 'invalid', report };
  return {
    status: 'verified', report, generatedAt: source.generatedAt,
    bundle: bundleRel, bundleChecksumsSha256: checksumsSha256,
    routes: source.checks?.routes ?? null, docker: source.docker ?? null,
    browserProbe: source.checks?.browserProbe ?? null,
  };
}

function readDeploymentVerificationAttempt(root, siteId) {
  const candidates = [
    { file: join(root, 'deployment-verification-attempt.json'), report: reportPath(siteId, 'deployment-verification-attempt.json'), mode: 'static' },
    { file: join(root, 'adapter-egress-verification-attempt.json'), report: reportPath(siteId, 'adapter-egress-verification-attempt.json'), mode: 'adapter' },
  ];
  const records = candidates.filter(item => existsSync(item.file)).map(item => {
    const source = readJson(item.file);
    const invalid = { status: 'invalid', report: item.report, mode: item.mode };
    if (source?.schema !== DEPLOYMENT_ATTEMPT_SCHEMA || source.siteId !== siteId
      || source.mode !== item.mode || !['failed', 'incomplete', 'unavailable', 'invalid'].includes(source.status)
      || typeof source.generatedAt !== 'string' || !Number.isFinite(Date.parse(source.generatedAt))) return invalid;
    const dataRoot = resolve(root, '..', '..');
    const bundle = typeof source.bundle === 'string' ? source.bundle : null;
    const bundlePath = bundle ? resolve(dataRoot, bundle) : null;
    const bundleRel = bundlePath ? relative(dataRoot, bundlePath).replaceAll('\\', '/') : null;
    if (bundle && (bundleRel !== bundle || !bundle.startsWith('deliverable/'))) return invalid;
    let bundleCurrent = null;
    if (bundlePath && /^[a-f0-9]{64}$/i.test(source.bundleChecksumsSha256 ?? '')) {
      try { bundleCurrent = verifyBundleChecksums(bundlePath) === source.bundleChecksumsSha256; } catch { bundleCurrent = false; }
    }
    const count = key => Number.isSafeInteger(source.browserProbe?.[key]) && source.browserProbe[key] >= 0 ? source.browserProbe[key] : null;
    const causes = typeof source.browserProbe?.causes === 'string'
      && /^[A-Za-z0-9_.:@×、…,-]{1,240}$/.test(source.browserProbe.causes) ? source.browserProbe.causes : null;
    const browserProbe = source.browserProbe && typeof source.browserProbe === 'object' ? {
      checked: count('checked'), failed: count('failed'), untested: count('untested'),
      truncated: source.browserProbe.truncated === true, failureCount: count('failureCount'),
      ...(causes ? { causes } : {}),
    } : null;
    return {
      status: source.status, mode: item.mode, report: item.report, generatedAt: source.generatedAt,
      stage: typeof source.stage === 'string' ? source.stage.slice(0, 32) : 'unknown',
      errorCode: typeof source.error?.code === 'string' ? source.error.code.slice(0, 32) : 'failed',
      ...(source.phase === 'beforeRestart' || source.phase === 'afterRestart' ? { phase: source.phase } : {}),
      ...(bundle ? { bundle: bundleRel, bundleChecksumsSha256: source.bundleChecksumsSha256, bundleCurrent } : {}),
      ...(browserProbe ? { browserProbe } : {}),
    };
  });
  return records.sort((a, b) => (Date.parse(b.generatedAt ?? '') || 0) - (Date.parse(a.generatedAt ?? '') || 0))[0] ?? null;
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
  const health = readHealthReport(root, healthReport);
  const browserFailures = Array.isArray(health?.browserProbe?.failures)
    ? health.browserProbe.failures.slice(0, 50).map(safeBrowserFailure).filter(Boolean) : [];
  const runtimeDataGaps = Array.isArray(health?.runtimeDataGaps)
    ? health.runtimeDataGaps.slice(0, 100).map(safeRuntimeDataGap).filter(Boolean) : [];
  const rawCapabilities = health?.browserProbe?.capabilities;
  const browserCapabilities = rawCapabilities && typeof rawCapabilities === 'object' && !Array.isArray(rawCapabilities)
    && Number.isSafeInteger(rawCapabilities.pagesObserved) && rawCapabilities.pagesObserved >= 0
    && Number.isSafeInteger(rawCapabilities.signalPages) && rawCapabilities.signalPages >= 0
    && rawCapabilities.totals && typeof rawCapabilities.totals === 'object' && !Array.isArray(rawCapabilities.totals)
    ? {
      pagesObserved: rawCapabilities.pagesObserved,
      signalPages: rawCapabilities.signalPages,
      pagesTruncated: rawCapabilities.pagesTruncated === true || (Array.isArray(rawCapabilities.pages) && rawCapabilities.pages.length > 50),
      totals: Object.fromEntries(['iframes', 'externalIframes', 'shadowRoots', 'canvases', 'tallPages']
        .map(key => [key, Number.isSafeInteger(rawCapabilities.totals[key]) && rawCapabilities.totals[key] >= 0 ? rawCapabilities.totals[key] : 0])),
      pages: Array.isArray(rawCapabilities.pages) ? rawCapabilities.pages.slice(0, 50).map(item => {
        if (!item || typeof item !== 'object' || typeof item.page !== 'string') return null;
        const page = redactText(item.page, { profile: 'strict' }).text.slice(0, 240);
        if (!page.startsWith('/')) return null;
        return { page, ...Object.fromEntries(['iframeCount', 'externalIframeCount', 'shadowRootCount', 'canvasCount']
          .filter(key => Number.isSafeInteger(item[key]) && item[key] > 0).map(key => [key, item[key]])),
          ...(item.tallPage === true ? { tallPage: true } : {}) };
      }).filter(Boolean) : [],
    } : null;
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
  const deploymentVerification = staticDeploymentVerification(root, siteId);
  const deploymentVerificationAttempt = readDeploymentVerificationAttempt(root, siteId);
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
  const browserCapabilitySupport = browserCapabilities
    ? classifyBrowserCapabilitySupport(browserCapabilities, browserFailures, runtimeDataGaps) : null;
  return {
    status: source.status, generatedAt: new Date(source.generatedAt).toISOString(), report, healthReport,
    offline: source.offline, strict: source.strict, root: source.root === 'mirror' ? 'mirror' : 'landing',
    published: source.published, pages: source.pages, adapter, adapterEgressVerification: egressVerification,
    deploymentVerification, deploymentVerificationAttempt,
    blockingCount: source.blockingCount, blockers,
    otherBlockers: source.blockingCount - Object.values(blockers).reduce((sum, value) => sum + value, 0),
    browser, browserFailures, ...(browserCapabilities ? {
      browserCapabilities: { ...browserCapabilities, ...(browserCapabilitySupport ? { support: browserCapabilitySupport } : {}) },
    } : {}), runtimeDataGaps,
    ...(health?.runtimeDataGapsTruncated === true ? { runtimeDataGapsTruncated: true } : {}),
    binaryDownloadGaps, readOnlyData, coverage: {
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
  const verificationGapItems = scan.status === 'ok'
    ? scan.pages.filter(row => row.status !== 'verified').map(row => ({ page: row.page, status: row.status }))
    : [];
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
    verificationGaps: {
      status: scan.status,
      total: scan.status === 'ok' ? verificationGapItems.length : null,
      items: verificationGapItems.slice(0, 50),
      truncated: verificationGapItems.length > 50,
    },
    delivery: liveExportSummary(siteDir(siteId), siteId),
    samplePages: mirrors.slice(0, 10),
  };
}

function seoSummary(siteId, root, expectedOrigin) {
  const file = join(root, 'seo', 'seo.json');
  if (!existsSync(file)) return { status: 'missing', report: null };
  const report = readJson(file);
  const reportPathname = reportPath(siteId, 'seo/seo.json');
  if (!report || typeof report !== 'object') return { status: 'invalid', report: reportPathname };
  const reportOrigin = originOf(report.origin);
  if (expectedOrigin === null) {
    return { status: 'invalid', report: reportPathname, reason: 'origin_ambiguous' };
  }
  if (expectedOrigin && reportOrigin && reportOrigin !== expectedOrigin) {
    return { status: 'invalid', report: reportPathname, reason: 'origin_mismatch' };
  }
  const repairCandidates = seoRepairCandidates(report);
  const advisoryCandidates = seoRepairCandidates(report, ['medium']);
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
    origin: reportOrigin,
    score: typeof report.score === 'number' ? report.score : null,
    grade: gradeOf(report.score),
    scoreMethodVersion: Number.isSafeInteger(report.scoreMethodVersion) ? report.scoreMethodVersion : null,
    measurementVersion: Number.isSafeInteger(report.measurementVersion) ? report.measurementVersion : null,
    scoreMethodStatus: methodStatus(report.scoreMethodVersion, SEO_SCORE_METHOD_VERSION),
    measurementStatus: methodStatus(report.measurementVersion, SEO_MEASUREMENT_VERSION),
    pages: typeof summary.pages === 'number' ? summary.pages : null,
    issues: typeof summary.issues === 'number' ? summary.issues : null,
    bySeverity,
    categories,
    geo: summarizeGeoReport(report.geo),
    outcomeEvidence: summarizeOutcomeEvidence(root, siteId, expectedOrigin),
    sitemap: sitemapSummary(report),
    repairCandidates: repairCandidates.items,
    repairCandidatesMeta: { total: repairCandidates.total, returned: repairCandidates.items.length, truncated: repairCandidates.truncated },
    advisoryCandidates: advisoryCandidates.items,
    advisoryCandidatesMeta: { total: advisoryCandidates.total, returned: advisoryCandidates.items.length, truncated: advisoryCandidates.truncated },
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

function publicContract(root, siteId, expectedOrigin) {
  const candidates = ['api-contract.json', 'deliver/api-contract.json', 'deliverable/api-contract.json'];
  for (const suffix of candidates) {
    const file = join(root, suffix);
    if (!existsSync(file)) continue;
    const contract = readJson(file);
    if (!contract || typeof contract !== 'object') return { status: 'invalid', path: reportPath(siteId, suffix) };
    const summary = summarizeObservedApiContract(contract);
    const origin = originOf(contract.origin) ?? originOf(contract.openapi?.servers?.[0]?.url);
    if (expectedOrigin === null) {
      return { status: 'invalid', path: reportPath(siteId, suffix), origin: null, reason: 'origin_ambiguous', summary: null, observedEndpoints: [] };
    }
    if (expectedOrigin && origin && origin !== expectedOrigin) {
      return { status: 'invalid', path: reportPath(siteId, suffix), origin: null, reason: 'origin_mismatch', summary: null, observedEndpoints: [] };
    }
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
  const taskFile = join(dir, 'backend-task.json');
  const taskReport = existsSync(taskFile) ? readJson(taskFile) : null;
  const aiTask = {
    status: taskReport?.schema === 'heimdall.backend-ai-task/1' ? 'present' : existsSync(taskFile) ? 'invalid' : 'missing',
    schema: typeof taskReport?.schema === 'string' ? taskReport.schema : null,
    taskStatus: typeof taskReport?.status === 'string' ? taskReport.status : null,
    path: existsSync(taskFile) ? reportPath(siteId, 'backend-scaffold/backend-task.json') : null,
  };
  const checkFile = join(dir, 'backend-check.json');
  const checkReport = existsSync(checkFile) ? readJson(checkFile) : null;
  const checkResults = Array.isArray(checkReport?.results) ? checkReport.results : [];
  const checkStatus = ['passed', 'incomplete', 'failed'].includes(checkReport?.overall) ? checkReport.overall : checkReport ? 'invalid' : 'not_run';
  const checkMode = checkReport?.mode === 'business-rules-only' ? 'business-rules-only' : 'scaffold';
  const businessRuleResults = checkResults.filter(item => item?.id === 'business-rules' || String(item?.id ?? '').startsWith('business-rule:'));
  const actorLabel = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value : null;
  const actorRows = new Map();
  for (const item of businessRuleResults) {
    if (!String(item?.id ?? '').startsWith('business-rule:')) continue;
    const actor = actorLabel(item?.actor);
    if (!actor) continue;
    const rows = actorRows.get(actor) ?? [];
    rows.push(item);
    actorRows.set(actor, rows);
  }
  const actors = [...actorRows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([actor, rows]) => {
    const passed = rows.filter(item => item?.status === 'passed').length;
    const failed = rows.filter(item => item?.status === 'failed').length;
    const incomplete = rows.filter(item => ['incomplete', 'skipped'].includes(item?.status)).length;
    return { actor, total: rows.length, passed, failed, incomplete,
      status: failed ? 'failed' : incomplete ? 'incomplete' : 'passed' };
  });
  const businessRules = {
    mode: checkMode,
    status: !businessRuleResults.length ? 'not-tested'
      : businessRuleResults.some(item => item?.status === 'failed') ? 'failed'
        : businessRuleResults.some(item => ['incomplete', 'skipped'].includes(item?.status)) ? 'incomplete' : 'passed',
    total: businessRuleResults.filter(item => String(item?.id ?? '').startsWith('business-rule:')).length,
    passed: businessRuleResults.filter(item => item?.status === 'passed').length,
    failed: businessRuleResults.filter(item => item?.status === 'failed').length,
    incomplete: businessRuleResults.filter(item => ['incomplete', 'skipped'].includes(item?.status)).length,
    actors,
  };
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
      for (const key of ['httpStatus', 'missingObservedRoutes', 'schemaPath', 'actualMimeType', 'uniqueGaps', 'unobservedQueryVariants', 'uncoveredQueryParameters', 'unverifiedWrites', 'reason', 'pointer', 'ruleId', 'sourceStatus', 'candidateStatus']) {
        const source = task.evidence[key];
        if (typeof source === 'string') evidence[key] = source.slice(0, 128);
        else if (Number.isFinite(Number(source))) evidence[key] = Number(source);
      }
      for (const key of ['actor', 'sourceActor', 'candidateActor']) {
        if (actorLabel(task.evidence[key])) evidence[key] = actorLabel(task.evidence[key]).slice(0, 64);
      }
      if (Number.isInteger(task.evidence.step) && task.evidence.step > 0) evidence.step = task.evidence.step;
      for (const key of ['expectedStatuses', 'expectedMimeTypes']) {
        if (Array.isArray(task.evidence[key])) evidence[key] = task.evidence[key].slice(0, 30).map(item => String(item).slice(0, 128));
      }
      if (Object.keys(evidence).length) value.evidence = evidence;
    }
    return value;
  };
  const issueCandidates = checkResults.filter(item => ['failed', 'incomplete', 'not_implemented', 'skipped'].includes(item?.status));
  const issueRows = issueCandidates.slice(0, 50).map(item => {
    const repairTask = safeRepairTask(item?.repairTask);
    return {
      id: typeof item?.id === 'string' ? item.id.slice(0, 128) : 'unknown',
      status: typeof item?.status === 'string' ? item.status.slice(0, 32) : 'unknown',
      ...(typeof item?.reason === 'string' ? { reason: item.reason.slice(0, 256) } : {}),
      ...(actorLabel(item?.actor) ? { actor: actorLabel(item.actor) } : {}),
      ...(Number.isInteger(item?.httpStatus) ? { httpStatus: item.httpStatus } : {}),
      ...(Number.isInteger(item?.step) && item.step > 0 ? { step: item.step } : {}),
      ...(typeof item?.pointer === 'string' ? { pointer: item.pointer.slice(0, 128) } : {}),
      ...(Number.isFinite(Number(item?.uniqueGaps)) ? { uniqueGaps: Number(item.uniqueGaps) } : {}),
      ...(Number.isFinite(Number(item?.uncoveredQueryParameters)) ? { uncoveredQueryParameters: Number(item.uncoveredQueryParameters) } : {}),
      ...(Number.isFinite(Number(item?.unverifiedWrites)) ? { unverifiedWrites: Number(item.unverifiedWrites) } : {}),
      ...(typeof item?.schemaError?.path === 'string' ? { schemaPath: item.schemaError.path.slice(0, 128) } : {}),
      ...(repairTask ? { repairTask } : {}),
    };
  });
  const repairTasks = issueCandidates.map(item => safeRepairTask(item?.repairTask)).filter(Boolean);
  const check = {
    status: checkStatus,
    mode: checkMode,
    overall: checkStatus === 'invalid' || checkStatus === 'not_run' ? null : checkStatus,
    generatedAt: typeof checkReport?.generatedAt === 'string' ? checkReport.generatedAt : null,
    resultCount: checkResults.length,
    failed: checkResults.filter(item => item?.status === 'failed').length,
    incomplete: checkResults.filter(item => ['incomplete', 'not_implemented', 'skipped'].includes(item?.status)).length,
    businessRules,
    issuesMeta: { total: issueCandidates.length, returned: issueRows.length, truncated: issueCandidates.length > 50 },
    issues: issueRows,
    repairTasks: repairTasks.slice(0, 50),
    repairTasksMeta: { total: repairTasks.length, returned: Math.min(repairTasks.length, 50), truncated: repairTasks.length > 50 },
    path: existsSync(checkFile) ? reportPath(siteId, 'backend-scaffold/backend-check.json') : null,
  };
  const comparisonFile = join(dir, 'backend-compare.json');
  const comparisonReport = existsSync(comparisonFile) ? readJson(comparisonFile) : null;
  const comparisonValid = comparisonReport?.schema === 'heimdall.backend-comparison/1'
    && comparisonReport?.mode === 'business-rules-only';
  const comparisonCandidates = comparisonValid && Array.isArray(comparisonReport.comparisons) ? comparisonReport.comparisons : [];
  const comparisonRows = comparisonCandidates.slice(0, 100).map(item => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string') return null;
      return {
        id: item.id.slice(0, 128),
        status: ['passed', 'failed', 'incomplete'].includes(item.status) ? item.status : 'unknown',
        ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 128) } : {}),
        sourceStatus: typeof item.sourceStatus === 'string' ? item.sourceStatus.slice(0, 32) : 'unknown',
        candidateStatus: typeof item.candidateStatus === 'string' ? item.candidateStatus.slice(0, 32) : 'unknown',
        ...(actorLabel(item.sourceActor) ? { sourceActor: actorLabel(item.sourceActor) } : {}),
        ...(actorLabel(item.candidateActor) ? { candidateActor: actorLabel(item.candidateActor) } : {}),
        ...(Number.isInteger(item.step) && item.step > 0 ? { step: item.step } : {}),
        ...(typeof item.pointer === 'string' ? { pointer: item.pointer.slice(0, 128) } : {}),
      };
    }).filter(Boolean);
  const comparisonOverall = comparisonValid && ['passed', 'failed', 'incomplete'].includes(comparisonReport.overall)
    ? comparisonReport.overall : null;
  const comparisonRepairTaskCandidates = comparisonValid && Array.isArray(comparisonReport.repairTasks)
    ? comparisonReport.repairTasks.map(safeRepairTask).filter(Boolean) : [];
  const comparison = {
    status: !existsSync(comparisonFile) ? 'not_run' : !comparisonValid ? 'invalid' : comparisonOverall ?? 'incomplete',
    overall: comparisonOverall,
    generatedAt: typeof comparisonReport?.generatedAt === 'string' ? comparisonReport.generatedAt : null,
    sourceRules: Number.isInteger(comparisonReport?.sourceRules) ? comparisonReport.sourceRules : null,
    candidateRules: Number.isInteger(comparisonReport?.candidateRules) ? comparisonReport.candidateRules : null,
    summary: comparisonValid && comparisonReport.summary && typeof comparisonReport.summary === 'object' ? Object.fromEntries(
      ['compared', 'passed', 'failed', 'incomplete'].map(key => [key, Number.isInteger(comparisonReport.summary[key]) ? comparisonReport.summary[key] : 0]),
    ) : { compared: 0, passed: 0, failed: 0, incomplete: 0 },
    comparisonsMeta: { total: comparisonCandidates.length, returned: comparisonRows.length, truncated: comparisonCandidates.length > 100 },
    comparisons: comparisonRows,
    repairTasks: comparisonRepairTaskCandidates.slice(0, 50),
    repairTasksMeta: { total: comparisonRepairTaskCandidates.length, returned: Math.min(comparisonRepairTaskCandidates.length, 50), truncated: comparisonRepairTaskCandidates.length > 50 },
    path: existsSync(comparisonFile) ? reportPath(siteId, 'backend-scaffold/backend-compare.json') : null,
  };
  check.businessRuleComparison = comparison;
  return {
    status,
    present: status === 'present',
    files: files.length,
    requiredFiles: required.length,
    path: status === 'missing' ? null : reportPath(siteId, 'backend-scaffold'),
    aiTask,
    check,
  };
}

function apiSummary(root, siteId, expectedOrigin = null) {
  const contract = publicContract(root, siteId, expectedOrigin);
  const adapter = adapterSummary(root, siteId);
  const scaffold = backendScaffoldSummary(root, siteId);
  const unknowns = [];
  if (contract.status === 'missing') unknowns.push('api-contract-missing');
  if (contract.status === 'invalid') unknowns.push('api-contract-invalid');
  if (contract.status === 'observed' || contract.status === 'no_observed_api') {
    unknowns.push('auth-permissions-state-unknown', 'business-rules-and-side-effects-unknown');
    if (contract.summary?.unknowns) unknowns.push(`api-contract-unknowns:${contract.summary.unknowns}`);
  }
  if (adapter.present && !adapter.validation) unknowns.push('adapter-validation-missing');
  if (adapter.present && adapter.validation?.status !== 'passed') unknowns.push('adapter-not-validated');
  if (adapter.gapLedger?.summary?.uniqueGaps > 0) unknowns.push(`adapter-runtime-gaps:${adapter.gapLedger.summary.uniqueGaps}`);
  if (adapter.gapLedger?.summary?.unobservedQueryVariants > 0 || adapter.gapLedger?.summary?.uncoveredQueryParameters > 0) {
    unknowns.push('adapter-query-gaps');
  }
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
  const reportedTotal = Number.isSafeInteger(run?.summary?.fileable) && run.summary.fileable >= 0
    ? run.summary.fileable : null;
  const digest = qaFindingDigest(source, run.runId, { reportedTotal });
  const inconsistent = digest.status === 'observed' && reportedTotal !== null && digest.total !== reportedTotal;
  return {
    ...digest,
    ...(reportedTotal !== null ? { reportedTotal } : {}),
    ...(inconsistent ? { status: 'inconsistent' } : {}),
  };
}

function qaSummary(args, ctx, siteId, origin) {
  if (!args.qaWorkspace) return { status: 'not_configured', latest: null, metrics: null, site: null };
  let ws;
  try { ws = openWorkspace(args.qaWorkspace, ctx); } catch { return { status: 'unavailable', latest: null, metrics: null, site: null }; }
  const sites = Object.values(ws.sites);
  const legacyOrigin = origin ?? (siteId.includes('--origin-') ? null : originOf(`https://${siteId}`));
  const qaSite = sites.find(site => site.name === siteId || site.origin === origin || originOf(site.url) === origin || (legacyOrigin && site.origin === legacyOrigin)) ?? null;
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
  const reportPath = join(runDir, 'report.md');
  const bugsPath = join(runDir, 'bugs.md');
  const incompleteReasons = qaIncompleteReasons({ summary,
    clientBlocked: pages.reduce((n, p) => n + (p?.counts?.clientBlocked ?? 0), 0) + checks.reduce((n, c) => n + (c?.clientBlocked ?? 0), 0),
    detection: coverage?.detection, navigation: { failedPages: pages.filter(p => p?.navError) }, baseline: { status: coverage?.baseline?.status },
  });
  const safeCoveragePath = value => typeof value === 'string'
    ? redactText(value, { profile: 'strict' }).text.slice(0, 240) : null;
  const pageCoverage = pages.map(page => {
    const path = safeCoveragePath(page?.path);
    const viewport = typeof page?.viewport === 'string' ? page.viewport.slice(0, 32) : null;
    if (!path || !viewport) return null;
    return {
      path, viewport, navigation: page.navError ? 'failed' : 'observed',
      clientBlocked: Number.isSafeInteger(page?.counts?.clientBlocked) && page.counts.clientBlocked >= 0 ? page.counts.clientBlocked : 0,
    };
  }).filter(Boolean);
  const checkCoverage = checks.slice(0, 50).map(check => ({
    id: safeCoveragePath(check?.id) ?? 'unknown',
    status: check?.pass === true ? 'passed' : check?.pass === false ? 'failed' : 'unknown',
    clientBlocked: Number.isSafeInteger(check?.clientBlocked) && check.clientBlocked >= 0 ? check.clientBlocked : 0,
  }));
  const returnedPages = pageCoverage.slice(0, 50);
  const returnedChecks = checkCoverage.slice(0, 50);
  const validBusinessChecks = checks.every(check => typeof check?.id === 'string' && check.id.trim().length > 0
    && typeof check?.pass === 'boolean');
  const detection = coverage?.detection && typeof coverage.detection === 'object' && !Array.isArray(coverage.detection)
    ? {
      enabled: coverage.detection.enabled === true,
      pages: Number.isSafeInteger(coverage.detection.pages) && coverage.detection.pages >= 0 ? coverage.detection.pages : null,
      findings: Number.isSafeInteger(coverage.detection.findings) && coverage.detection.findings >= 0 ? coverage.detection.findings : null,
      failedPages: Array.isArray(coverage.detection.failedPages) ? coverage.detection.failedPages.length : null,
      detectors: Array.isArray(coverage.detection.detectors)
        ? coverage.detection.detectors.filter(value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value)).slice(0, 50)
        : [],
    } : null;
  const coverageSummary = {
    pages: returnedPages, pagesTotal: pages.length, pagesReturned: returnedPages.length, pagesTruncated: pages.length > 50,
    pagesMeta: { total: pages.length, valid: pageCoverage.length, returned: returnedPages.length, truncated: pages.length > 50 },
    checks: returnedChecks, checksTotal: checks.length, checksReturned: returnedChecks.length, checksTruncated: checks.length > 50,
    checksMeta: { total: checks.length, returned: returnedChecks.length, truncated: checks.length > 50 },
    businessChecks: { status: checks.length ? (validBusinessChecks ? 'observed' : 'incomplete') : 'not_declared', total: checks.length },
    detection,
    baselineStatus: typeof coverage?.baseline?.status === 'string' ? coverage.baseline.status.slice(0, 32) : null,
  };
  const known = summary && ['fileable', 'environment', 'checkNeedsFix'].every(key => Number.isInteger(summary[key]) && summary[key] >= 0)
    && pages.length > 0 && pages.every(p => typeof p?.path === 'string' && typeof p?.viewport === 'string')
    && Array.isArray(coverage?.checks) && validBusinessChecks;
  return {
    status: 'observed',
    site: { name: qaSite.name, environment: qaSite.environment, pages: qaSite.pages.length },
    metrics,
    latest: {
      runId: run.runId,
      startedAt: run.startedAt ?? null,
      summary,
      completeness: { status: incompleteReasons.length ? 'incomplete' : known ? 'complete' : 'unknown', incompleteReasonCount: incompleteReasons.length },
      coverage: coverageSummary,
      findings: readQaFindingDigest(runDir, run),
      report: existsSync(reportPath) ? relPath(ws, reportPath) : null,
      bugs: existsSync(bugsPath) ? relPath(ws, bugsPath) : null,
    },
  };
}

function pageSourceOrigin(root, pages) {
  const origins = new Set();
  for (const page of pages) {
    const origin = originOf(readJson(join(root, 'pages', page, 'manifest.json'))?.target);
    if (origin) origins.add(origin);
  }
  return origins.size === 0 ? undefined : origins.size === 1 ? [...origins][0] : null;
}

function siteIdOrigin(siteId) {
  return typeof siteId === 'string' && !siteId.includes('--origin-') ? originOf(`https://${siteId}`) : null;
}

function siteOrigin(root, pages, seo, api, siteId) {
  const pageOrigin = pageSourceOrigin(root, pages);
  if (pageOrigin !== undefined) return pageOrigin;
  return seo.origin || api.contract.origin || siteIdOrigin(siteId);
}

function claimsOf(siteId, clone, seo, api, qa, unknowns) {
  const verified = [];
  const observed = [];
  if (clone.verified > 0) verified.push(`clone.multi_viewport:${clone.verified}`);
  if (clone.delivery.deploymentVerification?.status === 'verified') verified.push('clone.independent_deployment:network_none');
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

function browserComplexitySummary(capabilities) {
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return null;
  const totals = capabilities.totals;
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return null;
  const count = key => Number.isSafeInteger(totals[key]) && totals[key] >= 0 ? totals[key] : 0;
  const signals = [
    ['iframes', count('iframes')],
    ['externalIframes', count('externalIframes')],
    ['shadowRoots', count('shadowRoots')],
    ['canvases', count('canvases')],
    ['tallPages', count('tallPages')],
  ].filter(([, value]) => value > 0);
  if (!signals.length) return null;
  return {
    pagesObserved: Number.isSafeInteger(capabilities.pagesObserved) && capabilities.pagesObserved >= 0 ? capabilities.pagesObserved : null,
    signalPages: Number.isSafeInteger(capabilities.signalPages) && capabilities.signalPages >= 0 ? capabilities.signalPages : null,
    pagesTruncated: capabilities.pagesTruncated === true,
    signals,
    support: capabilities.support ?? null,
  };
}

function classifyBrowserCapabilitySupport(capabilities, failures, runtimeDataGaps) {
  const pages = Array.isArray(capabilities.pages) ? capabilities.pages : [];
  const failureItems = Array.isArray(failures) ? failures : [];
  const dataGapItems = Array.isArray(runtimeDataGaps) ? runtimeDataGaps : [];
  const specs = [
    ['iframes', 'iframeCount', 'iframes'],
    ['externalIframes', 'externalIframeCount', 'externalIframes'],
    ['shadowRoots', 'shadowRootCount', 'shadowRoots'],
    ['canvases', 'canvasCount', 'canvases'],
    ['tallPages', 'tallPage', 'tallPages'],
  ];
  const signals = specs.flatMap(([id, key, totalKey]) => {
    const signalPages = pages.filter(page => key === 'tallPage' ? page.tallPage === true : page[key] > 0);
    const total = Number.isSafeInteger(capabilities.totals?.[totalKey]) && capabilities.totals[totalKey] > 0
      ? capabilities.totals[totalKey] : 0;
    if (!signalPages.length && !total) return [];
    const pageNames = signalPages.map(page => page.page);
    if (!signalPages.length) return [{
      id, status: 'degraded', count: total, pages: [], pagesTruncated: true,
      reason: '已观察到该类信号，但没有可用的逐页样本来确认支持状态。',
    }];
    const pageSet = new Set(pageNames);
    const relevantFailures = failureItems.filter(item => pageSet.has(item.page));
    const externalFailures = relevantFailures.filter(item => ['externalRequest', 'websocketUnsupported'].includes(item.kind));
    const localFailures = relevantFailures.filter(item => !['externalRequest', 'websocketUnsupported'].includes(item.kind));
    const relevantDataGaps = dataGapItems.filter(item => pageSet.has(item.page));
    const count = total || (key === 'tallPage'
      ? signalPages.length
      : signalPages.reduce((sum, page) => sum + (Number.isSafeInteger(page[key]) ? page[key] : 0), 0));
    let status = 'supported';
    let reason = '观察页面没有匹配的本地浏览器失败或动态数据缺口。';
    if (id === 'externalIframes') {
      status = externalFailures.length ? 'unsupported' : 'degraded';
      reason = externalFailures.length
        ? '外部嵌入在候选包断网探针中被阻断。'
        : '发现外部嵌入，但当前候选包没有证明其可独立部署。';
    } else if (id === 'iframes' && externalFailures.length) {
      status = 'degraded';
      reason = 'iframe 所在页面仍有外部运行时失败。';
    } else if (localFailures.length || relevantDataGaps.length) {
      status = 'degraded';
      reason = '信号所在页面仍有本地浏览器失败或同源动态数据缺口。';
    } else if (capabilities.pagesTruncated === true) {
      status = 'degraded';
      reason = '页面复杂度样本已截断，当前分类只覆盖部分信号页面。';
    }
    return [{
      id, status, count, pages: pageNames.slice(0, 10),
      pagesReturned: Math.min(pageNames.length, 10),
      ...(pageNames.length > 10 || capabilities.pagesTruncated === true ? { pagesTruncated: true } : {}),
      reason,
    }];
  });
  if (!signals.length) return null;
  const overall = signals.some(signal => signal.status === 'unsupported') ? 'unsupported'
    : signals.some(signal => signal.status === 'degraded') ? 'degraded' : 'supported';
  return {
    overall, basis: 'observed', scope: 'candidate-offline-browser', signals,
    limitations: [
      'supported 只表示当前候选包的已观察页面没有匹配失败，不证明源站语义、交互或业务等价。',
      'degraded 和 unsupported 需要按页面信号修复、人工审核或重新导出后复测。',
    ],
  };
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

function buildSeoGeoTask(siteId, origin, seo) {
  const observed = seo.status === 'observed';
  const geo = seo.geo && typeof seo.geo === 'object' ? seo.geo : {
    score: null, status: 'unknown', methodVersion: null, actionItems: 0, actionPlan: [],
    actionPlanMeta: { truncated: false },
  };
  const repairCandidates = Array.isArray(seo.repairCandidates) ? seo.repairCandidates : [];
  const advisoryCandidates = Array.isArray(seo.advisoryCandidates) ? seo.advisoryCandidates : [];
  const methodsCurrent = observed && seo.scoreMethodStatus === 'current' && seo.measurementStatus === 'current';
  const seoActions = observed ? repairCandidates.map(issue => ({
    kind: 'seo', id: issue.id, category: issue.category, severity: issue.severity,
    priority: issue.severity === 'critical' || issue.severity === 'high' ? 'P0' : 'P1',
    title: issue.title, instruction: issue.suggestion, affectedPages: issue.affectedPages,
    pages: issue.pages, evidenceLevel: 'observed',
    verification: { method: 'rerun-seo-audit', checkId: issue.id, expectedStatus: 'resolved' },
  })) : [];
  const geoActions = observed ? geo.actionPlan.map(action => ({
    kind: 'geo', id: action.id, dimension: action.dimension, priority: action.priority,
    title: action.title, instruction: action.action,
    affectedPages: action.impact?.affectedPages ?? 0,
    evidenceLevel: 'observed', estimatedEffort: action.estimatedEffort,
    verification: { method: 'rerun-geo-audit', checkId: action.validation?.checkId ?? action.id, expectedStatus: 'pass' },
  })) : [];
  const advisoryActions = observed ? advisoryCandidates.map(issue => ({
    kind: 'seo', id: issue.id, category: issue.category, severity: issue.severity,
    priority: 'P2', title: issue.title, instruction: issue.suggestion,
    affectedPages: issue.affectedPages, pages: issue.pages, evidenceLevel: 'observed',
    verification: { method: 'rerun-seo-audit', checkId: issue.id, expectedStatus: 'resolved' },
  })).slice(0, 20) : [];
  const priorityRank = { P0: 0, P1: 1, P2: 2 };
  const allActions = [...seoActions, ...geoActions].sort((a, b) =>
    (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9)
    || (Number(b.affectedPages) || 0) - (Number(a.affectedPages) || 0)
    || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const actions = allActions.slice(0, 20);
  const totalByKind = {
    seo: seo.repairCandidatesMeta?.total ?? seoActions.length,
    geo: geo.actionPlanMeta?.total ?? geoActions.length,
  };
  const returnedByKind = {
    seo: actions.filter(item => item.kind === 'seo').length,
    geo: actions.filter(item => item.kind === 'geo').length,
  };
  const observedActionsMeta = {
    total: totalByKind.seo + totalByKind.geo,
    returned: actions.length,
    truncated: allActions.length > actions.length || seo.repairCandidatesMeta?.truncated === true || geo.actionPlanMeta?.truncated === true,
    totalByKind, returnedByKind,
  };
  const observedAdvisoriesMeta = {
    total: seo.advisoryCandidatesMeta?.total ?? advisoryCandidates.length,
    returned: advisoryActions.length,
    truncated: seo.advisoryCandidatesMeta?.truncated === true || advisoryCandidates.length > advisoryActions.length,
  };
  const outcomeEvidence = seo.outcomeEvidence ?? {
    search: { status: 'unknown', basis: 'unknown', evidence: [], reason: '没有授权的真实搜索结果、收录或排名实验。' },
    modelCitation: { status: 'unknown', basis: 'unknown', evidence: [], reason: '没有授权的真实模型检索和引用命中实验。' },
  };
  const outcomeTasks = [
    ...(outcomeEvidence.search?.status === 'observed' ? [] : [{ id: 'measure-search-outcomes', basis: 'unknown', requiresHumanApproval: true,
      instruction: '在固定且获授权的查询集合上记录搜索结果、收录状态和采集时间，并写入脱敏 outcome-evidence.json；不要把页面评分当作真实排名或收录结果。' }]),
    ...(outcomeEvidence.modelCitation?.status === 'observed' ? [] : [{ id: 'measure-model-citation-outcomes', basis: 'unknown', requiresHumanApproval: true,
      instruction: '在固定且获授权的提示词、模型和时间窗口上记录回答与来源引用，并写入脱敏 outcome-evidence.json；不要把 GEO 准备度当作真实引用命中率。' }]),
  ];
  const geoCoverage = geo.coverage && typeof geo.coverage === 'object' ? {
    pages: Number.isInteger(geo.coverage.pages) ? geo.coverage.pages : null,
    pagesScored: Number.isInteger(geo.coverage.pagesScored) ? geo.coverage.pagesScored : null,
    pagesUnavailable: Number.isInteger(geo.coverage.pagesUnavailable) ? geo.coverage.pagesUnavailable : null,
    observedWeight: Number.isFinite(geo.coverage.observedWeight) ? geo.coverage.observedWeight : null,
    totalWeight: Number.isFinite(geo.coverage.totalWeight) ? geo.coverage.totalWeight : null,
    ratio: Number.isFinite(geo.coverage.ratio) ? geo.coverage.ratio : null,
    confidence: typeof geo.confidence === 'string' ? geo.confidence : null,
  } : null;
  const coverage = {
    pages: Number.isInteger(seo.pages) ? seo.pages : null,
    sitemapCoverage: seo.completeness?.sitemapCoverage ?? null,
    failedPages: Number(seo.completeness?.failedPages ?? 0),
    initialHtmlUnchecked: Number(seo.completeness?.initialHtmlUnchecked ?? 0),
    geoStatus: geo.status ?? 'unknown',
    geo: geoCoverage,
    actionItems: geo.actionItems ?? 0,
    actionsTruncated: observedActionsMeta.truncated || observedAdvisoriesMeta.truncated,
  };
  const complete = observed && methodsCurrent
    && !['partial', 'unavailable'].includes(coverage.sitemapCoverage)
    && coverage.failedPages === 0 && coverage.initialHtmlUnchecked === 0
    && coverage.geoStatus === 'complete' && !observedActionsMeta.truncated && actions.length === 0;
  const status = !observed ? 'blocked_on_observation'
    : !methodsCurrent ? 'blocked_on_measurement' : complete ? 'ready' : 'ready_for_ai_review';
  return {
    schema: 'heimdall.seo-geo-ai-task/1', siteId, status,
    objective: '让 AI 在当前 SEO/GEO 证据范围内提出可执行优化，并用同一套确定性审计复测结果。',
    scores: {
      seo: observed ? seo.score : null, seoGrade: observed ? seo.grade : null,
      geo: observed ? geo.score : null, geoStatus: observed ? geo.status : 'unknown',
      geoConfidence: observed && typeof geo.confidence === 'string' ? geo.confidence : null,
      geoDimensions: observed ? geo.dimensions : null,
    },
    methods: {
      seoScore: { version: seo.scoreMethodVersion, status: seo.scoreMethodStatus },
      seoMeasurement: { version: seo.measurementVersion, status: seo.measurementStatus },
      geo: { version: geo.methodVersion, status: geo.status === 'unknown' ? 'unknown' : geo.status },
    },
    coverage,
    observedActions: actions,
    observedActionsMeta,
    observedAdvisories: advisoryActions,
    observedAdvisoriesMeta,
    outcomeEvidence,
    inputs: observed ? [{ path: seo.reports.json, role: 'deterministic SEO/GEO report', basis: 'observed', required: true }] : [],
    tasks: observed ? [
      { id: 'fix-observed-seo', basis: 'observed', requiresHumanApproval: true, instruction: '按 observedActions 中的 SEO 项修复页面、模板或结构化信息；不要改评分公式来消除问题。' },
      { id: 'improve-observed-geo', basis: 'observed', requiresHumanApproval: true, instruction: '按 GEO 行动项补充可回答、可抽取、实体和引用线索；所有事实、作者和链接先人工核实。' },
      ...outcomeTasks,
      { id: 'rerun-complete-audit', basis: 'inferred', requiresHumanApproval: false, instruction: '修复后用相同站点范围重新审计，确认口径、覆盖、sitemap 和 action plan 都可比较。' },
    ] : [
      { id: 'obtain-seo-geo-evidence', basis: 'unknown', requiresHumanApproval: true, instruction: '先运行授权的 SEO/GEO 审计；没有报告时不要猜测分数或问题。' },
    ],
    guardrails: [
      'SEO/GEO 分数只表示当前方法和采集范围，不代表排名、流量、收录或模型引用成功。',
      'unknown、stale、future、partial 和 unavailable 不能被 AI 改写成通过或完整覆盖。',
      'medium SEO 行动属于 observed advisory，不会单独改变 readiness，但修复后仍需用同一审计复测。',
      '真实搜索结果、收录状态和模型引用命中率必须有独立实验；页面评分不会自动升级 outcomeEvidence。',
      'AI 可以提出内容、结构、链接和结构化数据优化，但不能未经人工核实编造事实、作者、评价或来源。',
      '任何优化都必须在相同范围、相同方法版本下重新运行审计后才能比较前后结果。',
    ],
    verification: {
      commands: [
        ...(origin ? [`heimdall seo-audit ${origin}/`] : []),
        `heimdall site-assessment ${siteId} --json`,
      ],
      gates: [
        '评分和测量口径均为 current，或报告明确保留为历史观察。',
        'sitemap、页面采集和初始 HTML 范围完整后再解释站点级结果。',
        '修复后的 observedActions 在同一审计范围内消失或降为已解释状态。',
        '需要声明真实排名、收录或模型引用效果时，先补齐对应的独立实验记录；否则保持 unknown。',
      ],
    },
    prompt: [
      '先读取 deliveryPlan.seoGeoTask 和其 inputs 指向的脱敏报告。',
      '把 observedActions 当作当前证据，把 tasks 中的 inferred 内容当作待人工核实的建议。',
      '如果 observedActionsMeta.truncated 为 true，或 returnedByKind 不等于 totalByKind，继续读取同一份脱敏报告；列表不是全部问题。',
      '不要把分数解释为排名或模型引用成功，也不要用改评分公式的方式消除问题。',
      '如果 outcomeEvidence.search 或 outcomeEvidence.modelCitation 为 unknown，先按对应 tasks 补采授权实验，再谈真实效果。',
      '完成一组小改动后按 verification.commands 复测，并分别汇报 verified、observed、inferred、unknown。',
    ].join('\n'),
    provenance: {
      observed: observed && seo.reports?.json ? [seo.reports.json] : [],
      inferred: ['优化优先级', 'AI 任务步骤', '复测门禁'],
      invented: [],
    },
    limitations: [
      '没有真实搜索结果、抓取日志或模型引用实验时，不能证明排名、收录和引用效果。',
      '任务包只投影安全摘要；需要完整问题证据时应读取同一份脱敏 SEO 报告。',
    ],
  };
}

function qaBackendScope(origin, api, backendCompletion) {
  const gapSummary = backendCompletion?.gapLedger?.summary ?? api.adapter.gapLedger?.summary;
  const gapKeys = ['uniqueGaps', 'unobservedQueryVariants', 'uncoveredQueryParameters', 'missingResponseBodies', 'unverifiedWrites'];
  const gapLedger = gapSummary && typeof gapSummary === 'object' ? {
    status: gapKeys.some(key => Number.isSafeInteger(gapSummary[key]) && gapSummary[key] > 0) ? 'open' : 'observed',
    ...Object.fromEntries(gapKeys.filter(key => Number.isSafeInteger(gapSummary[key]) && gapSummary[key] >= 0)
      .map(key => [key, gapSummary[key]])),
  } : { status: 'missing' };
  const repairTasks = Array.isArray(backendCompletion?.repairTasks) ? backendCompletion.repairTasks : [];
  const humanJourneys = Array.isArray(backendCompletion?.humanJourneys) ? backendCompletion.humanJourneys : [];
  const unknowns = Array.isArray(backendCompletion?.unknowns) ? backendCompletion.unknowns : [];
  return {
    origin: origin ?? null,
    contract: api.contract.status,
    adapter: api.adapter.status,
    scaffoldCheck: api.scaffold?.check?.status ?? 'not_run',
    basis: api.contract.status === 'observed' || api.adapter.present ? 'observed' : 'unknown',
    completion: {
      status: backendCompletion?.status ?? 'unknown',
      currentLevel: backendCompletion?.target?.currentLevel ?? 'unknown',
      observedEndpoints: Array.isArray(backendCompletion?.observedEndpoints) ? backendCompletion.observedEndpoints.length : 0,
      gapLedger,
      businessRules: typeof backendCompletion?.businessRules?.status === 'string'
        ? backendCompletion.businessRules.status : 'not-tested',
      businessRuleActors: Array.isArray(backendCompletion?.businessRules?.actors)
        ? backendCompletion.businessRules.actors.slice(0, 20) : [],
      businessRuleComparison: typeof backendCompletion?.businessRuleComparison?.overall === 'string'
        ? backendCompletion.businessRuleComparison.overall
        : typeof backendCompletion?.businessRuleComparison?.status === 'string'
          ? backendCompletion.businessRuleComparison.status : 'not_run',
      adapterEgress: typeof backendCompletion?.adapterEgress?.status === 'string'
        ? backendCompletion.adapterEgress.status : 'unknown',
      operationProbe: typeof backendCompletion?.adapterEgress?.operationProbe?.status === 'string'
        ? backendCompletion.adapterEgress.operationProbe.status : 'not-tested',
      repairTasks: {
        total: Number.isSafeInteger(backendCompletion?.repairTasksMeta?.total)
          ? backendCompletion.repairTasksMeta.total : repairTasks.length,
        kinds: [...new Set(repairTasks.map(task => task?.kind).filter(kind => typeof kind === 'string'))].slice(0, 12),
      },
      humanJourneys: humanJourneys.slice(0, 8).map(journey => ({
        id: typeof journey?.id === 'string' ? journey.id : 'unknown',
        status: typeof journey?.status === 'string' ? journey.status : 'unknown',
      })),
      unknowns: unknowns.slice(0, 12).map(item => ({
        id: typeof item?.id === 'string' ? item.id : 'unknown',
        basis: typeof item?.basis === 'string' ? item.basis : 'unknown',
      })),
    },
  };
}

function buildQaTask(siteId, origin, qa, api, backendCompletion = null) {
  const latest = qa.latest;
  const findings = latest?.findings?.items ?? [];
  const findingsTotal = Number.isSafeInteger(latest?.findings?.total) && latest.findings.total >= 0
    ? latest.findings.total : findings.length;
  const hasFindings = findingsTotal > 0;
  const findingsObserved = latest?.findings?.status === 'observed';
  const completeness = latest?.completeness?.status ?? 'unknown';
  const businessChecks = latest?.coverage?.businessChecks ?? { status: 'unknown', total: null };
  const observed = qa.status === 'observed';
  const backendScope = qaBackendScope(origin, api, backendCompletion);
  const status = !observed || ['not_configured', 'unavailable', 'configured'].includes(qa.status)
    ? 'blocked_on_qa_evidence'
    : qa.status === 'no_runs' ? 'blocked_on_observation'
      : completeness !== 'complete' ? 'blocked_on_complete_run'
        : !findingsObserved ? 'blocked_on_qa_evidence'
        : hasFindings ? 'human_review'
          : qa.metrics?.decision?.primaryAction && qa.metrics.decision.primaryAction !== 'hold'
            ? 'ready_for_ai_review' : 'ready';
  const tasks = observed && latest ? [
    ...(completeness !== 'complete' ? [{ id: 'complete-qa-run', basis: 'observed', requiresHumanApproval: true, instruction: '补齐环境、导航、检测器和基线证据；没有可提单问题不等于 QA 已完成。' }] : []),
    ...(!findingsObserved ? [{ id: 'obtain-finding-evidence', basis: 'unknown', requiresHumanApproval: true, instruction: '先恢复或重新生成脱敏 finding 详情；摘要总量不能替代逐条证据。' }] : []),
    ...(findingsObserved && hasFindings ? [{ id: 'review-findings', basis: 'observed', requiresHumanApproval: true, instruction: '先用 heimdall_qa_findings 逐条确认 finding；只有人工确认后才修改代码或业务。' }] : []),
    ...(findings.some(item => item.triage === 'known-bug') ? [{ id: 'fix-confirmed-findings', basis: 'observed', requiresHumanApproval: false, instruction: '修复已经标记为 known-bug 的问题，再用同一站点和检查点重跑 QA。' }] : []),
    ...(businessChecks.status === 'incomplete' ? [{ id: 'complete-business-checks', basis: 'observed', requiresHumanApproval: true, instruction: '修复缺少 id 或 pass 结果的业务检查点，再用同一站点重跑完整 QA；半截检查点不能证明业务规则。' }] : []),
    ...(businessChecks.status === 'not_declared' ? [{ id: 'add-business-checks', basis: 'unknown', requiresHumanApproval: true, instruction: '把已确认的 PRD、业务流程和接口响应期望写成声明检查点，再用同一站点重跑 QA；页面 detector 不能替代业务检查。' }] : []),
    ...(qa.metrics?.decision?.primaryAction && qa.metrics.decision.primaryAction !== 'hold'
      ? [{ id: 'follow-up-qa-metrics', basis: 'inferred', requiresHumanApproval: true, instruction: '按 QA 指标决策补证据、修已有检测器或增加业务检查点；不以指标不足为由新增通用检测器。' }] : []),
  ] : [{ id: 'obtain-qa-evidence', basis: 'unknown', requiresHumanApproval: true, instruction: '先准备匹配站点的 QA 工作区并完成一次只读 QA；没有运行证据时不要猜测缺陷。' }];
  const metrics = qa.metrics?.decision ? {
    coverage: {
      runs: Number(qa.metrics.coverage?.runs ?? 0),
      pageViewportChecks: Number(qa.metrics.coverage?.pageViewportChecks ?? 0),
      checks: Number(qa.metrics.coverage?.checks ?? 0),
    },
    decision: {
      primaryAction: qa.metrics.decision.primaryAction ?? 'unknown',
      detectorExpansion: qa.metrics.decision.detectorExpansion ?? 'unknown',
      secondaryActions: Array.isArray(qa.metrics.decision.secondaryActions) ? qa.metrics.decision.secondaryActions.slice(0, 4) : [],
    },
  } : null;
  return {
    schema: 'heimdall.qa-bug-ai-task/1', siteId, status,
    objective: '让 AI 在完整、脱敏的 QA 证据上定位前端和后端缺陷候选，并在人工裁决后用同一检查点复测。',
    scope: {
      frontend: { pages: qa.site?.pages ?? null, latestRun: latest?.runId ?? null, basis: observed ? 'observed' : 'unknown' },
      backend: backendScope,
    },
    latest: latest ? {
      runId: latest.runId, summary: latest.summary, completeness: latest.completeness,
      coverage: latest.coverage,
      findings: {
        status: latest.findings.status,
        ...(Number.isSafeInteger(latest.findings.reportedTotal) ? { reportedTotal: latest.findings.reportedTotal } : {}),
        total: latest.findings.total, returned: latest.findings.returned, truncated: latest.findings.truncated, items: findings,
      },
    } : null,
    metrics, tasks,
    inputs: observed && latest ? [
      { path: latest.report, role: 'QA report', basis: 'observed', required: true },
      { path: latest.bugs, role: 'sanitized finding summary', basis: 'observed', required: true },
    ].filter(input => input.path) : [],
    guardrails: [
      'finding 只有在人工裁决后才能作为真实 bug；known-bug 可进入修复，new 或 reopened 先保留人工复核。',
      '零可提单问题不等于零 bug；运行完整性、覆盖、漏报和未声明业务规则必须单独汇报。',
      '页面视觉通过不证明 API、认证、权限、状态机、持久化或外部副作用通过。',
      '不得把原始 HAR、Cookie、令牌、请求体或未脱敏响应交给 AI；复测必须绑定同一站点、检查点和 finding fingerprint。',
    ],
    verification: {
      commands: [
        ...(qaWorkspaceCommand(siteId, qa) ? [qaWorkspaceCommand(siteId, qa)] : []),
        `heimdall site-assessment ${siteId} --json`,
      ],
      gates: [
        '匹配站点的 QA 运行完整，环境、导航、检测器和基线证据可解释。',
        '每条 fileable finding 都有人工 verdict；确认问题修复后同一 fingerprint 从新完整运行中消失。',
        '后端契约、适配器和业务规则单独核实，不能用页面无报错替代。',
      ],
    },
    prompt: [
      '先读取 deliveryPlan.qaTask 及其 inputs；再按 tasks 的顺序处理，不要把 finding 数量当准确率。',
      '先区分 observed、inferred、unknown 和人工 verdict，再决定是否修改前端、后端或 QA 检查。',
      '先读取 scope.backend.completion 的后端缺口、修复任务和人工旅程，再回读 deliveryPlan.backendCompletion 的完整脱敏证据。',
      '如果 latest.coverage.pagesMeta 或 latest.coverage.checksMeta 的 truncated 为 true，或 pagesMeta.valid 小于 total，先补齐 QA 覆盖证据。',
      '读取 latest.coverage.detection 的数量和 detector 列表；检测器发现不能直接当作已确认 bug，仍须读取 finding 证据并完成人工裁决。',
      '如果 latest.coverage.businessChecks.status 为 not_declared，先补充已确认的业务检查点；页面巡检不能证明后端和业务规则。',
      '完成修复后用同一站点、检查点和 fingerprint 复测，并分别汇报 verified、observed、inferred、unknown。',
    ].join('\n'),
    provenance: {
      observed: observed && latest ? [latest.report, latest.bugs].filter(Boolean) : [],
      inferred: ['缺陷处理顺序', 'AI 修复步骤', '复测门禁'],
      invented: [],
    },
    limitations: [
      'QA 摘要只覆盖声明的页面、检查点和运行范围；不能外推任意站点缺陷检出率。',
      '后端认证、权限、写入、状态和副作用需要独立授权旅程与业务规则对照。',
    ],
  };
}

function buildCloneTask(siteId, origin, clone, items) {
  const delivery = clone.delivery ?? { status: 'not_recorded' };
  const deployment = delivery.deploymentVerification ?? { status: 'unknown', report: null };
  const rebuildPage = Array.isArray(clone.samplePages)
    ? clone.samplePages.find(page => typeof page === 'string' && /^[a-z0-9._-]{1,128}$/i.test(page)) ?? null
    : null;
  const cloneItems = items.filter(item => CLONE_TASK_ITEM_IDS.has(item.id));
  const actions = cloneItems.map(item => ({
    id: item.id, kind: item.kind, status: item.status, basis: item.basis,
    title: item.title, instruction: item.detail, evidence: item.evidence,
    action: item.action ?? null, verification: item.verify ?? null,
    requiresHumanApproval: item.action?.requiresHumanApproval === true || item.status === 'blocked',
  }));
  const captureBlocked = !clone.pages || clone.mirrors < clone.pages;
  const visualBlocked = clone.pages > 0 && (clone.unmeasured > 0 || clone.verificationStatus !== 'checked');
  const deliveryBlocked = clone.mirrors > 0 && delivery.status !== 'passed';
  const deploymentBlocked = (delivery.status === 'passed' || delivery.deploymentVerificationAttempt) && deployment.status !== 'verified';
  const status = captureBlocked ? 'blocked_on_capture'
    : visualBlocked ? 'blocked_on_visual_verification'
      : deliveryBlocked ? 'blocked_on_offline_delivery'
        : deploymentBlocked ? 'blocked_on_independent_deployment'
          : actions.length ? 'ready_for_ai_review' : 'ready';
  const reportInputs = [
    delivery.report ? { path: delivery.report, role: 'strict offline delivery summary', basis: 'observed', required: true } : null,
    deployment.report ? { path: deployment.report, role: 'independent deployment verification', basis: 'observed', required: false } : null,
    delivery.deploymentVerificationAttempt?.report ? { path: delivery.deploymentVerificationAttempt.report, role: 'independent deployment failure attempt', basis: 'observed', required: false } : null,
  ].filter(Boolean);
  const cloneCommand = origin
    ? `heimdall clone ${origin}/ --scope site --level verified${delivery.coverage?.scopeLimited === true ? ' --all-discovered' : ''}`
    : null;
  const exportCommand = `heimdall live ${siteId} --offline --strict --heal --materialize-har${delivery.root === 'mirror' ? ' --root mirror' : ''}`;
  const verificationCommands = [
    ...(cloneCommand ? [cloneCommand] : []),
    exportCommand,
    ...((delivery.status === 'passed' || delivery.deploymentVerificationAttempt) && deployment.status !== 'verified'
      ? [`heimdall live-verify <deliverable/${siteId}-包目录> --static --site-id ${siteId}`] : []),
    `heimdall site-assessment ${siteId} --json`,
  ];
  const closureObligations = [
    {
      id: 'mirror-coverage',
      status: captureBlocked ? (clone.pages ? 'open' : 'unknown') : 'verified',
      basis: clone.pages ? 'observed' : 'unknown',
      verify: 'clone.mirrors === clone.pages',
    },
    {
      id: 'visual-verification',
      status: clone.pages === 0 ? 'unknown' : visualBlocked ? 'open' : 'verified',
      basis: clone.pages ? 'observed' : 'unknown',
      verify: 'clone.unmeasured === 0 && clone.verificationStatus === "checked"',
    },
    {
      id: 'strict-offline-delivery',
      status: delivery.status === 'passed' ? 'verified' : delivery.status === 'not_recorded' ? 'unknown' : 'open',
      basis: delivery.report ? 'observed' : 'unknown',
      verify: 'clone.delivery.status === "passed"',
    },
    {
      id: 'delivery-scope',
      status: !delivery.coverage ? 'unknown'
        : delivery.coverage.scope === 'recon-discovered' && delivery.coverage.scopeLimited === false ? 'verified' : 'open',
      basis: delivery.coverage ? 'observed' : 'unknown',
      verify: 'scope.delivery.coverage.scope === "recon-discovered" && scope.delivery.coverage.scopeLimited === false',
    },
    {
      id: 'independent-deployment',
      status: deployment.status === 'verified' ? 'verified' : deployment.status === 'unknown' ? 'unknown' : 'open',
      basis: deployment.report ? 'observed' : 'unknown',
      verify: 'scope.delivery.independentDeployment.status === "verified"',
    },
  ];
  const closureCounts = {
    required: closureObligations.length,
    verified: closureObligations.filter(item => item.status === 'verified').length,
    open: closureObligations.filter(item => item.status === 'open').length,
    unknown: closureObligations.filter(item => item.status === 'unknown').length,
  };
  const rebuild = rebuildPage ? {
    status: 'available', basis: 'observed', page: rebuildPage,
    workflow: ['study', 'build', 'check', 'refine', 'deliver'],
    commands: [
      `heimdall rebuild init ${siteId} --page ${rebuildPage} --stack html-css --gate silver`,
      `heimdall compare --project <rebuild-dir> --page ${rebuildPage} --mode fast`,
      'heimdall rebuild status --project <rebuild-dir> --json',
      `heimdall compare --project <rebuild-dir> --page ${rebuildPage} --mode formal --gate --md`,
      'heimdall rebuild deliver --project <rebuild-dir> --json',
    ],
    gates: [
      '先读取重建工作区生成的 AGENTS.md、brief 和 sections，再修改项目文件。',
      '每次修改后运行同一页面的 compare/check；分数变差时回到最近一次通过或更好的提交。',
      '只有正式门禁通过才能把重建项目标为成品；否则按 Floor=Mirror 交付并保留残差。',
    ],
  } : {
    status: 'blocked_on_capture', basis: 'unknown', page: null,
    workflow: ['study', 'build', 'check', 'refine', 'deliver'], commands: [], gates: [],
  };
  return {
    schema: 'heimdall.clone-ai-task/1', siteId, status,
    objective: '让 AI 在当前镜像、还原度和独立交付证据范围内补齐可验证的站点重建缺口。',
    scope: {
      origin: origin ?? null,
      pages: clone.pages, mirrors: clone.mirrors,
      mirrorCoverage: clone.pages ? +(clone.mirrors / clone.pages).toFixed(3) : null,
      visual: {
        verified: clone.verified, unmeasured: clone.unmeasured,
        verificationStatus: clone.verificationStatus, averageOverall: clone.averageOverall,
        averageScore: clone.averageScore, worstViewport: clone.worstViewport,
        scoreStatuses: clone.scoreStatuses, verificationGaps: clone.verificationGaps,
      },
      delivery: {
        status: delivery.status, published: delivery.published ?? null,
        offline: delivery.offline ?? null, strict: delivery.strict ?? null,
        blockingCount: delivery.blockingCount ?? null,
        browser: delivery.browser ?? null,
        browserCapabilities: delivery.browserCapabilities ?? null,
        browserFailures: delivery.browserFailures?.length ?? 0,
        runtimeDataGaps: delivery.runtimeDataGaps?.length ?? 0,
        binaryDownloadGaps: delivery.binaryDownloadGaps?.length ?? 0,
        coverage: {
          scope: ['captured-only', 'recon-discovered', 'untrusted-recon'].includes(delivery.coverage?.scope) ? delivery.coverage.scope : 'unknown',
          scopeLimited: delivery.coverage?.scopeLimited === false ? false : true,
        },
        independentDeployment: { status: deployment.status, report: deployment.report },
        independentDeploymentAttempt: delivery.deploymentVerificationAttempt ?? null,
      },
    },
    closure: {
      schema: 'heimdall.rebuild-closure/1',
      state: closureCounts.verified === closureCounts.required ? 'ready' : 'open',
      counts: closureCounts,
      requiredObligations: closureObligations,
    },
    rebuild,
    observedActions: actions.filter(item => item.basis === 'observed'),
    openActions: actions,
    tasks: actions.length ? actions.map(item => ({
      id: item.id, basis: item.basis, requiresHumanApproval: item.requiresHumanApproval,
      instruction: item.instruction, verification: item.verification,
    })) : [{
      id: 'rerun-clone-gates', basis: 'inferred', requiresHumanApproval: false,
      instruction: '代码或资源发生变化后，按相同页面、视口和交付范围重新运行克隆门禁。',
      verification: { method: 'site-assessment', expectedStatus: 'ready' },
    }],
    inputs: reportInputs,
    guardrails: [
      '视觉分数只表示当前页面和视口的相似度，不代表功能、后端、SEO 或业务等价。',
      'strict 离线导出通过不等于独立部署通过；必须有当前校验和绑定的断网部署报告。',
      'scope.delivery.coverage.scopeLimited 为 true 时，当前包只代表有界页面范围；先用 allDiscovered 扩大范围并重新验证。',
      '外部运行时、动态 API、WebSocket、登录、权限和写入行为不能由 AI 猜成已实现。',
      'browserCapabilities.support 是候选包离线观察分类；supported 不证明源站或业务等价，degraded 和 unsupported 必须继续复测。',
      '前端重建只从当前镜像和脱敏证据开始；后端补全继续读取 deliveryPlan.backendCompletion。',
      'unknown、unmeasured、blocked 和未审核资源必须保留原状态，不能改写成通过。',
      'closure.requiredObligations 是重建闭环的硬门槛；unknown 或 open 不能被 AI 改写成 ready。',
      '源站源码、凭据、Cookie、令牌、原始 HAR 和未脱敏响应不进入任务包。',
    ],
    verification: {
      commands: verificationCommands,
      gates: [
        '镜像数量等于当前页面范围，且每页都有当前有效的多视口验证。',
        'strict 离线导出为 passed，blockingCount、浏览器失败和未测页均为零。',
        '交付范围为 recon-discovered 且 scopeLimited 为 false，或明确把当前结果标为有界交付。',
        '独立部署报告绑定当前包校验和，并在 Docker network none 中通过路由检查。',
        '修复后必须用同一站点范围重新评估，分别汇报 verified、observed、inferred、unknown。',
      ],
    },
    prompt: [
      '先读取 deliveryPlan.cloneTask、scope 和 inputs 指向的脱敏报告。',
      '把 observedActions 当作当前证据，把 tasks 中的 inferred 内容当作待验证工作。',
      '不要把视觉分数、strict 导出或静态页面通过解释成后端和业务功能完成。',
      '不要猜测动态 API、外部运行时、WebSocket、认证、权限或写入行为；遇到缺口先保留 unknown。',
      '如果 scope.delivery.browserCapabilities 存在，先读取 support 的逐信号分类；supported 只限候选包观察，degraded 或 unsupported 先按页面证据复测。',
      '先处理 closure.requiredObligations，再按相同证据重新运行 site-assessment；所有必需义务 verified 后才可称为 ready。',
      '完成小改动后按 verification.commands 复测，并分别汇报 verified、observed、inferred、unknown。',
    ].join('\n'),
    provenance: {
      observed: reportInputs.map(input => input.path),
      inferred: ['克隆修复顺序', 'AI 任务步骤', '复测门禁'],
      invented: [],
    },
    limitations: [
      '页面相似度不能证明交互、认证、权限、状态机、持久化或外部副作用等价。',
      '没有独立断网部署报告时，strict 导出只能作为候选交付证据。',
    ],
  };
}

function qaWorkspaceCommand(siteId, qa) {
  return qa?.site?.name ? `heimdall qa run --site ${qa.site.name}` : null;
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

function runtimeDataRepairTasks(siteId, gaps, delivery) {
  const seen = new Set();
  return gaps.filter(gap => {
    const key = `${gap.resourceType}:${gap.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((gap, index) => ({
    id: `repair-runtime-data-${index + 1}`,
    kind: 'runtime-data-observation', target: gap.target, status: 'blocked_on_observation',
    instruction: '先在获授权的源站复测这个动态数据请求，确认路径、查询参数名、状态和响应结构；再补本地适配器或受审核的只读数据。不要从 404 猜测业务数据。',
    requiresHumanApproval: true,
    evidence: { ...gap, health: delivery?.healthReport ?? null },
    verification: planVerification(siteId, 'clone.delivery.runtimeDataGaps.length === 0'),
  }));
}

function buildBackendCompletionTask(siteId, api, delivery = null) {
  const observed = api.contract.status === 'observed';
  const endpoints = api.contract.observedEndpoints ?? [];
  const responseShapes = endpoints.flatMap(endpoint => endpoint.responseShapes);
  const shapedResponses = responseShapes.filter(shape => shape.withSchema);
  const hasWrite = endpoints.some(endpoint => endpoint.method !== 'GET');
  const validationStatus = api.adapter.validation?.status ?? 'not-validated';
  const adapterServerEgress = delivery?.adapter?.serverEgress ?? 'unknown';
  const operationProbe = delivery?.adapterEgressVerification?.operationProbe ?? { status: 'not-tested' };
  const operationProbeStatus = operationProbe?.status ?? 'not-tested';
  const businessRuleCheck = api.scaffold?.check?.businessRules ?? { status: 'not-tested', total: 0, passed: 0, failed: 0, incomplete: 0 };
  const businessRuleComparison = api.scaffold?.check?.businessRuleComparison ?? { status: 'not_run', overall: null, summary: { compared: 0, passed: 0, failed: 0, incomplete: 0 }, repairTasks: [] };
  const scaffoldCheckStatus = api.scaffold?.check?.mode === 'business-rules-only' ? 'not-tested' : api.scaffold?.check?.status ?? 'not_run';
  const gapLedger = api.adapter.gapLedger;
  const gapLedgerHasOpenItems = Boolean(gapLedger?.summary && (
    gapLedger.summary.uniqueGaps > 0 || gapLedger.summary.unobservedQueryVariants > 0
    || gapLedger.summary.uncoveredQueryParameters > 0 || gapLedger.summary.missingResponseBodies > 0
    || gapLedger.summary.unverifiedWrites > 0
  ));
  const scaffold = api.scaffold ?? { status: 'missing', present: false, path: null };
  const repairTasks = Array.isArray(scaffold.check?.repairTasks) ? [...scaffold.check.repairTasks] : [];
  for (const gapRepairTask of repairTasksFromGapLedger(siteId, gapLedger)) {
    if (!repairTasks.some(task => task?.kind === gapRepairTask.kind)) repairTasks.push(gapRepairTask);
  }
  const runtimeGaps = Array.isArray(delivery?.runtimeDataGaps) ? delivery.runtimeDataGaps : [];
  for (const task of runtimeDataRepairTasks(siteId, runtimeGaps, delivery)) {
    if (!repairTasks.some(item => item?.id === task.id)) repairTasks.push(task);
  }
  for (const task of businessRuleComparison.repairTasks ?? []) {
    if (!repairTasks.some(item => item?.id === task.id)) repairTasks.push(task);
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
      aiTask: scaffold.aiTask ?? { status: 'missing', schema: null, taskStatus: null, path: null },
      action: scaffoldAction,
      check: scaffold.check,
    },
    businessRules: businessRuleCheck,
    businessRuleComparison,
    runtimeDataGaps: runtimeGaps,
    runtimeDataGapsTruncated: delivery?.runtimeDataGapsTruncated === true,
    repairTasks,
    adapterEgress: {
      status: adapterServerEgress,
      basis: adapterServerEgress === 'not-tested' || adapterServerEgress === 'verified' ? 'observed' : 'unknown',
      evidence: delivery?.adapterEgressVerification?.status === 'verified'
        ? [delivery.adapterEgressVerification.report] : [],
      httpChecks: delivery?.adapterEgressVerification?.httpChecks ?? null,
      operationProbe,
    },
    gapLedger,
    unknowns: [
      { id: 'authentication', basis: 'unknown', detail: '哪些端点强制认证、凭据如何刷新和失效，尚未由摘要证明。' },
      { id: 'permissions', basis: 'unknown', detail: '不同账号、角色或资源边界的允许/拒绝矩阵尚未验证。' },
      { id: 'state-machine', basis: 'unknown', detail: '创建、更新、删除、回滚和刷新后的状态转换尚未验证。' },
      { id: 'business-rules', basis: businessRuleCheck.status === 'passed' ? 'observed' : 'unknown', detail: businessRuleCheck.status === 'passed'
        ? `已声明的 ${businessRuleCheck.passed} 条业务规则复测通过；未声明的边界、幂等、限流、排序、清理和副作用仍未知。`
        : '边界条件、幂等、限流、排序和业务校验规则尚未完成确定性复测。' },
      { id: 'side-effects', basis: 'unknown', detail: '持久化、消息、邮件、支付、Webhook 等副作用尚未验证。' },
      ...(gapLedger?.summary?.uniqueGaps > 0 ? [{ id: 'runtime-gaps', basis: 'observed', detail: `运行时记录了 ${gapLedger.summary.uniqueGaps} 个脱敏请求缺口，需要补路由或补录制。` }] : []),
      ...(gapLedger?.summary?.missingResponseBodies > 0 ? [{ id: 'missing-response-body', basis: 'observed', detail: `${gapLedger.summary.missingResponseBodies} 条已声明路由没有可回放的响应体。` }] : []),
      ...(gapLedger?.summary?.unverifiedWrites > 0 ? [{ id: 'unverified-write', basis: 'unknown', detail: `${gapLedger.summary.unverifiedWrites} 条写入路由只有回放证据，尚未证明真实写入和清理。` }] : []),
      ...(runtimeGaps.length ? [{ id: 'runtime-data-gaps', basis: 'observed', detail: `离线浏览器发现 ${runtimeGaps.length} 个未覆盖的 XHR/fetch 动态数据请求；响应内容仍需授权观察。` }] : []),
      ...(api.adapter.present && adapterServerEgress !== 'verified' ? [{
        id: 'adapter-server-egress', basis: adapterServerEgress === 'not-tested' ? 'observed' : 'unknown',
        detail: adapterServerEgress === 'not-tested'
          ? '适配器服务端外联尚未在无外联部署中验证；留出回放通过不等于独立部署安全。'
          : '没有可用的适配器服务端外联证据。',
      }] : []),
      ...(api.adapter.present && operationProbeStatus !== 'passed' ? [{
        id: 'adapter-operation-probe', basis: operationProbeStatus === 'blocked' ? 'observed' : 'unknown',
        detail: operationProbeStatus === 'blocked'
          ? '最终镜像中的授权浏览器操作复测有失败或未测流程。'
          : operationProbeStatus === 'invalid'
            ? '最终镜像操作复测报告存在不可用字段，不能作为交互证据。'
            : '没有最终镜像操作计划证据；点击、输入、导航和断言尚未复测。',
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
        { id: 'adapter-gap-ledger', status: gapLedger ? (gapLedgerHasOpenItems ? 'open' : 'observed') : 'blocked', basis: gapLedger ? 'observed' : 'unknown', condition: '运行适配器并读取 /__heimdall/adapter-gaps，确认没有新的未声明路径、未观察查询变体或未覆盖查询参数。' },
        { id: 'backend-scaffold-check', status: scaffoldCheckStatus, basis: scaffoldCheckStatus !== 'not_run' && scaffoldCheckStatus !== 'not-tested' ? 'observed' : 'unknown', condition: '运行完整脚手架 npm run check，确认服务健康、观察路由覆盖、状态码、MIME、响应结构和缺口账本都没有未完成项。' },
        { id: 'business-rules', status: businessRuleCheck.status,
          basis: businessRuleCheck.status === 'passed' || businessRuleCheck.status === 'failed' || businessRuleCheck.status === 'incomplete' ? 'observed' : 'unknown',
          condition: '运行 state-rules.json 中已人工确认的流程，检查每一步的状态码、MIME 和 JSON Pointer 断言。' },
        { id: 'business-rule-equivalence', status: businessRuleComparison.overall ?? (businessRuleComparison.status === 'invalid' ? 'not-tested' : businessRuleComparison.status === 'not_run' ? 'not-tested' : 'incomplete'),
          basis: ['passed', 'failed', 'incomplete'].includes(businessRuleComparison.overall) ? 'observed' : 'unknown',
          condition: '对照获授权源站与候选后端的同一份 business-rules-only 报告，确认候选规则逐条通过。' },
        { id: 'state-consistency', status: 'blocked', basis: 'unknown', condition: '同一业务流程中操作后再次读取/刷新仍保持预期状态。' },
        { id: 'offline-egress', status: adapterServerEgress === 'verified' ? 'passed' : 'blocked',
          basis: adapterServerEgress === 'verified' || adapterServerEgress === 'not-tested' ? 'observed' : 'unknown',
          condition: '最终适配器在无外联部署中通过断网浏览器验收。' },
        { id: 'operation-probe', status: operationProbeStatus,
          basis: operationProbeStatus === 'passed' || operationProbeStatus === 'blocked' ? 'observed' : 'unknown',
          condition: '在最终镜像文件系统上执行授权操作计划，确认点击、输入、导航和断言全部通过。' },
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
  const seoGeoTask = buildSeoGeoTask(siteId, origin, seo);
  const qaTask = buildQaTask(siteId, origin, qa, api, backendCompletion);
  const qaFindingEvidenceUnavailable = qa.status === 'observed' && qa.latest && qa.latest.findings?.status !== 'observed';
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
    const gapExamples = Array.isArray(clone.verificationGaps?.items)
      ? clone.verificationGaps.items.slice(0, 4).map(item => `${item.page}:${item.status}`).join('、') : '';
    add({
      id: 'clone-visual-verification', kind: 'visual_verification_gap', basis: 'unknown', status: 'open',
      title: '多视口验证不完整', detail: clone.unmeasured > 0
        ? `${clone.unmeasured} 页没有当前有效的多视口验证${gapExamples ? `（${gapExamples}）` : ''}。`
        : `验证扫描状态为 ${clone.verificationStatus}。`,
      evidence: [`clone.verification:${clone.verificationStatus}`, `clone.unmeasured:${clone.unmeasured}`, ...(gapExamples ? [`clone.verificationGaps:${gapExamples}`] : [])],
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
      action: plannedAction('cli:shell', { command: `heimdall live ${siteId} --offline --strict --heal --materialize-har${clone.delivery.root === 'mirror' ? ' --root mirror' : ''}` },
        '按已审核的资源策略修复候选包 health.json 阻断，再用同一根路径严格导出', { canAutoRun: true, requiresHumanApproval: false }),
      verify: planVerification(siteId, 'rerun strict offline export for current inputs; clone.delivery.status === "passed"'),
    });
  }
  const complexity = browserComplexitySummary(clone.delivery.browserCapabilities);
  if (complexity) {
    const signalText = complexity.signals.map(([name, count]) => `${name}=${count}`).join('、');
    const supportText = complexity.support?.signals?.map(item => `${item.id}=${item.status}`).join('、');
    const scopeText = complexity.signalPages !== null && complexity.pagesObserved !== null
      ? `${complexity.signalPages}/${complexity.pagesObserved} 个已观察页面` : '部分已观察页面';
    add({
      id: 'clone-page-complexity', kind: 'page_complexity_signal', basis: 'observed', status: 'open',
      title: '页面复杂度需要专项复测',
      detail: `离线浏览器在 ${scopeText} 观察到 ${signalText}${complexity.pagesTruncated ? '；页面样本已截断' : ''}${supportText ? `；候选包分类为 ${complexity.support.overall}（${supportText}）` : ''}。这些信号仍需按页复测 Shadow DOM、画布、嵌入内容或超长滚动，分类只覆盖候选包观察范围。`,
      evidence: [clone.delivery.healthReport, `browserCapabilities:${signalText}`].filter(Boolean),
      verify: { method: 'human_authorized_complexity_review', condition: '按页面信号完成对应专项复测，并把结果分别记录为 verified、observed 或 unknown' },
    });
  }
  if (clone.delivery.browserFailures?.length) {
    const externalFailures = clone.delivery.browserFailures.filter(failure => failure.kind === 'externalRequest');
    const localFailures = clone.delivery.browserFailures.filter(failure => failure.kind !== 'externalRequest');
    const failureExamples = failures => failures.slice(0, 4).map(failure => {
      const target = failure.target ? ` ${failure.target}` : '';
      const reason = failure.message || failure.error || failure.kind;
      return `${failure.page ?? '/'}: ${failure.kind}${target} — ${reason}`;
    }).join('；');
    if (externalFailures.length) add({
      id: 'clone-external-runtime', kind: 'external_runtime_gap', basis: 'observed', status: 'blocked',
      title: '离线页面仍依赖未审核的外部运行时',
      detail: `${externalFailures.length} 条 externalRequest：${failureExamples(externalFailures)}。逐个选择安全缓存、显式替换或继续阻断；不要把外链运行时当成源站后端缺口。`,
      evidence: [clone.delivery.healthReport].filter(Boolean),
      verify: { method: 'human_authorized_external_runtime_review', condition: '每个 externalRequest 都有批准的缓存、替换或阻断策略，并重新严格导出复测' },
    });
    if (localFailures.length) add({
      id: 'clone-browser-failures', kind: 'frontend_runtime_gap', basis: 'observed', status: 'blocked',
      title: '离线浏览器发现本地前端运行时错误',
      detail: `${localFailures.length} 条本地失败证据：${failureExamples(localFailures)}`,
      evidence: [clone.delivery.healthReport].filter(Boolean),
      action: plannedAction('cli:shell', {
        command: `heimdall live ${siteId} --offline --strict --heal --materialize-har${clone.delivery.root === 'mirror' ? ' --root mirror' : ''}`,
      }, '修复候选页面本地运行时错误后重新严格导出和复测', { requiresHumanApproval: true }),
      verify: planVerification(siteId, 'clone.delivery.browserFailures.filter(item => item.kind !== "externalRequest").length === 0'),
    });
  }
  if (clone.delivery.runtimeDataGaps?.length) {
    const examples = clone.delivery.runtimeDataGaps.slice(0, 4).map(gap => {
      const status = Number.isInteger(gap.status) ? ` ${gap.status}` : '';
      return `${gap.page ?? '/'}: ${gap.resourceType} ${gap.target}${status}`;
    }).join('；');
    add({
      id: 'clone-runtime-data-gaps', kind: 'runtime_data_gap', basis: 'observed', status: 'blocked',
      title: '离线页面仍依赖未覆盖的动态数据',
      detail: `${clone.delivery.runtimeDataGaps.length} 条同源 XHR/fetch 请求失败：${examples}${clone.delivery.runtimeDataGapsTruncated ? '；失败证据已截断' : ''}。先补授权观察或本地适配器，再重新严格交付。`,
      evidence: [clone.delivery.healthReport].filter(Boolean),
      action: capture,
      verify: planVerification(siteId, 'clone.delivery.runtimeDataGaps.length === 0'),
      repairTasks: runtimeDataRepairTasks(siteId, clone.delivery.runtimeDataGaps, clone.delivery),
      repairTasksTruncated: clone.delivery.runtimeDataGapsTruncated === true,
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
  const deploymentAttempt = clone.delivery.deploymentVerificationAttempt;
  if ((clone.delivery.status === 'passed' || deploymentAttempt) && clone.delivery.deploymentVerification?.status !== 'verified') {
    const failedAttempt = deploymentAttempt && deploymentAttempt.status !== 'invalid';
    const attemptDetail = failedAttempt
      ? `最近一次 ${deploymentAttempt.mode} 断网验收在 ${deploymentAttempt.stage} 阶段${deploymentAttempt.browserProbe?.causes ? `失败原因：${deploymentAttempt.browserProbe.causes}` : `结束为 ${deploymentAttempt.status}`}；该证据只用于定位，修复后仍须重新验证。`
      : 'strict 导出通过只证明候选包门禁通过；还需要在不含原工作区的 Docker network none 中启动两次并检查页面路由。';
    add({
      id: 'independent-deployment', kind: 'independent_deployment_gap',
      basis: clone.delivery.deploymentVerification || failedAttempt ? 'observed' : 'unknown', status: failedAttempt ? 'blocked' : 'open',
      title: failedAttempt ? '最近一次独立断网部署验收失败' : '最终包还没有独立断网部署证据',
      detail: clone.delivery.deploymentVerification?.status === 'invalid'
        ? '已有部署报告，但报告、包校验和或声明不再匹配。'
        : attemptDetail,
      evidence: [clone.delivery.report, clone.delivery.deploymentVerification?.report, deploymentAttempt?.report].filter(Boolean),
      action: plannedAction('cli:shell', {
        command: clone.delivery.status === 'passed'
          ? `heimdall live-verify <deliverable/${siteId}-包目录> --static --site-id ${siteId}`
          : `heimdall live ${siteId} --offline --strict --heal --materialize-har${clone.delivery.root === 'mirror' ? ' --root mirror' : ''}`,
      }, clone.delivery.status === 'passed' ? '在最终静态交付包中执行两次断网启动和页面路由检查' : '先修复严格离线交付，再重跑独立部署验收', { requiresHumanApproval: true }),
      verify: planVerification(siteId, 'clone.delivery.deploymentVerification.status === "verified"'),
    });
  }
  if (clone.mirrors && clone.delivery.status === 'passed' && clone.delivery.coverage?.scopeLimited === true) {
    const expandCapture = origin
      ? { url: `${origin}/`, scope: 'site', level: 'verified', allDiscovered: true }
      : { siteId, scope: 'site', level: 'verified', allDiscovered: true };
    add({
      id: 'clone-scope-limited', kind: 'clone_scope_gap', basis: 'observed', status: 'open',
      title: '站点克隆范围仍受限',
      detail: `当前离线包只覆盖 ${clone.delivery.coverage.scope ?? '未知'} 范围；strict 通过不代表站点全集已发现。先补齐侦察发现范围，再重新克隆、验证和导出。`,
      evidence: [`clone.delivery.coverage.scope:${clone.delivery.coverage.scope ?? 'unknown'}`, 'clone.delivery.coverage.scopeLimited:true'],
      action: plannedAction('heimdall_clone', expandCapture, '扩大到当前侦察发现的全部同源页面，再重新运行多视口和离线门禁'),
      verify: planVerification(siteId, 'clone.delivery.coverage.scope === "recon-discovered" && clone.delivery.coverage.scopeLimited === false'),
    });
  }

  const sitemapIncomplete = ['partial', 'unavailable'].includes(seo.completeness?.sitemapCoverage);
  const seoMethodIncomplete = seo.status === 'observed'
    && (seo.scoreMethodStatus !== 'current' || seo.measurementStatus !== 'current');
  const seoIncomplete = seo.status === 'observed'
    && (seo.completeness.failedPages > 0 || seo.completeness.initialHtmlUnchecked > 0 || sitemapIncomplete || seoMethodIncomplete || seo.geo.status !== 'complete');
  const seoHasIssues = seo.status === 'observed'
    && (seo.bySeverity.critical > 0 || seo.bySeverity.high > 0 || seo.geo.actionItems > 0);
  const sitemapEvidence = seo.sitemap?.reasons?.length
    ? ` sitemap 原因：${seo.sitemap.reasons.join('、')}。` : '';
  const methodEvidence = seoMethodIncomplete
    ? ` 评分口径状态：${seo.scoreMethodStatus}，测量口径状态：${seo.measurementStatus}。` : '';
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
        ? `报告包含未成功采集、未核对页面或过时评分口径，分数不能当成完整站点结论。${sitemapEvidence}${methodEvidence}`
        : `发现 critical=${seo.bySeverity.critical}、high=${seo.bySeverity.high}，GEO 待办 ${seo.geo.actionItems} 项。`,
      evidence: [seo.reports.json],
      action: origin ? plannedAction('heimdall_seo_audit', { url: `${origin}/` }, '补采完整报告并复核 SEO/GEO 待办') : null,
      verify: planVerification(siteId, 'seo.completeness.failedPages === 0 && seo.completeness.initialHtmlUnchecked === 0 && ["complete", "not_found"].includes(seo.completeness.sitemapCoverage) && seo.geo.status === "complete" && seo.geo.actionItems === 0 && seo.bySeverity.critical === 0 && seo.bySeverity.high === 0'),
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
        : api.contract.status === 'invalid' && ['origin_mismatch', 'origin_ambiguous'].includes(api.contract.reason)
          ? api.contract.reason === 'origin_ambiguous'
            ? '页面来源包含多个 origin，无法安全绑定契约，已拒绝把它当作本站 API 证据。'
            : '契约来源与当前站点页面来源不一致，已拒绝把它当作本站 API 证据。'
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
    || api.adapter.gapLedger.summary.unobservedQueryVariants > 0
    || api.adapter.gapLedger.summary.uncoveredQueryParameters > 0
    || api.adapter.gapLedger.summary.missingResponseBodies > 0
    || api.adapter.gapLedger.summary.unverifiedWrites > 0)) {
    add({
      id: 'api-adapter-gap-ledger', kind: 'b2_adapter_gap', basis: 'observed', status: 'open',
      title: '适配器缺口账本还有待处理项',
      detail: `未声明/未覆盖请求 ${api.adapter.gapLedger.summary.uniqueGaps} 个；未观察查询变体 ${api.adapter.gapLedger.summary.unobservedQueryVariants ?? 0} 个；未覆盖查询参数 ${api.adapter.gapLedger.summary.uncoveredQueryParameters ?? 0} 个；缺响应体 ${api.adapter.gapLedger.summary.missingResponseBodies} 条；未验证写入 ${api.adapter.gapLedger.summary.unverifiedWrites ?? 0} 条。`,
      evidence: [api.adapter.gapLedger.report].filter(Boolean),
      action: plannedAction('cli:shell', { command: `heimdall probe adapter --site ${siteId} --include-api-bodies --force` }, '按最新脱敏观察重新生成适配器，再复核缺口账本', { requiresHumanApproval: false }),
      verify: planVerification(siteId, 'api.adapter.gapLedger.summary.uniqueGaps === 0 && api.adapter.gapLedger.summary.unobservedQueryVariants === 0 && api.adapter.gapLedger.summary.uncoveredQueryParameters === 0 && api.adapter.gapLedger.summary.missingResponseBodies === 0 && api.adapter.gapLedger.summary.unverifiedWrites === 0'),
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
  const businessChecksStatus = qa.latest?.coverage?.businessChecks?.status;
  if (qa.status === 'observed' && (qa.latest?.completeness?.status === 'complete' && businessChecksStatus === 'not_declared'
    || businessChecksStatus === 'incomplete')) {
    const incomplete = businessChecksStatus === 'incomplete';
    add({
      id: 'qa-business-checks', kind: 'qa_business_checkpoint_gap', basis: incomplete ? 'observed' : 'unknown', status: incomplete ? 'blocked' : 'open',
      title: incomplete ? '业务检查点记录不完整' : '没有声明业务检查点',
      detail: incomplete
        ? '已有业务检查点记录，但至少一条缺少非空 id 或布尔 pass 结果；先修复检查证据，再判断认证、权限、接口响应、状态转换和业务规则。'
        : '当前运行只覆盖页面导航和无参照物检测；认证、权限、接口响应、状态转换和业务规则仍没有可核对的检查点。',
      evidence: [qa.latest.report].filter(Boolean),
      action: plannedAction('heimdall_qa_run', { ...(qaWorkspace ? { workspace: qaWorkspace } : {}), site: qa.site?.name }, incomplete ? '修复 checks 结构后重跑完整 QA' : '把已确认的业务流程和接口期望写入 checks 后重跑 QA', { requiresHumanApproval: true }),
      verify: { tool: 'heimdall_site_assessment', condition: 'qa.latest.coverage.businessChecks.status === "observed"' },
    });
  }
  if (qaFindingEvidenceUnavailable) {
    const findingsStatus = qa.latest.findings.status;
    add({
      id: 'qa-finding-evidence', kind: 'qa_business_checkpoint_gap', basis: 'unknown', status: 'blocked',
      title: findingsStatus === 'inconsistent' ? 'QA finding 摘要与详情不一致' : 'QA finding 详情不可用',
      detail: findingsStatus === 'inconsistent'
        ? '运行摘要的 fileable 数量与脱敏 finding 详情不一致；先恢复完整详情或重新运行 QA。'
        : '运行摘要无法替代逐条 finding 证据；先恢复脱敏详情或重新运行 QA。',
      evidence: [qa.latest?.report].filter(Boolean),
      action: plannedAction('heimdall_qa_findings', { ...(qaWorkspace ? { workspace: qaWorkspace } : {}), action: 'show', runId: qa.latest.runId }, '恢复逐条 QA finding 证据'),
      verify: { tool: 'heimdall_qa_findings', condition: 'qa.latest.findings.status === "observed"' },
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
  if (qa.status === 'observed' && qa.metrics?.decision) add(qaMetricsDecisionTask(qa.metrics, { workspace: qaWorkspace, site: qa.site?.name }));

  const counts = {
    total: items.length,
    open: items.filter(item => item.status === 'open').length,
    blocked: items.filter(item => item.status === 'blocked').length,
    unknown: items.filter(item => item.basis === 'unknown').length,
    canAutoRun: items.filter(item => item.action?.canAutoRun === true).length,
    requiresHumanApproval: items.filter(item => item.action?.requiresHumanApproval === true || item.status === 'blocked').length,
  };
  const nextStage = !clone.mirrors ? 'capture' : counts.blocked ? 'human_review' : counts.open ? 'ai_review_with_open_actions' : 'ready';
  const cloneTask = buildCloneTask(siteId, origin, clone, items);
  return {
    schema: 'heimdall.site-delivery-plan/1',
    decision: {
      basis: 'inferred',
      stage: nextStage,
      reason: nextStage === 'capture' ? '先补齐参考镜像。' : nextStage === 'human_review' ? '存在尚未通过的交付门禁，或需要人工确认的业务与 QA 前置条件。' : counts.open ? '已有足够证据进入 AI 处理，但仍有明确的补证或复核动作。' : '现有摘要覆盖了已声明的交付能力，可进入实现或复测。',
    },
    counts,
    items,
    cloneTask,
    backendCompletion,
    seoGeoTask,
    qaTask,
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
  const cloneScopeLimited = clone.delivery.coverage ? clone.delivery.coverage.scopeLimited === true : null;
  const cloneScopeReady = clone.delivery.coverage?.scope === 'recon-discovered' && !cloneScopeLimited;
  const cloneScope = entry(cloneScopeReady ? 'ready' : clone.delivery.coverage ? 'needs_scope_review' : 'unknown',
    clone.delivery.coverage ? 'observed' : 'unknown',
    [
      `clone.delivery.coverage.scope:${clone.delivery.coverage?.scope ?? 'unknown'}`,
      `clone.delivery.coverage.scopeLimited:${cloneScopeLimited ?? 'unknown'}`,
    ], item('clone-scope-limited'));
  const seoComplete = seo.status === 'observed'
    && seo.scoreMethodStatus === 'current' && seo.measurementStatus === 'current'
    && !['partial', 'unavailable'].includes(seo.completeness.sitemapCoverage)
    && seo.completeness.failedPages === 0 && seo.completeness.initialHtmlUnchecked === 0
    && seo.bySeverity.critical === 0 && seo.bySeverity.high === 0 && seo.geo.status === 'complete' && seo.geo.actionItems === 0;
  const seoStatus = seo.status !== 'observed' ? 'needs_report' : seoComplete ? 'ready' : 'needs_follow_up';
  const seoItem = item('seo-report', 'seo-geo-follow-up');
  const sitemapIncomplete = ['partial', 'unavailable'].includes(seo.completeness?.sitemapCoverage);
  const seoMethodIncomplete = seo.status === 'observed'
    && (seo.scoreMethodStatus !== 'current' || seo.measurementStatus !== 'current');
  const geoStatus = seo.status !== 'observed' || seo.geo.status === 'unknown' ? 'needs_report'
    : seo.geo.status !== 'complete' || sitemapIncomplete || seoMethodIncomplete || seo.geo.actionItems ? 'needs_follow_up' : 'ready';
  const backendObserved = api.contract.status !== 'missing' || api.adapter.present;
  const backendItem = item('api-contract', 'api-adapter', 'backend-scaffold', 'backend-scaffold-check', 'api-adapter-validation', 'api-adapter-gap-ledger', 'api-behavior-unknown');
  const qaItem = item('qa-workspace', 'qa-first-run', 'qa-incomplete', 'qa-finding-evidence', 'qa-findings', 'qa-metrics-decision');
  const qaReady = qa.status === 'observed' && qa.latest?.completeness?.status === 'complete'
    && qa.latest.findings?.status === 'observed' && qa.latest.summary.fileable === 0;
  return {
    schema: 'heimdall.site-readiness/1',
    stage: deliveryPlan.decision.stage,
    overall: overallForStage(deliveryPlan.decision.stage),
    clone: {
      ...entry(cloneStatus, cloneStatus === 'ready' ? 'verified' : clone.pages || clone.mirrors ? 'observed' : 'unknown',
        [`clone.mirrors:${clone.mirrors}/${clone.pages}`, `clone.verification:${clone.verificationStatus}`], cloneItem),
      scope: cloneScope,
      scopeLimited: cloneScopeLimited,
    },
    delivery: entry(clone.delivery.status === 'passed' ? 'last_check_passed'
      : clone.delivery.status === 'blocked' ? 'blocked' : clone.delivery.status === 'unverified' ? 'needs_strict_verification' : 'needs_export',
      clone.delivery.report ? 'observed' : 'unknown', [clone.delivery.report, clone.delivery.healthReport], item('clone-offline-delivery')),
    independentDeployment: entry(clone.delivery.deploymentVerification?.status === 'verified' ? 'verified'
      : clone.delivery.deploymentVerification?.status === 'invalid' ? 'invalid' : 'needs_verification',
      clone.delivery.deploymentVerification || clone.delivery.deploymentVerificationAttempt ? 'observed' : 'unknown',
      [clone.delivery.deploymentVerification?.report, clone.delivery.deploymentVerificationAttempt?.report], item('independent-deployment')),
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
    const expectedOrigin = pageSourceOrigin(root, pages);
    const seo = seoSummary(args.siteId, root, expectedOrigin);
    const api = apiSummary(root, args.siteId, expectedOrigin);
    const origin = siteOrigin(root, pages, seo, api, args.siteId);
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
    if ((clone.delivery.status === 'passed' || clone.delivery.deploymentVerificationAttempt) && clone.delivery.deploymentVerification?.status !== 'verified') {
      const attempt = clone.delivery.deploymentVerificationAttempt;
      unknowns.push({ id: 'independent-deployment-not-verified', detail: attempt?.status === 'failed'
        ? `最近一次独立部署验收在 ${attempt.stage} 阶段失败；修复后仍需用当前包校验和重新复测。`
        : '最终包还没有当前校验和绑定的 Docker network none 独立部署证据。' });
    }
    if (seo.status === 'missing') unknowns.push({ id: 'seo-report-missing', detail: '没有本地 SEO/GEO 报告。' });
    if (seo.status === 'invalid') unknowns.push({ id: 'seo-report-invalid', detail: 'SEO 报告存在但无法读取。' });
    if (seo.status === 'observed' && (seo.completeness.failedPages > 0 || seo.completeness.initialHtmlUnchecked > 0)) {
      unknowns.push({ id: 'seo-collection-incomplete', detail: 'SEO 报告包含未成功采集或未核对页面。' });
    }
    if (seo.status === 'observed' && ['partial', 'unavailable'].includes(seo.completeness.sitemapCoverage)) {
      const reasons = seo.sitemap?.reasons?.length ? ` 原因：${seo.sitemap.reasons.join('、')}。` : '';
      unknowns.push({ id: 'seo-sitemap-scope-limited', detail: `站点地图覆盖为 ${seo.completeness.sitemapCoverage}，站点范围仍需补采。${reasons}` });
    }
    if (seo.status === 'observed') {
      if (seo.outcomeEvidence?.search?.status !== 'observed') {
        unknowns.push({ id: 'seo-search-outcome-unknown', detail: '当前 SEO 证据没有可用的真实搜索结果、收录或排名实验。' });
      }
      if (seo.outcomeEvidence?.modelCitation?.status !== 'observed') {
        unknowns.push({ id: 'geo-model-citation-outcome-unknown', detail: '当前 GEO 证据没有可用的真实模型检索和引用命中实验。' });
      }
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
    const allNextActions = [...new Map(deliveryPlan.items
      .filter(item => item.action)
      .map(item => {
        const action = nextAction(item.action.tool, item.action.args, item.action.reason);
        return [JSON.stringify({ tool: action.tool, args: action.args ?? null }), action];
      }))
      .values()];
    const nextActions = allNextActions.slice(0, 5);
    const evidence = [];
    if (seo.status === 'observed') evidence.push({ kind: 'file', path: seo.reports.json });
    if (api.contract.path) evidence.push({ kind: 'file', path: api.contract.path });
    if (api.adapter.report) evidence.push({ kind: 'file', path: api.adapter.report });
    if (clone.delivery.report) evidence.push({ kind: 'file', path: clone.delivery.report });
    return ok({ siteId: args.siteId, origin, overall, readiness, clone: { ...clone, samplePages: clone.samplePages.slice(0, args.limit) }, seo, api, qa,
      deliveryPlan, claims: claimsOf(args.siteId, clone, seo, api, qa, unknowns), unknowns,
      nextActionsMeta: { total: allNextActions.length, returned: nextActions.length, truncated: allNextActions.length > nextActions.length } }, {
      summary: `${args.siteId}：${clone.mirrors}/${clone.pages} 页有镜像；多视口验证 ${clone.verified ?? 0} 页；离线交付 ${clone.delivery.status}；SEO ${seo.status}；API ${api.status}；QA ${qa.status}。`,
      nextActions, evidence,
    });
  },
};
