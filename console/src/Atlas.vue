<script setup>
/**
 * Atlas — 全站星图（3D 力导向，graphify 同款形态）
 *
 * 静态模式：读已有 /<host>/recon/atlas.json（或从站点切换器载入任意已侦察站）
 * live 模式：POST /api/recon → SSE 事件流 → 节点逐个弹入生长
 * 点星球 = 锻造该页；「锻造内环」= 批量并行
 */
import { onMounted, onBeforeUnmount, ref, reactive, computed } from 'vue';
import Graph3D from './Graph3D.vue';

import { PAGE_TYPES as PT, typeColor, typeCn } from './types.js';
const PAGE_TYPES = PT;
const TYPE_COLOR = Object.fromEntries(Object.entries(PAGE_TYPES).map(([k, v]) => [k, v.color]));
// 引擎 API 直连（vite proxy 会缓冲实时 SSE；引擎侧 CORS 已开放）
const API = 'http://127.0.0.1:8900';

const host = ref('apify.com');
const atlas = ref(null);
const live = ref(false);
const statusText = ref('');
const errMsg = ref('');
// 任务中心：每个 forge 任务独立对象 + 独立 EventSource（修复并发锻造单例覆盖）
const tasks = reactive([]);
const activeTaskId = ref(null);
const forge = computed(() => tasks.find(t => t.localId === activeTaskId.value) ?? null);
const taskSources = new Map();
const tasksOpen = ref(true);
function taskState(t) { return t.failed ? 'failed' : t.done ? 'done' : 'running'; }
function taskLabel(t) { return { running: '运行中', done: '完成', failed: '失败' }[taskState(t)] ?? '运行中'; }
const tokenOf = () => localStorage.getItem('heimdall-token') ?? '';
function apiHeaders() { const t = tokenOf(); return { 'Content-Type': 'application/json', ...(t ? { 'x-heimdall-token': t } : {}) }; }
function sseUrl(taskId) { const t = tokenOf(); return `${API}/api/events?task=${taskId}${t ? '&token=' + encodeURIComponent(t) : ''}`; }
const hudPages = ref(0);
const hudEdges = ref(0);
const hudEdgesRendered = ref(0);
const hudOrigin = ref('');
const sites = ref([]);          // 已侦察站点清单（/api/sites）
const engine = ref({ ok: false, recon: null, forge: null });   // 引擎状态灯
const autoRotate = ref(true);   // 星图自转开关
const showPanel = ref(true);    // 左侧仪表面板折叠
const pagesListOpen = ref(false);
const plSelected = ref(new Set());
function plToggle(id) { const s = new Set(plSelected.value); s.has(id) ? s.delete(id) : s.add(id); plSelected.value = s; }
function plSelectAll() { const s = new Set(plSelected.value); nodes.filter(n => n.forgeState !== 'done').forEach(n => s.add(n.id)); plSelected.value = s; }
async function forgeChecked() {
  const targets = nodes.filter(n => plSelected.value.has(n.id) && n.forgeState !== 'done');
  statusText.value = `清单锻造 ${targets.length} 页`;
  const q = [...targets]; let done = 0;
  const worker = async () => { while (q.length) { const n = q.shift(); await startForge(n); done++; statusText.value = `清单锻造 ${done}/${targets.length}`; } };
  await Promise.all([worker(), worker()]);
  statusText.value = '清单锻造完成'; plSelected.value = new Set();
  setTimeout(() => { statusText.value = ''; }, 3000);
}
const theme = ref(localStorage.getItem('heimdall-theme') ?? 'dark');   // 深色/浅色
function applyTheme(t) {
  theme.value = t;
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('heimdall-theme', t);
}
function toggleTheme() { applyTheme(theme.value === 'dark' ? 'light' : 'dark'); }
const selected = ref(null);          // 当前选中星球（点星=选中）
const detailTab = ref('overview');   // 详情面板 tab
const detailIntel = ref(null);       // 已锻页 intel.json
const detailScore = ref(null);       // 已锻页 score.json
const detailSeo = computed(() => selected.value?.seoLite ?? null);
const seoChecks = computed(() => {
  const sl = detailSeo.value;
  if (!sl) return null;
  const tLen = (sl.title ?? selected.value?.title ?? '').length;
  const dLen = (sl.description ?? '').length;
  return {
    title: { ok: tLen >= 10 && tLen <= 65, msg: tLen + ' 字符（建议 10-65）' },
    desc: { ok: dLen >= 50 && dLen <= 165, msg: dLen ? dLen + ' 字符（建议 50-165）' : '缺失' },
    h1: { ok: sl.h1Count === 1, msg: sl.h1Count + ' 个（建议恰好 1 个）' },
    alt: { ok: (sl.imgNoAlt ?? 0) === 0, msg: sl.imgCount ? sl.imgNoAlt + '/' + sl.imgCount + ' 缺失' : '无图片' },
    og: { ok: !!sl.ogTitle, msg: sl.ogTitle ? 'og:title 存在' : '缺失' },
    lang: { ok: !!sl.lang, msg: sl.lang || '缺失' },
  };
});

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
  hudPages.value = a.nodes.length;
  hudEdges.value = a.meta?.edges ?? a.edges.length;
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
    hudPages.value = nodes.length;
    hudEdges.value = a.meta?.edges ?? edges.length;
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
  const totalEdges = atlas.value?.meta?.edges ?? edges.length;
  if (totalEdges !== hudEdges.value) hudEdges.value = totalEdges;
  if (edges.length !== hudEdgesRendered.value) hudEdgesRendered.value = edges.length;
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
    const task = reactive({
      localId: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      taskId: null, pageName, url: node.url, nodeId: node.id,
      stages: { capture: 'idle', build: 'idle', shot: 'idle', diff: 'idle', fixup: 'idle', harvest: 'idle' },
      score: null, done: false, failed: false, intel: null, rounds: [], skipReason: null, error: null,
      startedAt: Date.now(), endedAt: null,
    });
    tasks.push(task);
    while (tasks.length > 20) tasks.shift();   // 只保留最近 20 条，长会话不膨胀
    activeTaskId.value = task.localId;
    node.forgeState = 'running';
    statusText.value = '锻造中 · ' + pageName;
    bump();
    (async () => {
      try {
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url: node.url }) });
        const { taskId, error } = await r.json();
        if (error) {
          task.failed = true; task.done = true; task.endedAt = Date.now();
          task.error = error === 'busy' ? '造物台忙：引擎并发槽已满（稍后重试）' : error;
          node.forgeState = 'idle'; return resolve();
        }
        task.taskId = taskId;
        const es = new EventSource(sseUrl(taskId));
        taskSources.set(task.localId, es);
        const closeTask = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
        es.onmessage = (m) => {
          let ev; try { ev = JSON.parse(m.data); } catch { return; }
          if (ev.kind === 'forge-stage') task.stages[ev.stage] = ev.status;
          else if (ev.kind === 'forge-score') task.score = ev.score;
          else if (ev.kind === 'fixup-round') task.rounds.push(ev);
          else if (ev.kind === 'fixup-skip') task.skipReason = `剩余差异 ${(ev.staticShare * 100).toFixed(1)}% 为动画噪声，AI 校准豁免`;
          else if (ev.kind === 'forge-error') task.failed = true;
          else if (ev.kind === 'exit') {
            task.done = ev.status === 'done';
            task.endedAt = Date.now();
            if (ev.status === 'cancelled') { task.error = '已取消'; node.forgeState = 'idle'; }
            else if (!task.done) { task.failed = true; node.forgeState = 'failed'; }
            else node.forgeState = 'done';
            statusText.value = task.done ? '恒星点亮' : (ev.status === 'cancelled' ? '任务已取消' : '造物失败');
            if (task.done) {
              fetch(`/${host.value}/pages/${task.pageName}/intel/intel.json`).then(r => r.ok ? r.json() : null).then(j => { if (j) task.intel = { headings: j.headings?.length ?? 0, prices: j.prices?.length ?? 0, cta: j.cta?.length ?? 0, links: j.links?.length ?? 0 }; }).catch(() => {});
            }
            closeTask();
            bump();
            setTimeout(() => { if (statusText.value !== '光点出发') statusText.value = ''; }, 2500);
            resolve();
          }
        };
        es.onerror = () => { closeTask(); resolve(); };
      } catch (e) {
        errMsg.value = String(e);
        task.failed = true; task.done = true; task.endedAt = Date.now();
        node.forgeState = 'idle';
        resolve();
      }
    })();
  });
}

