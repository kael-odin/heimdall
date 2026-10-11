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
import SiteBar from './SiteBar.vue';
import Sparkline from './Sparkline.vue';
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
const liveHealth = ref(null);    // 最新交互镜像体检（/api/live-health/:host，导出时生成）
const lastVerify = ref(null);    // 最近一次全站体检结果（/api/verify）
const liveRebuild = ref(false);  // 导出交互镜像前先重建 live 页面
const sessionState = ref(null);  // 本站登录态（/api/session/:host）：需要登录的站点靠它
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
  { id: 'atlas', icon: '✦', label: '星图', hint: '全站力导向图：每个行星是一页，连线是站内链接' },
  { id: 'pages', icon: '▤', label: '页面', hint: '逐页清单：克隆状态 / 还原度 / 资产 / 缺口，可搜索筛选批量克隆' },
  { id: 'jobs', icon: '◷', label: '任务', hint: '本次会话的任务与持久化历史（引擎重启也在）' },
  { id: 'reports', icon: '▦', label: '报告', hint: '克隆档案 / SEO 审计 / 体检 / 交互镜像 / 对标 / 情报' },
  { id: 'settings', icon: '⚙', label: '设置', hint: '模型服务、引擎地址与 Token、界面偏好' },
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
/** 工作视图表头的站点切换（SiteBar emit） */
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
        pageMeta[n.id] = { assets: hit.assets ?? null, visualGaps: hit.visualGaps ?? null, interactions: hit.interactions ?? null, updatedAt: hit.updatedAt ?? null, motion: hit.motion ?? null };
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
    // 侦察只抓到 0-1 页：最常见的两种原因是登录墙与纯客户端渲染。
    // 不去猜是哪种，直接把"下一步能做什么"摆出来 —— 否则用户只会看到一个空星图。
    // （登录这一步以前只有命令行走得通，见 core/src/session/）
    if ((a.meta?.pages ?? 0) <= 1) {
      okMsg.value = `侦察只找到 ${a.meta?.pages ?? 0} 页。若该站需要登录，先「本站操作 → 登录并保存会话」，登录后再重新侦察`;
      setTimeout(() => { okMsg.value = ''; }, 20000);
    }
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
 * 最近一次 SEO 审计（从磁盘读，不只在"本次会话跑过"时才有）。
 * 此前只由 SSE 事件写入 —— 刷新页面后报告卡就显示"尚未运行"，明明报告就在盘上。
 */
function loadAuditReport(h) {
  auditReport.value = null;
  if (!h) return;
  wsJson(h, 'seo/seo.json').then(j => {
    if (!j || host.value !== h) return;
    auditReport.value = {
      host: h, score: j.score,
      pages: j.summary?.pages ?? j.pages?.length ?? 0,
      issues: j.summary?.issues ?? 0,
      generatedAt: j.generatedAt, field: j.field ?? null,
    };
  });
}

/** 分数走势：workspace/<host>/history.json（审计与整站克隆各记一笔，见 core/src/seo/history.mjs） */
const siteHistory = ref([]);
function loadHistory(h) {
  siteHistory.value = [];
  if (!h) return;
  wsJson(h, 'history.json').then(j => { if (Array.isArray(j) && host.value === h) siteHistory.value = j; });
}
/** 按 kind/字段取序列 —— 画的就是记录本身，不做聚合 */
const trendOf = (kind, field) => siteHistory.value
  .filter(x => x?.kind === kind && typeof x[field] === 'number')
  .map(x => ({ at: x.at, v: x[field] }));
const auditTrend = computed(() => trendOf('audit', 'score'));
/** 最近一次审计覆盖的页数 —— 页数不同的两次分数不可直接比，图上要点出来 */
const lastAuditPages = computed(() => [...siteHistory.value].reverse().find(x => x.kind === 'audit' && x.pages)?.pages ?? null);
const cloneTrend = computed(() => trendOf('clone', 'avgPixel'));

/**
 * 本站能做的事。费时（全量重跑）与破坏性（删除本站）的项标红并二次确认 ——
 * 它们要么占满引擎并发槽跑上小时，要么删掉整站产物，误点的代价不对称。
 */
