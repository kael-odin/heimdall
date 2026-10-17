<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders } from './api.js';
import { catalogFailure } from './acceptance-catalog.js';
import { GATE_LABELS } from './acceptance-workbench.js';
import { browserCandidateHistory, browserCandidateReviewState, buildBrowserCandidateInput,
  createBrowserCandidateReadGuard, fetchBrowserCandidateEvidence } from './acceptance-browser-candidates.js';

const props = defineProps({
  projectId: { type: String, required: true }, detail: { type: Object, default: null }, version: { type: Object, default: null },
  selection: { type: Object, default: null }, facts: { type: Array, default: () => [] }, ready: Boolean, active: Boolean,
  requiresReconcile: Boolean, writing: { type: String, default: '' }, request: { type: Function, required: true },
  write: { type: Function, required: true }, reconcileWrite: { type: Function, required: true },
});
const emit = defineEmits(['reconcile']);
const sourceBindingId = ref(''), candidateId = ref(''), state = ref(null), loading = ref(false), confirmed = ref(false);
const error = ref(null), notice = ref(''), errorElement = ref(null), reviewElement = ref(null), reconciling = ref(false);
const opened = reactive(new Set()), guard = createBrowserCandidateReadGuard();
const evidence = ref(null);
let readController, evidenceController, selectionEpoch = 0, evidenceEpoch = 0, stopped = false;
const historyState = computed(() => {
  if (!props.detail) return { candidates: [], available: false, error: '' };
  try { return { ...browserCandidateHistory(props.detail, props.projectId), error: '' }; }
  catch (problem) { return { candidates: [], available: false, error: problem.message }; }
});
const candidates = computed(() => historyState.value.candidates);
const selectedFact = computed(() => props.facts.find(value => value.projectId === props.projectId && value.sourceBindingId === sourceBindingId.value));
const pendingFacts = computed(() => props.facts.filter(value => value.projectId === props.projectId && value.phase === 'unknown'));
const currentReview = computed(() => state.value?.review);
const canSave = computed(() => props.ready && props.active && !loading.value && !!state.value?.canConfirm && confirmed.value
  && !['unknown', 'submitting', 'confirmed'].includes(selectedFact.value?.phase));
const rawBlocks = computed(() => state.value?.review ? [
  { key: 'organizationContext', label: '完整组织上下文', value: state.value.value.organizationContext },
  { key: 'sourceProjection', label: '完整来源投影与摘要', value: state.value.value.sourceProjection },
  ...[['scope', '检查范围'], ['rules', '完整检查规则'], ['selectedOracles', '所选侧验收参考'],
    ['selectedEvidence', '所选侧证据清单'], ['verifiedEvidence', '全部核验证据清单'],
    ['environment', '捕获环境'], ['urlProof', 'URL 证明边界'], ['limitations', '合同限制说明']]
    .map(([key, label]) => ({ key, label, value: state.value.review[key] })),
] : []);
const pretty = value => JSON.stringify(value, null, 2);
const sideLabel = side => side === 'baseline' ? 'baseline · 原比较基线侧' : 'target · 原比较目标侧';
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const context = () => ({ projectId: props.projectId, sourceBindingId: sourceBindingId.value, candidateId: candidateId.value,
  generationId: props.version?.generationId, revision: props.version?.revision, selectionEpoch });
