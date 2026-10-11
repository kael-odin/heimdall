<script setup>
/**
 * Sparkline — 走势小图（纯展示，无依赖）
 *
 * 用折线而不是柱：分数的变化通常只有几个点、幅度不大，折线更能看出方向。
 * 只有一个点时画一个圆点 —— 空图会让人以为"坏了"，而真相是"只跑过一次"。
 */
import { computed } from 'vue';

const props = defineProps({
  points: { type: Array, default: () => [] },   // [{at, v}]
  unit: { type: String, default: '' },
  label: { type: String, default: '' },
});

const W = 100, H = 28;

const stats = computed(() => {
  const vs = props.points.map(p => p.v);
  if (!vs.length) return null;
  return { lo: Math.min(...vs), hi: Math.max(...vs), last: vs[vs.length - 1], first: vs[0], n: vs.length };
});

const path = computed(() => {
  const pts = props.points;
  if (pts.length < 2 || !stats.value) return '';
  const { lo, hi } = stats.value;
  const span = hi - lo || 1;
  return pts.map((p, i) => {
    const x = (i / (pts.length - 1)) * W;
    const y = H - 3 - ((p.v - lo) / span) * (H - 6);
    return `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
});

const lastPos = computed(() => {
  const pts = props.points;
  if (pts.length !== 1 || !stats.value) return null;
  return { x: W / 2, y: H / 2 };
});

const fmt = (v) => (Math.round(v * 10) / 10).toFixed(1) + props.unit;
</script>

<template>
  <div class="spark">
    <div class="spark-head">
      <span class="spark-label">{{ label }}</span>
      <span class="spark-last" v-if="stats">{{ fmt(stats.last) }}<i>{{ stats.n }} 次记录</i></span>
    </div>
    <svg v-if="path || lastPos" class="spark-svg" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img"
      :aria-label="label + ' 走势：' + (stats ? fmt(stats.first) + ' 到 ' + fmt(stats.last) : '无数据')">
      <path :d="path" fill="none" stroke="currentColor" stroke-width="1.2" vector-effect="non-scaling-stroke" />
      <circle v-if="lastPos" :cx="lastPos.x" :cy="lastPos.y" r="1.8" fill="currentColor" />
    </svg>
    <div class="spark-empty" v-else>还没有数据</div>
    <div class="spark-range" v-if="stats && stats.n > 1">
      <span>{{ fmt(stats.lo) }}</span><span>{{ fmt(stats.hi) }}</span>
    </div>
  </div>
</template>

<style scoped>
.spark { display: flex; flex-direction: column; gap: 3px; min-width: 150px; }
.spark-head { display: flex; align-items: baseline; gap: 8px; }
.spark-label { font-size: 11px; color: var(--muted); }
.spark-last { margin-left: auto; font-size: 12px; color: var(--text); font-family: var(--font-mono); }
.spark-last i { font-style: normal; color: var(--muted); font-size: 10px; margin-left: 6px; }
.spark-svg { width: 100%; height: 34px; color: var(--accent); }
.spark-empty { font-size: 11px; color: var(--muted); padding: 8px 0; }
.spark-range { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); font-family: var(--font-mono); }
</style>
