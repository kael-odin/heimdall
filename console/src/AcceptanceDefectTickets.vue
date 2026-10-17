<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders } from './api.js';
import { DEFECT_HANDLING_LABELS, DEFECT_VERIFICATION_LABELS, defectTicketCreateInput, defectTicketCloseInput,
  defectTicketSources, defectTicketList, defectTicketDetail, defectTicketPreview, defectTicketConfirmation,
  defectTicketAction, createDefectTicketReadGuard, createDefectTicketReceipts, requestDefectTickets,
  fetchDefectTicketExport } from './acceptance-defect-tickets.js';

const props = defineProps({ projectId: { type: String, required: true }, detail: { type: Object, default: null },
  version: { type: Object, default: null }, ready: Boolean, active: Boolean });
const drafts = reactive(new Map()), clients = new Map(), guard = createDefectTicketReadGuard(), downloadUrls = new Set();
const tickets = ref([]), sources = ref(null), selectedTicket = ref(null), preview = ref(null), pending = ref([]);
const loading = reactive({ list: false, sources: false, detail: false, preview: false, resolve: false, export: false });
const writing = ref(false), error = ref(''), notice = ref(''), errorElement = ref(null), receiptsReady = ref(false), receiptsWritable = ref(false);
const createConfirmed = ref(false), closeConfirmed = ref(false);
let stopped = false, client, writeToken;
const draft = computed(() => {
  if (!drafts.has(props.projectId)) drafts.set(props.projectId, { candidateId: '', sourceOperationId: '', memberCheckIds: [],
    title: '', severity: 'high', description: '', reproduction: '', selectedTicketId: '', resolution: '' });
  return drafts.get(props.projectId);
});
const candidates = computed(() => props.detail?.project?.id === props.projectId ? props.detail.browserCandidates ?? [] : []);
const releases = computed(() => props.detail?.releases ?? []);
const candidate = computed(() => candidates.value.find(value => value.id === draft.value.candidateId));
const sourceOperation = computed(() => sources.value?.operations.find(value => value.operationId === draft.value.sourceOperationId));
const selectedMembers = computed(() => sourceOperation.value?.members.filter(value => draft.value.memberCheckIds.includes(value.checkId)) ?? []);
const canWrite = computed(() => props.active && props.ready && !stopped && receiptsReady.value && receiptsWritable.value
  && !pending.value.length && !writing.value && !loading.resolve);
const canCreate = computed(() => canWrite.value && createConfirmed.value && !!candidate.value && !!sourceOperation.value
  && sources.value?.contentDigest === candidate.value.contentDigest && selectedMembers.value.length >= 1 && selectedMembers.value.length <= 24
  && selectedMembers.value.length === draft.value.memberCheckIds.length
  && [draft.value.title, draft.value.description, draft.value.reproduction].every(value => value.trim().length));
const canClose = computed(() => canWrite.value && closeConfirmed.value && preview.value?.closeEligible === true
  && preview.value.ticketId === selectedTicket.value?.ticketId && draft.value.resolution.trim().length > 0);
