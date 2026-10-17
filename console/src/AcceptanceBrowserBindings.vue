<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders } from './api.js';
import { GATE_LABELS } from './acceptance-workbench.js';
import { catalogFailure } from './acceptance-catalog.js';
import { browserBindingHistory, browserBindingPreviewState, browserBindingRuns, browserUrlDisplay,
  buildBrowserBindingInput, createBrowserBindingReadGuard, fetchBrowserBindingEvidence } from './acceptance-browser-bindings.js';

const props = defineProps({
  projectId: { type: String, required: true }, detail: { type: Object, default: null }, version: { type: Object, default: null },
  runs: { type: Array, default: () => [] }, ready: Boolean, active: Boolean, requiresReconcile: Boolean,
  writing: { type: String, default: '' }, request: { type: Function, required: true }, write: { type: Function, required: true },
});
const emit = defineEmits(['reconcile', 'open-run', 'review-candidate']);
const drafts = reactive(new Map()), selectedBindingId = ref(''), previewState = ref(null), previewLoading = ref(false);
const error = ref(null), errorElement = ref(null), notice = ref(''), submitting = ref(false);
const evidence = reactive(new Map()), evidenceControllers = new Map(), objectUrls = new Set();
const guard = createBrowserBindingReadGuard();
let readController, selectionEpoch = 0, evidenceEpoch = 0, stopped = false;
const draft = computed(() => {
  if (!drafts.has(props.projectId)) drafts.set(props.projectId, { runId: '', sourceSide: '', releaseId: '', confirmed: false, manual: false });
  return drafts.get(props.projectId);
});
const historyState = computed(() => {
  if (!props.detail) return { available: false, bindings: [], message: '' };
  try { return { available: true, bindings: browserBindingHistory(props.detail, props.projectId), message: '' }; }
  catch (problem) { return { available: false, bindings: [], message: problem.message }; }
});
const history = computed(() => historyState.value.bindings);
const releases = computed(() => props.detail?.releases ?? []);
const runs = computed(() => browserBindingRuns(props.runs));
const selectedRun = computed(() => runs.value.find(value => value.runId === draft.value.runId));
const selectedRelease = computed(() => releases.value.find(value => value.id === draft.value.releaseId));
const duplicate = computed(() => history.value.find(value => value.source.runId === draft.value.runId && value.source.side === draft.value.sourceSide));
const available = computed(() => historyState.value.available && props.detail?.project?.id === props.projectId);
const ready = computed(() => props.ready && available.value && !previewLoading.value && !submitting.value);
const canBind = computed(() => ready.value && !!selectedRelease.value && !!draft.value.runId
  && (draft.value.manual || !!selectedRun.value) && ['baseline', 'target'].includes(draft.value.sourceSide)
  && draft.value.confirmed && !duplicate.value);
const preview = computed(() => previewState.value?.preview ?? null);
const selectedBinding = computed(() => previewState.value?.binding ?? history.value.find(value => value.id === selectedBindingId.value));
const candidateReviewAvailable = computed(() => props.detail?.browserCandidateSupport?.available === true);
const candidateForBinding = bindingId => props.detail?.browserCandidates?.find(value => value.sourceBindingId === bindingId)?.id || '';
const dateLabel = value => {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
};
const releaseLabel = id => releases.value.find(value => value.id === id)?.label || id;
const displayText = value => value ?? '无法显示';
const sideLabel = side => side === 'baseline' ? 'baseline · 原比较基线侧' : 'target · 原比较目标侧';
const runLabel = run => `${run.name || run.runId} · ${run.mode} · ${GATE_LABELS[run.gate] || run.gate || '已完成'} · ${run.runId.slice(-8)}`;
const context = () => ({ projectId: props.projectId, bindingId: selectedBindingId.value,
  generationId: props.version?.generationId, revision: props.version?.revision, selectionEpoch });
const sameSelection = stamp => !stopped && stamp.projectId === props.projectId && stamp.selectionEpoch === selectionEpoch;
const evidenceKey = (index, role) => `${index}:${role}`;
const evidenceState = (index, role) => evidence.get(evidenceKey(index, role));
const evidenceRoles = [{ key: 'screenshot', label: '查看保存截图' }, { key: 'repeat', label: '查看重复截图' }, { key: 'details', label: '查看原始采集详情' }];

