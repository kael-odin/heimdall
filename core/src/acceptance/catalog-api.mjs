/** HTTP projection for local project/release/history bindings; no runner actions. */
import { currentSelectionsOf } from './catalog-schema.mjs';
import { browserBindingCollectionView, browserBindingMutationView, browserBindingReadView,
  browserBindingStoredVerificationView, browserBindingSummariesOf } from './browser-binding-view.mjs';
import { browserCandidateCollectionView, browserCandidateSupportOf } from './browser-candidate-review.mjs';
const ROOT = '/api/acceptance/projects';
const PROJECT_ID = /^ap-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANDIDATE_ID = /^ab-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BROWSER_BINDING_ID = /^ax-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BROWSER_CANDIDATE_ID = /^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITES = Object.freeze({ releases: 'createRelease', 'run-bindings': 'bindRun',
  'baseline-candidates': 'createBaselineCandidate', 'baseline-approvals': 'approveBaseline', 'baseline-selections': 'selectBaseline',
  'browser-source-bindings': 'bindBrowserSource', 'browser-baseline-candidates': 'createBrowserBaselineCandidate' });
const MESSAGES = Object.freeze({
  INVALID_INPUT: '目录请求参数无效，请核对输入。',
  NOT_FOUND: '所选项目、版本或运行不存在。',
  STALE_REVISION: '目录已更新，请刷新并重新核对后操作。',
  STALE_GENERATION: '目录身份已变化，请刷新并重新核对后操作。',
  CATALOG_GENERATION_CHANGED: '目录身份已变化，请刷新并重新核对后操作。',
  PROJECT_MISMATCH: '运行、版本或项目归属不一致。',
  CONTEXT_ALREADY_BOUND: '此运行已经归属其他上下文，不能重新认领。',
  SOURCE_INTEGRITY_FAILED: '来源记录无法核验，请检查原运行。',
  SOURCE_NOT_ELIGIBLE: '来源不符合当前操作要求。',
  BASELINE_CHANGED: '来源内容已变化，请重新复核。',
  CANDIDATE_ALREADY_EXISTS: '此 Browser 来源已有候选，请先核对已存记录。',
  CATALOG_MIGRATION_REQUIRED: 'Browser 候选需要 Schema4，请先停止同根引擎并显式预览、确认维护。',
  SELECTION_UNCHANGED: '当前选用未变化，无需重复提交。',
  CATALOG_CAPACITY: '目录已达到容量上限，请保留历史并检查目录配置。',
  CATALOG_QUEUE_FULL: '目录写入队列已满，请稍后重试。',
  CATALOG_CORRUPT: '目录记录损坏，已保留原件，请检查目录。',
  CATALOG_UNAVAILABLE: '目录暂时不可用，请稍后重试。',
  ACCEPTANCE_OWNER_UNAVAILABLE: '验收目录正由其他引擎使用，或无法安全确认目录所有权。',
  ACCEPTANCE_OWNER_LOST: '验收目录所有权已失效，请停止当前引擎后重试。',
});

export function acceptanceCatalogError(error) {
  const known = Object.hasOwn(MESSAGES, error?.code);
  const code = known ? error.code : 'CATALOG_UNAVAILABLE';
  const status = known && [400, 404, 409, 413, 503].includes(error.status) ? error.status : 503;
  const payload = { code, error: MESSAGES[code] };
  const generation = error?.currentGenerationId ?? error?.details?.generationId;
  const revision = error?.currentRevision ?? error?.details?.revision;
  if (Number.isSafeInteger(revision) && revision >= 0) payload.currentRevision = revision;
  if (typeof generation === 'string' && /^ag-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(generation)) {
    payload.currentGenerationId = generation;
  }
  if (known && error?.details && typeof error.details === 'object') {
    const details = {};
    if (payload.currentGenerationId) details.generationId = payload.currentGenerationId;
    if (payload.currentRevision !== undefined) details.revision = payload.currentRevision;
    if (typeof error.details.reason === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.details.reason)) details.reason = error.details.reason;
    if (typeof error.details.limit === 'string' && ['jsonBytes', 'projects', 'releases', 'runBindings', 'browserSourceBindings', 'browserCandidates', 'browserCandidateBytes', 'candidates', 'approvals', 'selections', 'migrations', 'events', 'queue'].includes(error.details.limit)) details.limit = error.details.limit;
    if (error.code === 'CANDIDATE_ALREADY_EXISTS' && typeof error.details.existingCandidateId === 'string'
      && BROWSER_CANDIDATE_ID.test(error.details.existingCandidateId)) details.existingCandidateId = error.details.existingCandidateId;
    if (Object.keys(details).length) payload.details = details;
  }
  return { status, payload };
}
const invalid = () => Object.assign(new Error('invalid catalog input'), { code: 'INVALID_INPUT', status: 400 });