function clearEvidence() {
  evidenceEpoch++; evidenceController?.abort(); evidenceController = undefined;
  if (evidence.value?.url) URL.revokeObjectURL(evidence.value.url);
  evidence.value = null;
}
function clearReview({ close = false } = {}) {
  selectionEpoch++; readController?.abort(); guard.invalidate(); state.value = null; loading.value = false;
  confirmed.value = false; opened.clear(); clearEvidence();
  if (close) { sourceBindingId.value = ''; candidateId.value = ''; }
}
function closeReview() { clearReview({ close: true }); error.value = null; notice.value = ''; }
async function showError(problem) {
  error.value = catalogFailure(problem); await nextTick(); errorElement.value?.focus({ preventScroll: true });
}
async function loadReview() {
  if (!props.ready || !props.active || !historyState.value.available || !sourceBindingId.value || stopped) return;
  clearReview(); error.value = null; notice.value = '';
  const controller = new AbortController(); readController = controller;
  const stamp = context(), ticket = guard.next(stamp); loading.value = true;
  const endpoint = stamp.candidateId ? `browser-baseline-candidates/${encodeURIComponent(stamp.candidateId)}`
    : `browser-source-bindings/${encodeURIComponent(stamp.sourceBindingId)}/candidate-preview`;
  try {
    const value = await props.request(`/${encodeURIComponent(stamp.projectId)}/${endpoint}`, { signal: controller.signal });
    if (controller.signal.aborted || !guard.accepts(ticket, context())) return;
    state.value = browserCandidateReviewState(value, { ...stamp, version: props.version });
  } catch (problem) {
    if (!stopped && !controller.signal.aborted && guard.accepts(ticket, context())) {
      if (problem.status === 409 || problem.code === 'STALE_REVISION') emit('reconcile', problem);
      await showError(problem);
    }
  } finally { if (!stopped && guard.accepts(ticket, context())) loading.value = false; }
}
async function openReview(bindingId, storedId = '') {
  if (!props.ready || !props.active || stopped) return;
  clearReview({ close: true }); sourceBindingId.value = bindingId; candidateId.value = storedId;
  await nextTick(); reviewElement.value?.focus({ preventScroll: true }); await loadReview();
}
function toggleRaw(key, event) { if (event.target.open) opened.add(key); else opened.delete(key); }
function toggleObservation(index, event) {
  toggleRaw(`observation-${index}`, event);
  if (!event.target.open && evidence.value?.index === index) clearEvidence();
}
async function loadEvidence(index, role) {
  const fullState = state.value, observation = fullState?.review?.observations[index];
  if (!observation || !props.ready || !props.active || stopped) return;
  clearEvidence(); const epoch = evidenceEpoch, stamp = context(), controller = new AbortController();
  evidenceController = controller; const item = { index, role, loading: true, error: '', url: '' }; evidence.value = item;
  const accepts = () => !stopped && !controller.signal.aborted && epoch === evidenceEpoch && state.value === fullState
    && stamp.selectionEpoch === selectionEpoch && props.active && stamp.generationId === props.version?.generationId
    && stamp.revision === props.version?.revision;
  try {
    const result = await fetchBrowserCandidateEvidence({ state: fullState, metadata: observation.evidence[role], role,
      baseUrl: API, headers: apiHeaders(), signal: controller.signal });
    if (accepts()) evidence.value = { ...item, loading: false, url: URL.createObjectURL(result.blob) };
  } catch (problem) {
    if (accepts()) evidence.value = { ...item, loading: false, error: problem.code === 'EVIDENCE_CHANGED' ? problem.message : '截图读取或大小、SHA-256 核对失败，请重新读取完整合同。' };
  } finally { if (evidenceController === controller) evidenceController = undefined; }
}
async function saveCandidate() {
  if (!canSave.value || stopped) return;
  const stamp = context(), selected = state.value;
  const stillSelected = () => !stopped && props.projectId === stamp.projectId
    && sourceBindingId.value === stamp.sourceBindingId && selectionEpoch === stamp.selectionEpoch;
  error.value = null; notice.value = ''; confirmed.value = false;
  try {
    const body = buildBrowserCandidateInput({ sourceBindingId: stamp.sourceBindingId, contentDigest: selected.value.contentDigest, confirmed: true }, props.version, selected);
    const result = await props.write(body, stamp.projectId);
    if (stillSelected()) {
      clearReview({ close: true });
    }
    if (!stopped && props.projectId === stamp.projectId) notice.value = `Browser 候选 ${result.value.candidate.id} 已记录。${result.refreshed ? '可从候选记录重新核对完整合同。' : '写入已确认，列表待刷新。'}`;
  } catch (problem) {
    if (!stopped && props.projectId === stamp.projectId && (!sourceBindingId.value || stillSelected())) {
      clearReview();
      const existing = problem.code === 'CANDIDATE_ALREADY_EXISTS' ? problem.details?.existingCandidateId : '';
      if (typeof existing === 'string' && /^bc-[a-f0-9-]{36}$/.test(existing)) candidateId.value = existing;
      await showError(problem);
    }
  }
}
async function reconcileCandidate(bindingId) {
  if (reconciling.value || props.writing || stopped) return;
  clearReview({ close: true }); error.value = null; reconciling.value = true;
  const projectId = props.projectId;
  try {
    const result = await props.reconcileWrite(projectId, bindingId);
    if (!stopped && projectId === props.projectId) notice.value = result.phase === 'confirmed'
      ? `集合已确认候选 ${result.candidateId} 已记录。请从候选列表重新读取。`
      : '候选集合未找到本次内容。目录已重新读取；请重新打开完整合同并明确确认后再提交。';
  } catch (problem) { if (!stopped && projectId === props.projectId) await showError(problem); }
  finally { if (!stopped) reconciling.value = false; }
}
watch(() => [props.projectId, props.detail, props.version?.generationId, props.version?.revision, props.requiresReconcile], () => {
  clearReview({ close: true }); error.value = null; notice.value = '';
}, { flush: 'sync' });
watch(() => props.active, value => { if (!value) closeReview(); }, { flush: 'sync' });
watch(() => props.ready, value => { if (!value) clearReview({ close: true }); }, { flush: 'sync' });
watch(() => props.selection, value => { if (value) openReview(value.sourceBindingId, value.candidateId); }, { flush: 'post' });
onBeforeUnmount(() => { stopped = true; clearReview({ close: true }); guard.stop(); });
</script>

