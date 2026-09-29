<script setup>
/**
 * Atlas — 全站星图（W2：Canvas 2D 星系布局）
 *
 * 数据源 /<host>/recon/atlas.json（vite publicDir 直连引擎产物 workspace/）
 * 布局 = BFS 深度同心环（星系旋臂感）+ 缓慢整体旋转 + 个体漂浮
 * 节点 = 类型色 + 辉光；边 = 低透明青色曲线；hover = 放大 + 缩略图卡
 */
import { onMounted, onBeforeUnmount, ref, computed } from 'vue';

const TYPE_COLOR = {
  marketing: '#22D3EE', pricing: '#F59E0B', doc: '#7B8CA6',
  listing: '#8B5CF6', auth: '#F87171', legal: '#4B5563',
};
const TYPE_CN = {
  marketing: '营销页', pricing: '定价页', doc: '文档',
  listing: '列表页', auth: '登录/控制台', legal: '法务',
};

const host = ref('apify.com');
const atlas = ref(null);
const hud = computed(() => atlas.value?.meta ?? { pages: 0, edges: 0 });
const hover = ref(null);
const loading = ref(true);
const errMsg = ref('');

const canvasRef = ref(null);
let ctx, W, H, DPR, raf, t0 = performance.now();
let nodes = [], edges = [], starDust = [];
let mouseX = -1, mouseY = -1;

async function load() {
  loading.value = true; errMsg.value = '';
  try {
    const res = await fetch(`/${host.value}/recon/atlas.json`);
    if (!res.ok) throw new Error(`atlas.json ${res.status}`);
    atlas.value = await res.json();
    buildScene();
  } catch (e) { errMsg.value = String(e); }
  loading.value = false;
}

function buildScene() {
  const a = atlas.value;
  // 同心环布局：depth 0 → 中心恒星，1 → 内环，≥2 → 外环（sitemap 补充页与深层同环）
  const byRing = {};
  for (const n of a.nodes) {
    n.ringIdx = n.depth === 0 ? 0 : n.depth === 1 ? 1 : 2;
    (byRing[n.ringIdx] ??= []).push(n);
  }
  nodes = [];
  for (const [ringStr, list] of Object.entries(byRing)) {
    const ringIdx = Number(ringStr);
    list.forEach((n, i) => {
      const angle = ringIdx === 0 ? 0 : (i / list.length) * Math.PI * 2 + ringIdx * 0.5;
      const jitter = ringIdx === 0 ? 0 : (Math.sin(i * 7.3 + ringIdx) * 18);
      nodes.push({
        ...n,
        ring: ringIdx,
        angle, jitter,
        r: ringIdx === 0 ? 10 : Math.max(4, 8 - ringIdx * 1.6) + (n.type === 'listing' ? 1.5 : 0),
        color: TYPE_COLOR[n.type] ?? '#22D3EE',
        x: 0, y: 0, phase: Math.random() * Math.PI * 2,
      });
    });
  }
  const idx = Object.fromEntries(nodes.map(n => [n.id, n]));
  // 边采样：每源节点最多 8 条，防止 1490 条糊成毛线球
  const byFrom = {};
  for (const e of a.edges) (byFrom[e.from] ??= []).push(e.to);
  edges = [];
  for (const [from, tos] of Object.entries(byFrom)) {
    for (const to of tos.slice(0, 8)) {
      const f = idx[from], t = idx[to];
      if (f && t && f !== t) edges.push([f, t]);
    }
  }
  // 星尘背景
  starDust = Array.from({ length: 900 }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 1.1 + 0.2,
    a: Math.random() * 0.5 + 0.1,
    tw: Math.random() * Math.PI * 2,
  }));
}

function frame(now) {
  const t = (now - t0) / 1000;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.36;      // 最大环半径基准
  const rot = t * 0.02;                  // 整体极慢旋转
  ctx.clearRect(0, 0, W, H);

  // 星尘
  for (const s of starDust) {
    const a = s.a * (0.6 + 0.4 * Math.sin(t * 0.7 + s.tw));
    ctx.globalAlpha = a;
    ctx.fillStyle = '#9FB4D8';
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * H, s.r, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 节点位置
  for (const n of nodes) {
    const ringR = [0, 0.42, 1.0][n.ring] * R;
    const ang = n.angle + rot + n.phase * 0.001;
    const bob = Math.sin(t * 0.8 + n.phase) * 3;
    n.sx = cx + Math.cos(ang) * ringR + n.jitter;
    n.sy = cy + Math.sin(ang) * ringR * 0.62 + bob;   // 椭圆压扁 → 星系盘面感
  }

  // 边
  ctx.lineWidth = 1;
  for (const [f, to] of edges) {
    const mx = (f.sx + to.sx) / 2 + (to.sy - f.sy) * 0.08;
    const my = (f.sy + to.sy) / 2 - (to.sx - f.sx) * 0.08;
    ctx.strokeStyle = 'rgba(34, 211, 238, 0.07)';
    ctx.beginPath();
    ctx.moveTo(f.sx, f.sy);
    ctx.quadraticCurveTo(mx, my, to.sx, to.sy);
    ctx.stroke();
  }

  // 节点（辉光）
  hover.value = null;
  for (const n of nodes) {
    const isHover = Math.hypot(mouseX - n.sx, mouseY - n.sy) < n.r + 9;
    if (isHover) hover.value = n;
    const r = n.r * (isHover ? 1.7 : 1) * (1 + 0.06 * Math.sin(t * 2 + n.phase));
    ctx.save();
    ctx.shadowColor = n.color;
    ctx.shadowBlur = isHover ? 26 : 12;
    ctx.fillStyle = n.color;
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r, 0, 7);
    ctx.fill();
    if (n.depth === 0) {   // 根节点恒星环
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r + 6 + Math.sin(t * 1.4) * 2, 0, 7);
      ctx.stroke();
    }
    ctx.restore();
  }
  raf = requestAnimationFrame(frame);
}