const dateLabel = value => {
  const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
};
const releaseLabel = id => releases.value.find(value => value.id === id)?.label || id;
const pretty = value => JSON.stringify(value, null, 2);
const handling = value => DEFECT_HANDLING_LABELS[value] || value;
const verification = value => DEFECT_VERIFICATION_LABELS[value] || value;
const relationLabel = value => ({ verified_passed: '复验通过', still_failed: '仍有问题', incomparable: '条件不同', unverified: '未核验' })[value] || value;
const current = ticket => !stopped && props.active && props.ready && guard.current(ticket);
const context = () => {
  const projectId = props.projectId, receipts = client, headers = apiHeaders();
  return { projectId, receipts, request: (suffix = '', options = {}) => requestDefectTickets(projectId, suffix, { baseUrl: API, headers, ...options }), headers };
};
async function showError(problem) {
  error.value = problem?.message || '人工缺陷单操作未能核对，请保留原确认。';
  await nextTick(); errorElement.value?.focus({ preventScroll: true });
}
function readPending(receipts = client) {
  const values = receipts.read();
  if (receipts === client) { pending.value = values; receiptsWritable.value = receipts.canWrite; receiptsReady.value = true; }
  return values;
}
function initializeClient() {
  receiptsReady.value = false; receiptsWritable.value = false; pending.value = [];
  try {
    const origin = new URL(API || location.origin, location.href).origin, key = `${origin}:${props.projectId}`;
    if (!clients.has(key)) clients.set(key, createDefectTicketReceipts({ projectId: props.projectId, origin, storage: localStorage }));
    client = clients.get(key); readPending();
  } catch (cause) { client = null; error.value = cause.message; }
}
function resetContext() {
  guard.reset(); tickets.value = []; sources.value = null; selectedTicket.value = null; preview.value = null;
  createConfirmed.value = false; closeConfirmed.value = false; error.value = ''; notice.value = '';
  writeToken = null; writing.value = false; for (const key of Object.keys(loading)) loading[key] = false;
  for (const url of downloadUrls) URL.revokeObjectURL(url); downloadUrls.clear();
}
async function loadList() {
  if (!props.active || !props.ready || stopped) return;
  const ticket = guard.begin('list'), captured = context(); loading.list = true;
  try {
    const value = defectTicketList(await captured.request('', { signal: ticket.signal }), captured.projectId);
    if (current(ticket)) tickets.value = value.tickets;
  } catch (cause) { if (current(ticket)) await showError(cause); }
  finally { if (current(ticket)) loading.list = false; }
}
async function loadSources() {
  if (!props.active || !props.ready || !candidate.value || stopped) return;
  const ticket = guard.begin('sources'), captured = context(), selected = { ...candidate.value };
  sources.value = null; createConfirmed.value = false; loading.sources = true;
  try {
    const value = defectTicketSources(await captured.request(`/sources?candidateId=${selected.id}`, { signal: ticket.signal }),
      captured.projectId, selected.id, selected.contentDigest);
    if (current(ticket) && draft.value.candidateId === selected.id && candidate.value?.contentDigest === selected.contentDigest) sources.value = value;
  } catch (cause) { if (current(ticket)) await showError(cause); }
  finally { if (current(ticket)) loading.sources = false; }
}
async function openTicket(ticketId) {
  if (!props.active || !props.ready || stopped) return;
  const ticket = guard.begin('detail'), captured = context(); guard.begin('preview'); preview.value = null; closeConfirmed.value = false;
  draft.value.selectedTicketId = ticketId; selectedTicket.value = null; loading.detail = true;
  try {
    const value = defectTicketDetail(await captured.request(`/${ticketId}`, { signal: ticket.signal }), captured.projectId, ticketId);
    if (current(ticket) && draft.value.selectedTicketId === ticketId) selectedTicket.value = value.ticket;
  } catch (cause) { if (current(ticket)) await showError(cause); }
  finally { if (current(ticket)) loading.detail = false; }
}
async function previewClose() {
  if (!selectedTicket.value || !props.active || !props.ready || stopped || writing.value) return;
  const ticket = guard.begin('preview'), captured = context(), ticketId = selectedTicket.value.ticketId;
  preview.value = null; closeConfirmed.value = false; loading.preview = true;
  try {
    const detail = defectTicketDetail(await captured.request(`/${ticketId}`, { signal: ticket.signal }), captured.projectId, ticketId).ticket;
    if (!current(ticket) || draft.value.selectedTicketId !== ticketId) return;
    selectedTicket.value = detail;
    if (!detail.currentOperationId) throw new Error('当前没有可核验的最新登记操作，请先检查验收原件。');
    const value = defectTicketPreview(await captured.request(`/${ticketId}/close-preview?afterOperationId=${detail.currentOperationId}`, { signal: ticket.signal }),
      captured.projectId, ticketId, detail.currentOperationId);
    if (value.preview.expectedRevision !== detail.revision || value.preview.expectedHeadSha256 !== detail.headSha256
      || value.preview.memberSetDigest !== detail.memberSetDigest) throw new Error('预览期间缺陷单已变化，请重新读取。');
    if (current(ticket) && draft.value.selectedTicketId === ticketId) preview.value = value.preview;
  } catch (cause) { if (current(ticket)) await showError(cause); }
  finally { if (current(ticket)) loading.preview = false; }
}
async function submit(kind) {
  if (kind === 'create' ? !canCreate.value : !canClose.value) return;
  const ticket = guard.begin('submit'), captured = context(), token = {}; writeToken = token; writing.value = true;
  error.value = ''; notice.value = ''; let original, claimed = false, dispatched = false, accepted = false;
  try {
    const ticketId = kind === 'create' ? 'dt-' + crypto.randomUUID() : selectedTicket.value.ticketId;
    const request = kind === 'create' ? defectTicketCreateInput({ ticketId, actionId: 'da-' + crypto.randomUUID(),
      sourceOperationId: draft.value.sourceOperationId, memberCheckIds: [...draft.value.memberCheckIds], title: draft.value.title,
      severity: draft.value.severity, description: draft.value.description, reproduction: draft.value.reproduction })
      : defectTicketCloseInput({ actionId: 'da-' + crypto.randomUUID(), afterOperationId: preview.value.afterOperationId,
        expectedRevision: preview.value.expectedRevision, expectedHeadSha256: preview.value.expectedHeadSha256,
        memberSetDigest: preview.value.memberSetDigest, factsDigest: preview.value.factsDigest, previewDigest: preview.value.previewDigest,
        resolution: draft.value.resolution, confirmed: true });
    original = await defectTicketConfirmation({ projectId: captured.projectId, ticketId, kind, request });
    if (!current(ticket)) return;
    claimed = await captured.receipts.claimForSubmit(original);
    if (!claimed) { if (current(ticket)) notice.value = '本项目已有原确认待核对；本次没有发送请求。'; return; }
    if (!current(ticket)) { await captured.receipts.cancelUnsent(original); return; }
    readPending(captured.receipts); captured.receipts.markDispatched(original); dispatched = true;
    const raw = await captured.request(kind === 'create' ? '' : `/${ticketId}/close`, { method: 'POST', body: request, signal: ticket.signal });
    const proof = await defectTicketAction(raw, original);
    if (proof.outcome !== 'recorded') throw new Error('提交响应没有完整动作原件，原确认继续保留。');
    await captured.receipts.resolveExact(original, proof); accepted = true;
    if (current(ticket)) { notice.value = kind === 'create' ? '人工缺陷单已记录。固定成员与来源已保存。' : '已明确关闭固定关联检查；后续可靠失败仍会再次打开。'; draft.value.selectedTicketId = ticketId; }
  } catch (cause) {
    if (claimed && dispatched && original && cause?.outcomeUnknown === false) {
      try { await captured.receipts.releaseRejected(original, cause);
        if (current(ticket)) notice.value = '原请求已明确拒绝。草稿保留，请重新读取和预览后再明确提交。';
      } catch { if (current(ticket)) receiptsReady.value = false; }
    }
    if (current(ticket)) await showError(cause);
  } finally {
    if (writeToken === token) { writeToken = null; writing.value = false; }
    if (current(ticket)) {
      createConfirmed.value = false; closeConfirmed.value = false; preview.value = null;
      try { readPending(captured.receipts); } catch (cause) { receiptsReady.value = false; await showError(cause); }
      if (accepted) { await loadList(); if (current(ticket)) await openTicket(original.ticketId); }
    }
  }
}
async function reconcile(original) {
  if (!props.active || !props.ready || stopped || loading.resolve || !client) return;
  const ticket = guard.begin('resolve'), captured = context(); loading.resolve = true; error.value = ''; notice.value = '';
  try {
    const proof = await defectTicketAction(await captured.request(`/actions/${original.actionId}`, { signal: ticket.signal }), original);
    if (proof.outcome === 'unresolved') { if (current(ticket)) notice.value = '服务端尚未给出此动作的完整原件。未查到记录不代表确定未提交，原确认继续保留。'; return; }
    await captured.receipts.resolveExact(original, proof);
    if (current(ticket)) { readPending(captured.receipts); notice.value = '原动作与确认内容已完整核对，本机待核对记录已解除。'; await loadList(); if (current(ticket)) await openTicket(original.ticketId); }
  } catch (cause) { if (current(ticket)) await showError(cause); }
  finally { if (current(ticket)) loading.resolve = false; }
}
async function download(format) {
  if (!selectedTicket.value || !props.active || !props.ready || stopped || loading.export) return;
  const ticket = guard.begin('export'), captured = context(), ticketId = selectedTicket.value.ticketId; loading.export = true;
  try {
    const blob = await fetchDefectTicketExport(captured.projectId, ticketId, format, { baseUrl: API, headers: captured.headers, signal: ticket.signal });
    if (!current(ticket) || selectedTicket.value?.ticketId !== ticketId) return;
    const url = URL.createObjectURL(blob); downloadUrls.add(url);
    const link = document.createElement('a'); link.href = url; link.download = `${ticketId}.${format}`; link.click();
    setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
    notice.value = '导出已准备。共享前请检查人工文字是否包含秘密。';
  } catch (cause) { if (current(ticket)) await showError(cause); }
  finally { if (current(ticket)) loading.export = false; }
}
watch(() => [props.projectId, props.active, props.ready, props.version?.generationId, props.version?.revision], () => {
  resetContext(); initializeClient();
  if (props.active && props.ready) { loadList(); if (candidate.value) loadSources(); if (draft.value.selectedTicketId) openTicket(draft.value.selectedTicketId); }
}, { immediate: true, flush: 'sync' });
watch(() => [props.projectId, draft.value.candidateId], (value, previous) => {
  if (!previous || value[0] !== previous[0]) return;
  guard.begin('sources'); sources.value = null; loading.sources = false; createConfirmed.value = false;
  draft.value.sourceOperationId = ''; draft.value.memberCheckIds = []; if (candidate.value) loadSources();
}, { flush: 'sync' });
watch(() => [props.projectId, draft.value.sourceOperationId], (value, previous) => {
  if (previous && value[0] === previous[0]) draft.value.memberCheckIds = []; createConfirmed.value = false;
}, { flush: 'sync' });
watch(() => [draft.value.title, draft.value.severity, draft.value.description, draft.value.reproduction, [...draft.value.memberCheckIds].sort().join('|')],
  () => { createConfirmed.value = false; }, { flush: 'sync' });
