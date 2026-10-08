<script setup>
/**
 * Atlas — 全站星图（3D 力导向，graphify 同款形态）
 *
 * 静态模式：读已有 /<host>/recon/atlas.json（或从站点切换器载入任意已侦察站）
 * live 模式：POST /api/recon → SSE 事件流 → 节点逐个弹入生长
 * 点星球 = 锻造该页；「锻造内环」= 批量并行
 */
import { onMounted, onBeforeUnmount, ref } from 'vue';
import Graph3D from './Graph3D.vue';

const TYPE_COLOR = {
  marketing: '#22D3EE', pricing: '#F59E0B', doc: '#7B8CA6',
  listing: '#8B5CF6', auth: '#F87171', legal: '#4B5563',
};
// 引擎 API 直连（vite proxy 会缓冲实时 SSE；引擎侧 CORS 已开放）
const API = 'http://127.0.0.1:8900';

const host = ref('apify.com');
const atlas = ref(null);
const live = ref(false);
const statusText = ref('');
const errMsg = ref('');
const forge = ref(null);
let esForge = null;
const hudPages = ref(0);
const hudEdges = ref(0);
const hudOrigin = ref('');
const sites = ref([]);          // 已侦察站点清单（/api/sites）
const engine = ref({ ok: false, recon: null, forge: null });   // 引擎状态灯
const autoRotate = ref(true);   // 星图自转开关
const showPanel = ref(true);    // 左侧仪表面板折叠

// 3D 图数据（Graph3D 消费）
const gNodes = ref([]);
const gLinks = ref([]);
const gTick = ref(0);
const bump = () => { gNodes.value = [...nodes]; gLinks.value = [...edges]; gTick.value++; };

let nodes = [], edges = [];
const urlNode = new Map();
let pendingEdges = [];
let es = null;

function normalizeUrl(v) {
  let s = v.trim();
  if (!s) return '';
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  try { return new URL(s).origin; } catch { return ''; }
}

function makeNode(ev, ringIdx) {
  return {
    ...ev,
    ring: ringIdx,
    color: TYPE_COLOR[ev.type] ?? '#22D3EE',
    forgeState: 'idle',
  };
}
function makeLink(f, t, bornAt = 0) {
  return { source: f.id, target: t.id, f, t, bornAt };
}

