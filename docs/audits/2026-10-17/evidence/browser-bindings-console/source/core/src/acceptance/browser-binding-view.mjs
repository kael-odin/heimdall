/**
 * Display-only HTTP views for Browser source organization. These views neither
 * read source files nor reconstruct an approval/execution contract. Catalog
 * entities and digests retain their original, complete URL identities.
 */
export const BROWSER_BINDING_VIEW_VERSION = 1;
const ENVIRONMENT = ['platform', 'arch', 'nodeVersion', 'browser', 'browserVersion',
  'playwrightVersion', 'locale', 'timezoneId', 'colorScheme', 'reducedMotion'];
const DIGESTS = ['sourcePlanDigest', 'sourceReportDigest', 'evidenceManifestDigest',
  'selectedEvidenceManifestDigest', 'scopeKey', 'ruleManifestKey', 'oracleManifestKey',
  'environmentKey', 'verifierFingerprint'];
const SOURCE_CHANGED = '当前 Browser 所选来源无法重建已记录内容；历史归属保留，请检查原运行。';
const string = value => typeof value === 'string' ? value : '';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const scalar = value => value === null || ['string', 'boolean'].includes(typeof value)
  || typeof value === 'number' && Number.isFinite(value);
function scalarFields(value, fields) {
  const result = {};
  for (const field of fields) {
    const descriptor = value && Object.getOwnPropertyDescriptor(value, field);
    if (descriptor && Object.hasOwn(descriptor, 'value') && scalar(descriptor.value)) result[field] = descriptor.value;
  }
  return result;
}

/** A text label only: credentials, fragments and the entire query are omitted. */
export function browserBindingUrlView(value, { relative = false } = {}) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\u007f\\]/.test(value)) {
    return { display: null, queryPresent: false };
  }
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//');
    if (!relative && !absolute) return { display: null, queryPresent: false };
    const url = new URL(value, 'https://browser-display.invalid/');
    if (!['http:', 'https:'].includes(url.protocol)) return { display: null, queryPresent: false };
    const queryPresent = value.split('#', 1)[0].includes('?');
    return { display: `${absolute ? url.origin : ''}${url.pathname}${queryPresent ? '?[redacted]' : ''}`, queryPresent };
  } catch { return { display: null, queryPresent: false }; }
}
function sourceView(source) {
  const url = browserBindingUrlView(source?.entryUrl);
  return { runId: string(source?.runId), sourceMode: string(source?.sourceMode), side: string(source?.side),
    entryUrlDisplay: url.display, queryPresent: url.queryPresent };
}

