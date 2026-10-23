<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders } from './api.js';
import { baselinePreviewState } from './acceptance-baseline.js';
import { GATE_LABELS } from './acceptance-workbench.js';
import { buildExecutionConfirmation, createAcceptanceExecutionClient, executionFailure } from './acceptance-execution.js';

const props = defineProps({ projectId: { type: String, required: true }, detail: { type: Object, default: null },
  version: { type: Object, default: null }, ready: Boolean, active: { type: Boolean, default: true }, request: { type: Function, required: true } });
const emit = defineEmits(['reconcile', 'open-run', 'run-created']);
const targetReleaseId = ref(''), confirmed = ref(false), previewValue = ref(null), previewLoading = ref(false);
const capability = ref(null), capabilityError = ref(''), capabilityLoading = ref(false);
const receipts = ref([]), selectedOperationId = ref(''), states = reactive(new Map()), readErrors = reactive(new Map());
const error = ref(null), errorElement = ref(null), storageError = ref(''), submitting = ref(false), stopping = ref(false);
const stopNotice = ref(''), stopRequested = reactive(new Set());
let client, stopped = false, epoch = 0, capabilityEpoch = 0;
let previewController, capabilityController, submitController, stopController, pollTimer, capabilityTimer;
const readControllers = new Map(), readEpochs = new Map();
const pollAttempts = reactive(new Map());
const visible = () => props.active && !document.hidden;
const selection = computed(() => props.detail?.currentSelections?.spec?.approvalId ? props.detail.currentSelections.spec : null);
const approval = computed(() => props.detail?.approvals?.find(item => item.id === selection.value?.approvalId));
const candidate = computed(() => props.detail?.candidates?.find(item => item.id === approval.value?.candidateId));
const releases = computed(() => props.detail?.releases ?? []);
const target = computed(() => releases.value.find(item => item.id === targetReleaseId.value));
const selectedReceipt = computed(() => receipts.value.find(item => item.request.operationId === selectedOperationId.value));
const selectedState = computed(() => states.get(selectedOperationId.value));
const terminal = value => ['completed', 'interrupted', 'failed'].includes(value?.state);
const unresolved = computed(() => receipts.value.some(item => !item.resolution && !terminal(states.get(item.request.operationId))));
const canReview = computed(() => props.ready && !!candidate.value && !!selection.value && !submitting.value);
const confirmation = computed(() => {
  if (!previewValue.value || !target.value || !props.ready) return null;
  try { return buildExecutionConfirmation({ projectId: props.projectId, detail: props.detail, version: props.version,
    preview: previewValue.value, targetReleaseId: targetReleaseId.value, epoch }); } catch { return null; }
});
const canStart = computed(() => !!confirmation.value && confirmed.value && capability.value?.ready === true
  && !unresolved.value && !storageError.value && !submitting.value && !previewLoading.value);
const canStop = computed(() => selectedState.value?.state === 'running' && !stopping.value
  && !stopRequested.has(selectedOperationId.value));
const labels = { unknown: '启动结果待核对', checking: '正在核对原操作', prepared: '已准备，未启动', running: '正在执行',
  completed: '执行已完成', interrupted: '执行已中断', failed: '执行失败', rejected: '请求未接纳' };
const stateLabel = value => labels[value?.state] || '尚未核对';
const currentStateLabel = computed(() => selectedReceipt.value?.resolution ? '请求未接纳' : stateLabel(selectedState.value));
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const pretty = value => JSON.stringify(value, null, 2);
const contextKey = computed(() => JSON.stringify([props.projectId, props.version?.generationId, props.version?.revision,
  selection.value?.id, approval.value?.id, candidate.value?.id, props.ready]));

watch(contextKey, () => {
  epoch++; previewController?.abort(); previewLoading.value = false; previewValue.value = null; confirmed.value = false;
}, { flush: 'sync' });
watch(targetReleaseId, () => { confirmed.value = false; }, { flush: 'sync' });
watch(selectedOperationId, () => { stopNotice.value = ''; schedulePoll(0); });
watch(() => props.active, active => {
  confirmed.value = false;
  if (active && client) { loadCapability(); schedulePoll(0); }
  else { clearTimeout(pollTimer); clearTimeout(capabilityTimer); }
});