function bodyOf(req, maxBytes = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0, oversized = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { oversized = true; chunks.length = 0; }
      else if (!oversized) chunks.push(chunk);
    });
    req.once('error', () => reject(invalid()));
    req.once('end', () => {
      if (oversized) return reject(Object.assign(invalid(), { status: 413 }));
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
        resolve(value);
      } catch { reject(invalid()); }
    });
  });
}
function bindingsOf(catalog, projectId) {
  return Object.values(catalog.runBindings).filter(binding => !projectId || binding.projectId === projectId).map(binding => ({
    ...binding, projectName: catalog.projects[binding.projectId]?.name ?? '', releaseLabel: catalog.releases[binding.releaseId]?.label ?? '',
  }));
}

/** Authentication must be checked by the engine before invoking this router. */
export async function handleAcceptanceCatalogRequest(req, res, url, { catalog, json }) {
  if (url.pathname !== ROOT && !url.pathname.startsWith(ROOT + '/')) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const send = (status, payload) => { json(res, status, payload); return true; };
  try {
    const segments = url.pathname === ROOT ? [] : url.pathname.slice(ROOT.length + 1).split('/');
    if (segments.length && !PROJECT_ID.test(segments[0])) throw invalid();
    const candidateRead = segments.length === 3 && segments[1] === 'baseline-candidates';
    const browserRead = segments.length === 3 && segments[1] === 'browser-source-bindings';
    const browserCollection = segments.length === 2 && segments[1] === 'browser-source-bindings';
    const browserCandidateCollection = segments.length === 2 && segments[1] === 'browser-baseline-candidates';
    const browserCandidateRead = segments.length === 3 && segments[1] === 'browser-baseline-candidates';
    const browserCandidatePreview = segments.length === 4 && segments[1] === 'browser-source-bindings' && segments[3] === 'candidate-preview';
    const browserPreviewImage = segments.length === 6 && segments[1] === 'browser-source-bindings'
      && segments[3] === 'candidate-preview' && segments[4] === 'evidence';
    const browserCandidateImage = segments.length === 5 && segments[1] === 'browser-baseline-candidates' && segments[3] === 'evidence';
    const image = browserPreviewImage || browserCandidateImage;
    const allowedQuery = image ? ['token', 'expectedContentDigest'] : ['token'];
    if ([...url.searchParams.keys()].some(key => !allowedQuery.includes(key))
      || allowedQuery.some(key => url.searchParams.getAll(key).length > 1)) throw invalid();
    if (image && !/^[a-f0-9]{64}$/.test(url.searchParams.get('expectedContentDigest') ?? '')) throw invalid();
    if (segments.length > 3 && !browserCandidatePreview && !image
      || segments.length === 3 && !candidateRead && !browserRead && !browserCandidateRead
      || browserRead && !segments[2]
      || segments.length === 2 && !Object.hasOwn(WRITES, segments[1])) {
      return send(404, { code: 'NOT_FOUND', error: MESSAGES.NOT_FOUND });
    }
    if (candidateRead && !CANDIDATE_ID.test(segments[2])) throw invalid();
    if (browserRead && !BROWSER_BINDING_ID.test(segments[2])) throw invalid();
    if ((browserCandidatePreview || browserPreviewImage) && !BROWSER_BINDING_ID.test(segments[2])) throw invalid();
    if ((browserCandidateRead || browserCandidateImage) && !BROWSER_CANDIDATE_ID.test(segments[2])) throw invalid();
    const file = browserPreviewImage ? segments[5] : browserCandidateImage ? segments[4] : null;
    if (image && !/^[a-z0-9][a-z0-9_.-]{0,234}\.png$/i.test(file)) throw invalid();
    const allowed = candidateRead || browserRead || browserCandidateRead || browserCandidatePreview || image ? ['GET'] : browserCollection || browserCandidateCollection ? ['GET', 'POST']
      : segments.length < 2 ? ['GET', ...(segments.length ? [] : ['POST'])] : ['POST'];
    if (!allowed.includes(req.method)) {
      res.setHeader('Allow', allowed.join(', '));
      return send(405, { code: 'METHOD_NOT_ALLOWED', error: '此目录接口不支持该请求方法。' });
    }
    if (req.method === 'GET') {
      if (image) {
        const input = { file, expectedContentDigest: url.searchParams.get('expectedContentDigest') };
        const captured = browserPreviewImage
          ? catalog.readBrowserCandidatePreviewEvidence(segments[0], segments[2], input)
          : catalog.readBrowserBaselineCandidateEvidence(segments[0], segments[2], input);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', captured.bytes.length);
        res.setHeader('X-Content-SHA256', captured.sha256);
        res.end(captured.bytes); return true;
      }
      if (browserCandidatePreview) return send(200, catalog.previewBrowserBaselineCandidate(segments[0], segments[2]));
      if (browserCandidateRead) return send(200, catalog.readBrowserBaselineCandidate(segments[0], segments[2]));
      if (candidateRead) return send(200, catalog.readBaselineCandidate(segments[0], segments[2]));
      if (browserRead) return send(200, browserBindingReadView(catalog.readBrowserSourceBinding(segments[0], segments[2])));
      const value = catalog.read();
      const common = { schemaVersion: value.schemaVersion, generationId: value.generationId, revision: value.revision };
      if (!segments.length) return send(200, { ...common, projects: Object.values(value.projects), runBindings: bindingsOf(value) });
      const projectId = segments[0], project = value.projects[projectId];
      if (!project) return send(404, { code: 'NOT_FOUND', error: MESSAGES.NOT_FOUND });
      if (browserCandidateCollection) {
        if (value.schemaVersion !== 4) throw Object.assign(new Error('Schema4 required'), {
          code: 'CATALOG_MIGRATION_REQUIRED', status: 409, details: { reason: 'SCHEMA4_REQUIRED' } });
        return send(200, browserCandidateCollectionView(value, projectId));
      }
      if (browserCollection) return send(200, browserBindingCollectionView(value, projectId));
      const runBindings = bindingsOf(value, projectId).map(binding => {
        try { return { ...binding, ...catalog.readRunReference(binding.runId) }; }
        catch { return { ...binding, source: null, diagnostics: { scope: 'manifest-only', manifestValid: false,
          reportPresent: false, reportDigestRecorded: false, evidenceVerified: false,
          issues: [{ code: 'SOURCE_UNAVAILABLE', message: '来源运行不可读取；目录归属不代表证据已核验。' }] } }; }
      });
      return send(200, { ...common, project, releases: Object.values(value.releases).filter(release => release.projectId === projectId),
        runBindings, events: value.events.filter(event => event.projectId === projectId),
        candidates: Object.values(value.candidates ?? {}).filter(item => item.projectId === projectId),
        approvals: Object.values(value.approvals ?? {}).filter(item => item.projectId === projectId),
        selections: Object.values(value.selections ?? {}).filter(item => item.projectId === projectId),
        currentSelections: currentSelectionsOf(value, projectId),
        browserSourceBindings: browserBindingSummariesOf(value, projectId),
        browserSourceVerification: browserBindingStoredVerificationView(),
        browserCandidates: value.schemaVersion === 4 ? browserCandidateCollectionView(value, projectId).browserCandidates : [],
        browserCandidateSupport: browserCandidateSupportOf(value), executionReady: false });
    }
    const input = await bodyOf(req);
    const result = !segments.length ? await catalog.createProject(input) : await catalog[WRITES[segments[1]]](segments[0], input);
    return send(201, browserCollection ? browserBindingMutationView(result) : result);
  } catch (error) {
    const failure = acceptanceCatalogError(error);
    return send(failure.status, failure.payload);
  }
}
