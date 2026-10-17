<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { API, apiHeaders } from './api.js';
import { browserCandidateReviewState } from './acceptance-browser-candidates.js';
import { browserOperationView, browserOperationCollection, browserOperationReport, browserExecutionLedger,
  browserExecutionRegistration, createBrowserExecutionReadGuard, createBrowserExecutionReceipts,
  fetchBrowserExecutionEvidence, requestBrowserExecution } from './acceptance-browser-execution.js';

const props = defineProps({ projectId: { type: String, required: true }, detail: { type: Object, default: null },
  version: { type: Object, default: null }, ready: Boolean, active: Boolean });
const candidateId = ref(''), targetReleaseId = ref(''), confirmed = ref(false), review = ref(null), reviewing = ref(false);
const operations = ref([]), capability = ref(null), pending = ref([]), selected = ref(''), report = ref(null), bugs = ref(null);
const beforeOperationId = ref(''), error = ref(''), notice = ref(''), writing = ref(false), images = ref([]), imageLoading = ref(false);
const guard = createBrowserExecutionReadGuard();
let stopped = false, pollTimer, receiptStore;
const candidates = computed(() => props.detail?.browserCandidates ?? []);
const releases = computed(() => props.detail?.releases ?? []);
const target = computed(() => releases.value.find(value => value.id === targetReleaseId.value));
const candidate = computed(() => candidates.value.find(value => value.id === candidateId.value));
const unknown = computed(() => pending.value.filter(value => !operations.value.some(op => op.operationId === value.operationId)));
const selectedOperation = computed(() => operations.value.find(value => value.operationId === selected.value));
const labels = { prepared: '已准备，未启动', running: '正在验收', completed: '已完成', interrupted: '已中断', failed: '执行失败' };
const gateLabels = { passed: '通过', failed: '发现问题', blocked: '存在阻塞', needs_review: '需要复核' };
const issueLabels = { open: '待处理', reopened: '再次发现', verified_passed: '已复验通过', unverified: '尚未核验' };
const relationLabels = { observed_failure: '首次发现', observed_passed: '本次通过', still_failed: '仍有问题', new_failure: '新增问题',
  verified_passed: '已复验通过', unchanged_passed: '持续通过', unverified: '未能核验', incomparable: '条件不同，无法比较', reopened: '通过后再次发现' };
const pretty = value => JSON.stringify(value, null, 2);
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const path = suffix => `/${props.projectId}/${suffix}`;
const request = (suffix, options = {}) => requestBrowserExecution(path(suffix), { baseUrl: API, headers: apiHeaders(), ...options });
const current = ticket => !stopped && props.active && guard.current(ticket);
const validReview = computed(() => review.value?.candidate?.id === candidateId.value && review.value?.review
  && review.value?.generationId === props.version?.generationId && review.value?.revision === props.version?.revision
  && review.value?.diagnostics?.contentMatches === true && review.value?.presentation?.completeSourceProjection === true);
const canStart = computed(() => props.ready && props.active && validReview.value && target.value && confirmed.value
  && capability.value?.ready && !writing.value && !unknown.value.length && !!receiptStore);