watch(() => draft.value.resolution, () => { closeConfirmed.value = false; }, { flush: 'sync' });
const storageChanged = event => {
  if (client && (event.key === client.key || event.key === null)) {
    createConfirmed.value = false; closeConfirmed.value = false; preview.value = null;
    try { readPending(); } catch (cause) { receiptsReady.value = false; showError(cause); }
  }
};
window.addEventListener('storage', storageChanged);
onBeforeUnmount(() => { stopped = true; resetContext(); guard.stop(); window.removeEventListener('storage', storageChanged); });
</script>

<template>
  <section class="defect-tickets" aria-labelledby="defect-ticket-title" data-testid="defect-tickets" :aria-busy="writing || loading.list || loading.detail">
    <div class="section-heading"><div><p class="eyebrow">问题闭环</p><h3 id="defect-ticket-title">人工缺陷单</h3></div><button type="button" :disabled="!active || !ready || loading.list" data-testid="defect-tickets-refresh" @click="loadList"><Icon name="refresh" decorative />{{ loading.list ? '正在读取…' : '刷新缺陷单' }}</button></div>
    <p class="muted">从已登记的可靠失败固定关联检查。处理状态与当前核验分开；全员同次复验通过后，再明确关闭。</p>
    <div v-if="error" ref="errorElement" role="alert" tabindex="-1" class="feedback error" data-testid="defect-ticket-error">{{ error }}</div>
    <p v-if="notice" role="status" class="feedback" data-testid="defect-ticket-notice">{{ notice }}</p>
    <p v-if="!receiptsReady || !receiptsWritable" class="feedback warning" role="status" data-testid="defect-ticket-readonly">当前本机确认无法安全读写，提交已暂停。仍可读取缺陷单和查询原动作。</p>
    <section v-if="pending.length" class="pending" aria-label="原人工操作待核对" data-testid="defect-ticket-pending">
      <h4>原动作结果待核对 <span>{{ pending.length }}</span></h4><p>原确认已保留。这里只查询原动作，不会重发成单或关闭请求。</p>
      <ol><li v-for="original in pending" :key="original.actionId" :data-defect-action="original.actionId"><strong>{{ original.kind === 'create' ? '人工成单确认' : '明确关闭确认' }}</strong><code>{{ original.actionId }}</code><p>缺陷单 <code>{{ original.ticketId }}</code></p><details><summary>查看原确认内容</summary><pre>{{ pretty(original) }}</pre></details><button type="button" :disabled="!active || !ready || loading.resolve" data-testid="defect-ticket-reconcile" :data-action-id="original.actionId" @click="reconcile(original)">{{ loading.resolve ? '正在只读核对…' : '只读核对原动作' }}</button></li></ol>
    </section>
    <details class="create-panel" data-testid="defect-ticket-create-panel"><summary data-testid="defect-tickets-toggle">从可靠失败创建缺陷单</summary>
      <form @submit.prevent="submit('create')">
        <div class="fields"><label>参考候选<select v-model="draft.candidateId" :disabled="writing" data-testid="defect-tickets-candidate"><option value="">请选择候选</option><option v-for="item in candidates" :key="item.id" :value="item.id">{{ releaseLabel(item.releaseId) }} · {{ item.id.slice(-8) }}</option></select></label><label>固定失败来源<select v-model="draft.sourceOperationId" :disabled="!sources || writing" data-testid="defect-tickets-source"><option value="">{{ loading.sources ? '正在核验登记来源…' : '请选择同一次已登记操作' }}</option><option v-for="operation in sources?.operations || []" :key="operation.operationId" :value="operation.operationId" :disabled="!operation.members.length">{{ releaseLabel(operation.targetReleaseId) }} · {{ dateLabel(operation.acceptedAt) }} · {{ operation.members.length }} 项可靠失败 · {{ operation.operationId.slice(-8) }}</option></select></label></div>
        <div class="actions"><button type="button" :disabled="!active || !ready || !candidate || loading.sources" data-testid="defect-ticket-sources-refresh" @click="loadSources">{{ loading.sources ? '正在核验来源…' : '重新读取登记来源' }}</button></div>
        <p v-if="!candidates.length" class="muted">当前项目还没有 Browser 候选。先在固定来源验收流程中保存候选并登记结果。</p>
        <p v-else-if="sources && !sources.operations.some(operation => operation.members.length)" class="muted" data-testid="defect-ticket-no-sources">此候选暂无已登记的可靠失败，暂不能人工成单。</p>
        <fieldset v-if="sourceOperation" class="member-selection"><legend>固定关联检查 · 已选 {{ draft.memberCheckIds.length }} / 24</legend><p class="muted">只从同一次操作选择 1–24 项。成单后固定来源和成员集合。</p><label v-for="member in sourceOperation.members" :key="member.checkId" class="check-row"><input v-model="draft.memberCheckIds" type="checkbox" :value="member.checkId" :disabled="writing || !draft.memberCheckIds.includes(member.checkId) && draft.memberCheckIds.length >= 24" data-testid="defect-ticket-member" :data-check-id="member.checkId" /><span><strong>{{ member.title || member.checkId }}</strong><small>{{ member.route }} · {{ member.identity.facet }} · {{ member.identity.viewport.width }} × {{ member.identity.viewport.height }}</small><code>{{ member.checkId }}</code></span></label></fieldset>
        <div class="fields"><label>问题标题<input v-model="draft.title" maxlength="240" required :disabled="writing" data-testid="defect-ticket-title" /></label><label>严重度<select v-model="draft.severity" :disabled="writing" data-testid="defect-ticket-severity"><option value="critical">严重</option><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label></div>
        <div class="fields"><label>问题说明<textarea v-model="draft.description" maxlength="4000" rows="4" required :disabled="writing" data-testid="defect-ticket-description" /></label><label>复现步骤<textarea v-model="draft.reproduction" maxlength="4000" rows="4" required :disabled="writing" data-testid="defect-ticket-reproduction" /></label></div>
        <label class="confirm"><input v-model="createConfirmed" type="checkbox" :disabled="!canWrite" data-testid="defect-ticket-create-confirm" /><span>我确认按当前说明，为所选同次失败和固定成员创建人工缺陷单。</span></label><button type="submit" class="primary" :disabled="!canCreate" data-testid="defect-ticket-create">{{ writing ? '正在保存原确认…' : '确认创建缺陷单' }}</button>
      </form>
    </details>
    <div class="ticket-workspace">
      <section class="ticket-list" aria-label="项目人工缺陷单列表"><h4>项目缺陷单 <span>{{ tickets.length }}</span></h4><p v-if="loading.list" class="muted" role="status">正在读取完整事件链…</p><p v-else-if="!tickets.length" class="muted" data-testid="defect-ticket-empty">尚无人工缺陷单。可靠失败可在上方明确成单。</p><ol><li v-for="item in tickets" :key="item.ticketId"><button type="button" class="ticket-row" :class="{ selected: draft.selectedTicketId === item.ticketId }" :aria-pressed="draft.selectedTicketId === item.ticketId" :disabled="!active || !ready" data-testid="defect-ticket-open" :data-ticket-id="item.ticketId" @click="openTicket(item.ticketId)"><strong>{{ item.title }}</strong><span class="status-pair"><span>{{ handling(item.processingStatus) }}</span><span>{{ verification(item.verificationStatus) }}</span></span><small>{{ item.counts.total }} 项固定检查 · {{ item.counts.passed }} 项通过 · 修订 {{ item.revision }}</small></button></li></ol></section>
      <section class="ticket-detail" aria-label="人工缺陷单详情" data-testid="defect-ticket-detail"><p v-if="loading.detail" class="muted" role="status">正在读取原件与当前核验…</p><p v-else-if="!selectedTicket" class="muted">选择一张缺陷单，查看固定证据、当前核验和人工处理历史。</p><template v-else>
        <div class="detail-heading"><h4>{{ selectedTicket.title }}</h4><div class="status-pair"><span data-testid="defect-ticket-handling">人工处理：{{ handling(selectedTicket.processingStatus) }}</span><span data-testid="defect-ticket-verification">当前核验：{{ verification(selectedTicket.verificationStatus) }}</span></div></div>
        <code>{{ selectedTicket.ticketId }}</code><p class="prose">{{ selectedTicket.description }}</p><details><summary>复现步骤与固定来源</summary><p class="prose">{{ selectedTicket.reproduction }}</p><p>来源操作 <code>{{ selectedTicket.source.operationId }}</code></p><p>固定成员集合摘要 <code>{{ selectedTicket.memberSetDigest }}</code></p><ol class="members"><li v-for="member in selectedTicket.members" :key="member.checkId"><strong>{{ member.checkId }}</strong><p>{{ member.route }} · {{ member.identity.viewport.width }} × {{ member.identity.viewport.height }}</p><details><summary>{{ member.evidence.length }} 份证据原件索引</summary><ul><li v-for="evidence in member.evidence" :key="evidence.role"><span>{{ evidence.role }} · {{ evidence.file }} · {{ evidence.bytes }} bytes</span><code>{{ evidence.sha256 }}</code></li></ul></details></li></ol></details>
        <div class="verification-summary"><strong>{{ selectedTicket.counts.passed }} / {{ selectedTicket.counts.total }}</strong><span>关联检查通过</span><p class="muted">失败 {{ selectedTicket.counts.failed }} · 条件不同 {{ selectedTicket.counts.incomparable }} · 未核验 {{ selectedTicket.counts.unverified }}</p></div>
        <p v-if="selectedTicket.verificationStatus === 'integrity_blocked'" class="feedback warning">人工处理历史已保留，当前来源无法完整核验。此状态不能用于声称已修复或关闭。</p>
        <ol class="results"><li v-for="result in selectedTicket.results" :key="result.bugId"><strong>{{ result.sourceCheckId }}</strong><span>{{ relationLabel(result.relation) }}</span><small>{{ result.reason }}</small></li></ol>
        <p v-if="selectedTicket.processingStatus === 'reopened'" class="feedback warning" data-testid="defect-ticket-reopened">关闭后再次登记了可靠失败。后续通过仍需重新预览并明确关闭。</p>
        <div class="close-panel"><h4>明确关闭</h4><p class="muted">读取此候选最新的一次已登记操作。全部固定成员需在同次复验可靠通过；空登记和未核验结果也会阻挡关闭。</p><button type="button" :disabled="!active || !ready || writing || loading.preview || selectedTicket.processingStatus === 'closed'" data-testid="defect-ticket-preview" @click="previewClose">{{ loading.preview ? '正在核验最新复验…' : '预览最新登记复验' }}</button>
          <div v-if="preview" class="preview" data-testid="defect-ticket-close-preview"><p><strong>{{ preview.closeEligible ? '全部固定成员符合关闭条件' : '本次不能关闭' }}</strong> · {{ verification(preview.verificationStatus) }}</p><p v-if="preview.after">复验目标 {{ releaseLabel(preview.after.targetReleaseId) }} · {{ dateLabel(preview.after.acceptedAt) }}</p><code data-testid="defect-ticket-after">{{ preview.afterOperationId }}</code><p class="muted">{{ preview.reason }}</p><ol class="results"><li v-for="result in preview.results" :key="result.bugId"><strong>{{ result.sourceCheckId }}</strong><span>{{ relationLabel(result.relation) }}</span></li></ol></div>
          <form @submit.prevent="submit('close')"><label>处理说明<textarea v-model="draft.resolution" maxlength="4000" rows="3" required :disabled="writing" data-testid="defect-ticket-resolution" /></label><label class="confirm"><input v-model="closeConfirmed" type="checkbox" :disabled="!canWrite || !preview?.closeEligible" data-testid="defect-ticket-confirm" /><span>我已核对本次复验和处理说明，明确关闭这些固定关联检查。</span></label><button type="submit" class="primary" :disabled="!canClose" data-testid="defect-ticket-close">确认明确关闭</button></form>
        </div>
        <details class="history"><summary>人工处理历史 · {{ selectedTicket.history.length }} 次</summary><ol><li v-for="entry in selectedTicket.history" :key="entry.actionId"><strong>{{ entry.kind === 'create' ? '人工成单' : '明确关闭' }} · 修订 {{ entry.revision }}</strong><span>{{ dateLabel(entry.createdAt) }}</span><code>{{ entry.actionId }}</code><p v-if="entry.resolution" class="prose">{{ entry.resolution }}</p></li></ol></details>
        <div class="actions"><button type="button" :disabled="!active || !ready || loading.export" data-testid="defect-ticket-export-md" @click="download('md')">导出 Markdown</button><button type="button" :disabled="!active || !ready || loading.export" data-testid="defect-ticket-export-json" @click="download('json')">导出 JSON</button></div><p class="muted scope-note">仅覆盖此缺陷单固定关联检查，不代表整个项目或业务流程已修复。导出省略原始报告、图片和已识别的敏感字段，共享前仍需检查人工文字。</p>
      </template></section>
    </div>
  </section>