async function forgeAll() {
  const targets = nodes.filter(n => n.forgeState !== 'done' && n.forgeState !== 'running').slice(0, 10);
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
  if (!node?.url) return;
  selected.value = node;                      // 点星 = 选中，打开详情剖析面板
  detailTab.value = 'overview';
  activeTaskId.value = null;                   // 关闭旧锻造视图（后台任务继续跑）
  detailIntel.value = null; detailScore.value = null;
  const pageName = node.path === '/' ? 'home' : node.path.replace(/^\//, '').replace(/\//g, '-');
  fetch(`/${host.value}/pages/${pageName}/intel/intel.json`).then(r => r.ok ? r.json() : null).then(j => { if (j && selected.value === node) detailIntel.value = j; }).catch(() => {});
  fetch(`/${host.value}/pages/${pageName}/score.json`).then(r => r.ok ? r.json() : null).then(j => { if (j && selected.value === node) detailScore.value = j; }).catch(() => {});
}

onMounted(() => {
  applyTheme(theme.value);
  loadSites(); pollEngine();
  // 默认载入上次侦察结果
  fetch('/apify.com/recon/atlas.json').then(r => r.ok ? r.json() : Promise.reject()).then(buildStatic).catch(() => {});
});
onBeforeUnmount(() => { es?.close(); for (const s of taskSources.values()) { try { s.close(); } catch {} } });
</script>

<template>
  <Graph3D :nodes="gNodes" :links="gLinks" :tick="gTick" :auto-rotate="autoRotate" @node-click="onNodeClick" />

  <div class="hud">
    <div class="brand">HEIMDALL<span class="brand-sub">SITE ATLAS · 深空观测站</span></div>
    <div class="hud-rule"></div>
    <div class="stats">
      <div class="stat"><b>{{ hudPages }}</b><i>pages</i></div>
      <div class="stat"><b>{{ hudEdges }}</b><i :title="`已渲染 ${hudEdgesRendered} / 全图 ${hudEdges} 条边`">edges</i></div>
      <div class="stat"><b>{{ hudOrigin }}</b><i>origin</i></div>
    </div>
    <div class="status" v-if="statusText" :class="{ live }">{{ statusText }}</div>
  </div>

  <!-- 左侧仪表面板 -->
  <div class="panel hud-panel" v-show="showPanel">
    <div class="panel-title">OBSERVATORY · 仪表面板<button class="panel-collapse" @click="showPanel = false" title="收起">—</button></div>
    <div class="panel-sec">
      <div class="panel-sec-name">图例 · 页面类型</div>
      <div class="legend"><span class="lg" v-for="(t, k) in PAGE_TYPES" :key="k"><i :style="{ background: t.color }"></i>{{ t.cn }}</span></div>
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
    <button class="theme-btn" @click="toggleTheme" :title="theme === 'dark' ? '切浅色' : '切深色'">{{ theme === 'dark' ? '☾' : '☀' }}</button>
    <input v-model="host" placeholder="输入目标域名 · apify.com" spellcheck="false" @keyup.enter="startRecon" />
    <button @click="startRecon">侦察</button>
  </div>

  <!-- 已侦察站点切换 -->
  <div class="sites" v-if="sites.length">
    <span class="sites-label">已侦察：</span>
    <button v-for="s in sites" :key="s.host" class="site-btn" :class="{ active: s.host === host, empty: !s.pages }" @click="pickSite(s); pagesListOpen = true" :title="s.pages ? `${s.forged}/${s.pages} 页已锻造` : '侦察结果为空（失败或无可用页面）'">
      {{ s.host }}<em>{{ s.pages ? s.forged + 'F' : '空' }}</em>
    </button>
    <button class="site-btn list-toggle" :class="{ active: pagesListOpen }" @click="pagesListOpen = !pagesListOpen">页面清单</button>
  </div>

  <!-- 任务中心：每个任务的独立进度（不再被后一个任务覆盖） -->
  <div class="task-center hud-panel" v-if="tasks.length">
    <div class="tc-head">
      <span>TASKS · 任务中心</span>
      <span class="tc-meta">{{ tasks.filter(t => !t.done && !t.failed).length }} 运行中 / {{ tasks.length }}</span>
      <button class="tc-toggle" @click="tasksOpen = !tasksOpen">{{ tasksOpen ? '—' : '＋' }}</button>
    </div>
    <div class="tc-rows" v-show="tasksOpen">
      <div class="tc-row" v-for="t in [...tasks].reverse()" :key="t.localId" :class="taskState(t)" @click="activeTaskId = t.localId" :title="t.error || t.url">
        <span class="tc-name">{{ t.pageName }}</span>
        <span class="tc-state">{{ taskLabel(t) }}</span>
        <span class="tc-score" v-if="t.score">{{ (t.score.pixel * 100).toFixed(1) }}%</span>
      </div>
    </div>
  </div>

  <!-- 页面清单（列表式查看 + 勾选锻造） -->
  <div class="pages-list hud-panel" v-if="pagesListOpen">
    <div class="pl-head">
      <span>页面清单 · {{ host }}</span>
      <span class="pl-actions">
        <button @click="plSelectAll" title="全选未锻页">全选未锻</button>
        <button @click="plSelected.clear(); syncPlSel()" title="清空选择">清空</button>
        <button class="pl-forge" :disabled="!plSelected.size" @click="forgeChecked">锻造选中 ({{ plSelected.size }})</button>
      </span>
    </div>
    <div class="pl-rows">
      <div class="pl-row" v-for="n in nodes" :key="n.id">
        <label class="pl-check"><input type="checkbox" :checked="plSelected.has(n.id)" @change="plToggle(n.id)" /></label>
        <span class="pl-type" :style="{ color: typeColor(n.type) }">{{ typeCn(n.type) }}</span>
        <span class="pl-path" @click="onNodeClick(n)">{{ n.path }}</span>
        <span class="pl-state">{{ n.forgeState === 'done' ? '✓ 已锻' : n.forgeState === 'running' ? '锻造中' : n.forgeState === 'failed' ? '失败' : '' }}</span>
      </div>
    </div>
  </div>

  <!-- 页面详情剖析面板（点星 = 选中；锻造是其中一项功能） -->
  <div class="dock" v-if="selected">
    <div class="dock-head">
      <div>
        <div class="dock-title">{{ selected.path === '/' ? 'home' : selected.path.slice(1) }}</div>
        <div class="dock-url">{{ selected.url }}</div>
      </div>
      <div class="dock-headbtns"><button class="dock-all" @click="forgeAll" title="批量锻造尚未完成的页面（每次最多 10 页，引擎 2 并发）">批量锻造 10 页</button><button class="dock-close" @click="selected = null">✕</button></div>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ on: detailTab === 'overview' }" @click="detailTab = 'overview'">概览</button>
      <button class="tab" :class="{ on: detailTab === 'seo' }" @click="detailTab = 'seo'">SEO 剖析</button>
      <button class="tab" :class="{ on: detailTab === 'forge' }" @click="detailTab = 'forge'">锻造克隆</button>
    </div>

    <!-- 概览 tab -->
    <div v-show="detailTab === 'overview'">
      <div class="ov-grid">
        <div class="ov-item"><span class="ov-k">类型</span><span class="ov-v" :style="{ color: typeColor(selected.type) }">{{ typeCn(selected.type) }}</span></div>
        <div class="ov-item"><span class="ov-k">层级深度</span><span class="ov-v">{{ selected.depth ?? '-' }}</span></div>
        <div class="ov-item"><span class="ov-k">锻造状态</span><span class="ov-v">{{ selected.forgeState === 'done' ? '已锻造' : selected.forgeState === 'running' ? '锻造中' : selected.forgeState === 'failed' ? '失败' : '未锻造' }}</span></div>
        <div class="ov-item" v-if="detailScore"><span class="ov-k">还原度</span><span class="ov-v" :style="{ color: detailScore.grade === 'A' ? 'var(--green)' : 'var(--amber)' }">{{ detailScore.total }}% {{ detailScore.grade }}</span></div>
      </div>
      <div class="ov-sec" v-if="selected.seoLite || selected.title">
        <div class="panel-sec-name">页面标题</div>
        <div class="ov-text">{{ selected.title || selected.seoLite?.title || '-' }}</div>
      </div>
      <div class="ov-sec" v-if="selected.seoLite?.description || detailIntel?.meta?.description">
        <div class="panel-sec-name">Meta Description</div>
        <div class="ov-text">{{ selected.seoLite?.description || detailIntel?.meta?.description }}</div>
      </div>
      <div class="ov-sec" v-if="detailIntel">
        <div class="panel-sec-name">情报摘要（已入库）</div>
        <div class="ov-text">标题 {{ detailIntel.headings?.length ?? 0 }} · 价格 {{ detailIntel.prices?.length ?? 0 }} · CTA {{ detailIntel.cta?.length ?? 0 }} · 链接 {{ detailIntel.links?.length ?? 0 }}</div>
      </div>
      <div class="forge-cta" v-if="selected.forgeState !== 'done' && selected.forgeState !== 'running'">
        <button class="forge-btn" @click="openForge">⚡ 开始锻造此页</button>
        <div class="forge-note">捕获 → 校准 → 评分，全程约 2-3 分钟；也可点「批量锻造 10 页」</div>
      </div>
      <div class="forge-cta" v-else-if="selected.forgeState === 'done'">
        <button class="forge-btn alt" @click="detailTab = 'forge'">查看锻造详情 →</button>
      </div>
    </div>

    <!-- SEO tab -->
    <div v-show="detailTab === 'seo'">
      <div class="seo-note">这是侦察期轻量检查（title/description/H1/alt/OG/lang）；完整 40+ 项审计在「SEO 审计」报告中产出。</div>
      <div class="seo-list" v-if="selected.seoLite">
        <div class="seo-row" :class="seoChecks.title.ok ? 'ok' : 'warn'"><span class="seo-k">Title</span><span>{{ seoChecks.title.msg }}</span></div>
        <div class="seo-row" :class="seoChecks.desc.ok ? 'ok' : 'warn'"><span class="seo-k">Description</span><span>{{ seoChecks.desc.msg }}</span></div>
        <div class="seo-row" :class="seoChecks.h1.ok ? 'ok' : 'warn'"><span class="seo-k">H1 数量</span><span>{{ seoChecks.h1.msg }}</span></div>
        <div class="seo-row" :class="seoChecks.alt.ok ? 'ok' : 'warn'"><span class="seo-k">图片 Alt</span><span>{{ seoChecks.alt.msg }}</span></div>
        <div class="seo-row" :class="seoChecks.og.ok ? 'ok' : 'warn'"><span class="seo-k">OG 标签</span><span>{{ seoChecks.og.msg }}</span></div>
        <div class="seo-row" :class="seoChecks.lang.ok ? 'ok' : 'warn'"><span class="seo-k">lang 属性</span><span>{{ seoChecks.lang.msg }}</span></div>
      </div>
      <div class="seo-note" v-else>该页侦察于旧版引擎（无 SEO 画像）。重新侦察本站即可获得全部页面的 SEO 剖析。</div>
    </div>

    <!-- 锻造 tab -->
    <div v-show="detailTab === 'forge'">
      <div class="forge-cta" v-if="!forge && selected.forgeState !== 'done' && selected.forgeState !== 'running'">
        <button class="forge-btn" @click="openForge">⚡ 开始锻造此页</button>
        <div class="forge-note">六阶段：捕获骨架 → 注入皮肤 → 渲染校准 → AI 校准 → 像素定谳 → 情报入库</div>
      </div>
      <div class="forge-cta" v-if="!forge && selected.forgeState === 'done'">
        <button class="forge-btn alt" @click="openForge">↻ 重新锻造此页</button>
      </div>

      <template v-if="forge">
        <div class="stages">
          <div class="stage" v-for="(label, key, i) in { capture: '捕获骨架', build: '注入皮肤', shot: '渲染校准', fixup: 'AI 校准', diff: '像素定谳', harvest: '情报入库' }" :key="key"
               :class="forge.stages[key]">
            <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>{{ label }}<span class="dot"></span>
          </div>
        </div>

        <div class="verdict hud-panel" v-if="forge.score">
          <div class="verdict-label">VISUAL FIDELITY · 视觉还原度（可核验口径）</div>
          <div class="score-num" :class="(forge.score.pixel * 100) >= 95 ? 'ok' : (forge.score.pixel * 100) >= 85 ? 'mid' : 'bad'">
            {{ (forge.score.pixel * 100).toFixed(1) }}<small>%</small>
          </div>
          <div class="score-break">
            <span>结构 {{ ((forge.score.dom?.dom ?? 0) * 100).toFixed(1) }}%</span>
            <span v-if="forge.score.data">数据 {{ (forge.score.data.data * 100).toFixed(1) }}%</span>
            <span class="grade">综合 {{ forge.score.total }} · {{ forge.score.grade }}</span>
          </div>
          <div class="score-note">结构/数据与捕获 DOM 同源比对（自证辅助项）；视觉分才是对外可核验口径。</div>
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
          <span class="sep">·</span>
          <a :href="`/${host}/pages/${forge.pageName}/clone/index.html`" target="_blank" rel="noopener">死镜像</a>
        </div>
        <iframe v-if="forge.done" :key="forge.taskId" class="live-clone" :src="`/${host}/pages/${forge.pageName}/clone/index.html`" title="living clone"></iframe>
      </template>
    </div>
  </div>

  <a class="archive-link" v-if="hudPages > 0" :href="`/${host}/index.html`" target="_blank" rel="noopener">克隆档案 · {{ hudPages }} 页</a>
  <div class="keys" v-if="!forge">
    <span>拖拽 = 旋转</span><span>滚轮 = 缩放</span><span>Ctrl+拖拽 = 平移</span><span class="k-amber">点击星球 = 打开页面详情</span>
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
.theme-btn { background: transparent; border: 0; color: var(--text-dim); font-size: 15px; padding: 0 6px 0 12px; cursor: pointer; }
.theme-btn:hover { color: var(--cyan); }
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
/* 页面清单 */
.pages-list { position: fixed; top: 116px; left: 50%; transform: translateX(-50%); width: 560px; max-height: 60vh; z-index: 7; padding: 12px 14px; display: flex; flex-direction: column; }
.pl-head { display: flex; justify-content: space-between; align-items: center; font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); letter-spacing: .12em; margin-bottom: 9px; }
.pl-actions { display: flex; gap: 6px; }
.pl-actions button { background: rgba(148,163,184,.1); border: 1px solid var(--cyan-line); color: var(--text-dim); padding: 3px 9px; border-radius: var(--r); cursor: pointer; font-size: 11px; }
.pl-actions button:hover { color: var(--cyan); border-color: var(--cyan-dim); }
.pl-actions .pl-forge { border-color: rgba(245,158,11,.5); color: var(--amber); }
.pl-actions .pl-forge:disabled { opacity: .4; cursor: not-allowed; }
.pl-rows { overflow-y: auto; max-height: 48vh; }
.pl-row { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: var(--r); font-size: 12px; }
.pl-row:hover { background: rgba(34,211,238,.05); }
.pl-check input { accent-color: var(--cyan); }
.pl-type { width: 64px; font-size: 11px; flex-shrink: 0; }
.pl-path { font-family: var(--font-mono); color: var(--text); cursor: pointer; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pl-path:hover { color: var(--cyan); }
.pl-state { font-size: 10px; color: var(--green); width: 52px; text-align: right; flex-shrink: 0; }
.list-toggle.active { border-color: var(--cyan); color: var(--cyan); }

.keys { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); display: flex; gap: 20px; z-index: 5; padding: 7px 18px; border: 1px solid var(--cyan-line); border-radius: var(--r); background: rgba(11,11,16,.72); font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); letter-spacing: .08em; }
.keys .k-amber { color: var(--amber); }