function clearImages() {
  guard.begin('images'); for (const image of images.value) URL.revokeObjectURL(image.url);
  images.value = []; imageLoading.value = false;
}
function clearReview() { guard.begin('review'); reviewing.value = false; review.value = null; confirmed.value = false; }
function reset() {
  guard.reset(); clearTimeout(pollTimer); clearReview(); clearImages();
  report.value = null; selected.value = ''; beforeOperationId.value = ''; bugs.value = null; notice.value = ''; error.value = '';
}
function initializeReceipts() {
  try {
    receiptStore = createBrowserExecutionReceipts({ projectId: props.projectId,
      origin: new URL(API || location.origin, location.href).origin, storage: localStorage });
    pending.value = receiptStore.read();
  } catch { receiptStore = null; pending.value = []; error.value = '本机待核对操作记录无法读取，已阻止提交。'; }
}
async function load() {
  if (stopped || !props.active) return;
  clearTimeout(pollTimer); const ticket = guard.begin('list'), projectId = props.projectId, client = receiptStore;
  try {
    const value = await request('browser-executions', { signal: ticket.signal });
    if (!current(ticket)) return;
    browserOperationCollection(value, projectId);
    // An operation number alone cannot reconcile a receipt for another candidate or target.
    if (client) for (const receipt of client.read()) {
      const found = value.operations.find(op => op.operationId === receipt.operationId);
      if (found) { browserOperationView(found, projectId, receipt.operationId, receipt); client.resolve(receipt.operationId); }
    }
    if (!current(ticket)) return;
    operations.value = value.operations; capability.value = value.capability;
    if (client) pending.value = client.read();
    if (selected.value && report.value && selectedOperation.value?.reportSha256 !== report.value.reportSha256) {
      guard.begin('report'); report.value = null; clearImages();
    }
  } catch (cause) { if (current(ticket) && cause?.name !== 'AbortError') { capability.value = null; error.value = cause.message; } }
  finally {
    if (current(ticket) && (unknown.value.length || operations.value.some(op => op.state === 'running'))) pollTimer = setTimeout(load, 1500);
  }
}
async function reviewCandidate() {
  if (!props.ready || !props.active || !candidate.value || stopped) return;
  clearReview(); const ticket = guard.begin('review'), id = candidateId.value, projectId = props.projectId;
  const sourceBindingId = candidate.value.sourceBindingId, version = { ...props.version };
  reviewing.value = true; error.value = '';
  try {
    const value = await request(`browser-baseline-candidates/${id}`, { signal: ticket.signal });
    if (!current(ticket) || !props.ready || id !== candidateId.value) return;
    const state = browserCandidateReviewState(value, { projectId, sourceBindingId, candidateId: id, version });
    if (!state.review || state.candidate?.contentDigest !== candidate.value?.contentDigest) throw new Error('候选当前来源无法完整核对，请刷新项目后重新读取。');
    review.value = state.value;
  } catch (cause) { if (current(ticket) && cause?.name !== 'AbortError') error.value = cause.message; }
  finally { if (current(ticket)) reviewing.value = false; }
}
async function start() {
  if (!canStart.value) return;
  const ticket = guard.begin('submit'), projectId = props.projectId, client = receiptStore;
  const input = { operationId: 'bo-' + crypto.randomUUID(), expectedGenerationId: props.version.generationId,
    expectedRevision: props.version.revision, candidateId: candidateId.value,
    contentDigest: review.value.candidate.contentDigest, targetReleaseId: targetReleaseId.value };
  writing.value = true; error.value = ''; notice.value = '';
  try {
    client.save(input); pending.value = client.read();
    const value = await requestBrowserExecution(`/${projectId}/browser-executions`, { baseUrl: API, headers: apiHeaders(), method: 'POST', body: input });
    browserOperationView(value, projectId, input.operationId, input);
    if (current(ticket)) { selected.value = value.operationId; notice.value = '本次批准已记录。验收只采集目标，参考来自固定来源材料。'; }
  } catch (cause) {
    if (cause.status >= 400 && cause.status < 500 && !cause.outcomeUnknown) {
      try { client.resolve(input.operationId); } catch { /* Receipt remains if storage is unavailable. */ }
    }
    if (current(ticket)) error.value = cause.message;
  } finally { writing.value = false; if (current(ticket)) { clearReview(); await load(); } }
}
async function openReport(op) {
  if (!props.ready || !props.active || stopped) return;
  selected.value = op.operationId; beforeOperationId.value = ''; report.value = null; clearImages(); error.value = '';
  const ticket = guard.begin('report'), projectId = props.projectId;
  try {
    const value = await request(`browser-executions/${op.operationId}/report`, { signal: ticket.signal });
    if (!current(ticket) || !props.ready || selected.value !== op.operationId) return;
    report.value = browserOperationReport(value, projectId, op);
  } catch (cause) { if (current(ticket) && cause?.name !== 'AbortError') error.value = cause.message; }
}
async function cancel(op) {
  if (!props.ready || !props.active || writing.value || stopped) return;
  const ticket = guard.begin('cancel'), projectId = props.projectId; writing.value = true; error.value = '';
  try {
    const value = await request(`browser-executions/${op.operationId}/cancel`, { method: 'POST', body: {} });
    browserOperationView(value, projectId, op.operationId);
    if (typeof value.stopRequested !== 'boolean') throw new Error('停止结果无法核对，请读取操作终态。');
    if (current(ticket)) { notice.value = '已请求停止，请以操作终态为准。'; await load(); }
  } catch (cause) { if (current(ticket)) error.value = cause.message; }
  finally { writing.value = false; }
}
async function loadBugs() {
  if (!props.ready || !props.active || stopped) return;
  const ticket = guard.begin('bugs'), projectId = props.projectId;
  try { const value = await request('browser-bugs', { signal: ticket.signal }); if (current(ticket) && props.ready) bugs.value = browserExecutionLedger(value, projectId); }
  catch (cause) { if (current(ticket) && cause?.name !== 'AbortError') error.value = cause.message; }
}
async function register() {
  if (writing.value || !report.value || !props.ready || !props.active || stopped) return;
  const ticket = guard.begin('register'), op = selected.value, fullReport = report.value, projectId = props.projectId;
  const before = beforeOperationId.value || null; writing.value = true; error.value = '';
  try {
    const value = await request(`browser-executions/${op}/register-result`, { method: 'POST', body: before ? { beforeOperationId: before } : {} });
    browserExecutionRegistration(value, projectId, op, fullReport, before);
    if (current(ticket)) { notice.value = '本次结果已登记。可靠检查的复验通过记录与业务问题最终关闭分别保留。'; await loadBugs(); }
  } catch (cause) { if (current(ticket)) error.value = cause.message; }
  finally { writing.value = false; }
}
async function loadImages(check) {
  if (!report.value || !props.ready || !props.active || stopped) return;
  clearImages(); const ticket = guard.begin('images'), op = selected.value, fullReport = report.value, projectId = props.projectId;
  imageLoading.value = true; error.value = '';
  try {
    const loaded = [];
    for (const [role, label] of [['baselineScreenshot', '固定来源'], ['targetScreenshot', '本次目标'], ['diff', '视觉差异']]) {
      const file = check.evidence?.[role], entry = fullReport.report.evidenceManifest.find(value => value.file === file);
      if (!entry) { if (role !== 'diff') throw new Error('完成报告缺少所需证据。'); continue; }
      const blob = await fetchBrowserExecutionEvidence({ projectId, operationId: op, entry }, { baseUrl: API, headers: apiHeaders(), signal: ticket.signal });
      if (!current(ticket) || !props.ready || selected.value !== op || report.value !== fullReport) return;
      loaded.push({ role, label, blob });
    }
    if (current(ticket) && props.ready && report.value === fullReport) images.value = loaded.map(({ role, label, blob }) => ({ role, label, url: URL.createObjectURL(blob) }));
  } catch (cause) { if (current(ticket) && cause?.name !== 'AbortError') { clearImages(); error.value = cause.message; } }
  finally { if (current(ticket)) imageLoading.value = false; }
}
watch(() => [props.projectId, props.version?.generationId, props.version?.revision], () => {
  reset(); candidateId.value = ''; targetReleaseId.value = ''; operations.value = []; capability.value = null;
  initializeReceipts(); if (props.active) load();
}, { immediate: true, flush: 'sync' });
watch([candidateId, targetReleaseId], () => { reset(); if (props.active) load(); }, { flush: 'sync' });
watch(() => [props.active, props.ready], ([active]) => { reset(); if (active) { initializeReceipts(); load(); } }, { flush: 'sync' });
onBeforeUnmount(() => { stopped = true; reset(); });
</script>

