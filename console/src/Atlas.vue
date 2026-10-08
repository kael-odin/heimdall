<script setup>
/**
 * Atlas — 全站星图（3D 力导向，graphify 同款形态）
 *
 * 静态模式：读已有 /<host>/recon/atlas.json（或从站点切换器载入任意已侦察站）
 * live 模式：POST /api/recon → SSE 事件流 → 节点逐个弹入生长
 * 点星球 = 锻造该页；「锻造内环」= 批量并行
 */
import { onMounted, onBeforeUnmount, ref, reactive, computed, watch } from 'vue';
import Graph3D from './Graph3D.vue';

import { PAGE_TYPES as PT, typeColor, typeCn } from './types.js';
const PAGE_TYPES = PT;
const TYPE_COLOR = Object.fromEntries(Object.entries(PAGE_TYPES).map(([k, v]) => [k, v.color]));
// 引擎 API 直连（vite proxy 会缓冲实时 SSE；引擎侧 CORS 已开放）
// 单端口部署时与引擎同源；Vite dev（5173/5175）直连引擎 :8900（避免代理缓冲 SSE）
const DEV_PORTS = ['5173', '5174', '5175'];
const API = localStorage.getItem('heimdall-api') ?? (DEV_PORTS.includes(location.port) || !/^https?:/.test(location.protocol) ? 'http://127.0.0.1:8900' : location.origin);

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
const auditReport = ref(null);   // 最近一次 SEO 审计结果（报告入口）
const watchReport = ref(null);   // 最近一次变更监控结果（报告入口）
const okMsg = ref('');           // 成功提示（绿色 toast，与错误提示区分）
const jobHistory = ref([]);      // 引擎持久化的历史任务（/api/jobs.history）
const reportIndex = ref([]);     // 可用报告索引（/api/reports/:host）
const assetInfo = ref(null);     // 资产清单（/api/assets/:host）
const assetAuditReport = ref(null); // 最近一次资产缺口扫描结果
const matrixPeer = ref('');          // 跨站对标对象
const matrixReport = ref(null);      // 最近一次对标矩阵报告
const llmStatus = ref(null);     // LLM 配置状态（/api/llm/status，不含 key）
const llmTest = ref(null);       // 最近一次连接测试结果
const llmTesting = ref(false);
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
const showPanel = ref(typeof window === 'undefined' || window.innerWidth > 768);    // 左侧仪表面板折叠（小屏默认收起）
const plSelected = ref(new Set());
function plToggle(id) { const s = new Set(plSelected.value); s.has(id) ? s.delete(id) : s.add(id); plSelected.value = s; }
function plSelectAll() { const s = new Set(plSelected.value); tableNodes.value.filter(n => n.forgeState !== 'done').forEach(n => s.add(n.id)); plSelected.value = s; }
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
const detailQuality = reactive({ loading: false, verify: null, fixup: null, gaps: null, history: null });
const assetGapsCache = ref(null);
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

