<script setup>
/**
 * Atlas — 全站星图
 *
 * 静态模式：读已有 /<host>/recon/atlas.json（上次侦察结果）
 * live 模式：POST /api/recon → SSE 事件流 → 节点逐个点亮生长（分镜 L1 幕）
 *
 * 布局 = 深度同心环（黄金角均匀分布，增量稳定）+ 缓慢整体旋转 + 个体漂浮
 * 出生动画 = 奇点飞入 + easeOutBack 缩放 + 辉光爆发；边在两端点亮后浮现
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
const GOLDEN = 2.399963229728653;
// 引擎 API 直连（vite proxy 会缓冲实时 SSE；引擎侧 CORS 已开放）
const API = 'http://127.0.0.1:8900';

const host = ref('apify.com');
const atlas = ref(null);
const live = ref(false);
const statusText = ref('');
const errMsg = ref('');
const hover = ref(null);
const selected = ref(null);          // 施工舱当前页
const forge = ref(null);             // {taskId,pageName,url,stages:{},score,done,failed}
let esForge = null;
const hudPages = ref(0);
const hudEdges = ref(0);
const hudOrigin = ref('');

const canvasRef = ref(null);
let ctx, W, H, DPR, raf, t0 = performance.now();
let nodes = [], edges = [], starDust = [];
let mouseX = -1, mouseY = -1;
const urlNode = new Map();
let pendingEdges = [];
let es = null;

const nowS = () => (performance.now() - t0) / 1000;

function normalizeUrl(v) {
  let s = v.trim();
  if (!s) return '';
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  try { return new URL(s).origin; } catch { return ''; }
}

// ---------- 场景 ----------
function makeNode(ev, ringIdx, i, bornAt) {
  return {
    ...ev,
    ring: ringIdx,
    angle: ringIdx === 0 ? 0 : i * GOLDEN + ringIdx * 0.7,
    jitter: ringIdx === 0 ? 0 : Math.sin(i * 7.3 + ringIdx) * 18,
    r: ringIdx === 0 ? 10 : Math.max(4, 8 - ringIdx * 1.6) + (ev.type === 'listing' ? 1.5 : 0),
    color: TYPE_COLOR[ev.type] ?? '#22D3EE',
    sx: 0, sy: 0, phase: Math.random() * Math.PI * 2,
    bornAt,
  };
}

function buildStatic(a) {
  atlas.value = a;
  hudOrigin.value = (a.origin ?? '').replace(/^https?:\/\//, '');
  nodes = []; edges = []; urlNode.clear(); pendingEdges = [];
  const byRing = {};
  for (const n of a.nodes) {
    n.ringIdx = n.depth === 0 ? 0 : n.depth === 1 ? 1 : 2;
    (byRing[n.ringIdx] ??= []).push(n);
  }
  for (const [ringStr, list] of Object.entries(byRing)) {
    list.forEach((n, i) => nodes.push(makeNode(n, Number(ringStr), i, 0)));
  }
  const idx = Object.fromEntries(nodes.map(n => [n.id, n]));
  const byFrom = {};
  for (const e of a.edges) (byFrom[e.from] ??= []).push(e.to);
  for (const [from, tos] of Object.entries(byFrom)) {
    for (const to of tos.slice(0, 8)) {
      const f = idx[from], t = idx[to];
      if (f && t && f !== t) edges.push([f, t, 0]);
    }
  }
  starDust = makeDust();
}

function makeDust() {
  return Array.from({ length: 900 }, () => ({
    x: Math.random(), y: Math.random(),
    r: Math.random() * 1.1 + 0.2,
    a: Math.random() * 0.5 + 0.1,
    tw: Math.random() * Math.PI * 2,
  }));
}

// ---------- live ----------
function startRecon() {
  const url = normalizeUrl(host.value);
  if (!url) { errMsg.value = '网址无效'; return; }
  errMsg.value = ''; live.value = true; statusText.value = '光点出发';
  hudOrigin.value = url.replace(/^https?:\/\//, '');
  nodes = []; edges = []; urlNode.clear(); pendingEdges = []; atlas.value = null;
  starDust = makeDust();
  host.value = url.replace(/^https?:\/\//, '');

  fetch(`${API}/api/recon`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, maxPages: 30 }) })
    .then(r => r.json())
    .then(({ taskId, error }) => {
      if (error) { errMsg.value = error === 'busy' ? '引擎忙：有任务在跑' : error; live.value = false; return; }
      listen(taskId);
    })
    .catch(e => { errMsg.value = String(e); live.value = false; });
}

function listen(taskId) {
  es = new EventSource(`${API}/api/events?task=${taskId}`);
  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.kind === 'page') {
      const ringIdx = ev.depth === 0 ? 0 : ev.depth === 1 ? 1 : 2;
      const ringCount = nodes.filter(n => n.ring === ringIdx).length;
      nodes.push(makeNode(ev, ringIdx, ringCount, nowS()));
      urlNode.set(ev.url, nodes[nodes.length - 1]);
      statusText.value = '新星点亮';
    } else if (ev.kind === 'edges') {
      pendingEdges.push({ from: ev.from, tos: ev.tos, bornAt: nowS() });
    } else if (ev.kind === 'exit') {
      es.close(); es = null;
      if (ev.status === 'done') finishRecon(taskId);
      else { errMsg.value = '侦察失败'; live.value = false; statusText.value = ''; }
    }
  };
  es.onerror = () => { es?.close(); es = null; };
}

async function finishRecon(taskId) {
  statusText.value = '星图定稿';
  try {
    const a = await (await fetch(`${API}/api/atlas/${taskId}`)).json();
    atlas.value = a;
    hudOrigin.value = (a.origin ?? '').replace(/^https?:\/\//, '');
    // 边换成清洗后的 id 对（节点对象复用，出生动画不重播）
    const byUrl = urlNode;
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    edges = [];
    const byFrom = {};
    for (const e of a.edges) (byFrom[e.from] ??= []).push(e.to);
    for (const [from, tos] of Object.entries(byFrom)) {
      for (const to of tos.slice(0, 8)) {
        const f = byId[from], t = byId[to];
        if (f && t && f !== t) edges.push([f, t, 0]);
      }
    }
    pendingEdges = [];
  } catch {}
  live.value = false;
  setTimeout(() => { statusText.value = ''; }, 2500);
}

// ---------- forge：点选节点 → 单页还原流水线 ----------
function startForge(node) {
  return new Promise((resolve) => {
    if (!node?.url) return resolve();
    selected.value = node;
    const pageName = node.path === '/' ? 'home' : node.path.replace(/^\//, '').replace(/\//g, '-');
    forge.value = { taskId: null, pageName, url: node.url, stages: { capture: 'idle', build: 'idle', shot: 'idle', diff: 'idle', harvest: 'idle' }, score: null, done: false, failed: false, intel: null };
    node.forgeState = 'running';
    statusText.value = '开始造物';
    (async () => {
      try {
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: node.url }) });
        const { taskId, error } = await r.json();
        if (error) { errMsg.value = error === 'busy' ? '造物台忙：有页面在锻造' : error; node.forgeState = 'idle'; return resolve(); }
        forge.value.taskId = taskId;
        esForge = new EventSource(`${API}/api/events?task=${taskId}`);
        esForge.onmessage = (m) => {
          let ev; try { ev = JSON.parse(m.data); } catch { return; }
          const f = forge.value;
          if (!f) return;
          if (ev.kind === 'forge-stage') f.stages[ev.stage] = ev.status;
          else if (ev.kind === 'forge-score') f.score = ev.score;
          else if (ev.kind === 'forge-error') f.failed = true;
          else if (ev.kind === 'exit') {
            f.done = ev.status === 'done';
            if (!f.done) { f.failed = true; node.forgeState = 'failed'; }
            else node.forgeState = 'done';
            statusText.value = f.done ? '恒星点亮' : '造物失败';
            if (f.done) {
              fetch(`/${host.value}/pages/${f.pageName}/intel/intel.json`).then(r => r.ok ? r.json() : null).then(j => { if (j) f.intel = { headings: j.headings?.length ?? 0, prices: j.prices?.length ?? 0, cta: j.cta?.length ?? 0, links: j.links?.length ?? 0 }; }).catch(() => {});
            }
            esForge?.close(); esForge = null;
            setTimeout(() => { if (statusText.value !== '光点出发') statusText.value = ''; }, 2500);
            resolve();
          }
        };
        esForge.onerror = () => { esForge?.close(); esForge = null; resolve(); };
      } catch (e) { errMsg.value = String(e); node.forgeState = 'idle'; resolve(); }
    })();
  });
}

async function forgeAll() {
  const targets = nodes.filter(n => n.ring === 1).slice(0, 6);
  for (const n of targets) await startForge(n);
  statusText.value = '全境锻造完成';
  setTimeout(() => { statusText.value = ''; }, 3000);
}

function onCanvasClick() {
  if (hover.value) startForge(hover.value);
}

// ---------- 渲染 ----------
function frame(now) {
  const t = (now - t0) / 1000;
  const cx = W / 2, cy = H / 2;
  const R = Math.min(W, H) * 0.36;
  const rot = t * 0.02;
  ctx.clearRect(0, 0, W, H);

  for (const s of starDust) {
    ctx.globalAlpha = s.a * (0.6 + 0.4 * Math.sin(t * 0.7 + s.tw));
    ctx.fillStyle = '#9FB4D8';
    ctx.beginPath();
    ctx.arc(s.x * W, s.y * H, s.r, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // 位置（含出生飞入）
  hover.value = null;
  for (const n of nodes) {
    const ringR = [0, 0.42, 1.0][n.ring] * R;
    const ang = n.angle + rot + n.phase * 0.001;
    const bob = Math.sin(t * 0.8 + n.phase) * 3;
    const tx = cx + Math.cos(ang) * ringR + n.jitter;
    const ty = cy + Math.sin(ang) * ringR * 0.62 + bob;
    const age = n.bornAt ? Math.min(1, (t - n.bornAt) / 0.6) : 1;
    const fly = Math.min(1, age * 1.8);
    const ef = 1 - Math.pow(1 - fly, 3);
    n.sx = cx + (tx - cx) * ef;
    n.sy = cy + (ty - cy) * ef;
    n.age = age;
    n.scale = n.bornAt ? (1 + 1.7 * Math.pow(age - 1, 3) + 0.7 * Math.pow(age - 1, 2) * 2.7) : 1; // easeOutBack 近似
    n.scale = Math.max(0.001, n.scale);
    const isHover = Math.hypot(mouseX - n.sx, mouseY - n.sy) < n.r + 9;
    if (isHover) hover.value = n;
    n.hover = isHover;
  }

  // pending 边转正（两端都已点亮）
  for (let i = pendingEdges.length - 1; i >= 0; i--) {
    const pe = pendingEdges[i];
    const f = urlNode.get(pe.from);
    for (const to of pe.tos) {
      const t2 = urlNode.get(to);
      if (f && t2 && f !== t2) edges.push([f, t2, Math.max(pe.bornAt, t2.bornAt ?? 0)]);
    }
    pendingEdges.splice(i, 1);
  }

  // 边
  ctx.lineWidth = 1;
  for (const [f, to, bornAt] of edges) {
    const a = bornAt ? Math.min(1, Math.max(0, (t - bornAt) / 0.5)) * 0.07 : 0.07;
    if (a <= 0.005) continue;
    const mx = (f.sx + to.sx) / 2 + (to.sy - f.sy) * 0.08;
    const my = (f.sy + to.sy) / 2 - (to.sx - f.sx) * 0.08;
    ctx.strokeStyle = `rgba(34, 211, 238, ${a})`;
    ctx.beginPath();
    ctx.moveTo(f.sx, f.sy);
    ctx.quadraticCurveTo(mx, my, to.sx, to.sy);
    ctx.stroke();
  }

  // 节点
  for (const n of nodes) {
    const r = n.r * (n.hover ? 1.7 : 1) * (1 + 0.06 * Math.sin(t * 2 + n.phase)) * n.scale;
    if (r < 0.2) continue;
    ctx.save();
    n.color2 = n.forgeState === 'running' ? '#F59E0B' : n.color;
    ctx.shadowColor = n.color2;
    ctx.shadowBlur = (n.hover ? 26 : 12) + (n.age < 1 ? (1 - n.age) * 34 : 0) + (n.forgeState === 'running' ? 14 + 8 * Math.sin(t * 5) : 0);
    ctx.fillStyle = n.color2;
    ctx.globalAlpha = Math.min(1, n.age * 1.4);
    ctx.beginPath();
    ctx.arc(n.sx, n.sy, r, 0, 7);
    ctx.fill();
    if (n.ring === 0 || n.forgeState === 'done') {   // 根节点 / 锻造完成的恒星环
      ctx.strokeStyle = n.forgeState === 'done' ? 'rgba(245,158,11,0.85)' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = n.forgeState === 'done' ? 2 : 1;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r + 6 + Math.sin(t * 1.4) * 2, 0, 7);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  if (nodes.length !== hudPages.value) hudPages.value = nodes.length;
  if (edges.length !== hudEdges.value) hudEdges.value = edges.length;
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
  canvasRef.value.addEventListener('click', onCanvasClick);
  // 默认载入上次侦察结果
  fetch('/apify.com/recon/atlas.json').then(r => r.ok ? r.json() : Promise.reject()).then(buildStatic).catch(() => {});
  raf = requestAnimationFrame(frame);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  es?.close(); esForge?.close();
  window.removeEventListener('resize', resize);
  window.removeEventListener('mousemove', onMove);
});
</script>

<template>
  <canvas ref="canvasRef"></canvas>

  <div class="hud">
    <div class="brand">HEIMDALL <span>Site Atlas</span></div>
    <div class="stats">
      <div class="stat"><b>{{ hudPages }}</b><i>pages</i></div>
      <div class="stat"><b>{{ hudEdges }}</b><i>edges</i></div>
      <div class="stat"><b>{{ hudOrigin }}</b><i>origin</i></div>
    </div>
    <div class="status" v-if="statusText" :class="{ live }">{{ statusText }}</div>
  </div>

  <div class="card" v-if="hover" :style="{ left: hover.sx + 18 + 'px', top: hover.sy - 30 + 'px' }">
    <img v-if="!live" :src="`/${host}/recon/thumbs/${hover.id}.png`" alt="" />
    <div class="meta">
      <div class="type" :style="{ color: hover.color }">{{ TYPE_CN[hover.type] ?? hover.type }}</div>
      <div class="path">{{ hover.path }}</div>
      <div class="title">{{ (hover.title || '').slice(0, 60) }}</div>
    </div>
  </div>

  <div class="seek">
    <input v-model="host" placeholder="apify.com" spellcheck="false" @keyup.enter="startRecon" />
    <button @click="startRecon">侦察</button>
  </div>

  <!-- 施工舱 -->
  <div class="dock" v-if="forge">
    <div class="dock-head">
      <div>
        <div class="dock-title">{{ forge.pageName }}</div>
        <div class="dock-url">{{ forge.url }}</div>
      </div>
      <div class="dock-headbtns"><button class="dock-all" @click="forgeAll" title="串行锻造内环 6 页">锻造内环</button><button class="dock-close" @click="forge = null">✕</button></div>
    </div>

    <div class="stages">
      <div class="stage" v-for="(label, key) in { capture: '捕获骨架', build: '注入皮肤', shot: '渲染校准', diff: '像素定谳', harvest: '情报入库' }" :key="key"
           :class="forge.stages[key]">
        <span class="dot"></span>{{ label }}
      </div>
    </div>

    <div class="verdict" v-if="forge.score">
      <div class="score-num" :class="forge.score.grade === 'A' ? 'ok' : forge.score.grade === 'B' ? 'mid' : 'bad'">
        {{ forge.score.total }}<small>%</small>
      </div>
      <div class="score-break">
        <span>像素 {{ (forge.score.pixel * 100).toFixed(1) }}%</span>
        <span>结构 {{ (forge.score.dom?.dom * 100).toFixed(1) }}%</span>
        <span class="grade">评级 {{ forge.score.grade }}</span>
      </div>
    </div>
    <div class="verdict pending" v-else-if="!forge.done">锻造中 …</div>
    <div class="intel-bar" v-if="forge.intel">情报包：标题 {{ forge.intel.headings }} · 价格 {{ forge.intel.prices }} · CTA {{ forge.intel.cta }} · 链接 {{ forge.intel.links }}</div>

    <div class="screens" v-if="forge.done">
      <div class="pane">
        <div class="pane-label">原站</div>
        <img :src="`/${host}/pages/${forge.pageName}/shot-src.png`" alt="source" />
      </div>
      <div class="pane">
        <div class="pane-label">镜像</div>
        <img :src="`/${host}/pages/${forge.pageName}/shot-clone.png`" alt="clone" />
      </div>
    </div>
    <iframe v-if="forge.done" :key="forge.taskId" class="live-clone" :src="`/${host}/pages/${forge.pageName}/clone/index.html`" title="living clone"></iframe>
  </div>

  <div class="toast" v-if="errMsg">{{ errMsg }}</div>
</template>

<style scoped>
canvas { position: fixed; inset: 0; display: block; }
.hud { position: fixed; left: 28px; top: 24px; pointer-events: none; }
.brand { font-family: var(--font-num); font-size: 22px; letter-spacing: .28em; color: var(--text); text-shadow: 0 0 18px rgba(34,211,238,.5); }
.brand span { color: var(--cyan); font-size: 13px; letter-spacing: .2em; margin-left: 10px; }
.stats { display: flex; gap: 26px; margin-top: 16px; }
.stat b { display: block; font-family: var(--font-num); font-size: 24px; color: var(--cyan); text-shadow: 0 0 12px rgba(34,211,238,.6); }
.stat i { font-style: normal; font-size: 11px; color: var(--text-dim); letter-spacing: .12em; }
.status { margin-top: 14px; font-size: 12px; letter-spacing: .3em; color: var(--text-dim); }
.status.live { color: var(--amber); text-shadow: 0 0 12px rgba(245,158,11,.6); animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .5; } }
.card { position: fixed; width: 300px; background: rgba(26,31,46,.92); border: 1px solid rgba(34,211,238,.35); border-radius: 10px; overflow: hidden; pointer-events: none; box-shadow: 0 0 30px rgba(34,211,238,.15); backdrop-filter: blur(6px); z-index: 5; }
.card img { width: 100%; display: block; }
.card .meta { padding: 10px 12px 12px; }
.card .type { font-size: 11px; letter-spacing: .2em; margin-bottom: 4px; }
.card .path { font-family: monospace; font-size: 12px; color: var(--cyan); }
.card .title { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
.seek { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); display: flex; }
.seek input { width: 300px; padding: 10px 16px; background: rgba(26,31,46,.8); border: 1px solid rgba(34,211,238,.4); border-right: 0; color: var(--text); font-family: monospace; outline: none; border-radius: 8px 0 0 8px; }
.seek button { padding: 10px 22px; background: linear-gradient(180deg, rgba(34,211,238,.25), rgba(34,211,238,.1)); border: 1px solid var(--cyan); color: var(--cyan); cursor: pointer; letter-spacing: .2em; border-radius: 0 8px 8px 0; }
.seek button:hover { box-shadow: 0 0 18px rgba(34,211,238,.5); }
.toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); color: var(--red); letter-spacing: .1em; font-size: 13px; }

/* 施工舱 */
.dock { position: fixed; right: 0; top: 0; bottom: 0; width: 30%; min-width: 380px; background: rgba(26,31,46,.94); border-left: 1px solid rgba(34,211,238,.3); backdrop-filter: blur(10px); padding: 22px; overflow-y: auto; z-index: 10; }
.dock-head { display: flex; justify-content: space-between; align-items: flex-start; }
.dock-title { font-family: var(--font-num); font-size: 20px; color: var(--cyan); letter-spacing: .08em; }
.dock-url { font-family: monospace; font-size: 11px; color: var(--text-dim); margin-top: 4px; word-break: break-all; }
.dock-close { background: none; border: 1px solid rgba(138,147,166,.4); color: var(--text-dim); width: 28px; height: 28px; border-radius: 6px; cursor: pointer; }
.dock-close:hover { color: var(--text); border-color: var(--cyan); }
.dock-headbtns { display: flex; gap: 8px; align-items: center; }
.dock-all { background: linear-gradient(180deg, rgba(245,158,11,.25), rgba(245,158,11,.08)); border: 1px solid var(--amber); color: var(--amber); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; letter-spacing: .1em; }
.dock-all:hover { box-shadow: 0 0 14px rgba(245,158,11,.5); }
.intel-bar { margin-top: 12px; padding: 10px 12px; border: 1px dashed rgba(139,92,246,.5); border-radius: 8px; color: #A78BFA; font-size: 12px; letter-spacing: .04em; }
.stages { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 20px; }
.stage { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid rgba(138,147,166,.25); border-radius: 8px; font-size: 13px; color: var(--text-dim); }
.stage .dot { width: 9px; height: 9px; border-radius: 50%; background: #3A4356; }
.stage.running { border-color: rgba(245,158,11,.6); color: var(--amber); }
.stage.running .dot { background: var(--amber); box-shadow: 0 0 10px var(--amber); animation: pulse 1s ease-in-out infinite; }
.stage.done { border-color: rgba(52,211,153,.5); color: var(--green); }
.stage.done .dot { background: var(--green); box-shadow: 0 0 8px var(--green); }
.verdict { margin-top: 18px; text-align: center; padding: 16px; border: 1px solid rgba(34,211,238,.3); border-radius: 10px; }
.verdict.pending { color: var(--text-dim); letter-spacing: .3em; }
.score-num { font-family: var(--font-num); font-size: 46px; }
.score-num small { font-size: 20px; color: var(--text-dim); }
.score-num.ok { color: var(--green); text-shadow: 0 0 24px rgba(52,211,153,.6); }
.score-num.mid { color: var(--amber); text-shadow: 0 0 24px rgba(245,158,11,.6); }
.score-num.bad { color: var(--red); }
.score-break { display: flex; justify-content: center; gap: 16px; margin-top: 8px; font-size: 12px; color: var(--text-dim); }
.score-break .grade { color: var(--cyan); }
.screens { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 18px; }
.pane img { width: 100%; border: 1px solid rgba(138,147,166,.3); border-radius: 6px; display: block; }
.pane-label { font-size: 11px; letter-spacing: .2em; color: var(--text-dim); margin-bottom: 6px; }
.live-clone { width: 100%; height: 46vh; margin-top: 14px; border: 1px solid rgba(34,211,238,.35); border-radius: 8px; background: #fff; }
</style>