<template>
  <section class="browser-execution" aria-label="固定来源 Browser 验收" data-testid="browser-execution">
    <h3>固定来源验收</h3><p class="muted">批准一个已保存候选用于本次目标验收。参考取自已核验材料，每次只访问目标版本；执行完成后再登记问题与复验。</p>
    <div class="fields"><label>参考候选<select v-model="candidateId" data-testid="browser-execution-candidate"><option value="">请选择候选</option><option v-for="candidate in candidates" :key="candidate.id" :value="candidate.id">{{ releases.find(value => value.id === candidate.releaseId)?.label || candidate.id }} · {{ candidate.id }}</option></select></label><label>本次目标版本<select v-model="targetReleaseId" data-testid="browser-execution-target"><option value="">请选择目标版本</option><option v-for="release in releases" :key="release.id" :value="release.id">{{ release.label }} · {{ release.targetUrl }}</option></select></label></div>
    <div class="actions"><button type="button" :disabled="!ready || !active || !candidateId || reviewing || writing" data-testid="browser-execution-review" @click="reviewCandidate">{{ reviewing ? '正在核验来源…' : '复核本次验收合同' }}</button><button type="button" :disabled="!active" data-testid="browser-execution-refresh" @click="load">读取操作并核对结果</button></div>
    <div v-if="validReview" class="review" data-testid="browser-execution-confirmation"><p>参考：{{ review.organizationContext.release.label }} · {{ review.sourceProjection.source.side }}；目标：{{ target?.label || '请选择版本' }}</p><p class="mono">{{ review.candidate.contentDigest }}</p><p class="muted">{{ review.review.declaredSlots }} 项声明检查；本次授权范围为所选目标，原比较门禁保持原结论。</p><details><summary>查看完整候选合同原文</summary><pre>{{ pretty(review) }}</pre></details><label class="confirm"><input v-model="confirmed" type="checkbox" data-testid="browser-execution-confirm" /><span>我已核对完整来源，批准此候选用于本次所选目标验收。</span></label><button type="button" class="primary" :disabled="!canStart" data-testid="browser-execution-start" @click="start">{{ writing ? '正在接纳…' : '批准并开始本次验收' }}</button></div>
    <p v-if="unknown.length" class="warning" role="status" data-testid="browser-execution-unknown">{{ unknown.length }} 次启动结果尚待核对。已保留原操作编号，正在只读查询，暂不重复提交。</p>
    <p v-if="notice" role="status" class="muted">{{ notice }}</p><p v-if="error" role="alert" class="warning" data-testid="browser-execution-error">{{ error }}</p>
    <p v-if="!operations.length" class="muted" data-testid="browser-execution-empty">尚无本次验收操作。请选择候选与目标，完整复核后开始。</p><ol class="operations"><li v-for="op in operations" :key="op.operationId" :data-browser-operation="op.operationId"><div><strong>{{ op.targetLabel }}</strong><span>{{ labels[op.state] }}{{ op.gate ? ' · ' + gateLabels[op.gate] : '' }}</span></div><code>{{ op.operationId }}</code><p v-if="op.summary" class="muted">目标缺陷 {{ op.summary.bugs }} · 通过 {{ op.summary.passed }} · 阻塞 {{ op.summary.blocked }}</p><button v-if="op.state === 'completed'" type="button" :disabled="!ready || !active" data-testid="browser-execution-open-report" :data-operation-id="op.operationId" @click="openReport(op)">读取完成报告与证据</button><button v-if="op.state === 'running'" type="button" :disabled="!ready || !active || writing" data-testid="browser-execution-stop" @click="cancel(op)">请求停止</button></li></ol>
    <section v-if="report" class="result" data-testid="browser-execution-report"><h4>本次验收结果 · {{ gateLabels[report.gate] }}</h4><p class="muted">{{ report.report.checks.length }} 项检查，{{ report.summary?.bugs }} 个目标缺陷。来源不重访，未声明范围保持未测。</p><ul class="checks"><li v-for="check in report.report.checks" :key="check.id"><span>{{ check.title }} · {{ check.status }} / {{ check.verdict }}</span><button v-if="check.evidence?.diff" type="button" :disabled="imageLoading" data-testid="browser-execution-images" @click="loadImages(check)">查看来源、目标与差异图</button></li></ul><div v-if="images.length" class="images"><figure v-for="image in images" :key="image.role"><figcaption>{{ image.label }}</figcaption><img :src="image.url" :alt="image.label + '验收证据'" /></figure></div><details><summary>查看完整完成报告</summary><pre>{{ pretty(report.report) }}</pre></details><label>显式复验此前运行 <span class="muted">首次登记可留空</span><select v-model="beforeOperationId" data-testid="browser-execution-before"><option value="">首次登记，不声明修复</option><option v-for="op in operations.filter(value => value.state === 'completed' && value.operationId !== selected && value.candidateId === report.candidateId)" :key="op.operationId" :value="op.operationId">{{ op.targetLabel }} · {{ op.operationId }}</option></select></label><button type="button" :disabled="writing || !ready" data-testid="browser-execution-register" @click="register">登记本次问题与复验</button></section>
    <div class="actions"><button type="button" :disabled="!ready || !active" data-testid="browser-bugs-refresh" @click="loadBugs">读取持久问题记录</button></div>
    <section v-if="bugs" data-testid="browser-bugs" class="ledger" aria-label="项目问题与复验记录">
      <h4>项目问题与复验记录</h4><p class="muted">记录按声明检查汇总。已复验通过表示对应检查的同源可靠复验结果，业务问题最终关闭仍需另行确认。</p>
      <p v-if="!bugs.issues.length" class="muted" data-testid="browser-bugs-empty">尚无已登记的问题。完成验收后，可在报告中登记本次结果。</p>
      <ol class="issues"><li v-for="issue in bugs.issues" :key="issue.bugId" :data-browser-bug="issue.bugId">
        <div class="issue-heading"><strong>{{ issue.title }}</strong><span :data-browser-bug-state="issue.status">{{ issueLabels[issue.status] }}</span></div>
        <p>{{ issue.route }} · {{ issue.facet }} · {{ issue.viewport.width }} × {{ issue.viewport.height }}</p>
        <p class="muted">最近目标：{{ releases.find(release => release.id === issue.latestTargetReleaseId)?.label || issue.latestTargetReleaseId }}</p>
        <details><summary>查看 {{ issue.history.length }} 次发现与复验</summary><ol class="issue-history"><li v-for="(item, index) in issue.history" :key="item.operationId + ':' + index"><strong>{{ relationLabels[item.relation] || item.relation }}</strong><span>{{ dateLabel(item.recordedAt) }}</span><code>{{ item.operationId }}</code></li></ol></details>
      </li></ol>
      <details><summary>查看完整登记原文</summary><pre>{{ pretty(bugs) }}</pre></details>
    </section>
  </section>
