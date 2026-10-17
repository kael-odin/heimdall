<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { catalogFailure } from './acceptance-catalog.js';
import { baselineSpecBindings, baselinePreviewState, buildBaselineCandidateInput, buildBaselineApprovalInput,
  buildBaselineSelectionInput, buildBaselineCancellationInput, createBaselinePreviewGuard } from './acceptance-baseline.js';

const props = defineProps({
  projectId: { type: String, required: true }, detail: { type: Object, default: null }, version: { type: Object, default: null },
  ready: Boolean, writing: { type: String, default: '' }, requiresReconcile: Boolean,
  request: { type: Function, required: true }, write: { type: Function, required: true },
});
const emit = defineEmits(['reconcile']);
const drafts = reactive(new Map()), previewValue = ref(null), previewState = ref(null), previewLoading = ref(false);
const error = ref(null), errorElement = ref(null), notice = ref(''), expandContracts = ref(true);
const guard = createBaselinePreviewGuard();
let previewController, selectionEpoch = 0, stopped = false;
const draft = computed(() => {
  if (!drafts.has(props.projectId)) drafts.set(props.projectId, { sourceRunId: '', candidateId: '', approvalId: '',
    decisions: new Map(), cancel: { reason: '', confirmed: false }, cancelOpen: false });
  return drafts.get(props.projectId);
});
function decision(kind, id) {
  const key = `${kind}:${id}`;
  if (!draft.value.decisions.has(key)) draft.value.decisions.set(key, { reason: '', confirmed: false });
  return draft.value.decisions.get(key);
}
const approvalDraft = computed(() => decision('approve', draft.value.candidateId));
const selectionDraft = computed(() => decision('select', draft.value.approvalId));
const candidates = computed(() => props.detail?.candidates ?? []);
const approvals = computed(() => props.detail?.approvals ?? []);
const selections = computed(() => props.detail?.selections ?? []);
const selectedCandidate = computed(() => candidates.value.find(value => value.id === draft.value.candidateId));
const selectedApproval = computed(() => approvals.value.find(value => value.id === draft.value.approvalId
  && value.candidateId === draft.value.candidateId));
const current = computed(() => {
  const selection = props.detail?.currentSelections?.spec;
  return selection?.approvalId ? selection : null;
});
const currentApproval = computed(() => approvals.value.find(value => value.id === current.value?.approvalId));
const currentCandidate = computed(() => candidates.value.find(value => value.id === currentApproval.value?.candidateId));
const sources = computed(() => baselineSpecBindings(props.detail?.runBindings));
const available = computed(() => props.detail?.project?.id === props.projectId && props.detail.executionReady === false
  && ['candidates', 'approvals', 'selections'].every(key => Array.isArray(props.detail[key])));
const preview = computed(() => previewState.value?.preview ?? null);
const canDecide = computed(() => props.ready && !previewLoading.value && previewState.value?.canDecide === true);
const canApprove = computed(() => canDecide.value && approvalDraft.value.confirmed && !!approvalDraft.value.reason.trim());
const canSelect = computed(() => canDecide.value && !!selectedApproval.value && selectedApproval.value.id !== current.value?.approvalId
  && selectionDraft.value.confirmed && !!selectionDraft.value.reason.trim());
const pretty = value => JSON.stringify(value, null, 2);
const dateLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
};
const releaseLabel = id => props.detail?.releases?.find(value => value.id === id)?.label || id;
const candidateLabel = value => `${releaseLabel(value.source.releaseId)} · ${value.source.runId}`;
const context = () => ({ projectId: props.projectId, generationId: props.version?.generationId,
  revision: props.version?.revision, candidateId: draft.value.candidateId, selectionEpoch });
const sameSelection = value => !stopped && value.projectId === props.projectId
  && value.generationId === props.version?.generationId && value.selectionEpoch === selectionEpoch;