function releaseEvidence(key) {
  evidenceControllers.get(key)?.abort(); evidenceControllers.delete(key);
  const value = evidence.get(key);
  if (value?.url) { URL.revokeObjectURL(value.url); objectUrls.delete(value.url); }
  evidence.delete(key);
}
function clearEvidence() {
  evidenceEpoch++;
  for (const key of [...evidence.keys()]) releaseEvidence(key);
  for (const controller of evidenceControllers.values()) controller.abort();
  evidenceControllers.clear();
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}
function invalidatePreview({ close = false } = {}) {
  readController?.abort(); guard.invalidate(); previewState.value = null; previewLoading.value = false; clearEvidence();
  if (close) selectedBindingId.value = '';
}
function clearConfirmations() { for (const value of drafts.values()) value.confirmed = false; }
watch(() => [draft.value.runId, draft.value.sourceSide, draft.value.releaseId, draft.value.manual], () => {
  selectionEpoch++; draft.value.confirmed = false; invalidatePreview({ close: true }); notice.value = ''; error.value = null;
}, { flush: 'sync' });
watch(() => props.projectId, () => {
  selectionEpoch++; clearConfirmations(); invalidatePreview({ close: true }); error.value = null; notice.value = '';
}, { flush: 'sync' });
watch(() => [props.version?.generationId, props.version?.revision, props.requiresReconcile], () => {
  clearConfirmations(); invalidatePreview({ close: true });
}, { flush: 'sync' });
watch(() => props.active, value => { if (!value) { clearConfirmations(); invalidatePreview({ close: true }); } }, { flush: 'sync' });
async function showError(problem) {
  error.value = catalogFailure(problem); await nextTick(); errorElement.value?.focus({ preventScroll: true });
}
async function bindSource() {
  if (!canBind.value || stopped) return;
  const currentDraft = draft.value, stamp = { projectId: props.projectId, selectionEpoch };
  error.value = null; notice.value = ''; submitting.value = true;
  try {
    const body = buildBrowserBindingInput(currentDraft, props.version);
    const result = await props.write(body, stamp.projectId);
    currentDraft.confirmed = false;
    if (!sameSelection(stamp)) return;
    notice.value = `${sideLabel(body.sourceSide)}已归属到「${releaseLabel(body.releaseId)}」。${result.refreshed
      ? '归属已完成，可按需核对保存来源。' : '提交已确认，列表待刷新；请使用上方刷新目录。'}`;
  } catch (problem) {
    currentDraft.confirmed = false;
    if (sameSelection(stamp)) await showError(problem);
  } finally { if (!stopped) submitting.value = false; }
}
async function loadPreview() {
  if (!props.ready || !props.active || !selectedBindingId.value || stopped) return;
  invalidatePreview(); error.value = null;
  const controller = new AbortController(); readController = controller;
  const stamp = context(), ticket = guard.next(stamp); previewLoading.value = true;
  try {
    const value = await props.request(`/${encodeURIComponent(stamp.projectId)}/browser-source-bindings/${encodeURIComponent(stamp.bindingId)}`,
      { signal: controller.signal });
    if (controller.signal.aborted || !guard.accepts(ticket, context())) return;
    previewState.value = browserBindingPreviewState(value, { projectId: stamp.projectId, bindingId: stamp.bindingId, version: props.version });
  } catch (problem) {
    if (!stopped && !controller.signal.aborted && guard.accepts(ticket, context())) {
      if (problem.status === 409 || problem.code === 'STALE_REVISION') emit('reconcile', problem);
      await showError(problem);
    }
  } finally { if (!stopped && guard.accepts(ticket, context())) previewLoading.value = false; }
}
async function openPreview(bindingId) {
  if (!props.ready || !props.active || stopped) return;
  selectionEpoch++; invalidatePreview({ close: true }); selectedBindingId.value = bindingId; await loadPreview();
}
function closePreview() { selectionEpoch++; invalidatePreview({ close: true }); }
function reviewCandidate(bindingId) {
  if (!props.ready || !props.active || !candidateReviewAvailable.value) return;
  const candidateId = candidateForBinding(bindingId);
  closePreview(); emit('review-candidate', { sourceBindingId: bindingId, candidateId });
}
async function loadEvidence(index, role) {
  const observation = preview.value?.observations[index], binding = selectedBinding.value;
  if (!observation || !binding || stopped || !props.active || !props.ready) return;
  const key = evidenceKey(index, role); if (evidence.get(key)?.loading) return;
  releaseEvidence(key);
  const controller = new AbortController(), epoch = evidenceEpoch, stamp = context();
  const state = reactive({ loading: true, error: '', url: '', content: '' });
  evidence.set(key, state); evidenceControllers.set(key, controller);
  const accepts = () => !stopped && !controller.signal.aborted && epoch === evidenceEpoch
    && sameSelection(stamp) && stamp.bindingId === selectedBindingId.value && stamp.generationId === props.version?.generationId
    && stamp.revision === props.version?.revision && evidence.get(key) === state;
  try {
    const result = await fetchBrowserBindingEvidence({ binding, metadata: observation.evidence[role], role,
      baseUrl: API, headers: apiHeaders(), signal: controller.signal });
    if (!accepts()) return;
    state.url = URL.createObjectURL(result.blob); objectUrls.add(state.url); state.content = result.content;
  } catch (problem) {
    if (accepts()) state.error = problem.code === 'EVIDENCE_CHANGED' ? problem.message : '此证据未通过读取或完整性核对，请重新核对来源后重试。';
  } finally {
    if (accepts()) state.loading = false;
    if (evidenceControllers.get(key) === controller) evidenceControllers.delete(key);
  }
}
function collapseObservation(index, event) {
  if (!event.target.open) for (const role of evidenceRoles) releaseEvidence(evidenceKey(index, role.key));
}
onBeforeUnmount(() => { stopped = true; guard.stop(); readController?.abort(); clearEvidence(); });
</script>

