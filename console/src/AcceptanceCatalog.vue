<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import Icon from './Icon.vue';
import AcceptanceBaseline from './AcceptanceBaseline.vue';
import AcceptanceExecution from './AcceptanceExecution.vue';
import AcceptanceBrowserBindings from './AcceptanceBrowserBindings.vue';
import AcceptanceBrowserCandidates from './AcceptanceBrowserCandidates.vue';
import { API, apiHeaders } from './api.js';
import { STATUS_LABELS, GATE_LABELS } from './acceptance-workbench.js';
import { AcceptanceCatalogError, buildCatalogBindingInput, buildCatalogProjectInput, buildCatalogReleaseInput,
  catalogFailure, catalogTargetUrl, catalogTerminalRuns, catalogVersion, createCatalogReadGuard,
  requestAcceptanceCatalog } from './acceptance-catalog.js';
import { validateBaselineWrite } from './acceptance-baseline.js';
import { validateBrowserBindingWrite } from './acceptance-browser-bindings.js';
import { createBrowserCandidateSubmission } from './acceptance-browser-candidates.js';

const props = defineProps({ runs: { type: Array, required: true } });
const emit = defineEmits(['open-run', 'execution-run']);
const expanded = ref(false), loaded = ref(false), listLoading = ref(false), detailLoading = ref(false);
const projects = ref([]), allBindings = ref([]), version = ref(null), selectedProject = ref(''), detail = ref(null);
const projectDraft = reactive({ name: '' });
const drafts = reactive(new Map());
const writing = ref(''), error = ref(null), notice = ref(''), requiresReconcile = ref(false), errorElement = ref(null);
const browserCandidateSelection = ref(null), browserCandidateFacts = ref([]);
const browserCandidateSubmission = createBrowserCandidateSubmission();
let browserCandidateSelectionEpoch = 0;
const listGuard = createCatalogReadGuard(), detailGuard = createCatalogReadGuard();
let listController, detailController, writeController, detailsPromise;
let stopped = false;
let selectionEpoch = 0;
const draft = computed(() => {
  if (!drafts.has(selectedProject.value)) drafts.set(selectedProject.value, {
    release: { label: '', targetUrl: '', buildRef: '' }, binding: { releaseId: '', runId: '', confirmed: false },
  });
  return drafts.get(selectedProject.value);
});
const project = computed(() => detail.value?.project ?? projects.value.find(item => item.id === selectedProject.value));
const releases = computed(() => detail.value?.releases ?? []);
const bindings = computed(() => detail.value?.runBindings ?? []);
const events = computed(() => [...(detail.value?.events ?? [])].reverse());
const terminalRuns = computed(() => catalogTerminalRuns(props.runs));
const bindingByRun = computed(() => new Map([...allBindings.value, ...bindings.value].map(item => [item.runId, item])));
const ready = computed(() => !!version.value && !listLoading.value && !detailLoading.value && !writing.value && !requiresReconcile.value);
const selectedRun = computed(() => terminalRuns.value.find(run => run.runId === draft.value.binding.runId));
const selectedRelease = computed(() => releases.value.find(release => release.id === draft.value.binding.releaseId));
const bindingProblem = computed(() => {
  const { runId, releaseId } = draft.value.binding;
  if (!runId || !releaseId) return '';
  const previous = bindingByRun.value.get(runId);
  if (previous) return `此运行已归属「${previous.projectName || previous.projectId} / ${previous.releaseLabel || previous.releaseId}」，不能重复认领。`;
  if (!selectedRun.value) return '所选运行不在当前历史列表中，请重新选择。列表未包含不代表来源文件缺失。';
  if (!selectedRelease.value) return '所选版本不在当前项目中，请重新选择。';
  try {
    if (catalogTargetUrl(selectedRun.value.targetUrl) !== catalogTargetUrl(selectedRelease.value.targetUrl)) {
      return '运行目标与版本目标不一致；需要完整 URL 一致，包含路径和查询参数。';
    }
  } catch { return '运行或版本目标 URL 无效，无法确认本次归属。'; }
  return '';
});
const canBind = computed(() => ready.value && !!detail.value && !!selectedRun.value && !!selectedRelease.value
  && !bindingProblem.value && draft.value.binding.confirmed);
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const dateLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '时间未记录';
};
const runLabel = run => `${run.name || run.runId} · ${STATUS_LABELS[run.status] || run.status} · ${run.runId.slice(-8)}`;
const eventLabel = event => event.kind === 'candidate-created' ? '记录需求候选'
  : event.kind === 'baseline-approved' ? '批准需求合同' : event.kind === 'baseline-selected' ? '记录 Spec 选用'
  : event.kind === 'browser-source-bound' ? '归属 Browser 来源侧'
  : event.kind === 'browser-candidate-created' ? '记录 Browser 候选'
  : event.kind.includes('binding') || event.kind.includes('bound') ? '认领历史运行'
  : event.kind.includes('release') ? '登记版本' : event.kind.includes('project') ? '创建项目' : event.kind;