// ---------- 登录态（需要登录/鉴权的站点） ----------

/** 读本站登录态；没有就是公开站点，一切照旧 */
async function loadSession() {
  sessionState.value = null;
  if (!host.value) return;
  try {
    const r = await fetch(API + '/api/session/' + host.value);
    if (r.ok) sessionState.value = await r.json();
  } catch { /* 引擎离线时静默 */ }
}

const sessionAge = computed(() => {
  const s = sessionState.value;
  if (!s?.exists || s.ageHours == null) return '';
  if (s.ageHours < 1) return `${Math.max(1, Math.round(s.ageHours * 60))} 分钟前`;
  if (s.ageHours < 48) return `${s.ageHours.toFixed(1)} 小时前`;
  return `${Math.round(s.ageHours / 24)} 天前`;
});

/**
 * 登录并保存会话：打开的是**真浏览器窗口**，登录这件事整个交给人。
 *
 * 为什么不自动化：验证码、短信码、扫码、SSO 跳转、人机验证 —— 既自动化不了，
 * 也不该去绕。我们只做一件事：把登录后的 `storageState` 存到 `workspace/<host>/session.json`，
 * 之后侦察 / 克隆 / SEO 审计 / 多视口验证都自动带上它（见 core/src/session/store.mjs）。
 */
function runLogin() {
  if (!confirm(`会打开一个浏览器窗口访问 https://${host.value}/。\n\n`
    + '请在里面完成登录（验证码 / 短信码 / 扫码 / 第三方 SSO 都行），'
    + '登录完成后**关掉那个标签页**即可。\n\n'
    + '登录态会存到本站目录（不会进交付包、不会提交到 git），'
    + '之后的侦察、克隆、SEO 审计、多视口验证都会自动带上它。')) return;
  const task = reactive({
    localId: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'session', label: '登录会话 · ' + host.value, url: 'https://' + host.value,
    done: false, failed: false, error: null, startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '等待登录 · 在刚打开的浏览器窗口里登录，完成后关掉那个标签页';
  (async () => {
    try {
      const r = await fetch(API + '/api/session/login', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: host.value }) });
      const { taskId, error } = await r.json();
      if (error) {
        task.failed = true; task.done = true;
        task.error = error === 'busy' ? '已有一个登录窗口在等待中' : error;
        errMsg.value = '无法开始登录：' + task.error;
        return;
      }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind !== 'exit') return;
        task.done = true; task.endedAt = Date.now();
        if (ev.status !== 'done') task.failed = true;
        close();
        loadSession();
        statusText.value = '';
        okMsg.value = ev.status === 'done' ? '登录态已保存 —— 之后的抓取会自动带上它' : '登录窗口已结束，但可能没存下会话';
        setTimeout(() => { okMsg.value = ''; }, 6000);
      };
      es.onerror = () => { close(); if (!task.done) { task.failed = true; task.error = '事件流中断'; } };
    } catch (e) {
      task.failed = true; task.done = true; task.error = String(e); errMsg.value = String(e);
    }
  })();
}

const siteActions = computed(() => {
  const has = !!host.value;
  const cloned = doneCount.value;
  return [
    { id: 'audit', label: 'SEO 审计', hint: '66 条规则 · 六分类评分 · 输出 HTML/CSV/JSON 报告', disabled: !has || !!engine.value.audit },
    {
      id: 'clone-incremental',
      label: cloned ? '增量克隆' : '整站克隆',
      hint: cloned ? '只重跑源站变了的页（按服务端 HTML 指纹判断，不起浏览器）' : '把侦察到的页面逐页克隆；由引擎执行，关掉本页也会继续',
      disabled: !has || !!engine.value.clone,
    },
    { id: 'clone-full', label: '全量重跑', hint: '忽略「源站是否变过」，整站重跑一遍 —— 页面多时按小时计', danger: true, disabled: !has || !cloned || !!engine.value.clone },
    { id: 'pages', label: view.value === 'pages' ? '收起清单' : '页面清单', hint: '逐页状态 / 还原度 / 资产 / 缺口', disabled: !has },
    {
      id: 'login',
      label: sessionState.value?.exists ? `重新登录（会话 ${sessionAge.value}）` : '登录并保存会话',
      hint: sessionState.value?.exists
        ? `已有登录态：${sessionState.value.cookies} 个 cookie · 本站域名下 ${sessionState.value.sameSite} 个。过期了就再登一次`
        : '需要登录/鉴权的站点：开一个浏览器窗口人工登一次，之后侦察/克隆/审计都自动带上这份登录态',
      disabled: !has,
    },
    { id: 'delete', label: '删除本站', hint: '移除该站的侦察、克隆与报告（CAS 资产保留）', danger: true, disabled: !has },
  ];
});
/** 工作视图自己就是清单，不需要「页面清单」那一项；其余动作与星图一致 */
const workViewActions = computed(() => siteActions.value.filter(a => a.id !== 'pages'));

