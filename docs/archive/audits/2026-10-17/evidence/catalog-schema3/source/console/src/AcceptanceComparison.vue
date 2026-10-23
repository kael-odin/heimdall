<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { COMPARISON_RELATIONS, GATE_LABELS, STATUS_LABELS, acceptanceComparisonQuery,
  filterAcceptanceComparison, acceptanceViewport } from './acceptance-workbench.js';
import { comparisonMarkdown } from '../../core/src/acceptance/comparison.mjs';

const props = defineProps({ runs: { type: Array, required: true }, request: { type: Function, required: true } });
const emit = defineEmits(['open-run']);
function restorePair() {
  try {
    const pair = JSON.parse(localStorage.getItem('heimdall-acceptance-comparison') || '{}');
    acceptanceComparisonQuery(pair.before, pair.after);
    return pair;
  } catch { return { before: '', after: '' }; }
}
const saved = restorePair();
const before = ref(saved.before);
const after = ref(saved.after);
const expanded = ref(false);
const loading = ref(false);
const exporting = ref('');
const error = ref('');
const result = ref(null);
const filters = reactive({ relation: 'all', query: '' });
const rows = computed(() => filterAcceptanceComparison(result.value?.checks ?? [], filters));
const relationOf = id => COMPARISON_RELATIONS.find(item => item.id === id);
const pairProblem = computed(() => {
  if (!before.value || !after.value) return '';
  try { acceptanceComparisonQuery(before.value, after.value); } catch (problem) { return problem.message; }
  const old = props.runs.find(run => run.runId === before.value), next = props.runs.find(run => run.runId === after.value);
  if (!old || !next) return '所选运行不在当前历史中，请刷新历史并重新选择。';
  if (old.status === 'running' || next.status === 'running') return '请等待所选运行结束后再复验。';
  if (new Date(old.createdAt).getTime() > new Date(next.createdAt).getTime()) return '此前运行的创建时间晚于本次运行，请交换选择。';
  return '';
});
const ready = computed(() => !!before.value && !!after.value && !pairProblem.value);
const label = run => `${run.name || run.runId} · ${run.createdAt ? new Date(run.createdAt).toLocaleString('zh-CN', { hour12: false }) : '时间未知'} · ${STATUS_LABELS[run.status] || run.status} · ${run.runId.slice(-8)}`;
let controller;
let epoch = 0;
let stopped = false;
const urls = new Set();
const timers = new Set();
function reset() {
  controller?.abort();
  epoch++;
  loading.value = false;
  exporting.value = '';
  result.value = null;
  error.value = '';
  filters.relation = 'all';
  filters.query = '';
}
watch([before, after], () => {
  reset();
  try { localStorage.setItem('heimdall-acceptance-comparison', JSON.stringify({ before: before.value, after: after.value })); } catch { /* Selection works without storage. */ }
}, { flush: 'sync' });
function validate(value, a, b) {
  if (value?.kind !== 'acceptance-comparison' || value.scope !== 'explicit-pair'
    || value.before?.runId !== a || value.after?.runId !== b || !Array.isArray(value.checks)
    || !['completed', 'blocked'].includes(value.status) || !value.summary || !Array.isArray(value.limitations)
    || value.checks.some(row => !relationOf(row.relation) || !Array.isArray(row.reasons))) {
    throw new Error('对比结果格式无效，请更新引擎后重新核验。');
  }
  return value;
}
async function compare() {
  if (!ready.value || loading.value || exporting.value || stopped) return;
  reset();
  const a = before.value, b = after.value, generation = epoch;
  const current = new AbortController();
  controller = current;
  loading.value = true;
  try {
    const value = await props.request(acceptanceComparisonQuery(a, b), { basePath: '/api/acceptance/comparisons', signal: current.signal });
    if (stopped || current.signal.aborted || generation !== epoch) return;
    result.value = validate(value, a, b);
  } catch (problem) {
    if (!stopped && !current.signal.aborted && generation === epoch) error.value = problem.message;
  } finally { if (!stopped && generation === epoch) loading.value = false; }
}
async function download(format) {
  if (!result.value || loading.value || exporting.value || stopped || !ready.value) return;
  const a = before.value, b = after.value, generation = epoch;
  const current = new AbortController();
  controller?.abort();
  controller = current;
  exporting.value = format;
  error.value = '';
  try {
    // Every export uses the same authenticated API and revalidates disk evidence.
    const value = await props.request(acceptanceComparisonQuery(a, b), {
      basePath: '/api/acceptance/comparisons', signal: current.signal,
    });
    if (stopped || current.signal.aborted || generation !== epoch) return;
    result.value = validate(value, a, b);
    const blob = new Blob([format === 'md' ? comparisonMarkdown(result.value) : JSON.stringify(result.value, null, 2) + '\n'],
      { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    urls.add(url);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${a.slice(-8)}-${b.slice(-8)}-comparison.${format}`;
    anchor.click();
    const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.delete(url); timers.delete(timer); }, 1000);
    timers.add(timer);
  } catch (problem) {
    if (!stopped && !current.signal.aborted && generation === epoch) error.value = problem.message;
  } finally { if (!stopped && generation === epoch) exporting.value = ''; }
}
function openRun(id) { expanded.value = false; emit('open-run', id); }
onBeforeUnmount(() => {
  stopped = true;
  reset();
  for (const timer of timers) clearTimeout(timer);
  for (const url of urls) URL.revokeObjectURL(url);
});
</script>

<template>
  <details class="ac-panel" :open="expanded" data-testid="acceptance-comparison" @toggle="expanded = $event.target.open">
    <summary><span><strong>跨运行复验</strong><small>选择两次运行，核对缺陷是否可靠复验通过</small></span><span aria-hidden="true">{{ expanded ? '−' : '+' }}</span></summary>
    <section class="ac-body" aria-label="验收运行对比" :aria-busy="loading || !!exporting">
      <p class="ac-intro">明确选择此前与本次运行。检查定义、依据、视口与执行环境相同，且报告和证据完整，才可形成可靠复验结论。</p>
      <div class="ac-pair">
        <label for="ac-before">此前运行<select id="ac-before" v-model="before" :aria-invalid="!!pairProblem" aria-describedby="ac-pair-hint"><option value="">请选择此前运行</option><option v-for="run in runs" :key="run.runId" :value="run.runId">{{ label(run) }}</option></select></label>
        <label for="ac-after">本次运行<select id="ac-after" v-model="after" :aria-invalid="!!pairProblem" aria-describedby="ac-pair-hint"><option value="">请选择本次运行</option><option v-for="run in runs" :key="run.runId" :value="run.runId">{{ label(run) }}</option></select></label>
      </div>
      <p id="ac-pair-hint" :class="pairProblem ? 'ac-error' : 'ac-hint'">{{ pairProblem || (runs.length < 2 ? '至少需要两次验收记录。完成新的验收后，在这里明确选择运行对。' : '历史顺序不代表已批准基线。旧记录缺少稳定身份或报告指纹时，需要重新运行。') }}</p>
      <div class="ac-actions"><button type="button" class="ac-primary" :disabled="!ready || loading || !!exporting" data-testid="acceptance-compare" @click="compare">{{ loading ? '正在核验证据…' : result ? '重新核验对比' : '生成复验对比' }}</button><span v-if="loading" role="status">正在读取报告并核对证据字节…</span></div>
      <div v-if="error" class="ac-error" role="alert"><p>{{ error }}</p><button type="button" :disabled="!ready || loading || !!exporting" @click="compare">重试对比</button></div>
      <div v-if="result" class="ac-result" data-testid="acceptance-comparison-result">
        <div class="ac-result-head"><h3>{{ result.status === 'blocked' ? '对比受阻：无法确认复验' : '运行对比已生成' }}</h3><div class="ac-actions"><button type="button" :disabled="!!exporting || loading" @click="download('json')">导出对比 JSON</button><button type="button" :disabled="!!exporting || loading" @click="download('md')">导出对比 Markdown</button></div></div>
        <p v-if="exporting" class="ac-hint" role="status">正在重新核验并导出…</p>
        <p class="ac-hint">结果对应生成时读取的证据；每次导出会再次核验。复验结果不改变以下原门禁。{{ result.status === 'blocked' ? '完整性未通过时，保存的门禁记录也需要人工核对。' : '' }}</p>
        <div class="ac-original-gates"><div v-for="side in ['before', 'after']" :key="side"><span>{{ side === 'before' ? '此前原门禁' : '本次原门禁' }}</span><strong>{{ GATE_LABELS[result[side].gate] || '未记录' }}</strong><button type="button" @click="openRun(result[side].runId)">查看{{ side === 'before' ? '此前' : '本次' }}原报告</button></div></div>
        <div v-if="result.integrity" class="ac-integrity" aria-label="报告与证据完整性">
          <div v-for="side in ['before', 'after']" :key="side"><strong>{{ side === 'before' ? '此前' : '本次' }}证据{{ result.integrity[side]?.valid && result.integrity[side]?.evidenceVerified ? '已核验' : '未通过核验' }}</strong><p>{{ result.integrity[side]?.verifiedFiles ?? 0 }} 个文件通过 · 已读取 {{ result.integrity[side]?.verifiedBytes ?? 0 }} 字节</p><ul v-if="result.integrity[side]?.errors?.length"><li v-for="(problem, index) in result.integrity[side].errors" :key="index"><code>{{ problem.code }}</code> {{ problem.message }}<small v-if="problem.file">{{ problem.file }}</small></li></ul></div>
        </div>
        <div class="ac-counts" aria-label="复验关系统计"><button v-for="relation in COMPARISON_RELATIONS" :key="relation.id" type="button" :data-relation="relation.id" :class="[relation.tone, { active: filters.relation === relation.id }]" :aria-pressed="filters.relation === relation.id" @click="filters.relation = filters.relation === relation.id ? 'all' : relation.id"><span>{{ relation.label }}</span><strong>{{ result.summary[relation.counter] ?? 0 }}</strong></button></div>
        <div class="ac-filters"><label for="ac-search">搜索检查或原因<input id="ac-search" v-model="filters.query" type="search" placeholder="路由、检查、不可比原因…" /></label><button v-if="filters.relation !== 'all' || filters.query" type="button" @click="filters.relation = 'all'; filters.query = ''">查看全部关系</button><span>{{ rows.length }} / {{ result.checks.length }} 项</span></div>
        <p v-if="!rows.length" class="ac-hint">{{ result.checks.length ? '没有符合筛选条件的检查。' : '没有可对比检查；请查看下方完整性诊断并重新运行。' }}</p>
        <ol class="ac-rows"><li v-for="row in rows" :key="row.key" :data-comparison-relation="row.relation"><div class="ac-row-head"><strong>{{ row.title }}</strong><span :class="relationOf(row.relation)?.tone">{{ relationOf(row.relation)?.label || row.relation }}</span></div><p class="ac-row-scope"><code>{{ row.route }}</code> · {{ acceptanceViewport(row.viewport) }} · {{ row.facet }}</p><p class="ac-check-refs">此前 {{ row.before?.checkId || '未测量' }} → 本次 {{ row.after?.checkId || '未测量' }}</p><ul v-if="row.reasons.length" class="ac-reasons"><li v-for="(reason, index) in row.reasons" :key="index"><code>{{ reason.code }}</code> {{ reason.message }}</li></ul></li></ol>
        <details class="ac-limitations" :open="result.status === 'blocked'"><summary>适用范围与完整性诊断</summary><ul><li v-for="(note, index) in result.limitations" :key="index">{{ note }}</li></ul></details>
      </div>
    </section>
  </details>
</template>

<style scoped>
.ac-panel { min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--r); margin-bottom: 24px; background: var(--surface-2); }
.ac-panel > summary { display: flex; justify-content: space-between; align-items: center; gap: 16px; min-height: 64px; padding: 14px 16px; cursor: pointer; list-style: none; }
.ac-panel > summary::-webkit-details-marker { display: none; }
.ac-panel > summary strong { display: block; font-size: 14px; font-weight: 600; }
.ac-panel > summary small { display: block; color: var(--text-dim); font-size: 12px; margin-top: 5px; line-height: 1.6; }
.ac-body { border-top: 1px solid var(--border); padding: 18px 16px; min-width: 0; }
.ac-intro, .ac-hint { color: var(--text-dim); font-size: 12px; line-height: 1.75; }
.ac-hint, .ac-error { margin-top: 10px; overflow-wrap: anywhere; }
.ac-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 16px; }
.ac-pair label, .ac-filters label { min-width: 0; display: block; font-size: 12px; }
.ac-pair select, .ac-filters input { display: block; width: 100%; min-width: 0; min-height: 44px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg); color: var(--text); padding: 8px; margin-top: 7px; font-size: 12px; }
button { min-height: 44px; padding: 9px 12px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: var(--r-sm); cursor: pointer; font-size: 12px; }
button:hover:not(:disabled) { background: var(--bg-2); border-color: var(--text-dim); }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.ac-primary { background: var(--accent); color: var(--bg); font-weight: 600; }
.ac-primary:hover:not(:disabled) { background: var(--accent); }
.ac-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.ac-actions > span { color: var(--text-dim); font-size: 12px; }
.ac-error, .bad { color: var(--bad); }
.ac-error { font-size: 12px; line-height: 1.7; }
.ac-error button { margin-top: 8px; }
.ok { color: var(--ok); }
.warn { color: var(--warn); }
.ac-result { margin-top: 24px; border-top: 1px solid var(--border-strong); padding-top: 20px; }
.ac-result-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; }
.ac-result-head h3 { font-size: 15px; font-weight: 600; }
.ac-result-head .ac-actions { margin: 0; }
.ac-original-gates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
.ac-original-gates > div { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.ac-original-gates span { color: var(--text-dim); font-size: 12px; }
.ac-original-gates strong { font-size: 13px; font-weight: 550; }
.ac-original-gates button { width: 100%; }
.ac-integrity { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; border-top: 1px solid var(--border); margin-top: 16px; padding-top: 14px; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.ac-integrity strong { font-weight: 550; }
.ac-integrity p { color: var(--text-dim); margin-top: 4px; }
.ac-integrity ul { padding-left: 16px; margin-top: 7px; color: var(--warn); }
.ac-integrity small { display: block; font-family: var(--font-mono); font-size: 11px; }
.ac-counts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-top: 18px; }
.ac-counts button { text-align: left; padding: 12px 10px; min-width: 0; background: var(--bg); }
.ac-counts button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.ac-counts span { display: block; font-size: 12px; color: var(--text-dim); line-height: 1.6; }
.ac-counts strong { display: block; font-size: 21px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
.ac-filters { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-top: 22px; }
.ac-filters label { flex: 1; min-width: 150px; }
.ac-filters > span { font-size: 12px; color: var(--text-dim); padding: 12px 0; }
.ac-rows { list-style: none; margin-top: 12px; padding: 0; }
.ac-rows > li { padding: 16px 0; border-top: 1px solid var(--border); overflow-wrap: anywhere; }
.ac-row-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
.ac-row-head strong { font-weight: 550; font-size: 13px; }
.ac-row-head > span { flex: none; font-size: 12px; }
.ac-row-scope, .ac-check-refs { color: var(--text-dim); font-size: 12px; line-height: 1.7; margin-top: 7px; }
.ac-check-refs { font-family: var(--font-mono); font-size: 11px; }
.ac-reasons, .ac-limitations ul { padding-left: 18px; margin-top: 9px; color: var(--text-dim); font-size: 12px; line-height: 1.8; }
.ac-limitations { margin-top: 16px; font-size: 12px; overflow-wrap: anywhere; }
.ac-limitations summary { cursor: pointer; min-height: 44px; padding: 12px 0; }
@media (max-width: 960px) { .ac-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .ac-pair, .ac-original-gates, .ac-integrity { grid-template-columns: minmax(0, 1fr); } .ac-body { padding: 16px 12px; } .ac-row-head { flex-wrap: wrap; gap: 5px; } .ac-result-head .ac-actions { width: 100%; } .ac-result-head button { flex: 1; } }
</style>
