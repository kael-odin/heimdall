<script setup>
/**
 * SitePicker — 工作视图表头里的站点切换器
 *
 * 为什么需要它：站点切换原本是星图上的浮层（.sites），在工作视图里会压住内容，
 * 窄屏下「页面清单」等按钮还会被裁掉、点不到。工作视图改为在各自表头内提供站点选择，
 * 浮层只留给星图。
 */
defineProps({
  sites: { type: Array, default: () => [] },
  host: { type: String, default: '' },
  busy: { type: Boolean, default: false },
});
const emit = defineEmits(['pick', 'audit']);
const onPick = (e) => emit('pick', e.target.value);
</script>

<template>
  <div class="site-picker">
    <label class="sr-only" for="site-picker-select">切换站点</label>
    <select id="site-picker-select" class="sp-select" :value="host" :disabled="!sites.length" @change="onPick">
      <option v-if="!sites.length" value="">尚无已侦察站点</option>
      <option v-for="s in sites" :key="s.host" :value="s.host">
        {{ s.host }} · {{ s.pages ? s.forged + '/' + s.pages + ' 页' : '侦察结果为空' }}
      </option>
    </select>
    <button class="sp-btn" :disabled="busy || !host" :title="busy ? '已有审计任务在运行' : '全站 SEO 审计（40+ 规则，输出 HTML/CSV/JSON）'" @click="emit('audit')">
      SEO 审计
    </button>
  </div>
</template>

<style scoped>
.site-picker { display: inline-flex; align-items: center; gap: 6px; }
.sp-select {
  background: rgba(255,255,255,.04); border: 1px solid var(--cyan-line); color: var(--text);
  border-radius: 3px; padding: 6px 9px; font-size: 12px; color-scheme: dark; max-width: 280px;
}
.sp-select option { background: #14141a; color: #e2e8f0; }
:global([data-theme="light"]) .sp-select { background: #fff; color-scheme: light; }
:global([data-theme="light"]) .sp-select option { background: #fff; color: #0f172a; }
.sp-btn {
  color: var(--green); border: 1px solid rgba(52,211,153,.4); background: rgba(52,211,153,.06);
  border-radius: 3px; padding: 6px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.sp-btn:disabled { opacity: .45; cursor: not-allowed; }
.sp-btn:hover:enabled { border-color: rgba(52,211,153,.7); }
</style>