const request = (path, options = {}) => requestAcceptanceCatalog(path, { baseUrl: API, headers: apiHeaders(), ...options });

function resetConfirmation() { draft.value.binding.confirmed = false; }
watch(() => [draft.value.binding.runId, draft.value.binding.releaseId], resetConfirmation, { flush: 'sync' });
watch(selectedProject, id => {
  selectionEpoch++;
  browserCandidateSelection.value = null;
  detailController?.abort();
  detailGuard.invalidate();
  detailLoading.value = false;
  detail.value = null;
  resetConfirmation();
  detailsPromise = id ? loadProject(id) : Promise.resolve(true);
}, { flush: 'sync' });

async function showError(problem) {
  error.value = catalogFailure(problem);
  await nextTick();
  errorElement.value?.focus({ preventScroll: true });
}

async function loadProject(id) {
  detailController?.abort();
  const controller = new AbortController();
  detailController = controller;
  const ticket = detailGuard.next(id);
  detailLoading.value = true;
  try {
    const value = await request(`/${encodeURIComponent(id)}`, { signal: controller.signal });
    if (stopped || controller.signal.aborted || !detailGuard.accepts(ticket, selectedProject.value)) return false;
    if (value.project?.id !== id || !Array.isArray(value.releases) || !Array.isArray(value.runBindings) || !Array.isArray(value.events)) {
      throw new AcceptanceCatalogError('项目详情响应无效。', { code: 'INVALID_RESPONSE' });
    }
    const incoming = catalogVersion(value);
    if (version.value && (incoming.generationId !== version.value.generationId || incoming.revision < version.value.revision)) {
      requiresReconcile.value = true;
      throw new AcceptanceCatalogError('目录谱系或修订号已改变，请刷新完整目录后核对。', {
        code: 'STALE_REVISION', currentGenerationId: incoming.generationId, currentRevision: incoming.revision,
      });
    }
    version.value = incoming;
    detail.value = value;
    return true;
  } catch (problem) {
    if (!stopped && !controller.signal.aborted && detailGuard.accepts(ticket, selectedProject.value)) await showError(problem);
    return false;
  } finally { if (!stopped && detailGuard.accepts(ticket, selectedProject.value)) detailLoading.value = false; }
}

async function refreshCatalog({ reconcile = false } = {}) {
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  const ticket = listGuard.next();
  listLoading.value = true;
  try {
    const value = await request('', { signal: controller.signal });
    if (stopped || controller.signal.aborted || !listGuard.accepts(ticket)) return false;
    if (!Array.isArray(value.projects) || !Array.isArray(value.runBindings)) throw new AcceptanceCatalogError('项目目录响应无效。', { code: 'INVALID_RESPONSE' });
    version.value = catalogVersion(value);
    projects.value = value.projects;
    allBindings.value = value.runBindings;
    const id = projects.value.some(item => item.id === selectedProject.value) ? selectedProject.value : projects.value[0]?.id || '';
    if (id !== selectedProject.value) selectedProject.value = id;
    else detailsPromise = id ? loadProject(id) : Promise.resolve(true);
    const detailsOk = await detailsPromise;
    if (stopped || controller.signal.aborted || !listGuard.accepts(ticket)) return false;
    loaded.value = true;
    if (reconcile && detailsOk) {
      requiresReconcile.value = false;
      error.value = null;
      resetConfirmation();
      notice.value = '目录已刷新。草稿已保留，请核对版本和归属记录后再提交。';
    }
    return detailsOk;
  } catch (problem) {
    if (!stopped && !controller.signal.aborted && listGuard.accepts(ticket)) await showError(problem);
    return false;
  } finally { if (!stopped && listGuard.accepts(ticket)) listLoading.value = false; }
}

function onToggle(event) {
  expanded.value = event.target.open;
  if (expanded.value && !loaded.value && !listLoading.value) refreshCatalog();
}

