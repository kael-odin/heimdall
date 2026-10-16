<script setup>
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders } from './api.js';
import {
  DIMENSIONS, STATUS_LABELS, GATE_LABELS, VERDICT_LABELS, buildAcceptanceInput,
  filterAcceptanceChecks, acceptanceEvidenceEntries, acceptanceScore, acceptanceViewport,
} from './acceptance-workbench.js';

defineEmits(['close']);
const form = reactive({ name: '', mode: 'mirror', baselineUrl: '', targetUrl: '', routes: '/', points: '', maskSelectors: '' });
const runs = ref([]);
const runsLoaded = ref(false);
const listError = ref('');
const creating = ref(false);
const formError = ref('');
const selectedId = ref('');
const manifest = ref(null);
const report = ref(null);
const runError = ref('');
const loadingRun = ref(false);
const downloading = ref('');
const downloadError = ref('');
const triage = ref(null);
const triageLoading = ref(false);
const triageError = ref('');
const triageEligible = computed(() => report.value?.checks.some(check => check.status !== 'passed') ?? false);
const filters = reactive({ dimension: 'all', verdict: 'attention', query: '' });
const evidence = reactive({});
const resultsElement = ref(null);
const filteredChecks = computed(() => filterAcceptanceChecks(report.value?.checks ?? [], filters));
const summary = computed(() => report.value?.summary ?? manifest.value?.summary ?? null);
const routeCount = computed(() => new Set(form.routes.split(/\r?\n/).map(x => x.trim()).filter(Boolean)).size);
function insertPointExample() {
  form.points = JSON.stringify([{
    id: 'MENU-OPEN', title: '菜单点击后展开', route: form.routes.split(/\r?\n/).map(x => x.trim()).find(Boolean) || '/', severity: 'high',
    steps: [{ action: 'click', selector: 'button[aria-label="菜单"]' }],
    assertions: [{ kind: 'attribute', selector: 'button[aria-label="菜单"]', attribute: 'aria-expanded', equals: 'true' }],
  }], null, 2);
}
const currentRunning = computed(() => manifest.value?.status === 'running');
const runningCount = computed(() => runs.value.filter(run => run.status === 'running').length);
let stopped = false;
let listTimer, runTimer;
let listController, runController, createController, downloadController, triageController;
let triageRestoreAttempted = false;
let listEpoch = 0;
let runEpoch = 0;
const evidenceControllers = new Set();
const blobUrls = new Set();
const downloadTimers = new Set();
const count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const pretty = value => value == null ? '未记录' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const oracleLabel = value => value && typeof value === 'object'
  ? [value.kind === 'approved-runtime' ? '运行基线' : value.kind, value.source].filter(Boolean).join(' · ') || pretty(value)
  : value || '未记录';
const evidenceLabel = value => value === 'browser-reproduced' ? '浏览器实测' : value || '未记录';
const coverageLabel = computed(() => summary.value?.coverage?.total > 0
  ? `已测 ${count(summary.value.coverage.measured)} / ${count(summary.value.coverage.total)} 项 · ${count(summary.value.passed)} 项通过`
  : '未声明有效检查，无法判断验收通过');
const dimensionLabel = value => DIMENSIONS.find(item => item.id === value)?.label ?? value;
function dimensionReading(dimension) {
  const value = summary.value?.dimensions?.[dimension];
  if (!(value?.total > 0)) return '未声明';
  if (dimension === 'visual') return acceptanceScore(value.score);
  if (value.failed > 0) return '有失败';
  if (value.blocked > 0) return '受阻';
  if (value.needsReview > 0) return '待复核';
  return '已检查';
}
function showResults() {
  resultsElement.value?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start',
  });
}
const dateLabel = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '时间未记录';
};
const progressLabel = computed(() => {
  const progress = manifest.value?.progress;
  if (!progress) return '浏览器正在采集基线、目标与差异证据。';
  if (typeof progress === 'string') return progress;
  return [progress.message || progress.stage, progress.route,
    Number.isFinite(progress.completed) && Number.isFinite(progress.total) ? `${progress.completed} / ${progress.total}` : '',
  ].filter(Boolean).join(' · ') || '正在执行验收计划…';
});

async function request(path, { signal, method = 'GET', body, responseType = 'json' } = {}) {
  const response = await fetch(`${API}/api/acceptance/runs${path}`, {
    method, headers: apiHeaders(), signal, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || data.message || `引擎返回 HTTP ${response.status}。`);
  }
  if (responseType === 'blob') return response.blob();
  if (!(response.headers.get('content-type') ?? '').includes('json')) throw new Error('引擎返回内容不是 JSON，请检查引擎地址与版本。');
  return response.json();
}

async function loadRuns() {
  clearTimeout(listTimer);
  listController?.abort();
  listController = new AbortController();
  const signal = listController.signal;
  const epoch = ++listEpoch;
  try {
    const data = await request('', { signal });
    if (stopped || signal.aborted || epoch !== listEpoch) return;
    if (!Array.isArray(data.runs)) throw new Error('验收历史格式无效，请更新引擎后重试。');
    runs.value = data.runs;
    listError.value = '';
    if (!selectedId.value && data.runs.length) {
      const savedId = localStorage.getItem('heimdall-acceptance-run');
      const initial = data.runs.find(run => run.runId === savedId) ?? data.runs[0];
      selectRun(initial.runId);
    }
  } catch (error) {
    if (!signal.aborted && !stopped && epoch === listEpoch) listError.value = error.message;
  } finally {
    if (!stopped && epoch === listEpoch) {
      runsLoaded.value = true;
      listTimer = setTimeout(loadRuns, 2000);
    }
  }
}

function clearEvidence() {
  for (const controller of evidenceControllers) controller.abort();
  evidenceControllers.clear();
  for (const url of blobUrls) URL.revokeObjectURL(url);
  blobUrls.clear();
  for (const key of Object.keys(evidence)) delete evidence[key];
}

