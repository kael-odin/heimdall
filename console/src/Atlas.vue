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
const REDUCED = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// ---------- 缩略图图集（星球贴图，LOD：hover/大节点才渲染贴图） ----------
const thumbCache = new Map();   // id -> ImageBitmap|null
async function preloadThumbs(hostName, list) {
  await Promise.all(list.map(n => new Promise(res => {
    if (thumbCache.has(n.id)) return res();
    const img = new Image();
    img.onload = () => { thumbCache.set(n.id, img); res(); };
    img.onerror = () => { thumbCache.set(n.id, null); res(); };
    img.src = `/${hostName}/recon/thumbs/${n.id}.png`;
  })));
}

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
  introUntil = nowS() + 0.1;
  hudOrigin.value = (a.origin ?? '').replace(/^https?:\/\//, '');
  preloadThumbs(host.value, a.nodes);
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
  introUntil = nowS();
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
    forge.value = { taskId: null, pageName, url: node.url, stages: { capture: 'idle', build: 'idle', shot: 'idle', diff: 'idle', fixup: 'idle', harvest: 'idle' }, score: null, done: false, failed: false, intel: null, rounds: [], skipReason: null };
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
          else if (ev.kind === 'fixup-round') f.rounds.push(ev);
          else if (ev.kind === 'fixup-skip') f.skipReason = `剩余差异 ${(ev.staticShare * 100).toFixed(1)}% 为动画噪声，AI 校准豁免`;
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
let introUntil = 0;   // 入场运镜截止时刻（s）；buildStatic/live 启动时设置
function frame(now) {
  const t = (now - t0) / 1000;
  const cx = W / 2, cy = H / 2;
  let R = Math.min(W, H) * 0.36;
  // 入场运镜：0-2.4s 相机由奇点拉出（zoom 3.2→1，ease-out），伴随一次全屏辉光
  const intro = REDUCED ? 1 : Math.min(1, Math.max(0, (t - introUntil) < 0 ? 1 : 0));
  const it = REDUCED ? 1 : Math.min(1, Math.max(0, (t - introUntil + 2.4) / 2.4));
  if (!REDUCED && t - introUntil < 2.4) {
    const ease = 1 - Math.pow(1 - it, 3);
    R *= 3.2 - 2.2 * ease;
    // 爆发辉光（前 0.8s 白青色全屏渐晕）
    if (it < 0.35) {
      const flash = 1 - it / 0.35;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
      g.addColorStop(0, `rgba(180, 240, 255, ${0.32 * flash})`);
      g.addColorStop(1, 'rgba(34, 211, 238, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
  }
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

  // 盘面光照：中心辐射冷光（星系核球）+ 倾斜椭圆银河带
  const coreR = R * 1.15;
  if (!REDUCED) {
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, 'rgba(34, 211, 238, 0.055)');
    core.addColorStop(0.55, 'rgba(34, 211, 238, 0.018)');
    core.addColorStop(1, 'rgba(34, 211, 238, 0)');
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(cx, cy, coreR, coreR * 0.62, 0, 0, 7);
    ctx.fill();
    // 银河带（与盘面同倾角的模糊亮带）
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, 0.35);
    ctx.rotate(0.12);
    const band = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.5);
    band.addColorStop(0, 'rgba(148, 163, 216, 0.03)');
    band.addColorStop(0.7, 'rgba(139, 92, 246, 0.02)');
    band.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = band;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.5, 0, 7);
    ctx.fill();
    ctx.restore();
  }

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
    const nearness = 1 - Math.min(1, (Math.max(f.ring, to.ring)) / 3);
    const a = (bornAt ? Math.min(1, Math.max(0, (t - bornAt) / 0.5)) : 1) * (0.04 + 0.05 * nearness);
    if (a <= 0.005) continue;
    const mx = (f.sx + to.sx) / 2 + (to.sy - f.sy) * 0.08;
    const my = (f.sy + to.sy) / 2 - (to.sx - f.sx) * 0.08;
    ctx.strokeStyle = `rgba(34, 211, 238, ${a})`;
    ctx.beginPath();
    ctx.moveTo(f.sx, f.sy);
    ctx.quadraticCurveTo(mx, my, to.sx, to.sy);
    ctx.stroke();
  }

  // 节点（LOD：根节点/hover 恒星贴缩略图球面，普通节点纯辉光点）
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
    ctx.shadowBlur = 0;
    const wantThumb = (n.hover || n.ring === 0 || n.forgeState === 'done') && r >= 7;
    const img = thumbCache.get(n.id);
    if (wantThumb && img) {
      // 球面贴图：圆形裁剪 + 图片 cover + 中心亮/边缘暗的球面光
      ctx.save();
      ctx.globalAlpha = Math.min(1, n.age * 1.4);
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r - 1, 0, 7);
      ctx.clip();
      const ir = (r - 1) * 2;
      ctx.drawImage(img, n.sx - (r - 1), n.sy - (r - 1), ir, ir * 0.625);
      const shade = ctx.createRadialGradient(n.sx - r * 0.3, n.sy - r * 0.35, r * 0.2, n.sx, n.sy, r);
      shade.addColorStop(0, 'rgba(255,255,255,0.14)');
      shade.addColorStop(0.6, 'rgba(0,0,0,0.05)');
      shade.addColorStop(1, 'rgba(5, 6, 10, 0.72)');
      ctx.fillStyle = shade;
      ctx.beginPath();
      ctx.arc(n.sx, n.sy, r - 1, 0, 7);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = Math.min(1, n.age * 1.4);
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
    <div class="brand">HEIMDALL<span class="brand-sub">SITE ATLAS · 深空观测站</span></div>
    <div class="hud-rule"></div>
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

  <div class="seek hud-panel">
    <span class="seek-caret">▾</span>
    <input v-model="host" placeholder="输入目标域名 · apify.com" spellcheck="false" @keyup.enter="startRecon" />
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
      <div class="stage" v-for="(label, key, i) in { capture: '捕获骨架', build: '注入皮肤', shot: '渲染校准', fixup: 'AI 校准', diff: '像素定谳', harvest: '情报入库' }" :key="key"
           :class="forge.stages[key]">
        <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>{{ label }}<span class="dot"></span>
      </div>
    </div>

    <div class="verdict hud-panel" v-if="forge.score">
      <div class="verdict-label">FIDELITY VERDICT · 还原度判定</div>
      <div class="score-num" :class="forge.score.grade === 'A' ? 'ok' : forge.score.grade === 'B' ? 'mid' : 'bad'">
        {{ forge.score.total }}<small>%</small>
      </div>
      <div class="score-break">
        <span>像素 {{ (forge.score.pixel * 100).toFixed(1) }}%</span>
        <span>结构 {{ (forge.score.dom?.dom * 100).toFixed(1) }}%</span>
        <span v-if="forge.score.data">数据 {{ (forge.score.data.data * 100).toFixed(1) }}%</span>
        <span class="grade">评级 {{ forge.score.grade }}</span>
      </div>
      <div class="refine" v-if="forge.score.breakdown">
        <div class="refine-bar"><i :style="{ width: (forge.score.breakdown.refinable * 100) + '%' }"></i></div>
        <span>可修静态差异 {{ (forge.score.breakdown.refinable * 100).toFixed(0) }}% · 动画噪声 {{ (forge.score.breakdown.dynamicShare * 100).toFixed(0) }}%</span>
      </div>
    </div>
    <div class="verdict pending hud-panel" v-else-if="!forge.done"><span class="scan"></span>锻造中 …</div>
    <div class="fixup-curve" v-if="forge.skipReason">
      <div class="curve-title">AI 校准</div>
      <div class="curve-row">{{ forge.skipReason }}</div>
    </div>
    <div class="fixup-curve" v-if="forge.rounds.length">
      <div class="curve-title">AI 校准曲线</div>
      <div class="curve-row" v-for="r in forge.rounds" :key="r.round">
        校准 {{ r.round }}：{{ r.before }}% → {{ r.after }}% <b :class="r.kept ? 'kept' : 'rolled'">{{ r.kept ? '保留' : '回滚' }}</b>
      </div>
    </div>
    <div class="intel-bar" v-if="forge.intel">情报包：标题 {{ forge.intel.headings }} · 价格 {{ forge.intel.prices }} · CTA {{ forge.intel.cta }} · 链接 {{ forge.intel.links }}</div>

    <div class="screens" v-if="forge.done">
      <div class="pane">
        <div class="pane-label">SOURCE · 原站</div>
        <img :src="`/${host}/pages/${forge.pageName}/shot-src.png`" alt="source" />
      </div>
      <div class="pane">
        <div class="pane-label">MIRROR · 镜像</div>
        <img :src="`/${host}/pages/${forge.pageName}/shot-clone.png`" alt="clone" />
      </div>
    </div>
    <iframe v-if="forge.done" :key="forge.taskId" class="live-clone" :src="`/${host}/pages/${forge.pageName}/clone/index.html`" title="living clone"></iframe>
  </div>

  <div class="toast" v-if="errMsg">{{ errMsg }}</div>
