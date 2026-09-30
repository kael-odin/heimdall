<script setup>
/**
 * Graph3D — 3d-force-graph 星图渲染层（graphify 同款形态）
 *
 * 数据由父组件喂：nodes（含 color/ring/path/type/url/forgeState/bornAt）
 * links = [{ source: nodeId, target: nodeId }]
 * 节点点击 → emit('node-click', node)
 * live 生长：父组件 push 后自增 tick，本组件 watch tick 重喂 graphData（力模拟热身 = 节点弹入）
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import ForceGraph3D from '3d-force-graph';

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  links: { type: Array, default: () => [] },
  tick: { type: Number, default: 0 },
});
const emit = defineEmits(['node-click', 'node-hover']);

const el = ref(null);
let graph = null;
let disposed = false;

function nodeColor(n) {
  if (n.forgeState === 'running') return '#F59E0B';
  return n.color ?? '#22D3EE';
}
function nodeVal(n) {
  return n.ring === 0 ? 14 : Math.max(3.5, 7 - n.ring * 1.6) + (n.type === 'listing' ? 1 : 0);
}

function update() {
  if (!graph || disposed) return;
  graph.nodeRelSize(5);
  graph.graphData({
    nodes: props.nodes.map(n => ({ ...n, __id: n.id, color: nodeColor(n) })),
    links: props.links.map(l => ({ source: l.source ?? l.from ?? l[0]?.id, target: l.target ?? l.to ?? l[1]?.id })),
  });
  try { graph.zoomToFit(700, 70); } catch {}
}

onMounted(() => {
  graph = ForceGraph3D()(el.value)
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .nodeColor(nodeColor)
    .nodeVal(nodeVal)
    .nodeLabel(n => `${n.path ?? ''}  [${n.type ?? ''}]`)
    .nodeOpacity(0.95)
    .linkColor(() => 'rgba(34,211,238,0.35)')
    .linkOpacity(0.35)
    .linkWidth(0.4)
    .onNodeClick(n => emit('node-click', n))
    .onNodeHover(n => { emit('node-hover', n); el.value.style.cursor = n ? 'pointer' : ''; });
  graph.d3Force('charge')?.strength(-260);
  graph.d3Force('link')?.distance(110);
  update();
  // 冷却后自动取景 + 缓慢自转（graphify 式可拖拽旋转）
  let stopped = false;
  graph.onEngineStop(() => {
    if (disposed || stopped) return;
    stopped = true;
    try { graph.zoomToFit(900, 70); } catch {}
    graph.controls().autoRotate = true;
    graph.controls().autoRotateSpeed = 0.5;
  });
});
onBeforeUnmount(() => { disposed = true; graph?._destructor?.(); });
watch(() => props.tick, update);
</script>

<template>
  <div ref="el" class="g3d"></div>
</template>

<style scoped>
.g3d { position: absolute; inset: 0; cursor: grab; }
.g3d:active { cursor: grabbing; }
</style>