<template>
  <section class="browser-bindings" aria-labelledby="browser-binding-title" data-testid="browser-bindings">
    <div class="browser-binding-heading"><div><h3 id="browser-binding-title">Browser 历史来源归属</h3><p class="browser-muted">明确选择一条运行的 baseline 或 target 侧，再归入本项目版本。</p></div><span class="browser-scope">来源归属</span></div>
    <p v-if="!detail" class="browser-muted" role="status">正在读取所选项目的来源历史…</p>
    <p v-else-if="!available" class="browser-muted">{{ historyState.message || '当前引擎未提供 Browser 来源归属，请更新并刷新目录。' }}</p>
    <template v-else>
      <form class="browser-binding-form" @submit.prevent="bindSource">
        <div class="browser-binding-fields">
          <label for="browser-binding-run">历史 Browser 运行<select v-if="!draft.manual" id="browser-binding-run" v-model="draft.runId" :disabled="!ready" required data-testid="browser-binding-run"><option value="">请选择已完成运行</option><option v-for="run in runs" :key="run.runId" :value="run.runId">{{ runLabel(run) }}</option></select><input v-else id="browser-binding-run" v-model.trim="draft.runId" :disabled="!ready" type="text" spellcheck="false" autocomplete="off" placeholder="ac-完整运行ID" required data-testid="browser-binding-run-id" /></label>
          <label for="browser-binding-side">来源侧<select id="browser-binding-side" v-model="draft.sourceSide" :disabled="!ready" required data-testid="browser-binding-side"><option value="">请明确选择来源侧</option><option value="baseline">baseline · 原比较基线侧</option><option value="target">target · 原比较目标侧</option></select></label>
          <label for="browser-binding-release">归入版本<select id="browser-binding-release" v-model="draft.releaseId" :disabled="!ready || !releases.length" required data-testid="browser-binding-release"><option value="">请选择本项目版本</option><option v-for="release in releases" :key="release.id" :value="release.id">{{ release.label }} · {{ browserUrlDisplay(release.targetUrl) }}</option></select></label>
        </div>
        <button type="button" class="browser-text-button" :disabled="!ready" data-testid="browser-binding-toggle-run-id" @click="draft.manual = !draft.manual">{{ draft.manual ? '从近期历史选择' : '更早的运行：填写完整 ID' }}</button>
        <p v-if="!runs.length && !draft.manual" class="browser-muted">近期没有已完成的 Browser 运行。可填写更早的完整运行 ID，或完成一次 mirror / regression 后刷新运行历史。</p>
        <p v-if="selectedRun" class="browser-muted">所选侧入口：<code>{{ browserUrlDisplay(draft.sourceSide === 'baseline' ? selectedRun.baselineUrl : draft.sourceSide === 'target' ? selectedRun.targetUrl : '') }}</code></p>
        <p class="browser-muted">完整入口由服务端核对，包含查询参数。比较失败或阻塞不直接决定所选侧资格。</p>
        <p v-if="duplicate" class="browser-warning" role="status" data-testid="browser-binding-duplicate">该运行的 {{ draft.sourceSide }} 侧已有本项目归属记录，不能重复认领；另一侧可独立选择。</p>
        <label class="browser-confirm"><input v-model="draft.confirmed" type="checkbox" :disabled="!ready || !draft.runId || !draft.sourceSide || !selectedRelease || !!duplicate" data-testid="browser-binding-confirm" /><span>我确认将以上运行的所选侧归入当前项目版本。此次记录不批准、选用或启动运行。</span></label>
        <button type="submit" class="browser-button browser-primary" :disabled="!canBind" data-testid="browser-binding-submit">{{ writing === 'browser-binding' || submitting ? '正在记录归属…' : '确认归属所选侧' }}</button>
      </form>

      <div v-if="error" ref="errorElement" class="browser-error" role="alert" tabindex="-1" data-testid="browser-binding-error"><strong>{{ error.message }}</strong><p><code>{{ error.code }}</code> · HTTP {{ error.status ?? '未收到响应' }}</p><p v-if="error.writeMayHaveCommitted">请求可能已经提交。请先刷新并核对来源历史，系统不会自动重发。</p></div>
      <p v-if="notice" class="browser-notice" role="status" data-testid="browser-binding-notice">{{ notice }}</p>
      <p v-if="requiresReconcile" class="browser-warning">草稿已保留。请先使用上方“刷新并核对目录”，再重新确认归属。</p>

      <div class="browser-history-heading"><h4>已归属来源 <span>{{ history.length }}</span></h4><p class="browser-muted">这里只显示已存记录；点击单条“核对来源”才重读原件。</p></div>
      <ol v-if="history.length" class="browser-history"><li v-for="binding in history" :key="binding.id" data-testid="browser-binding-row" :data-binding-id="binding.id"><div class="browser-row"><strong>{{ releaseLabel(binding.releaseId) }} · {{ binding.source.side }}</strong><div class="browser-row-actions"><button type="button" class="browser-button" :disabled="!props.ready || previewLoading" data-testid="browser-binding-preview" :data-binding-id="binding.id" @click="openPreview(binding.id)">核对来源</button><button v-if="candidateReviewAvailable" type="button" class="browser-button" :disabled="!props.ready || !props.active" data-testid="browser-binding-candidate-review" :data-binding-id="binding.id" :data-candidate-id="candidateForBinding(binding.id)" @click="reviewCandidate(binding.id)">{{ candidateForBinding(binding.id) ? '查看已保存候选' : '查看完整候选合同' }}</button></div></div><p>{{ binding.source.sourceMode }} · <code>{{ binding.source.runId }}</code></p><p class="browser-muted"><code>{{ displayText(binding.source.entryUrlDisplay) }}</code></p><p class="browser-muted">归属于 {{ dateLabel(binding.boundAt) }} · <code>{{ binding.id }}</code></p></li></ol>
      <p v-else class="browser-empty">尚无 Browser 来源归属。明确选择运行、来源侧和版本后，即可保存第一条记录。</p>

      <section v-if="selectedBindingId" class="browser-review" aria-labelledby="browser-binding-review-title" data-testid="browser-binding-preview-content">
        <div class="browser-row"><h4 id="browser-binding-review-title">所选来源核对</h4><button type="button" class="browser-button" data-testid="browser-binding-close-preview" @click="closePreview">关闭核对</button></div>
        <template v-if="selectedBinding"><p><strong>{{ sideLabel(selectedBinding.source.side) }}</strong> · {{ releaseLabel(selectedBinding.releaseId) }}</p><p class="browser-muted"><code>{{ selectedBinding.source.runId }}</code></p></template>
        <div v-if="previewLoading" class="browser-loading" role="status"><span class="browser-skeleton" /><span class="browser-skeleton browser-skeleton-short" /><p class="browser-muted">正在重读这一条来源并核对保存证据…</p></div>
        <template v-else-if="previewState">
          <div data-testid="browser-binding-diagnostics" :class="previewState.diagnostics.contentMatches ? 'browser-valid' : 'browser-warning'"><p>{{ previewState.diagnostics.contentMatches ? '本次读取与归属记录一致。' : '原归属记录保留；当前来源无法重建已记录内容。' }}</p><ul v-if="previewState.diagnostics.issues.length"><li v-for="issue in previewState.diagnostics.issues" :key="issue.code"><code>{{ issue.code }}</code> {{ issue.message }}</li></ul></div>
          <template v-if="preview">
            <p class="browser-muted">{{ preview.reviewNotice }}</p><p class="browser-coverage" data-testid="browser-binding-coverage">检查槽位 {{ preview.projectedSlots }} / {{ preview.declaredSlots }} · 采集观察 {{ preview.observations.length }} 条 · 原比较 {{ GATE_LABELS[preview.sourceGate] || preview.sourceGate }}</p>
            <dl class="browser-source-facts"><div><dt>保存入口</dt><dd><code>{{ displayText(preview.sourceReference.entryUrlDisplay) }}</code></dd></div><div><dt>捕获环境</dt><dd>{{ preview.environment.browser }} {{ preview.environment.browserVersion }} · {{ preview.environment.locale }} · {{ preview.environment.timezoneId }}</dd></div></dl>
            <ol class="browser-observations"><li v-for="(observation, index) in preview.observations" :key="index" data-testid="browser-binding-observation" :data-observation-index="index"><details @toggle="collapseObservation(index, $event)"><summary><strong>{{ observation.title || '页面采集' }}</strong><span>{{ displayText(observation.slot.routeDisplay) }} · {{ observation.viewportName }} {{ observation.slot.viewport.width }} × {{ observation.slot.viewport.height }}</span></summary><div class="browser-observation-body"><dl class="browser-source-facts"><div><dt>计划地址</dt><dd><code>{{ displayText(observation.plannedUrlDisplay) }}</code></dd></div><div><dt>观测地址</dt><dd><code>{{ displayText(observation.observedFinalUrlDisplay) }}</code><small>查询已隐藏；不证明完整重定向链或最终完整查询参数。</small></dd></div><div><dt>保存事实</dt><dd>HTTP {{ observation.expected.httpStatus }} · {{ observation.capture.captureScope }} · 两次截图一致度 {{ (observation.stability * 100).toFixed(2) }}%</dd></div><div v-if="observation.expected.assertionSummary"><dt>声明断言</dt><dd>{{ observation.expected.assertionSummary.passed }} / {{ observation.expected.assertionSummary.total }} 条通过；字面量已隐藏。</dd></div></dl>
              <details class="browser-structure"><summary>查看保存的结构文字</summary><p class="browser-muted">以下是被测页面的有界观察文字，不作为链接或 HTML 执行。</p><h5>标题</h5><p>{{ observation.expected.structure.title || '未记录标题' }}</p><h5>一级标题</h5><ul v-if="observation.expected.structure.headings.length"><li v-for="(heading, headingIndex) in observation.expected.structure.headings" :key="headingIndex">{{ heading }}</li></ul><p v-else class="browser-muted">未记录可见一级标题。</p><h5>可见控件 {{ observation.expected.structure.controls.length }}</h5><ul class="browser-controls"><li v-for="(control, controlIndex) in observation.expected.structure.controls" :key="controlIndex"><strong>{{ control.label || control.tag }}</strong><code>{{ control.path }}</code><span v-if="control.hrefDisplay">链接观察：{{ control.hrefDisplay }}</span><span v-if="control.expanded !== null">展开状态：{{ control.expanded }}</span></li></ul></details>
              <div class="browser-evidence-actions"><button v-for="role in evidenceRoles" :key="role.key" type="button" class="browser-button" :disabled="!props.ready || evidenceState(index, role.key)?.loading" :data-testid="'browser-binding-evidence-' + role.key" :data-observation-index="index" @click="loadEvidence(index, role.key)">{{ role.label }}</button></div>
              <div v-for="role in evidenceRoles" :key="role.key" class="browser-evidence-result"><p v-if="evidenceState(index, role.key)?.loading" class="browser-muted" role="status" data-testid="browser-binding-evidence-loading" :data-role="role.key" :data-observation-index="index">正在读取并核对证据大小与摘要…</p><p v-else-if="evidenceState(index, role.key)?.error" class="browser-warning" role="alert" data-testid="browser-binding-evidence-error" :data-role="role.key" :data-observation-index="index">{{ evidenceState(index, role.key).error }}</p><figure v-else-if="evidenceState(index, role.key)?.url" data-testid="browser-binding-evidence-content" :data-role="role.key" :data-observation-index="index"><figcaption><strong>{{ role.label }}</strong><button type="button" class="browser-text-button" @click="releaseEvidence(evidenceKey(index, role.key))">关闭此证据</button></figcaption><template v-if="role.key === 'details'"><p class="browser-muted">原始保存证据，可能包含页面文字、链接及断言观察；仅作文本展示，不执行。</p><pre>{{ evidenceState(index, role.key).content }}</pre></template><img v-else :src="evidenceState(index, role.key).url" :alt="sideLabel(selectedBinding.source.side) + ' · ' + role.label + ' · ' + observation.viewportName" /><p class="browser-muted">已核对大小与 SHA-256 · <code>{{ observation.evidence[role.key].file }}</code></p></figure></div>
            </div></details></li></ol>
          </template>
          <div class="browser-review-actions"><button type="button" class="browser-button" :disabled="!props.ready" @click="loadPreview"><Icon name="refresh" decorative />重新核对此来源</button><button v-if="selectedBinding && candidateReviewAvailable" type="button" class="browser-button" :disabled="!props.ready || !props.active" data-testid="browser-binding-candidate-review" :data-binding-id="selectedBinding.id" :data-candidate-id="candidateForBinding(selectedBinding.id)" @click="reviewCandidate(selectedBinding.id)">{{ candidateForBinding(selectedBinding.id) ? '查看已保存候选' : '查看完整候选合同' }}</button><button v-if="selectedBinding" type="button" class="browser-button" :disabled="!props.ready" @click="emit('open-run', selectedBinding.source.runId)">查看原运行<Icon name="external" decorative /></button></div>
        </template>
      </section>
    </template>
  </section>