function onMove(e) { const r = canvasRef.value.getBoundingClientRect(); mouseX = e.clientX - r.left; mouseY = e.clientY - r.top; }

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvasRef.value.width = W * DPR; canvasRef.value.height = H * DPR;
  canvasRef.value.style.width = W + 'px'; canvasRef.value.style.height = H + 'px';
  ctx = canvasRef.value.getContext('2d');
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}

onMounted(() => {
  resize();
  window.addEventListener('resize', resize);
  window.addEventListener('mousemove', onMove);
  load();
  raf = requestAnimationFrame(frame);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  window.removeEventListener('resize', resize);
  window.removeEventListener('mousemove', onMove);
});
</script>

<template>
  <canvas ref="canvasRef"></canvas>

  <!-- HUD -->
  <div class="hud">
    <div class="brand">HEIMDALL <span>Site Atlas</span></div>
    <div class="stats" v-if="atlas">
      <div class="stat"><b>{{ hud.pages }}</b><i>pages</i></div>
      <div class="stat"><b>{{ hud.edges }}</b><i>edges</i></div>
      <div class="stat"><b>{{ atlas.origin.replace(/^https?:\/\//, '') }}</b><i>origin</i></div>
    </div>
  </div>

  <!-- 节点信息卡 -->
  <div class="card" v-if="hover" :style="{ left: hover.sx + 18 + 'px', top: hover.sy - 30 + 'px' }">
    <img :src="`/${host}/recon/thumbs/${hover.id}.png`" alt="" />
    <div class="meta">
      <div class="type" :style="{ color: hover.color }">{{ TYPE_CN[hover.type] ?? hover.type }}</div>
      <div class="path">{{ hover.path }}</div>
      <div class="title">{{ hover.title.slice(0, 60) }}</div>
    </div>
  </div>

  <!-- 顶部输入（引擎接口 W2.5 接入，当前演示模式） -->
  <div class="seek">
    <input v-model="host" placeholder="apify.com" spellcheck="false" />
    <button @click="load">侦察</button>
  </div>

  <div class="loading" v-if="loading">侦察中 …</div>
  <div class="loading" v-if="errMsg" style="color: var(--red)">加载失败：{{ errMsg }} — 先跑 node src/crawler/recon.mjs</div>
</template>

<style scoped>
canvas { position: fixed; inset: 0; display: block; }
.hud { position: fixed; left: 28px; top: 24px; pointer-events: none; }
.brand { font-family: var(--font-num); font-size: 22px; letter-spacing: .28em; color: var(--text); text-shadow: 0 0 18px rgba(34,211,238,.5); }
.brand span { color: var(--cyan); font-size: 13px; letter-spacing: .2em; margin-left: 10px; }
.stats { display: flex; gap: 26px; margin-top: 16px; }
.stat b { display: block; font-family: var(--font-num); font-size: 24px; color: var(--cyan); text-shadow: 0 0 12px rgba(34,211,238,.6); }
.stat i { font-style: normal; font-size: 11px; color: var(--text-dim); letter-spacing: .12em; }
.card { position: fixed; width: 300px; background: rgba(26,31,46,.92); border: 1px solid rgba(34,211,238,.35); border-radius: 10px; overflow: hidden; pointer-events: none; box-shadow: 0 0 30px rgba(34,211,238,.15); backdrop-filter: blur(6px); }
.card img { width: 100%; display: block; }
.card .meta { padding: 10px 12px 12px; }
.card .type { font-size: 11px; letter-spacing: .2em; margin-bottom: 4px; }
.card .path { font-family: monospace; font-size: 12px; color: var(--cyan); }
.card .title { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.seek { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); display: flex; gap: 0; }
.seek input { width: 300px; padding: 10px 16px; background: rgba(26,31,46,.8); border: 1px solid rgba(34,211,238,.4); border-right: 0; color: var(--text); font-family: monospace; outline: none; border-radius: 8px 0 0 8px; }
.seek button { padding: 10px 22px; background: linear-gradient(180deg, rgba(34,211,238,.25), rgba(34,211,238,.1)); border: 1px solid var(--cyan); color: var(--cyan); cursor: pointer; letter-spacing: .2em; border-radius: 0 8px 8px 0; }
.seek button:hover { box-shadow: 0 0 18px rgba(34,211,238,.5); }
.loading { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); color: var(--text-dim); letter-spacing: .3em; font-size: 13px; }
</style>