<template>
  <section class="browser-candidates" data-testid="browser-candidates" aria-labelledby="browser-candidate-title">
    <div class="candidate-heading"><div><h3 id="browser-candidate-title">Browser 验收候选</h3><p class="candidate-muted">保存一侧完整合同，供后续验收能力继续搭建。候选尚不具备执行或放行资格。</p></div><span class="candidate-count">{{ candidates.length }} 条记录</span></div>
    <p v-if="!detail" class="candidate-muted" role="status">正在读取候选目录…</p>
    <p v-else-if="!historyState.available" class="candidate-maintenance" data-testid="browser-candidate-maintenance">{{ historyState.error || '当前目录为 schema 3。Browser 候选需要维护者显式升级到 schema 4；此界面不会自动迁移。' }}</p>
    <template v-else>
      <ol v-if="candidates.length" class="candidate-history"><li v-for="candidate in candidates" :key="candidate.id" data-testid="browser-candidate-row" :data-candidate-id="candidate.id" :data-source-binding-id="candidate.sourceBindingId"><div class="candidate-row"><strong>{{ detail.releases?.find(value => value.id === candidate.releaseId)?.label || candidate.releaseId }}</strong><button type="button" class="candidate-button" :disabled="!ready || !active" data-testid="browser-candidate-open" :data-candidate-id="candidate.id" @click="openReview(candidate.sourceBindingId, candidate.id)">核对已保存合同</button></div><p><code>{{ candidate.id }}</code> · {{ dateLabel(candidate.createdAt) }}</p><p class="candidate-muted">来源 <code>{{ candidate.sourceBindingId }}</code></p><p class="candidate-muted">内容摘要 <code>{{ candidate.contentDigest }}</code></p></li></ol>
      <p v-else class="candidate-empty">尚无 Browser 候选。先在上方已归属来源中打开完整合同。</p>
    </template>
    <div v-for="fact in pendingFacts" :key="fact.sourceBindingId" class="candidate-pending"><p>此来源的写入结果未知：<code>{{ fact.sourceBindingId }}</code>。重新打开合同也不会重发。</p><button type="button" class="candidate-button" data-testid="browser-candidate-reconcile" :disabled="!!writing || reconciling" @click="reconcileCandidate(fact.sourceBindingId)">{{ reconciling ? '正在核对集合…' : '读取候选集合并核对结果' }}</button></div>
    <p v-if="notice" class="candidate-notice" role="status" data-testid="browser-candidate-notice">{{ notice }}</p>
    <div v-if="error" ref="errorElement" class="candidate-error" tabindex="-1" role="alert" data-testid="browser-candidate-error"><strong>{{ error.message }}</strong><p><code>{{ error.code }}</code><span v-if="error.status"> · HTTP {{ error.status }}</span></p></div>
    <section v-if="sourceBindingId" ref="reviewElement" class="candidate-review" tabindex="-1" data-testid="browser-candidate-review" :data-source-binding-id="sourceBindingId" :data-candidate-id="candidateId" aria-labelledby="browser-candidate-review-title" :aria-busy="loading">
      <div class="candidate-row"><h4 id="browser-candidate-review-title">{{ candidateId ? '已保存的完整候选合同' : '记录前完整合同复核' }}</h4><button type="button" class="candidate-button" data-testid="browser-candidate-close" @click="closeReview">关闭合同</button></div>
      <p class="candidate-muted">来源 <code>{{ sourceBindingId }}</code></p>
      <p v-if="loading" class="candidate-loading" role="status">正在重新核验来源并读取完整合同…</p>
      <template v-else-if="state">
        <div data-testid="browser-candidate-diagnostics" :class="state.review ? 'candidate-valid' : 'candidate-warning'"><p>{{ state.review ? '完整合同已读取，组织上下文、所选侧范围和证据引用齐全。' : '当前来源无法重建候选合同。已保存的候选记录保留。' }}</p><ul v-if="state.diagnostics.issues.length"><li v-for="(issue, index) in state.diagnostics.issues" :key="index"><code>{{ issue.code }}</code> {{ issue.message }}</li></ul></div>
        <template v-if="currentReview">
          <p class="candidate-side"><strong>{{ sideLabel(state.sourceBinding.source.side) }}</strong><span>只采用这一侧的采集内容</span></p>
          <dl class="candidate-facts"><div><dt>项目 / 版本</dt><dd>{{ state.project.name }} / {{ state.release.label }}</dd></div><div><dt>原运行</dt><dd><code>{{ state.sourceBinding.source.runId }}</code> · {{ currentReview.sourcePlan.mode }}</dd></div><div><dt>检查覆盖</dt><dd>{{ currentReview.projectedSlots }} / {{ currentReview.declaredSlots }} 个槽位 · {{ currentReview.observations.length }} 条观察 · 原比较 {{ GATE_LABELS[currentReview.sourceGate] || currentReview.sourceGate }}</dd></div><div><dt>baseline 入口</dt><dd><code>{{ currentReview.sourcePlan.baselineUrl }}</code></dd></div><div><dt>target 入口</dt><dd><code>{{ currentReview.sourcePlan.targetUrl }}</code></dd></div></dl>
          <p class="candidate-muted">以下保留查询参数、步骤、断言和规则的完整字面量；仅以文本显示。计划、规则、观察及清单均未截断。</p>
          <details class="candidate-raw" data-testid="browser-candidate-plan" @toggle="toggleRaw('plan', $event)"><summary>完整标准化计划 · {{ currentReview.sourcePlan.routes.length }} 条路由 / {{ currentReview.sourcePlan.viewports.length }} 个视口 / {{ currentReview.sourcePlan.points.length }} 个行为点</summary><pre v-if="opened.has('plan')" data-testid="browser-candidate-plan-json">{{ pretty(currentReview.sourcePlan) }}</pre></details>
          <details v-for="block in rawBlocks" :key="block.key" class="candidate-raw" :data-testid="'browser-candidate-raw-' + block.key" @toggle="toggleRaw(block.key, $event)"><summary>{{ block.label }}</summary><pre v-if="opened.has(block.key)" :data-testid="'browser-candidate-raw-' + block.key + '-json'">{{ pretty(block.value) }}</pre></details>
          <div class="candidate-observation-heading"><h4>所选侧全部采集观察</h4><p class="candidate-muted">展开后可阅读原始合同字段，并按需核对保存截图。</p></div>
          <ol class="candidate-observations"><li v-for="(observation, index) in currentReview.observations" :key="index"><details data-testid="browser-candidate-observation" :data-observation-index="index" @toggle="toggleObservation(index, $event)"><summary><strong>{{ observation.title || '页面采集' }}</strong><span>{{ observation.slot.route }} · {{ observation.viewportName }} {{ observation.slot.viewport.width }} × {{ observation.slot.viewport.height }}</span></summary><template v-if="opened.has('observation-' + index)"><pre data-testid="browser-candidate-observation-json" :data-observation-index="index">{{ pretty(observation) }}</pre><div class="candidate-actions"><button v-for="role in ['screenshot', 'repeat']" :key="role" type="button" class="candidate-button" :disabled="!ready || !active || evidence?.loading" :data-testid="'browser-candidate-evidence-' + role" :data-observation-index="index" @click="loadEvidence(index, role)">{{ role === 'screenshot' ? '查看所选侧截图' : '查看所选侧重复截图' }}</button></div><div v-if="evidence?.index === index" class="candidate-evidence"><p v-if="evidence.loading" role="status" class="candidate-muted">正在读取并核对图片大小与 SHA-256…</p><p v-else-if="evidence.error" class="candidate-warning" role="alert" data-testid="browser-candidate-evidence-error" :data-role="evidence.role" :data-observation-index="index">{{ evidence.error }}</p><figure v-else-if="evidence.url"><figcaption>{{ evidence.role === 'screenshot' ? '所选侧截图' : '所选侧重复截图' }}<button type="button" class="candidate-button" @click="clearEvidence">关闭图片</button></figcaption><img :src="evidence.url" :alt="sideLabel(state.sourceBinding.source.side) + ' · ' + observation.viewportName" data-testid="browser-candidate-evidence-image" :data-role="evidence.role" :data-observation-index="index" /><p class="candidate-muted">已核对大小与 SHA-256 · <code>{{ observation.evidence[evidence.role].file }}</code></p></figure></div></template></details></li></ol>
          <dl class="candidate-facts candidate-digests"><div><dt>来源内容摘要</dt><dd><code>{{ state.value.candidateContent.sourceContentDigest }}</code></dd></div><div><dt>组织上下文摘要</dt><dd><code>{{ state.value.organizationContextDigest }}</code></dd></div><div><dt>候选内容摘要</dt><dd><code>{{ state.value.contentDigest }}</code></dd></div></dl>
          <template v-if="state.canConfirm"><label class="candidate-confirm"><input v-model="confirmed" type="checkbox" data-testid="browser-candidate-confirm" :disabled="!ready || !active || !!selectedFact && ['unknown', 'submitting', 'confirmed'].includes(selectedFact.phase)" /><span>我已复核此项目、版本和所选侧的完整计划、规则、参考与证据，确认记录上述内容摘要。此操作只记录候选，后续仍需批准与执行能力。</span></label><button type="button" class="candidate-button candidate-primary" data-testid="browser-candidate-save" :disabled="!canSave" @click="saveCandidate">{{ writing === 'browser-candidate' ? '正在记录候选…' : '确认记录 Browser 候选' }}</button></template>
          <p v-else class="candidate-muted">该合同已记录为候选，可继续核对完整内容。</p>
        </template>
      </template>
      <div class="candidate-actions"><button type="button" class="candidate-button" data-testid="browser-candidate-reload" :disabled="!ready || !active || loading" @click="loadReview"><Icon name="refresh" decorative />重新读取完整合同</button></div>
    </section>
  </section>