</template>

<style scoped>
.browser-execution { margin-top:24px; padding-top:20px; border-top:1px solid var(--border); min-width:0; }
h3,h4 { font-size:14px; margin-bottom:8px; } p { font-size:12px; line-height:1.8; overflow-wrap:anywhere; }
.muted { color:var(--text-dim); } .warning { color:var(--warn); margin:12px 0; } .mono,code { font:11px/1.7 var(--font-mono); overflow-wrap:anywhere; }
.fields { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:16px 0; } label { display:flex; flex-direction:column; gap:7px; font-size:12px; line-height:1.7; min-width:0; }
select,button { min-height:44px; border:1px solid var(--border-strong); border-radius:var(--r-sm); color:var(--text); background:var(--surface); font:12px/1.6 var(--font); padding:10px 12px; max-width:100%; }
select { width:100%; } button { cursor:pointer; } button:disabled { opacity:.5; cursor:default; } button:focus-visible,select:focus-visible,input:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.primary { background:var(--accent); color:var(--bg); font-weight:650; } .actions { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
.review,.result { border:1px solid var(--border); border-radius:var(--r-sm); background:var(--surface); padding:15px; margin:14px 0; min-width:0; } .confirm { flex-direction:row; align-items:start; margin:14px 0; gap:10px; } .confirm input { margin-top:5px; accent-color:var(--accent); }
summary { min-height:44px; padding:12px 0; font-size:12px; cursor:pointer; } pre { max-height:380px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font:11px/1.7 var(--font-mono); color:var(--text-dim); }
.operations,.checks { list-style:none; padding:0; } .operations li { border-bottom:1px solid var(--border); padding:14px 0; display:grid; gap:7px; min-width:0; } .operations li>div { display:flex; flex-wrap:wrap; justify-content:space-between; gap:8px; font-size:12px; } .operations button { justify-self:start; }
.checks li { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 0; border-bottom:1px solid var(--border); font-size:12px; overflow-wrap:anywhere; } .images { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin:14px 0; } figure { min-width:0; } figcaption { font-size:12px; margin:8px 0; } img { max-width:100%; height:auto; border:1px solid var(--border); }
.result>label { margin:14px 0; } .ledger { margin-top:24px; padding-top:20px; border-top:1px solid var(--border); min-width:0; } .issues,.issue-history { list-style:none; padding:0; } .issues>li { padding:16px 0; border-bottom:1px solid var(--border); } .issue-heading { display:flex; flex-wrap:wrap; justify-content:space-between; gap:10px; font-size:14px; line-height:1.7; } .issue-heading span { color:var(--text-dim); } .issue-history li { display:grid; gap:6px; padding:12px 0; font-size:12px; line-height:1.7; } .issue-history span { color:var(--text-dim); }
@media(max-width:700px) { p,label,select,button { font-size:16px; } .muted,.checks li { font-size:14px; } .fields,.images { grid-template-columns:1fr; } .checks li { align-items:start; flex-direction:column; } .review,.result { padding:12px; } }
</style>