</template>

<style scoped>
.defect-tickets { border-top:1px solid var(--border); padding-top:24px; margin-top:28px; min-width:0; }
.section-heading,.detail-heading { display:flex; justify-content:space-between; align-items:start; flex-wrap:wrap; gap:12px; margin-bottom:12px; }
h3 { font-size:18px; line-height:1.5; } h4 { font-size:14px; line-height:1.6; margin-bottom:8px; } h4 span { color:var(--text-dim); font-weight:400; }
p,label,li { font-size:13px; line-height:1.8; overflow-wrap:anywhere; } .eyebrow { color:var(--text-dim); font-size:11px; letter-spacing:.12em; margin-bottom:4px; }
.muted,small { color:var(--text-dim); } small { font-size:12px; line-height:1.7; } code,pre { font:11px/1.8 var(--font-mono); overflow-wrap:anywhere; }
code { display:inline; } pre { white-space:pre-wrap; max-height:340px; overflow:auto; } .prose { white-space:pre-wrap; margin:12px 0; }
button,input,select,textarea { border:1px solid var(--border-strong); border-radius:var(--r-sm); background:var(--surface); color:var(--text); font:13px/1.6 var(--font); min-height:44px; padding:10px 12px; max-width:100%; }
input,select,textarea { width:100%; } textarea { resize:vertical; } button { cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:8px; text-align:start; }
button:disabled { opacity:.5; cursor:default; } button:hover:not(:disabled) { border-color:var(--accent); } button:active:not(:disabled) { transform:translateY(1px); }
button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; }
.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); font-weight:650; } label { display:flex; flex-direction:column; gap:7px; min-width:0; }
.fields { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:16px; margin:16px 0; } .actions { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
summary { min-height:44px; cursor:pointer; padding:12px 0; font-size:13px; line-height:1.7; } details { min-width:0; } .create-panel { border:1px solid var(--border); border-radius:var(--r-sm); margin:18px 0; padding:0 16px 12px; background:var(--surface); }
.create-panel>summary { font-weight:600; } .confirm,.check-row { flex-direction:row; align-items:start; gap:10px; margin:12px 0; min-height:44px; padding:8px 0; }
.confirm input,.check-row input { width:18px; height:18px; min-height:18px; flex:0 0 18px; margin-top:4px; padding:0; accent-color:var(--accent); } .check-row>span { min-width:0; display:grid; gap:3px; }
.member-selection { border:1px solid var(--border); border-radius:var(--r-sm); padding:12px; min-width:0; } legend { font-size:13px; padding:0 6px; } .check-row { border-bottom:1px solid var(--border); }
.feedback { border-left:3px solid var(--accent); background:var(--surface); padding:12px 14px; margin:14px 0; } .warning,.error { border-color:var(--warn); } .error { color:var(--warn); }
.pending { border:1px solid var(--border-strong); border-radius:var(--r-sm); padding:16px; margin:18px 0; } ol,ul { list-style:none; padding:0; }
.pending li { border-top:1px solid var(--border); margin-top:12px; padding-top:12px; } .pending li>code { display:block; }
.ticket-workspace { display:grid; grid-template-columns:minmax(220px,.8fr) minmax(0,1.6fr); gap:20px; margin-top:24px; }
.ticket-list,.ticket-detail { min-width:0; } .ticket-detail { border-left:1px solid var(--border); padding-left:20px; } .ticket-list ol { display:grid; gap:10px; }
.ticket-row { width:100%; display:grid; gap:9px; padding:14px; justify-content:stretch; } .ticket-row.selected { border-color:var(--accent); background:var(--surface-2); } .ticket-row strong { overflow-wrap:anywhere; }
.status-pair { display:flex; flex-wrap:wrap; gap:6px 10px; font-size:12px; line-height:1.7; color:var(--text-dim); } .status-pair>span { border:1px solid var(--border); padding:2px 7px; border-radius:var(--r-sm); }
.members>li,.history li { padding:12px 0; border-bottom:1px solid var(--border); } .members ul li { padding:6px 0; } .members ul code { display:block; }
.verification-summary { padding:16px; margin:18px 0; background:var(--surface); border:1px solid var(--border); border-radius:var(--r-sm); }
.verification-summary>strong { font-size:24px; margin-right:10px; font-variant-numeric:tabular-nums; } .verification-summary>span { font-size:12px; color:var(--text-dim); }
.results li { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px 12px; padding:10px 0; border-bottom:1px solid var(--border); } .results small { grid-column:1/-1; }
.close-panel { border-top:1px solid var(--border); padding-top:18px; margin-top:20px; } .close-panel>button { margin:12px 0; } .close-panel form { margin-top:16px; }
.preview { border:1px solid var(--border-strong); border-radius:var(--r-sm); background:var(--surface); padding:14px; margin:12px 0; } .history li { display:grid; gap:4px; }
.history li>span { color:var(--text-dim); font-size:12px; } .scope-note { border-top:1px solid var(--border); padding-top:14px; }
@media(max-width:900px) { .ticket-workspace { grid-template-columns:1fr; } .ticket-detail { border-left:0; border-top:1px solid var(--border); padding:20px 0 0; } }
@media(max-width:700px) { p,label,li,button,input,select,textarea,summary { font-size:16px; } .muted,small,.status-pair { font-size:14px; } .fields { grid-template-columns:1fr; } .create-panel,.pending { padding-left:12px; padding-right:12px; } .section-heading>button { width:100%; } }
@media(prefers-reduced-motion:reduce) { button:active:not(:disabled) { transform:none; } }
</style>
