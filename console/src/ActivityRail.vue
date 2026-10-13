<script setup>
/**
 * ActivityRail —— 「进行中」的那一条轨道
 *
 * 存在的理由是一次实测：一次 40 秒的单页克隆，在 t=2.5 / 8 / 20 秒三次采样里
 * 屏幕上能看到的文字**完全一致**（状态条「克隆中 · home」+ 任务中心一行「home 运行中」），
 * 第 40 秒才跳成完成。而六个阶段名和一条实时日志其实一直在 SSE 里推过来 ——
 * 它们此前只渲染在**详情面板的「克隆」tab**里，那要"选中该页 → 打开面板 → 切 tab"。
 *
 * 这条轨道把那份信息搬到始终可见的地方：目标、第几步、当前阶段、已跑多久
 * （同类页面的中位耗时来自真实历史，样本不足就不显示）、以及最后一行输出。
 *
 * 动效只有一处持续信号 —— **进行中那一段上扫过的光带**。
 * "有东西在动"本身就是等待感的主要来源，但到处都动就没有重点了：
 * 阶段完成时那一次 320ms 的填充、日志行的 200ms 淡入，都是同一套节拍里的短动作。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { FORGE_STAGES, forgeStageProgress, stageProgressText } from './format.js';
import { hostOfTask } from './tasks.js';

const props = defineProps({
  task: { type: Object, required: true },
  /** 参考耗时 `{ sec, scope }`（scope: 'host' | 'all'）。样本不足时父组件传 null ——
   *  宁可不显示，也不给假精度。两档**分开标**：跨站兜底不能冒充"同类"。 */
  median: { type: Object, default: null },
  /** 点目标能不能跳过去（页不在当前站点/星图里时不给假按钮） */
  canFocus: { type: Boolean, default: false },
});
defineEmits(['focus']);

const now = ref(Date.now());
let timer = null;
// 只在活着的时候走秒。空闲会话不该养一个空转定时器（详情面板那条同理）。
onMounted(() => { timer = setInterval(() => { now.value = Date.now(); }, 1000); });
onUnmounted(() => { if (timer) clearInterval(timer); });

const mmss = (sec) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');

/** 目标写成"站点/页"：切到别的站以后，光一个 `home` 认不出是谁 */
const target = computed(() => {
  const h = hostOfTask(props.task);
  const page = props.task.pageName || '';
  if (h && page) return h + '/' + page;
  return h || props.task.label || '任务';
});

const stages = computed(() => forgeStageProgress(props.task.stages ?? null));
const stageText = computed(() => stageProgressText(stages.value));
/** 有分子分母的任务（整站克隆 / 审计 / 扫描 / 导出）：用真实计数画条，不猜百分比 */
const counted = computed(() => (props.task.totalCount ? { done: props.task.doneCount ?? 0, total: props.task.totalCount } : null));
const countText = computed(() => (counted.value ? `${counted.value.done}/${counted.value.total}` : ''));

const elapsedText = computed(() => {
  const t0 = props.task.startedAt;
  if (!t0) return '';
  const end = props.task.endedAt ?? now.value;
  return mmss(Math.max(0, (end - t0) / 1000));
});
const medianText = computed(() => (props.median?.sec >= 5 ? mmss(props.median.sec) : ''));
/** 口径写清楚：本站样本写「同类中位」，跨站兜底写「跨站中位」 */
const medianLabel = computed(() => (props.median?.scope === 'all' ? '跨站中位' : '同类中位'));

const segState = (k) => props.task.stages?.[k] ?? 'idle';
const logLine = computed(() => {
  const lines = props.task.logs;
  if (!lines?.length) return '';
  return String(lines[lines.length - 1]).trim().slice(0, 110);
});
</script>

<template>
  <aside class="rail surface" :class="{ stalled: !!task.killed }">
    <div class="rail-top">
      <span class="rail-pip" aria-hidden="true"></span>
      <button v-if="canFocus" class="rail-target" @click="$emit('focus')"
              :title="'跳到 ' + target">{{ target }}</button>
      <span v-else class="rail-target" :title="task.url || target">{{ target }}</span>
      <span class="rail-stage">{{ stageText || countText || '进行中' }}</span>
      <span class="rail-clock" aria-hidden="true">
        <b>{{ elapsedText }}</b><i v-if="medianText" :title="'这一档的中位耗时来自真实历史'">{{ medianLabel }} {{ medianText }}</i>
      </span>
    </div>

    <div v-if="stages" class="rail-track" role="progressbar" :aria-valuemin="0"
         :aria-valuemax="stages.total" :aria-valuenow="stages.index" :aria-valuetext="stageText">
      <span v-for="(label, key) in FORGE_STAGES" :key="key" class="seg" :class="segState(key)" :title="label">
        <span class="seg-fill"></span>
      </span>
    </div>
    <div v-else-if="counted" class="rail-track" role="progressbar" :aria-valuemin="0"
         :aria-valuemax="counted.total" :aria-valuenow="counted.done" :aria-valuetext="countText">
      <span class="seg" :style="{ flex: counted.done || 1 }"><span class="seg-fill on"></span></span>
      <span class="seg" :style="{ flex: Math.max(counted.total - counted.done, 0) || 1 }"><span class="seg-fill"></span></span>
    </div>
    <div v-else class="rail-track unknown" role="progressbar" aria-valuetext="进行中">
      <span class="seg"><span class="seg-fill on sweep"></span></span>
    </div>

    <p v-if="logLine" class="rail-log" role="log" aria-live="polite" :key="logLine">{{ logLine }}</p>
  </aside>
</template>