async function showError(problem) {
  error.value = executionFailure(problem);
  await nextTick();
  if (!stopped) errorElement.value?.focus({ preventScroll: true });
}
function loadReceipts() {
  try {
    receipts.value = client.listReceipts({ projectId: props.projectId });
    if (!receipts.value.some(item => item.request.operationId === selectedOperationId.value)) {
      selectedOperationId.value = receipts.value[0]?.request.operationId || '';
    }
    storageError.value = '';
    return true;
  } catch (problem) { storageError.value = problem.message || '无法读取本地操作凭据。'; return false; }
}
async function loadCapability() {
  clearTimeout(capabilityTimer); capabilityController?.abort();
  if (stopped || !visible() || !client) return;
  const stamp = ++capabilityEpoch, controller = new AbortController(); capabilityController = controller;
  capabilityLoading.value = true;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const value = await client.readCapability({ signal: controller.signal });
    if (!stopped && stamp === capabilityEpoch && !controller.signal.aborted) {
      capability.value = value; capabilityError.value = '';
    }
  } catch (problem) {
    if (!stopped && stamp === capabilityEpoch) {
      capability.value = null; capabilityError.value = controller.signal.aborted ? '执行状态读取超时，请重新核对。' : problem.message;
    }
  } finally {
    clearTimeout(timeout);
    if (!stopped && stamp === capabilityEpoch) {
      capabilityLoading.value = false;
      if (visible()) capabilityTimer = setTimeout(loadCapability, 3000);
    }
  }
}
async function review() {
  if (!canReview.value || stopped) return;
  previewController?.abort(); confirmed.value = false; previewValue.value = null; error.value = null;
  const stamp = epoch, candidateId = candidate.value.id, controller = new AbortController(); previewController = controller;
  previewLoading.value = true;
  try {
    const value = await props.request(`/${encodeURIComponent(props.projectId)}/baseline-candidates/${encodeURIComponent(candidateId)}`,
      { signal: controller.signal });
    if (stopped || controller.signal.aborted || stamp !== epoch) return;
    const state = baselinePreviewState(value, { projectId: props.projectId, candidateId, version: props.version });
    if (!state.canDecide) throw new Error('当前来源与已选合同无法核对，请先刷新目录并检查需求来源。');
    previewValue.value = value;
  } catch (problem) {
    if (!stopped && !controller.signal.aborted && stamp === epoch) {
      if (problem.code === 'STALE_REVISION') emit('reconcile', problem);
      await showError(problem);
    }
  } finally { if (!stopped && stamp === epoch) previewLoading.value = false; }
}
function schedulePoll(delay = 1200) {
  clearTimeout(pollTimer);
  const receipt = selectedReceipt.value;
  if (stopped || !visible() || !receipt || receipt.resolution || terminal(states.get(receipt.request.operationId))) return;
  const id = receipt.request.operationId, state = states.get(id);
  if (state?.state !== 'running' && (pollAttempts.get(id) || 0) >= 5) return;
  pollTimer = setTimeout(() => query(receipt), state?.state === 'running' ? delay : Math.max(delay, (pollAttempts.get(id) || 0) * 1000));
}
async function query(receipt = selectedReceipt.value) {
  if (!client || !receipt || receipt.resolution || submitting.value || stopped) return;
  const id = receipt.request.operationId;
  pollAttempts.set(id, (pollAttempts.get(id) || 0) + 1);
  readControllers.get(id)?.abort();
  const controller = new AbortController(), stamp = (readEpochs.get(id) || 0) + 1;
  readControllers.set(id, controller); readEpochs.set(id, stamp);
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const value = await client.readOperation(receipt, { signal: controller.signal });
    if (stopped || controller.signal.aborted || readEpochs.get(id) !== stamp) return;
    const previous = states.get(id);
    if (terminal(previous) && (previous.state !== value.state || previous.gate !== value.gate || previous.reasonCode !== value.reasonCode)) {
      throw new Error('原操作返回的终态与最近确认结果不一致，请核对引擎保留现场。');
    }
    readErrors.delete(id);
    states.set(id, value);
  } catch (problem) {
    if (!stopped && readEpochs.get(id) === stamp && readControllers.get(id) === controller) {
      const message = controller.signal.aborted ? '原操作查询超时，结果仍待核对。' : problem.message;
      readErrors.set(id, message);
      if (!terminal(states.get(id))) states.set(id, { state: 'unknown', message, code: problem.code || 'NETWORK_ERROR' });
    }
  } finally {
    clearTimeout(timeout);
    if (!stopped && readEpochs.get(id) === stamp) {
      readControllers.delete(id);
      if (id === selectedOperationId.value) schedulePoll();
    }
  }
}
async function start() {
  if (!canStart.value || stopped) return;
  // Another tab may have persisted an attempt since this page last rendered.
  // Re-read before creating a new confirmation, and query any unseen attempt.
  if (!loadReceipts() || unresolved.value) { confirmed.value = false; schedulePoll(0); return; }
  submitting.value = true; confirmed.value = false; error.value = null; stopNotice.value = '';
  clearTimeout(pollTimer);
  const stamp = epoch, controller = new AbortController(); submitController = controller;
  const timeout = setTimeout(() => controller.abort(), 20000);
  let prepared;
  try {
    prepared = client.prepareStart(confirmation.value);
    if (!loadReceipts()) throw new Error('无法重新读取刚保存的操作凭据，本次未发送启动请求。');
    const id = prepared.receipt.request.operationId;
    selectedOperationId.value = id; states.set(id, { state: 'unknown' });
    const value = await prepared.submit({ signal: controller.signal });
    if (stopped) return;
    states.set(id, value);
    if (stamp === epoch && value.runCreated) emit('run-created', value.runId);
  } catch (problem) {
    if (!stopped) {
      loadReceipts();
      if (prepared) states.set(prepared.receipt.request.operationId, { state: 'unknown', message: problem.message, code: problem.code });
      if (problem.code === 'STALE_REVISION') emit('reconcile', problem);
      await showError(problem);
    }
  } finally {
    clearTimeout(timeout);
    if (!stopped) { submitting.value = false; schedulePoll(0); loadCapability(); }
  }
}
async function stop() {
  if (!canStop.value || stopped) return;
  const id = selectedOperationId.value, operation = selectedState.value;
  const controller = new AbortController(); stopController = controller;
  stopRequested.add(id);
  stopping.value = true; stopNotice.value = ''; error.value = null;
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    await client.requestStop({ taskId: operation.taskId, runId: operation.runId }, { signal: controller.signal });
    if (!stopped && id === selectedOperationId.value) {
      stopNotice.value = '已请求停止，正在等待运行记录确认结果。';
    }
  } catch (problem) {
    if (!stopped && id === selectedOperationId.value) {
      stopNotice.value = '停止响应尚未确认，请先查询原操作状态。'; await showError(problem);
    }
  } finally {
    clearTimeout(timeout);
    if (!stopped) { stopping.value = false; schedulePoll(0); }
  }
}
function storageChanged(event) {
  if (event.key !== null && !event.key.startsWith('heimdall-acceptance-execution-v1:')) return;
  confirmed.value = false;
  if (client && loadReceipts()) schedulePoll(0);
}
function visibilityChanged() {
  if (visible() && client) { loadCapability(); schedulePoll(0); }
  else { clearTimeout(pollTimer); clearTimeout(capabilityTimer); }
}
onMounted(async () => {
  window.addEventListener('storage', storageChanged);
  document.addEventListener('visibilitychange', visibilityChanged);
  try {
    client = createAcceptanceExecutionClient({ baseUrl: API, headers: apiHeaders, storage: localStorage });
    if (loadReceipts()) await Promise.allSettled(receipts.value.filter(item => !item.resolution).map(item => query(item)));
    if (!stopped) loadCapability();
  } catch (problem) { if (!stopped) storageError.value = problem.message; }
});
onBeforeUnmount(() => {
  window.removeEventListener('storage', storageChanged);
  document.removeEventListener('visibilitychange', visibilityChanged);
  stopped = true; epoch++; capabilityEpoch++; clearTimeout(pollTimer); clearTimeout(capabilityTimer);
  for (const controller of [previewController, capabilityController, submitController, stopController, ...readControllers.values()]) controller?.abort();
});
</script>