/* dock 内错误 */
.dock-err { margin-top: 12px; padding: 11px 13px; border: 1px solid rgba(239,68,68,.45); border-radius: var(--r); color: var(--red); font-size: 12.5px; background: rgba(239,68,68,.05); }

/* 施工舱 */
/* 详情 tabs */
.tabs { display: flex; gap: 6px; margin-top: 16px; }
.tab { flex: 1; padding: 8px 0; background: rgba(30,30,35,.5); border: 1px solid rgba(148,163,184,.18); border-radius: var(--r); color: var(--text-faint); font-size: 12.5px; cursor: pointer; transition: all var(--dur); }
.tab:hover { color: var(--text); }
.tab.on { border-color: var(--cyan); color: var(--cyan); background: rgba(34,211,238,.06); }

/* 概览 */
.ov-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
.ov-item { padding: 9px 11px; border: 1px solid rgba(148,163,184,.16); border-radius: var(--r); background: rgba(30,30,35,.5); }
.ov-k { display: block; font-size: 10px; color: var(--text-faint); letter-spacing: .14em; margin-bottom: 3px; font-family: var(--font-mono); }
.ov-v { font-size: 13px; color: var(--text); }
.ov-sec { margin-top: 13px; }
.ov-sec .panel-sec-name { margin-bottom: 5px; }
.ov-text { font-size: 12px; color: var(--text-dim); line-height: 1.7; }
.forge-cta { margin-top: 16px; text-align: center; }
.forge-btn { width: 100%; padding: 13px 0; background: linear-gradient(180deg, rgba(34,211,238,.22), rgba(34,211,238,.06)); border: 1px solid var(--cyan); border-radius: var(--r); color: var(--cyan); font-size: 14.5px; letter-spacing: .2em; cursor: pointer; transition: all var(--dur); }
.forge-btn:hover { box-shadow: 0 0 26px rgba(34,211,238,.35); }
.forge-btn.alt { background: rgba(148,163,184,.08); border-color: rgba(148,163,184,.4); color: var(--text-dim); }
.forge-note { margin-top: 8px; font-size: 11px; color: var(--text-faint); line-height: 1.6; }