function clearConfirmations() {
  for (const value of drafts.values()) {
    for (const item of value.decisions.values()) item.confirmed = false;
    value.cancel.confirmed = false;
    value.cancelOpen = false;
  }
}
function invalidatePreview() {
  previewController?.abort(); guard.invalidate(); previewValue.value = null; previewState.value = null;
  previewLoading.value = false; clearConfirmations();
}
watch(() => [props.projectId, props.version?.generationId], () => {
  selectionEpoch++; invalidatePreview(); error.value = null; notice.value = '';
}, { flush: 'sync' });
watch(() => [props.version?.revision, props.detail, props.requiresReconcile], invalidatePreview, { flush: 'sync' });

async function showError(problem) {
  error.value = catalogFailure(problem);
  await nextTick(); errorElement.value?.focus({ preventScroll: true });
}
async function loadPreview() {
  if (!props.ready || !selectedCandidate.value || stopped) return;
  invalidatePreview(); error.value = null; notice.value = '';
  const controller = new AbortController(); previewController = controller;
  const stamp = context(), ticket = guard.next(stamp);
  previewLoading.value = true;
  try {
    const value = await props.request(`/${encodeURIComponent(stamp.projectId)}/baseline-candidates/${encodeURIComponent(stamp.candidateId)}`,
      { signal: controller.signal });
    if (controller.signal.aborted || !guard.accepts(ticket, context())) return;
    const state = baselinePreviewState(value, { projectId: stamp.projectId, candidateId: stamp.candidateId, version: props.version });
    previewValue.value = value; previewState.value = state;
  } catch (problem) {
    if (!stopped && !controller.signal.aborted && guard.accepts(ticket, context())) {
      if (problem.code === 'STALE_REVISION') emit('reconcile', problem);
      await showError(problem);
    }
  } finally { if (!stopped && guard.accepts(ticket, context())) previewLoading.value = false; }
}
async function openCandidate(candidateId, approvalId = '') {
  if (!props.ready) return;
  selectionEpoch++;
  draft.value.candidateId = candidateId; draft.value.approvalId = approvalId;
  invalidatePreview();
  await loadPreview();
}
async function createCandidate() {
  if (!props.ready || !available.value) return;
  const stamp = context(), sourceRunId = draft.value.sourceRunId;
  error.value = null; notice.value = '';
  try {
    const body = buildBaselineCandidateInput({ sourceRunId }, props.version);
    const result = await props.write('candidate', body, stamp.projectId);
    if (!sameSelection(stamp)) return;
    notice.value = '需求候选已记录。请核对完整合同，再单独批准。';
    if (result.refreshed) { await nextTick(); await openCandidate(result.candidate.id); }
  } catch (problem) { if (sameSelection(stamp)) await showError(problem); }
}
async function decide(kind) {
  if (!props.ready || !available.value) return;
  const stamp = context(), currentDraft = kind === 'approval' ? approvalDraft.value
    : kind === 'selection' ? selectionDraft.value : draft.value.cancel;
  const snapshot = JSON.stringify(currentDraft);
  error.value = null; notice.value = '';
  try {
    const body = kind === 'approval' ? buildBaselineApprovalInput(currentDraft, props.version, previewValue.value, stamp.projectId)
      : kind === 'selection' ? buildBaselineSelectionInput(currentDraft, props.version, previewValue.value, selectedApproval.value, stamp.projectId)
        : buildBaselineCancellationInput(currentDraft, props.version, current.value);
    await props.write(kind, body, stamp.projectId);
    currentDraft.confirmed = false;
    if (!sameSelection(stamp)) return;
    if (JSON.stringify({ ...currentDraft, confirmed: true }) === snapshot) currentDraft.reason = '';
    if (kind === 'cancellation') draft.value.cancelOpen = false;
    notice.value = kind === 'approval' ? '合同批准已记录。当前选用未改变；如需选用，请从批准历史单独核对并确认。'
      : kind === 'cancellation' ? '已取消当前 Spec 选用。历史候选、批准与选用记录均已保留。'
        : '本项目的 Spec 选用已记录。未启动新运行，原报告与门禁保持不变。';
  } catch (problem) {
    currentDraft.confirmed = false;
    if (sameSelection(stamp)) await showError(problem);
  }
}
onBeforeUnmount(() => { stopped = true; guard.stop(); previewController?.abort(); });
</script>