// ---------- 静态载入 ----------
function buildStatic(a) {
  atlas.value = a;
  hudOrigin.value = (a.origin ?? '').replace(/^https?:\/\//, '');
  nodes = []; edges = []; urlNode.clear(); pendingEdges = [];
  for (const n of a.nodes) {
    const ringIdx = n.depth === 0 ? 0 : n.depth === 1 ? 1 : 2;
    nodes.push(makeNode(n, ringIdx));
  }
  const idx = Object.fromEntries(nodes.map(n => [n.id, n]));
  const byFrom = {};
  for (const e of a.edges) (byFrom[e.from] ??= []).push(e.to);
  for (const [from, tos] of Object.entries(byFrom)) {
    for (const to of tos.slice(0, 8)) {
      const f = idx[from], t = idx[to];
      if (f && t && f !== t) edges.push(makeLink(f, t));
    }
  }
  bump();
}

// ---------- live 侦察 ----------
function startRecon() {
  const url = normalizeUrl(host.value);
  if (!url) { errMsg.value = '网址无效'; return; }
  errMsg.value = ''; live.value = true; statusText.value = '光点出发';
  hudOrigin.value = url.replace(/^https?:\/\//, '');
  nodes = []; edges = []; urlNode.clear(); pendingEdges = []; atlas.value = null;
  host.value = url.replace(/^https?:\/\//, '');
  bump();

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
      const node = makeNode(ev, ringIdx);
      nodes.push(node);
      urlNode.set(ev.url, node);
      statusText.value = '新星点亮';
      bump();
    } else if (ev.kind === 'edges') {
      pendingEdges.push({ from: ev.from, tos: ev.tos });
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
    const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
    edges = [];
    const byFrom = {};
    for (const e of a.edges) (byFrom[e.from] ??= []).push(e.to);
    for (const [from, tos] of Object.entries(byFrom)) {
      for (const to of tos.slice(0, 8)) {
        const f = byId[from], t = byId[to];
        if (f && t && f !== t) edges.push(makeLink(f, t));
      }
    }
    pendingEdges = [];
    bump();
  } catch {}
  live.value = false;
  setTimeout(() => { statusText.value = ''; }, 2500);
}

// ---------- 每帧消化 pending 边（两端点亮后浮现） ----------
setInterval(() => {
  for (let i = pendingEdges.length - 1; i >= 0; i--) {
    const pe = pendingEdges[i];
    const f = urlNode.get(pe.from);
    let added = false;
    for (const to of pe.tos) {
      const t2 = urlNode.get(to);
      if (f && t2 && f !== t2) { edges.push(makeLink(f, t2)); added = true; }
    }
    if (added) pendingEdges.splice(i, 1);
  }
  if (nodes.length !== hudPages.value) hudPages.value = nodes.length;
  if (edges.length !== hudEdges.value) hudEdges.value = edges.length;
}, 600);

// ---------- 站点切换器 ----------
async function loadSites() {
  try {
    const r = await fetch(`${API}/api/sites`);
    sites.value = (await r.json()).sites ?? [];
  } catch {}
}
async function pollEngine() {
  try {
    const r = await fetch(`${API}/api/status`);
    engine.value = await r.json();
  } catch { engine.value = { ok: false }; }
}
setInterval(pollEngine, 15000);
function pickSite(s) {
  if (!s) return;
  host.value = s.host;
  fetch(`/${s.host}/recon/atlas.json`).then(r => r.ok ? r.json() : Promise.reject()).then(buildStatic).catch(e => { errMsg.value = String(e); });
}

// ---------- forge：点选节点 → 单页还原流水线 ----------
function startForge(node) {
  return new Promise((resolve) => {
    if (!node?.url) return resolve();
    const pageName = node.path === '/' ? 'home' : node.path.replace(/^\//, '').replace(/\//g, '-');
    forge.value = { taskId: null, pageName, url: node.url, stages: { capture: 'idle', build: 'idle', shot: 'idle', diff: 'idle', fixup: 'idle', harvest: 'idle' }, score: null, done: false, failed: false, intel: null, rounds: [], skipReason: null, error: null };
    node.forgeState = 'running';
    statusText.value = '锻造中 · ' + pageName;
    bump();
    (async () => {
      try {
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: node.url }) });
        const { taskId, error } = await r.json();
        if (error) {
          forge.value.failed = true; forge.value.done = true; forge.value.error = error === 'busy' ? '造物台忙：其它页面正在锻造（稍后再点）' : error;
          node.forgeState = 'idle'; return resolve();
        }
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
            bump();
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
  const targets = nodes.filter(n => n.ring <= 2).slice(0, 10);
  statusText.value = `全境锻造 ${targets.length} 页`;
  let done = 0;
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      await startForge(n);
      done++;
      statusText.value = `全境锻造 ${done}/${targets.length}`;
    }
  };
  await Promise.all([worker(), worker()]);
  statusText.value = '全境锻造完成';
  setTimeout(() => { statusText.value = ''; }, 3000);
}

function liveUrl(f) {
  try { const u = new URL(f.url); return `/lm/${u.host}${u.pathname.replace(/\/$/, '')}`; } catch { return '#'; }
}

function onNodeClick(node) {
  if (node?.url) startForge(node);
}

onMounted(() => {
  loadSites(); pollEngine();
  // 默认载入上次侦察结果
  fetch('/apify.com/recon/atlas.json').then(r => r.ok ? r.json() : Promise.reject()).then(buildStatic).catch(() => {});
});
onBeforeUnmount(() => { es?.close(); esForge?.close(); });
</script>

<template>
  <Graph3D :nodes="gNodes" :links="gLinks" :tick="gTick" :auto-rotate="autoRotate" @node-click="onNodeClick" />

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

  <!-- 左侧仪表面板 -->
  <div class="panel hud-panel" v-show="showPanel">
    <div class="panel-title">OBSERVATORY · 仪表面板<button class="panel-collapse" @click="showPanel = false" title="收起">—</button></div>
    <div class="panel-sec">
      <div class="panel-sec-name">图例 · 页面类型</div>
      <div class="legend"><span class="lg"><i style="background:#22D3EE"></i>营销页</span><span class="lg"><i style="background:#F59E0B"></i>定价页</span><span class="lg"><i style="background:#8B5CF6"></i>列表页</span><span class="lg"><i style="background:#7B8CA6"></i>文档</span><span class="lg"><i style="background:#F87171"></i>登录</span></div>
    </div>
    <div class="panel-sec">
      <div class="panel-sec-name">显示</div>
      <label class="sw"><input type="checkbox" v-model="autoRotate" /><span>星图自转</span></label>
    </div>
    <div class="panel-sec">
      <div class="panel-sec-name">引擎</div>
      <div class="eng" :class="{ on: engine.ok }"><i></i>{{ engine.ok ? '在线 :8900' : '离线' }}</div>
      <div class="eng-detail" v-if="engine.ok">锻造槽 {{ engine.forge?.slots ?? 0 }}/2 · 侦察 {{ engine.recon ? '进行中' : '空闲' }}</div>
    </div>
  </div>
  <button class="panel-open" v-if="!showPanel" @click="showPanel = true" title="仪表面板">☰</button>

  <div class="seek hud-panel">
    <span class="seek-caret">▾</span>
    <input v-model="host" placeholder="输入目标域名 · apify.com" spellcheck="false" @keyup.enter="startRecon" />
    <button @click="startRecon">侦察</button>
  </div>

  <!-- 已侦察站点切换 -->
  <div class="sites" v-if="sites.length">
    <span class="sites-label">已侦察：</span>
    <button v-for="s in sites" :key="s.host" class="site-btn" :class="{ active: s.host === host }" @click="pickSite(s)" :title="`${s.forged}/${s.pages} 页已锻造`">
      {{ s.host }}<em>{{ s.forged }}F</em>
    </button>
  </div>

  <!-- 施工舱 -->
  <div class="dock" v-if="forge">
    <div class="dock-head">
      <div>
        <div class="dock-title">{{ forge.pageName }}</div>
        <div class="dock-url">{{ forge.url }}</div>
      </div>
      <div class="dock-headbtns"><button class="dock-all" @click="forgeAll" title="并行批量锻造内外环前 10 页">批量锻造 10 页</button><button class="dock-close" @click="forge = null">✕</button></div>
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
    <div class="verdict pending hud-panel" v-else-if="!forge.done && !forge.error"><span class="scan"></span>锻造中 …</div>
    <div class="dock-err hud-panel" v-if="forge.error">{{ forge.error }}</div>
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
    <div class="compare-link" v-if="forge.done">
      <a :href="`/${host}/compare.html?p=${forge.pageName}`" target="_blank" rel="noopener">⇔ 同步滚动对比</a>
      <span class="sep">·</span>
      <a :href="liveUrl(forge)" target="_blank" rel="noopener" title="功能与数据实时回原站（代理通道）">⚡ 活镜像</a>
    </div>
    <iframe v-if="forge.done" :key="forge.taskId" class="live-clone" :src="`/${host}/pages/${forge.pageName}/clone/index.html`" title="living clone"></iframe>
  </div>

  <a class="archive-link" v-if="hudPages > 0" :href="`/${host}/index.html`" target="_blank" rel="noopener">克隆档案 · {{ hudPages }} 页</a>
  <div class="keys" v-if="!forge">
    <span>拖拽 = 旋转</span><span>滚轮 = 缩放</span><span>Ctrl+拖拽 = 平移</span><span class="k-amber">点击星球 = 锻造该页</span>
  </div>
  <div class="toast" v-if="errMsg">{{ errMsg }}</div>
</template>

<style scoped>
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

.seek { position: fixed; top: 24px; left: 50%; transform: translateX(-50%); display: flex; align-items: stretch; z-index: 5; background: rgba(11,11,16,.85); }
.seek-caret { display: flex; align-items: center; padding: 0 4px 0 12px; color: var(--cyan-dim); font-size: 12px; }
.seek input { width: 320px; padding: 11px 14px; background: transparent; border: 0; color: var(--text); font-family: var(--font-mono); font-size: 14px; letter-spacing: .04em; outline: none; }
.seek input::placeholder { color: var(--text-faint); }
.seek button { padding: 0 24px; background: linear-gradient(180deg, rgba(34,211,238,.18), rgba(34,211,238,.05)); border: 0; border-left: 1px solid var(--cyan-line); color: var(--cyan); cursor: pointer; letter-spacing: .34em; font-size: 13px; font-family: var(--font-cn); transition: background var(--dur), box-shadow var(--dur); }
.seek button:hover { background: rgba(34,211,238,.14); box-shadow: 0 0 20px rgba(34,211,238,.25) inset; }

.sites { position: fixed; top: 76px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; z-index: 5; align-items: center; }
.sites-label { font-size: 11px; color: var(--text-faint); font-family: var(--font-mono); letter-spacing: .1em; }
.site-btn { background: rgba(11,11,16,.8); border: 1px solid var(--cyan-line); color: var(--text-dim); padding: 5px 12px; border-radius: var(--r); cursor: pointer; font-family: var(--font-mono); font-size: 12px; transition: all var(--dur); }
.site-btn em { font-style: normal; color: var(--green); margin-left: 6px; font-size: 10px; }
.site-btn:hover { border-color: var(--cyan-dim); color: var(--text); }
.site-btn.active { border-color: var(--cyan); color: var(--cyan); }

.toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); color: var(--red); letter-spacing: .08em; font-size: 13px; z-index: 20; }