</template>

<style scoped>
.browser-bindings { min-width: 0; margin-top: 24px; padding-top: 22px; border-top: 1px solid var(--border); font-size: 12px; line-height: 1.8; }
.browser-binding-heading, .browser-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.browser-binding-heading { align-items: start; }
.browser-row-actions { display: flex; flex-wrap: wrap; gap: 9px; }
.browser-bindings h3 { font-size: 14px; font-weight: 650; }
.browser-bindings h4, .browser-bindings h5 { font-size: 13px; font-weight: 600; }
.browser-bindings h4 span { color: var(--text-dim); margin-left: 6px; font-weight: 400; }
.browser-bindings p, .browser-bindings dd, .browser-bindings strong, .browser-bindings code { overflow-wrap: anywhere; }
.browser-bindings code { font-family: var(--font-mono); font-size: 11px; }
.browser-muted, .browser-bindings dt, .browser-bindings small { color: var(--text-dim); }
.browser-binding-heading p { max-width: 70ch; margin-top: 4px; }
.browser-scope { flex: none; color: var(--text-dim); font-size: 11px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 4px 9px; }
.browser-binding-form { margin-top: 18px; }
.browser-binding-fields { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr) minmax(0, 1fr); gap: 13px; }
.browser-bindings label { display: flex; flex-direction: column; gap: 7px; min-width: 0; color: var(--text-dim); }
.browser-bindings select, .browser-bindings input:not([type="checkbox"]) { width: 100%; min-width: 0; min-height: 44px; background: var(--bg); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 10px 12px; font: inherit; font-size: 13px; text-overflow: ellipsis; }
.browser-binding-form > p { margin-top: 9px; }
.browser-button { display: inline-flex; justify-content: center; align-items: center; gap: 7px; min-height: 44px; padding: 9px 13px; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--r-sm); cursor: pointer; font: inherit; line-height: 1.6; }
.browser-button:hover:enabled { background: var(--bg-2); border-color: var(--accent-dim); }
.browser-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 650; }
.browser-primary:hover:enabled { background: var(--accent); filter: brightness(1.08); }
.browser-button:active:enabled { transform: translateY(1px); }
.browser-bindings button:disabled, .browser-bindings input:disabled, .browser-bindings select:disabled { cursor: not-allowed; }
.browser-bindings :is(button,input,select,summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.browser-text-button { min-height: 44px; padding: 7px 0; border: 0; background: transparent; color: var(--text-dim); cursor: pointer; font: inherit; text-align: left; text-decoration: underline; text-underline-offset: 4px; }
.browser-text-button:hover:enabled { color: var(--text); }
.browser-bindings .browser-confirm { flex-direction: row; align-items: start; gap: 11px; padding: 14px 0; max-width: 75ch; cursor: pointer; }
.browser-confirm input { flex: none; width: 17px; height: 17px; margin-top: 4px; accent-color: var(--accent); }
.browser-warning { color: var(--warn); }
.browser-valid, .browser-notice { color: var(--ok); }
.browser-error { margin: 13px 0; padding: 13px 15px; background: var(--surface); border: 1px solid var(--bad); border-radius: var(--r-sm); color: var(--bad); overflow-wrap: anywhere; }
.browser-error p, .browser-notice { margin-top: 8px; }
.browser-history-heading { margin-top: 24px; }
.browser-history-heading p { margin-top: 4px; }
.browser-history, .browser-observations, .browser-controls { list-style: none; padding: 0; }
.browser-history > li { padding: 15px 0; border-bottom: 1px solid var(--border); }
.browser-history p { margin-top: 5px; }
.browser-empty { color: var(--text-dim); padding: 14px 0; }
.browser-review { margin-top: 20px; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 15px; background: var(--surface); min-width: 0; }
.browser-review > p, .browser-review > div, .browser-review > dl { margin-top: 10px; }
.browser-coverage { font-variant-numeric: tabular-nums; color: var(--text); }
.browser-source-facts { margin-top: 12px; }
.browser-source-facts > div { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 10px; padding: 5px 0; }
.browser-source-facts dd { margin: 0; min-width: 0; }
.browser-source-facts small { display: block; }
.browser-observations { margin-top: 18px; }
.browser-observations > li { border-top: 1px solid var(--border); }
.browser-bindings summary { min-height: 44px; cursor: pointer; padding: 12px 0; }
.browser-observations > li > details > summary strong { margin-right: 10px; }
.browser-observations > li > details > summary span { color: var(--text-dim); font-size: 11px; }
.browser-observation-body { padding: 0 0 16px; }
.browser-structure { margin-top: 9px; }
.browser-structure h5 { margin-top: 14px; margin-bottom: 5px; }
.browser-structure ul:not(.browser-controls) { padding-left: 20px; }
.browser-controls li { display: grid; gap: 3px; padding: 9px 0; border-bottom: 1px solid var(--border); }
.browser-controls li span { color: var(--text-dim); }
.browser-evidence-actions, .browser-review-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 14px; }
.browser-evidence-result > p { margin-top: 10px; }
.browser-evidence-result figure { margin: 14px 0 0; min-width: 0; }
.browser-evidence-result figcaption { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.browser-evidence-result img { display: block; max-width: 100%; height: auto; margin: 7px 0; }
.browser-evidence-result pre { background: var(--bg); padding: 12px; max-height: 440px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 11px; }
.browser-loading { padding: 14px 0; }
.browser-skeleton { display: block; height: 12px; width: min(100%, 600px); margin: 7px 0; background: var(--bg-2); border-radius: var(--r-sm); }
.browser-skeleton-short { width: min(68%, 360px); }
@media (max-width: 1100px) { .browser-binding-fields { grid-template-columns: 1fr 1fr; }.browser-binding-fields > label:first-child { grid-column: 1 / -1; } }
@media (max-width: 620px) { .browser-binding-fields { grid-template-columns: 1fr; }.browser-binding-fields > label:first-child { grid-column: auto; }.browser-binding-heading { flex-direction: column; }.browser-scope { display: none; }.browser-row { align-items: start; flex-wrap: wrap; }.browser-review { padding: 12px; }.browser-source-facts > div { grid-template-columns: 1fr; gap: 2px; }.browser-evidence-actions > .browser-button { flex: 1 1 140px; }.browser-observations > li > details > summary span { display: block; } }
</style>