async function mutate(kind) {
  if (!ready.value || stopped) return;
  const projectId = selectedProject.value, currentDraft = draft.value, submittedSelectionEpoch = selectionEpoch;
  let body, path;
  try {
    if (kind === 'project') { body = buildCatalogProjectInput(projectDraft, version.value); path = ''; }
    else if (!projectId || detail.value?.project.id !== projectId) throw new AcceptanceCatalogError('请先读取并选择项目。', { code: 'INVALID_INPUT' });
    else if (kind === 'release') { body = buildCatalogReleaseInput(currentDraft.release, version.value); path = `/${encodeURIComponent(projectId)}/releases`; }
    else {
      if (bindingProblem.value) throw new AcceptanceCatalogError(bindingProblem.value, { code: 'INVALID_INPUT' });
      body = buildCatalogBindingInput(currentDraft.binding, version.value);
      path = `/${encodeURIComponent(projectId)}/run-bindings`;
    }
  } catch (problem) { await showError(problem); return; }
  const snapshot = JSON.stringify(kind === 'project' ? projectDraft : currentDraft[kind === 'release' ? 'release' : 'binding']);
  const submittedProject = project.value?.name || projectId;
  const submittedRelease = selectedRelease.value?.label || body.releaseId;
  error.value = null;
  notice.value = '';
  writing.value = kind;
  const controller = new AbortController();
  writeController = controller;
  let committed = false;
  try {
    const result = await request(path, { method: 'POST', body, signal: controller.signal });
    if (stopped) return;
    const entity = result[kind === 'project' ? 'project' : kind === 'release' ? 'release' : 'binding'];
    if (!entity || (kind === 'binding' ? entity.runId !== body.runId : !entity.id)) {
      throw new AcceptanceCatalogError('写入响应缺少已提交实体，请先刷新核对。', { code: 'INVALID_RESPONSE', writeMayHaveCommitted: true });
    }
    committed = true;
    if (kind === 'project' && JSON.stringify(projectDraft) === snapshot) projectDraft.name = '';
    if (kind === 'release' && JSON.stringify(currentDraft.release) === snapshot) Object.assign(currentDraft.release, { label: '', targetUrl: '', buildRef: '' });
    if (kind === 'binding') {
      if (JSON.stringify(currentDraft.binding) === snapshot) currentDraft.binding.runId = '';
      currentDraft.binding.confirmed = false;
    }
    if (kind === 'project' && selectedProject.value === projectId && selectionEpoch === submittedSelectionEpoch) {
      // The new selection is explicit through project creation; no run is auto-bound.
      projects.value = [...projects.value, entity];
      selectedProject.value = entity.id;
    }
    const refreshed = await refreshCatalog();
    if (!refreshed) requiresReconcile.value = true;
    const subject = kind === 'project' ? `项目「${entity.name}」已创建` : kind === 'release'
      ? `项目「${submittedProject}」已登记版本「${entity.label}」` : `运行已认领到「${submittedProject} / ${submittedRelease}」`;
    notice.value = `${subject}。${refreshed ? '原始运行和报告保持不变。' : '写入已确认，目录读取尚未完成，请刷新核对。'}`;
  } catch (problem) {
    if (!stopped && !controller.signal.aborted) {
      if (problem.status === 409 || problem.code === 'STALE_REVISION' || problem.writeMayHaveCommitted || committed) requiresReconcile.value = true;
      currentDraft.binding.confirmed = false;
      await showError(problem);
    }
  } finally { if (!stopped) writing.value = ''; }
}