/* 左侧仪表面板 */
.panel { position: fixed; left: 28px; bottom: 64px; width: 236px; padding: 14px 16px 16px; z-index: 6; }
.panel-title { display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 10px; letter-spacing: .24em; color: var(--text-faint); margin-bottom: 12px; }
.panel-collapse { background: none; border: 0; color: var(--text-faint); cursor: pointer; font-size: 13px; }
.panel-collapse:hover { color: var(--cyan); }
.panel-sec { margin-bottom: 12px; }
.panel-sec-name { font-size: 10px; letter-spacing: .18em; color: var(--text-faint); font-family: var(--font-mono); margin-bottom: 7px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px; }
.lg { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-dim); }
.lg i { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 6px currentColor; }
.sw { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); cursor: pointer; }
.sw input { accent-color: var(--cyan); }
.eng { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); }
.eng i { width: 8px; height: 8px; border-radius: 50%; background: var(--red); }
.eng.on i { background: var(--green); box-shadow: 0 0 8px rgba(52,211,153,.7); }
.eng-detail { margin-top: 5px; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); }
.panel-open { position: fixed; left: 28px; bottom: 64px; z-index: 6; width: 34px; height: 34px; background: rgba(11,11,16,.82); border: 1px solid var(--cyan-line); border-radius: var(--r); color: var(--cyan); cursor: pointer; font-size: 14px; }

