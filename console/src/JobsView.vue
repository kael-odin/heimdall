<script setup>
/**
 * JobsView — 任务中心（本会话任务 + 引擎持久化历史）
 *
 * 两块数据来源不同，所以要一起展示、分开标注：
 *   tasks   —— 本会话内存里的任务（引擎重启即消失）
 *   jobs    —— 引擎持久化的历史（重启后仍可查，见 /api/history）
 * 混在一起会让人以为历史任务也能点开看进度，所以历史行标了 .history 且不可点。
 */
import SiteBar from './SiteBar.vue';
import Icon from './Icon.vue';
import { taskState, taskLabel, fmtTime, fmtDuration, kindCn } from './format.js';

defineProps({
  tasks: { type: Array, default: () => [] },
  jobs: { type: Array, default: () => [] },
  sites: { type: Array, default: () => [] },
  host: { type: String, default: '' },
  engine: { type: Object, default: () => ({}) },
  actions: { type: Array, default: () => [] },
});
defineEmits(['pick', 'action', 'close', 'retry']);

/** 单行右侧的读数：不同任务类型看的东西不一样 */
function readingOf(t) {
  if (t.kind === 'audit') return t.auditScore != null ? t.auditScore + ' 分' : '—';
  if (t.kind === 'watch') return t.watchChanges != null ? t.watchChanges + ' 处变化' : '—';
  if (t.kind === 'assets') return t.assetGaps != null ? t.assetGaps + ' 缺口' : '—';
  return t.score ? (t.score.pixel * 100).toFixed(1) + '%' : '—';
}

/** 历史行能不能续跑：中断/失败，且有可重发的 kind 与 url。
 *  引擎重启会把 running 的旧任务标成 interrupted —— 那就该能一键续上，而不是让用户猜怎么重来。 */
function canRetry(h) {
  return ['interrupted', 'failed'].includes(h.status) && ['clone', 'forge'].includes(h.kind) && !!h.url;
}
const RETRY_CN = { clone: '继续克隆', forge: '重新克隆' };
</script>

<template>
  <section class="work-view surface">
    <div class="wv-head">
      <b>任务中心</b>
      <span class="wv-stat">引擎 {{ engine.ok ? '在线' : '离线' }} · 克隆槽 {{ engine.forge?.slots ?? 0 }}/{{ engine.forge?.max ?? 2 }} · 本会话 {{ tasks.length }} 个任务</span>
      <SiteBar :sites="sites" :host="host" :actions="actions" @pick="$emit('pick', $event)" @action="$emit('action', $event)" />
      <button class="wv-close" @click="$emit('close')" title="返回星图（Esc）"><Icon name="close" decorative /> 返回星图</button>
    </div>
    <div class="wv-rows">
      <div class="wv-row job-row" v-for="t in [...tasks].reverse()" :key="t.localId">
        <span class="job-name">{{ t.label ?? t.pageName }}</span>
        <span class="job-kind">{{ kindCn(t.kind) }}</span>
        <span class="wv-state" :class="taskState(t)">{{ taskLabel(t) }}</span>
        <span class="wv-score">{{ readingOf(t) }}</span>
        <span class="job-time">{{ fmtTime(t.startedAt) }} · {{ fmtDuration(t) }}</span>
        <span class="job-error" :title="t.error">{{ t.error || '' }}</span>
      </div>
      <div class="wv-empty" v-if="!tasks.length && !jobs.length">本次会话还没有任务：在「星图」点击页面，或在「页面」批量克隆 / 运行 SEO 审计。</div>
      <div class="wv-sub" v-if="jobs.length">引擎持久化历史（最近 {{ jobs.length }} 条，重启后仍可查）</div>
      <div class="wv-row job-row history" v-for="h in jobs" :key="'h-' + h.id">
        <span class="job-name">{{ h.pageName || h.url }}</span>
        <span class="job-kind">{{ h.kind }}</span>
        <span class="wv-state" :class="h.status === 'done' ? 'done' : h.status === 'failed' ? 'failed' : h.status === 'running' ? 'running' : 'idle'">{{ h.status }}</span>
        <span class="wv-score">—</span>
        <span class="job-time">{{ fmtTime(h.createdAt) }} · {{ h.endedAt ? Math.round((h.endedAt - h.createdAt) / 1000) + 's' : '' }}</span>
        <span class="job-error">{{ h.error || '' }}</span>
        <span class="job-retry"><button v-if="canRetry(h)" @click="$emit('retry', h)" :title="'重新发起这个任务'">{{ RETRY_CN[h.kind] }}</button></span>
      </div>
    </div>
  </section>
</template>