/** Stored facts only; this helper deliberately does not establish source health. */
export function browserBindingSummaryView(binding) {
  return { id: string(binding.id), projectId: string(binding.projectId), releaseId: string(binding.releaseId),
    projectionVersion: number(binding.projectionVersion), source: sourceView(binding.source),
    sourceContentDigest: string(binding.sourceContentDigest), boundAt: string(binding.boundAt),
    actor: { kind: 'local-operator' } };
}
function detailBindingView(binding) {
  const result = browserBindingSummaryView(binding);
  for (const field of DIGESTS) result[field] = string(binding[field]);
  return result;
}
export function browserBindingStoredVerificationView() {
  return { scope: 'stored-record-only', currentSourceVerified: false };
}
export function browserBindingSummariesOf(catalog, projectId) {
  return Object.values(catalog.browserSourceBindings ?? {}).filter(binding => binding.projectId === projectId)
    .map(browserBindingSummaryView).sort((a, b) => a.boundAt === b.boundAt
      ? a.id < b.id ? 1 : a.id > b.id ? -1 : 0 : a.boundAt < b.boundAt ? 1 : -1);
}
export function browserBindingCollectionView(catalog, projectId) {
  return { viewVersion: BROWSER_BINDING_VIEW_VERSION, schemaVersion: catalog.schemaVersion,
    generationId: catalog.generationId, revision: catalog.revision, projectId,
    bindings: browserBindingSummariesOf(catalog, projectId),
    verification: browserBindingStoredVerificationView(), executionReady: false };
}
function evidenceView(evidence) {
  const result = {};
  for (const role of ['details', 'screenshot', 'repeat']) {
    const item = evidence?.[role], extension = role === 'details' ? 'json' : 'png';
    if (!item || typeof item.file !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,234}\.(?:png|json)$/i.test(item.file)
      || item.file.includes('..') || !item.file.toLowerCase().endsWith('.' + extension)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '')) {
      throw new TypeError('Invalid Browser evidence display metadata.');
    }
    result[role] = { file: item.file, bytes: item.bytes, sha256: item.sha256 };
  }
  return result;
}
function structureView(structure) {
  if (!structure) return null;
  return { title: string(structure.title), headings: (structure.headings ?? []).filter(value => typeof value === 'string'),
    controls: (structure.controls ?? []).map(control => {
      const href = browserBindingUrlView(control.href, { relative: true });
      return { ...scalarFields(control, ['path', 'tag', 'role', 'label', 'type', 'disabled', 'expanded', 'selected']),
        hrefDisplay: href.display, hrefQueryPresent: href.queryPresent };
    }) };
}
function observationView(observation) {
  const route = browserBindingUrlView(observation.slot?.route, { relative: true });
  const planned = browserBindingUrlView(observation.plannedUrl);
  const observed = browserBindingUrlView(observation.observedFinalUrl);
  const assertions = observation.expected?.observedAssertions;
  const expected = { httpStatus: number(observation.expected?.httpStatus),
    screenshotSha256: string(observation.expected?.screenshotSha256), structure: structureView(observation.expected?.structure) };
  if (Array.isArray(assertions)) expected.assertionSummary = { total: assertions.length,
    passed: assertions.filter(assertion => assertion.passed === true).length,
    checks: assertions.map(assertion => ({ kind: string(assertion.kind), passed: assertion.passed === true })) };
  return { slot: { routeDisplay: route.display, queryPresent: route.queryPresent,
    viewport: { width: number(observation.slot?.viewport?.width), height: number(observation.slot?.viewport?.height) },
    ...(typeof observation.slot?.pointId === 'string' ? { pointId: observation.slot.pointId } : {}) },
    ...scalarFields(observation, ['viewportName', 'title', 'severity']),
    plannedUrlDisplay: planned.display, plannedQueryPresent: planned.queryPresent,
    observedFinalUrlDisplay: observed.display, observedFinalQueryPresent: observed.queryPresent,
    finalUrlProof: 'redacted-observation-only', evidence: evidenceView(observation.evidence), expected,
    capture: { ...scalarFields(observation.capture, ['captureScope', 'captureLimited']),
      documentSize: { width: number(observation.capture?.documentSize?.width), height: number(observation.capture?.documentSize?.height) } },
    mask: scalarFields(observation.mask, ['maskedRatio', 'effectiveAreaPx', 'samplingCapped']),
    stability: number(observation.stability) };
}

/** An intentionally incomplete display preview, never an approval contract. */
export function browserBindingPreviewView(preview) {
  if (preview === null) return null;
  return { projectionVersion: number(preview.projectionVersion), mode: 'browser', sourceReference: sourceView(preview.sourceReference),
    ...scalarFields(preview, ['name', 'sourceStatus', 'sourceGate', 'declaredSlots', 'projectedSlots']),
    observations: (preview.observations ?? []).map(observationView), executionReady: false,
    oracleStorage: 'captured-side-evidence', environment: scalarFields(preview.environment, ENVIRONMENT),
    verifierFingerprint: string(preview.verifierFingerprint),
    urlProof: { planned: 'server-verified-exact-entry; display-query-hidden',
      observedFinal: 'redacted-observation-only; no complete redirect-chain or final-query proof' },
    presentation: { kind: 'organization-review', completeSourceProjection: false,
      omitted: ['raw-query', 'step-values', 'assertion-literals', 'rules'] },
    reviewNotice: '仅用于所选来源侧的组织核对。显示已隐藏整段查询参数、步骤值、断言字面量与规则；页面文字仍是不可信观察。此次核对不批准、选用或启动运行，也不证明部署冻结或最终完整查询参数。' };
}
function diagnosticsView(result) {
  const verified = result.preview !== null && result.diagnostics?.eligible === true && result.diagnostics?.contentMatches === true;
  return verified ? { eligible: true, contentMatches: true, issues: [] }
    : { eligible: false, contentMatches: false, issues: [{ code: 'BASELINE_CHANGED', message: SOURCE_CHANGED }] };
}
export function browserBindingReadView(result) {
  return { viewVersion: BROWSER_BINDING_VIEW_VERSION, generationId: result.generationId, revision: result.revision,
    binding: detailBindingView(result.binding), preview: browserBindingPreviewView(result.preview),
    diagnostics: diagnosticsView(result), executionReady: false };
}
export function browserBindingMutationView(result) {
  if (result.event?.kind !== 'browser-source-bound') throw new TypeError('Invalid Browser binding event.');
  const view = browserBindingReadView({ generationId: result.generationId, revision: result.revision,
    binding: result.binding, preview: result.preview, diagnostics: { eligible: true, contentMatches: true } });
  view.event = { ...scalarFields(result.event, ['id', 'revision', 'projectId', 'entityId', 'entityDigest', 'at']),
    kind: 'browser-source-bound', actor: { kind: 'local-operator' } };
  return view;
}