<template>
  <section class="baseline" aria-labelledby="baseline-title" data-testid="acceptance-baseline">
    <div class="baseline-heading"><div><h3 id="baseline-title">Spec 需求合同</h3><p>核对来源与预期，分别记录批准和本项目的选用。</p></div><span class="baseline-scope">记录模式 · 不启动运行</span></div>
    <p class="baseline-boundary">合同批准、当前选用与原运行结果分别记录。需要执行时，请在下方“执行已选需求验收”核对合同并明确目标版本。</p>
    <p v-if="!detail" class="baseline-muted" role="status">正在读取所选项目的合同历史…</p>
    <p v-else-if="!available" class="baseline-muted">当前引擎未返回完整的合同记录能力，请更新并刷新目录后继续。</p>
    <template v-else>
      <div class="baseline-current" data-testid="baseline-current">
        <div class="baseline-row"><h4>当前 Spec 选用</h4><button v-if="current" type="button" class="baseline-button" :disabled="!ready" data-testid="baseline-open-cancel" @click="draft.cancelOpen = !draft.cancelOpen; draft.cancel.confirmed = false">取消当前选用</button></div>
        <template v-if="current"><p><strong>{{ currentCandidate ? releaseLabel(currentCandidate.source.releaseId) : '已记录的合同批准' }}</strong></p><p v-if="currentCandidate" class="baseline-muted">来源运行 <code>{{ currentCandidate.source.runId }}</code></p><p class="baseline-muted">批准 <code>{{ current.approvalId }}</code></p><p class="baseline-muted">选用 <code>{{ current.id }}</code> · {{ dateLabel(current.selectedAt) }}</p><p>{{ current.reason }}</p><p class="baseline-muted">本项目已记录当前选用。来源后来变化时仍保留此记录，可独立取消；每次执行前会重新核对来源。</p></template>
        <p v-else class="baseline-muted">尚未选用。批准合同后，仍需单独核对并选用。</p>
        <form v-if="draft.cancelOpen && current" class="baseline-decision" @submit.prevent="decide('cancellation')">
          <label for="baseline-cancel-reason">取消理由<textarea id="baseline-cancel-reason" v-model="draft.cancel.reason" rows="2" required maxlength="1000" data-testid="baseline-cancel-reason" /></label>
          <label class="baseline-confirm"><input v-model="draft.cancel.confirmed" type="checkbox" data-testid="baseline-cancel-confirm" /><span>我确认取消以上当前选用；历史记录仍保留。此操作不依赖来源文件可用。</span></label>
          <button type="submit" class="baseline-button" :disabled="!ready || !draft.cancel.confirmed || !draft.cancel.reason.trim()" data-testid="baseline-cancel">{{ writing === 'baseline-cancellation' ? '正在记录…' : '确认取消选用' }}</button>
        </form>
      </div>

      <form class="baseline-create" @submit.prevent="createCandidate">
        <label for="baseline-source">从已归属的 Spec 运行创建候选<select id="baseline-source" v-model="draft.sourceRunId" :disabled="!ready || !sources.length" required data-testid="baseline-source"><option value="">请选择本项目的来源运行</option><option v-for="binding in sources" :key="binding.runId" :value="binding.runId">{{ releaseLabel(binding.releaseId) }} · {{ binding.source?.name || binding.runId }} · {{ binding.source?.gate || binding.source?.status }} · {{ binding.runId }}</option></select></label>
        <button type="submit" class="baseline-button baseline-primary" :disabled="!ready || !draft.sourceRunId || !sources.length" data-testid="baseline-create-candidate">{{ writing === 'baseline-candidate' ? '正在记录候选…' : '创建需求候选' }}</button>
        <p class="baseline-muted">只读取已绑定本项目版本的来源。原目标失败或完整草稿尚未批准，不代表需求合同不可核对。</p>
        <p v-if="!sources.length" class="baseline-muted">还没有已归属的 Spec 运行。请先在上方认领来源；组织归属本身不证明证据或合同资格。</p>
      </form>

      <div class="baseline-row baseline-history-heading"><h4>需求候选 <span>{{ candidates.length }}</span></h4></div>
      <ul v-if="candidates.length" class="baseline-candidates"><li v-for="candidate in [...candidates].reverse()" :key="candidate.id" :class="{ selected: draft.candidateId === candidate.id }"><div><strong>{{ releaseLabel(candidate.source.releaseId) }}</strong><small>{{ dateLabel(candidate.createdAt) }}</small></div><code>{{ candidate.id }}</code><p class="baseline-muted">来源 <code>{{ candidate.source.runId }}</code></p><button type="button" class="baseline-button" :disabled="!ready" :data-candidate-id="candidate.id" data-testid="baseline-preview-candidate" @click="openCandidate(candidate.id)">{{ draft.candidateId === candidate.id ? '重新核对合同' : '核对完整合同' }}</button></li></ul>
      <p v-else class="baseline-muted">尚无需求候选。候选创建后，仍需查看完整合同并显式批准。</p>

      <div v-if="error" ref="errorElement" class="baseline-error" role="alert" tabindex="-1" data-testid="baseline-error"><strong>{{ error.message }}</strong><p><code>{{ error.code }}</code> · HTTP {{ error.status ?? '未收到响应' }}</p><p v-if="error.writeMayHaveCommitted">请求可能已经提交。请先刷新目录核对历史，系统不会自动重发。</p></div>
      <p v-if="notice" class="baseline-notice" role="status" data-testid="baseline-notice">{{ notice }}</p>
      <p v-if="previewLoading" class="baseline-muted" role="status">正在重读来源并核对完整合同…</p>
      <p v-if="requiresReconcile" class="baseline-warning">草稿已保留。请先使用上方“刷新并核对目录”，再重新打开完整合同并确认。</p>
      <section v-if="selectedCandidate" class="baseline-review" aria-labelledby="baseline-review-title" data-testid="baseline-review">
        <div class="baseline-row"><h4 id="baseline-review-title">候选合同核对</h4><button type="button" class="baseline-button" :disabled="!ready || previewLoading" data-testid="baseline-reload-preview" @click="loadPreview"><Icon name="refresh" decorative />重新读取来源</button></div>
        <p class="baseline-muted">{{ candidateLabel(selectedCandidate) }}</p><code>{{ selectedCandidate.id }}</code>
        <details class="baseline-digest"><summary>查看候选摘要与身份</summary><dl><div><dt>内容摘要</dt><dd><code>{{ selectedCandidate.contentDigest }}</code></dd></div><div><dt>来源侧</dt><dd>source · Spec</dd></div><div><dt>版本声明</dt><dd><code>{{ selectedCandidate.source.releaseId }}</code></dd></div></dl></details>
        <template v-if="previewState">
          <p :class="previewState.canDecide ? 'baseline-valid' : 'baseline-warning'" data-testid="baseline-eligibility">{{ previewState.canDecide ? '当前来源与候选内容一致，可人工核对并作出决定。' : '当前来源不可批准或选用；历史候选仍保留。' }}</p>
          <ul v-if="previewState.diagnostics.issues.length" class="baseline-issues"><li v-for="(issue, index) in previewState.diagnostics.issues" :key="index"><code>{{ issue.code }}</code> {{ issue.message }}</li></ul>
          <p v-if="!previewState.diagnostics.contentMatches" class="baseline-warning">来源可能已变化或无法重建。下方若有当前内容，也不能视为该历史候选或批准的原内容。</p>
        </template>
        <p v-else-if="!previewLoading" class="baseline-muted">请重新读取来源，核对完整合同。之前的确认不会沿用。</p>
        <template v-if="preview">
          <div class="baseline-source"><h5>本次核验的需求来源</h5><dl><div><dt>需求</dt><dd>{{ preview.source.title || preview.source.id }}</dd></div><div><dt>标识 / 修订</dt><dd><code>{{ preview.source.id }}</code> · {{ preview.source.revision }}</dd></div><div><dt>类型</dt><dd>{{ preview.source.type === 'openapi' ? 'OpenAPI 文档合同' : '手工声明合同' }}</dd></div><div><dt>原目标</dt><dd><code>{{ preview.targetUrl }}</code></dd></div><div><dt>原运行事实</dt><dd>{{ preview.sourceGate }} · {{ preview.sourceSpecApproved ? '该次运行已批准清单' : '该次运行未批准清单' }}</dd></div></dl><details><summary>完整来源声明</summary><pre>{{ pretty(preview.source) }}</pre></details></div>
          <div class="baseline-row baseline-contract-heading"><h5>完整预期合同 · {{ preview.checks.length }} / {{ preview.declaredSlots }}</h5><button type="button" class="baseline-text-button" @click="expandContracts = !expandContracts">{{ expandContracts ? '折叠全部' : '展开全部' }}</button></div>
          <ol class="baseline-contracts" data-testid="baseline-contracts"><li v-for="check in preview.checks" :key="check.id"><details :open="expandContracts"><summary><span><strong>{{ check.method }} {{ check.path }}</strong><small>{{ check.id }} · {{ check.title }} · {{ check.severity }}</small></span><span class="baseline-http">预期 {{ check.expect.status }}</span></summary><div class="baseline-expectation"><p class="baseline-muted">以下为需求预期，不是原目标实际响应。</p><pre data-testid="baseline-full-expect">{{ pretty(check.expect) }}</pre><details><summary>执行规则与身份范围</summary><pre>{{ pretty({ rule: check.rule, identity: check.identity }) }}</pre></details></div></details></li></ol>
          <p class="baseline-muted">已展示全部 {{ preview.projectedSlots }} 条合同；未覆盖项 0。批准针对这些预期，不改变原目标的失败、阻塞或通过结论。</p>
          <form class="baseline-decision" @submit.prevent="decide('approval')">
            <h5>记录合同批准</h5><label for="baseline-approval-reason">批准理由<textarea id="baseline-approval-reason" v-model="approvalDraft.reason" rows="3" required maxlength="1000" :disabled="!ready" data-testid="baseline-approval-reason" /></label>
            <label class="baseline-confirm"><input v-model="approvalDraft.confirmed" type="checkbox" :disabled="!canDecide" data-testid="baseline-approval-confirm" /><span>我已核对以上需求来源与全部预期合同，批准此内容作为需求记录。原运行结果保持不变，当前选用不会自动改变。</span></label>
            <button type="submit" class="baseline-button baseline-primary" :disabled="!canApprove" data-testid="baseline-approve">{{ writing === 'baseline-approval' ? '正在记录批准…' : '记录合同批准' }}</button>
          </form>
          <form v-if="selectedApproval" class="baseline-decision baseline-selection-form" @submit.prevent="decide('selection')" data-testid="baseline-selection-form">
            <h5>单独确认本项目选用</h5><p class="baseline-muted">当前批准 <code>{{ current?.approvalId || '尚未选用' }}</code> → 将选用 <code>{{ selectedApproval.id }}</code></p><p>{{ selectedApproval.reason }}</p><label for="baseline-selection-reason">选用 / 回退理由<textarea id="baseline-selection-reason" v-model="selectionDraft.reason" rows="3" required maxlength="1000" :disabled="!ready" data-testid="baseline-selection-reason" /></label>
            <label class="baseline-confirm"><input v-model="selectionDraft.confirmed" type="checkbox" :disabled="!canDecide || selectedApproval.id === current?.approvalId" data-testid="baseline-selection-confirm" /><span>我确认将此批准记录为本项目当前 Spec 选用。此次操作不启动新运行。</span></label>
            <p v-if="selectedApproval.id === current?.approvalId" class="baseline-muted">这条批准已经是当前选用，无需重复记录。</p><button type="submit" class="baseline-button baseline-primary" :disabled="!canSelect" data-testid="baseline-select">{{ writing === 'baseline-selection' ? '正在记录选用…' : '确认选用此批准' }}</button>
          </form>
        </template>
      </section>

      <section class="baseline-approvals" aria-labelledby="baseline-approvals-title"><h4 id="baseline-approvals-title">合同批准历史 <span>{{ approvals.length }}</span></h4><ol v-if="approvals.length"><li v-for="approval in [...approvals].reverse()" :key="approval.id"><div class="baseline-row"><strong>{{ approval.id === current?.approvalId ? '当前选用的批准' : '已记录合同批准' }}</strong><button type="button" class="baseline-button" :disabled="!ready" :data-approval-id="approval.id" data-testid="baseline-review-approval" @click="openCandidate(approval.candidateId, approval.id)">核对并选用</button></div><code>{{ approval.id }}</code><p>{{ approval.reason }}</p><p class="baseline-muted">候选 <code>{{ approval.candidateId }}</code> · {{ dateLabel(approval.approvedAt) }}</p></li></ol><p v-else class="baseline-muted">尚无合同批准。创建候选不会自动产生批准记录。</p></section>
      <details v-if="selections.length" class="baseline-selection-history"><summary>选用与取消历史 {{ selections.length }} 条</summary><ol><li v-for="selection in [...selections].reverse()" :key="selection.id"><strong>{{ selection.approvalId ? '选用合同批准' : '取消选用' }}</strong><p>{{ selection.reason }}</p><p class="baseline-muted"><code>{{ selection.id }}</code> · {{ dateLabel(selection.selectedAt) }}</p><code v-if="selection.approvalId">{{ selection.approvalId }}</code></li></ol></details>
    </template>
  </section>
