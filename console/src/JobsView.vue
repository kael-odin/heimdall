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
import { computed } from 'vue';
import { taskState, taskLabel, fmtTime, fmtStamp, fmtDuration, kindCn, jobStatusCn } from './format.js';
import { canRetry, canExportLive, hostOfTask, RETRY_CN } from './tasks.js';

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  jobs: { type: Array, default: () => [] },
  sites: { type: Array, default: () => [] },
  host: { type: String, default: '' },
  engine: { type: Object, default: () => ({}) },
  actions: { type: Array, default: () => [] },
});
defineEmits(['pick', 'action', 'close', 'retry', 'export-live', 'stop']);

/**
 * 这批历史覆盖的时间跨度。
 * "最新 50 条"答不了"我看的是什么时候的历史" —— 而这条列表看起来**永远不变**
 * （它就是持久化历史，刷新当然不变），所以跨度必须写在标题上，否则只能靠猜。
 */
const historySpan = computed(() => {
  const ts = props.jobs.map(h => h.createdAt).filter(t => Number.isFinite(t));
  if (!ts.length) return '';
  const lo = new Date(Math.min(...ts)), hi = new Date(Math.max(...ts));
  const d = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  return d(lo) === d(hi) ? d(hi) : d(lo) + ' ~ ' + d(hi);
});

/** 单行右侧的读数：不同任务类型看的东西不一样 */
function readingOf(t) {
  if (t.kind === 'audit') return t.auditScore != null ? t.auditScore + ' 分' : '—';
  if (t.kind === 'watch') return t.watchChanges != null ? t.watchChanges + ' 处变化' : '—';
  if (t.kind === 'assets') return t.assetGaps != null ? t.assetGaps + ' 缺口' : '—';
  return t.score ? (t.score.pixel * 100).toFixed(1) + '%' : '—';
}

// canRetry / canExportLive / hostOfTask / RETRY_CN 都在 tasks.js —— 抽出去是为了能被单测钉住，
// 免得"从任务行反推站点身份"出现第二份实现（那类分叉的表现是"点了没反应"）。
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
        <!-- 只有引擎侧真有进程（taskId）的任务才给「停止」：前端排队的批次没有可停的东西，
             给一个点了没反应的按钮比不给更糟。 -->
        <span class="job-stop"><button v-if="!t.done && !t.failed && t.taskId" :disabled="!!t.stopping"
          @click="$emit('stop', t)" :title="t.stopping ? '已请求停止，等引擎收尾；已完成的页会保留' : '让引擎停下这个任务（已完成的产物保留）'">{{ t.stopping ? '停止中…' : '停止' }}</button></span>
        <span class="job-live"><button v-if="canExportLive(t)"
          @click="$emit('export-live', hostOfTask(t))"
          title="交互镜像：保留脚本、资源实时回源的另一种产物（与「静态镜像」不是一回事），导出后是一个可直接部署的离线包。首次生成 / 导出过则是增量更新">导出交互镜像</button></span>
      </div>
      <div class="wv-empty" v-if="!tasks.length && !jobs.length">
        <p>还没有任何任务。</p>
        <p class="wv-empty-hint">先在星图顶部填一个网址并点「侦察」，看清全站有哪些页面；只想要一页就点「只克隆此页」。任务跑起来之后，这里会出现进度、耗时和停止按钮。</p>
        <button class="wv-primary" @click="$emit('close')">回星图，粘一个网址开始</button>
      </div>
      <div class="wv-sub" v-if="jobs.length">引擎持久化历史（最新 {{ jobs.length }} 条 · {{ historySpan }} · 重启后仍可查）</div>
      <div class="wv-row job-row history" v-for="h in jobs" :key="'h-' + h.id">
        <span class="job-name">{{ h.pageName || h.url }}</span>
        <span class="job-kind">{{ kindCn(h.kind) }}</span>
        <span class="wv-state" :class="h.status === 'done' ? 'done' : h.status === 'failed' ? 'failed' : h.status === 'running' ? 'running' : 'idle'">{{ jobStatusCn(h.status) }}</span>
        <span class="wv-score">—</span>
        <span class="job-time">{{ fmtStamp(h.createdAt) }} · {{ h.endedAt ? Math.round((h.endedAt - h.createdAt) / 1000) + 's' : '' }}</span>
        <span class="job-error" :title="h.error || ''">{{ h.error || '' }}</span>
        <span class="job-retry"><button v-if="canRetry(h)" @click="$emit('retry', h)" :title="'重新发起这个任务'">{{ RETRY_CN[h.kind] }}</button></span>
        <span class="job-live"><button v-if="canExportLive(h)"
          @click="$emit('export-live', hostOfTask(h))"
          title="交互镜像：保留脚本、资源实时回源的另一种产物（与「静态镜像」不是一回事），导出后是一个可直接部署的离线包。首次生成 / 导出过则是增量更新">导出交互镜像</button></span>
      </div>
    </div>
  </section>
</template>