function onSiteAction(id) {
  if (id === 'audit') return runAudit();
  if (id === 'clone-incremental') return startCloneSite({ incremental: doneCount.value > 0 });
  if (id === 'clone-full') {
    if (!confirm(`全量重跑 ${host.value}？\n\n忽略「源站是否变过」，把本站全部页面重新克隆一遍。\n页面多时按小时计，期间引擎的并发槽会被占满。`)) return;
    return startCloneSite({ incremental: false });
  }
  if (id === 'pages') return togglePages();
  if (id === 'login') return runLogin();
  if (id === 'delete') { const s = sites.value.find(x => x.host === host.value); if (s) deleteSite(s); }
}

function pickSite(s) {
  if (!s) return;
  host.value = s.host;
  loadHistory(s.host);
  loadAuditReport(s.host);
  loadSession();
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
      // 只有审计产物、没有克隆页：直接进「报告」——报告就在那里，摆一个空清单没有意义
      if (!s.forged && s.audit) {
        view.value = 'reports';
        okMsg.value = '该站点只做过 SEO 审计（无侦察/克隆产物），已打开报告中心。';
      } else {
        view.value = 'pages';    // 没有星图可看，直接把清单摆出来
        okMsg.value = '该站点只有克隆页面、尚未全站侦察；已显示页面清单。侦察后可获得星图与全站视图。';
      }
      setTimeout(() => { okMsg.value = ''; }, 6000);
    })
    .catch(e => { errMsg.value = String(e); });
}

/**
 * 首屏「只克隆此页」：不侦察整站，只跑输入框里这一个 URL 的克隆流水线。
 *
 * 存在理由：克隆与侦察本来是两条独立能力（引擎侧 /api/forge 与 /api/recon 互不依赖），
 * 但界面上只有「侦察」一个入口，于是"我只是想要这一页"的人被迫先侦察整站。
 * 单页克隆出来的站点没有星图，只有页面清单 —— 控制台会直接把清单摆出来。
 */