</template>

<style scoped>
.baseline { min-width: 0; border-top: 1px solid var(--border); margin-top: 24px; padding-top: 22px; font-size: 12px; line-height: 1.8; }
.baseline-heading, .baseline-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.baseline-heading { align-items: start; }
.baseline h3 { font-size: 14px; font-weight: 650; }
.baseline h4, .baseline h5 { font-size: 13px; font-weight: 600; }
.baseline h4 span { margin-left: 6px; color: var(--text-dim); font-weight: 400; }
.baseline-heading p, .baseline-muted, .baseline small { color: var(--text-dim); }
.baseline code { font-size: 11px; overflow-wrap: anywhere; }
.baseline p, .baseline dd, .baseline strong { overflow-wrap: anywhere; }
.baseline-scope { flex: none; border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 4px 9px; color: var(--text-dim); font-size: 11px; }
.baseline-boundary { margin: 12px 0 18px; border-left: 2px solid var(--accent-dim); padding-left: 12px; color: var(--text-dim); }
.baseline-current, .baseline-review { border: 1px solid var(--border); background: var(--surface); border-radius: var(--r-sm); padding: 15px; min-width: 0; }
.baseline-current > p { margin-top: 7px; }
.baseline-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 9px 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--text); background: var(--surface); cursor: pointer; font-size: 12px; line-height: 1.6; }
.baseline-button:hover:enabled { background: var(--bg-2); border-color: var(--accent-dim); }
.baseline-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 650; }
.baseline-primary:hover:enabled { background: var(--accent); filter: brightness(1.08); }
.baseline button:disabled, .baseline input:disabled { cursor: not-allowed; }
.baseline label { display: flex; flex-direction: column; gap: 7px; color: var(--text-dim); min-width: 0; }
.baseline select, .baseline textarea { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--r-sm); padding: 10px 12px; color: var(--text); background: var(--bg); font-size: 13px; line-height: 1.6; }
.baseline select { min-height: 44px; text-overflow: ellipsis; }
.baseline textarea { resize: vertical; }
.baseline-create { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 9px 12px; margin-top: 22px; }
.baseline-create > .baseline-button { align-self: end; }
.baseline-create > p { grid-column: 1 / -1; }
.baseline-history-heading { margin: 23px 0 10px; }
.baseline-candidates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; list-style: none; }
.baseline-candidates > li { min-width: 0; border: 1px solid var(--border); border-radius: var(--r-sm); padding: 12px; }
.baseline-candidates > li.selected { border-color: var(--accent-dim); background: var(--surface); }
.baseline-candidates li > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 5px 10px; }
.baseline-candidates .baseline-button { margin-top: 9px; }
.baseline-candidates code { display: block; }
.baseline-review { margin-top: 18px; }
.baseline-review > code { display: block; }
.baseline summary { min-height: 44px; padding: 10px 0; cursor: pointer; }
.baseline-digest dl, .baseline-source dl { margin: 6px 0; }
.baseline dl > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 12px; margin: 5px 0; }
.baseline dt { color: var(--text-dim); }
.baseline pre { min-width: 0; max-height: 440px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; line-height: 1.8; font-family: var(--font-mono); color: var(--text); padding: 12px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg); }
.baseline-valid { color: var(--ok); margin: 10px 0; }
.baseline-warning { color: var(--warn); margin: 10px 0; }
.baseline-issues { list-style: none; color: var(--warn); }
.baseline-source { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 14px; }
.baseline-contract-heading { margin-top: 15px; }
.baseline-text-button { background: transparent; color: var(--accent); min-height: 44px; padding: 9px 4px; border: 0; cursor: pointer; font-size: 12px; }
.baseline-contracts { list-style: none; margin: 6px 0 10px; }
.baseline-contracts > li { border-top: 1px solid var(--border); }
.baseline-contracts > li > details > summary { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.baseline-contracts strong, .baseline-contracts small { display: block; }
.baseline-http { flex: none; font-family: var(--font-mono); color: var(--text-dim); font-size: 11px; }
.baseline-expectation { padding-bottom: 12px; }
.baseline-expectation > p { margin-bottom: 7px; }
.baseline-decision { display: flex; flex-direction: column; gap: 11px; margin-top: 17px; border-top: 1px solid var(--border); padding-top: 15px; }
.baseline-decision > .baseline-button { align-self: start; }
.baseline label.baseline-confirm { flex-direction: row; align-items: start; gap: 10px; cursor: pointer; padding: 4px 0; }
.baseline-confirm input { width: 17px; height: 17px; margin-top: 4px; flex: none; accent-color: var(--accent); }
.baseline-selection-form { border-left: 2px solid var(--accent-dim); padding-left: 13px; }
.baseline-error { border: 1px solid var(--bad); border-radius: var(--r-sm); color: var(--bad); padding: 12px; margin-top: 15px; overflow-wrap: anywhere; }
.baseline-notice { color: var(--ok); margin: 12px 0; }
.baseline-approvals { margin-top: 22px; }
.baseline-approvals ol, .baseline-selection-history ol { list-style: none; }
.baseline-approvals li, .baseline-selection-history li { padding: 13px 0; border-bottom: 1px solid var(--border); }
.baseline-approvals li > p { margin-top: 6px; }
.baseline-selection-history { margin-top: 8px; }
@media (max-width: 800px) { .baseline-create { grid-template-columns: 1fr; } .baseline-create > .baseline-button { justify-self: start; } }
@media (max-width: 620px) {
  .baseline-heading, .baseline-row { align-items: start; flex-direction: column; gap: 8px; }
  .baseline-candidates { grid-template-columns: 1fr; }
  .baseline-current, .baseline-review { padding: 12px; }
  .baseline dl > div { grid-template-columns: 1fr; gap: 1px; }
  .baseline-contracts > li > details > summary { align-items: start; flex-direction: column; gap: 3px; }
  .baseline select, .baseline textarea { font-size: 13px; }
}
</style>