// ---------- 工作台视图（v2）：星图 / 页面 / 任务 / 报告 / 设置 ----------
const view = ref('atlas');
const VIEWS = [
  { id: 'atlas', icon: '✦', label: '星图' },
  { id: 'pages', icon: '▤', label: '页面' },
  { id: 'jobs', icon: '◷', label: '任务' },
  { id: 'reports', icon: '▦', label: '报告' },
  { id: 'settings', icon: '⚙', label: '设置' },
];
const pageQuery = ref('');
const typeFilter = ref('');
const statusFilter = ref('');
const tableNodes = ref([]);                       // 页面表格的响应式快照（含孤儿已克隆页）
const extraNodes = ref([]);                       // 已克隆但不在 atlas 中的页面（补全清单）
const sortKey = ref('path');
const sortDir = ref(1);
const pageScores = reactive({});                  // nodeId -> score.json（懒加载）
const pageVerify = reactive({});                  // nodeId -> verify.json（多视口，懒加载）
const pageMeta = reactive({});                    // nodeId -> { assets, visualGaps, interactions, updatedAt }
const tokenInput = ref(localStorage.getItem('heimdall-token') ?? '');
const apiBaseInput = ref(localStorage.getItem('heimdall-api') ?? API);
const pageNameOf = (n) => {
  try { const p = new URL(n.url).pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[/?&#]+/g, '-').slice(0, 60); return p || 'home'; }
  catch { return n.path === '/' ? 'home' : String(n.path || '').replace(/^\//, '').replace(/[/?&#]+/g, '-') || 'home'; }
};
const STATE_RANK = { done: 0, running: 1, failed: 2, idle: 3 };
function toggleSort(k) { if (sortKey.value === k) sortDir.value = -sortDir.value; else { sortKey.value = k; sortDir.value = 1; } }
const filteredNodes = computed(() => {
  const q = pageQuery.value.trim().toLowerCase();
  const out = tableNodes.value.filter(n => {
    if (typeFilter.value && n.type !== typeFilter.value) return false;
    if (statusFilter.value === 'done' && n.forgeState !== 'done') return false;
    if (statusFilter.value === 'todo' && (n.forgeState === 'done' || n.forgeState === 'running')) return false;
    if (statusFilter.value === 'failed' && n.forgeState !== 'failed') return false;
    const hay = ((n.url || '') + ' ' + (n.title || '') + ' ' + (n.path || '')).toLowerCase();
    return !q || hay.includes(q);
  });
  const dir = sortDir.value;
  out.sort((a, b) => {
    if (sortKey.value === 'state') return (STATE_RANK[a.forgeState] - STATE_RANK[b.forgeState]) * dir;
    if (sortKey.value === 'score') {
      const av = pageScores[a.id]?.pixel, bv = pageScores[b.id]?.pixel;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    }
    if (sortKey.value === 'assets') return ((pageMeta[a.id]?.assets?.bytes ?? 0) - (pageMeta[b.id]?.assets?.bytes ?? 0)) * dir;
    if (sortKey.value === 'title') return String(a.title || '').localeCompare(String(b.title || '')) * dir;
    return String(a.path || '').localeCompare(String(b.path || '')) * dir;
  });
  return out;
});
const doneCount = computed(() => tableNodes.value.filter(n => n.forgeState === 'done').length);
const statusCounts = computed(() => ({
  all: tableNodes.value.length,
  done: tableNodes.value.filter(n => n.forgeState === 'done').length,
  todo: tableNodes.value.filter(n => n.forgeState !== 'done' && n.forgeState !== 'running').length,
  failed: tableNodes.value.filter(n => n.forgeState === 'failed').length,
}));
const avgVisual = computed(() => {
  const vals = Object.values(pageScores).filter(s => s && typeof s.pixel === 'number').map(s => s.pixel);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1) + '%' : '—';
});
const avgWorst = computed(() => {
  const vals = Object.values(pageVerify).filter(v => v?.minViewport && typeof v.minViewport.score === 'number').map(v => v.minViewport.score);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1) + '%' : null;
});
let scoreLoadTimer = null;
function scheduleScoreLoad() { clearTimeout(scoreLoadTimer); scoreLoadTimer = setTimeout(loadPageScores, 400); }
async function loadPageScores() {
  const list = tableNodes.value.filter(n => n.forgeState === 'done').slice(0, 80);
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const n = list[i++];
      try {
        const name = pageNameOf(n);
        const [rs, rv] = await Promise.all([
          fetch('/' + host.value + '/pages/' + name + '/score.json'),
          fetch('/' + host.value + '/verify/' + name + '/verify.json'),
        ]);
        pageScores[n.id] = rs.ok ? await rs.json() : null;
        pageVerify[n.id] = rv.ok ? await rv.json() : null;
      } catch { pageScores[n.id] = null; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString('zh-CN', { hour12: false }) : '');
const fmtDate = (t) => (t ? new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—');
const fmtBytes = (n) => (n == null ? '—' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? (n / 1024).toFixed(0) + 'KB' : n + 'B');
const fmtDuration = (t) => (t.endedAt && t.startedAt ? Math.round((t.endedAt - t.startedAt) / 1000) + 's' : (t.startedAt ? '进行中' : ''));
async function loadQuality() {
  const n = selected.value;
  if (!n) return;
  detailQuality.loading = true;
  detailQuality.verify = null; detailQuality.fixup = null; detailQuality.gaps = null; detailQuality.history = null;
  const name = pageNameOf(n);
  const [v, f, h] = await Promise.all([
    fetch('/' + host.value + '/verify/' + name + '/verify.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch('/' + host.value + '/pages/' + name + '/fixup-history.json').then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(API + '/api/history/' + encodeURIComponent(host.value) + '/' + encodeURIComponent(name), { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  if (selected.value !== n) return;
  detailQuality.verify = v; detailQuality.fixup = f; detailQuality.history = h;
  if (!assetGapsCache.value) {
    try { const r = await fetch('/' + host.value + '/audit/asset-gaps.json'); if (r.ok) assetGapsCache.value = await r.json(); } catch {}
  }
  detailQuality.gaps = assetGapsCache.value?.pages?.find(p => p.page === name) ?? null;
  detailQuality.loading = false;
}
watch(detailTab, (t) => { if (t === 'quality') loadQuality(); });

function openDetail(n) { view.value = 'pages'; onNodeClick(n); }
function selectView(id) {
  if (id === 'pages' && view.value === 'pages') { view.value = 'atlas'; return; }   // 再次点击 = 收起
  view.value = id;
  if (id === 'jobs') loadJobHistory();
  if (id === 'reports') { loadReports(); loadAssets(); }
  if (id === 'settings') loadLlm();
}
function togglePages() { if (view.value === 'pages') view.value = 'atlas'; else { view.value = 'pages'; loadPageStatus(); } }
async function deleteSite(s) {
  if (!s?.host) return;
  if (!confirm('删除站点 ' + s.host + '？\n将移除 workspace/' + s.host + ' 下的侦察、克隆与报告（CAS 资产保留）。')) return;
  try {
    const r = await fetch(API + '/api/sites/' + encodeURIComponent(s.host), { method: 'DELETE', headers: apiHeaders() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    sites.value = sites.value.filter(x => x.host !== s.host);
    if (host.value === s.host) {
      if (sites.value[0]) pickSite(sites.value[0]);
      else { host.value = ''; nodes = []; edges = []; tableNodes.value = []; bump(); }
    }
    okMsg.value = '已删除站点 ' + s.host;
    setTimeout(() => { okMsg.value = ''; }, 2500);
  } catch (e) { errMsg.value = '删除失败：' + String(e).slice(0, 160); }
}
async function removePageNode(n) {
  const name = n.pageName ?? pageNameOf(n);
  const r = await fetch(API + '/api/sites/' + encodeURIComponent(host.value) + '/pages/' + encodeURIComponent(name), { method: 'DELETE', headers: apiHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  delete pageScores[n.id];
  nodes = nodes.filter(x => x.id !== n.id);
  extraNodes.value = extraNodes.value.filter(x => x.id !== n.id);
  if (selected.value === n) selected.value = null;
  bump();
  return j;
}
async function deletePage(n) {
  const name = n.pageName ?? pageNameOf(n);
  if (!confirm('删除页面 ' + (n.path || name) + ' 的克隆产物，并从星图移除该节点？')) return;
  try {
    const j = await removePageNode(n);
    okMsg.value = '已删除页面 ' + name + (j.removedNode ? '（星图节点已移除）' : '');
    setTimeout(() => { okMsg.value = ''; }, 2500);
    loadSites();
  } catch (e) { errMsg.value = '删除失败：' + String(e).slice(0, 160); }
}
async function removeChecked() {
  const targets = tableNodes.value.filter(n => plSelected.value.has(n.id) && n.forgeState !== 'running');
  if (!targets.length) return;
  if (!confirm('移除选中 ' + targets.length + ' 个页面？\n将删除克隆产物并从星图移除节点（CAS 资产保留）。')) return;
  let ok = 0, fail = 0;
  for (const n of targets) { try { await removePageNode(n); ok++; } catch { fail++; } }
  plSelected.value = new Set();
  okMsg.value = '已移除 ' + ok + ' 个页面' + (fail ? '（' + fail + ' 失败）' : '');
  setTimeout(() => { okMsg.value = ''; }, 3000);
  loadSites();
}
function saveApiBase() {
  const v = apiBaseInput.value.trim() || 'http://127.0.0.1:8900';
  localStorage.setItem('heimdall-api', v);
  location.reload();
}
async function loadPageStatus() {
  try {
    const r = await fetch(API + '/api/pages/' + host.value);
    if (!r.ok) return;
    const { pages } = await r.json();
    const byPath = new Map();
    const byName = new Map();
    for (const p of pages) {
      try { byPath.set(new URL(p.target).pathname.replace(/\/$/, '') || '/', p); } catch {}
      byName.set(p.name, p);
    }
    const matchedNames = new Set();
    for (const n of nodes) {
      const key = (n.path || '/').replace(/\/$/, '') || '/';
      const hit = byPath.get(key) ?? byName.get(pageNameOf(n));
      if (hit) {
        n.forgeState = 'done'; pageScores[n.id] = hit.score ?? null; matchedNames.add(hit.name);
        pageMeta[n.id] = { assets: hit.assets ?? null, visualGaps: hit.visualGaps ?? null, interactions: hit.interactions ?? null, updatedAt: hit.updatedAt ?? null };
      }
    }
    // 补全：已克隆但不在 atlas 中的页面（例如 recon 截断、删过节点），保证清单是"完全体"
    extraNodes.value = pages.filter(p => !matchedNames.has(p.name)).map(p => {
      let path = p.target;
      try { path = new URL(p.target).pathname || '/'; } catch {}
      return { id: 'forged:' + p.name, url: p.target, path, title: p.target, type: 'generic', depth: 99, ring: 3, color: '#64748B', forgeState: 'done', synthetic: true, pageName: p.name };
    });
    for (const n of extraNodes.value) {
      const hit = pages.find(p => p.name === n.pageName);
      pageScores[n.id] = hit?.score ?? null;
      pageMeta[n.id] = { assets: hit?.assets ?? null, visualGaps: hit?.visualGaps ?? null, interactions: hit?.interactions ?? null, updatedAt: hit?.updatedAt ?? null };
    }
    tableNodes.value = [...nodes, ...extraNodes.value];
  } catch {}
}
function saveToken() {
  const v = tokenInput.value.trim();
  if (v) localStorage.setItem('heimdall-token', v); else localStorage.removeItem('heimdall-token');
  okMsg.value = v ? 'Token 已保存（后续请求生效）' : 'Token 已清除';
  setTimeout(() => { okMsg.value = ''; }, 2500);
}

// 3D 图数据（Graph3D 消费）
const gNodes = ref([]);
const gLinks = ref([]);
const gTick = ref(0);
const bump = () => { gNodes.value = [...nodes]; gLinks.value = [...edges]; gTick.value++; tableNodes.value = [...nodes, ...extraNodes.value]; scheduleScoreLoad(); };

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
  const seenUrls = new Set();
  for (const n of a.nodes) {
    const key = (n.url || '').replace(/\/$/, '');
    if (seenUrls.has(key)) continue;   // 去重：https://x 与 https://x/ 视为同一页
    seenUrls.add(key);
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
  loadPageStatus();
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
    loadPageStatus();
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
  plSelected.value = new Set();
  selected.value = null;
  detailIntel.value = null; detailScore.value = null;
  fetch(`/${s.host}/recon/atlas.json`).then(r => r.ok ? r.json() : Promise.reject()).then(a => { buildStatic(a); loadPageStatus(); }).catch(e => { errMsg.value = String(e); });
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
            loadSites();
            setTimeout(loadPageStatus, 600);
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

/** LLM 状态与连接测试（设置页使用） */
async function loadLlm() {
  try { const r = await fetch(API + '/api/llm/status'); if (r.ok) llmStatus.value = await r.json(); } catch {}
}
async function testLlm() {
  llmTesting.value = true; llmTest.value = null;
  try {
    const r = await fetch(API + '/api/llm/test', { method: 'POST', headers: apiHeaders() });
    llmTest.value = await r.json();
  } catch (e) { llmTest.value = { ok: false, error: String(e).slice(0, 200) }; }
  finally { llmTesting.value = false; }
}

/** 报告索引 + 资产清单（报告页使用） */
async function loadReports() {
  try { const r = await fetch(API + '/api/reports/' + host.value); if (r.ok) reportIndex.value = (await r.json()).reports ?? []; } catch {}
}
async function loadAssets() {
  try { const r = await fetch(API + '/api/assets/' + host.value); if (r.ok) assetInfo.value = await r.json(); } catch {}
}

/** 引擎持久化任务历史（重启后仍可查） */
async function loadJobHistory() {
  try {
    const r = await fetch(API + '/api/jobs');
    if (!r.ok) return;
    const j = await r.json();
    jobHistory.value = j.history ?? [];
  } catch {}
}

/** 跨站对标矩阵：引擎 matrix 任务 */
function runMatrix() {
  if (!matrixPeer.value) return;
  const task = reactive({
    localId: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'matrix', label: '对标 · ' + host.value + ' vs ' + matrixPeer.value, url: 'https://' + matrixPeer.value,
    done: false, failed: false, error: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '对标矩阵 · 生成中';
  (async () => {
    try {
      const r = await fetch(API + '/api/matrix', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ sites: [host.value, matrixPeer.value], maxPages: 15 }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '对标失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'matrix-done') {
          task.done = true; task.endedAt = Date.now();
          const rel = String(ev.path || '').split(/[\\/]workspace[\\/]/).pop() || '';
          matrixReport.value = { url: '/static/' + rel.split('\\').join('/'), sites: [host.value, matrixPeer.value] };
          statusText.value = '对标矩阵完成';
          close(); setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断'; close();
        }
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) { task.failed = true; task.done = true; task.error = String(e); errMsg.value = String(e); }
  })();
}

/** 资产缺口扫描：引擎 assets 任务（SSE → 报告入口） */
function runAssetsAudit() {
  const task = reactive({
    localId: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'assets', label: '资产扫描 · ' + host.value, url: 'https://' + host.value,
    done: false, failed: false, error: null, assetGaps: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '资产扫描 · 采集中';
  (async () => {
    try {
      const r = await fetch(API + '/api/assets-audit', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: host.value, maxPages: 100 }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '资产扫描失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'assets-gaps-done') {
          task.assetGaps = ev.visualGaps; task.done = true; task.endedAt = Date.now();
          assetAuditReport.value = { host: host.value, visualGaps: ev.visualGaps, visualOrigin: ev.visualOrigin, visualThird: ev.visualThird, pages: ev.pages };
          statusText.value = ev.visualGaps ? ('资产扫描完成 · ' + ev.visualGaps + ' 个视觉缺口') : '资产扫描完成 · 无视觉缺口';
          close(); loadReports(); loadAssets();
          setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断'; close();
        }
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) { task.failed = true; task.done = true; task.error = String(e); errMsg.value = String(e); }
  })();
}

/** 站点变更监控：引擎 watch 任务（SSE 进度 → 变更报告入口） */
function runWatch() {
  const origin = atlas.value?.origin ?? 'https://' + host.value;
  const task = reactive({
    localId: 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'watch', label: '变更监控 · ' + host.value, url: origin,
    done: false, failed: false, error: null, watchChanges: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '变更监控 · 采集中';
  (async () => {
    try {
      const r = await fetch(API + '/api/watch', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url: origin, maxPages: 30 }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '变更监控失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'watch-page') statusText.value = '变更监控 · ' + ev.index + '/' + ev.total;
        else if (ev.kind === 'watch-done') {
          task.watchChanges = ev.changes; task.done = true; task.endedAt = Date.now();
          watchReport.value = { host: host.value, changes: ev.changes, bySeverity: ev.bySeverity };
          statusText.value = ev.changes ? '变更监控完成 · ' + ev.changes + ' 处变化' : '变更监控完成 · 无变化';
          close(); setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'watch-error') {
          task.failed = true; task.done = true; task.error = ev.error;
          errMsg.value = '变更监控失败：' + ev.error; close();
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断'; close();
        }
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) { task.failed = true; task.done = true; task.error = String(e); errMsg.value = String(e); }
  })();
}

/** 全站 SEO 审计：复用引擎 audit 任务（SSE 进度 → 报告入口） */
function runAudit() {
  const origin = atlas.value?.origin ?? `https://${host.value}`;
  const task = reactive({
    localId: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: 'audit', label: 'SEO 审计 · ' + host.value, url: origin,
    done: false, failed: false, error: null, auditScore: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = 'SEO 审计 · 准备中';
  (async () => {
    try {
      const r = await fetch(`${API}/api/audit`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url: origin, maxPages: 30 }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = 'SEO 审计失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'audit-start') statusText.value = `SEO 审计 · 0/${ev.targets}`;
        else if (ev.kind === 'audit-page') statusText.value = `SEO 审计 · ${ev.index}/${ev.total}`;
        else if (ev.kind === 'audit-done') {
          task.auditScore = ev.score; task.done = true; task.endedAt = Date.now();
          auditReport.value = { host: host.value, score: ev.score, pages: ev.pages, issues: ev.issues };
          statusText.value = `SEO 审计完成 · ${ev.score} 分`;
          close(); setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'audit-error') {
          task.failed = true; task.done = true; task.error = ev.error;
          errMsg.value = 'SEO 审计失败：' + ev.error; close();
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断'; close();
        }
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) {
      task.failed = true; task.done = true; task.error = String(e);
      errMsg.value = String(e);
    }
  })();
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

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (selected.value) { selected.value = null; return; }
  if (view.value !== 'atlas') { view.value = 'atlas'; }
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  applyTheme(theme.value);
  loadSites(); pollEngine();
  // 默认载入上次侦察结果
  fetch('/apify.com/recon/atlas.json').then(r => r.ok ? r.json() : Promise.reject()).then(buildStatic).catch(() => {});
});
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown); es?.close(); for (const s of taskSources.values()) { try { s.close(); } catch {} } });
</script>

<template>
  <Graph3D v-show="view === 'atlas'" :nodes="gNodes" :links="gLinks" :tick="gTick" :auto-rotate="autoRotate" @node-click="onNodeClick" />

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
  <div class="panel hud-panel" v-if="view === 'atlas' && showPanel">
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
  <button class="panel-open" v-if="view === 'atlas' && !showPanel" @click="showPanel = true" title="仪表面板">☰</button>

  <div class="seek hud-panel">
    <button class="theme-btn" @click="toggleTheme" :title="theme === 'dark' ? '切浅色' : '切深色'">{{ theme === 'dark' ? '☾' : '☀' }}</button>
    <input v-model="host" placeholder="输入目标域名 · apify.com" spellcheck="false" @keyup.enter="startRecon" />
    <button @click="startRecon">侦察</button>
  </div>

  <!-- 已侦察站点切换 -->
  <div class="sites" v-if="sites.length">
    <span class="sites-label">已侦察：</span>
    <span class="site-item" v-for="s in sites" :key="s.host">
      <button class="site-btn" :class="{ active: s.host === host, empty: !s.pages }" @click="pickSite(s)" :title="s.pages ? `${s.forged}/${s.pages} 页已锻造` : '侦察结果为空（失败或无可用页面）'">
        {{ s.host }}<em>{{ s.pages ? s.forged + 'F' : '空' }}</em>
      </button>
      <button class="site-del" title="删除该站点（侦察/克隆/报告；CAS 资产保留）" @click.stop="deleteSite(s)">✕</button>
    </span>
    <button class="site-btn audit-btn" :disabled="!!engine.audit" @click="runAudit" :title="engine.audit ? '已有审计任务在运行' : '全站 SEO 审计（40+ 规则，输出 HTML/CSV/JSON 报告）'">SEO 审计</button>
    <button class="site-btn list-toggle" :class="{ active: view === 'pages' }" @click="togglePages()" :title="view === 'pages' ? '收起清单返回星图' : '打开页面清单'">{{ view === 'pages' ? '收起清单' : '页面清单' }}</button>
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
        <span class="tc-name">{{ t.label ?? t.pageName }}</span>
        <span class="tc-state">{{ taskLabel(t) }}</span>
        <span class="tc-score" v-if="t.kind === 'audit' && t.auditScore != null">{{ t.auditScore }} 分</span>
        <span class="tc-score" v-else-if="t.score">{{ (t.score.pixel * 100).toFixed(1) }}%</span>
      </div>
    </div>
  </div>

    <!-- 工作台视图：页面 / 任务 / 报告 / 设置 -->
  <section class="work-view hud-panel" v-if="view === 'pages'">
    <div class="wv-head">
      <b>页面清单 · {{ host }}</b>
      <span class="wv-stat">{{ doneCount }}/{{ tableNodes.length }} 已克隆 · 平均视觉 {{ avgVisual }}<template v-if="avgWorst"> · 最差视口均值 {{ avgWorst }}</template></span>
      <input class="wv-search" v-model="pageQuery" placeholder="搜索 URL / 标题" spellcheck="false" />
      <select v-model="typeFilter"><option value="">全部类型</option><option v-for="(t, k) in PAGE_TYPES" :key="k" :value="k">{{ t.cn }}</option></select>
      <select v-model="statusFilter"><option value="">全部状态 ({{ statusCounts.all }})</option><option value="done">已克隆 ({{ statusCounts.done }})</option><option value="todo">未完成 ({{ statusCounts.todo }})</option><option value="failed">失败 ({{ statusCounts.failed }})</option></select>
      <button @click="plSelectAll" title="全选未克隆页">全选未锻</button>
      <button @click="plSelected = new Set(tableNodes.map(n => n.id))" title="全选当前清单">全选</button>
      <button @click="plSelected = new Set()" title="清空选择">清空</button>
      <button class="wv-primary" :disabled="!plSelected.size" @click="forgeChecked">克隆选中 ({{ plSelected.size }})</button>
      <button class="danger" :disabled="!plSelected.size" @click="removeChecked">移除选中 ({{ plSelected.size }})</button>
      <button class="wv-close" @click="view = 'atlas'" title="返回星图（Esc）">✕ 返回星图</button>
    </div>
    <div class="wv-rows">
      <div class="wv-row wv-th">
        <span class="c-check"></span>
        <span class="c-path sortable" @click="toggleSort('path')">路径 {{ sortKey === 'path' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-title sortable" @click="toggleSort('title')">标题 {{ sortKey === 'title' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-type">类型</span>
        <span class="c-state sortable" @click="toggleSort('state')">状态 {{ sortKey === 'state' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-score sortable" @click="toggleSort('score')">视觉 {{ sortKey === 'score' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-assets sortable" @click="toggleSort('assets')">资产 {{ sortKey === 'assets' ? (sortDir > 0 ? '▲' : '▼') : '' }}</span>
        <span class="c-gaps">缺口</span>
        <span class="c-ix">交互</span>
        <span class="c-updated">更新</span>
        <span class="c-actions">操作</span>
      </div>
      <div class="wv-row" v-for="n in filteredNodes" :key="n.id">
        <label class="c-check"><input type="checkbox" :checked="plSelected.has(n.id)" @change="plToggle(n.id)" /></label>
        <span class="wv-url c-path" @click="openDetail(n)" :title="n.url">{{ n.path }}</span>
        <span class="wv-title c-title" :title="n.title">{{ n.title }}</span>
        <span class="wv-type c-type" :style="{ color: typeColor(n.type) }">{{ typeCn(n.type) }}</span>
        <span class="wv-state c-state" :class="n.forgeState">{{ n.forgeState === 'done' ? '已克隆' : n.forgeState === 'running' ? '克隆中' : n.forgeState === 'failed' ? '失败' : '未克隆' }}</span>
        <span class="wv-score c-score" :title="pageVerify[n.id]?.minViewport ? ('多视口最差：' + pageVerify[n.id].minViewport.name + ' ' + (pageVerify[n.id].minViewport.score * 100).toFixed(1) + '%') : '未运行多视口验证'">{{ pageScores[n.id]?.pixel != null ? (pageScores[n.id].pixel * 100).toFixed(1) + '%' : '—' }}<i v-if="pageVerify[n.id]?.minViewport && pageVerify[n.id].minViewport.score < 0.95" :class="pageVerify[n.id].minViewport.score < 0.85 ? 'min-bad' : 'min-mid'"> ↓{{ (pageVerify[n.id].minViewport.score * 100).toFixed(0) }}</i></span>
        <span class="wv-meta c-assets" :title="pageMeta[n.id]?.assets ? (pageMeta[n.id].assets.count + ' 个文件') : ''">{{ pageMeta[n.id]?.assets ? fmtBytes(pageMeta[n.id].assets.bytes) : '—' }}<i v-if="pageMeta[n.id]?.assets"> · {{ pageMeta[n.id].assets.count }}</i></span>
        <span class="wv-meta c-gaps" :class="{ bad: (pageMeta[n.id]?.visualGaps?.visual ?? 0) > 0 }" :title="pageMeta[n.id]?.visualGaps ? ('原站 ' + pageMeta[n.id].visualGaps.origin + ' / 第三方 ' + pageMeta[n.id].visualGaps.third) : ''">{{ pageMeta[n.id]?.visualGaps == null ? '—' : pageMeta[n.id].visualGaps.visual }}</span>
        <span class="wv-meta c-ix">{{ pageMeta[n.id]?.interactions ? (pageMeta[n.id].interactions.passed + '/' + pageMeta[n.id].interactions.total) : '—' }}</span>
        <span class="wv-meta c-updated">{{ fmtDate(pageMeta[n.id]?.updatedAt) }}</span>
        <span class="wv-actions c-actions">
          <a :href="n.url" target="_blank" rel="noopener" title="打开原站">原站</a>
          <button @click="openDetail(n)">详情</button>
          <button :disabled="n.forgeState === 'running'" @click="startForge(n)">{{ n.forgeState === 'done' ? '重锻' : '克隆' }}</button>
          <button v-if="n.forgeState === 'done' || n.forgeState === 'failed'" class="danger" @click="deletePage(n)" title="删除该页克隆产物并从星图移除">删除</button>
        </span>
      </div>
      <div class="wv-empty" v-if="!filteredNodes.length">没有匹配的页面。</div>
    </div>
  </section>

  <section class="work-view hud-panel" v-if="view === 'jobs'">
    <div class="wv-head">
      <b>任务中心</b>
      <span class="wv-stat">引擎 {{ engine.ok ? '在线' : '离线' }} · 克隆槽 {{ engine.forge?.slots ?? 0 }}/{{ engine.forge?.max ?? 2 }} · 本会话 {{ tasks.length }} 个任务</span>
    </div>
    <div class="wv-rows">
      <div class="wv-row job-row" v-for="t in [...tasks].reverse()" :key="t.localId">
        <span class="job-name">{{ t.label ?? t.pageName }}</span>
        <span class="job-kind">{{ t.kind === 'audit' ? 'SEO 审计' : t.kind === 'watch' ? '变更监控' : t.kind === 'assets' ? '资产扫描' : t.kind === 'matrix' ? '跨站对标' : '克隆' }}</span>
        <span class="wv-state" :class="taskState(t)">{{ taskLabel(t) }}</span>
        <span class="wv-score">{{ t.kind === 'audit' ? (t.auditScore != null ? t.auditScore + ' 分' : '—') : t.kind === 'watch' ? (t.watchChanges != null ? t.watchChanges + ' 处变化' : '—') : t.kind === 'assets' ? (t.assetGaps != null ? t.assetGaps + ' 缺口' : '—') : (t.score ? (t.score.pixel * 100).toFixed(1) + '%' : '—') }}</span>
        <span class="job-time">{{ fmtTime(t.startedAt) }} · {{ fmtDuration(t) }}</span>
        <span class="job-error" :title="t.error">{{ t.error || '' }}</span>
      </div>
      <div class="wv-empty" v-if="!tasks.length && !jobHistory.length">本次会话还没有任务：在「星图」点击页面，或在「页面」批量克隆 / 运行 SEO 审计。</div>
      <div class="wv-sub" v-if="jobHistory.length">引擎持久化历史（最近 {{ jobHistory.length }} 条，重启后仍可查）</div>
      <div class="wv-row job-row history" v-for="h in jobHistory" :key="'h-' + h.id">
        <span class="job-name">{{ h.pageName || h.url }}</span>
        <span class="job-kind">{{ h.kind }}</span>
        <span class="wv-state" :class="h.status === 'done' ? 'done' : h.status === 'failed' ? 'failed' : h.status === 'running' ? 'running' : 'idle'">{{ h.status }}</span>
        <span class="wv-score">—</span>
        <span class="job-time">{{ fmtTime(h.createdAt) }} · {{ h.endedAt ? Math.round((h.endedAt - h.createdAt) / 1000) + 's' : '' }}</span>
        <span class="job-error">{{ h.error || '' }}</span>
      </div>
    </div>
  </section>

  <section class="reports-grid" v-if="view === 'reports'">
    <div class="report-card hud-panel">
      <h3>克隆档案</h3>
      <p>{{ doneCount }} 页已克隆 · 平均视觉 {{ avgVisual }}</p>
      <a :href="`/${host}/index.html`" target="_blank" rel="noopener">打开档案</a>
    </div>
    <div class="report-card hud-panel">
      <h3>SEO 审计报告</h3>
      <p v-if="auditReport">{{ auditReport.score }} 分 · {{ auditReport.pages }} 页 · {{ auditReport.issues }} 条问题</p>
      <p v-else>尚未运行（40+ 规则 / 六分类评分）</p>
      <a v-if="auditReport" :href="`/static/${auditReport.host}/seo/seo.html`" target="_blank" rel="noopener">打开报告</a>
      <button v-else class="wv-primary" @click="runAudit">运行审计</button>
    </div>
    <div class="report-card hud-panel">
      <h3>变更监控</h3>
      <p v-if="watchReport">{{ watchReport.changes }} 处变化（高 {{ watchReport.bySeverity?.high ?? 0 }}）</p>
      <p v-else>对比基线快照，发现标题/描述/canonical/正文变化</p>
      <a v-if="watchReport" :href="`/static/${host}/watch/watch.html`" target="_blank" rel="noopener">打开变更报告</a>
      <button v-else class="wv-primary" @click="runWatch">运行监控</button>
    </div>
    <div class="report-card hud-panel">
      <h3>同步滚动对比</h3>
      <p>原站快照 vs 镜像，逐屏目检</p>
      <a :href="`/${host}/compare.html`" target="_blank" rel="noopener">打开对比</a>
    </div>
    <div class="report-card hud-panel">
      <h3>竞品情报包</h3>
      <p>概览 / 语义情报 / 定价与 CTA</p>
      <a :href="`/${host}/intel/${host}-intel.xlsx`" download>下载 Excel</a>
    </div>

    <div class="report-card hud-panel">
      <h3>跨站对标矩阵</h3>
      <p v-if="matrixReport">与 {{ matrixReport.sites[1] }} 的 SEO 对标已生成</p>
      <p v-else>选择另一站点，生成站点分/覆盖率/LCP/页面类型对比</p>
      <div v-if="matrixReport"><a :href="matrixReport.url" target="_blank" rel="noopener">打开矩阵报告</a></div>
      <div v-else class="matrix-run">
        <select v-model="matrixPeer"><option value="">选择对标站点</option><option v-for="s in sites.filter(x => x.host !== host)" :key="s.host" :value="s.host">{{ s.host }}</option></select>
        <button class="wv-primary" :disabled="!matrixPeer" @click="runMatrix">生成对标</button>
      </div>
    </div>
    <div class="report-card hud-panel">
      <h3>资产缺口</h3>
      <p v-if="assetAuditReport">{{ assetAuditReport.visualGaps }} 个视觉缺口（原站 {{ assetAuditReport.visualOrigin }} / 第三方 {{ assetAuditReport.visualThird }}）</p>
      <p v-else>扫描图片/图标/SVG/CSS 引用，区分视觉缺口与元数据噪声</p>
      <a v-if="assetAuditReport" :href="`/static/${host}/audit/asset-gaps.html`" target="_blank" rel="noopener">打开缺口报告</a>
      <button v-else class="wv-primary" @click="runAssetsAudit">运行扫描</button>
    </div>
    <div class="report-card report-wide hud-panel">
      <h3>更多报告</h3>
      <div class="report-list" v-if="reportIndex.filter(r => r.available).length">
        <a v-for="r in reportIndex.filter(x => x.available)" :key="r.id" :href="r.url" target="_blank" rel="noopener">{{ r.name }}</a>
      </div>
      <p v-else>暂无（运行 verify / tokens / components / matrix 后自动出现）</p>
    </div>

    <div class="report-card report-wide hud-panel">
      <h3>资产清单 <span class="wv-stat" v-if="assetInfo">共 {{ assetInfo.count }} 个文件 · {{ (assetInfo.totalBytes / 1024 / 1024).toFixed(1) }}MB · 去重后可查看 asset-ledger</span></h3>
      <div class="asset-table" v-if="assetInfo?.items?.length">
        <div class="asset-row asset-th"><span>页面</span><span>类型</span><span>大小</span><span>路径</span><span></span></div>
        <div class="asset-row" v-for="a in assetInfo.items.slice(0, 120)" :key="a.path">
          <span>{{ a.page }}</span><span>{{ a.ext || '—' }}</span><span>{{ (a.size / 1024).toFixed(0) }}KB</span>
          <span class="asset-path" :title="a.path">{{ a.path }}</span>
          <a :href="a.url" target="_blank" rel="noopener">打开</a>
        </div>
      </div>
      <p v-else>暂无资产数据（先克隆页面）</p>
    </div>
  </section>

  <section class="work-view hud-panel" v-if="view === 'settings'">
    <div class="wv-head"><b>设置</b><span class="wv-stat">本地控制台偏好（浏览器存储）</span></div>
    <div class="settings-grid">
      <div class="set-row"><span>主题</span><button @click="toggleTheme">{{ theme === 'dark' ? '深色 → 浅色' : '浅色 → 深色' }}</button></div>
      <div class="set-row"><span>星图自转</span><input type="checkbox" v-model="autoRotate" /></div>
      <div class="set-row"><span>引擎地址</span><input v-model="apiBaseInput" placeholder="http://127.0.0.1:8900" spellcheck="false" /><button @click="saveApiBase">保存并刷新</button></div>
      <div class="set-row"><span>引擎 Token</span><input v-model="tokenInput" placeholder="HEIMDALL_TOKEN（保护引擎 API，可留空）" spellcheck="false" /><button @click="saveToken">保存</button></div>
      <div class="set-note" style="border-top:0;padding-top:0">「引擎 Token」= 访问本机引擎 API 的口令（环境变量 HEIMDALL_TOKEN），与下面模型服务的 LLM Key 不是一回事：前者保护你的引擎，后者用于调用模型。</div>
      <div class="set-row" v-if="llmStatus">
        <span>模型服务</span>
        <b :style="{ color: llmStatus.enabled ? 'var(--green)' : 'var(--red)' }">{{ llmStatus.enabled ? '已启用' : '未启用' }}</b>
        <span class="wv-stat">协议 {{ llmStatus.protocol }} · 主模型 {{ llmStatus.model }} · 快速 {{ llmStatus.fastModel }} · 端点 {{ llmStatus.baseHost || '—' }} · Key {{ llmStatus.hasKey ? '已配置' : '缺失' }}</span>
        <button :disabled="llmTesting || !llmStatus.enabled" @click="testLlm">{{ llmTesting ? '测试中…' : '测试连接' }}</button>
      </div>
      <div class="set-note" v-if="llmTest">{{ llmTest.ok ? ('✓ 连接成功 · ' + llmTest.latencyMs + 'ms · ' + (llmTest.reply || '').slice(0, 40)) : ('✗ 失败：' + (llmTest.error || 'unknown')) }}</div>
      <div class="set-note">模型配置：编辑 <code>core/.env</code> 的 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_MODEL_FAST / LLM_PROTOCOL（chat|responses|anthropic），改完重启引擎生效。</div>
      <div class="set-note">引擎：{{ engine.ok ? '在线' : '离线' }} · 绑定 {{ engine.bind ?? '127.0.0.1' }} · 鉴权 {{ engine.auth ? '开启' : '关闭' }}<br/>数据目录 / 并发 / 代理白名单通过环境变量配置（HEIMDALL_DATA_DIR / HEIMDALL_TOKEN / HEIMDALL_ALLOWED_HOSTS）。</div>
    </div>
  </section>

  <!-- 页面详情剖析面板（点星 = 选中；锻造是其中一项功能） -->
  <div class="dock" v-if="selected && (view === 'atlas' || view === 'pages')">
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
      <button class="tab" :class="{ on: detailTab === 'quality' }" @click="detailTab = 'quality'">质检</button>
      <button class="tab" :class="{ on: detailTab === 'forge' }" @click="detailTab = 'forge'">锻造克隆</button>
    </div>

    <!-- 概览 tab -->
    <div v-show="detailTab === 'overview'">
      <div class="ov-grid">
        <div class="ov-item"><span class="ov-k">类型</span><span class="ov-v" :style="{ color: typeColor(selected.type) }">{{ typeCn(selected.type) }}</span></div>
        <div class="ov-item"><span class="ov-k">层级深度</span><span class="ov-v">{{ selected.depth ?? '-' }}</span></div>
        <div class="ov-item"><span class="ov-k">锻造状态</span><span class="ov-v">{{ selected.forgeState === 'done' ? '已锻造' : selected.forgeState === 'running' ? '锻造中' : selected.forgeState === 'failed' ? '失败' : '未锻造' }}</span></div>
        <div class="ov-item" v-if="detailScore"><span class="ov-k">还原度</span><span class="ov-v" :style="{ color: detailScore.grade === 'A' ? 'var(--green)' : 'var(--amber)' }">{{ detailScore.total }}% {{ detailScore.grade }}</span></div>
        <div class="ov-item" v-if="pageMeta[selected.id]?.assets"><span class="ov-k">资产</span><span class="ov-v">{{ fmtBytes(pageMeta[selected.id].assets.bytes) }} · {{ pageMeta[selected.id].assets.count }} 个</span></div>
        <div class="ov-item" v-if="pageMeta[selected.id]?.visualGaps != null"><span class="ov-k">视觉缺口</span><span class="ov-v" :style="{ color: pageMeta[selected.id].visualGaps.visual ? 'var(--red)' : 'var(--green)' }">{{ pageMeta[selected.id].visualGaps.visual }}</span></div>
        <div class="ov-item" v-if="pageMeta[selected.id]?.interactions"><span class="ov-k">交互回放</span><span class="ov-v">{{ pageMeta[selected.id].interactions.passed }}/{{ pageMeta[selected.id].interactions.total }}</span></div>
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
      <div class="dock-quick" v-if="selected.forgeState === 'done'">
        <a :href="`/${host}/pages/${pageNameOf(selected)}/clone/index.html`" target="_blank" rel="noopener">打开克隆</a>
        <a :href="liveUrl({ url: selected.url })" target="_blank" rel="noopener">活镜像</a>
        <a :href="`/${host}/compare.html?p=${pageNameOf(selected)}`" target="_blank" rel="noopener">同步对比</a>
        <a :href="`/${host}/pages/${pageNameOf(selected)}/score.json`" target="_blank" rel="noopener">分数 JSON</a>
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

    <!-- 质检 tab -->
    <div v-show="detailTab === 'quality'">
      <div class="seo-note" v-if="detailQuality.loading">加载质检数据…</div>
      <template v-else>
        <div class="ov-sec">
          <div class="panel-sec-name">视觉保真（多视口）</div>
          <div v-if="detailQuality.verify" class="q-list">
            <div class="q-row" v-for="v in detailQuality.verify.viewports" :key="v.name">
              <span class="q-k">{{ v.name }}</span>
              <span class="q-v" :class="v.grade === 'A' ? 'ok' : v.grade === 'B' ? 'mid' : 'bad'">{{ v.score != null ? ((v.score * 100).toFixed(1) + '% ' + v.grade) : (v.skipped || v.error || '—') }}</span>
            </div>
            <div class="q-row"><span class="q-k">综合</span><span class="q-v">{{ (detailQuality.verify.overall * 100).toFixed(1) }}% {{ detailQuality.verify.grade }}</span></div>
            <div class="q-row" v-if="detailQuality.verify.minViewport"><span class="q-k">最差视口</span><span class="q-v" :class="detailQuality.verify.minViewport.score >= 0.95 ? 'ok' : detailQuality.verify.minViewport.score >= 0.85 ? 'mid' : 'bad'">{{ detailQuality.verify.minViewport.name }} {{ (detailQuality.verify.minViewport.score * 100).toFixed(1) }}% {{ detailQuality.verify.minViewport.grade }}</span></div>
          </div>
          <div v-else class="seo-note">未运行多视口验证：<code>node core/src/verify/verify.mjs {{ host }} {{ pageNameOf(selected) }}</code></div>
        </div>
        <div class="ov-sec">
          <div class="panel-sec-name">交互回放（功能保真）</div>
          <div v-if="detailQuality.verify?.functional" class="q-list">
            <div class="q-row"><span class="q-k">通过</span><span class="q-v" :class="detailQuality.verify.functional.passed === detailQuality.verify.functional.total ? 'ok' : 'bad'">{{ detailQuality.verify.functional.passed }}/{{ detailQuality.verify.functional.total }}</span></div>
            <div class="q-row" v-for="(ix, i) in (detailQuality.verify.interactions || [])" :key="i">
              <span class="q-k">{{ ix.label || ('交互 ' + (i + 1)) }}</span>
              <span class="q-v" :class="ix.pass ? 'ok' : 'bad'">{{ ix.pass ? '通过' : '失败' }}<i v-if="ix.visualScore != null"> · 像素 {{ (ix.visualScore * 100).toFixed(1) }}%</i></span>
            </div>
          </div>
          <div v-else class="seo-note">未运行交互回放（单页 verify 默认开启，可用 --no-interactions 关闭）</div>
        </div>
        <div class="ov-sec">
          <div class="panel-sec-name">资产缺口</div>
          <div v-if="detailQuality.gaps" class="q-list">
            <div class="q-row"><span class="q-k">视觉缺口</span><span class="q-v" :class="(detailQuality.gaps.visualGaps ?? 0) ? 'bad' : 'ok'">{{ detailQuality.gaps.visualGaps ?? 0 }}</span></div>
            <div class="q-row" v-for="(g, i) in (detailQuality.gaps.gaps || []).filter(x => x.category === 'visual').slice(0, 8)" :key="i">
              <span class="q-k">{{ g.kind }}</span><span class="q-v" :title="g.url">{{ String(g.url).slice(0, 52) }}</span>
            </div>
          </div>
          <div v-else class="seo-note">未扫描：报告 → 资产缺口 → 运行扫描</div>
        </div>
        <div class="ov-sec" v-if="detailQuality.history?.jobs?.length">
          <div class="panel-sec-name">锻造历史（引擎持久化 · 最近 {{ detailQuality.history.jobs.length }} 次）</div>
          <div class="q-list">
            <div class="q-row" v-for="j in detailQuality.history.jobs.slice(0, 8)" :key="j.id">
              <span class="q-k">{{ fmtDate(j.createdAt) }}</span>
              <span class="q-v" :class="j.status === 'done' ? 'ok' : j.status === 'failed' ? 'bad' : 'mid'">
                {{ j.status }} · {{ j.endedAt ? Math.round((j.endedAt - j.createdAt) / 1000) + 's' : '—' }}
                <i v-if="j.score"> · 视觉 {{ (j.score.pixel * 100).toFixed(1) }}%</i>
                <i v-if="j.error" class="bad"> · {{ String(j.error).slice(0, 40) }}</i>
              </span>
            </div>
          </div>
        </div>
        <div class="ov-sec" v-if="detailQuality.fixup?.rounds?.length">
          <div class="panel-sec-name">AI 校准曲线</div>
          <div class="q-list">
            <div class="q-row" v-for="r in detailQuality.fixup.rounds" :key="r.round"><span class="q-k">第 {{ r.round }} 轮</span><span class="q-v">{{ r.before }}% → {{ r.after }}% <b :class="r.kept ? 'ok' : 'bad'">{{ r.kept ? '保留' : '回滚' }}</b></span></div>
          </div>
        </div>
      </template>
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

  <a class="audit-link" v-if="auditReport" :href="`/static/${auditReport.host}/seo/seo.html`" target="_blank" rel="noopener">SEO 报告 · {{ auditReport.score }} 分</a>
  <a class="archive-link" v-if="hudPages > 0" :href="`/${host}/index.html`" target="_blank" rel="noopener">克隆档案 · {{ hudPages }} 页</a>
  <div class="keys" v-if="view === 'atlas' && !forge">
    <span>拖拽 = 旋转</span><span>滚轮 = 缩放</span><span>Ctrl+拖拽 = 平移</span><span class="k-amber">点击星球 = 打开页面详情</span>
  </div>
  <div class="toast" v-if="errMsg">{{ errMsg }}</div>
  <div class="toast ok" v-if="okMsg">{{ okMsg }}</div>
  <div class="view-nav hud-panel">
    <button v-for="v in VIEWS" :key="v.id" :class="{ on: view === v.id }" @click="selectView(v.id)">
      <b>{{ v.icon }}</b><span>{{ v.label }}</span>
    </button>
  </div>
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

.sites { position: fixed; top: 76px; left: 50%; transform: translateX(-50%); display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; z-index: 5; align-items: center; max-width: min(92vw, 980px); }
.sites-label { font-size: 11px; color: var(--text-faint); font-family: var(--font-mono); letter-spacing: .1em; }
.site-btn { background: rgba(11,11,16,.8); border: 1px solid var(--cyan-line); color: var(--text-dim); padding: 5px 12px; border-radius: var(--r); cursor: pointer; font-family: var(--font-mono); font-size: 12px; transition: all var(--dur); }
.site-btn em { font-style: normal; color: var(--green); margin-left: 6px; font-size: 10px; }
.site-btn:hover { border-color: var(--cyan-dim); color: var(--text); }
.site-btn.active { border-color: var(--cyan); color: var(--cyan); }

.toast { position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%); color: var(--red); letter-spacing: .08em; font-size: 13px; z-index: 20; }
.toast.ok { color: var(--green); }
.wv-row { grid-template-columns: 34px minmax(150px,1.1fr) minmax(180px,1.6fr) 90px 80px 70px 230px; }
.wv-actions { flex-wrap: wrap; }

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
.site-item { display: inline-flex; align-items: center; gap: 2px; }
.site-del { background: none; border: 1px solid transparent; color: var(--text-faint); cursor: pointer; border-radius: 3px; padding: 2px 5px; font-size: 11px; }
.site-del:hover { color: var(--red); border-color: rgba(239,68,68,.4); }
.wv-close { margin-left: auto; }
.wv-actions button.danger:hover { color: var(--red); border-color: rgba(239,68,68,.5); }
.site-btn.empty { opacity: .55; border-color: rgba(239,68,68,.35); }
.site-btn.empty em { color: var(--red); }
.score-note { margin-top: 8px; font-size: 10px; color: var(--text-faint); font-family: var(--font-mono); letter-spacing: .04em; }
.audit-btn { border-color: rgba(52,211,153,.4); color: var(--green); }
.audit-btn:disabled { opacity: .45; cursor: not-allowed; }
.audit-link { position: fixed; right: 24px; bottom: 62px; z-index: 8; padding: 8px 16px; border: 1px solid rgba(52,211,153,.45); border-radius: var(--r); background: rgba(11,11,16,.82); color: var(--green); font-family: var(--font-mono); font-size: 12px; letter-spacing: .12em; text-decoration: none; }
.audit-link:hover { box-shadow: 0 0 18px rgba(52,211,153,.25); }
[data-theme="light"] .site-btn { background: #ffffff; color: var(--text-dim); }
[data-theme="light"] .site-btn:hover { color: var(--text); }
[data-theme="light"] .site-btn.active { color: var(--cyan); background: rgba(8,145,178,.08); }
[data-theme="light"] .site-btn em { color: var(--green); }
[data-theme="light"] .archive-link,
[data-theme="light"] .audit-link { background: #ffffff; }
/* 工作台视图 + 底部导航（v2 IA） */
.work-view { position: fixed; left: 24px; right: 24px; top: 96px; bottom: 86px; z-index: 7; display: flex; flex-direction: column; overflow: hidden; padding: 0; }
.wv-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--cyan-line); flex-wrap: wrap; font-size: 13px; }
.wv-head b { font-family: var(--font-mono); letter-spacing: .08em; }
.wv-stat { color: var(--text-dim); font-size: 11.5px; font-family: var(--font-mono); }
.wv-head input, .wv-head select, .wv-head button { background: rgba(255,255,255,.04); border: 1px solid var(--cyan-line); color: var(--text); border-radius: 3px; padding: 6px 9px; font-size: 12px; }
.wv-head select { color-scheme: dark; }
.wv-head select option { background: #14141a; color: #e2e8f0; }
[data-theme="light"] .wv-head select { color-scheme: light; }
[data-theme="light"] .wv-head select option { background: #ffffff; color: #0f172a; }
.sortable { cursor: pointer; user-select: none; }
.sortable:hover { color: var(--cyan); }
.wv-head button.danger, .wv-actions button.danger { color: var(--red); border-color: rgba(239,68,68,.35); }
.wv-head button.danger:disabled { opacity: .35; }
.wv-search { min-width: 180px; }
.wv-head button { cursor: pointer; }
.wv-head button:disabled { opacity: .4; cursor: not-allowed; }
.wv-primary { background: rgba(34,211,238,.12) !important; color: var(--cyan) !important; border-color: rgba(34,211,238,.5) !important; }
.wv-rows { flex: 1; overflow: auto; }
.wv-row { display: grid; grid-template-columns: 34px minmax(140px,1.1fr) minmax(160px,1.5fr) 78px 70px 62px 84px 50px 54px 90px 220px; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid rgba(148,163,184,.10); font-size: 12px; min-width: 1180px; }
.wv-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-dim); white-space: nowrap; }
.wv-meta.bad { color: var(--red); }
@media (max-width: 1560px) {
  .wv-row { grid-template-columns: 34px minmax(130px,1.1fr) minmax(150px,1.5fr) 74px 66px 58px 80px 46px 50px 200px; min-width: 1040px; }
  .c-updated { display: none; }
}
@media (max-width: 1360px) {
  .wv-row { grid-template-columns: 34px minmax(120px,1.1fr) minmax(140px,1.5fr) 70px 64px 56px 76px 46px 190px; min-width: 960px; }
  .c-ix { display: none; }
}
@media (max-width: 1180px) {
  .wv-row { grid-template-columns: 34px minmax(110px,1.1fr) minmax(130px,1.5fr) 64px 60px 52px 70px 180px; min-width: 860px; }
  .c-assets { display: none; }
}
@media (max-width: 1024px) {
  .wv-row { grid-template-columns: 30px minmax(100px,1.1fr) minmax(120px,1.4fr) 58px 54px 48px 160px; min-width: 760px; }
  .c-type { display: none; }
}
.dock-quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.dock-quick a { color: var(--cyan); border: 1px solid var(--cyan-line); border-radius: 3px; padding: 5px 10px; font-size: 12px; text-decoration: none; }
.dock-quick a:hover { background: rgba(34, 211, 238, .08); }
.matrix-run { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.report-card select { background: rgba(255,255,255,.04); border: 1px solid var(--cyan-line); color: var(--text); border-radius: 3px; padding: 6px 9px; font-size: 12px; color-scheme: dark; }
.report-card select option { background: #14141a; color: #e2e8f0; }
[data-theme="light"] .report-card select { background: #fff; color-scheme: light; }
[data-theme="light"] .report-card select option { background: #fff; color: #0f172a; }
.q-list { margin-top: 8px; }
.q-row { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px dashed rgba(148,163,184,.14); font-size: 12px; }
.q-k { width: 120px; color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; flex-shrink: 0; }
.q-v { color: var(--text-dim); word-break: break-all; }
.q-v.ok { color: var(--green); }
.q-v.mid { color: var(--amber); }
.q-v.bad { color: var(--red); }
[data-theme="light"] .wv-th,
[data-theme="light"] .asset-th { background: rgba(255, 255, 255, .96); color: var(--text-dim); }
[data-theme="light"] .wv-head input,
[data-theme="light"] .wv-head select,
[data-theme="light"] .wv-head button { background: #ffffff; }
[data-theme="light"] .view-nav.hud-panel { background: #ffffff; }
.wv-row:hover { background: rgba(34,211,238,.05); }
.wv-th { position: sticky; top: 0; background: rgba(11,11,16,.95); color: var(--text-faint); font-size: 10.5px; letter-spacing: .12em; z-index: 1; }
.wv-url { color: var(--cyan); font-family: var(--font-mono); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wv-title { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wv-type { font-size: 11px; }
.wv-state { font-size: 11px; }
.wv-state.done { color: var(--green); }
.wv-state.running { color: var(--amber); }
.wv-state.failed { color: var(--red); }
.wv-state.idle { color: var(--text-faint); }
.wv-score { font-family: var(--font-mono); color: var(--text-dim); }
.wv-score i { font-style: normal; margin-left: 4px; font-size: 10.5px; }
.wv-score .min-mid { color: var(--amber); }
.wv-score .min-bad { color: var(--red); }
.wv-actions { display: flex; gap: 6px; }
.wv-actions a, .wv-actions button { color: var(--text-dim); background: none; border: 1px solid rgba(148,163,184,.25); border-radius: 3px; padding: 3px 7px; font-size: 11px; text-decoration: none; cursor: pointer; }
.wv-actions a:hover, .wv-actions button:hover { color: var(--cyan); border-color: var(--cyan-dim); }
.wv-actions button:disabled { opacity: .35; cursor: not-allowed; }
.wv-empty { padding: 40px; text-align: center; color: var(--text-faint); font-size: 13px; }
.job-row { grid-template-columns: minmax(160px,1.2fr) 90px 80px 80px 130px 1fr; }
.job-name { color: var(--text); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-kind { color: var(--violet); font-size: 11px; }
.job-time { color: var(--text-faint); font-family: var(--font-mono); font-size: 11px; }
.job-error { color: var(--red); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-row.history { opacity: .82; }
.wv-sub { padding: 10px 14px 6px; color: var(--text-faint); font-size: 10.5px; letter-spacing: .14em; font-family: var(--font-mono); border-top: 1px solid rgba(148,163,184,.15); }
.reports-grid { position: fixed; left: 24px; right: 24px; top: 96px; bottom: 86px; z-index: 7; display: grid; grid-template-columns: repeat(auto-fit,minmax(240px,1fr)); gap: 14px; align-content: start; }
.report-card { padding: 16px; }
.report-card h3 { margin: 0 0 8px; font-size: 15px; }
.report-card p { color: var(--text-dim); font-size: 12px; min-height: 34px; margin: 0 0 12px; }
.report-card a, .report-card button { display: inline-block; color: var(--cyan); border: 1px solid var(--cyan-line); background: rgba(34,211,238,.06); border-radius: 3px; padding: 6px 12px; font-size: 12px; text-decoration: none; cursor: pointer; }
.reports-grid { overflow: auto; grid-auto-rows: min-content; align-content: start; }
.report-wide { grid-column: 1 / -1; }
.report-list { display: flex; flex-wrap: wrap; gap: 8px; }
.report-list a { margin: 0; }
.asset-table { display: flex; flex-direction: column; max-height: 320px; overflow: auto; }
.asset-row { display: grid; grid-template-columns: 110px 70px 80px 1fr 60px; gap: 8px; padding: 5px 6px; border-bottom: 1px solid rgba(148,163,184,.10); font-size: 11.5px; align-items: center; }
.asset-th { color: var(--text-faint); font-family: var(--font-mono); letter-spacing: .08em; position: sticky; top: 0; background: rgba(11,11,16,.95); }
.asset-path { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); }
.settings-grid { padding: 16px; display: flex; flex-direction: column; gap: 12px; max-width: 760px; }
.set-row { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text-dim); }
.set-row > span { width: 110px; }
.set-row input:not([type=checkbox]) { background: rgba(255,255,255,.04); border: 1px solid var(--cyan-line); color: var(--text); border-radius: 3px; padding: 6px 9px; min-width: 280px; }
.set-row button { background: rgba(34,211,238,.10); border: 1px solid var(--cyan-line); color: var(--cyan); border-radius: 3px; padding: 6px 12px; cursor: pointer; }
.set-note { color: var(--text-faint); font-size: 11.5px; line-height: 1.8; border-top: 1px dashed var(--cyan-line); padding-top: 12px; }
.view-nav { position: fixed; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 12; display: flex; padding: 4px; gap: 2px; }
.view-nav button { display: flex; flex-direction: column; align-items: center; gap: 1px; min-width: 62px; padding: 5px 8px; background: none; border: 0; color: var(--text-faint); cursor: pointer; border-radius: 3px; }
.view-nav button b { font-size: 13px; }
.view-nav button span { font-size: 10px; letter-spacing: .1em; }
.view-nav button.on { color: var(--cyan); background: rgba(34,211,238,.10); }
.view-nav button:hover { color: var(--text); }
.keys { bottom: 76px !important; }

/* 移动端（≤768px）：单列卡片 + 底部抽屉，保证每台设备都能用 */
@media (max-width: 768px) {
  .hud { left: 12px; right: 12px; top: 10px; display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; }
  .brand { font-size: 15px; letter-spacing: .22em; }
  .brand-sub, .hud-rule { display: none; }
  .stats { gap: 14px; }
  .stat b { font-size: 16px; }
  .stat i { font-size: 8.5px; letter-spacing: .14em; }
  .status { position: fixed; left: 12px; right: 12px; bottom: 74px; margin: 0; text-align: center; font-size: 10.5px; letter-spacing: .12em; z-index: 13; }
  .seek { top: 54px; left: 12px; right: 12px; transform: none; }
  .seek input { width: auto; flex: 1; min-width: 0; font-size: 13px; padding: 10px; }
  .seek button { padding: 0 14px; letter-spacing: .12em; }
  .theme-btn { padding: 0 4px 0 8px; }
  .sites { top: 102px; left: 12px; right: 12px; transform: none; flex-wrap: nowrap; justify-content: flex-start; overflow-x: auto; padding-bottom: 2px; max-width: none; scrollbar-width: none; }
  .sites::-webkit-scrollbar { display: none; }
  .sites-label { display: none; }
  .site-btn, .site-del { flex: 0 0 auto; }
  .panel { left: 12px; right: 12px; bottom: 66px; width: auto; max-height: 42vh; overflow-y: auto; }
  .panel-open { left: 12px; bottom: 70px; }
  .keys, .archive-link, .audit-link { display: none; }
  .task-center { left: 12px; right: 12px; bottom: 66px; width: auto; }
  .toast { bottom: 74px; left: 12px; right: 12px; transform: none; text-align: center; font-size: 12px; z-index: 14; }
  .dock { left: 0; right: 0; width: auto; min-width: 0; padding: 16px 14px 92px; }
  .work-view { left: 0; right: 0; top: 144px; bottom: 64px; }
  .wv-head { gap: 8px; padding: 10px 12px; }
  .wv-head b { flex: 1 1 100%; }
  .wv-stat { flex: 1 1 100%; }
  .wv-search { flex: 1 1 100%; min-width: 0; }
  .wv-close { margin-left: 0; }
  .wv-rows { padding-bottom: 8px; }
  .wv-row { display: flex; flex-wrap: wrap; gap: 6px 12px; min-width: 0; padding: 10px 12px; }
  .wv-row.wv-th { display: none; }
  .wv-row .c-check { order: 1; }
  .wv-row .c-path { order: 2; flex: 1 1 calc(100% - 34px); }
  .wv-row .c-title { order: 3; flex: 1 1 100%; white-space: normal; }
  .wv-row .c-state { order: 4; }
  .wv-row .c-score { order: 5; }
  .wv-row .c-gaps { order: 6; display: block; }
  .wv-row .c-type { order: 7; display: block; }
  .wv-row .c-assets { order: 8; display: block; }
  .wv-row .c-actions { order: 9; flex: 1 1 100%; margin-top: 2px; }
  .wv-row .c-score::before { content: '视觉 '; color: var(--text-faint); }
  .wv-row .c-gaps::before { content: '缺口 '; color: var(--text-faint); }
  .wv-row .c-assets::before { content: '资产 '; color: var(--text-faint); }
  .wv-row .c-type::before { content: '类型 '; color: var(--text-faint); }
  .job-row { display: flex; }
  .job-row .job-name { flex: 1 1 100%; }
  .reports-grid { left: 12px; right: 12px; top: 144px; bottom: 64px; grid-template-columns: 1fr; }
  .settings-grid { padding: 12px; }
  .set-row { flex-wrap: wrap; }
  .set-row > span { width: 100%; }
  .set-row input:not([type=checkbox]) { min-width: 0; flex: 1 1 100%; }
  .view-nav button { min-width: 56px; padding: 5px 4px; }
}
</style>