</template>

<style scoped>
.browser-candidates { margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--border); min-width: 0; font-size: 12px; line-height: 1.8; }
.candidate-heading, .candidate-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.candidate-heading { align-items: start; }.browser-candidates h3 { font-size: 14px; font-weight: 650; }.browser-candidates h4 { font-size: 13px; font-weight: 600; }
.browser-candidates p, .browser-candidates dd, .browser-candidates code, .browser-candidates span { overflow-wrap: anywhere; }.browser-candidates code { font: 11px var(--font-mono); }
.candidate-muted, .candidate-facts dt, .candidate-count { color: var(--text-dim); }.candidate-heading p { margin-top: 4px; max-width: 75ch; }.candidate-count { white-space: nowrap; font-variant-numeric: tabular-nums; }
.candidate-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 9px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text); cursor: pointer; font: inherit; line-height: 1.6; }
.candidate-button:hover:enabled { border-color: var(--accent-dim); background: var(--bg-2); }.candidate-button:active:enabled { transform: translateY(1px); }.candidate-button:disabled, .candidate-confirm input:disabled { cursor: not-allowed; }.candidate-primary { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 650; }.candidate-primary:hover:enabled { background: var(--accent); filter: brightness(1.08); }
.browser-candidates :is(button,input,summary):focus-visible, .candidate-review:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.candidate-history, .candidate-observations { list-style: none; padding: 0; }.candidate-history { margin-top: 14px; }.candidate-history > li { padding: 15px 0; border-bottom: 1px solid var(--border); }.candidate-history p { margin-top: 5px; }
.candidate-empty, .candidate-maintenance, .candidate-loading { padding: 14px 0; color: var(--text-dim); }.candidate-review { margin-top: 20px; padding: 15px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); min-width: 0; }.candidate-review > p, .candidate-review > div, .candidate-review > dl { margin-top: 12px; }
.candidate-valid, .candidate-notice { color: var(--ok); }.candidate-warning { color: var(--warn); }.candidate-error { margin-top: 14px; border: 1px solid var(--bad); border-radius: var(--r-sm); padding: 13px 15px; color: var(--bad); background: var(--surface); }.candidate-error p { margin-top: 6px; }.candidate-pending { border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 13px; margin-top: 14px; }.candidate-pending button { margin-top: 9px; }.candidate-notice { margin-top: 12px; }
.candidate-side { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; }.candidate-side span { color: var(--text-dim); }.candidate-facts > div { display: grid; grid-template-columns: 115px minmax(0,1fr); gap: 12px; padding: 5px 0; }.candidate-facts dd { margin: 0; min-width: 0; }.candidate-digests { padding-top: 12px; border-top: 1px solid var(--border); }
.candidate-raw, .candidate-observations > li { border-top: 1px solid var(--border); }.candidate-raw:first-of-type { margin-top: 18px; }.browser-candidates summary { padding: 12px 0; min-height: 44px; cursor: pointer; }.browser-candidates pre { margin: 0 0 14px; padding: 12px; max-height: 440px; overflow: auto; background: var(--bg); white-space: pre-wrap; overflow-wrap: anywhere; font: 11px/1.8 var(--font-mono); }.candidate-observation-heading { padding-top: 16px; }.candidate-observations summary strong { margin-right: 10px; }.candidate-observations summary span { color: var(--text-dim); font-size: 11px; }.candidate-actions { display: flex; gap: 9px; flex-wrap: wrap; margin-top: 14px; }.candidate-observations .candidate-actions { margin-bottom: 14px; }
.candidate-evidence { margin-bottom: 16px; }.candidate-evidence figure { margin: 0; min-width: 0; }.candidate-evidence figcaption { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.candidate-evidence img { display: block; max-width: 100%; height: auto; margin: 10px 0; }.candidate-confirm { display: flex; align-items: start; gap: 11px; padding: 15px 0; max-width: 85ch; cursor: pointer; color: var(--text-dim); }.candidate-confirm input { width: 17px; height: 17px; margin-top: 4px; flex: none; accent-color: var(--accent); }
@media (max-width:620px) { .candidate-heading, .candidate-row { align-items: start; flex-wrap: wrap; }.candidate-count { display: none; }.candidate-review { padding: 12px; }.candidate-facts > div { grid-template-columns: 1fr; gap: 2px; }.candidate-observations summary span { display: block; }.candidate-actions > button { flex: 1 1 160px; }.candidate-review > .candidate-primary { width: 100%; } }
</style>
