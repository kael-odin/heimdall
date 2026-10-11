<script setup>
/**
 * Atlas — 全站星图（3D 力导向，graphify 同款形态）
 *
 * 静态模式：读已有 /<host>/recon/atlas.json（或从站点切换器载入任意已侦察站）
 * live 模式：POST /api/recon → SSE 事件流 → 节点逐个弹入生长
 * 点星球 = 克隆该页；「克隆内环」= 批量并行
 */
import { onMounted, onBeforeUnmount, ref, reactive, computed, watch, defineAsyncComponent, h } from 'vue';
/**
 * 星图渲染层异步加载。
 *
 * 3d-force-graph + three 占了整包的绝大部分（实测未拆分时 1553KB / gzip 422KB，
 * 而其余全部代码加起来不到 90KB）。静态 import 会让**整个控制台**等它下载完才能交互。
 *
 * 两个实际收益：
 *  ① 应用外壳（站点条、导航、报告/设置页）先可用，星图后到；
 *  ② three 那部分被拆成独立 chunk，改控制台代码重建时不会连带重下 1.2MB
 *     —— 对一个天天重建的开发工具，这是每天都省的时间。
 */
const Graph3D = defineAsyncComponent({
  loader: () => import('./Graph3D.vue'),
  // 慢网络下 1.4MB 的 chunk 要几秒才到；没有占位就是一段纯黑，看起来像坏了。
  // 用 h() 而不是内联 template —— Vue 的 runtime-only 构建不含模板编译器，
  // 内联 template 在这里会静默失效。
  loadingComponent: { render: () => h('div', { class: 'g3d-loading' }, '星图渲染层加载中（three.js 按需加载，约 1.4MB）…') },
  delay: 120,     // 120ms 内到货就不闪占位
  timeout: 30000,
});
import SitePicker from './SitePicker.vue';
import Icon from './Icon.vue';
import JobsView from './JobsView.vue';
import PagesView from './PagesView.vue';
import StorageCard from './StorageCard.vue';
import AssetTable from './AssetTable.vue';
import DetailDock from './DetailDock.vue';
import { API, apiHeaders, apiJson, wsUrl, wsJson } from './api.js';
import { taskState, taskLabel, fmtTime, fmtDate, fmtBytes, fmtDuration } from './format.js';
import { pageNameOf, liveUrl } from './pages.js';

import { PAGE_TYPES as PT, typeColor, typeCn } from './types.js';
const PAGE_TYPES = PT;
const typeColorThemed = (t) => typeColor(t, theme.value);

// 星图节点/图例共用的色板，跟随主题。
// 必须跟着主题走：画布底色就是 --bg，浅色主题下画布是象牙白，
// 而深色色板是给暖炭画布挑的 —— 实测 15 个色在浅色画布上有 12 个低于 3:1
// （最差的 #FBBF24 只有 1.54:1），节点基本看不见，而节点是星图视图的主导航。
// 交给 Graph3D 一个 palette 对象而不是把颜色烤进节点：
// 主题切换时节点不需要重建，只需重喂一次 graphData。
const graphPalette = computed(() => ({
  types: Object.fromEntries(Object.keys(PAGE_TYPES).map(k => [k, typeColorThemed(k)])),
  running: theme.value === 'light' ? '#8A6420' : '#D9A05B',     // 与 --warn 同值
  fallback: typeColorThemed('generic'),
  synthetic: theme.value === 'light' ? '#6E6C64' : '#94918A',   // 与 --text-faint 同值
  link: theme.value === 'light' ? 'rgba(25,25,25,0.22)' : 'rgba(245,244,239,0.18)',
}));

const host = ref('');   // 当前站点：由「已侦察站点」列表决定，不再写死默认站点
const atlas = ref(null);
const live = ref(false);
const statusText = ref('');
const errMsg = ref('');
// 任务中心：每个 forge 任务独立对象 + 独立 EventSource（修复并发克隆单例覆盖）
const tasks = reactive([]);
const activeTaskId = ref(null);
const forge = computed(() => tasks.find(t => t.localId === activeTaskId.value && t.kind !== 'clone') ?? null);
const taskSources = new Map();
const tasksOpen = ref(true);
const auditReport = ref(null);   // 最近一次 SEO 审计结果（报告入口）
const watchReport = ref(null);   // 最近一次变更监控结果（报告入口）
const okMsg = ref('');           // 成功提示（绿色 toast，与错误提示区分）
/** 子组件上报"做完了"，统一走这里出提示（组件不直接碰父组件的 toast 状态） */
function toast(msg, ms = 4000) {
  okMsg.value = msg;
  setTimeout(() => { if (okMsg.value === msg) okMsg.value = ''; }, ms);
}
const jobHistory = ref([]);      // 引擎持久化的历史任务（/api/jobs.history）
const reportIndex = ref([]);     // 可用报告索引（/api/reports/:host）
const liveHealth = ref(null);    // 最新活镜像体检（/api/live-health/:host，导出时生成）
const lastVerify = ref(null);    // 最近一次全站体检结果（/api/verify）
const liveRebuild = ref(false);  // 导出活镜像前先重建 live 页面
const liveHealthHost = ref('');   // liveHealth 对应的 host（切站后避免串数据）
const assetAuditReport = ref(null); // 最近一次资产缺口扫描结果
const matrixPeer = ref('');          // 跨站对标对象
const matrixReport = ref(null);      // 最近一次对标矩阵报告
const llmStatus = ref(null);     // 模型服务状态（/api/settings/llm，不含 Key）
const llmTest = ref(null);       // 最近一次连接测试结果
const llmTesting = ref(false);
const llmSaving = ref(false);
const llmSaveMsg = ref('');
// 表单草稿：保存前可先「测试连接」验证；apiKey 留空 = 不修改已保存的 Key
const llmForm = ref({ enabled: true, protocol: 'chat', baseUrl: '', apiKey: '', model: '', fastModel: '', timeoutMs: 180000, retries: 3 });

