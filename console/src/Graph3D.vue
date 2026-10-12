<script setup>
/**
 * Graph3D — 3d-force-graph 星图渲染层（graphify 同款形态）
 *
 * 交互：拖拽=旋转 · 滚轮=缩放 · Ctrl+拖拽=平移画布 · 点星球=克隆
 *
 * 数据由父组件喂：nodes（含 color/ring/path/type/url/forgeState）
 * links = [{ source: nodeId, target: nodeId }]
 * 节点点击 → emit('node-click', node)
 * live 生长：父组件 push 后自增 tick，本组件 watch tick 重喂 graphData（力模拟热身 = 节点弹入）
 */
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';

const props = defineProps({
  nodes: { type: Array, default: () => [] },
  links: { type: Array, default: () => [] },
  tick: { type: Number, default: 0 },
  autoRotate: { type: Boolean, default: true },
  /**
   * 节点色板，由父组件按当前主题给出：{ types, running, fallback, synthetic }。
   * 颜色不烤进节点对象，是为了让主题切换只重喂一次 graphData，
   * 而不需要重建整份节点列表（重建会丢失力模拟的位置，星图会跳）。
   */
  palette: { type: Object, default: () => ({}) },
});
const emit = defineEmits(['node-click', 'node-hover']);

const el = ref(null);
let graph = null;
let disposed = false;
let panning = false;
let lastX = 0, lastY = 0;
let ro = null;
let rafId = 0;
/** 自转循环的帧句柄（和 fit() 的那个分开：一个是一次性的尺寸同步，一个是常驻循环） */
let spinId = 0;
let lastSpinT = 0;
let lastW = 0, lastH = 0;

/**
 * 星图自转。
 *
 * 为什么不是"打开库的 autoRotate 就行"——**因为库冷却后根本不重绘**。
 * 实测：把 WebGL 的 drawElements/drawArrays 打点，模拟退火停下来之后
 * 5 秒内 **0 次绘制调用**（`requestAnimationFrame` 也基本停了）。
 * 所以 autoRotate 转的是相机对象，屏幕上是上一帧的静止画面 —— 勾不勾一模一样。
 * （3d-force-graph 默认还是 trackball 控制器，那上面连 autoRotate 属性都没有，
 *   等于两层都没生效。）
 *
 * 既然渲染是按需的，自转就得**自己供帧**：每帧把相机绕 target 转一点，
 * 再自己调一次 renderer.render()。这样与库的渲染策略无关，
 * 也顺带把 dz 带来的"每帧角度固定"变成"按经过时间算"——掉帧时转速不会变慢。
 * 关掉开关时这个循环什么都不做，不占 CPU。
 */
const SPIN_DEG_PER_SEC = 6;   // 60 秒一圈：看得见，又不至于让人分心
function spin(t) {
  spinId = requestAnimationFrame(spin);
  if (disposed || !graph) return;
  if (!props.autoRotate) { lastSpinT = 0; return; }
  const dt = lastSpinT ? Math.min(t - lastSpinT, 120) : 0;
  lastSpinT = t;
  if (dt <= 0) return;
  const ctr = graph.controls();
  const cam = graph.camera();
  if (!ctr?.target || !cam) return;
  const v = new THREE.Vector3().subVectors(cam.position, ctr.target);
  v.applyAxisAngle(new THREE.Vector3(0, 1, 0), (dt / 1000) * SPIN_DEG_PER_SEC * Math.PI / 180);
  cam.position.copy(ctr.target).add(v);
  cam.lookAt(ctr.target);
  try { ctr.update?.(); } catch { /* fly 控制器没有 update，忽略 */ }
  try { graph.renderer().render(graph.scene(), cam); } catch { /* 库正在自己渲染时可能瞬时不稳，忽略 */ }
}

/**
 * 把画布尺寸同步到容器。
 *
 * 必须手动做：3d-force-graph 在挂载时按当时的容器尺寸建 renderer，
 * **不监听窗口变化**。实测（视口从 1280 拖到 1024）canvas 与 .scene-container
 * 都停留在 1280 宽，documentElement.scrollWidth 也是 1280 ——
 * 于是多出一条 256px 的横向滚动条，画布右侧被裁掉。
 * 用 ResizeObserver 而不是 window.resize：容器后续被布局改动时也能跟上。
 *
 * 用 rAF 合并连续变化（拖拽窗口时 ResizeObserver 会高频回调，
 * 每次都重建 renderer 尺寸会把主线程占满）。
 */
function fit() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (!graph || disposed || !el.value) return;
    const r = el.value.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    try { graph.width(w).height(h); } catch {}
  });
}