/* SEO 检查清单 */
.seo-note { margin-top: 14px; padding: 9px 12px; border: 1px dashed var(--cyan-line); border-radius: var(--r); color: var(--text-faint); font-size: 11.5px; line-height: 1.6; }
.seo-list { margin-top: 14px; }
.seo-row { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 11px; border: 1px solid rgba(148,163,184,.16); border-radius: var(--r); margin-bottom: 7px; font-size: 12px; }
.seo-row .seo-k { font-family: var(--font-mono); color: var(--text-dim); }
.seo-row.ok { border-color: rgba(52,211,153,.35); }
.seo-row.ok .seo-k { color: var(--green); }
.seo-row.warn { border-color: rgba(245,158,11,.4); }
.seo-row.warn .seo-k { color: var(--amber); }

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
/* 任务中心 + 口径说明 */
.task-center { position: fixed; left: 20px; bottom: 58px; z-index: 9; width: 280px; padding: 10px 12px; }
.tc-head { display: flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: .22em; color: var(--text-faint); }
.tc-meta { margin-left: auto; color: var(--text-dim); letter-spacing: .05em; }
.tc-toggle { background: none; border: 0; color: var(--cyan); cursor: pointer; font-size: 12px; }
.tc-rows { margin-top: 8px; max-height: 180px; overflow: auto; }
.tc-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 3px; cursor: pointer; font-size: 11.5px; color: var(--text-dim); }
.tc-row:hover { background: rgba(34,211,238,.08); }
.tc-row.running .tc-state { color: var(--amber); }
.tc-row.done .tc-state { color: var(--green); }
.tc-row.failed .tc-state { color: var(--red); }
.tc-name { font-family: var(--font-mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tc-state { margin-left: auto; font-size: 10px; }
.tc-score { font-family: var(--font-mono); color: var(--green); font-size: 10px; }
.site-btn.empty { opacity: .55; border-color: rgba(239,68,68,.35); }
.site-btn.empty em { color: var(--red); }
.score-note { margin-top: 8px; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); letter-spacing: .04em; }
</style>