<template>
  <section class="execution-panel" aria-labelledby="execution-title" data-testid="acceptance-execution">
    <div class="execution-heading"><div><h3 id="execution-title">执行已选需求验收</h3><p>核对当前合同，选择待验收版本，再启动一次验收。</p></div>
      <button type="button" class="execution-button" :disabled="capabilityLoading || !client" data-testid="execution-refresh-status" @click="loadCapability"><Icon name="refresh" decorative />核对执行状态</button></div>
    <p class="execution-capability" role="status" data-testid="execution-capability">{{ capabilityError || (!capability ? '正在读取执行状态…' : capability.ready ? '执行器可用 · 支持 GET / HEAD 接口合同' : capability.busy ? '已有验收占用执行槽，请等待当前运行结束。' : capability.blocked ? '执行器需要处理保留现场，请检查引擎状态。' : '执行器暂未就绪，请核对恢复状态。') }}</p>
    <p v-if="storageError" class="execution-warning" role="alert" data-testid="execution-storage-error">{{ storageError }} 请恢复浏览器本地存储后重新进入；启动前必须保存操作凭据。</p>
    <div v-if="error" ref="errorElement" class="execution-error" role="alert" tabindex="-1" data-testid="execution-error"><strong>{{ error.message }}</strong><p><code>{{ error.code }}</code><span v-if="error.status"> · HTTP {{ error.status }}</span></p><p v-if="error.outcomeUnknown || error.writeMayHaveCommitted">启动结果尚待核对，请使用下方原操作记录查询。</p></div>
    <template v-if="selection && candidate && approval">
      <dl class="execution-facts" data-testid="execution-selection"><div><dt>当前需求来源</dt><dd>{{ candidate.source.runId }}</dd></div><div><dt>选用 / 批准</dt><dd><code>{{ selection.id }}</code><code>{{ approval.id }}</code></dd></div><div><dt>合同摘要</dt><dd><code>{{ candidate.contentDigest }}</code></dd></div></dl>
      <button type="button" class="execution-button" :disabled="!canReview || previewLoading" data-testid="execution-review" @click="review">{{ previewLoading ? '正在核对来源…' : '核对本次执行合同' }}</button>
      <details v-if="previewValue" class="execution-contract" data-testid="execution-contract"><summary>已核对完整合同 · {{ previewValue.preview.checks.length }} 项</summary><p>{{ previewValue.preview.source.title || previewValue.preview.source.id }} · {{ previewValue.preview.source.revision }}</p><ol><li v-for="check in previewValue.preview.checks" :key="check.id"><strong>{{ check.method }} {{ check.path }}</strong><span>{{ check.title }}</span><pre>{{ pretty(check.expect) }}</pre></li></ol></details>
      <form class="execution-form" @submit.prevent="start">
        <label for="execution-target">待验收目标版本<select id="execution-target" v-model="targetReleaseId" required :disabled="!ready || submitting" data-testid="execution-target"><option value="">请选择本次待验收版本</option><option v-for="release in releases" :key="release.id" :value="release.id">{{ release.label }} · {{ release.targetUrl }}</option></select></label>
        <div v-if="target" class="execution-target-summary" data-testid="execution-target-summary"><strong>{{ target.label }}</strong><code>{{ target.targetUrl }}</code><span v-if="target.buildRef">构建引用 {{ target.buildRef }}</span><p>版本地址与构建引用由项目登记；本次执行检查该地址的当前响应。</p></div>
        <label class="execution-confirm"><input v-model="confirmed" type="checkbox" :disabled="!confirmation || submitting || unresolved || !capability?.ready" data-testid="execution-confirm" /><span>我已核对上述已选合同与目标版本，确认现在发起一次验收。</span></label>
        <button type="submit" class="execution-button execution-primary" :disabled="!canStart" data-testid="execution-start">{{ submitting ? '正在接纳本次验收…' : '启动需求验收' }}</button>
      </form>
    </template>
    <p v-else class="execution-empty">先在需求基线中批准并选用一份完整 Spec 合同，再回到这里选择目标版本。</p>
    <section v-if="receipts.length" class="execution-operations" aria-labelledby="execution-operations-title">
      <h4 id="execution-operations-title">本机操作记录</h4><p>记录保存在当前浏览器。重新进入后只查询原操作编号。</p>
      <label for="execution-operation">查看操作<select id="execution-operation" v-model="selectedOperationId" data-testid="execution-operation"><option v-for="receipt in receipts" :key="receipt.request.operationId" :value="receipt.request.operationId">{{ dateLabel(receipt.createdAt) }} · {{ receipt.request.operationId.slice(-8) }} · {{ receipt.resolution ? '请求未接纳' : stateLabel(states.get(receipt.request.operationId)) }}</option></select></label>
      <template v-if="selectedReceipt">
        <div class="execution-operation-heading"><strong role="status" data-testid="execution-operation-state">{{ currentStateLabel }}</strong><button type="button" class="execution-button" :disabled="submitting || !!selectedReceipt.resolution" data-testid="execution-query" @click="query()">查询原操作</button></div>
        <p v-if="readErrors.get(selectedOperationId) && terminal(selectedState)" class="execution-warning" role="status" data-testid="execution-read-error">本次查询失败：{{ readErrors.get(selectedOperationId) }} 下方保留最近确认的运行结果；报告与证据需重新读取核验。</p>
        <dl class="execution-facts"><div><dt>操作编号</dt><dd><code data-testid="execution-operation-id">{{ selectedReceipt.request.operationId }}</code></dd></div><div><dt>原目录修订</dt><dd>{{ selectedReceipt.request.expectedGenerationId }} · {{ selectedReceipt.request.expectedRevision }}</dd></div><div><dt>原目标版本</dt><dd><code>{{ selectedReceipt.request.targetReleaseId }}</code></dd></div><div v-if="selectedState?.runCreated"><dt>运行编号</dt><dd><code data-testid="execution-run-id">{{ selectedState.runId }}</code></dd></div></dl>
        <p v-if="selectedReceipt.resolution" class="execution-warning" data-testid="execution-rejection">{{ selectedReceipt.resolution.code }} · 该次请求未被接纳。请重新核对目录、合同与目标后再明确启动。</p>
        <p v-else-if="selectedState?.state === 'prepared'" class="execution-warning">原操作只留下准备记录，未创建运行。该记录不能继续执行，请核对引擎保留现场。</p>
        <p v-else-if="!selectedState || selectedState.state === 'unknown'" class="execution-warning" data-testid="execution-unknown">{{ selectedState?.message || '尚未确认启动结果。' }} 即使暂未找到原操作，也需要继续查询；此页暂不接纳新的启动确认。</p>
        <p v-else-if="selectedState.state === 'completed'" class="execution-result">运行记录已完成。验收结论：{{ GATE_LABELS[selectedState.gate] || selectedState.gate }}。打开报告查看核验后的明细与证据。</p>
        <p v-else-if="selectedState.state === 'interrupted' || selectedState.state === 'failed'" class="execution-warning">{{ stateLabel(selectedState) }} · {{ selectedState.reasonCode || '请查看原运行记录' }}。此次没有完成的验收放行结论。</p>
        <div class="execution-actions"><button v-if="selectedState?.runCreated" type="button" class="execution-button" data-testid="execution-open-run" @click="emit('open-run', selectedState.runId)">查看运行与报告<Icon name="external" decorative /></button><button v-if="selectedState?.state === 'running'" type="button" class="execution-button execution-stop" :disabled="!canStop" data-testid="execution-stop" @click="stop">{{ stopping ? '正在请求停止…' : stopRequested.has(selectedOperationId) ? '已请求停止，等待结果' : '请求停止本次运行' }}</button></div>
        <p v-if="stopNotice" class="execution-warning" role="status" data-testid="execution-stop-notice">{{ stopNotice }}</p>
        <p v-if="!terminal(selectedState) && selectedState?.state !== 'running' && (pollAttempts.get(selectedOperationId) || 0) >= 5" class="execution-warning" data-testid="execution-poll-paused">自动核对已暂停，可点击“查询原操作”继续核对。</p>
      </template>
    </section>
    <p v-if="unresolved" class="execution-warning" data-testid="execution-unresolved">本项目仍有运行或待核对操作。核对原操作结果后，才能确认下一次启动。</p>
  </section>