function forgeSingle() {
  const url = normalizeUrl(host.value);
  if (!url) { errMsg.value = '网址无效'; return; }
  errMsg.value = '';
  host.value = url.replace(/^https?:\/\//, '');
  startForge(null, { url });
}

// ---------- forge：单页还原流水线 ----------
// node 可空：星图上点节点会传节点；首屏「只克隆此页」直接从输入框的 URL 起跑 ——
// 那条路径根本没有星图，也就没有节点。区别只有 pageName 的来源与 forgeState 往哪写。
function startForge(node, opts = {}) {
  return new Promise((resolve) => {
    const url = node?.url ?? opts.url;
    if (!url) return resolve();
    const pageName = node
      ? (node.path === '/' ? 'home' : node.path.replace(/^\//, '').replace(/\//g, '-'))
      : pageNameOf({ url });
    const setState = (s) => { if (node) node.forgeState = s; };
    const task = reactive({
      localId: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      taskId: null, pageName, url, nodeId: node?.id ?? null,
      stages: { capture: 'idle', build: 'idle', shot: 'idle', diff: 'idle', fixup: 'idle', harvest: 'idle' },
      score: null, done: false, failed: false, intel: null, rounds: [], skipReason: null, error: null,
      startedAt: Date.now(), endedAt: null,
    });
    tasks.push(task);
    while (tasks.length > 20) tasks.shift();   // 只保留最近 20 条，长会话不膨胀
    activeTaskId.value = task.localId;
    setState('running');
    statusText.value = '克隆中 · ' + pageName;
    bump();
    (async () => {
      try {
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url: node.url }) });
        const { taskId, error } = await r.json();
        if (error) {
          task.failed = true; task.done = true; task.endedAt = Date.now();
          task.error = error === 'busy' ? '造物台忙：引擎并发槽已满（稍后重试）' : error;
          setState('idle'); return resolve();
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
            if (ev.status === 'cancelled') { task.error = '已取消'; setState('idle'); }
            else if (!task.done) { task.failed = true; setState('failed'); }
            else setState('done');
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
        setState('idle');
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

/** 复制交付包路径：交给同事最常用的一步，就是把这一整行发过去 */
async function copyBundlePath() {
  const p = liveHealth.value?.bundlePath;
  if (!p) return;
  try { await navigator.clipboard.writeText(p); okMsg.value = '已复制交付包路径'; }
  catch { errMsg.value = '浏览器拒绝了剪贴板，请手动选中那行路径'; }
  setTimeout(() => { okMsg.value = ''; }, 4000);
}

/** 在资源管理器里定位交付包（引擎只接受 DATA_ROOT 以内的路径） */
async function revealBundle() {
  const p = liveHealth.value?.bundlePath;
  if (!p) return;
  try {
    const r = await fetch(API + '/api/reveal', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ path: p }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); errMsg.value = '打开失败：' + (j.error ?? r.status); }
  } catch (e) { errMsg.value = String(e); }
}

/** 交互镜像导出：引擎 live 任务（离线 + mirror + heal + materialize） */
function runLiveExport() {
  const task = reactive({
    localId: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'live', label: '交互镜像导出 · ' + host.value, url: atlas.value?.origin ?? ('https://' + host.value),
    done: false, failed: false, error: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '交互镜像导出中 · 约 2-5 分钟（HAR 合并 + 图片本地化 + 体检）';
  (async () => {
    try {
      const r = await fetch(API + '/api/live-export', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: host.value, root: 'mirror', rebuild: liveRebuild.value }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; task.error = error; errMsg.value = '交互镜像导出失败：' + error; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      es.onmessage = (m) => {
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'exit') {
          task.done = true; task.endedAt = Date.now();
          if (ev.status === 'done') { statusText.value = '交互镜像导出完成 · 已生成离线完整包'; loadLiveHealth(); loadReports(); }
          else { task.failed = true; task.error = '导出失败（见 health.json / 任务日志）'; errMsg.value = '交互镜像导出失败，查看任务日志'; }
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
          loadHistory(host.value);                          // 审计刚落一条，走势图跟上
          loadAuditReport(host.value);                      // 报告卡切到最新一份（含真实用户指标）
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
            loadHistory(h);                                    // 走势多一个点
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
    <input v-model="host" aria-label="目标站点域名" placeholder="输入目标域名 · apify.com" spellcheck="false" @keyup.enter="startRecon"
      title="要分析的站点域名（可带 https://）。回车或点「侦察」开始" />
    <button @click="startRecon"
      title="全站侦察：从 sitemap 与站内链接找出页面，逐页抓标题/类型/缩略图，产出星图与全站视图。页数上限由站点配方的 maxPages 决定，几十页通常 1-3 分钟">侦察</button>
    <button class="seek-alt" @click="forgeSingle"
      title="不侦察整站，只克隆输入框里这一个页面：捕获 → 校准 → 评分，约 2-3 分钟。克隆产物照样能导出成可部署的离线包">只克隆此页</button>
  </div>

  <!-- 站点切换 + 本站操作（星图与工作视图现在共用 SiteBar；原先星图这里是把每个站点
       一个按钮加一个 ×、再并上四个功能按钮平铺，站点到八个就折成三行） -->
  <SiteBar v-if="view === 'atlas'" class="sites" :sites="sites" :host="host" :actions="siteActions" :busy="!!engine.audit || !!engine.clone" @pick="pickSiteByHost" @action="onSiteAction" />

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
    :actions="workViewActions"
    @pick="pickSiteByHost" @action="onSiteAction" @close="view = 'atlas'"
    @detail="onNodeClick" @forge="startForge" @delete="deletePage"
    @forge-checked="forgeChecked" @remove-checked="removeChecked"
  />
  <JobsView
    v-if="view === 'jobs'"
    :tasks="tasks" :jobs="jobHistory" :sites="sites" :host="host" :engine="engine"
    :actions="workViewActions"
    @pick="pickSiteByHost" @action="onSiteAction" @close="view = 'atlas'"
  />

  <section class="work-view surface" v-if="view === 'reports'">
    <div class="wv-head">
      <b>报告中心 · {{ host || '未选择站点' }}</b>
      <span class="wv-stat">克隆档案 / SEO / 体检 / 交互镜像 / 对标 / 情报</span>
      <SiteBar :sites="sites" :host="host" :actions="workViewActions" @pick="pickSiteByHost" @action="onSiteAction" />
      <button class="wv-close" @click="view = 'atlas'" title="返回星图（Esc）"><Icon name="close" decorative /> 返回星图</button>
    </div>
    <div class="reports-scroll">
    <div class="report-card surface">
      <h3>克隆档案</h3>
      <p>{{ doneCount }} 页已克隆 · 平均视觉 {{ avgVisual }}</p>
      <a :href="`/${host}/index.html`" target="_blank" rel="noopener">打开档案</a>
    </div>
    <div class="report-card surface">
      <h3>分数走势</h3>
      <div class="trend-grid">
        <Sparkline label="SEO 审计分" :points="auditTrend" />
        <Sparkline label="平均视觉还原度" :points="cloneTrend" unit="%" />
      </div>
      <p class="trend-hint" v-if="!auditTrend.length && !cloneTrend.length">
        还没有记录 —— 跑一次「SEO 审计」或整站克隆，这里就会出现第一个点
      </p>
      <p class="trend-hint" v-else>
        数据来自本站历史（每次审计与每批整站克隆各记一笔）
        <template v-if="lastAuditPages">；最近一次审计覆盖 {{ lastAuditPages }} 页 —— 页数不同的两次分数不能直接比</template>
      </p>
    </div>
    <div class="report-card surface">
      <h3>SEO 审计报告</h3>
      <p v-if="auditReport">{{ auditReport.score }} 分 · {{ auditReport.pages }} 页 · {{ auditReport.issues }} 条问题</p>
      <p v-else>尚未运行（66 条规则 / 六分类评分）</p>
      <p class="trend-hint" v-if="auditReport?.field?.compare">{{ auditReport.field.compare.note }}</p>
      <p class="trend-hint" v-else-if="auditReport?.field && !auditReport.field.available">
        只有实验室数据（本机 Playwright 实测）：{{ auditReport.field.reason }}
      </p>
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
      <h3>交互镜像</h3>
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
      <!-- 交付：这个目录就是要交给同事的东西。路径、复制、打开文件夹三个动作都在这里，
           因为"导出成功了"和"我拿到了"之间还差一步 —— 找到它在哪。 -->
      <div class="bundle" v-if="liveHealth?.bundlePath">
        <code class="bundle-path" :title="liveHealth.bundlePath">{{ liveHealth.bundlePath }}</code>
        <div class="bundle-btns">
          <button @click="copyBundlePath" :title="'复制这一整行路径'">复制路径</button>
          <button @click="revealBundle" title="在资源管理器里定位这个目录">打开文件夹</button>
        </div>
        <p class="score-note">交给同事：整个目录拷走即可，对方跑 <code>node serve.mjs --port 8080</code>（零依赖）或 <code>docker compose up -d</code>。纯前端站已按 <code>--root mirror</code> 导出，不会再落到它自己的 404。</p>
      </div>
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
      <SiteBar :sites="sites" :host="host" :actions="workViewActions" @pick="pickSiteByHost" @action="onSiteAction" />
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
    <button v-for="v in VIEWS" :key="v.id" :class="{ on: view === v.id }" :aria-current="view === v.id ? 'page' : undefined" :title="v.hint" @click="selectView(v.id)">
      <b aria-hidden="true">{{ v.icon }}</b><span>{{ v.label }}</span>
    </button>
  </div>
</template>