function openRun(runId) { expanded.value = false; emit('open-run', runId); }
async function reconcileBaseline(problem) {
  requiresReconcile.value = true;
  await showError(problem);
}
async function writeBaseline(kind, body, projectId) {
  if (!ready.value || stopped || selectedProject.value !== projectId || detail.value?.project.id !== projectId) {
    throw new AcceptanceCatalogError('请先读取当前项目，再提交合同决定。', { code: 'INVALID_INPUT' });
  }
  const paths = { candidate: 'baseline-candidates', approval: 'baseline-approvals', selection: 'baseline-selections', cancellation: 'baseline-selections' };
  if (!paths[kind] || body.expectedGenerationId !== version.value.generationId || body.expectedRevision !== version.value.revision) {
    throw new AcceptanceCatalogError('目录版本已变化，请重新核对合同。', { code: 'STALE_REVISION', status: 409 });
  }
  const submittedProject = project.value?.name || projectId;
  const submittedEpoch = selectionEpoch;
  writing.value = `baseline-${kind}`; error.value = null; notice.value = '';
  const controller = new AbortController(); writeController = controller;
  let committed = false;
  try {
    const result = await request(`/${encodeURIComponent(projectId)}/${paths[kind]}`, { method: 'POST', body, signal: controller.signal });
    validateBaselineWrite(kind, result, { projectId, body });
    committed = true;
    if (stopped) return { ...result, refreshed: false };
    const refreshed = await refreshCatalog();
    if (!refreshed) requiresReconcile.value = true;
    const action = { candidate: '需求候选', approval: '合同批准', selection: 'Spec 选用', cancellation: '取消选用' }[kind];
    notice.value = `项目「${submittedProject}」的${action}已记录。${refreshed ? '未启动新运行，原报告保持不变。' : '写入已确认，读取尚未完成，请刷新核对。'}`;
    return { ...result, refreshed };
  } catch (problem) {
    if (!stopped) {
      if (problem.status === 409 || problem.code === 'STALE_REVISION' || problem.writeMayHaveCommitted || committed) requiresReconcile.value = true;
      resetConfirmation();
      if (submittedEpoch === selectionEpoch) await showError(problem);
      else {
        error.value = catalogFailure(problem);
        notice.value = `项目「${submittedProject}」的合同操作需要刷新核对。当前项目选择保持不变，系统不会自动重发。`;
      }
    }
    throw problem;
  } finally { if (!stopped) writing.value = ''; }
}
async function writeBrowserBinding(body, projectId) {
  if (!ready.value || stopped || selectedProject.value !== projectId || detail.value?.project.id !== projectId) {
    throw new AcceptanceCatalogError('请先读取当前项目，再记录 Browser 来源归属。', { code: 'INVALID_INPUT' });
  }
  if (body.expectedGenerationId !== version.value.generationId || body.expectedRevision !== version.value.revision) {
    const problem = new AcceptanceCatalogError('目录版本已变化，请重新核对 Browser 来源归属。', { code: 'STALE_REVISION', status: 409 });
    requiresReconcile.value = true;
    await showError(problem);
    throw problem;
  }
  const submittedProject = project.value?.name || projectId, submittedEpoch = selectionEpoch;
  const stillSelected = () => selectedProject.value === projectId && selectionEpoch === submittedEpoch;
  writing.value = 'browser-binding'; error.value = null; notice.value = '';
  const controller = new AbortController(); writeController = controller;
  let committed = false;
  try {
    const result = await request(`/${encodeURIComponent(projectId)}/browser-source-bindings`, { method: 'POST', body, signal: controller.signal });
    validateBrowserBindingWrite(result, { projectId, body });
    committed = true;
    if (stopped) return { ...result, refreshed: false };
    if (!stillSelected()) {
      requiresReconcile.value = true;
      notice.value = `项目「${submittedProject}」的 Browser 来源归属已记录。提交已确认，请刷新目录核对。`;
      return { ...result, refreshed: false };
    }
    const refreshed = await refreshCatalog();
    if (!refreshed || !stillSelected()) requiresReconcile.value = true;
    if (stillSelected()) notice.value = `项目「${submittedProject}」的 Browser 来源归属已记录。${refreshed
      ? '归属已完成，可按需核对保存来源。' : '提交已确认，列表待刷新；请刷新目录核对。'}`;
    return { ...result, refreshed: refreshed && stillSelected() };
  } catch (problem) {
    if (!stopped) {
      if (problem.status === 409 || problem.code === 'STALE_REVISION' || problem.writeMayHaveCommitted || committed) requiresReconcile.value = true;
      resetConfirmation();
      if (stillSelected()) await showError(problem);
      else {
        error.value = catalogFailure(problem);
        notice.value = `项目「${submittedProject}」的 Browser 来源归属需要刷新核对。系统不会自动重发。`;
      }
    }
    throw problem;
  } finally {
    if (!stopped) writing.value = '';
    if (writeController === controller) writeController = undefined;
  }
}
function reviewBrowserCandidate(selection) {
  browserCandidateSelection.value = { ...selection, epoch: ++browserCandidateSelectionEpoch };
}
async function writeBrowserCandidate(body, projectId) {
  if (!ready.value || stopped || selectedProject.value !== projectId || detail.value?.project.id !== projectId) {
    throw new AcceptanceCatalogError('请先读取当前项目，再记录 Browser 候选。', { code: 'INVALID_INPUT' });
  }
  if (body.expectedGenerationId !== version.value.generationId || body.expectedRevision !== version.value.revision) {
    const problem = new AcceptanceCatalogError('目录版本已变化，请重新读取完整候选合同。', { code: 'STALE_REVISION', status: 409 });
    requiresReconcile.value = true; await showError(problem); throw problem;
  }
  const submittedEpoch = selectionEpoch, submittedProject = project.value?.name || projectId;
  const stillSelected = () => !stopped && projectId === selectedProject.value && submittedEpoch === selectionEpoch;
  const controller = new AbortController(); writeController = controller;
  writing.value = 'browser-candidate'; error.value = null; notice.value = '';
  try {
    const pending = browserCandidateSubmission.submit({ projectId, body,
      post: input => request(`/${encodeURIComponent(projectId)}/browser-baseline-candidates`, { method: 'POST', body: input, signal: controller.signal }),
      refresh: async () => {
        browserCandidateFacts.value = browserCandidateSubmission.facts();
        if (!stillSelected()) return false;
        return await refreshCatalog() && stillSelected();
      },
    });
    browserCandidateFacts.value = browserCandidateSubmission.facts();
    const result = await pending;
    if (!result.refreshed && !stopped) requiresReconcile.value = true;
    if (!stopped) notice.value = `项目「${submittedProject}」的 Browser 候选已记录。${result.refreshed ? '可从候选记录重新核对完整合同。' : '写入已确认，列表待刷新。'}`;
    return result;
  } catch (problem) {
    if (!stopped) {
      if (problem.status === 409 || problem.code === 'STALE_REVISION' || problem.writeMayHaveCommitted) requiresReconcile.value = true;
      if (stillSelected()) await showError(problem);
      else error.value = catalogFailure(problem);
    }
    throw problem;
  } finally {
    browserCandidateFacts.value = browserCandidateSubmission.facts();
    if (!stopped) writing.value = '';
    if (writeController === controller) writeController = undefined;
  }
}
async function reconcileBrowserCandidate(projectId, sourceBindingId) {
  if (stopped || writing.value || projectId !== selectedProject.value) {
    throw new AcceptanceCatalogError('请先完成当前写入，再核对本项目候选集合。', { code: 'INVALID_INPUT' });
  }
  const controller = new AbortController(); writeController = controller; writing.value = 'browser-candidate-reconcile';
  try {
    const value = await request(`/${encodeURIComponent(projectId)}/browser-baseline-candidates`, { signal: controller.signal });
    const result = browserCandidateSubmission.reconcile(value, { projectId, sourceBindingId });
    browserCandidateFacts.value = browserCandidateSubmission.facts();
    const refreshed = await refreshCatalog({ reconcile: true });
    if (!refreshed) {
      requiresReconcile.value = true;
      if (result.phase === 'absent') throw new AcceptanceCatalogError('集合未找到本次内容，但目录刷新尚未完成。请先刷新目录，再重新读取完整合同。', { code: 'INVALID_RESPONSE' });
    }
    return { ...result, refreshed };
  } finally {
    if (!stopped) writing.value = '';
    if (writeController === controller) writeController = undefined;
  }
}
onBeforeUnmount(() => {
  stopped = true;
  listGuard.stop();
  detailGuard.stop();
  listController?.abort();
  detailController?.abort();
  writeController?.abort();
});
</script>