function selectRun(id) {
  if (!id || stopped) return;
  clearTimeout(runTimer);
  runController?.abort();
  downloadController?.abort();
  triageController?.abort();
  clearEvidence();
  runEpoch++;
  selectedId.value = id;
  manifest.value = null;
  report.value = null;
  runError.value = '';
  downloadError.value = '';
  downloading.value = '';
  triage.value = null;
  triageError.value = '';
  triageLoading.value = false;
  triageRestoreAttempted = false;
  filters.dimension = 'all';
  filters.verdict = 'attention';
  filters.query = '';
  localStorage.setItem('heimdall-acceptance-run', id);
  loadSelected(id, runEpoch);
}

async function loadSelected(id = selectedId.value, epoch = runEpoch) {
  clearTimeout(runTimer);
  runController?.abort();
  runController = new AbortController();
  const signal = runController.signal;
  loadingRun.value = !manifest.value;
  let keepPolling = true;
  try {
    const data = await request(`/${encodeURIComponent(id)}`, { signal });
    if (stopped || signal.aborted || epoch !== runEpoch || id !== selectedId.value) return;
    manifest.value = data;
    runError.value = '';
    keepPolling = data.status === 'running';
    if (data.status === 'completed' && !report.value) {
      const result = await request(`/${encodeURIComponent(id)}/report`, { signal });
      if (stopped || signal.aborted || epoch !== runEpoch || id !== selectedId.value) return;
      if (result.runId !== id || !Array.isArray(result.checks)) throw new Error('验收报告格式无效，请刷新重试。');
      report.value = result;
    }
    if (data.triageAvailable === true && triageEligible.value && !triageRestoreAttempted && !triageLoading.value) {
      triageRestoreAttempted = true;
      loadTriage('GET', id, epoch);
    }
  } catch (error) {
    if (!signal.aborted && !stopped && epoch === runEpoch) {
      runError.value = error.message;
      keepPolling = true;
    }
  } finally {
    if (!stopped && epoch === runEpoch && !signal.aborted) {
      loadingRun.value = false;
      if (keepPolling) runTimer = setTimeout(() => loadSelected(id, epoch), 1000);
    }
  }
}

async function createRun() {
  formError.value = '';
  let input;
  try { input = buildAcceptanceInput(form); } catch (error) { formError.value = error.message; return; }
  creating.value = true;
  createController = new AbortController();
  try {
    const result = await request('', { method: 'POST', body: input, signal: createController.signal });
    if (stopped) return;
    if (!result.runId) throw new Error('引擎没有返回验收任务 ID，请刷新历史确认任务是否已创建。');
    selectRun(result.runId);
    await loadRuns();
  } catch (error) {
    if (!stopped && !createController.signal.aborted) formError.value = error.message;
  } finally { if (!stopped) creating.value = false; }
}

async function loadEvidence(check) {
  if (evidence[check.id]) return;
  const epoch = runEpoch;
  const id = selectedId.value;
  const state = reactive({ loading: true, files: [], errors: [] });
  evidence[check.id] = state;
  const controller = new AbortController();
  evidenceControllers.add(controller);
  const results = await Promise.allSettled(acceptanceEvidenceEntries(check).map(async item => {
    const blob = await request(`/${encodeURIComponent(id)}/evidence/${encodeURIComponent(item.filename)}`, { signal: controller.signal, responseType: 'blob' });
    if (stopped || controller.signal.aborted || epoch !== runEpoch) return null;
    const isImage = /\.png$/i.test(item.filename);
    if (isImage && !blob.type.startsWith('image/png')) throw new Error(`${item.label}不是 PNG 图片。`);
    if (!isImage && !blob.type.includes('json')) throw new Error(`${item.label}不是 JSON 文件。`);
    const content = isImage ? '' : await blob.text();
    if (stopped || controller.signal.aborted || epoch !== runEpoch) return null;
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    return { ...item, isImage, url, content };
  }));
  evidenceControllers.delete(controller);
  if (stopped || controller.signal.aborted || epoch !== runEpoch) return;
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) state.files.push(result.value);
    if (result.status === 'rejected') state.errors.push(result.reason.message);
  }
  state.loading = false;
}

function onCheckToggle(check, event) { if (event.target.open) loadEvidence(check); }
function retryEvidence(check) {
  for (const file of evidence[check.id]?.files ?? []) { URL.revokeObjectURL(file.url); blobUrls.delete(file.url); }
  delete evidence[check.id];
  loadEvidence(check);
}

async function loadTriage(method = 'POST', id = selectedId.value, epoch = runEpoch) {
  if (!triageEligible.value || triageLoading.value || stopped) return;
  triageController?.abort();
  const controller = new AbortController();
  triageController = controller;
  triageLoading.value = true;
  triageError.value = '';
  try {
    const result = await request(`/${encodeURIComponent(id)}/triage`, {
      method, signal: controller.signal, ...(method === 'POST' ? { body: {} } : {}),
    });
    if (stopped || controller.signal.aborted || epoch !== runEpoch || id !== selectedId.value) return;
    if (result.kind !== 'ai-assistance' || !['completed', 'disabled', 'failed'].includes(result.status)
      || !Array.isArray(result.items)) throw new Error('AI 解读格式无效，请检查模型输出后重试。');
    triage.value = result;
    if (result.status === 'failed') triageError.value = result.error || '模型未能完成解读。';
    if (manifest.value && result.status === 'completed') manifest.value.triageAvailable = true;
  } catch (error) {
    if (!stopped && !controller.signal.aborted && epoch === runEpoch && id === selectedId.value) triageError.value = error.message;
  } finally {
    if (!stopped && !controller.signal.aborted && epoch === runEpoch && id === selectedId.value) triageLoading.value = false;
  }
}