</template>

<style scoped>
.execution-panel { border-top: 1px solid var(--border); margin-top: 24px; padding-top: 22px; min-width: 0; }
.execution-heading, .execution-operation-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
.execution-heading h3 { font-size: 15px; font-weight: 650; line-height: 1.6; }
.execution-panel h4 { font-size: 13px; line-height: 1.6; font-weight: 650; }
.execution-heading p, .execution-operations > p, .execution-empty { color: var(--text-dim); font-size: 12px; line-height: 1.8; margin-top: 5px; max-width: 72ch; }
.execution-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 10px 14px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text); cursor: pointer; font-size: 12px; line-height: 1.6; }
.execution-button:hover:enabled { border-color: var(--accent-dim); background: var(--bg-2); }
.execution-button:disabled { cursor: not-allowed; opacity: .5; }
.execution-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 650; }
.execution-primary:hover:enabled { background: var(--accent); filter: brightness(1.08); }
.execution-stop { color: var(--warn); }
.execution-panel :is(button, select, input, summary):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.execution-capability { font-size: 12px; line-height: 1.8; color: var(--text-dim); margin: 12px 0; }
.execution-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 22px; padding: 16px 0; font-size: 12px; line-height: 1.8; }
.execution-facts > div { min-width: 0; }
.execution-facts dt { color: var(--text-dim); margin-bottom: 4px; }
.execution-facts dd { color: var(--text); overflow-wrap: anywhere; }
.execution-facts code { display: block; font-family: var(--font-mono); font-size: 11px; }
.execution-contract { margin-top: 13px; border-bottom: 1px solid var(--border); }
.execution-contract > summary { min-height: 44px; padding: 12px 0; font-size: 12px; cursor: pointer; }
.execution-contract p { font-size: 12px; line-height: 1.8; }
.execution-contract ol { list-style: none; padding-bottom: 12px; }
.execution-contract li { border-top: 1px solid var(--border); padding: 12px 0; }
.execution-contract li > span { display: block; font-size: 12px; margin: 4px 0; color: var(--text-dim); }
.execution-contract strong { font-size: 12px; overflow-wrap: anywhere; }
.execution-contract pre { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 11px; line-height: 1.8; color: var(--text-dim); }
.execution-form { display: grid; gap: 14px; margin-top: 17px; }
.execution-panel label { display: flex; flex-direction: column; gap: 7px; min-width: 0; font-size: 12px; color: var(--text-dim); line-height: 1.8; }
.execution-panel select { min-width: 0; width: 100%; min-height: 44px; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: var(--text); font-size: 13px; }
.execution-target-summary { display: grid; gap: 4px; font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.execution-target-summary code { color: var(--text); font-size: 12px; }
.execution-target-summary :is(span, p) { color: var(--text-dim); }
.execution-panel .execution-confirm { flex-direction: row; align-items: start; gap: 11px; cursor: pointer; }
.execution-confirm input { flex: none; width: 17px; height: 17px; margin-top: 3px; accent-color: var(--accent); }
.execution-form > button { justify-self: start; }
.execution-operations { border-top: 1px solid var(--border); margin-top: 23px; padding-top: 19px; }
.execution-operations > label { margin: 14px 0; }
.execution-operation-heading > strong { font-size: 13px; font-weight: 600; }
.execution-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
.execution-warning, .execution-result { color: var(--warn); font-size: 12px; line-height: 1.8; margin-top: 11px; overflow-wrap: anywhere; max-width: 75ch; }
.execution-result { color: var(--text); }
.execution-error { border: 1px solid var(--bad); border-radius: var(--r-sm); color: var(--bad); font-size: 12px; line-height: 1.8; padding: 13px 15px; margin: 13px 0; overflow-wrap: anywhere; }
.execution-error strong { font-weight: 600; }
.execution-error p { margin-top: 5px; }
@media (max-width: 620px) {
  .execution-heading { align-items: start; flex-direction: column; }
  .execution-facts { grid-template-columns: minmax(0, 1fr); }
  .execution-actions { align-items: stretch; flex-direction: column; }
  .execution-form > button { justify-self: stretch; }
}
</style>