<template>
  <details class="catalog-panel" :open="expanded" data-testid="acceptance-catalog" @toggle="onToggle">
    <summary data-testid="catalog-toggle"><span><strong>项目与版本</strong><small>将历史运行明确归入本地项目与版本</small></span><Icon name="chevron" decorative :class="{ 'catalog-expanded': expanded }" /></summary>
    <section class="catalog-body" aria-label="本地项目与版本目录" :aria-busy="listLoading || detailLoading || !!writing">
      <div class="catalog-toolbar"><p>后续归属只组织历史记录，原报告保持不变。</p><button type="button" class="catalog-button" :disabled="listLoading || !!writing" data-testid="catalog-refresh" @click="refreshCatalog({ reconcile: true })"><Icon name="refresh" decorative />{{ listLoading ? '正在读取…' : '刷新并核对目录' }}</button></div>
      <div v-if="error" ref="errorElement" class="catalog-error" role="alert" tabindex="-1" data-testid="catalog-error">
        <strong>{{ error.message }}</strong><dl><div><dt>code</dt><dd><code>{{ error.code }}</code></dd></div><div><dt>HTTP</dt><dd>{{ error.status ?? '未收到响应' }}</dd></div><div v-if="error.currentGenerationId"><dt>当前世代</dt><dd><code>{{ error.currentGenerationId }}</code></dd></div><div v-if="error.currentRevision !== null"><dt>当前修订</dt><dd>{{ error.currentRevision }}</dd></div></dl>
        <p v-if="error.writeMayHaveCommitted">请求可能已经提交。请先刷新目录，核对实体与变更记录，再决定是否重新提交。系统不会自动重发。</p><p v-else-if="error.code === 'STALE_REVISION'">目录已被其他操作更新。草稿已保留，请刷新后核对，系统不会自动重发。</p>
        <details v-if="error.details && Object.keys(error.details).length"><summary>查看结构化详情</summary><pre>{{ pretty(error.details) }}</pre></details>
      </div>
      <p v-if="notice" class="catalog-notice" role="status" data-testid="catalog-notice">{{ notice }}</p>
      <p v-if="!loaded && listLoading" class="catalog-hint" role="status">正在读取项目目录…</p>
      <p v-if="version" class="catalog-version" data-testid="catalog-version">目录 <code>{{ version.generationId }}</code><span>修订 {{ version.revision }}</span></p>
      <div class="catalog-project-row">
        <label for="catalog-project">当前项目<select id="catalog-project" v-model="selectedProject" name="catalog-project" :disabled="listLoading || !projects.length"><option value="">{{ projects.length ? '请选择项目' : '尚未创建项目' }}</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <details class="catalog-new-project" :open="loaded && !projects.length" data-testid="catalog-new-project"><summary>新建项目</summary><form @submit.prevent="mutate('project')"><label for="catalog-project-name">项目名称<input id="catalog-project-name" v-model="projectDraft.name" name="catalog-project-name" required maxlength="120" placeholder="例如：商城开发验收" /></label><button type="submit" class="catalog-button catalog-primary" :disabled="!ready" data-testid="catalog-create-project">{{ writing === 'project' ? '正在创建…' : '创建项目' }}</button></form></details>
      </div>
      <p v-if="detailLoading" class="catalog-hint" role="status">正在读取所选项目…</p>
      <template v-if="detail && detail.project.id === selectedProject">
        <div class="catalog-section-heading"><div><h3>版本声明 <span>{{ releases.length }}</span></h3><p>版本一经登记不可修改；目标或构建变化时登记新版本。</p></div></div>
        <p id="catalog-release-note" class="catalog-boundary">URL 与构建引用是版本声明，不证明当前部署内容，也不形成验收放行结论。</p>
        <ul v-if="releases.length" class="catalog-releases"><li v-for="release in releases" :key="release.id" :data-release-id="release.id"><div><strong>{{ release.label }}</strong><span>不可变声明</span></div><code>{{ release.targetUrl }}</code><p v-if="release.buildRef">构建引用 <code>{{ release.buildRef }}</code></p><small>登记于 {{ dateLabel(release.createdAt) }}</small></li></ul>
        <p v-else class="catalog-empty">还没有版本。先登记目标地址，再明确选择历史运行认领。</p>
        <details class="catalog-new-release" data-testid="catalog-new-release"><summary>登记新版本</summary><form class="catalog-release-form" @submit.prevent="mutate('release')"><label for="catalog-release-label">版本名称<input id="catalog-release-label" v-model="draft.release.label" name="catalog-release-label" required maxlength="120" placeholder="例如：v1.2 候选版" /></label><label for="catalog-release-target">版本目标 URL<input id="catalog-release-target" v-model="draft.release.targetUrl" name="catalog-release-target" type="url" required spellcheck="false" placeholder="http://127.0.0.1:3000" aria-describedby="catalog-release-note" /></label><label for="catalog-release-build-ref">构建引用 <span class="catalog-optional">选填</span><input id="catalog-release-build-ref" v-model="draft.release.buildRef" name="catalog-release-build-ref" maxlength="200" spellcheck="false" placeholder="commit、构建编号或交付标记" /></label><button type="submit" class="catalog-button catalog-primary" :disabled="!ready" data-testid="catalog-create-release">{{ writing === 'release' ? '正在登记…' : '登记不可变版本' }}</button></form></details>
        <section class="catalog-binding-form" aria-labelledby="catalog-binding-title"><h3 id="catalog-binding-title">认领已结束的历史运行</h3><p class="catalog-hint">从当前历史列表显式选择。相同 URL 不会自动归属；每次运行只能认领一次。</p><form @submit.prevent="mutate('binding')"><div class="catalog-binding-fields"><label for="catalog-binding-release">归入版本<select id="catalog-binding-release" v-model="draft.binding.releaseId" name="catalog-binding-release" required :disabled="!releases.length"><option value="">请选择版本</option><option v-for="release in releases" :key="release.id" :value="release.id">{{ release.label }} · {{ release.targetUrl }}</option></select></label><label for="catalog-binding-run">历史运行<select id="catalog-binding-run" v-model="draft.binding.runId" name="catalog-binding-run" required :aria-invalid="!!bindingProblem" aria-describedby="catalog-binding-problem"><option value="">请选择已结束运行</option><option v-for="run in terminalRuns" :key="run.runId" :value="run.runId" :disabled="bindingByRun.has(run.runId)">{{ runLabel(run) }}{{ bindingByRun.has(run.runId) ? ' · 已归属' : '' }}</option></select></label></div><p v-if="!terminalRuns.length" class="catalog-hint">当前历史列表没有已结束运行。运行结束后刷新历史即可选择。</p><p v-if="bindingProblem" id="catalog-binding-problem" class="catalog-field-error" role="status">{{ bindingProblem }}</p><p v-if="selectedRun && selectedRelease" class="catalog-binding-selection">将 <strong>{{ selectedRun.name || selectedRun.runId }}</strong> 认领到 <strong>{{ project.name }} / {{ selectedRelease.label }}</strong>。</p><label class="catalog-confirm"><input v-model="draft.binding.confirmed" type="checkbox" name="catalog-binding-confirmed" :disabled="!!bindingProblem || !selectedRun || !selectedRelease" /><span>我确认这是后续归属；原始运行、报告与门禁不变。归属不代表证据或基线已获批准。</span></label><button type="submit" class="catalog-button catalog-primary" :disabled="!canBind" data-testid="catalog-bind-run">{{ writing === 'binding' ? '正在认领…' : '确认认领运行' }}</button></form></section>
        <section class="catalog-bindings" aria-labelledby="catalog-bindings-title"><h3 id="catalog-bindings-title">已归属运行 <span>{{ bindings.length }}</span></h3><ol v-if="bindings.length"><li v-for="binding in bindings" :key="binding.runId" :data-binding-run="binding.runId"><div class="catalog-binding-heading"><strong>{{ binding.releaseLabel || releases.find(item => item.id === binding.releaseId)?.label || binding.releaseId }}</strong><button type="button" class="catalog-button" data-testid="catalog-open-run" :data-run-id="binding.runId" @click="openRun(binding.runId)">查看原运行<Icon name="external" decorative /></button></div><p>{{ binding.source?.name || binding.runId }}</p><p class="catalog-hint">后续归属 · {{ dateLabel(binding.boundAt) }}<span v-if="binding.source"> · {{ STATUS_LABELS[binding.source.status] || binding.source.status }}<span v-if="binding.source.gate"> · {{ GATE_LABELS[binding.source.gate] || binding.source.gate }}</span></span></p><p class="catalog-hint">{{ binding.diagnostics?.scope === 'manifest-only' ? '仅核对运行记录；未核验报告与证据。' : '组织归属记录；未核验报告与证据。' }}</p><ul v-if="binding.diagnostics?.issues?.length" class="catalog-diagnostics"><li v-for="(issue, index) in binding.diagnostics.issues" :key="index"><code>{{ issue.code }}</code> {{ issue.message }}</li></ul></li></ol><p v-else class="catalog-empty">尚未认领运行。已有验收结果不会自动进入此项目。</p></section>
      </template>
      <AcceptanceBrowserBindings v-if="selectedProject" :project-id="selectedProject" :detail="detail" :version="version" :runs="runs"
        :ready="ready && !!detail" :active="expanded" :writing="writing" :requires-reconcile="requiresReconcile"
        :request="request" :write="writeBrowserBinding" @reconcile="reconcileBaseline" @open-run="openRun" @review-candidate="reviewBrowserCandidate" />
      <AcceptanceBrowserCandidates v-if="selectedProject" :project-id="selectedProject" :detail="detail" :version="version"
        :ready="ready && !!detail" :active="expanded" :writing="writing" :requires-reconcile="requiresReconcile"
        :selection="browserCandidateSelection" :facts="browserCandidateFacts" :request="request" :write="writeBrowserCandidate"
        :reconcile-write="reconcileBrowserCandidate" @reconcile="reconcileBaseline" />
      <AcceptanceBaseline v-if="selectedProject" :project-id="selectedProject" :detail="detail" :version="version"
        :ready="ready && !!detail" :writing="writing" :requires-reconcile="requiresReconcile" :request="request" :write="writeBaseline" @reconcile="reconcileBaseline" />
      <AcceptanceExecution v-if="selectedProject" :key="selectedProject" :project-id="selectedProject" :detail="detail" :version="version"
        :ready="ready && !!detail" :active="expanded" :request="request" @reconcile="reconcileBaseline" @open-run="openRun" @run-created="emit('execution-run', $event)" />
      <details v-if="detail && detail.project.id === selectedProject && events.length" class="catalog-events"><summary>目录变更记录 {{ events.length }} 条</summary><ol><li v-for="event in events" :key="event.id"><strong>{{ eventLabel(event) }}</strong><span>修订 {{ event.revision }} · {{ dateLabel(event.at) }}</span><code>{{ event.entityId }}</code><small>本机操作者 · {{ event.actor?.kind || '未记录' }}</small></li></ol></details>
    </section>
  </details>
