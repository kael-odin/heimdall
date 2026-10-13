<script setup>
/**
 * PagesView — 页面清单工作台
 *
 * 筛选 / 排序 / 勾选三件状态**放在本组件内部**，不下发给父组件。
 * 理由：它们是纯粹的视图状态（换视图就该重置），父组件从来不读它们，
 * 唯一需要外传的只是"用户勾了哪些 id" —— 那用事件带出去就够了。
 * 放在父组件的话，每次改动都要在 1700 行里找那几个 ref，正是拆分要解决的问题。
 *
 * 父组件仍然持有 pageScores / pageVerify / pageMeta：
 * 它们的加载是**按站点的一次批量请求**（loadPageStatus），
 * 详情面板也要用同一份数据，放在这里会导致切换视图就重新拉一遍。
 */
import { ref, computed } from 'vue';
import SiteBar from './SiteBar.vue';
import Icon from './Icon.vue';
import { PAGE_TYPES as PT, typeColor, typeCn } from './types.js';
import { fmtDate, fmtBytes } from './format.js';

const PAGE_TYPES = PT;

const props = defineProps({
  host: { type: String, default: '' },
  sites: { type: Array, default: () => [] },
  nodes: { type: Array, default: () => [] },       // 全量清单（含孤儿已克隆页）
  actions: { type: Array, default: () => [] },
  scores: { type: Object, default: () => ({}) },   // nodeId -> score.json
  verify: { type: Object, default: () => ({}) },   // nodeId -> verify.json
  meta: { type: Object, default: () => ({}) },     // nodeId -> { assets, visualGaps, interactions, updatedAt }
  theme: { type: String, default: 'dark' },
});
const emit = defineEmits(['pick', 'audit', 'close', 'detail', 'forge', 'delete', 'forge-checked', 'remove-checked']);

const typeColorThemed = (t) => typeColor(t, props.theme);

// ---------- 视图状态（本组件自持） ----------
const pageQuery = ref('');
const typeFilter = ref('');
const statusFilter = ref('');
const sortKey = ref('path');
const sortDir = ref(1);
const selectedIds = ref(new Set());

const STATE_RANK = { done: 0, running: 1, failed: 2, idle: 3 };

function toggleSort(k) {
  if (sortKey.value === k) sortDir.value = -sortDir.value; else { sortKey.value = k; sortDir.value = 1; }
}
/** 排序表头的无障碍名：把当前排序状态也读出来（读屏用户看不到 ▲/▼ 那两个箭头） */
const sortAria = (k, label) => sortKey.value === k
  ? `${label}，当前${sortDir.value > 0 ? '升序' : '降序'}，回车切换`
  : `${label}，回车排序`;
function toggleOne(id) {
  const s = new Set(selectedIds.value);
  s.has(id) ? s.delete(id) : s.add(id);
  selectedIds.value = s;
}
function selectAllTodo() {
  const s = new Set(selectedIds.value);
  props.nodes.filter(n => n.forgeState !== 'done').forEach(n => s.add(n.id));
  selectedIds.value = s;
}
function selectAll() { selectedIds.value = new Set(props.nodes.map(n => n.id)); }
function clearAll() { selectedIds.value = new Set(); }

/** 交给父组件执行后清空勾选 */
function handOff(kind) {
  const ids = [...selectedIds.value];
  if (!ids.length) return;
  emit(kind, ids);
  selectedIds.value = new Set();
}

const filteredNodes = computed(() => {
  const q = pageQuery.value.trim().toLowerCase();
  const out = props.nodes.filter(n => {
    if (typeFilter.value && n.type !== typeFilter.value) return false;
    if (statusFilter.value === 'done' && n.forgeState !== 'done') return false;
    if (statusFilter.value === 'todo' && (n.forgeState === 'done' || n.forgeState === 'running')) return false;
    if (statusFilter.value === 'failed' && n.forgeState !== 'failed') return false;
    const hay = ((n.url || '') + ' ' + (n.title || '') + ' ' + (n.path || '')).toLowerCase();
    return !q || hay.includes(q);
  });
  const dir = sortDir.value;
  out.sort((a, b) => {
    if (sortKey.value === 'state') return (STATE_RANK[a.forgeState] - STATE_RANK[b.forgeState]) * dir;
    if (sortKey.value === 'score') {
      const av = props.scores[a.id]?.pixel, bv = props.scores[b.id]?.pixel;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    }
    if (sortKey.value === 'assets') return ((props.meta[a.id]?.assets?.bytes ?? 0) - (props.meta[b.id]?.assets?.bytes ?? 0)) * dir;
    if (sortKey.value === 'title') return String(a.title || '').localeCompare(String(b.title || '')) * dir;
    return String(a.path || '').localeCompare(String(b.path || '')) * dir;
  });
  return out;
});