const triageCheckTitle = checkId => {
  const check = report.value?.checks.find(item => item.id === checkId);
  return check ? `${check.title} · ${check.route} · ${acceptanceViewport(check.viewport)}` : checkId;
};

async function downloadReport(format) {
  if (!report.value || downloading.value) return;
  const id = selectedId.value;
  const epoch = runEpoch;
  downloading.value = format;
  downloadError.value = '';
  downloadController = new AbortController();
  try {
    const blob = format === 'json'
      ? new Blob([JSON.stringify(report.value, null, 2)], { type: 'application/json;charset=utf-8' })
      : await request(`/${encodeURIComponent(id)}/report.md`, { signal: downloadController.signal, responseType: 'blob' });
    if (stopped || epoch !== runEpoch || downloadController.signal.aborted) return;
    const url = URL.createObjectURL(blob);
    blobUrls.add(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${id}-acceptance.${format === 'json' ? 'json' : 'md'}`;
    anchor.click();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); blobUrls.delete(url); downloadTimers.delete(timer); }, 1000);
    downloadTimers.add(timer);
  } catch (error) {
    if (!stopped && epoch === runEpoch && !downloadController.signal.aborted) downloadError.value = error.message;
  } finally { if (!stopped && epoch === runEpoch) downloading.value = ''; }
}

onMounted(loadRuns);
onBeforeUnmount(() => {
  stopped = true;
  listEpoch++;
  runEpoch++;
  clearTimeout(listTimer);
  clearTimeout(runTimer);
  for (const timer of downloadTimers) clearTimeout(timer);
  listController?.abort();
  runController?.abort();
  createController?.abort();
  downloadController?.abort();
  triageController?.abort();
  clearEvidence();
});
</script>

<template>
  <section class="work-view surface acceptance-workbench" aria-labelledby="aw-title" data-testid="acceptance-workbench">
    <header class="aw-header">
      <div><h1 id="aw-title">项目验收</h1><p>对照基线，复现差异，把还原度和 BUG 落到可检查的证据。</p></div>
      <div class="aw-header-actions"><button v-if="selectedId" type="button" class="aw-button aw-mobile-results" aria-controls="aw-result-panel" data-testid="acceptance-view-results" @click="showResults">查看结果<Icon name="chevron" decorative /></button><button type="button" class="aw-button aw-close" @click="$emit('close')"><Icon name="close" decorative /> 返回星图</button></div>
    </header>
    <div class="aw-layout">
      <aside class="aw-sidebar">
        <form class="aw-form" @submit.prevent="createRun" aria-label="新建项目验收">
          <h2>新建验收</h2>
          <label>任务名称 <span class="aw-optional">选填</span><input v-model="form.name" name="acceptance-name" placeholder="例如：首页与商品列表验收" maxlength="120" /></label>
          <fieldset class="aw-modes"><legend>验收方式</legend>
            <label :class="{ selected: form.mode === 'mirror' }"><input v-model="form.mode" type="radio" name="acceptance-mode" value="mirror" /><span>还原验收<small>原站与开发项目对照</small></span></label>
            <label :class="{ selected: form.mode === 'regression' }"><input v-model="form.mode" type="radio" name="acceptance-mode" value="regression" /><span>回归验收<small>稳定版本与新版本对照</small></span></label>
          </fieldset>
          <label>基线 URL<input v-model="form.baselineUrl" name="acceptance-baseline" type="url" placeholder="https://reference.example.com" required spellcheck="false" /></label>
          <label>目标 URL<input v-model="form.targetUrl" name="acceptance-target" type="url" placeholder="http://127.0.0.1:3000" required spellcheck="false" /></label>
          <label>路由 <span class="aw-optional">一行一个</span><textarea v-model="form.routes" name="acceptance-routes" rows="3" required spellcheck="false" aria-describedby="aw-route-note"></textarea></label>
          <p id="aw-route-note" class="aw-hint">{{ routeCount }} 条路由 · 默认桌面、平板、手机三个视口。路径相对入口 URL，/ 保留入口页。</p>
          <details class="aw-advanced"><summary>验收点与忽略区域</summary>
            <label>验收点 JSON<textarea v-model="form.points" name="acceptance-points" rows="5" placeholder='[]' spellcheck="false" aria-describedby="aw-points-note"></textarea></label>
            <p id="aw-points-note" class="aw-hint">填入验收点对象数组，支持可见、隐藏、文本、属性与 URL 断言。空白时执行页面默认检查。</p>
            <button type="button" class="aw-text-button aw-example" :disabled="!!form.points.trim()" @click="insertPointExample">填入菜单展开示例</button>
            <label>忽略区域 JSON<textarea v-model="form.maskSelectors" name="acceptance-masks" rows="2" placeholder='[".timestamp", "[data-dynamic]"]' spellcheck="false"></textarea></label>
            <p class="aw-hint">CSS 选择器数组，用于截图中的动态时间、广告等区域。</p>
          </details>
          <p v-if="formError" class="aw-error" role="alert">{{ formError }}</p>
          <button type="submit" class="aw-button aw-primary" :disabled="creating" data-testid="acceptance-run"><Icon name="bolt" decorative />{{ creating ? '正在创建…' : '运行验收' }}</button>
        </form>
        <section class="aw-history" aria-labelledby="aw-history-title">
          <div class="aw-section-title"><h2 id="aw-history-title">验收历史 <span>{{ runs.length }}</span></h2><button class="aw-icon-button" type="button" @click="loadRuns" aria-label="刷新验收历史"><Icon name="refresh" decorative /></button></div>
          <p v-if="runningCount" class="aw-hint">{{ runningCount }} 个任务正在运行，可切换查看。</p>
          <p v-if="listError" class="aw-error" role="alert">历史读取失败：{{ listError }}</p>
          <p v-if="!runsLoaded" class="aw-hint" role="status">正在读取历史…</p>
          <p v-else-if="!runs.length && !listError" class="aw-hint">运行首个验收后，任务与报告会保存在这里。</p>
          <ol v-if="runs.length" class="aw-run-list">
            <li v-for="run in runs" :key="run.runId"><button type="button" :class="{ selected: run.runId === selectedId }" :aria-current="run.runId === selectedId ? 'true' : undefined" @click="selectRun(run.runId)" :data-run-id="run.runId">
              <span class="aw-history-name">{{ run.name || run.runId }}</span><span class="aw-history-meta"><time>{{ dateLabel(run.createdAt) }}</time><span :class="['aw-state', run.status]">{{ STATUS_LABELS[run.status] ?? run.status }}</span></span>
              <span v-if="run.status === 'completed'" :class="['aw-history-gate', run.gate]">{{ GATE_LABELS[run.gate] ?? '结论未记录' }}<span v-if="run.summary"> · {{ count(run.summary.bugs) }} 个缺陷</span></span>
            </button></li>
          </ol>
        </section>
      </aside>
      <main id="aw-result-panel" ref="resultsElement" class="aw-results" aria-live="polite" aria-busy="loadingRun || currentRunning">
        <div v-if="!selectedId" class="aw-empty">
          <h2>从一次可复现的对照开始</h2><p>填入作为预期的基线与待验收项目地址。验收会按路由采集视觉、结构、交互和运行健康结果，并保留截图与复现步骤。</p>
          <dl><div><dt>目标缺陷</dt><dd>基线可运行，目标偏离预期</dd></div><div><dt>基线失败</dt><dd>预期本身未成立，需要核对基线</dd></div><div><dt>待复核</dt><dd>证据不足以自动判定，需要人工检查</dd></div></dl>
        </div>
        <template v-else>
          <p v-if="loadingRun" class="aw-loading" role="status">正在读取验收任务…</p>
          <div v-if="runError" class="aw-error aw-load-error" role="alert"><p>任务读取失败：{{ runError }}</p><button type="button" class="aw-button" @click="loadSelected()">重新读取</button></div>
          <template v-if="manifest">
            <div class="aw-report-head"><div><h2>{{ manifest.name || selectedId }}</h2><p>{{ manifest.mode === 'regression' ? '回归验收' : '还原验收' }} · {{ dateLabel(manifest.createdAt || report?.startedAt) }}<span v-if="report?.endedAt"> · 完成于 {{ dateLabel(report.endedAt) }}</span></p></div>
              <div v-if="report" class="aw-downloads"><button class="aw-button" type="button" @click="downloadReport('md')" :disabled="!!downloading">{{ downloading === 'md' ? '正在下载…' : '下载 Markdown' }}</button><button class="aw-button" type="button" @click="downloadReport('json')" :disabled="!!downloading">JSON</button></div>
            </div>
            <p v-if="downloadError" class="aw-error" role="alert">报告下载失败：{{ downloadError }}</p>
            <div v-if="currentRunning" class="aw-running" role="status"><span class="aw-running-dot"></span><div><strong>验收正在运行</strong><p>{{ progressLabel }}</p></div></div>
            <div v-else-if="['failed', 'interrupted'].includes(manifest.status)" class="aw-failed" role="alert"><strong>{{ manifest.status === 'interrupted' ? '验收已中断' : '验收运行失败' }}</strong><p>{{ pretty(manifest.error || '引擎没有记录失败原因；请检查引擎日志后重新运行。') }}</p></div>
            <template v-if="report">
              <div :class="['aw-verdict', report.gate]" data-testid="acceptance-gate"><strong>{{ GATE_LABELS[report.gate] ?? '结论未记录' }}</strong><span>{{ coverageLabel }}</span></div>
              <dl class="aw-scope"><div><dt>基线</dt><dd><code>{{ report.baselineUrl }}</code></dd></div><div><dt>目标</dt><dd><code>{{ report.targetUrl }}</code></dd></div></dl>
              <p class="aw-hint aw-scope-note">{{ report.scope || '仅验收已声明路由、视口和操作；未声明的业务流程与接口契约尚未测量。' }}</p>
              <div class="aw-summary" aria-label="验收结果统计">
                <button type="button" :class="{ active: filters.verdict === 'bug' }" @click="filters.verdict = filters.verdict === 'bug' ? 'attention' : 'bug'"><span>目标缺陷</span><strong class="aw-bad">{{ count(summary?.bugs) }}</strong></button>
                <button type="button" :class="{ active: filters.verdict === 'baseline_failed' }" @click="filters.verdict = filters.verdict === 'baseline_failed' ? 'attention' : 'baseline_failed'"><span>基线失败</span><strong class="aw-warn">{{ count(summary?.baselineFailed) }}</strong></button>
                <button type="button" :class="{ active: filters.verdict === 'needs_review' }" @click="filters.verdict = filters.verdict === 'needs_review' ? 'attention' : 'needs_review'"><span>待复核</span><strong class="aw-warn">{{ count(summary?.needsReview) }}</strong></button>
                <button type="button" :class="{ active: filters.verdict === 'environment' }" @click="filters.verdict = filters.verdict === 'environment' ? 'attention' : 'environment'"><span>受阻检查</span><strong>{{ count(summary?.blocked) }}</strong></button>
              </div>
              <div class="aw-dimensions" aria-label="按验收维度筛选">
                <button v-for="dimension in DIMENSIONS" :key="dimension.id" type="button" :class="{ active: filters.dimension === dimension.id }" :aria-pressed="filters.dimension === dimension.id" @click="filters.dimension = filters.dimension === dimension.id ? 'all' : dimension.id"><span>{{ dimension.label }}</span><b>{{ dimensionReading(dimension.id) }}</b><small v-if="summary?.dimensions?.[dimension.id]?.total > 0">{{ count(summary?.dimensions?.[dimension.id]?.passed) }} / {{ count(summary?.dimensions?.[dimension.id]?.total) }} 通过</small><small v-else>{{ dimension.id === 'behavior' ? '未声明交互验收点' : '未声明检查' }}</small></button>
              </div>
              <section v-if="triageEligible" class="aw-triage" aria-labelledby="aw-triage-title" :aria-busy="triageLoading">
                <div class="aw-triage-head"><h3 id="aw-triage-title">AI 证据解读</h3><button type="button" class="aw-button" :disabled="triageLoading" data-testid="acceptance-triage" @click="loadTriage('POST')"><Icon name="bolt" decorative />{{ triageLoading ? '正在解读…' : triage?.status === 'completed' ? '重新解读缺陷' : 'AI 解读缺陷' }}</button></div>
                <p class="aw-hint">仅向已配置模型发送脱敏检查摘要，AI 建议不改变验收门禁。</p>
                <p v-if="triageLoading" class="aw-hint" role="status">模型正在整理可能原因、修复建议与复验步骤…</p>
                <div v-if="triageError || triage?.status === 'disabled'" class="aw-triage-error" role="alert"><p :class="triageError ? 'aw-error' : 'aw-hint'">{{ triageError || triage.error || triage.summary || '模型服务尚未启用。' }}</p><p class="aw-hint">请打开底部“设置”，启用模型服务并完成“测试连接”，再重新解读。</p></div>
                <template v-if="triage?.status === 'completed'">
                  <p class="aw-triage-summary">{{ triage.summary }}</p>
                  <p class="aw-triage-meta">{{ triage.model ? `模型 ${triage.model} · ` : '' }}{{ dateLabel(triage.generatedAt) }}</p>
                  <ol v-if="triage.items.length" class="aw-triage-items"><li v-for="(item, index) in triage.items" :key="`${item.checkId}:${index}`"><h4>{{ triageCheckTitle(item.checkId) }}</h4><p>{{ item.explanation }}</p><dl><div><dt>修复建议</dt><dd>{{ item.suggestedFix }}</dd></div><div v-if="item.verification?.length"><dt>复验步骤</dt><dd><ol><li v-for="(step, stepIndex) in item.verification" :key="stepIndex">{{ step }}</li></ol></dd></div></dl></li></ol>
                  <p class="aw-hint">{{ triage.disclaimer || 'AI 解读仅供辅助排查；验收结论以浏览器采集证据与检查结果为准。' }}</p>
                </template>
              </section>
              <section class="aw-checks" aria-labelledby="aw-checks-title">
                <div class="aw-checks-heading"><h3 id="aw-checks-title">验收明细 <span>{{ filteredChecks.length }} / {{ report.checks.length }}</span></h3><button v-if="filters.dimension !== 'all' || filters.verdict !== 'attention' || filters.query" type="button" class="aw-text-button" @click="filters.dimension = 'all'; filters.verdict = 'attention'; filters.query = ''">重置筛选</button></div>
                <div class="aw-filters"><label class="aw-sr-only" for="aw-verdict-filter">问题类型</label><select id="aw-verdict-filter" v-model="filters.verdict"><option value="attention">需要关注</option><option value="all">全部检查</option><option value="bug">目标缺陷</option><option value="baseline_failed">基线失败</option><option value="needs_review">待复核</option><option value="environment">环境受阻</option><option value="match">一致</option></select><label class="aw-sr-only" for="aw-query">搜索验收明细</label><input id="aw-query" v-model="filters.query" type="search" placeholder="搜索路由、问题或预期…" /><span v-if="filters.dimension !== 'all'" class="aw-filter-note">{{ dimensionLabel(filters.dimension) }}</span></div>
                <div v-if="!filteredChecks.length" class="aw-no-checks"><p>{{ filters.verdict === 'attention' && !filters.query && filters.dimension === 'all' ? '当前报告没有需要关注的检查项。' : '没有符合筛选条件的检查项。' }}</p><button type="button" class="aw-text-button" @click="filters.verdict = 'all'; filters.dimension = 'all'; filters.query = ''">查看全部 {{ report.checks.length }} 项检查</button></div>
                <details v-for="check in filteredChecks" :key="selectedId + ':' + check.id" class="aw-check" :data-check-id="check.id" @toggle="onCheckToggle(check, $event)">
                  <summary><span :class="['aw-check-state', check.verdict, check.status]">{{ VERDICT_LABELS[check.verdict] ?? STATUS_LABELS[check.status] ?? check.status }}</span><span class="aw-check-title">{{ check.title }}<small><code>{{ check.route }}</code> · {{ acceptanceViewport(check.viewport) }} · {{ dimensionLabel(check.dimension) }}</small></span><span class="aw-severity">{{ check.severity || '—' }}</span><Icon name="chevron" decorative /></summary>
                  <div class="aw-check-body"><div class="aw-check-meta"><span>判断依据 <code>{{ oracleLabel(check.oracle) }}</code></span><span>证据等级 <code>{{ evidenceLabel(check.evidenceLevel) }}</code></span><span v-if="Number.isFinite(check.score)">得分 {{ acceptanceScore(check.score) }}</span></div>
                    <dl class="aw-comparison"><div><dt>预期</dt><dd><pre>{{ pretty(check.expected) }}</pre></dd></div><div><dt>实际</dt><dd><pre>{{ pretty(check.actual) }}</pre></dd></div></dl>
                    <div class="aw-reproduction"><h4>复现步骤</h4><ol v-if="check.reproduction?.length"><li v-for="(step, index) in check.reproduction" :key="index">{{ step }}</li></ol><p v-else class="aw-hint">该检查未记录复现步骤。</p></div>
                    <p v-if="evidence[check.id]?.loading" class="aw-hint" role="status">正在读取证据…</p>
                    <p v-for="(error, index) in evidence[check.id]?.errors ?? []" :key="index" class="aw-error">证据读取失败：{{ error }}</p>
                    <button v-if="evidence[check.id]?.errors.length" type="button" class="aw-text-button" @click="retryEvidence(check)">重新读取证据</button>
                    <div v-if="evidence[check.id]?.files.length" class="aw-evidence"><figure v-for="file in evidence[check.id].files" :key="file.filename" :class="{ 'aw-json-evidence': !file.isImage }"><figcaption>{{ file.label }} <a :href="file.url" :download="file.filename">下载</a></figcaption><a v-if="file.isImage" :href="file.url" target="_blank" rel="noopener"><img :src="file.url" :alt="`${check.route} ${file.label}`" loading="lazy" /></a><pre v-else>{{ file.content }}</pre></figure></div>
                    <p v-else-if="!evidence[check.id]?.loading && !acceptanceEvidenceEntries(check).length" class="aw-hint">该检查没有关联可展示的截图或详情文件。</p>
                  </div>
                </details>
              </section>
            </template>
            <div v-else-if="!currentRunning && manifest.status === 'completed' && !runError" class="aw-loading" role="status">正在读取验收报告…</div>
          </template>
        </template>
      </main>
    </div>
  </section>
</template>

<style scoped>
.acceptance-workbench { top: 24px; font-size: 13px; box-shadow: none; }
.aw-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 21px 25px 18px; border-bottom: 1px solid var(--border); }
.aw-header h1 { font-size: 22px; font-weight: 650; letter-spacing: -.02em; }
.aw-header p { color: var(--text-dim); margin-top: 4px; font-size: 12px; }
.aw-header-actions { display: flex; gap: 7px; flex: none; }
.aw-button.aw-mobile-results { display: none; }
.aw-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: 320px minmax(0, 1fr); }
.aw-sidebar { overflow-y: auto; border-right: 1px solid var(--border); background: var(--surface-2); }
.aw-form { padding: 22px 22px 23px; }
.aw-form h2, .aw-history h2 { font-size: 14px; font-weight: 650; margin-bottom: 17px; }
.aw-form > label, .aw-advanced label { display: block; font-size: 12px; font-weight: 550; margin-top: 14px; }
.aw-optional { color: var(--text-faint); font-size: 11px; font-weight: 400; margin-left: 5px; }
.aw-form input:not([type='radio']), .aw-form textarea, .aw-filters input, .aw-filters select { display: block; width: 100%; min-width: 0; padding: 9px 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg); color: var(--text); font-size: 12px; margin-top: 6px; caret-color: var(--accent); }
.aw-form input[type='url'], .aw-form textarea { font-family: var(--font-mono); font-size: 11.5px; }
.aw-form textarea { resize: vertical; min-height: 64px; max-height: 350px; line-height: 1.65; }
.aw-form input:focus, .aw-form textarea:focus { border-color: var(--accent); }
.aw-hint { color: var(--text-faint); line-height: 1.7; font-size: 11px; margin-top: 7px; }
.aw-modes { border: 0; padding: 0; margin: 17px 0 3px; display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
.aw-modes legend { font-size: 12px; margin-bottom: 7px; font-weight: 550; }
.aw-modes label { padding: 9px 8px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); display: flex; align-items: start; gap: 6px; cursor: pointer; }
.aw-modes label.selected { border-color: var(--accent); background: var(--bg); }
.aw-modes input { accent-color: var(--accent); margin-top: 3px; }
.aw-modes span { font-size: 12px; }
.aw-modes small { display: block; margin-top: 3px; font-size: 10px; color: var(--text-faint); }
.aw-advanced { border-top: 1px solid var(--border); margin-top: 17px; padding-top: 13px; }
.aw-advanced > summary { color: var(--text-dim); cursor: pointer; font-size: 12px; }
.aw-button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; padding: 8px 11px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--text-dim); cursor: pointer; font-size: 12px; white-space: nowrap; transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease); }
.aw-button:hover:not(:disabled) { color: var(--text); border-color: var(--text-faint); background: var(--surface-2); }
.aw-button:disabled { cursor: wait; }
.aw-primary { width: 100%; padding: 11px; margin-top: 20px; background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 650; font-size: 13px; }
.aw-primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 88%, var(--text)); border-color: var(--accent); color: var(--bg); }
.aw-error { color: var(--bad); font-size: 12px; line-height: 1.7; margin-top: 12px; overflow-wrap: anywhere; }
.aw-history { border-top: 1px solid var(--border); padding: 18px 13px 22px; }
.aw-section-title { display: flex; align-items: center; justify-content: space-between; padding: 0 9px; }
.aw-section-title h2 { margin: 0; }
.aw-section-title h2 span { color: var(--text-faint); font-size: 11px; font-weight: 400; margin-left: 4px; }
.aw-icon-button { padding: 6px; background: none; border: 0; cursor: pointer; color: var(--text-dim); font-size: 15px; border-radius: var(--r-sm); }
.aw-icon-button:hover { background: var(--bg-2); color: var(--text); }
.aw-history > .aw-hint, .aw-history > .aw-error { padding: 0 9px; }
.aw-run-list { list-style: none; margin-top: 10px; }
.aw-run-list button { width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: var(--r-sm); padding: 10px 9px; color: var(--text); cursor: pointer; }
.aw-run-list button:hover { background: var(--bg-2); }
.aw-run-list button.selected { border-color: var(--border-strong); background: var(--bg); }
.aw-history-name { font-size: 12px; display: block; overflow-wrap: anywhere; }
.aw-history-meta { display: flex; gap: 8px; justify-content: space-between; font-size: 10px; margin-top: 6px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.aw-state.running { color: var(--warn); }
.aw-state.failed, .aw-state.interrupted { color: var(--bad); }
.aw-state.completed { color: var(--text-dim); }
.aw-history-gate { display: block; font-size: 10px; margin-top: 4px; color: var(--warn); }
.aw-history-gate.passed { color: var(--ok); }
.aw-history-gate.failed { color: var(--bad); }
.aw-results { padding: 24px 28px 36px; overflow-y: auto; min-width: 0; }
.aw-empty { max-width: 570px; padding: 54px 15px 30px; margin: 0 auto; }
.aw-empty h2 { font-size: 23px; font-weight: 600; letter-spacing: -.02em; }
.aw-empty > p { font-size: 13px; color: var(--text-dim); line-height: 1.9; margin-top: 15px; max-width: 65ch; }
.aw-empty dl { margin-top: 30px; border-top: 1px solid var(--border); }
.aw-empty dl > div { display: grid; grid-template-columns: 80px 1fr; gap: 18px; padding: 13px 0; border-bottom: 1px solid var(--border); }
.aw-empty dt { font-size: 12px; color: var(--text); }
.aw-empty dd { font-size: 12px; color: var(--text-dim); }
.aw-loading { color: var(--text-dim); padding: 16px 0; }
.aw-load-error { margin-bottom: 18px; }
.aw-load-error .aw-button { margin-top: 8px; }
.aw-report-head { display: flex; justify-content: space-between; gap: 20px; align-items: start; }
.aw-report-head h2 { font-size: 20px; font-weight: 600; overflow-wrap: anywhere; }
.aw-report-head p { color: var(--text-faint); font-size: 11px; margin-top: 6px; }
.aw-downloads { display: flex; gap: 7px; flex-wrap: wrap; justify-content: end; }
.aw-running, .aw-failed { padding: 17px 18px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--r); margin-top: 24px; }
.aw-running { display: flex; gap: 11px; align-items: baseline; }
.aw-running strong { color: var(--warn); font-weight: 550; }
.aw-running p, .aw-failed p { color: var(--text-dim); font-size: 12px; margin-top: 6px; overflow-wrap: anywhere; }
.aw-running-dot { width: 7px; height: 7px; flex: none; background: var(--warn); border-radius: 50%; animation: aw-pulse 1.7s ease-in-out infinite; }
@keyframes aw-pulse { 50% { opacity: .35; } }
.aw-failed strong { color: var(--bad); }
.aw-verdict { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; padding: 17px 0 14px; margin-top: 14px; border-bottom: 1px solid var(--border); }
.aw-verdict strong { font-size: 18px; font-weight: 600; color: var(--warn); }
.aw-verdict.failed strong { color: var(--bad); }
.aw-verdict.passed strong { color: var(--ok); }
.aw-verdict span { color: var(--text-dim); font-size: 11px; font-variant-numeric: tabular-nums; }
.aw-scope { margin-top: 11px; font-size: 11px; }
.aw-scope > div { display: grid; grid-template-columns: 35px minmax(0, 1fr); gap: 7px; margin-top: 5px; }
.aw-scope dt { color: var(--text-faint); }
.aw-scope dd { color: var(--text-dim); overflow-wrap: anywhere; }
.aw-scope code, .aw-check code { font-family: var(--font-mono); font-size: 10.5px; }
.aw-scope-note { max-width: 75ch; }
.aw-summary { display: flex; gap: 0; margin: 24px 0 20px; border-block: 1px solid var(--border); }
.aw-summary button { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex: 1; padding: 11px 13px; background: transparent; border: 0; border-right: 1px solid var(--border); color: var(--text-dim); cursor: pointer; font-size: 12px; }
.aw-summary button:first-child { padding-left: 0; }
.aw-summary button:last-child { border: 0; padding-right: 0; }
.aw-summary button.active { color: var(--text); background: var(--surface-2); }
.aw-summary strong { font-size: 19px; color: var(--text); font-weight: 550; font-variant-numeric: tabular-nums; }
.aw-summary strong.aw-bad { color: var(--bad); }
.aw-summary strong.aw-warn { color: var(--warn); }
.aw-dimensions { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-bottom: 1px solid var(--border); padding-bottom: 20px; gap: 8px; }
.aw-dimensions button { display: grid; grid-template-columns: 1fr auto; gap: 7px; padding: 10px 10px 9px; background: transparent; border: 1px solid transparent; border-radius: var(--r-sm); text-align: left; cursor: pointer; color: var(--text); }
.aw-dimensions button:hover, .aw-dimensions button.active { border-color: var(--border-strong); background: var(--surface-2); }
.aw-dimensions button span { font-size: 11px; }
.aw-dimensions button b { font-size: 12px; font-weight: 550; font-variant-numeric: tabular-nums; }
.aw-dimensions button small { color: var(--text-faint); font-size: 10px; grid-column: 1 / -1; }
.aw-triage { margin-top: 20px; padding: 16px 17px; border: 1px solid var(--border); border-radius: var(--r); background: var(--surface-2); }
.aw-triage-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.aw-triage h3 { font-size: 13px; font-weight: 600; }
.aw-triage-error .aw-error { margin-top: 9px; }
.aw-triage-summary { font-size: 12px; color: var(--text); line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; margin-top: 16px; }
.aw-triage-meta { font-size: 10px; color: var(--text-faint); margin-top: 6px; }
.aw-triage-items { list-style: none; padding: 0; margin: 15px 0 0; }
.aw-triage-items > li { border-top: 1px solid var(--border); padding: 13px 0; }
.aw-triage-items h4 { font-size: 12px; font-weight: 550; overflow-wrap: anywhere; }
.aw-triage-items p, .aw-triage-items dd { font-size: 11px; color: var(--text-dim); line-height: 1.85; white-space: pre-wrap; overflow-wrap: anywhere; }
.aw-triage-items p { margin-top: 7px; }
.aw-triage-items dl { margin-top: 10px; }
.aw-triage-items dl > div { display: grid; grid-template-columns: 60px minmax(0, 1fr); gap: 10px; margin-top: 7px; }
.aw-triage-items dt { color: var(--text-faint); font-size: 11px; }
.aw-triage-items dd ol { padding-left: 18px; }
.aw-checks { margin-top: 22px; }
.aw-checks-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.aw-checks h3 { font-size: 14px; font-weight: 600; }
.aw-checks h3 span { margin-left: 7px; color: var(--text-faint); font-size: 11px; font-weight: 400; }
.aw-text-button { color: var(--accent); border: 0; background: transparent; font-size: 11px; cursor: pointer; text-underline-offset: 3px; }
.aw-text-button:hover { text-decoration: underline; }
.aw-example { margin-top: 5px; }
.aw-text-button:disabled { cursor: not-allowed; color: var(--text-faint); text-decoration: none; }
.aw-filters { display: flex; gap: 9px; margin: 12px 0 13px; align-items: center; }
.aw-filters select { width: 130px; flex: none; margin: 0; }
.aw-filters input { max-width: 340px; margin: 0; }
.aw-filter-note { font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.aw-no-checks { padding: 35px 10px; text-align: center; border-block: 1px solid var(--border); color: var(--text-faint); font-size: 12px; }
.aw-no-checks button { margin-top: 10px; }
.aw-check { border-bottom: 1px solid var(--border); }
.aw-check > summary { display: flex; gap: 13px; align-items: center; padding: 15px 2px; cursor: pointer; list-style: none; }
.aw-check > summary::-webkit-details-marker { display: none; }
.aw-check > summary > .icon { font-size: 16px; color: var(--text-faint); transition: transform var(--dur) var(--ease); }
.aw-check[open] > summary > .icon { transform: rotate(90deg); }
.aw-check-state { width: 64px; flex: none; font-size: 11px; color: var(--warn); }
.aw-check-state.bug { color: var(--bad); }
.aw-check-state.match { color: var(--ok); }
.aw-check-title { flex: 1; min-width: 0; font-size: 12px; overflow-wrap: anywhere; }
.aw-check-title small { display: block; margin-top: 5px; font-size: 10px; color: var(--text-faint); }
.aw-severity { color: var(--text-faint); font-size: 10px; font-family: var(--font-mono); }
.aw-check-body { padding: 1px 0 23px 79px; }
.aw-check-meta { display: flex; gap: 14px; color: var(--text-faint); font-size: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.aw-check-meta code { color: var(--text-dim); margin-left: 4px; overflow-wrap: anywhere; }
.aw-comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.aw-comparison dt, .aw-reproduction h4 { color: var(--text-dim); font-size: 11px; font-weight: 550; margin-bottom: 6px; }
.aw-comparison dd { background: var(--bg); border-radius: var(--r-sm); padding: 10px 12px; }
.aw-check pre { color: var(--text); font-family: var(--font-mono); font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 300px; overflow-y: auto; }
.aw-reproduction { margin-top: 18px; }
.aw-reproduction ol { margin: 0; padding-left: 19px; color: var(--text-dim); font-size: 11px; line-height: 1.9; overflow-wrap: anywhere; }
.aw-evidence { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 11px; margin-top: 18px; }
.aw-evidence figure { min-width: 0; margin: 0; }
.aw-evidence figcaption { display: flex; justify-content: space-between; color: var(--text-dim); font-size: 10px; gap: 8px; margin-bottom: 6px; }
.aw-evidence a { color: var(--accent); text-underline-offset: 3px; }
.aw-evidence img { width: 100%; max-height: 300px; object-fit: contain; object-position: top; display: block; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg); }
.aw-evidence .aw-json-evidence { grid-column: 1 / -1; }
.aw-json-evidence pre { background: var(--bg); padding: 10px 12px; border-radius: var(--r-sm); }
.aw-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 1220px) {
  .aw-layout { grid-template-columns: 290px minmax(0, 1fr); }
  .aw-form { padding-inline: 17px; }
  .aw-results { padding: 21px 22px 30px; }
  .aw-report-head { flex-direction: column; gap: 12px; }
  .aw-dimensions { grid-template-columns: 1fr 1fr; }
  .aw-summary button { flex-direction: column; gap: 3px; align-items: start; padding-inline: 10px; }
  .aw-check-body { padding-left: 0; }
}
@media (max-width: 760px) {
  .acceptance-workbench { inset: 12px 10px 84px; }
  .aw-header { padding: 15px; align-items: start; gap: 12px; }
  .aw-header h1 { font-size: 19px; }
  .aw-header p { font-size: 11px; line-height: 1.7; }
  .aw-close { padding: 7px; font-size: 10px; }
  .aw-header-actions { flex-direction: column; }
  .aw-button.aw-mobile-results { display: inline-flex; padding: 7px; font-size: 10px; }
  .aw-layout { display: block; overflow-y: auto; }
  .aw-sidebar { overflow: visible; border-right: 0; border-bottom: 1px solid var(--border); }
  .aw-form { padding: 18px; }
  .aw-history { padding: 14px 9px 16px; }
  .aw-run-list { display: flex; gap: 5px; overflow-x: auto; padding-bottom: 3px; }
  .aw-run-list li { min-width: 200px; max-width: 230px; flex: none; }
  .aw-history-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aw-results { overflow: visible; padding: 23px 16px 30px; }
  .aw-empty { padding: 10px 0 8px; }
  .aw-empty h2 { font-size: 20px; }
  .aw-verdict { flex-direction: column; gap: 5px; }
  .aw-report-head h2 { font-size: 19px; }
  .aw-filters { flex-wrap: wrap; }
  .aw-filters select { width: 116px; }
  .aw-filters input { flex: 1; width: auto; min-width: 100px; }
  .aw-check > summary { gap: 8px; }
  .aw-check-state { width: 54px; font-size: 10px; }
  .aw-check-title { font-size: 12px; }
  .aw-check-title small { line-height: 1.8; }
  .aw-comparison { grid-template-columns: 1fr; gap: 12px; }
  .aw-evidence { grid-template-columns: 1fr; }
  .aw-evidence img { max-height: 400px; }
}
</style>