function nodeColor(n) {
  if (n.forgeState === 'running') return props.palette.running ?? '#D9A05B';
  if (n.synthetic) return props.palette.synthetic ?? '#94918A';
  return props.palette.types?.[n.type] ?? props.palette.fallback ?? n.color ?? '#A8A59C';
}
function nodeVal(n) {
  return n.ring === 0 ? 14 : Math.max(3.5, 7 - n.ring * 1.6) + (n.type === 'listing' ? 1 : 0);
}

/**
 * @param {{fit?: boolean}} opts fit=false 时不重新取景。
 *   主题切换会走到这里，若每次都 zoomToFit 会把用户转好的视角重置掉。
 */
function update({ fit = true } = {}) {
  if (!graph || disposed) return;
  graph.nodeRelSize(5);
  graph.graphData({
    nodes: props.nodes.map(n => ({ ...n, __id: n.id, color: nodeColor(n) })),
    links: props.links.map(l => ({ source: l.source ?? l.from ?? l[0]?.id, target: l.target ?? l.to ?? l[1]?.id })),
  });
  if (fit) { try { graph.zoomToFit(700, 70); } catch {} }
}

// ---------- Ctrl+拖拽平移（沿相机平面位移，捕获阶段拦截旋转） ----------
function onPointerDown(e) {
  if (!e.ctrlKey || !graph) return;
  e.preventDefault();
  e.stopPropagation();
  panning = true;
  lastX = e.clientX; lastY = e.clientY;
  el.value.style.cursor = 'move';
  if (graph.controls()) graph.controls().enabled = false;
}
function onPointerMove(e) {
  if (!panning || !graph) return;
  e.preventDefault();
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  const cam = graph.camera();
  const ctr = graph.controls();
  const dist = cam.position.distanceTo(ctr.target ?? new THREE.Vector3());
  const k = dist * 0.0013;
  const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
  cam.position.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
  if (ctr.target) ctr.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
}
function onPointerUp() {
  if (!panning) return;
  panning = false;
  el.value.style.cursor = '';
  if (graph.controls()) graph.controls().enabled = true;
}

watch(() => props.autoRotate, (v) => {
  // 不碰 controls.autoRotate：库默认的 trackball 控制器没有这个属性，
  // 而且库冷却后不重绘，转相机也看不见（原因见 spin() 的注释）。
  // 自转完全由我们自己的 spin 循环负责。
  if (v) lastSpinT = 0;      // 重新起转时不要拿"上次停下前的时间差"补一个大角度
});

onMounted(() => {
  graph = ForceGraph3D()(el.value)
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .nodeColor(nodeColor)
    .nodeVal(nodeVal)
    .nodeLabel(n => `${n.path ?? ''}  [${n.type ?? ''}]`)
    .nodeOpacity(0.95)
    .linkColor(() => props.palette.link ?? 'rgba(204,120,92,0.35)')
    .linkOpacity(0.35)
    .linkWidth(0.4)
    .onNodeClick(n => { if (!panning) emit('node-click', n); })
    .onNodeHover(n => { emit('node-hover', n); if (!panning) el.value.style.cursor = n ? 'pointer' : ''; });
  graph.d3Force('charge')?.strength(-260);
  graph.d3Force('link')?.distance(110);
  // Ctrl+拖拽平移（捕获阶段：先于内部旋转控制器）
  el.value.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  update();
  // 尺寸跟随容器（见 fit() 注释：库自身不处理 resize）
  ro = new ResizeObserver(fit);
  ro.observe(el.value);
  fit();
  // 冷却后自动取景（自转由 spin() 常驻循环负责，不在这里挂）
  let stopped = false;
  graph.onEngineStop(() => {
    if (disposed || stopped) return;
    stopped = true;
    try { graph.zoomToFit(900, 70); } catch {}
  });
  spinId = requestAnimationFrame(spin);
});
onBeforeUnmount(() => {
  disposed = true;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (spinId) { cancelAnimationFrame(spinId); spinId = 0; }
  ro?.disconnect(); ro = null;
  el.value?.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  graph?._destructor?.();
});
watch(() => props.tick, () => update());
// 主题切换：重喂一次 graphData 即可换色（update 里会重新解析 nodeColor），
// 但不重新取景 —— 否则切主题会把用户转好的视角重置。
watch(() => props.palette, () => update({ fit: false }));
</script>

<template>
  <!-- 星图是 canvas，键盘/读屏进不去。它**不是**唯一入口：同一批页面在「页面」视图
       是一张可排序、可键盘操作的表格，所以这里给一个 role=img + 说明即可，
       不做伪造的键盘导航（那只会做出一个半残的替身）。 -->
  <div ref="el" class="g3d" role="img" :aria-label="`站点星图：${(nodes || []).length} 个页面节点、${(links || []).length} 条站内链接。逐页清单与键盘操作见「页面」视图。`"></div>
</template>

<style scoped>
.g3d { position: absolute; inset: 0; cursor: grab; }
.g3d:active { cursor: grabbing; }
</style>