</template>

<style scoped>
.catalog-panel { margin-bottom: 16px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface-2); min-width: 0; }
.catalog-panel > summary { min-height: 72px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 19px; cursor: pointer; list-style: none; }
.catalog-panel > summary::-webkit-details-marker { display: none; }
.catalog-panel > summary strong { font-size: 14px; font-weight: 600; }
.catalog-panel > summary small { display: block; margin-top: 3px; color: var(--text-dim); font-size: 12px; }
.catalog-panel > summary > .icon { color: var(--text-dim); transition: transform var(--dur) var(--ease); }
.catalog-expanded { transform: rotate(90deg); }
.catalog-body { padding: 0 19px 20px; min-width: 0; }
.catalog-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; border-top: 1px solid var(--border); padding-top: 15px; }
.catalog-toolbar p, .catalog-hint, .catalog-section-heading p, .catalog-boundary { color: var(--text-dim); font-size: 12px; line-height: 1.75; }
.catalog-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 44px; padding: 10px 13px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-sm); cursor: pointer; font-size: 12px; line-height: 1.5; white-space: normal; }
.catalog-button:hover:enabled { background: var(--bg-2); border-color: var(--accent-dim); }
.catalog-primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 650; }
.catalog-primary:hover:enabled { background: var(--accent); filter: brightness(1.08); }
.catalog-version { display: flex; flex-wrap: wrap; gap: 5px 12px; color: var(--text-dim); font-size: 11px; margin: 14px 0 18px; }
.catalog-version code { overflow-wrap: anywhere; }
.catalog-project-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(200px, .85fr); gap: 18px; align-items: start; }
.catalog-body label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; line-height: 1.6; color: var(--text-dim); min-width: 0; }
.catalog-body input:not([type="checkbox"]), .catalog-body select { width: 100%; min-width: 0; min-height: 44px; padding: 10px 12px; color: var(--text); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: 13px; line-height: 1.55; }
.catalog-body summary { cursor: pointer; font-size: 12px; line-height: 1.6; min-height: 44px; padding: 12px 0; }
.catalog-new-project > summary { color: var(--text); }
.catalog-new-project form, .catalog-release-form { display: flex; flex-direction: column; gap: 13px; padding: 3px 0 15px; }
.catalog-new-project .catalog-button { align-self: start; }
.catalog-section-heading { margin-top: 25px; }
.catalog-body h3 { font-size: 13px; line-height: 1.6; font-weight: 650; }
.catalog-body h3 span { color: var(--text-dim); margin-left: 6px; font-weight: 400; }
.catalog-section-heading p { margin-top: 4px; }
.catalog-boundary { margin-top: 9px; border-left: 2px solid var(--accent-dim); padding-left: 11px; }
.catalog-releases { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px; list-style: none; margin-top: 15px; }
.catalog-releases > li { border: 1px solid var(--border); background: var(--surface); border-radius: var(--r-sm); padding: 13px 14px; min-width: 0; }
.catalog-releases > li > div { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; }
.catalog-releases strong { font-size: 13px; overflow-wrap: anywhere; }
.catalog-releases span, .catalog-releases small { font-size: 11px; color: var(--text-dim); }
.catalog-releases code { display: block; color: var(--text-dim); font-size: 11px; margin-top: 7px; overflow-wrap: anywhere; }
.catalog-releases p { font-size: 11px; color: var(--text-dim); margin-top: 7px; }
.catalog-releases p code { display: inline; }
.catalog-releases small { display: block; margin-top: 9px; }
.catalog-empty { color: var(--text-dim); font-size: 12px; line-height: 1.8; padding: 14px 0; }
.catalog-new-release { margin-top: 8px; border-bottom: 1px solid var(--border); }
.catalog-new-release > summary { color: var(--text); }
.catalog-release-form { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.catalog-release-form > label:nth-child(2) { grid-column: 1 / -1; }
.catalog-release-form > .catalog-button { align-self: end; justify-self: end; }
.catalog-optional { color: var(--text-dim); font-size: 11px; }
.catalog-binding-form { margin-top: 23px; }
.catalog-binding-form > .catalog-hint { margin-top: 4px; }
.catalog-binding-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 13px; margin-top: 15px; }
.catalog-binding-selection { margin-top: 12px; font-size: 12px; line-height: 1.8; color: var(--text-dim); overflow-wrap: anywhere; }
.catalog-binding-selection strong { color: var(--text); font-weight: 550; }
.catalog-body .catalog-confirm { flex-direction: row; align-items: start; gap: 11px; padding: 14px 0; cursor: pointer; line-height: 1.8; }
.catalog-confirm input { width: 17px; height: 17px; flex: none; margin-top: 3px; accent-color: var(--accent); }
.catalog-field-error { color: var(--warn); font-size: 12px; line-height: 1.8; margin-top: 10px; }
.catalog-bindings { border-top: 1px solid var(--border); margin-top: 23px; padding-top: 20px; }
.catalog-bindings > ol { list-style: none; }
.catalog-bindings > ol > li { padding: 15px 0; border-bottom: 1px solid var(--border); }
.catalog-binding-heading { display: flex; align-items: center; justify-content: space-between; gap: 15px; }
.catalog-binding-heading strong { font-size: 13px; overflow-wrap: anywhere; }
.catalog-bindings li > p { font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.catalog-bindings li > p:not(.catalog-hint) { color: var(--text); margin-top: 4px; }
.catalog-diagnostics { list-style: none; margin-top: 7px; color: var(--warn); font-size: 11px; line-height: 1.9; overflow-wrap: anywhere; }
.catalog-events { margin-top: 9px; }
.catalog-events ol { list-style: none; }
.catalog-events li { display: grid; gap: 4px; border-top: 1px solid var(--border); padding: 12px 0; color: var(--text-dim); font-size: 12px; }
.catalog-events li strong { font-weight: 550; }
.catalog-events li span, .catalog-events li small { color: var(--text-dim); font-size: 11px; }
.catalog-events code { font-size: 11px; overflow-wrap: anywhere; }
.catalog-error { margin: 13px 0; padding: 13px 15px; background: var(--surface); border: 1px solid var(--bad); border-radius: var(--r-sm); color: var(--bad); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.catalog-error strong { font-weight: 550; }
.catalog-error dl { display: flex; flex-wrap: wrap; gap: 3px 15px; margin-top: 7px; }
.catalog-error dl > div { display: flex; gap: 7px; min-width: 0; }
.catalog-error dt { color: var(--text-dim); }
.catalog-error dd { color: var(--text-dim); overflow-wrap: anywhere; }
.catalog-error p { margin-top: 8px; }
.catalog-error pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 230px; overflow-y: auto; font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); }
.catalog-notice { color: var(--ok); font-size: 12px; line-height: 1.8; margin: 12px 0; overflow-wrap: anywhere; }
@media (max-width: 1000px) { .catalog-project-row, .catalog-binding-fields { grid-template-columns: 1fr; } }
@media (max-width: 620px) {
  .catalog-panel > summary { padding: 14px; }
  .catalog-body { padding: 0 14px 17px; }
  .catalog-toolbar { align-items: start; flex-direction: column; gap: 10px; }
  .catalog-releases, .catalog-release-form { grid-template-columns: 1fr; }
  .catalog-release-form > label:nth-child(2) { grid-column: auto; }
  .catalog-release-form > .catalog-button { justify-self: start; }
  .catalog-binding-heading { align-items: start; flex-direction: column; gap: 8px; }
  .catalog-body select { font-size: 12px; text-overflow: ellipsis; }
}
</style>