</template>

<style scoped>
canvas { position: fixed; inset: 0; display: block; }
.hud { position: fixed; left: 28px; top: 24px; pointer-events: none; z-index: 4; }
.brand { font-family: var(--font-num); font-size: 24px; font-weight: 700; letter-spacing: .3em; color: var(--text); text-shadow: 0 0 24px rgba(34,211,238,.55); }
.brand-sub { display: block; font-size: 10px; letter-spacing: .34em; color: var(--text-faint); margin-top: 6px; font-family: var(--font-mono); text-shadow: none; }
.hud-rule { width: 210px; height: 1px; margin: 12px 0 14px; background: linear-gradient(90deg, var(--cyan-dim), transparent); position: relative; }
.hud-rule::after { content: ''; position: absolute; left: 0; top: -2px; width: 5px; height: 5px; background: var(--cyan); box-shadow: 0 0 8px var(--cyan); }
.stats { display: flex; gap: 30px; }
.stat b { display: block; font-family: var(--font-num); font-size: 26px; font-weight: 700; color: var(--cyan); text-shadow: 0 0 14px rgba(34,211,238,.5); font-variant-numeric: tabular-nums; }
.stat i { font-style: normal; font-size: 10px; color: var(--text-faint); letter-spacing: .22em; font-family: var(--font-mono); }
.status { margin-top: 16px; display: inline-block; padding: 5px 12px; border: 1px solid var(--cyan-line); font-size: 12px; letter-spacing: .3em; color: var(--text-dim); font-family: var(--font-mono); background: rgba(11,11,16,.6); }
.status.live { color: var(--amber); border-color: rgba(245,158,11,.4); animation: hud-pulse 1.2s ease-in-out infinite; }
.card { position: fixed; width: 300px; z-index: 6; pointer-events: none; background: rgba(11,11,16,.92); border: 1px solid var(--cyan-dim); border-radius: var(--r); overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,.6), 0 0 24px rgba(34,211,238,.12); backdrop-filter: blur(8px); }
.card img { width: 100%; display: block; border-bottom: 1px solid var(--cyan-line); }
.card .meta { padding: 10px 12px 12px; }
.card .type { font-size: 10px; letter-spacing: .24em; margin-bottom: 5px; font-family: var(--font-mono); }
.card .path { font-family: var(--font-mono); font-size: 13px; color: var(--cyan); }
.card .title { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.5; }
.seek { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; z-index: 5; background: rgba(11,11,16,.85); }
.seek-caret { display: flex; align-items: center; padding: 0 4px 0 12px; color: var(--cyan-dim); font-size: 12px; }
.seek input { width: 320px; padding: 11px 14px; background: transparent; border: 0; color: var(--text); font-family: var(--font-mono); font-size: 14px; letter-spacing: .04em; outline: none; }
.seek input::placeholder { color: var(--text-faint); }
.seek button { padding: 0 24px; background: linear-gradient(180deg, rgba(34,211,238,.18), rgba(34,211,238,.05)); border: 0; border-left: 1px solid var(--cyan-line); color: var(--cyan); cursor: pointer; letter-spacing: .34em; font-size: 13px; font-family: var(--font-cn); transition: background var(--dur), box-shadow var(--dur); }
.seek button:hover { background: rgba(34,211,238,.14); box-shadow: 0 0 20px rgba(34,211,238,.25) inset; }
.toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); color: var(--red); letter-spacing: .08em; font-size: 13px; z-index: 20; }
/* 施工舱 */
.dock { position: fixed; right: 0; top: 0; bottom: 0; width: 32%; min-width: 400px; background: linear-gradient(180deg, rgba(20,20,26,.97), rgba(11,11,16,.98)); border-left: 1px solid var(--cyan-line); backdrop-filter: blur(14px); padding: 20px 20px 28px; overflow-y: auto; z-index: 10; }
.dock::before { content: ''; position: sticky; top: 0; display: block; height: 2px; margin: -20px -20px 18px; background: linear-gradient(90deg, var(--cyan), rgba(34,211,238,.05)); opacity: .7; }
.dock-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.dock-title { font-family: var(--font-num); font-size: 19px; font-weight: 700; color: var(--text); letter-spacing: .06em; }
.dock-url { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); margin-top: 5px; word-break: break-all; }
.dock-headbtns { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.dock-all { background: rgba(245,158,11,.08); border: 1px solid rgba(245,158,11,.45); color: var(--amber); padding: 7px 14px; border-radius: var(--r); cursor: pointer; font-size: 12px; letter-spacing: .14em; transition: all var(--dur); }
.dock-all:hover { background: rgba(245,158,11,.16); box-shadow: 0 0 16px rgba(245,158,11,.3); }
.dock-close { background: none; border: 1px solid rgba(148,163,184,.3); color: var(--text-dim); width: 30px; height: 30px; border-radius: var(--r); cursor: pointer; transition: all var(--dur); }
.dock-close:hover { color: var(--text); border-color: var(--cyan-dim); }
/* 阶段步进器 */
.stages { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 18px; }
.stage { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border: 1px solid rgba(148,163,184,.16); border-radius: var(--r); font-size: 12.5px; color: var(--text-faint); background: rgba(30,30,35,.5); transition: all var(--dur); }
.stage .idx { font-family: var(--font-mono); font-size: 10px; color: var(--text-faint); letter-spacing: .08em; }
.stage .dot { margin-left: auto; width: 6px; height: 6px; border-radius: 50%; background: #3A4356; transition: all var(--dur); }
.stage.running { border-color: rgba(245,158,11,.55); color: var(--amber); background: rgba(245,158,11,.05); }
.stage.running .dot { background: var(--amber); box-shadow: 0 0 10px var(--amber); animation: hud-pulse .9s ease-in-out infinite; }
.stage.done { border-color: rgba(52,211,153,.35); color: var(--text-dim); }
.stage.done .dot { background: var(--green); box-shadow: 0 0 8px rgba(52,211,153,.7); }
.stage.done .idx { color: var(--green); }
.stage.skipped { opacity: .5; }
/* 判定区 */
.verdict { margin-top: 16px; padding: 16px 16px 14px; text-align: center; }
.verdict-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: .3em; color: var(--text-faint); margin-bottom: 10px; }
.verdict.pending { display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--text-dim); letter-spacing: .3em; font-size: 13px; padding: 22px; }
.scan { width: 8px; height: 8px; border: 1px solid var(--amber); border-radius: 50%; animation: hud-pulse 1s ease-in-out infinite; }
.score-num { font-family: var(--font-num); font-size: 54px; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
.score-num small { font-size: 22px; color: var(--text-faint); font-weight: 500; }
.score-num.ok { color: var(--green); text-shadow: 0 0 32px rgba(52,211,153,.5); }
.score-num.mid { color: var(--amber); text-shadow: 0 0 32px rgba(245,158,11,.45); }
.score-num.bad { color: var(--red); text-shadow: 0 0 32px rgba(239,68,68,.4); }
.score-break { display: flex; justify-content: center; gap: 18px; margin-top: 12px; font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); }
.score-break .grade { color: var(--cyan); }
.refine { margin-top: 12px; }
.refine-bar { height: 3px; background: #26262c; border-radius: 2px; overflow: hidden; }
.refine-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--green), var(--cyan)); box-shadow: 0 0 8px rgba(34,211,238,.5); transition: width .6s ease; }
.refine span { display: block; margin-top: 6px; font-size: 10px; letter-spacing: .12em; color: var(--text-faint); font-family: var(--font-mono); }
/* AI 校准 & 情报 */
.fixup-curve { margin-top: 12px; padding: 11px 13px; border: 1px solid rgba(167,139,250,.35); border-radius: var(--r); background: rgba(167,139,250,.04); }
.curve-title { font-family: var(--font-mono); font-size: 10px; letter-spacing: .26em; color: var(--violet); margin-bottom: 7px; }
.curve-row { font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); display: flex; gap: 8px; align-items: center; line-height: 1.8; }
.curve-row b.kept { color: var(--green); }
.curve-row b.rolled { color: var(--red); }
.intel-bar { margin-top: 12px; padding: 10px 13px; border: 1px dashed rgba(167,139,250,.45); border-radius: var(--r); color: var(--violet); font-size: 12px; letter-spacing: .03em; background: rgba(167,139,250,.04); }
/* 双联与活体 */
.screens { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 16px; }
.pane img { width: 100%; border: 1px solid rgba(148,163,184,.22); border-radius: var(--r); display: block; }
.pane-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: .22em; color: var(--text-faint); margin-bottom: 6px; }
.live-clone { width: 100%; height: 44vh; margin-top: 14px; border: 1px solid var(--cyan-line); border-radius: var(--r); background: #fff; }
</style>