const doneCount = computed(() => props.nodes.filter(n => n.forgeState === 'done').length);
const statusCounts = computed(() => ({
  all: props.nodes.length,
  done: props.nodes.filter(n => n.forgeState === 'done').length,
  todo: props.nodes.filter(n => n.forgeState !== 'done' && n.forgeState !== 'running').length,
  failed: props.nodes.filter(n => n.forgeState === 'failed').length,
}));
const avgVisual = computed(() => {
  const vals = Object.values(props.scores).filter(s => s && typeof s.pixel === 'number').map(s => s.pixel);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1) + '%' : '—';
});
const avgWorst = computed(() => {
  const vals = Object.values(props.verify).filter(v => v?.minViewport && typeof v.minViewport.score === 'number').map(v => v.minViewport.score);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1) + '%' : null;
});

const stateLabel = (s) => (s === 'done' ? '已克隆' : s === 'running' ? '克隆中' : s === 'failed' ? '失败' : '未克隆');
</script>

<template>
  <section class="work-view surface">
    <div class="wv-head">
      <b>页面清单 · {{ host || '未选择站点' }}</b>
      <span class="wv-stat">{{ doneCount }}/{{ nodes.length }} 已克隆 · 平均视觉 {{ avgVisual }}<template v-if="avgWorst"> · 最差视口均值 {{ avgWorst }}</template></span>
      <SiteBar :sites="sites" :host="host" :actions="actions" @pick="$emit('pick', $event)" @action="$emit('action', $event)" />
      <input class="wv-search" v-model="pageQuery" aria-label="搜索页面 URL 或标题" placeholder="搜索 URL / 标题" spellcheck="false" />
      <select v-model="typeFilter" aria-label="按页面类型筛选"><option value="">全部类型</option><option v-for="(t, k) in PAGE_TYPES" :key="k" :value="k">{{ t.cn }}</option></select>
      <select v-model="statusFilter" aria-label="按克隆状态筛选"><option value="">全部状态 ({{ statusCounts.all }})</option><option value="done">已克隆 ({{ statusCounts.done }})</option><option value="todo">未完成 ({{ statusCounts.todo }})</option><option value="failed">失败 ({{ statusCounts.failed }})</option></select>
      <button @click="selectAllTodo" title="全选未克隆页">全选未克隆</button>
      <button @click="selectAll" title="全选当前清单">全选</button>
      <button @click="clearAll" title="清空选择">清空</button>
      <button class="wv-primary" :disabled="!selectedIds.size" @click="handOff('forge-checked')">克隆选中 ({{ selectedIds.size }})</button>
      <button class="danger" :disabled="!selectedIds.size" @click="handOff('remove-checked')">移除选中 ({{ selectedIds.size }})</button>
      <button class="wv-close" @click="$emit('close')" title="返回星图（Esc）"><Icon name="close" decorative /> 返回星图</button>
    </div>
    <div class="wv-rows">
      <div class="wv-row wv-th">
        <span class="c-check"></span>
        <span class="c-path sortable" role="button" tabindex="0" :aria-label="sortAria('path', '路径')" @click="toggleSort('path')" @keydown.enter.prevent="toggleSort('path')" @keydown.space.prevent="toggleSort('path')">路径 {{ sortKey === 'path' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-title sortable" role="button" tabindex="0" :aria-label="sortAria('title', '标题')" @click="toggleSort('title')" @keydown.enter.prevent="toggleSort('title')" @keydown.space.prevent="toggleSort('title')">标题 {{ sortKey === 'title' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-type">类型</span>
        <span class="c-state sortable" role="button" tabindex="0" :aria-label="sortAria('state', '状态')" @click="toggleSort('state')" @keydown.enter.prevent="toggleSort('state')" @keydown.space.prevent="toggleSort('state')">状态 {{ sortKey === 'state' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-score sortable" role="button" tabindex="0" :aria-label="sortAria('score', '视觉还原度')" @click="toggleSort('score')" @keydown.enter.prevent="toggleSort('score')" @keydown.space.prevent="toggleSort('score')">视觉 {{ sortKey === 'score' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-assets sortable" role="button" tabindex="0" :aria-label="sortAria('assets', '资产体积')" @click="toggleSort('assets')" @keydown.enter.prevent="toggleSort('assets')" @keydown.space.prevent="toggleSort('assets')">资产 {{ sortKey === 'assets' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-gaps">缺口</span>
        <span class="c-ix">交互</span>
        <span class="c-updated">更新</span>
        <span class="c-actions">操作</span>
      </div>
      <div class="wv-row" v-for="n in filteredNodes" :key="n.id">
        <label class="c-check"><input type="checkbox" :checked="selectedIds.has(n.id)" :aria-label="'选择页面 ' + (n.path || n.url)" @change="toggleOne(n.id)" /></label>
        <span class="wv-url c-path" role="button" tabindex="0" :aria-label="'打开详情：' + (n.path || n.url)" @click="$emit('detail', n)" @keydown.enter.prevent="$emit('detail', n)" @keydown.space.prevent="$emit('detail', n)" :title="n.url">{{ n.path }}</span>
        <span class="wv-title c-title" :title="n.title">{{ n.title }}</span>
        <span class="wv-type c-type" :style="{ color: typeColorThemed(n.type) }">{{ typeCn(n.type) }}</span>
        <span class="wv-state c-state" :class="n.forgeState">{{ stateLabel(n.forgeState) }}</span>
        <span class="wv-score c-score" :title="verify[n.id]?.minViewport ? ('多视口最差：' + verify[n.id].minViewport.name + ' ' + (verify[n.id].minViewport.score * 100).toFixed(1) + '%') : '未运行多视口验证'">{{ scores[n.id]?.pixel != null ? (scores[n.id].pixel * 100).toFixed(1) + '%' : '—' }}<i v-if="verify[n.id]?.minViewport && verify[n.id].minViewport.score < 0.95" :class="verify[n.id].minViewport.score < 0.85 ? 'min-bad' : 'min-mid'"> ↓{{ (verify[n.id].minViewport.score * 100).toFixed(0) }}</i></span>
        <span class="wv-meta c-assets" :title="meta[n.id]?.assets ? (meta[n.id].assets.count + ' 个文件') : ''">{{ meta[n.id]?.assets ? fmtBytes(meta[n.id].assets.bytes) : '—' }}<i v-if="meta[n.id]?.assets"> · {{ meta[n.id].assets.count }}</i></span>
        <span class="wv-meta c-gaps" :class="{ bad: (meta[n.id]?.visualGaps?.visual ?? 0) > 0 }" :title="meta[n.id]?.visualGaps ? ('原站 ' + meta[n.id].visualGaps.origin + ' / 第三方 ' + meta[n.id].visualGaps.third) : ''">{{ meta[n.id]?.visualGaps == null ? '—' : meta[n.id].visualGaps.visual }}</span>
        <span class="wv-meta c-ix">{{ meta[n.id]?.interactions ? (meta[n.id].interactions.passed + '/' + meta[n.id].interactions.total) : '—' }}</span>
        <span class="wv-meta c-updated">{{ fmtDate(meta[n.id]?.updatedAt) }}</span>
        <span class="wv-actions c-actions">
          <a :href="n.url" target="_blank" rel="noopener" title="打开原站">原站</a>
          <button @click="$emit('detail', n)">详情</button>
          <button :disabled="n.forgeState === 'running'" @click="$emit('forge', n)">{{ n.forgeState === 'done' ? '重新克隆' : '克隆' }}</button>
          <button v-if="n.forgeState === 'done' || n.forgeState === 'failed'" class="danger" @click="$emit('delete', n)" title="删除该页克隆产物并从星图移除">删除</button>
        </span>
      </div>
      <div class="wv-empty" v-if="!filteredNodes.length">没有匹配的页面。</div>
    </div>
  </section>
</template>