/* 快捷键条 */
.keys { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; gap: 20px; z-index: 5; padding: 7px 18px; border: 1px solid var(--cyan-line); border-radius: var(--r); background: rgba(11,11,16,.72); font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); letter-spacing: .08em; }
.keys .k-amber { color: var(--amber); }

/* dock 内错误 */
.dock-err { margin-top: 12px; padding: 11px 13px; border: 1px solid rgba(239,68,68,.45); border-radius: var(--r); color: var(--red); font-size: 12.5px; background: rgba(239,68,68,.05); }

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
.score-break { display: flex; justify-content: center; gap: 18px; margin-top: 12px; font-size: 12px; color: var(--text-dim); font-family: var(--font-mono); flex-wrap: wrap; }
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
.compare-link { margin-top: 10px; text-align: center; }
.compare-link a { color: var(--cyan); font-size: 12px; font-family: var(--font-mono); letter-spacing: .12em; text-decoration: none; border-bottom: 1px dashed var(--cyan-line); }
.compare-link a:hover { border-color: var(--cyan); }
.compare-link .sep { color: var(--text-faint); margin: 0 8px; }
.archive-link { position: fixed; right: 24px; bottom: 20px; z-index: 8; padding: 8px 16px; border: 1px solid var(--cyan-line); border-radius: var(--r); background: rgba(11, 11, 16, .82); color: var(--cyan); font-family: var(--font-mono); font-size: 12px; letter-spacing: .16em; text-decoration: none; transition: all var(--dur); }
.archive-link:hover { border-color: var(--cyan-dim); box-shadow: 0 0 18px rgba(34, 211, 238, .2); }
.live-clone { width: 100%; height: 44vh; margin-top: 14px; border: 1px solid var(--cyan-line); border-radius: var(--r); background: #fff; }
</style>