// 预设只是「起点」：一键填好协议与端点，模型名以服务商当前文档为准，填完请先点「测试连接」
const LLM_PRESETS = [
  { name: 'OpenAI', protocol: 'chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', fastModel: 'gpt-4o-mini' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', fastModel: 'claude-haiku-5-5' },
  { name: 'DeepSeek', protocol: 'chat', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', fastModel: 'deepseek-chat' },
  { name: 'OpenRouter', protocol: 'chat', baseUrl: 'https://openrouter.ai/api/v1', model: '', fastModel: '' },
  { name: '本地 Ollama', protocol: 'chat', baseUrl: 'http://127.0.0.1:11434/v1', model: '', fastModel: '' },
  { name: '自建中转', protocol: 'chat', baseUrl: '', model: '', fastModel: '' },
];
const tokenOf = () => localStorage.getItem('heimdall-token') ?? '';
function sseUrl(taskId) { const t = tokenOf(); return `${API}/api/events?task=${taskId}${t ? '&token=' + encodeURIComponent(t) : ''}`; }
const hudPages = ref(0);
const hudEdges = ref(0);
const hudEdgesRendered = ref(0);
const hudOrigin = ref('');
const sites = ref([]);          // 已侦察站点清单（/api/sites）
const engine = ref({ ok: false, recon: null, forge: null });   // 引擎状态灯
const autoRotate = ref(true);   // 星图自转开关
const showPanel = ref(typeof window === 'undefined' || window.innerWidth > 768);    // 左侧仪表面板折叠（小屏默认收起）
/** 批量克隆：ids 由 PagesView 的勾选状态提供（勾选状态现在归它自己管） */
async function forgeChecked(ids) {
  const targets = nodes.filter(n => ids.includes(n.id) && n.forgeState !== 'done');
  statusText.value = `清单克隆 ${targets.length} 页`;
  const q = [...targets]; let done = 0;
  const worker = async () => { while (q.length) { const n = q.shift(); await startForge(n); done++; statusText.value = `清单克隆 ${done}/${targets.length}`; } };
  await Promise.all([worker(), worker()]);
  statusText.value = '清单克隆完成';
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
// 详情面板（.dock）是否占着右侧。它是 fixed 全高的右侧 32% 面板，
// 会盖住右下角 z-index 更低的 .archive-link（实测 154×32 完全覆盖），
// 所以那个链接在面板打开时必须让位 —— 否则它在用户浏览页面期间完全点不到。
const dockOpen = computed(() => !!selected.value && (view.value === 'atlas' || view.value === 'pages'));
const detailIntel = ref(null);       // 已锻页 intel.json
const detailScore = ref(null);       // 已锻页 score.json
const detailSeo = computed(() => selected.value?.seoLite ?? null);

// ---------- 工作台视图（v2）：星图 / 页面 / 任务 / 报告 / 设置 ----------
const view = ref('atlas');
const VIEWS = [
  { id: 'atlas', icon: '✦', label: '星图' },
  { id: 'pages', icon: '▤', label: '页面' },
  { id: 'jobs', icon: '◷', label: '任务' },
  { id: 'reports', icon: '▦', label: '报告' },
  { id: 'settings', icon: '⚙', label: '设置' },
];
const tableNodes = ref([]);                       // 页面表格的响应式快照（含孤儿已克隆页）
const extraNodes = ref([]);                       // 已克隆但不在 atlas 中的页面（补全清单）
const pageScores = reactive({});                  // nodeId -> score.json（懒加载）
const pageVerify = reactive({});                  // nodeId -> verify.json（多视口，懒加载）
const pageMeta = reactive({});                    // nodeId -> { assets, visualGaps, interactions, updatedAt }
const tokenInput = ref(localStorage.getItem('heimdall-token') ?? '');
const apiBaseInput = ref(localStorage.getItem('heimdall-api') ?? API);
// 「克隆档案」卡片用（报告页）。PagesView 里那份是它自己的，两者数据源相同但各自持有 ——
// 卡片只需要两个数字，为它把 PagesView 的 props 反向暴露出去并不划算。
// 报告页已有专属卡片的报告 id —— 不能让它们在"设计资产"里再出现一遍
const CARDED_REPORTS = new Set(['archive', 'compare', 'seo', 'watch', 'assets', 'intel', 'verify']);
const designReports = computed(() => reportIndex.value.filter(r => r.available && !CARDED_REPORTS.has(r.id)));

// 「克隆档案」卡片用（报告页）。PagesView 里那份是它自己的，两者数据源相同但各自持有 ——
// 卡片只需要两个数字，为它把 PagesView 的 props 反向暴露出去并不划算。
const doneCount = computed(() => tableNodes.value.filter(n => n.forgeState === 'done').length);
const avgVisual = computed(() => {
  const vals = Object.values(pageScores).filter(s => s && typeof s.pixel === 'number').map(s => s.pixel);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(1) + '%' : '—';
});
/** 清单数据刷新：一次 /api/pages 请求拿全（分数/资产/缺口/交互/最差视口）。
 *  此前这里还有一条逐页拉 score.json + verify.json 的路径（80 页 = 160 请求），
 *  而分数本就包含在 /api/pages 的响应里 —— 已删除。 */
function scheduleScoreLoad() { clearTimeout(scoreLoadTimer); scoreLoadTimer = setTimeout(loadPageStatus, 400); }
let scoreLoadTimer = null;

function openDetail(n) { view.value = 'pages'; onNodeClick(n); }
function selectView(id) {
  if (id === 'pages' && view.value === 'pages') { view.value = 'atlas'; return; }   // 再次点击 = 收起
  view.value = id;
  if (id === 'jobs') loadJobHistory();
  if (id === 'reports') { loadReports(); loadLiveHealth(); loadVerifySummary(); }   // 存储/资产卡片挂在报告页，v-if 挂载时自己拉数据
  if (id === 'settings') loadLlm();
}
function togglePages() { if (view.value === 'pages') view.value = 'atlas'; else { view.value = 'pages'; loadPageStatus(); } }
/** 工作视图表头的站点切换（SitePicker emit） */
function pickSiteByHost(h) {
  const s = sites.value.find(x => x.host === h);
  if (s) pickSite(s);
  else { host.value = h; }
}
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
async function removeChecked(ids) {
  const targets = tableNodes.value.filter(n => ids.includes(n.id) && n.forgeState !== 'running');
  if (!targets.length) return;
  if (!confirm('移除选中 ' + targets.length + ' 个页面？\n将删除克隆产物并从星图移除节点（CAS 资产保留）。')) return;
  let ok = 0, fail = 0;
  for (const n of targets) { try { await removePageNode(n); ok++; } catch { fail++; } }
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
        // 视觉列的最差视口也来自这一条响应（引擎已把 verify.json 的两项一起给出）。
        // 此前是逐页再发 score.json + verify.json 两个请求 —— 80 页就是 160 个，
        // 而分数本来就包含在这条响应里，等于白拉了一遍。
        pageVerify[n.id] = hit.minViewport ? { minViewport: hit.minViewport } : null;
        pageMeta[n.id] = { assets: hit.assets ?? null, visualGaps: hit.visualGaps ?? null, interactions: hit.interactions ?? null, updatedAt: hit.updatedAt ?? null };
      }
    }
    // 补全：已克隆但不在 atlas 中的页面（例如 recon 截断、删过节点），保证清单是"完全体"
    extraNodes.value = pages.filter(p => !matchedNames.has(p.name)).map(p => {
      let path = p.target;
      try { path = new URL(p.target).pathname || '/'; } catch {}
      return { id: 'forged:' + p.name, url: p.target, path, title: p.target, type: 'generic', depth: 99, ring: 3, forgeState: 'done', synthetic: true, pageName: p.name };
    });
    for (const n of extraNodes.value) {
      const hit = pages.find(p => p.name === n.pageName);
      pageScores[n.id] = hit?.score ?? null;
      pageVerify[n.id] = hit?.minViewport ? { minViewport: hit.minViewport } : null;
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
/**
 * 站点 chip 上的角标。此前是 `61F` —— F 指 forged（克隆），
 * 但没人能从界面上知道这一点。改成"已克隆/已发现"的分数形式。
 * 只克隆过、没做全站侦察的站点单列（那是另一条路径，不是没做完）。
 */
function siteBadge(s) {
  if (s.status === 'partial') return s.forged + ' 页';
  if (!s.pages) return '空';
  return s.forged + '/' + s.pages;
}
function siteTitle(s) {
  if (s.status === 'partial') return `${s.forged} 页已克隆 · 未做全站侦察（点开看页面清单；侦察后才有星图）`;
  if (!s.pages) return '侦察结果为空（失败或没有可用页面）';
  const behind = s.pages - s.forged;
  return `${s.forged}/${s.pages} 页已克隆${behind > 0 ? `，还差 ${behind} 页` : '，全部完成'}`;
}

function pickSite(s) {
  if (!s) return;
  host.value = s.host;
  selected.value = null;
  detailIntel.value = null; detailScore.value = null;
  // 站点可能只有克隆、没有全站侦察（用户直接 `forge <url>` 克隆单页 ——
  // 这正是"一次性便利"的主路径）。那种情况下没有 atlas.json 可读，
  // 但 /api/pages/<host> 仍然能列出已克隆的页面，所以退到"只有清单"而不是报错：
  // 站点出现在列表里却点不动，比不出现更让人困惑。
  fetch(wsUrl(s.host, 'recon/atlas.json'))
    .then(r => (r.ok ? r.json() : null))
    .then(async (a) => {
      if (a) { buildStatic(a); loadPageStatus(); return; }
      buildStatic({ origin: s.origin ?? ('https://' + s.host), nodes: [], edges: [], meta: { pages: 0, edges: 0 } });
      await loadPageStatus();
      view.value = 'pages';    // 没有星图可看，直接把清单摆出来
      okMsg.value = '该站点只有克隆页面、尚未全站侦察；已显示页面清单。侦察后可获得星图与全站视图。';
      setTimeout(() => { okMsg.value = ''; }, 6000);
    })
    .catch(e => { errMsg.value = String(e); });
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
    statusText.value = '克隆中 · ' + pageName;
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
              wsJson(host.value, 'pages/' + task.pageName + '/intel/intel.json').then(j => { if (j) task.intel = { headings: j.headings?.length ?? 0, prices: j.prices?.length ?? 0, cta: j.cta?.length ?? 0, links: j.links?.length ?? 0 }; });
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

/** 模型服务：读取 / 测试（草稿，不落盘）/ 保存（写 core/.env，保存即生效） */
async function loadLlm() {
  try {
    const r = await fetch(API + '/api/settings/llm', { headers: apiHeaders() });
    if (!r.ok) return;
    llmStatus.value = await r.json();
    syncLlmForm();
  } catch { /* 引擎离线时静默 */ }
}
function syncLlmForm() {
  const s = llmStatus.value;
  if (!s) return;
  llmForm.value = {
    enabled: !!s.enabled, protocol: s.protocol || 'chat', baseUrl: s.baseUrl || '',
    apiKey: '',                       // 永不回显 Key
    model: s.model || '', fastModel: s.fastModel || '',
    timeoutMs: s.timeoutMs || 180000, retries: s.retries || 3,
  };
}
function applyLlmPreset(p) {
  llmForm.value = {
    ...llmForm.value,
    protocol: p.protocol,
    baseUrl: p.baseUrl,
    model: p.model || llmForm.value.model,
    fastModel: p.fastModel || '',
  };
  llmTest.value = null; llmSaveMsg.value = '';
}
async function testLlm() {
  llmTesting.value = true; llmTest.value = null; llmSaveMsg.value = '';
  try {
    const f = llmForm.value;
    const body = { protocol: f.protocol, baseUrl: f.baseUrl, model: f.model };
    if (f.apiKey) body.apiKey = f.apiKey;    // 留空 = 用已保存的 Key 测
    const r = await fetch(API + '/api/llm/test', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    llmTest.value = await r.json();
  } catch (e) { llmTest.value = { ok: false, error: String(e).slice(0, 200) }; }
  finally { llmTesting.value = false; }
}
async function saveLlm() {
  llmSaving.value = true; llmSaveMsg.value = '';
  try {
    const f = llmForm.value;
    const body = {
      enabled: f.enabled, protocol: f.protocol, baseUrl: f.baseUrl, model: f.model,
      fastModel: f.fastModel, timeoutMs: Number(f.timeoutMs), retries: Number(f.retries),
    };
    if (f.apiKey) body.apiKey = f.apiKey;
    const r = await fetch(API + '/api/settings/llm', { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      llmStatus.value = j.settings ?? llmStatus.value;
      syncLlmForm();
      llmSaveMsg.value = '✓ 已保存并生效（无需重启引擎）';
      okMsg.value = '模型服务已保存';
    } else {
      llmSaveMsg.value = '✗ 保存失败：' + (j.error || ('HTTP ' + r.status));
    }
  } catch (e) { llmSaveMsg.value = '✗ 保存失败：' + String(e).slice(0, 160); }
  finally { llmSaving.value = false; }
}

/** 报告索引 + 资产清单（报告页使用） */
async function loadLiveHealth() {
  try {
    const r = await fetch(API + '/api/live-health/' + encodeURIComponent(host.value), { headers: apiHeaders() });
    liveHealth.value = r.ok ? await r.json() : null;
  } catch { liveHealth.value = null; }
}
async function loadVerifySummary() {
  try {
    const r = await fetch('/static/' + host.value + '/verify/verify-summary.json');
    if (!r.ok) { lastVerify.value = null; return; }
    const j = await r.json();
    lastVerify.value = { host: host.value, pages: j.pages?.length ?? 0, average: ((j.average ?? 0) * 100).toFixed(1), worst: j.worst ?? null };
  } catch { lastVerify.value = null; }
}
async function loadReports() {
  try { const r = await fetch(API + '/api/reports/' + host.value); if (r.ok) reportIndex.value = (await r.json()).reports ?? []; } catch {}
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
          close(); loadReports();
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

/** 多视口体检：引擎 verify 任务（--all 或单页；minViewport 告警口径） */
function runVerify(page) {
  const task = reactive({
    localId: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'verify', label: page ? ('多视口体检 · ' + page) : ('全站体检 · ' + host.value), url: atlas.value?.origin ?? ('https://' + host.value),
    done: false, failed: false, error: null, verifyAverage: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = page ? ('体检 ' + page + ' · 截图中') : '全站体检 · 准备中';
  (async () => {
    try {
      const r = await fetch(API + '/api/verify', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: host.value, page: page || undefined, maxPages: 30 }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '体检失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'verify-page') {
          const pct = (ev.overall * 100).toFixed(1);
          const min = ev.minViewport ? (' · 最低 ' + ev.minViewport.name + ' ' + (ev.minViewport.score * 100).toFixed(1) + '%') : '';
          statusText.value = '体检 ' + ev.page + ' · ' + pct + '%' + min;
        } else if (ev.kind === 'verify-done') {
          task.done = true; task.endedAt = Date.now(); task.verifyAverage = ev.average;
          lastVerify.value = { host: host.value, pages: ev.pages, average: (ev.average * 100).toFixed(1) };
          loadVerifySummary();
          statusText.value = '体检完成 · ' + ev.pages + ' 页 · 平均 ' + (ev.average * 100).toFixed(1) + '%';
          close(); scheduleScoreLoad(); loadReports();
          setTimeout(() => { statusText.value = ''; }, 5000);
        } else if (ev.kind === 'verify-error') {
          statusText.value = '体检告警 · ' + ev.page + ' ' + (ev.error || '');
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断'; close();
        }
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) { task.failed = true; task.done = true; task.error = String(e); errMsg.value = String(e); }
  })();
}
function runResponsiveUpgrade() {
  const task = reactive({
    localId: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'upgrade', label: '响应式升级 · ' + host.value, url: atlas.value?.origin ?? ('https://' + host.value),
    done: false, failed: false, error: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '响应式升级 · 低分页批量处理（快照→构建→verify，提升才保留）';
  (async () => {
    try {
      const r = await fetch(API + '/api/responsive-upgrade', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: host.value, threshold: 0.97, max: 8 }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '响应式升级失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'upgrade-page') statusText.value = '响应式升级 · ' + ev.page + ' · ' + (ev.kept ? '保留' : '回退');
        else if (ev.kind === 'exit') {
          task.done = true; task.endedAt = Date.now();
          if (ev.status === 'done') { statusText.value = '响应式升级完成'; loadVerifySummary(); scheduleScoreLoad(); }
          else { task.failed = true; task.error = '升级任务失败'; errMsg.value = '响应式升级失败，见任务日志'; }
          close(); setTimeout(() => { statusText.value = ''; }, 5000);
        }
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) { task.failed = true; task.done = true; task.error = String(e); errMsg.value = String(e); }
  })();
}
function runVerifyAll() { runVerify(null); }
function runVerifyPage() { const n = selected.value; if (n) runVerify(pageNameOf(n)); }

/** 活镜像导出：引擎 live 任务（离线 + mirror + heal + materialize） */
function runLiveExport() {
  const task = reactive({
    localId: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'live', label: '活镜像导出 · ' + host.value, url: atlas.value?.origin ?? ('https://' + host.value),
    done: false, failed: false, error: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '活镜像导出中 · 约 2-5 分钟（HAR 合并 + 图片本地化 + 体检）';
  (async () => {
    try {
      const r = await fetch(API + '/api/live-export', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: host.value, root: 'mirror', rebuild: liveRebuild.value }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '活镜像导出失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'exit') {
          task.done = true; task.endedAt = Date.now();
          if (ev.status === 'done') { statusText.value = '活镜像导出完成 · 已生成离线完整包'; loadLiveHealth(); loadReports(); }
          else { task.failed = true; task.error = '导出失败（见 health.json / 任务日志）'; errMsg.value = '活镜像导出失败，查看任务日志'; }
          close(); setTimeout(() => { statusText.value = ''; }, 5000);
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
  statusText.value = `全境克隆 ${targets.length} 页`;
  let done = 0;
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const n = queue.shift();
      await startForge(n);
      done++;
      statusText.value = `全境克隆 ${done}/${targets.length}`;
    }
  };
  await Promise.all([worker(), worker()]);
  statusText.value = '全境克隆完成';
  setTimeout(() => { statusText.value = ''; }, 3000);
}

/** 整站克隆 —— 交给引擎跑批量队列，而不是用浏览器标签页驱动。
 * 关掉控制台页面任务照跑；并发与单页熔断按站点配方走；控制台只订阅进度。 */
function startCloneSite({ incremental = false } = {}) {
  return new Promise((resolve) => {
    const h = host.value;
    const task = reactive({
      localId: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: 'clone', taskId: null, host: h,
      label: (incremental ? '增量克隆 · ' : '整站克隆 · ') + h,
      progress: '', done: false, failed: false, killed: null, error: null,
      startedAt: Date.now(), endedAt: null,
    });
    tasks.push(task);
    while (tasks.length > 20) tasks.shift();
    activeTaskId.value = task.localId;
    statusText.value = task.label + ' · 准备中';
    (async () => {
      try {
        const r = await fetch(`${API}/api/clone-site`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: h, incremental }) });
        const body = await r.json();
        if (body.error) {
          task.failed = true; task.done = true; task.endedAt = Date.now();
          task.error = body.error === 'busy' ? '已有整站克隆在运行' : body.error;
          statusText.value = '整站克隆：' + task.error;
          setTimeout(() => { statusText.value = ''; }, 4000);
          return resolve();
        }
        task.taskId = body.taskId;
        const es = new EventSource(sseUrl(body.taskId));
        taskSources.set(task.localId, es);
        const closeTask = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
        es.onmessage = (m) => {
          let ev; try { ev = JSON.parse(m.data); } catch { return; }
          if (ev.kind === 'queue-start') task.progress = `0/${ev.pending}`;
          else if (ev.kind === 'queue-progress' && ev.phase === 'check') task.progress = `校验 ${ev.done}/${ev.total}`;
          else if (ev.kind === 'queue-progress' && ev.phase === 'check-done') task.progress = `变了 ${ev.changed} · 未变 ${ev.same}`;
          else if (ev.kind === 'queue-page' && ev.status !== 'running') task.progress = `${ev.done}/${ev.total}`;
          else if (ev.kind === 'queue-complete') task.progress = `${ev.done}/${ev.total}`;
          else if (ev.kind === 'exit') {
            task.done = ev.status === 'done';
            task.killed = ev.killed ?? null;
            task.failed = ev.status !== 'done' && ev.status !== 'cancelled';
            task.endedAt = Date.now();
            closeTask();
            statusText.value = task.done ? `整站克隆完成${task.progress ? ' · ' + task.progress : ''}` : (ev.status === 'cancelled' ? '整站克隆已取消' : '整站克隆中断');
            loadPageStatus();                                  // 刷新页面清单上的铸造状态
            setTimeout(() => { statusText.value = ''; }, 4000);
            resolve();
          }
        };
        es.onerror = () => { closeTask(); if (!task.done) { task.failed = true; task.done = true; task.error = '事件流中断'; resolve(); } };
      } catch (e) {
        task.failed = true; task.done = true; task.error = String(e);
        statusText.value = String(e);
        resolve();
      }
    })();
  });
}

function onNodeClick(node) {
  if (!node?.url) return;
  selected.value = node;                      // 点星 = 选中，打开详情剖析面板
  activeTaskId.value = null;                   // 关闭旧克隆视图（后台任务继续跑）
  detailIntel.value = null; detailScore.value = null;
  const pageName = node.path === '/' ? 'home' : node.path.replace(/^\//, '').replace(/\//g, '-');
  wsJson(host.value, 'pages/' + pageName + '/intel/intel.json').then(j => { if (j && selected.value === node) detailIntel.value = j; });
  wsJson(host.value, 'pages/' + pageName + '/score.json').then(j => { if (j && selected.value === node) detailScore.value = j; });
}

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (selected.value) { selected.value = null; return; }
  if (view.value !== 'atlas') { view.value = 'atlas'; }
}
onMounted(() => {
  document.addEventListener('keydown', onKeydown);
  applyTheme(theme.value);
  loadSites().then(() => {
    // 默认载入第一个「有侦察结果」的站点；没有则保持空态（引导用户输入域名侦察）
    const first = sites.value.find(s => s.pages) ?? sites.value[0];
    if (first) pickSite(first);
    else host.value = '';
  });
  pollEngine();
});
onBeforeUnmount(() => { document.removeEventListener('keydown', onKeydown); es?.close(); for (const s of taskSources.values()) { try { s.close(); } catch {} } });
</script>

<template>
  <Graph3D v-show="view === 'atlas'" :nodes="gNodes" :links="gLinks" :tick="gTick" :auto-rotate="autoRotate" :palette="graphPalette" @node-click="onNodeClick" />

  <div class="hud" v-if="view === 'atlas'">
    <div class="brand">HEIMDALL<span class="brand-sub">SITE ATLAS · 站点克隆工作台</span></div>
    <div class="brand-rule"></div>
    <div class="stats">
      <div class="stat"><b>{{ hudPages }}</b><i title="本次侦察抓取到的页面数。站点实际页面数通常更多 —— 侦察有页数上限（见站点配方的 maxPages）。">页面</i></div>
      <div class="stat"><b>{{ hudEdges }}</b><i :title="`这 ${hudPages} 个页面之间的站内链接数（不是页面数）。星图上当前已渲染 ${hudEdgesRendered} 条。`">站内链接</i></div>
      <div class="stat"><b>{{ hudOrigin }}</b><i title="被克隆的原始站点。镜像与原站的对比都以它为准。">原站</i></div>
    </div>
    <div class="status" v-if="statusText" :class="{ live }">{{ statusText }}</div>
  </div>

  <!-- 左侧仪表面板 -->
  <div class="panel surface" v-if="view === 'atlas' && showPanel">
    <div class="panel-title">仪表面板<button class="panel-collapse" @click="showPanel = false" title="收起">—</button></div>
    <div class="panel-sec">
      <div class="panel-sec-name">图例 · 页面类型</div>
      <div class="legend"><span class="lg" v-for="(t, k) in PAGE_TYPES" :key="k"><i :style="{ background: typeColorThemed(k) }"></i>{{ t.cn }}</span></div>
    </div>
    <div class="panel-sec">
      <div class="panel-sec-name">显示</div>
      <label class="sw"><input type="checkbox" v-model="autoRotate" /><span>星图自转</span></label>
    </div>
    <div class="panel-sec">
      <div class="panel-sec-name">引擎</div>
      <div class="eng" :class="{ on: engine.ok }"><i></i>{{ engine.ok ? '在线 :8900' : '离线' }}</div>
      <div class="eng-detail" v-if="engine.ok">克隆槽 {{ engine.forge?.slots ?? 0 }}/{{ engine.forge?.max ?? 2 }} · 侦察 {{ engine.recon ? '进行中' : '空闲' }}</div>
    </div>
  </div>
  <button class="panel-open" v-if="view === 'atlas' && !showPanel" @click="showPanel = true" aria-label="展开仪表面板" title="仪表面板"><Icon name="menu" decorative /></button>

  <div class="seek surface">
    <button class="theme-btn" @click="toggleTheme" :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" :title="theme === 'dark' ? '切换浅色' : '切换深色'"><Icon :name="theme === 'dark' ? 'moon' : 'sun'" decorative /></button>
    <input v-model="host" aria-label="目标站点域名" placeholder="输入目标域名 · apify.com" spellcheck="false" @keyup.enter="startRecon" />
    <button @click="startRecon">侦察</button>
  </div>

  <!-- 已侦察站点切换（仅星图；工作视图在各自表头里放站点选择器，避免浮层压住内容） -->
  <div class="sites" v-if="view === 'atlas' && sites.length">
    <span class="sites-label">站点：</span>
    <span class="site-item" v-for="s in sites" :key="s.host">
      <button class="site-btn" :class="{ active: s.host === host, empty: !s.forged && !s.pages, partial: s.status === 'partial' }" @click="pickSite(s)" :title="siteTitle(s)">
        {{ s.host }}<em>{{ siteBadge(s) }}</em>
      </button>
      <button class="site-del" :aria-label="'删除站点 ' + s.host" title="删除该站点（侦察/克隆/报告；CAS 资产保留）" @click.stop="deleteSite(s)"><Icon name="close" decorative /></button>
    </span>
    <button class="site-btn audit-btn" :disabled="!!engine.audit" @click="runAudit" :title="engine.audit ? '已有审计任务在运行' : '全站 SEO 审计（56 条规则，输出 HTML/CSV/JSON 报告）'">SEO 审计</button>
    <button class="site-btn clone-btn" :disabled="!!engine.clone" @click="startCloneSite({ incremental: doneCount > 0 })"
      :title="engine.clone ? '已有整站克隆在运行' : (doneCount > 0 ? `站点已有 ${doneCount} 页克隆，默认增量：只重跑源站变了的页（改版检测基于服务端 HTML）` : '整站批量克隆，由引擎侧执行 —— 关掉这个页面任务也会继续')">
      {{ doneCount > 0 ? '增量克隆' : '整站克隆' }}
    </button>
    <button v-if="doneCount > 0" class="site-btn" :disabled="!!engine.clone" @click="startCloneSite({ incremental: false })" title="忽略「源站是否变过」，全部重跑一遍（慢，但最完整）">全量重跑</button>
    <button class="site-btn list-toggle" :class="{ active: view === 'pages' }" @click="togglePages()" :title="view === 'pages' ? '收起清单返回星图' : '打开页面清单'">{{ view === 'pages' ? '收起清单' : '页面清单' }}</button>
  </div>

  <!-- 任务中心：每个任务的独立进度（不再被后一个任务覆盖） -->
  <!-- 任务浮层：只在不专门看任务的时候出现。
       此前没有视图守卫，于是「任务」视图里同一份任务列表会显示两遍
       （浮层 + 视图各一份）—— 这正是"重复赘余"的典型。 -->
  <div class="task-center surface" v-if="tasks.length && view !== 'jobs'">
    <div class="tc-head">
      <span>任务中心</span>
      <span class="tc-meta">{{ tasks.filter(t => !t.done && !t.failed).length }} 运行中 / {{ tasks.length }}</span>
      <button class="tc-toggle" @click="tasksOpen = !tasksOpen">{{ tasksOpen ? '—' : '＋' }}</button>
    </div>
    <div class="tc-rows" v-show="tasksOpen">
      <div class="tc-row" v-for="t in [...tasks].reverse()" :key="t.localId" :class="taskState(t)" @click="t.kind !== 'clone' && (activeTaskId = t.localId)" :title="t.error || t.url">
        <span class="tc-name">{{ t.label ?? t.pageName }}</span>
        <span class="tc-state">{{ taskLabel(t) }}</span>
        <span class="tc-score" v-if="t.kind === 'audit' && t.auditScore != null">{{ t.auditScore }} 分</span>
        <span class="tc-score" v-else-if="t.score">{{ (t.score.pixel * 100).toFixed(1) }}%</span>
      </div>
    </div>
  </div>

    <!-- 工作台视图：页面 / 任务 / 报告 / 设置 -->
  <PagesView
    v-if="view === 'pages'"
    :key="'pages-' + host"
    :host="host" :sites="sites" :engine="engine" :theme="theme"
    :nodes="tableNodes" :scores="pageScores" :verify="pageVerify" :meta="pageMeta"
    @pick="pickSiteByHost" @audit="runAudit" @close="view = 'atlas'"
    @detail="onNodeClick" @forge="startForge" @delete="deletePage"
    @forge-checked="forgeChecked" @remove-checked="removeChecked"
  />
  <JobsView
    v-if="view === 'jobs'"
    :tasks="tasks" :jobs="jobHistory" :sites="sites" :host="host" :engine="engine"
    @pick="pickSiteByHost" @audit="runAudit" @close="view = 'atlas'"
  />

  <section class="work-view surface" v-if="view === 'reports'">
    <div class="wv-head">
      <b>报告中心 · {{ host || '未选择站点' }}</b>
      <span class="wv-stat">克隆档案 / SEO / 体检 / 活镜像 / 对标 / 情报</span>
      <SitePicker :sites="sites" :host="host" :busy="!!engine.audit" @pick="pickSiteByHost" @audit="runAudit" />
      <button class="wv-close" @click="view = 'atlas'" title="返回星图（Esc）"><Icon name="close" decorative /> 返回星图</button>
    </div>
    <div class="reports-scroll">
    <div class="report-card surface">
      <h3>克隆档案</h3>
      <p>{{ doneCount }} 页已克隆 · 平均视觉 {{ avgVisual }}</p>
      <a :href="`/${host}/index.html`" target="_blank" rel="noopener">打开档案</a>
    </div>
    <div class="report-card surface">
      <h3>SEO 审计报告</h3>
      <p v-if="auditReport">{{ auditReport.score }} 分 · {{ auditReport.pages }} 页 · {{ auditReport.issues }} 条问题</p>
      <p v-else>尚未运行（56 条规则 / 六分类评分）</p>
      <a v-if="auditReport" :href="`/static/${auditReport.host}/seo/seo.html`" target="_blank" rel="noopener">打开报告</a>
      <button v-else class="wv-primary" @click="runAudit">运行审计</button>
    </div>
    <div class="report-card surface">
      <h3>变更监控</h3>
      <p v-if="watchReport">{{ watchReport.changes }} 处变化（高 {{ watchReport.bySeverity?.high ?? 0 }}）</p>
      <p v-else>对比基线快照，发现标题/描述/canonical/正文变化</p>
      <a v-if="watchReport" :href="`/static/${host}/watch/watch.html`" target="_blank" rel="noopener">打开变更报告</a>
      <button v-else class="wv-primary" @click="runWatch">运行监控</button>
    </div>
    <div class="report-card surface">
      <h3>同步滚动对比</h3>
      <p>原站快照 vs 镜像，逐屏目检</p>
      <a :href="`/${host}/compare.html`" target="_blank" rel="noopener">打开对比</a>
    </div>
    <div class="report-card surface">
      <h3>竞品情报包</h3>
      <p>概览 / 语义情报 / 定价与 CTA</p>
      <a :href="`/${host}/intel/${host}-intel.xlsx`" download>下载 Excel</a>
    </div>

    <div class="report-card surface">
      <h3>跨站对标矩阵</h3>
      <p v-if="matrixReport">与 {{ matrixReport.sites[1] }} 的 SEO 对标已生成</p>
      <p v-else>选择另一站点，生成站点分/覆盖率/LCP/页面类型对比</p>
      <div v-if="matrixReport"><a :href="matrixReport.url" target="_blank" rel="noopener">打开矩阵报告</a></div>
      <div v-else class="matrix-run">
        <select v-model="matrixPeer" aria-label="选择要对标的站点"><option value="">选择对标站点</option><option v-for="s in sites.filter(x => x.host !== host)" :key="s.host" :value="s.host">{{ s.host }}</option></select>
        <button class="wv-primary" :disabled="!matrixPeer" @click="runMatrix">生成对标</button>
      </div>
    </div>
    <div class="report-card surface">
      <h3>资产缺口</h3>
      <p v-if="assetAuditReport">{{ assetAuditReport.visualGaps }} 个视觉缺口（原站 {{ assetAuditReport.visualOrigin }} / 第三方 {{ assetAuditReport.visualThird }}）</p>
      <p v-else>扫描图片/图标/SVG/CSS 引用，区分视觉缺口与元数据噪声</p>
      <a v-if="assetAuditReport" :href="`/static/${host}/audit/asset-gaps.html`" target="_blank" rel="noopener">打开缺口报告</a>
      <button v-else class="wv-primary" @click="runAssetsAudit">运行扫描</button>
    </div>
    <div class="report-card surface">
      <h3>全站体检</h3>
      <p v-if="lastVerify">{{ lastVerify.pages }} 页 · 平均 {{ lastVerify.average }}%<template v-if="lastVerify.worst"><br /><span class="score-note">最差 {{ lastVerify.worst.page }} · {{ lastVerify.worst.name }} {{ (lastVerify.worst.score * 100).toFixed(1) }}%</span></template></p>
      <p v-else>多视口（375/768/1440）逐页像素 diff，输出最差视口</p>
      <div class="report-list" v-if="lastVerify"><a :href="'/static/' + host + '/verify/verify-summary.json'" target="_blank" rel="noopener">体检 JSON</a></div>
      <button class="wv-primary" @click="runVerifyAll">{{ lastVerify ? '重新体检' : '运行全站体检' }}</button>
      <button @click="runResponsiveUpgrade" title="对 minViewport<0.97 的页面做多视口快照，verify 提升才保留">响应式升级</button>
    </div>
    <div class="report-card surface">
      <h3>活镜像</h3>
      <!-- 导出与体检此前是两张卡片，但它们说的是同一件产物（离线包 + 它的健康报告）——
           放在一起才知道"导出什么、导出来怎么样"。 -->
      <template v-if="liveHealth">
        <p>最近导出：<b>{{ liveHealth.bundle }}</b></p>
        <p>离线资源 {{ liveHealth.assets?.local ?? 0 }} 本地 / {{ liveHealth.assets?.har ?? 0 }} HAR 回放 · <b :style="{ color: (liveHealth.assets?.unresolved ?? 0) ? 'var(--warn)' : 'var(--ok)' }">缺口 {{ liveHealth.assets?.unresolved ?? 0 }}</b></p>
        <p class="score-note">页面 {{ liveHealth.pages ?? 0 }}<template v-if="liveHealth.liveMissing">（少 {{ liveHealth.liveMissing }} 页）</template> · 未镜像链接 {{ liveHealth.links?.missing ?? 0 }}</p>
        <!-- 站外引用分两个口径显示。此前只显示 externalAssets，于是
             YouTube 嵌入这类"没有资源扩展名的外链"在界面上完全看不到 ——
             实测 apify 站外引用 1826 条，其中静态资源 1419 条，差额 407 条被隐藏。 -->
        <p class="score-note">
          站外静态资源 <b :title="'图片/CSS/脚本等带扩展名的站外资源。离线时一定会裂，需要本地化。'">{{ liveHealth.assets?.externalAssets ?? 0 }}</b>
          · 站外引用共 <b :title="'含 YouTube 嵌入、地图、统计脚本等无扩展名的外链。在线可用，离线为空 —— 这类无法本地化，属固有边界。'">{{ liveHealth.assets?.external ?? 0 }}</b>
          · 动态图 {{ liveHealth.assets?.dynamic ?? 0 }}
        </p>
      </template>
      <p v-else>可部署的离线完整包：本地快照 → HAR 回放 → 原站代理。导出后这里显示离线缺口。</p>
      <label class="sw" style="margin-bottom:8px;display:flex"><input type="checkbox" v-model="liveRebuild" /><span>先重建 live 页面（站点改版后勾选）</span></label>
      <button class="wv-primary" @click="runLiveExport">{{ liveHealth ? '重新导出' : '导出完整离线包' }}</button>
    </div>
    <div class="report-card report-wide surface">
      <h3>设计资产</h3>
      <!-- 只列**没有专属卡片**的报告。此前这块叫"更多报告"，
           把上面已有卡片的 7 项又列了一遍 —— 同一个链接在同一页出现两次。
           真正只在这里出现的只有设计令牌与组件画廊。 -->
      <div class="report-list" v-if="designReports.length">
        <a v-for="r in designReports" :key="r.id" :href="r.url" target="_blank" rel="noopener">{{ r.name }}</a>
      </div>
      <p v-else>暂无（运行 <code>tokens</code> / <code>components</code> 后自动出现）</p>
      <p class="score-note" v-if="designReports.length">从站点 CSSOM 归纳出的色板、字阶、间距，以及可复用组件的独立预览。</p>
    </div>

    <StorageCard @ok="toast" />


    <AssetTable :host="host" />
    </div>
  </section>

  <section class="work-view surface" v-if="view === 'settings'">
    <div class="wv-head">
      <b>设置</b>
      <span class="wv-stat">模型服务写引擎配置（保存即生效）；其余为本地浏览器偏好</span>
      <SitePicker :sites="sites" :host="host" :busy="!!engine.audit" @pick="pickSiteByHost" @audit="runAudit" />
      <button class="wv-close" @click="view = 'atlas'" title="返回星图（Esc）"><Icon name="close" decorative /> 返回星图</button>
    </div>
    <div class="settings-grid">

      <!-- 模型服务：控制台直接配置第三方大模型 -->
      <div class="set-card surface">
        <div class="set-card-head">
          <b>模型服务</b>
          <span class="set-badge" :class="llmStatus?.ready ? 'ok' : 'bad'">{{ llmStatus?.ready ? '已就绪' : (llmStatus?.enabled ? '配置不完整' : '未启用') }}</span>
          <span class="wv-stat" v-if="llmStatus?.baseHost">端点 {{ llmStatus.baseHost }} · Key {{ llmStatus.hasKey ? llmStatus.keyHint : '缺失' }}</span>
        </div>
        <p class="set-desc">
          用于「AI 校准」（把 diff 差异交给模型修）与「情报语义抽取」。留空/关闭时，克隆与审计仍照常跑，
          只是少了这两个 AI 增强环节（确定性流程不依赖模型）。
        </p>

        <div class="set-form">
          <label for="set-llm-enabled">启用</label>
          <div><input id="set-llm-enabled" type="checkbox" v-model="llmForm.enabled" /><span class="hint">关闭后 AI 校准与语义抽取会自动跳过</span></div>

          <label for="set-llm-protocol">协议</label>
          <div>
            <select id="set-llm-protocol" v-model="llmForm.protocol">
              <option value="chat">chat · OpenAI 兼容 /chat/completions（绝大多数中转与厂商）</option>
              <option value="responses">responses · OpenAI /responses</option>
              <option value="anthropic">anthropic · Anthropic /messages</option>
            </select>
          </div>

          <label for="set-llm-baseurl">Base URL</label>
          <div><input id="set-llm-baseurl" v-model="llmForm.baseUrl" placeholder="https://api.openai.com/v1" spellcheck="false" /></div>

          <label for="set-llm-apikey">API Key</label>
          <div>
            <input id="set-llm-apikey" type="password" v-model="llmForm.apiKey" spellcheck="false"
                   :placeholder="llmStatus?.hasKey ? ('已保存（' + llmStatus.keyHint + '）— 留空表示不修改') : 'sk-...'" />
          </div>

          <label for="set-llm-model">主模型</label>
          <div><input id="set-llm-model" v-model="llmForm.model" placeholder="用于 AI 校准与语义抽取" spellcheck="false" /></div>

          <label for="set-llm-fastmodel">快速模型</label>
          <div><input id="set-llm-fastmodel" v-model="llmForm.fastModel" placeholder="留空 = 与主模型相同" spellcheck="false" /></div>

          <label for="set-llm-timeout">超时 / 重试</label>
          <div class="set-inline">
            <input id="set-llm-timeout" type="number" v-model.number="llmForm.timeoutMs" min="1000" max="900000" step="1000" aria-label="请求超时毫秒数" /><span class="hint">ms</span>
            <input type="number" v-model.number="llmForm.retries" min="1" max="10" aria-label="网络错误重试次数" /><span class="hint">次</span>
          </div>
        </div>

        <div class="set-presets">
          <span class="hint">快速填充：</span>
          <button v-for="p in LLM_PRESETS" :key="p.name" @click="applyLlmPreset(p)">{{ p.name }}</button>
          <span class="hint">（预设只填协议与端点；模型名以服务商当前文档为准）</span>
        </div>

        <div class="set-actions">
          <button :disabled="llmTesting" @click="testLlm">{{ llmTesting ? '测试中…' : '测试连接（不保存）' }}</button>
          <button class="wv-primary" :disabled="llmSaving" @click="saveLlm">{{ llmSaving ? '保存中…' : '保存并生效' }}</button>
        </div>

        <div class="set-msg" :class="llmTest?.ok ? 'ok' : 'bad'" v-if="llmTest">
          {{ llmTest.ok
            ? ('✓ 连接成功 · ' + llmTest.latencyMs + 'ms · ' + (llmTest.model || '') + ' · ' + (llmTest.reply || '').slice(0, 40) + (llmTest.draft ? '（草稿配置）' : ''))
            : ('✗ 失败：' + (llmTest.error || 'unknown')) }}
        </div>
        <div class="set-msg" :class="llmSaveMsg.startsWith('✓') ? 'ok' : 'bad'" v-if="llmSaveMsg">{{ llmSaveMsg }}</div>

        <div class="set-warn" v-if="llmStatus?.shadowed?.length">
          注意：环境变量正在覆盖以下配置，控制台里改了也不生效 —— {{ llmStatus.shadowed.join('、') }}。请在启动引擎的环境中去掉它们。
        </div>

        <div class="set-foot">
          写入 <code>{{ llmStatus?.envFile || 'core/.env' }}</code>：改动立即生效（引擎每次调用重读配置，无需重启）。
          Key 只落本地文件、永不回显。
        </div>
      </div>

      <!-- 引擎与数据 -->
      <div class="set-card surface">
        <div class="set-card-head"><b>引擎与数据</b></div>
        <div class="set-row"><span>主题</span><button @click="toggleTheme">{{ theme === 'dark' ? '深色 → 浅色' : '浅色 → 深色' }}</button></div>
        <div class="set-row"><span>星图自转</span><input type="checkbox" v-model="autoRotate" aria-label="星图自动旋转" /></div>
        <div class="set-row"><span>引擎地址</span><input v-model="apiBaseInput" aria-label="引擎 API 地址" placeholder="http://127.0.0.1:8900" spellcheck="false" /><button @click="saveApiBase">保存并刷新</button></div>
        <div class="set-row"><span>引擎 Token</span><input v-model="tokenInput" aria-label="引擎 API 口令" placeholder="HEIMDALL_TOKEN（保护引擎 API，可留空）" spellcheck="false" /><button @click="saveToken">保存</button></div>
        <div class="set-foot">
          「引擎 Token」是访问本机引擎 API 的口令（环境变量 HEIMDALL_TOKEN），与模型服务的 API Key 不是一回事：前者保护你的引擎，后者用于调用模型。
        </div>
        <div class="set-foot">
          引擎：{{ engine.ok ? '在线' : '离线' }} · 绑定 {{ engine.bind ?? '127.0.0.1' }} · 鉴权 {{ engine.auth ? '开启' : '关闭' }}<br />
          数据目录 / 并发 / 代理白名单走环境变量：HEIMDALL_DATA_DIR / HEIMDALL_ALLOWED_HOSTS。
        </div>
        <div class="set-foot" v-if="llmStatus?.readonly?.length">
          只读配置：<template v-for="(r, i) in llmStatus.readonly.filter(x => x.value)" :key="r.key"><code v-if="i">{{ ' ' }}</code><code>{{ r.key }}={{ r.value }}</code> </template>
        </div>
      </div>

    </div>
  </section>

  <!-- 页面详情剖析面板（点星 = 选中；克隆是其中一项功能） -->
  <DetailDock
    v-if="dockOpen"
    :key="'dock-' + selected?.id"
    :host="host" :selected="selected" :forge="forge" :theme="theme"
    :page-meta="pageMeta" :detail-intel="detailIntel" :detail-score="detailScore"
    @close="selected = null" @open-forge="openForge" @forge-all="forgeAll" @verify="runVerifyPage"
  />

  <a class="audit-link" v-if="auditReport" :href="`/static/${auditReport.host}/seo/seo.html`" target="_blank" rel="noopener">SEO 报告 · {{ auditReport.score }} 分</a>
  <a class="archive-link" v-if="hudPages > 0 && !dockOpen" :href="`/${host}/index.html`" target="_blank" rel="noopener">克隆档案 · {{ hudPages }} 页</a>
  <div class="keys" v-if="view === 'atlas' && !forge">
    <span>拖拽 = 旋转</span><span>滚轮 = 缩放</span><span>Ctrl+拖拽 = 平移</span><span class="k-amber">点击星球 = 打开页面详情</span>
  </div>
  <div class="toast" v-if="errMsg">{{ errMsg }}</div>
  <div class="toast ok" v-if="okMsg">{{ okMsg }}</div>
  <div class="view-nav surface">
    <button v-for="v in VIEWS" :key="v.id" :class="{ on: view === v.id }" :aria-current="view === v.id ? 'page' : undefined" @click="selectView(v.id)">
      <b aria-hidden="true">{{ v.icon }}</b><span>{{ v.label }}</span>
    </button>
  </div>
</template>
