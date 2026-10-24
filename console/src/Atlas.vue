<script setup>
/**
 * Atlas — 全站星图（3D 力导向，graphify 同款形态）
 *
 * 静态模式：读已有 /<host>/recon/atlas.json（或从站点切换器载入任意已侦察站）
 * live 模式：POST /api/recon → SSE 事件流 → 节点逐个弹入生长
 * 点星球打开详情；克隆由详情或页面清单中的显式操作发起。
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
  loadingComponent: { render: () => h('div', { class: 'g3d-loading' }, '正在加载星图…') },
  errorComponent: { render: () => h('div', { class: 'g3d-loading', role: 'alert' }, '星图加载失败，请刷新页面重试。') },
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
/**
 * 验收相关的视图异步加载。
 *
 * Acceptance* 这十个组件加起来约 500KB 源码，原先静态 import 进 Atlas，
 * 于是它们和星图挤在同一个 chunk 里 —— **打开控制台就是为了克隆一个站，
 * 却要先下完一整套验收工作台**。而「项目验收」是一个独立的视图（view === 'acceptance'），
 * 「报告」页里那张验收汇总卡也只是报告页的一部分。
 * 拆成独立 chunk 之后：首屏只下外壳，点进去才拉。Graph3D 当初也是这么处理的。
 *
 * 沿用 Graph3D 的两个细节：120ms 内到货不闪占位；错误给一句人话而不是一片空白。
 */
const asyncView = (loader, label) => defineAsyncComponent({
  loader,
  loadingComponent: { render: () => h('div', { class: 'wv-empty', role: 'status' }, `正在加载${label}…`) },
  errorComponent: { render: () => h('div', { class: 'wv-empty', role: 'alert' }, `${label}加载失败，请刷新页面重试。`) },
  delay: 120,
  timeout: 30000,
});
const AcceptanceSummary = asyncView(() => import('./AcceptanceSummary.vue'), '验收汇总');
const AcceptanceWorkbench = asyncView(() => import('./AcceptanceWorkbench.vue'), '项目验收');
import DetailDock from './DetailDock.vue';
import ActivityRail from './ActivityRail.vue';
import TrashDialog from './TrashDialog.vue';
import { API, apiHeaders, wsUrl, wsOpenUrl, wsJson, tokenOf, staticUrl, artifactOpenUrl, staticBridgeNeeded, normalizeApiBase } from './api.js';
import { taskState, taskLabel, liveStageCn, fmtBytes, forgeStageProgress, stageProgressText, verifyPageProgress, userErrorText, streamBreakText } from './format.js';
import { pageNameOf, pagePathOf, normalizeSiteUrl, normalizePageUrl, workspaceHostOf, mirrorBridgeNeeded, localEngineSupportsMirror } from './pages.js';
import { hostOfTask, medianForgeSec } from './tasks.js';
import { liveHealthPrefetch } from './prefetch-cache.js';

import { PAGE_TYPES as PT, typeColor } from './types.js';
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
const targetInput = ref('');
const atlas = ref(null);
const live = ref(false);
const statusText = ref('');
const errMsg = ref('');
/**
 * 错误的三段式：一句人话 / 下一步 / 技术串。
 *
 * 以前只有 errMsg，而十几处调用传的是 `String(e)` —— 屏幕中间直接摆一行
 * `TypeError: Failed to fetch`。技术信息不是不能给，而是不该占着最显眼的位置：
 * 它进「详情」，要看的自己展开。文案的归类在 format.js 的 userErrorText 里。
 */
const errHint = ref('');
const errDetail = ref('');
function clearErr() { errMsg.value = ''; errHint.value = ''; errDetail.value = ''; }
/** 所有面向用户的失败都从这里出 —— 不直接给 errMsg 赋值，免得多出一条"没人话"的路径 */
function fail(message, hint = '', detail = '') {
  errMsg.value = String(message ?? '').slice(0, 220);
  errHint.value = hint || '';
  errDetail.value = detail ? String(detail).slice(0, 600) : '';
}
/** 把一个原始错误翻成人话（引擎没开 / 5xx / 超时 / busy …） */
function failFrom(raw, opts) { const t = userErrorText(raw, opts); fail(t.msg, t.hint, t.detail); }
// 任务中心：每个 forge 任务独立对象 + 独立 EventSource（修复并发克隆单例覆盖）
const tasks = reactive([]);
const activeTaskId = ref(null);
const forge = computed(() => tasks.find(t => t.localId === activeTaskId.value && t.kind !== 'clone') ?? null);
const taskSources = new Map();
const tasksOpen = ref(true);
const auditReport = ref(null);   // 最近一次 SEO 审计结果（报告入口）
const watchReport = ref(null);   // 最近一次变更监控结果（报告入口）
const okMsg = ref('');           // 成功提示（绿色 toast，与错误提示区分）
const trashOpen = ref(false);
/** 子组件上报"做完了"，统一走这里出提示（组件不直接碰父组件的 toast 状态） */
function toast(msg, ms = 4000) {
  okMsg.value = msg;
  setTimeout(() => { if (okMsg.value === msg) okMsg.value = ''; }, ms);
}
const jobHistory = ref([]);      // 引擎持久化的历史任务（/api/jobs.history）
const reportIndex = ref([]);     // 可用报告索引（/api/reports/:host）
const liveHealth = ref(null);    // 最新交互镜像体检（/api/live-health/:host，导出时生成）
const liveStrictPassed = computed(() => liveHealth.value?.strict === true
  && !!liveHealth.value.strictBlockers
  && Object.values(liveHealth.value.strictBlockers).every(count => count === 0));
const lastVerify = ref(null);    // 最近一次全站体检结果（/api/verify）
const liveRebuild = ref(false);  // 导出交互镜像前先重建 live 页面
const sessionState = ref(null);  // 本站登录态（/api/session/:host）：需要登录的站点靠它
const queueState = ref(null);    // 本站整站克隆的断点状态（/api/queue/:host）
const editManifest = ref(null);  // 改站起点清单（workspace/<host>/deliver/edit-manifest.json）
const newDomain = ref('');       // 域名替换：目标域名（输入）
const domainResult = ref(null);  // 域名替换：最近一次预览/替换的结果
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
function sseUrl(taskId) { const t = tokenOf(); return `${API}/api/events?task=${taskId}${t ? '&token=' + encodeURIComponent(t) : ''}`; }

/**
 * SSE 断流的看门狗 —— 每一条任务流都从这里挂 onerror。
 *
 * 原先各任务流自己写 `es.onerror = () => { close(); resolve(); }`，两种写法都不对：
 *   · forge 那条**只关连接、不置失败** —— 引擎退出/网络一抖，节点就永远显示"克隆中"，
 *     底部「进行中」轨道也一直挂着（它的判据就是"有任务没 done 没 failed"）；
 *   · 另外几条一律当"事件流中断"记失败 —— 但浏览器在自动重连时**也会先调一次 onerror**，
 *     于是一次 3 秒的抖动会被记成失败，而任务其实还在跑。
 *
 * 所以判据用 readyState：
 *   CLOSED(2)    —— 浏览器放弃重连（4xx/5xx、CORS、引擎拒绝），立刻置失败；
 *   CONNECTING(0) —— 正在自动重连，给 `graceMs` 宽限；这期间只要来一条消息就撤回。
 * 宽限期不能短：整站克隆的引擎侧可能几分钟才推一条事件（正在跑的页没有进度事件）。
 */
const STREAM_GRACE_MS = 20000;
function watchStream(es, task, close, onDrop) {
  const drop = () => {
    if (task._grace) { clearTimeout(task._grace); task._grace = null; }
    if (!task?.done && !task?.failed) onDrop();
  };
  es.onerror = () => {
    if (task.done || task.failed) {                     // 正常结束后浏览器也会报一次，忽略
      if (task._grace) { clearTimeout(task._grace); task._grace = null; }
      close(); return;
    }
    if (es.readyState === 2) { close(); drop(); return; }      // EventSource.CLOSED
    if (task._grace) return;
    task._grace = setTimeout(() => { task._grace = null; if (!task.done && !task.failed) { close(); drop(); } }, STREAM_GRACE_MS);
  };
  return {
    /** 收到任何事件就撤回宽限计时 —— 流还活着 */
    alive: () => { if (task._grace) { clearTimeout(task._grace); task._grace = null; } },
    stop: () => { if (task._grace) { clearTimeout(task._grace); task._grace = null; } close(); },
  };
}

/**
 * 一条普通任务流的完整挂载：断流即置失败 + 一句人话 + 状态条复位。
 * 任务流的调用点只用两件事 —— 收到消息时 `alive()`，收到 exit 时 `stop()`。
 */
function attachStream(es, task, close, what) {
  return watchStream(es, task, close, () => {
    if (task.done || task.failed) return;
    const t = streamBreakText({ what });
    task.failed = true; task.done = true; task.endedAt = Date.now(); task.stopping = false; task.error = t.msg;
    fail(t.msg, t.hint, t.detail);
  });
}

/**
 * 「停止」—— 长任务（整站克隆 / 审计 / 交互镜像导出）此前只能等。
 *
 * 引擎侧早就有了 `POST /api/jobs/:id/cancel`（core/src/engine-server.mjs:1551），
 * 控制台从来没调过。这里只发请求并置"正在停止"；**UI 的复位交给流上的 exit 事件**
 * （引擎会推 `status: 'cancelled'`）—— 不在这里抢先改状态，否则停止失败时界面已经骗人了。
 */
async function cancelJob(task = runningTask.value) {
  // 轨道发出的 stop 事件不带参数（它只知道“当前在跑的那一个”），所以缺省取 runningTask。
  // 模板里写成 cancelJob(runningTask) 会在渲染期就执行一次 —— 那是把这个调用当成了处理函数。
  if (!task?.taskId || task.stopping) return;
  task.stopping = true;
  try {
    const r = await fetch(`${API}/api/jobs/${encodeURIComponent(task.taskId)}/cancel`, { method: 'POST', headers: apiHeaders() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    // 引擎回的是"请求已受理"，进程收尾还要一两秒 —— 文案里别说成"已停止"
    toast(`${task.label ?? '任务'}：已请求停止，等它收尾…`, 5000);
  } catch (e) {
    task.stopping = false;
    failFrom(e, { what: '停止任务' });
  }
}
const hudPages = ref(0);
const hudEdges = ref(0);
const hudEdgesRendered = ref(0);
const hudOrigin = ref('');
const sites = ref([]);          // 已侦察站点清单（/api/sites）
const sitesLoaded = ref(false); // 站点清单是否已经问过一次（首启向导据此判断"确实没有站点"）
/** 当前站点的交互镜像产量。0 = 从没导出过 —— 镜像路由"本地无快照就反代回原站"，
 *  此时「交互镜像」入口打开的是原站本身，详情面板要如实说明（见 DetailDock 的 liveTitle）。
 *  null = 站点清单还没到，先不下结论。 */
const curSiteMirrored = computed(() => sites.value.find(s => s.host === host.value)?.mirrored ?? null);
const engine = ref({ ok: false, recon: null, forge: null });   // 引擎状态灯
/**
 * 星图自转开关。默认值跟随 prefers-reduced-motion。
 * 星图是这一屏唯一持续运动的元素，对勾了"减少动效"的用户，默认让它转是错的；
 * 用户仍可在面板/设置里主动勾上 —— 那是明确的意图，不该被我们覆盖。
 */
const prefersReducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const autoRotate = ref(!prefersReducedMotion);   // 星图自转开关
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
/**
 * 任务行能不能点开详情 —— 判据必须与"详情面板真的会渲染"完全一致。
 * 以前只判 `t.kind !== 'clone'`，于是「报告」「设置」里（以及星图没选中节点时）
 * 那些行**看着可点、点了什么也不发生**（写进 activeTaskId 的东西没人渲染）。
 */
const taskRowClickable = (t) => t.kind !== 'clone' && dockOpen.value;
const detailIntel = ref(null);       // 已锻页 intel.json
const detailScore = ref(null);       // 已锻页 score.json

// ---------- 工作台视图（v2）：星图 / 页面 / 任务 / 报告 / 设置 ----------
const view = ref('atlas');
const VIEWS = [
  { id: 'atlas', icon: '✦', label: '星图', hint: '全站力导向图：每个行星是一页，连线是站内链接' },
  { id: 'pages', icon: '▤', label: '页面', hint: '逐页清单：克隆状态 / 还原度 / 资产 / 缺口，可搜索筛选批量克隆' },
  { id: 'acceptance', iconName: 'swap', label: '项目验收', hint: '对照基线与目标项目，验证视觉、结构、交互与运行健康，查看缺陷和复现证据' },
  { id: 'jobs', icon: '◷', label: '任务', hint: '本次会话的任务与持久化历史（引擎重启也在）' },
  { id: 'reports', icon: '▦', label: '报告', hint: '克隆档案 / SEO 审计 / 体检 / 交互镜像 / 对标 / 情报' },
  { id: 'settings', icon: '⚙', label: '设置', hint: '模型服务、引擎地址与 Token、界面偏好' },
];
const tableNodes = ref([]);                       // 页面表格的响应式快照（含孤儿已克隆页）

/**
 * 地址栏与界面状态同步：?site=host&view=pages&page=xxx
 *
 * 以前 view / 当前站点 / 选中的页面全在内存里 —— 刷新一下回到星图首页，
 * 想"把某站某页的详情发给同事"也做不到。
 * 切视图用 pushState（后退键能在视图之间回退，这是"浏览"），
 * 选页 / 切站用 replaceState（那是同一个视图里的状态，不该刷历史）。
 * `?artifact=` 先于 Atlas 在 main.js 里被消费，不会冲突。
 */
const VIEW_IDS = new Set(VIEWS.map(v => v.id));
function readUrlState() {
  const q = new URLSearchParams(location.search);
  const v = q.get('view');
  return { site: q.get('site') || '', view: VIEW_IDS.has(v) ? v : 'atlas', page: q.get('page') || '' };
}
const viewFromUrl = () => {
  const v = new URLSearchParams(location.search).get('view');
  return VIEW_IDS.has(v) ? v : 'atlas';
};
let urlSyncSuspended = false;
function syncUrl() {
  if (urlSyncSuspended) return;
  const q = new URLSearchParams(location.search);
  q.delete('artifact');    // 产物票据用完即弃，不该跟着地址栏活下去
  if (host.value) q.set('site', host.value); else q.delete('site');
  if (view.value && view.value !== 'atlas') q.set('view', view.value); else q.delete('view');
  const page = selected.value ? pageNameOf(selected.value) : '';
  if (page) q.set('page', page); else q.delete('page');
  const next = location.pathname + (q.toString() ? '?' + q.toString() : '');
  const current = location.pathname + location.search;
  if (next === current) return;
  // 切视图 = 一次浏览动作，进历史；选页 / 切站是同一视图内的状态，只替换当前条
  if (viewFromUrl() !== view.value) history.pushState(null, '', next);
  else history.replaceState(null, '', next);
}
watch([view, host, selected], syncUrl);

/** 从地址栏恢复视图与选中页。站点本身由调用方（首次加载 / popstate）先切好。 */
function applyUrlState(state = readUrlState()) {
  // 恢复过程本身会改 view（触发 syncUrl），而这时 selected 还是空的 ——
  // 不挂起的话地址栏里的 page 会被自己抹掉。恢复期间一律不写地址栏。
  urlSyncSuspended = true;
  const release = () => { urlSyncSuspended = false; syncUrl(); };
  if (state.view && VIEW_IDS.has(state.view)) view.value = state.view;
  if (!state.page) { release(); return; }
  const wanted = state.page;
  const find = () => nodes.find(n => pageNameOf(n) === wanted) ?? null;
  const first = find();
  // 找到节点 ≠ 恢复成功：onNodeClick 在 pagesLoading 期间会直接返回。
  // 以前这里无条件 release()，于是"找到了但被拒收"照样把地址栏的 page 抹掉。
  if (first) {
    onNodeClick(first);
    if (selected.value) { release(); return; }
  }
  // 星图可能还在路上（pickSite 的 atlas.json 是异步读的），页面状态也可能还在加载
  // （onNodeClick 在 pagesLoading 时会直接返回）。有界重试：**只有真的选中了才算成功** ——
  // 否则会把"找到了节点但被拒收"误判成恢复完成，地址栏里的 page 照样被抹掉。
  let tries = 0;
  const retry = () => {
    const node = pagesLoading.value ? null : find();
    if (node) {
      onNodeClick(node);
      if (selected.value) { release(); return; }
    }
    if (++tries <= 200) { setTimeout(retry, 100); return; }   // 最多等 20 秒：大站的页面状态加载不便宜
    release();   // 确实恢复不了：放开同步，让地址栏回到真实状态
  };
  setTimeout(retry, 100);
}
function onPopState() {
  const state = readUrlState();
  urlSyncSuspended = true;
  const target = sites.value.find(s => s.host === state.site) ?? null;
  const settle = () => { applyUrlState(state); urlSyncSuspended = false; syncUrl(); };
  if (target && target.host !== host.value) {
    Promise.resolve(pickSite(target)).then(settle, settle);
  } else {
    settle();
  }
}
/**
 * 逐页状态是否还在加载。
 * 数字没到之前**不能显示 0** ——"这站一页都没克隆"和"还没算完"是两件事，
 * 而用户会把前者当真（实测：61 页的站点第一眼显示"0 页已克隆 · 平均视觉 —"）。
 */
const pagesLoading = ref(false);
let siteEpoch = 0;
let pageLoadSerial = 0;
const extraNodes = ref([]);                       // 已克隆但不在 atlas 中的页面（补全清单）
const pageScores = reactive({});                  // nodeId -> score.json（懒加载）
const pageVerify = reactive({});                  // nodeId -> verify.json（多视口，懒加载）
const pageMeta = reactive({});                    // nodeId -> { assets, visualGaps, interactions, updatedAt }
const tokenInput = ref(localStorage.getItem('heimdall-token') ?? '');
const apiBaseInput = ref(localStorage.getItem('heimdall-api') ?? API);
// 「克隆档案」卡片用（报告页）。PagesView 里那份是它自己的，两者数据源相同但各自持有 ——
// 卡片只需要两个数字，为它把 PagesView 的 props 反向暴露出去并不划算。
// 报告页已有专属卡片的报告 id —— 不能让它们在"设计资产"里再出现一遍
const CARDED_REPORTS = new Set(['archive', 'compare', 'seo', 'watch', 'assets', 'intel', 'verify', 'edit-manifest']);
const designReports = computed(() => reportIndex.value.filter(r => r.available && !CARDED_REPORTS.has(r.id)));

/**
 * 按 id 查报告索引。引擎已经算好了 `available` 与它的真实 URL（`/static/<host>/…`），
 * 卡片**不要自己拼路径** —— 拼出来的那一份既可能 404，又是同一件事的第二份实现
 * （这个仓库里 pageNameOf / liveUrl 都吃过这个亏）。
 */
const reportById = computed(() => Object.fromEntries(reportIndex.value.map(r => [r.id, r])));
const reportUrl = (id) => artifactOpenUrl(reportById.value[id]?.url);
const hasReport = (id) => !!reportById.value[id]?.available;

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

function selectView(id) {
  if (id === 'pages' && view.value === 'pages') { view.value = 'atlas'; return; }   // 再次点击 = 收起
  view.value = id;
  if (id === 'jobs') loadJobHistory();
  if (id === 'reports') { loadLiveHealth(); loadVerifySummary(); }   // 存储/资产卡片挂在报告页，v-if 挂载时自己拉数据
  if (id === 'settings') loadLlm();
}
function togglePages() { if (view.value === 'pages') view.value = 'atlas'; else { view.value = 'pages'; loadPageStatus(); } }
/** 工作视图表头的站点切换（SiteBar emit） */
function pickSiteByHost(h) {
  const s = sites.value.find(x => x.host === h);
  if (s) pickSite(s);
}
async function deleteSite(s) {
  if (!s?.host) return;
  const typed = prompt('将站点 ' + s.host + ' 移入“最近删除”（持续保留，可在设置中恢复）。\n请输入站点名 ' + s.host + ' 确认：');
  if (typed !== s.host) {
    if (typed !== null) fail('站点名不一致，没有删除。', '确认框里要一字不差地填站点名（' + s.host + '）才会删。');
    return;
  }
  try {
    const r = await fetch(API + '/api/sites/' + encodeURIComponent(s.host), { method: 'DELETE', headers: apiHeaders(), body: JSON.stringify({ confirmHost: typed }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    sites.value = sites.value.filter(x => x.host !== s.host);
    if (host.value === s.host) {
      if (sites.value[0]) pickSite(sites.value[0]);
      else resetSiteContext('');
    }
    okMsg.value = '已移入最近删除：' + s.host + '（可在设置中恢复）';
    setTimeout(() => { okMsg.value = ''; }, 2500);
  } catch (e) { failFrom(e, { what: '把站点移入最近删除' }); }
}
async function removePageNode(n) {
  const forHost = host.value;
  if (pagesLoading.value || !forHost || n.siteHost !== forHost) throw new Error('页面不属于当前站点，请重新选择站点');
  const name = n.pageName ?? pageNameOf(n);
  const r = await fetch(API + '/api/sites/' + encodeURIComponent(forHost) + '/pages/' + encodeURIComponent(name), { method: 'DELETE', headers: apiHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  if (host.value !== forHost) return j;
  delete pageScores[n.id];
  nodes = nodes.filter(x => x.id !== n.id);
  extraNodes.value = extraNodes.value.filter(x => x.id !== n.id);
  if (selected.value === n) selected.value = null;
  bump();
  return j;
}
async function deletePage(n) {
  const name = n.pageName ?? pageNameOf(n);
  if (!confirm('将页面 ' + (n.path || name) + ' 移入“最近删除”，并从星图移除该节点？可在设置中恢复。')) return;
  try {
    const j = await removePageNode(n);
    okMsg.value = '已移入最近删除：' + name + '（可在设置中恢复）';
    setTimeout(() => { okMsg.value = ''; }, 2500);
    loadSites();
  } catch (e) { failFrom(e, { what: '把页面移入最近删除' }); }
}
async function onTrashRestored(entry) {
  await loadSites();
  const restored = sites.value.find(site => site.host === entry.host);
  if (restored && (entry.kind === 'site' || host.value === entry.host)) pickSite(restored);
  toast('已恢复 ' + entry.host + (entry.name ? '/' + entry.name : ''));
}
async function removeChecked(ids) {
  if (pagesLoading.value) return;
  const forHost = host.value;
  const targets = tableNodes.value.filter(n => ids.includes(n.id) && n.siteHost === forHost && n.forgeState !== 'running');
  if (!targets.length) return;
  if (!confirm('将选中的 ' + targets.length + ' 个页面移入“最近删除”，并从星图移除节点？可在设置中恢复。')) return;
  let ok = 0, fail = 0;
  for (const n of targets) {
    if (host.value !== forHost) break;
    try { await removePageNode(n); ok++; } catch { fail++; }
  }
  okMsg.value = '已移入最近删除 ' + ok + ' 个页面' + (fail ? '（' + fail + ' 失败）' : '');
  setTimeout(() => { okMsg.value = ''; }, 3000);
  loadSites();
}
function saveApiBase() {
  const v = apiBaseInput.value.trim() || 'http://127.0.0.1:8900';
  const base = normalizeApiBase(v);
  if (!base) { fail('这个引擎地址不能用。', '只填到源地址为止，例如 http://127.0.0.1:8900 —— 不要带路径、账号或 ?query。'); return; }
  if (location.protocol === 'https:' && !base.startsWith('https:')) {
    fail('HTTPS 页面不能直连 HTTP 引擎。', '换成 https 开头的引擎地址，或者直接用 http://127.0.0.1:8900 打开控制台。');
    return;
  }
  localStorage.setItem('heimdall-api', base);
  location.reload();
}

function canonicalPageUrl(input) {
  try {
    const url = new URL(input);
    url.hash = '';
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch { return String(input ?? ''); }
}

async function loadPageStatus() {
  // 记住这次请求是替哪个站点发的。切站之后回来的响应属于上一个站 ——
  // 不丢掉的话，它会把上一个站的分数写进本页的 pageScores（按 nodeId 存，两边同号就串），
  // 于是新站的"平均视觉"显示出旧站的数字（实测：切到没有克隆页的站，表头却显示 99.1%）。
  const forHost = host.value;
  const epoch = siteEpoch;
  const serial = ++pageLoadSerial;
  if (!forHost) { pagesLoading.value = false; return; }
  pagesLoading.value = true;
  try {
    const r = await fetch(API + '/api/pages/' + encodeURIComponent(forHost), { headers: apiHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const { pages } = await r.json();
    if (host.value !== forHost || siteEpoch !== epoch || pageLoadSerial !== serial) return;
    const byUrl = new Map();
    for (const p of pages) {
      byUrl.set(canonicalPageUrl(p.target), p);
    }
    const matchedNames = new Set();
    for (const n of nodes) {
      const hit = byUrl.get(canonicalPageUrl(n.url));
      if (hit) {
        n.forgeState = 'done'; n.pageName = hit.name; pageScores[n.id] = hit.score ?? null; matchedNames.add(hit.name);
        // 视觉列的最差视口也来自这一条响应（引擎已把 verify.json 的两项一起给出）。
        // 此前是逐页再发 score.json + verify.json 两个请求 —— 80 页就是 160 个，
        // 而分数本来就包含在这条响应里，等于白拉了一遍。
        pageVerify[n.id] = hit.minViewport ? { minViewport: hit.minViewport, scoreVersion: hit.verifyScoreVersion, measured: hit.verifyMeasured } : null;
      pageMeta[n.id] = { assets: hit.assets ?? null, visualGaps: hit.visualGaps ?? null, interactions: hit.interactions ?? null, verifyFresh: hit.verifyFresh ?? false, artifacts: hit.artifacts ?? null, updatedAt: hit.updatedAt ?? null, motion: hit.motion ?? null };
      }
    }
    // 补全：已克隆但不在 atlas 中的页面（例如 recon 截断、删过节点），保证清单是"完全体"
    extraNodes.value = pages.filter(p => !matchedNames.has(p.name)).map(p => {
      const path = pagePathOf({ url: p.target }) || p.target;
      return { id: 'forged:' + p.name, url: p.target, path, title: p.target, type: 'generic', depth: 99, ring: 3, forgeState: 'done', synthetic: true, pageName: p.name, siteHost: forHost };
    });
    for (const n of extraNodes.value) {
      const hit = pages.find(p => p.name === n.pageName);
      pageScores[n.id] = hit?.score ?? null;
      pageVerify[n.id] = hit?.minViewport ? { minViewport: hit.minViewport, scoreVersion: hit.verifyScoreVersion, measured: hit.verifyMeasured } : null;
      pageMeta[n.id] = { assets: hit?.assets ?? null, visualGaps: hit?.visualGaps ?? null, interactions: hit?.interactions ?? null, verifyFresh: hit?.verifyFresh ?? false, artifacts: hit?.artifacts ?? null, updatedAt: hit?.updatedAt ?? null, motion: hit?.motion ?? null };
    }
    tableNodes.value = [...nodes, ...extraNodes.value];
    loadQueue(forHost);
    loadEditManifest(forHost);
  } catch (e) {
    if (host.value === forHost && siteEpoch === epoch && pageLoadSerial === serial) failFrom(e, { what: '加载页面状态' });
  }
  finally { if (host.value === forHost && siteEpoch === epoch && pageLoadSerial === serial) pagesLoading.value = false; }
}

/** 整站克隆的断点状态（/api/queue/<host>）：让"还剩 N 页、可以直接续跑"成为可显示的读数。
 *  此前一批 60 页的站中断后，用户能做的唯一判断是"再点一次整站克隆"，而不知道它会不会重头再来。 */
async function loadQueue(h) {
  try {
    const r = await fetch(API + '/api/queue/' + encodeURIComponent(h), { headers: apiHeaders() });
    if (!r.ok || host.value !== h) return;
    const j = await r.json();
    if (host.value !== h || j.host !== h) return;
    // 即使还没有 queue.json，API 仍会给出侦察范围；操作入口需要这份分母。
    queueState.value = j;
  } catch { /* 引擎离线：保持上一次读数 */ }
}

/** 改站起点清单（引擎生成的 workspace 产物）。取不到就当"还没生成"。 */
async function loadEditManifest(h) {
  const reports = await loadReports();
  if (host.value !== h) return;
  const available = reports.some(r => r.id === 'edit-manifest' && r.available);
  const j = available ? await wsJson(h, 'deliver/edit-manifest.json') : null;
  if (host.value !== h) return;
  editManifest.value = j;
  domainResult.value = null;   // 换站了，上一次的替换读数不再适用
}

/** 本站的原站域名 —— 域名替换的默认"从" */
function originHostOf() {
  try { return new URL(atlas.value?.origin ?? ('https://' + host.value)).hostname; } catch { return host.value; }
}

/** 生成/刷新「改站起点」清单：引擎侧子进程（大站约 5s），完成后读回产物 */
function runEditManifest() {
  const h = host.value;
  const task = reactive({
    localId: 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'editmanifest', label: '改站清单 · ' + h, url: 'https://' + h,
    taskId: null, progress: '', done: false, failed: false, stopping: false, error: null, startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '改站清单 · 统计中';
  (async () => {
    try {
      const r = await fetch(API + '/api/edit-manifest', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: h }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '生成改站清单' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '改站清单');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'edit-manifest') {
          task.progress = `${ev.assets} 资源 · ${ev.remoteVisual} 外链视觉`;
          task.done = true; task.endedAt = Date.now();
          statusText.value = `改站清单完成 · ${ev.assets} 个资源 / ${ev.remoteVisual} 个仍是外链的视觉资产`;
          stream.stop(); loadEditManifest(h);
          setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断';
          fail('引擎那边的进程没有正常结束。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          stream.stop();
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '生成改站清单' }); task.error = errMsg.value; }
  })();
}

/**
 * 在资源管理器里定位一个产物路径（引擎只接受 DATA_ROOT 以内的路径）。
 *
 * 以前三处调用各写一份 fetch —— 合到一处，因为"产物到底落在哪"这个问题只会越来越多
 * （静态镜像 / 交互镜像 / 交付包 / 清单里的单个资源）。`what` 只影响报错文案：
 * 产物还不存在时**必须说清"先去跑一次"**，否则用户会以为按钮坏了 —— 引擎对缺失路径
 * 回的是 404 `not found`，和"路径非法""引擎没开"混在一起就分不出来。
 */
async function revealPath(rel, what = '产物') {
  if (!rel) { fail(`还不知道${what}在哪里。`, '先跑一次对应的任务；产物生成之后这里才有可定位的路径。'); return; }
  try {
    const r = await fetch(API + '/api/reveal', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ path: rel }) });
    if (r.ok) return;
    const j = await r.json().catch(() => ({}));
    if (j.error === 'not found') fail(`还没有这个${what}。`, `产物目录还不存在（${rel}）—— 先跑一次对应的任务，再回来定位。`, 'HTTP 404 not found');
    else fail(`打不开${what}所在的文件夹。`, '引擎可能没有权限或已被关闭；重试一次，不行就重启引擎。', j.error ?? `HTTP ${r.status}`);
  } catch (e) { failFrom(e, { what: `定位${what}` }); }
}

/** 在资源管理器里定位清单里的某个资源（换图时最常用的下一步） */
async function revealManifestAsset(a) {
  const page = a.pages?.[0];
  if (!page || !a.local) { fail('这个资源还没有本地副本，仍是外链。', '先到「报告 → 资产缺口」跑一次扫描并补齐，再回来定位。'); return; }
  return revealPath(`workspace/${host.value}/pages/${page}/clone/${a.local}`, '本地资源');
}

/** 域名替换：apply=false 只预览（默认），true 才真改（引擎侧先备份再改） */
function runReplaceDomain(apply) {
  const h = host.value;
  const to = newDomain.value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!to) { fail('还没填要换成的新域名。', '在右边输入框里填新域名（例如 mysite.com），先点「预览」看清会改哪些地方。'); return; }
  const task = reactive({
    localId: 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'replace-domain', label: (apply ? '替换域名 · ' : '预览替换 · ') + originHostOf() + ' → ' + to,
    url: 'https://' + h, taskId: null, progress: '', done: false, failed: false, stopping: false, error: null, startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = apply ? '替换域名 · 写入中（改前会先备份）' : '替换域名 · 预览中';
  (async () => {
    try {
      const r = await fetch(API + '/api/replace-domain', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: h, from: originHostOf(), to, apply }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '域名替换' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '域名替换');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'replace-domain') {
          domainResult.value = ev;
          task.progress = `${ev.files} 文件 / ${ev.occurrences} 处`;
          task.done = true; task.endedAt = Date.now();
          statusText.value = ev.mode === 'apply'
            ? `已替换 ${ev.changed} 个文件（备份已生成）`
            : `预览：命中 ${ev.files} 个文件 / ${ev.occurrences} 处`;
          stream.stop(); if (ev.mode === 'apply') loadEditManifest(h);
          setTimeout(() => { statusText.value = ''; }, 5000);
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断';
          fail('引擎那边的进程没有正常结束。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          stream.stop();
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '域名替换' }); task.error = errMsg.value; }
  })();
}
async function establishBrowserSession() {
  if (!tokenOf()) return;
  const r = await fetch(`${API}/api/status`, {
    headers: apiHeaders(), credentials: mirrorBridgeNeeded() ? 'omit' : 'include',
  });
  if (!r.ok) throw new Error('Token 无效或引擎未就绪');
}

async function saveToken() {
  const v = tokenInput.value.trim();
  const previous = tokenOf();
  const crossOrigin = mirrorBridgeNeeded();
  if (v) localStorage.setItem('heimdall-token', v); else localStorage.removeItem('heimdall-token');
  try {
    if (v) await establishBrowserSession();
    else if (!crossOrigin) {
      const r = await fetch(`${API}/api/auth/logout`, { method: 'POST', credentials: 'include' });
      if (!r.ok) throw new Error(`引擎注销失败：${r.status}`);
    }
    okMsg.value = v
      ? mirrorBridgeNeeded()
        ? localEngineSupportsMirror() ? 'Token 已保存，交互镜像将通过一次性授权打开' : 'Token 已保存；独立子域镜像需要本机引擎'
        : 'Token 已保存，浏览器产物访问已授权'
      : crossOrigin ? 'Token 已清除；已打开的镜像会话可能持续到 Cookie 过期' : 'Token 已清除';
    clearErr();
    loadSites();
    if (host.value) loadPageStatus();
  } catch (e) {
    if (v) {
      if (previous) localStorage.setItem('heimdall-token', previous);
      else localStorage.removeItem('heimdall-token');
    }
    failFrom(e, { what: '校验引擎 Token' });
  }
  setTimeout(() => { okMsg.value = ''; }, 2500);
}

// 3D 图数据（Graph3D 消费）
const gNodes = ref([]);
const gLinks = ref([]);
// 空态不下载 three；首次有节点后保持挂载，切页时复用 WebGL 实例。
const graphRequested = ref(false);
watch([gNodes, view], ([currentNodes, currentView]) => {
  if (currentView === 'atlas' && currentNodes.length > 0) graphRequested.value = true;
}, { immediate: true });
const gTick = ref(0);
const bump = (loadStatus = true) => { gNodes.value = [...nodes]; gLinks.value = [...edges]; gTick.value++; tableNodes.value = [...nodes, ...extraNodes.value]; if (loadStatus) scheduleScoreLoad(); };

let nodes = [], edges = [];
const urlNode = new Map();
/**
 * 星图/清单里识别"同一个页面"的键：**去掉尾斜杠**（与引擎侧 src/url-canon.mjs 同一口径）。
 *
 * 不加这个，`https://x` 与 `https://x/` 就是两个节点 —— 星图上长出两颗重叠的星球，
 * 页面清单里两行一模一样的路径；而产物目录名是按去尾斜杠的 path 算的，
 * 于是克隆其中一条会让另一条也显示"已克隆"。
 *
 * 引擎侧（recon.mjs）已经做了归一，但**实时侦察的 SSE 路径当时漏了**：
 * 页面在侦察过程中就重复长出来，直到侦察结束重读 atlas（buildStatic 会去重）才恢复。
 */
const urlKey = canonicalPageUrl;
let pendingEdges = [];
let es = null;

function makeNode(ev, ringIdx) {
  return {
    ...ev,
    ring: ringIdx,
    forgeState: 'idle',
    siteHost: host.value,
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
    const key = urlKey(n.url);
    if (seenUrls.has(key)) continue;   // 去重：https://x 与 https://x/ 视为同一页
    seenUrls.add(key);
    const ringIdx = n.depth === 0 ? 0 : n.depth === 1 ? 1 : 2;
    const node = makeNode(n, ringIdx);
    nodes.push(node);
    urlNode.set(key, node);   // 供后续 edges 事件按归一化键查找
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
  bump(false);
  loadPageStatus();
}

function resetSiteContext(nextHost) {
  siteEpoch++;
  pageLoadSerial++;
  clearTimeout(scoreLoadTimer);
  es?.close(); es = null;
  host.value = nextHost;
  targetInput.value = nextHost;
  nodes = []; edges = []; urlNode.clear(); pendingEdges = [];
  atlas.value = null;
  extraNodes.value = [];
  for (const bag of [pageScores, pageMeta, pageVerify]) for (const key of Object.keys(bag)) delete bag[key];
  selected.value = null; detailIntel.value = null; detailScore.value = null;
  reportIndex.value = []; lastVerify.value = null; liveHealth.value = null;
  queueState.value = null; editManifest.value = null; domainResult.value = null;
  auditReport.value = null; watchReport.value = null; assetAuditReport.value = null;
  matrixReport.value = null; sessionState.value = null; siteHistory.value = [];
  hudPages.value = 0; hudEdges.value = 0; hudEdgesRendered.value = 0; hudOrigin.value = nextHost;
  // 切站时侦察必然已经不在跑了（换站会关掉那条流）—— 不复位的话「侦察」按钮
  // 会一直停在 disabled 的"侦察中…"，用户只能刷新页面
  live.value = false; statusText.value = '';
  pagesLoading.value = !!nextHost;
  bump(false);
  return siteEpoch;
}

// ---------- live 侦察 ----------
function startRecon() {
  const url = normalizeSiteUrl(targetInput.value);
  if (!url) { fail('这个网址看不出来是什么站点。', '填完整域名，例如 apify.com 或 https://apify.com/store —— 带路径也行。'); return; }
  const epoch = resetSiteContext('');
  targetInput.value = url;
  clearErr(); live.value = true; statusText.value = '光点出发';
  hudOrigin.value = url.replace(/^https?:\/\//, '');

  fetch(`${API}/api/recon`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url, maxPages: 30 }) })
    .then(r => r.json())
    .then(({ taskId, error, siteId }) => {
      if (siteEpoch !== epoch) return;
      if (error) {
        live.value = false; statusText.value = '';
        if (error === 'busy') fail('引擎正忙：已经有一个侦察在跑。', '等它跑完（看底部「进行中」轨道），再点一次「侦察」。', 'HTTP 409 busy');
        else failFrom(error, { what: '侦察' });
        return;
      }
      host.value = siteId || workspaceHostOf(url);
      listen(taskId, epoch);
    })
    .catch(e => { if (siteEpoch === epoch) { live.value = false; statusText.value = ''; failFrom(e, { what: '侦察' }); } });
}

function listen(taskId, epoch) {
  es = new EventSource(sseUrl(taskId));
  /**
   * 侦察流的状态位。**断流要复位 live** —— 原先 onerror 只是关掉连接，
   * 于是 `live` 永远是 true：顶部状态条带着 live 的呼吸动画停在"光点出发"，
   * 「侦察」按钮也永远停在不可再点的样子，看起来像引擎还在跑。
   * 用一个只带这两个字段的小对象喂给 watchStream（它只读 done/failed）。
   */
  const state = { done: false, failed: false };
  const stream = watchStream(es, state, () => { try { es?.close(); } catch {} es = null; }, () => {
    const t = streamBreakText({ what: '侦察' });
    live.value = false; statusText.value = '';
    fail(t.msg, t.hint, t.detail);
  });
  es.onmessage = (m) => {
    stream.alive();
    if (siteEpoch !== epoch) { stream.stop(); return; }
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.kind === 'calibrated') {
      if (ev.host) host.value = ev.host;
      hudOrigin.value = (ev.origin ?? '').replace(/^https?:\/\//, '');
    } else if (ev.kind === 'page') {
      const k = urlKey(ev.url);
      if (urlNode.has(k)) return;   // 同一页的另一种写法（尾斜杠）—— 不再长第二颗星球
      const ringIdx = ev.depth === 0 ? 0 : ev.depth === 1 ? 1 : 2;
      const node = makeNode(ev, ringIdx);
      nodes.push(node);
      urlNode.set(k, node);
      statusText.value = '新星点亮';
      bump();
    } else if (ev.kind === 'edges') {
      pendingEdges.push({ from: ev.from, tos: ev.tos });
    } else if (ev.kind === 'recon-error') {
      // 引擎单页失败：技术串原样保留在详情里，正文给一句人话
      fail('有一页没能抓下来（其余页面不受影响）。', '通常是这一页需要登录或加载超时；要整页排查就展开详情看引擎的原始报错。', ev.error);
    } else if (ev.kind === 'exit') {
      state.done = true;
      stream.stop();
      if (ev.status === 'done') finishRecon(taskId, epoch);
      else {
        live.value = false; statusText.value = '';
        if (ev.status === 'cancelled') fail('侦察已取消。', '想要全站视图就再点一次「侦察」；已经抓到的页面不会丢。');
        else fail('侦察没有跑完。', '重跑一次；同一个站反复失败就展开详情，把原始错误和 engine.log 一起看。', `exit status: ${ev.status}`);
      }
    }
  };
}

async function finishRecon(taskId, epoch) {
  statusText.value = '星图定稿';
  try {
    const response = await fetch(`${API}/api/atlas/${taskId}`, { headers: apiHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const a = await response.json();
    if (siteEpoch !== epoch) return;
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
    bump(false);
    loadPageStatus();
    loadSites();
  } catch {}
  live.value = false;
  setTimeout(() => { statusText.value = ''; }, 2500);
}

// ---------- 每帧消化 pending 边（两端点亮后浮现） ----------
const edgeTick = setInterval(() => {
  for (let i = pendingEdges.length - 1; i >= 0; i--) {
    const pe = pendingEdges[i];
    const f = urlNode.get(urlKey(pe.from));
    let added = false;
    for (const to of pe.tos) {
      const t2 = urlNode.get(urlKey(to));
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
    const r = await fetch(`${API}/api/sites`, { headers: apiHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    sites.value = (await r.json()).sites ?? [];
  } catch (e) { failFrom(e, { what: '加载站点列表' }); }
  sitesLoaded.value = true;   // 首启向导只在**确认过**没有站点时才出现，避免加载中闪一下
}
async function pollEngine() {
  try {
    const r = await fetch(`${API}/api/status`, { headers: apiHeaders() });
    engine.value = await r.json();
  } catch { engine.value = { ok: false }; }
}
const pollTick = setInterval(pollEngine, 15000);
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
    const r = await fetch(API + '/api/session/' + encodeURIComponent(host.value), { headers: apiHeaders() });
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
    taskId: null, done: false, failed: false, stopping: false, error: null, startedAt: Date.now(), endedAt: null,
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
        if (error === 'busy') fail('已经有一个登录窗口开着了。', '先去那个窗口把登录做完并关掉标签页，再回这里点一次。', 'HTTP 409 busy');
        else failFrom(error, { what: '打开登录窗口' });
        task.error = errMsg.value;
        return;
      }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '登录窗口');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind !== 'exit') return;
        task.done = true; task.endedAt = Date.now();
        if (ev.status !== 'done') task.failed = true;
        stream.stop();
        loadSession();
        statusText.value = '';
        okMsg.value = ev.status === 'done' ? '登录态已保存 —— 之后的抓取会自动带上它' : '登录窗口已结束，但可能没存下会话';
        setTimeout(() => { okMsg.value = ''; }, 6000);
      };
    } catch (e) {
      task.failed = true; task.done = true;
      failFrom(e, { what: '打开登录窗口' });
      task.error = errMsg.value;
    }
  })();
}

const siteActions = computed(() => {
  const has = !!host.value;
  const cloned = doneCount.value;
  const scope = queueState.value?.scope;
  const hasAtlas = Array.isArray(atlas.value?.nodes) && atlas.value.nodes.length > 0;
  return [
    { id: 'audit', label: 'SEO 审计', hint: '66 条规则 · 六分类评分 · 输出 HTML/CSV/JSON 报告', disabled: !has || !!engine.value.audit },
    {
      id: 'clone-incremental',
      label: cloned ? '增量克隆' : '整站克隆',
      hint: cloned ? '只重跑源站变了的页（按服务端 HTML 指纹判断，不起浏览器）' : '把侦察到的页面逐页克隆；由引擎执行，关掉本页也会继续',
      disabled: !has || !!engine.value.clone,
    },
    ...(hasAtlas ? [{
      id: 'clone-all-discovered',
      label: '克隆全部已发现页面',
      hint: scope?.status === 'ok'
        ? `把已发现的 ${scope.discovered} 个有效同源页面全部入队，包含登录和法务页。${scope.maxPages == null ? '侦察页数上限未记录' : `侦察最多 ${scope.maxPages} 页`}${scope.maxDepth == null ? '' : `、深度 ${scope.maxDepth}`}，可能尚未发现整个站点。`
        : '正在确认侦察范围；范围无效时需先重新侦察。',
      disabled: !has || !!engine.value.clone || scope?.status !== 'ok',
    }] : []),
    // 断点续跑：上一批没跑完才出现。续跑本质就是增量克隆（queue.json 会跳过已完成页），
    // 但把它单独列出来、并写明"剩 N 页"，用户才敢点第二次。
    ...(queueState.value && queueState.value.unfinished > 0 ? [{
      id: 'clone-resume',
      label: `继续整站克隆（剩 ${queueState.value.unfinished} 页）`,
      hint: `上次整站克隆完成 ${queueState.value.done}/${queueState.value.total}，还有 ${queueState.value.unfinished} 页未完成。续跑会跳过已完成页，不会重头再来。`,
      disabled: !!engine.value.clone,
    }] : []),
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
    { id: 'delete', label: '删除本站', hint: '将侦察、克隆与报告移入最近删除，可在设置中恢复', danger: true, disabled: !has },
  ];
});
/** 工作视图自己就是清单，不需要「页面清单」那一项；其余动作与星图一致 */
const workViewActions = computed(() => siteActions.value.filter(a => a.id !== 'pages'));

function onSiteAction(id) {
  if (id === 'audit') return runAudit();
  if (id === 'clone-incremental') return startCloneSite({ incremental: doneCount.value > 0 });
  if (id === 'clone-all-discovered') {
    if (queueState.value?.scope?.status !== 'ok' || !atlas.value?.nodes?.length) {
      fail('还不确定这次要克隆哪些页。', '先对这个站跑一次侦察（或刷新站点列表），再点「克隆全部已发现页面」。');
      return;
    }
    return startCloneSite({ allDiscovered: true });
  }
  if (id === 'clone-resume') return startCloneSite({ incremental: true });
  if (id === 'clone-full') {
    if (!confirm(`全量重跑 ${host.value}？\n\n忽略「源站是否变过」，把本站全部页面重新克隆一遍。\n页面多时按小时计，期间引擎的并发槽会被占满。`)) return;
    return startCloneSite({ incremental: false });
  }
  if (id === 'pages') return togglePages();
  if (id === 'login') return runLogin();
  if (id === 'delete') { const s = sites.value.find(x => x.host === host.value); if (s) deleteSite(s); }
}

function pickSite(s) {
  if (!s) return Promise.resolve();
  const epoch = resetSiteContext(s.host);
  targetInput.value = s.origin ?? s.host;
  loadHistory(s.host);
  loadAuditReport(s.host);
  loadSession();
  // 站点可能只有克隆、没有全站侦察（用户直接 `forge <url>` 克隆单页 ——
  // 这正是"一次性便利"的主路径）。那种情况下没有 atlas.json 可读，
  // 但 /api/pages/<host> 仍然能列出已克隆的页面，所以退到"只有清单"而不是报错：
  // 站点出现在列表里却点不动，比不出现更让人困惑。
  const chain = (s.pages ? wsJson(s.host, 'recon/atlas.json') : Promise.resolve(null))
    .then(async (a) => {
      if (siteEpoch !== epoch) return;
      if (a) { buildStatic(a); return; }
      buildStatic({ origin: s.origin ?? ('https://' + s.host), nodes: [], edges: [], meta: { pages: 0, edges: 0 } });
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
    .catch(e => { if (siteEpoch === epoch) failFrom(e, { what: '载入站点' }); });
  // 返回这条链本身：地址栏恢复（applyUrlState）要在星图建好之后才能按页名找到节点。
  // 以前这里没有 return，调用方 await 到的是 undefined —— 于是刷新带 ?page= 时
  // 永远找不到那颗星，地址栏里的 page 被 syncUrl 抹掉。
  return chain;
}

/**
 * 首屏「只克隆此页」：不侦察整站，只跑输入框里这一个 URL 的克隆流水线。
 *
 * 存在理由：克隆与侦察本来是两条独立能力（引擎侧 /api/forge 与 /api/recon 互不依赖），
 * 但界面上只有「侦察」一个入口，于是"我只是想要这一页"的人被迫先侦察整站。
 * 单页克隆出来的站点没有星图，只有页面清单 —— 控制台会直接把清单摆出来。
 */
/** 「只克隆此页」是否在跑 —— 只为了让那个按钮显示"克隆中…"（进行态的可见性） */
const singleBusy = ref(false);
async function forgeSingle() {
  // 页面级归一：**保留路径**。站点选择仍然只取 origin（站点栏与产物路径都按站点走），
  // 两者以前是同一个函数、同一条 origin，于是填 `apify.com/store` 会克隆成首页。
  const url = normalizePageUrl(targetInput.value);
  if (!url) { fail('这个网址看不出来要克隆哪一页。', '填完整域名（可以带路径，例如 apify.com/store），再点一次。', String(targetInput.value || '')); return; }
  clearErr();
  const nextHost = sites.value.find(s => s.origin === new URL(url).origin)?.host ?? workspaceHostOf(url);
  if (nextHost !== host.value) {
    const site = sites.value.find(s => s.host === nextHost);
    if (site) pickSite(site);
    else {
      resetSiteContext(nextHost);
      loadPageStatus();
    }
    view.value = 'pages';
  }
  targetInput.value = url;
  // 这个按钮自己的进行态：任务进任务中心，但按钮也要立刻说"我在跑"
  const busy = startForge(null, { url });
  singleBusy.value = true;
  try { await busy; } finally { singleBusy.value = false; }
}

// ---------- forge：单页还原流水线 ----------
// node 可空：星图上点节点会传节点；首屏「只克隆此页」直接从输入框的 URL 起跑 ——
// 那条路径根本没有星图，也就没有节点。区别只有 pageName 的来源与 forgeState 往哪写。
function startForge(node, opts = {}) {
  return new Promise((resolve) => {
    if (node && (pagesLoading.value || node.siteHost !== host.value)) {
      fail('这一页不属于当前站点。', '等页面清单刷新完再点一次；还不行就先在星图上切换回它所属的站点。');
      return resolve();
    }
    const url = node?.url ?? opts.url;
    if (!url) return resolve();
    const requestEpoch = siteEpoch;
    // 页名只有一条规则（pages.js 的 pageNameOf，与 core 侧 url-canon 同源）。
    // 这里曾经内联了第二份：`node.path.replace(/^\//,'').replace(/\//g,'-')` ——
    // 它**不截断到 60 字符**。产物目录名是截断过的，所以凡是路径 ≥60 字符的页
    // （stripe 的 guides/best-practices-… 就有 62 字符）在控制台里都指向一个不存在的目录：
    // 详情面板的「还原度」「情报摘要」两块永远不出现，而 404 被 wsJson 吞成 null，
    // 看起来只是"这页没跑过"。
    const pageName = pageNameOf(node ?? { url });
    const setState = (s) => { if (node) node.forgeState = s; };
    const task = reactive({
      localId: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      pageName, url, nodeId: node?.id ?? null,
      stages: { capture: 'idle', build: 'idle', shot: 'idle', diff: 'idle', fixup: 'idle', harvest: 'idle' },
      score: null, done: false, failed: false, cancelled: false, stopping: false, intel: null, rounds: [], skipReason: null, error: null,
      logs: [],   // 子进程的实时输出（引擎以 {kind:'log'} 推进来）——只保留尾部，见下面的裁剪
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
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url }) });
        const { taskId, error, pageName: storedPageName, siteId } = await r.json();
        if (error) {
          task.failed = true; task.done = true; task.endedAt = Date.now();
          if (error === 'busy') {
            fail('克隆槽已满，这一页没能开始。', '引擎同时在跑 2 个克隆；等手上那页跑完（底部「进行中」轨道），再点一次。', 'HTTP 409 busy');
          } else failFrom(error, { what: '克隆这一页' });
          task.error = errMsg.value;
          setState('failed'); return resolve();      // 置 failed 而不是 idle：起步就失败也是一次失败
        }
        task.taskId = taskId;
        if (!node && siteId && host.value !== siteId && siteEpoch === requestEpoch) {
          resetSiteContext(siteId);
          targetInput.value = url;
          loadPageStatus();
        }
        if (storedPageName) {
          task.pageName = storedPageName;
          if (node) node.pageName = storedPageName;
        }
        const es = new EventSource(sseUrl(taskId));
        taskSources.set(task.localId, es);
        const closeTask = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
        // 断流必须置失败：否则 node.forgeState 永远停在 'running'，节点一直写"克隆中"，
        // 底部「进行中」轨道也下不来（它的判据就是"存在没 done 没 failed 的任务"）。
        const stream = watchStream(es, task, closeTask, () => {
          const t = streamBreakText({ what: '克隆' });
          task.failed = true; task.done = true; task.endedAt = Date.now(); task.error = t.msg;
          setState('failed');                       // ← 这一句原先根本没有
          statusText.value = '克隆中断 · ' + pageName;
          fail(t.msg, t.hint, t.detail);
          bump(); loadPageStatus();
          setTimeout(() => { if (statusText.value.startsWith('克隆中断')) statusText.value = ''; }, 6000);
          resolve();
        });
        es.onmessage = (m) => {
          stream.alive();
          let ev; try { ev = JSON.parse(m.data); } catch { return; }
          // 阶段一变就把"第几步 / 当前阶段"写进 task.progress —— 任务中心、任务视图、
          // 页面清单和「进行中」轨道都读它。此前 forge 这条路上**从来没赋值过**，
          // 于是 2-3 分钟里到处只显示一句"运行中"（六个阶段名其实一直在推）。
          if (ev.kind === 'forge-stage') {
            task.stages[ev.stage] = ev.status;
            task.progress = stageProgressText(forgeStageProgress(task.stages));
          }
          else if (ev.kind === 'forge-score') task.score = ev.score;
          else if (ev.kind === 'log') {
            // 只留尾部 60 行：日志窗显示的就是"现在在干什么"，不需要翻历史
            task.logs.push(ev.line);
            if (task.logs.length > 60) task.logs.splice(0, task.logs.length - 60);
          }
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
            stream.stop();
            bump();
            loadSites();
            setTimeout(loadPageStatus, 600);
            setTimeout(() => { if (statusText.value !== '光点出发') statusText.value = ''; }, 2500);
            resolve();
          }
        };
      } catch (e) {
        failFrom(e, { what: '克隆这一页' });
        task.failed = true; task.done = true; task.endedAt = Date.now();
        task.error = errMsg.value;
        setState('failed');
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
  const h = host.value;
  try {
    // 每次都主动作废：这个函数只在"刚导出完 / 打开报告页"时调，要的就是最新那份。
    // 详情面板读同一个缓存，于是它也不必为同一份结果再问一次引擎。
    liveHealthPrefetch.drop(h);
    const result = await liveHealthPrefetch.get(h, async () => {
      const r = await fetch(API + '/api/live-health/' + encodeURIComponent(h), { headers: apiHeaders() });
      return r.ok ? r.json() : null;
    });
    if (host.value === h) liveHealth.value = result;
  } catch { if (host.value === h) liveHealth.value = null; }
}
async function loadVerifySummary() {
  const h = host.value;
  try {
    const reports = await loadReports();
    if (host.value !== h) return;
    const report = reports.find(x => x.id === 'verify' && x.available);
    if (!report) { lastVerify.value = null; return; }
    const r = await fetch(report.url, { headers: apiHeaders() });
    if (!r.ok) { lastVerify.value = null; return; }
    const j = await r.json();
    if (host.value === h) lastVerify.value = { host: h, pages: j.pages?.length ?? 0, average: (j.measured > 0 && typeof j.average === 'number') ? (j.average * 100).toFixed(1) : null, worst: j.worst ?? null, mode: j.mode ?? 'sample', measured: j.measured ?? 0, targetTotal: j.targetTotal ?? j.pages?.length ?? 0, untested: j.untested ?? 0 };
  } catch { if (host.value === h) lastVerify.value = null; }
}
async function loadReports() {
  const h = host.value;
  if (!h) return [];
  try {
    const r = await fetch(API + '/api/reports/' + encodeURIComponent(h), { headers: apiHeaders() });
    const reports = r.ok ? ((await r.json()).reports ?? []).map(report => ({ ...report, url: staticUrl(report.url) })) : [];
    if (host.value === h) reportIndex.value = reports;
    return reports;
  } catch { if (host.value === h) reportIndex.value = []; return []; }
}

/** 引擎持久化任务历史（重启后仍可查） */
async function loadJobHistory() {
  try {
    const r = await fetch(API + '/api/jobs', { headers: apiHeaders() });
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
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '生成对标矩阵' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '对标矩阵');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'matrix-start') { task.progress = '0/' + ev.total; statusText.value = '对标矩阵 · 0/' + ev.total; }
        else if (ev.kind === 'matrix-site') { task.progress = ev.index + '/' + ev.total; task.doneCount = ev.index; task.totalCount = ev.total; statusText.value = '对标矩阵 · ' + ev.host + ' · ' + ev.index + '/' + ev.total; }
        else if (ev.kind === 'matrix-done') {
          task.done = true; task.endedAt = Date.now();
          const rel = String(ev.path || '').split(/[\\/]workspace[\\/]/).pop() || '';
          matrixReport.value = { url: staticUrl('/static/' + rel.split('\\').join('/')), sites: [host.value, matrixPeer.value] };
          statusText.value = '对标矩阵完成';
          stream.stop(); setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断';
          fail('引擎那边的进程没有正常结束。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          stream.stop();
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '生成对标矩阵' }); task.error = errMsg.value; }
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
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '资产缺口扫描' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '资产扫描');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'asset-gaps-start') { task.progress = '0/' + ev.total; statusText.value = '资产扫描 · 0/' + ev.total; }
        else if (ev.kind === 'asset-gaps-page') { task.progress = ev.index + '/' + ev.total; task.doneCount = ev.index; task.totalCount = ev.total; statusText.value = '资产扫描 · ' + ev.index + '/' + ev.total; }
        else if (ev.kind === 'assets-gaps-done') {
          task.assetGaps = ev.visualGaps; task.done = true; task.endedAt = Date.now();
          assetAuditReport.value = { host: host.value, visualGaps: ev.visualGaps, visualOrigin: ev.visualOrigin, visualThird: ev.visualThird, pages: ev.pages };
          statusText.value = ev.visualGaps ? ('资产扫描完成 · ' + ev.visualGaps + ' 个视觉缺口') : '资产扫描完成 · 无视觉缺口';
          stream.stop(); loadReports();
          setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断';
          fail('引擎那边的进程没有正常结束。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          stream.stop();
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '资产缺口扫描' }); task.error = errMsg.value; }
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
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '变更监控' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '变更监控');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'watch-page') statusText.value = '变更监控 · ' + ev.index + '/' + ev.total;
        else if (ev.kind === 'watch-done') {
          task.watchChanges = ev.changes; task.done = true; task.endedAt = Date.now();
          watchReport.value = { host: host.value, changes: ev.changes, bySeverity: ev.bySeverity };
          statusText.value = ev.changes ? '变更监控完成 · ' + ev.changes + ' 处变化' : '变更监控完成 · 无变化';
          stream.stop(); setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'watch-error') {
          task.failed = true; task.done = true; task.error = ev.error;
          fail('变更监控没有跑完。', '重跑一次；反复失败就展开详情看引擎的原始报错。', ev.error);
          stream.stop();
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断';
          fail('引擎那边的进程没有正常结束。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          stream.stop();
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '变更监控' }); task.error = errMsg.value; }
  })();
}

/** 多视口体检：引擎 verify 任务（--all 或单页；minViewport 告警口径） */
function verifyFailureMessage(ev, page, issues) {
  const expected = ev.targetTotal ?? ev.pages ?? (page ? 1 : 0);
  const untested = Number.isFinite(ev.untested) ? ev.untested : Math.max(0, expected - (ev.measured ?? 0));
  const first = (Array.isArray(ev.failedPages) ? ev.failedPages : []).find(p => p?.page) ?? issues[0];
  const reason = String(first?.error ?? first?.reason ?? '').slice(0, 120);
  const detail = first?.page ? `（${first.page}${reason ? `：${reason}` : ''}）` : '';
  if (untested > 0) return `体检未通过：${page ? '该页' : `${untested} 页`}未完整测量${detail}`;
  if (typeof ev.average === 'number') {
    const threshold = Number.isFinite(ev.threshold) && ev.threshold > 0 ? `${ev.threshold}%` : '设定阈值';
    return `体检未通过：${page ? '该页' : '平均'}还原度 ${(ev.average * 100).toFixed(1)}% 未达到 ${threshold}`;
  }
  return `体检未通过${detail || '：请查看逐页验证结果'}`;
}

function runVerify(page) {
  const h = host.value;
  const task = reactive({
    localId: 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'verify', label: page ? ('多视口体检 · ' + page) : ('全站体检 · ' + h), url: atlas.value?.origin ?? ('https://' + h),
    done: false, failed: false, error: null, verifyAverage: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = page ? ('体检 ' + page + ' · 截图中') : '全站体检 · 准备中';
  (async () => {
    try {
      const r = await fetch(API + '/api/verify', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: h, page: page || undefined }) });
      const { taskId, error } = await r.json();
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '全站体检' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const verifyIssues = [];
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      // 这段此前没有挂看门狗，却调用了 stream.stop()（当时叫 watch.stop()）—— 解析到的是 vue 的 watch，
      // 于是每次体检完成都抛一次未捕获异常（控制台 E2E 抓到过）。这里补上标准的挂载。
      const stream = attachStream(es, task, close, '全站体检');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'verify-page') {
          if (ev.error) verifyIssues.push({ page: ev.page, error: ev.error });
          statusText.value = verifyPageProgress(ev, { startedAt: task.startedAt });
        } else if (ev.kind === 'verify-done') {
          task.done = true; task.endedAt = Date.now(); task.verifyAverage = ev.average;
          task.failed = !ev.passed;
          if (task.failed) {
            task.error = verifyFailureMessage(ev, page, verifyIssues);
            // 失败项要给出可执行的下一步，而不只是一句"未通过"。
            // 卡点直方图来自 verify-summary（--resume 之后重跑只会补没测到的页）。
            const topBlocker = Object.entries(ev.blockers ?? {}).sort((a, b) => b[1] - a[1])[0];
            if ((ev.untested ?? 0) > 0) {
              task.hint = (topBlocker ? `最常见的卡点：${topBlocker[0]}（${topBlocker[1]} 个视口）。` : '')
                + '重跑会跳过已测过的页；如果卡点是长轮询/埋点，加 --allow-bounded 可让"版面已定、请求没完"的页按有界置信度计入。';
            } else if (typeof ev.average === 'number' && Number.isFinite(ev.threshold) && ev.threshold > 0) {
              task.hint = '先看最差的那页：点逐页清单按还原度排序，差异热图在对应页的体检目录里。';
            }
          }
          if (host.value === h) {
            if (!page) lastVerify.value = { host: h, pages: ev.pages,
              average: (ev.measured > 0 && typeof ev.average === 'number') ? (ev.average * 100).toFixed(1) : null,
              measured: ev.measured, targetTotal: ev.targetTotal, untested: ev.untested, mode: 'all' };
            loadVerifySummary();
            statusText.value = task.failed ? task.error
              : '体检完成 · ' + (ev.measured ?? 0) + '/' + (ev.targetTotal ?? ev.pages) + ' 页完整测量';
          }
          stream.stop(); scheduleScoreLoad(); loadReports();
          setTimeout(() => { statusText.value = ''; }, 5000);
        } else if (ev.kind === 'verify-error') {
          verifyIssues.push({ page: ev.page, error: ev.error });
          statusText.value = '体检告警 · ' + ev.page + ' ' + (ev.error || '');
        } else if (ev.kind === 'exit' && ev.status !== 'done' && !task.done) {
          task.failed = true; task.done = true; task.error = '任务中断';
          fail('引擎那边的进程没有正常结束。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          stream.stop();
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '全站体检' }); task.error = errMsg.value; }
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
      if (error) { task.failed = true; task.done = true; failFrom(error, { what: '响应式升级' }); task.error = errMsg.value; return; }
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '响应式升级');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'upgrade-page') statusText.value = '响应式升级 · ' + ev.page + ' · ' + (ev.error ? '失败' : ev.kept ? '保留' : '未采用');
        else if (ev.kind === 'exit') {
          task.done = true; task.endedAt = Date.now();
          if (ev.status === 'done') { statusText.value = '响应式升级完成'; loadVerifySummary(); scheduleScoreLoad(); }
          else { task.failed = true; task.error = '升级任务失败'; fail('响应式升级没有跑完。', '看「任务」里这条的日志确认卡在哪一步；没有变好的页会自动保留原样。'); }
          stream.stop(); setTimeout(() => { statusText.value = ''; }, 5000);
        }
      };
    } catch (e) { task.failed = true; task.done = true; failFrom(e, { what: '响应式升级' }); task.error = errMsg.value; }
  })();
}
function runVerifyAll() { runVerify(null); }
function runVerifyPage() { const n = selected.value; if (n) runVerify(pageNameOf(n)); }

/** 复制交付包路径：交给同事最常用的一步，就是把这一整行发过去 */
async function copyBundlePath() {
  const p = liveHealth.value?.bundlePath;
  if (!p) return;
  try { await navigator.clipboard.writeText(p); okMsg.value = '已复制交付包路径'; }
  catch { fail('浏览器不允许直接写剪贴板。', '手动选中那行路径再复制（Ctrl+C）即可。'); }
  setTimeout(() => { okMsg.value = ''; }, 4000);
}

/** 在资源管理器里定位交付包（引擎只接受 DATA_ROOT 以内的路径） */
function revealBundle() { return revealPath(liveHealth.value?.bundlePath, '交付包'); }

/**
 * 「进行中」轨道显示的那个任务：最近的、还在跑的。
 *
 * 只用一条轨道而不是每个任务一条：同时跑 3 个任务时，屏幕上该有一个明确的
 * "现在最该看的东西"，其余的去任务中心看（那里本来就列了全部）。
 */
const runningTask = computed(() => [...tasks].reverse().find(t => !t.done && !t.failed) ?? null);
/**
 * 报告页那几张卡片自己的进行态。
 * 此前点「运行审计」/「导出并验收」之后，按钮文字**一动不动** —— 只有底部状态条在变，
 * 而用户的视线在按钮上。"点了没反应"的观感就是这么来的。
 */
const activeOfKind = (kind) => [...tasks].reverse().find(t => t.kind === kind && !t.done && !t.failed) ?? null;
const auditTask = computed(() => activeOfKind('audit'));
const liveTask = computed(() => activeOfKind('live'));

/**
 * 参考耗时 `{ sec, scope }` —— 回答"还要等多久"。算法在 tasks.js（纯函数、有单测）：
 * 优先本站样本，不够才放宽到跨站；两档在界面上的文案不同（别让兜底冒充"同类"）。
 * 样本不足时返回 null，轨道不显示这一项。
 */
const forgeMedianSec = computed(() => medianForgeSec(jobHistory.value, hostOfTask(runningTask.value ?? {})));

/** 跳回正在跑的那一页时，详情面板没在展示同一个任务的阶段条（那是同一事实的详版） */
const railVisible = computed(() => {
  const t = runningTask.value;
  if (!t) return false;
  const n = selected.value;
  if (!dockOpen.value || !n) return true;
  return !(n.forgeState === 'running' && (n.id === t.nodeId || pageNameOf(n) === t.pageName));
});

/** 点轨道上的目标能不能跳过去：同站的页要有那颗星，别站的要本站点存在 */
const canFocusTask = computed(() => {
  const t = runningTask.value;
  if (!t) return false;
  const h = hostOfTask(t);
  if (h && h !== host.value) return sites.value.some(s => s.host === h);
  const nodes = atlas.value?.nodes ?? [];
  return nodes.some(n => n.id === t.nodeId) || nodes.some(n => pageNameOf(n) === t.pageName);
});

/** 跳到正在跑的那一页。跨站时先切站 —— 切完页面才在星图里，这里不替用户点星。 */
function focusTask() {
  const t = runningTask.value;
  if (!t) return;
  const h = hostOfTask(t);
  if (h && h !== host.value) { pickSiteByHost(h); return; }
  const nodes = atlas.value?.nodes ?? [];
  const node = nodes.find(n => n.id === t.nodeId) ?? nodes.find(n => pageNameOf(n) === t.pageName);
  if (node) { view.value = 'atlas'; onNodeClick(node); }
}

/**
 * 产物位置一览：站点工作区 / 静态镜像 / 交互镜像 / 交付包。
 *
 * 存在的意义是补上"导出成功了"和"我拿到了"之间那一步 —— 用户能在控制台里看到分数、
 * 打开镜像，却找不到磁盘上那个目录。每条都给**相对路径**（可读、可复制）与「打开文件夹」；
 * 不存在的产物按钮置灰并写明原因，而不是点了没反应。
 */
const artifactDirs = computed(() => {
  const h = host.value;
  const live = liveHealth.value;
  return [
    { what: '站点工作区', path: `workspace/${h}`, ok: true, note: '本站所有产物的根目录' },
    { what: '静态镜像', path: `workspace/${h}/pages`, ok: true, note: '每页一个目录，clone/ 里就是静态镜像本体' },
    { what: '交互镜像', path: `workspace/${h}/live`, ok: (curSiteMirrored.value ?? 0) > 0, note: '保留脚本的那一份；没导出过就没有这个目录' },
    { what: '交付包', path: live?.bundlePath ?? '', ok: !!live?.bundlePath, note: '可直接部署的那个目录（整个拷走即可）' },
  ];
});

/**
 * 交互镜像导出：引擎 live 任务（离线 + 严格验收 + mirror + heal + materialize）
 *
 * `hostArg` 是**任务中心那一行**点进来时传的站点 —— 它未必等于当前选中的站点
 * （比如刚克隆完 A 站，随后切到 B 站看东西，再回头点 A 站那行的按钮）。
 * 所以：对外一律按 h 走，只有"刷新界面上的读数"这一件事才认 isCurrent。
 * 同理 `rebuild` 那个勾选是报告页针对当前站点的，跨站触发时不带过去。
 */
function runLiveExport(hostArg) {
  const h = hostArg || host.value;
  if (!h) return;
  const isCurrent = h === host.value;
  const task = reactive({
    localId: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    kind: 'live', label: '交互镜像导出 · ' + h, url: 'https://' + h, taskId: null,
    done: false, failed: false, cancelled: false, stopping: false, error: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = '交互镜像导出中 · 约 2-5 分钟（HAR 合并 + 图片本地化 + 体检）';
  (async () => {
    try {
      const r = await fetch(API + '/api/live-export', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: h, root: 'mirror', rebuild: isCurrent && liveRebuild.value }) });
      const { taskId, error } = await r.json();
      if (error) {
        task.failed = true; task.done = true;
        failFrom(error, { what: '交互镜像导出' });
        task.error = errMsg.value; return;
      }
      task.taskId = taskId;
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, '交互镜像导出');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'live-stage') {
          const label = liveStageCn(ev.stage);
          if (ev.index != null) { task.progress = label + ' ' + ev.index + '/' + ev.total; task.doneCount = ev.index; task.totalCount = ev.total; }
          else if (ev.status === 'running') task.progress = label + '…';
          else if (ev.status === 'done') task.progress = label;
          statusText.value = '交互镜像导出 · ' + task.progress;
        }
        else if (ev.kind === 'exit') {
          task.done = true; task.endedAt = Date.now(); task.stopping = false;
          task.cancelled = ev.status === 'cancelled';
          if (ev.status === 'done') { statusText.value = '交互镜像导出完成 · 严格离线验收通过'; if (isCurrent) { loadLiveHealth(); loadReports(); } }
          else if (ev.status === 'cancelled') {
            statusText.value = '交互镜像导出已停止（旧包保留）';
            toast('交互镜像导出已停止 —— 候选包没通过验收时旧包会留着，线上镜像不受影响', 8000);
          } else {
            task.failed = true;
            task.error = '导出或严格离线验收失败';
            fail('交互镜像导出没通过验收，这一轮没有发布。', '旧包仍然保留、线上镜像不变；重跑一次，或到「任务」里展开详情看候选包 health.json 是哪个检查没过。', 'live-export exit status: failed');
          }
          stream.stop(); setTimeout(() => { statusText.value = ''; }, 5000);
        }
      };
    } catch (e) {
      task.failed = true; task.done = true; failFrom(e, { what: '交互镜像导出' }); task.error = errMsg.value;
    }
  })();
}

/** 全站 SEO 审计：复用引擎 audit 任务（SSE 进度 → 报告入口） */
function runAudit() {
  const origin = atlas.value?.origin ?? `https://${host.value}`;
  const task = reactive({
    localId: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    kind: 'audit', label: 'SEO 审计 · ' + host.value, url: origin, taskId: null,
    done: false, failed: false, cancelled: false, stopping: false, error: null, auditScore: null,
    startedAt: Date.now(), endedAt: null,
  });
  tasks.push(task);
  while (tasks.length > 20) tasks.shift();
  statusText.value = 'SEO 审计 · 准备中';
  (async () => {
    try {
      const r = await fetch(`${API}/api/audit`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ url: origin, maxPages: 30 }) });
      const { taskId, error } = await r.json();
      if (error) {
        task.failed = true; task.done = true;
        failFrom(error, { what: 'SEO 审计' });
        task.error = errMsg.value; return;
      }
      task.taskId = taskId;
      const es = new EventSource(sseUrl(taskId));
      taskSources.set(task.localId, es);
      const close = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
      const stream = attachStream(es, task, close, 'SEO 审计');
      es.onmessage = (m) => {
        stream.alive();
        let ev; try { ev = JSON.parse(m.data); } catch { return; }
        if (ev.kind === 'audit-start') statusText.value = `SEO 审计 · 0/${ev.targets}`;
        else if (ev.kind === 'audit-page') statusText.value = `SEO 审计 · ${ev.index}/${ev.total}`;
        else if (ev.kind === 'audit-done') {
          task.auditScore = ev.score; task.done = true; task.endedAt = Date.now(); task.stopping = false;
          loadHistory(host.value);                          // 审计刚落一条，走势图跟上
          loadAuditReport(host.value);                      // 报告卡切到最新一份（含真实用户指标）
          auditReport.value = { host: host.value, score: ev.score, pages: ev.pages, issues: ev.issues };
          statusText.value = `SEO 审计完成 · ${ev.score} 分`;
          stream.stop(); setTimeout(() => { statusText.value = ''; }, 4000);
        } else if (ev.kind === 'audit-error') {
          task.failed = true; task.done = true; task.error = ev.error; task.stopping = false;
          fail('SEO 审计没有跑完，这一轮没有出报告。', '重跑一次；同一站反复失败就展开详情，原始错误在下面。', ev.error);
          stream.stop();
        } else if (ev.kind === 'exit' && !task.done) {
          task.done = true; task.endedAt = Date.now(); task.stopping = false;
          if (ev.status === 'cancelled') {
            task.cancelled = true;
            statusText.value = 'SEO 审计已停止（已跑完的页会留在报告里）';
            toast('SEO 审计已停止', 6000);
          } else {
            task.failed = true; task.error = '审计进程没有正常结束';
            fail('SEO 审计没有跑完，这一轮没有出报告。', '重跑一次；反复失败就看「任务」里的日志与 engine.log。', `exit status: ${ev.status}`);
          }
          stream.stop();
        }
      };
    } catch (e) {
      task.failed = true; task.done = true;
      failFrom(e, { what: 'SEO 审计' });
      task.error = errMsg.value;
    }
  })();
}

/**
 * 详情面板里的「开始克隆此页 / 重新克隆此页」。
 *
 * ⚠️ 这个函数此前**根本不存在** —— 模板里绑了 `@open-forge="openForge"`，但没有任何定义，
 * 于是详情面板上那三个克隆按钮（概览页的 ⚡、克隆 tab 的开始/重新克隆）点了没反应，
 * 控制台只留一条 TypeError。这是"模板绑了个不存在的 handler"这类静默故障的典型：
 * 编译器不会报错，因为模板里的一切都只是运行时的属性查找。
 * 已加 `test/console-handlers.test.mjs` 守住这一类。
 */
function openForge() {
  const n = selected.value;
  if (!n) return;
  if (n.forgeState === 'running') { statusText.value = '这一页正在克隆中'; return; }
  startForge(n);
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
/**
 * 历史任务的一键续跑。只处理两类有明确 target 的任务：
 *   · clone（整站）—— url 是 origin，续跑即增量克隆（queue.json 跳过已完成页）
 *   · forge（单页）—— url 是页面 URL，直接重新克隆这一页
 * 引擎重启会把当时 running 的任务标成 interrupted；这一步就是为它准备的出口。
 */
function retryJob(h) {
  if (h.kind === 'clone') {
    let target = '';
    try { target = new URL(h.url).hostname.replace(/^www\./, ''); } catch { target = ''; }
    if (!target) { fail('这条历史记录里没有可用的站点地址。', '刷新任务列表后再看一次；仍为空说明这条记录确实缺字段，直接回站点重新发起即可。'); return; }
    pickSiteByHost(target);
    startCloneSite({ incremental: true });
    return;
  }
  if (h.kind === 'forge' && h.url) {
    startForge(null, { url: h.url });
    return;
  }
  fail('这类历史任务不支持一键续跑。', '回站点里重新发起一次；已经跑完的页面会被跳过，不必从头来。');
}

function startCloneSite({ incremental = false, allDiscovered = false } = {}) {  return new Promise((resolve) => {
    const h = host.value;
    const task = reactive({
      localId: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: 'clone', taskId: null, host: h,
      label: (allDiscovered ? '克隆全部已发现页面 · ' : incremental ? '增量克隆 · ' : '整站克隆 · ') + h,
      progress: '', done: false, failed: false, cancelled: false, stopping: false, killed: null, error: null,
      startedAt: Date.now(), endedAt: null,
    });
    tasks.push(task);
    while (tasks.length > 20) tasks.shift();
    activeTaskId.value = task.localId;
    statusText.value = task.label + ' · 准备中';
    (async () => {
      try {
        const payload = { host: h, incremental };
        if (allDiscovered) payload.allDiscovered = true;
        const r = await fetch(`${API}/api/clone-site`, { method: 'POST', headers: apiHeaders(), body: JSON.stringify(payload) });
        const body = await r.json();
        if (body.error) {
          task.failed = true; task.done = true; task.endedAt = Date.now();
          if (body.error === 'busy') fail('已经有一个整站克隆在跑了。', '等它跑完（底部「进行中」轨道会消失），再点一次。', 'HTTP 409 busy');
          else failFrom(body.error, { what: '整站克隆' });
          task.error = errMsg.value;
          statusText.value = '整站克隆没有开始';
          setTimeout(() => { statusText.value = ''; }, 4000);
          return resolve();
        }
        task.taskId = body.taskId;
        const es = new EventSource(sseUrl(body.taskId));
        taskSources.set(task.localId, es);
        const closeTask = () => { try { es.close(); } catch {} taskSources.delete(task.localId); };
        const stream = attachStream(es, task, closeTask, '整站克隆');
        es.onmessage = (m) => {
          stream.alive();
          let ev; try { ev = JSON.parse(m.data); } catch { return; }
          // 带分子分母的任务同时记一份**数值**进度：轨道按真实计数画条，
          // 不去解析给用户看的那句文案（那是拿显示串当数据用）。
          if (ev.kind === 'queue-start') { task.progress = `0/${ev.pending}`; task.doneCount = 0; task.totalCount = ev.pending; }
          else if (ev.kind === 'queue-progress' && ev.phase === 'check') { task.progress = `校验 ${ev.done}/${ev.total}`; task.doneCount = ev.done; task.totalCount = ev.total; }
          else if (ev.kind === 'queue-progress' && ev.phase === 'check-done') task.progress = `变了 ${ev.changed} · 未变 ${ev.same}`;
          else if (ev.kind === 'queue-page' && ev.status !== 'running') { task.progress = `${ev.done}/${ev.total}`; task.doneCount = ev.done; task.totalCount = ev.total; }
          else if (ev.kind === 'queue-complete') { task.progress = `${ev.done}/${ev.total}`; task.doneCount = ev.done; task.totalCount = ev.total; }
          else if (ev.kind === 'exit') {
            // 取消也是一次"结束"：done 必须为 true，否则这个任务永远留在「进行中」轨道上
            // —— 用户点了「停止」，界面反而多挂一条不动的进度条。
            task.done = ev.status === 'done' || ev.status === 'cancelled';
            task.cancelled = ev.status === 'cancelled';
            task.stopping = false;
            task.killed = ev.killed ?? null;
            task.failed = ev.status !== 'done' && ev.status !== 'cancelled';
            task.endedAt = Date.now();
            stream.stop();
            statusText.value = task.done ? `整站克隆完成${task.progress ? ' · ' + task.progress : ''}` : (ev.status === 'cancelled' ? '整站克隆已取消' : '整站克隆中断');
            if (ev.status === 'cancelled') toast(`整站克隆已停止${task.progress ? ' · 停在 ' + task.progress : ''}（已克隆的页面保留，下次可以「续跑」）`, 8000);
            loadPageStatus();                                  // 刷新页面清单上的铸造状态
            loadQueue(h);                                      // 断点续跑的"还剩 N 页"也随之更新
            loadSites();                                       // 也要刷新站点列表：SiteBar 的"克隆 N 页"取的是它，
                                                               // 此前不刷新，于是它和"克隆档案 · N 页"当场打架
            loadHistory(h);                                    // 走势多一个点
            setTimeout(() => { statusText.value = ''; }, 4000);
            resolve();
          }
        };
      } catch (e) {
        task.failed = true; task.done = true; task.error = String(e);
        failFrom(e, { what: '整站克隆' });
        task.error = errMsg.value;
        statusText.value = '整站克隆没有开始';
        setTimeout(() => { statusText.value = ''; }, 4000);
        resolve();
      }
    })();
  });
}

function onNodeClick(node) {
  if (!node?.url || node.siteHost !== host.value || pagesLoading.value) return;
  selected.value = node;                      // 点星 = 选中，打开详情剖析面板
  activeTaskId.value = null;                   // 关闭旧克隆视图（后台任务继续跑）
  detailIntel.value = null; detailScore.value = null;
  // 与产物目录名同一条规则（pages.js）—— 内联第二份会漏掉 60 字符截断，见 startForge 的注释
  const pageName = pageNameOf(node);
  if (node.forgeState === 'done') {
    wsJson(host.value, 'pages/' + pageName + '/intel/intel.json').then(j => { if (j && selected.value === node) detailIntel.value = j; });
    wsJson(host.value, 'pages/' + pageName + '/score.json').then(j => { if (j && selected.value === node) detailScore.value = j; });
  }
}

function onKeydown(e) {
  if (e.key !== 'Escape') return;
  if (selected.value) { selected.value = null; return; }
  if (view.value !== 'atlas') { view.value = 'atlas'; }
}
onMounted(async () => {
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('popstate', onPopState);
  applyTheme(theme.value);
  // 任务历史一开始就取一次：它此前只在切到「任务」视图时才拉，于是「进行中」轨道上的
  // "同类中位 0:38"在星图上永远是空的（实测：克隆 apify 页面时中位数不显示，
  // 而那站的历史里有 46 条样本）。顺手也让任务视图打开即是满的。
  try { await establishBrowserSession(); } catch (e) { failFrom(e, { what: '校验引擎 Token' }); }
  loadJobHistory();
  loadSites().then(() => {
    // 地址栏指定了站点就优先它（刷新 / 分享链接），否则载入第一个「有侦察结果」的站点
    const state = readUrlState();
    const wanted = state.site ? sites.value.find(s => s.host === state.site) : null;
    const first = wanted ?? sites.value.find(s => s.pages) ?? sites.value[0];
    if (first) {
      // 切站会改 host（触发 syncUrl），而这时还没走到 applyUrlState ——
      // 不先挂起的话，刷新带 ?page= 时地址栏会在恢复开始前就把 page 抹掉。
      urlSyncSuspended = true;
      const restore = () => { urlSyncSuspended = false; applyUrlState(state); };
      Promise.resolve(pickSite(first)).then(restore, restore);
    } else resetSiteContext('');
  });
  pollEngine();
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('popstate', onPopState);
  es?.close();
  for (const s of taskSources.values()) { try { s.close(); } catch {} }
  // 看门狗的宽限计时器也要清：不然卸载后它还会到点触发一次 onDrop，往已经空的界面上写错误
  for (const t of tasks) if (t._grace) { clearTimeout(t._grace); t._grace = null; }
  // 两个常驻定时器此前没人清理。今天不会观察到泄漏（Atlas 是根组件、不会卸载），
  // 但"根组件永远不卸载"不是一条能长期成立的假设，清掉是零成本的。
  clearInterval(edgeTick);
  clearInterval(pollTick);
});
</script>

<template>
  <Graph3D v-if="graphRequested" v-show="view === 'atlas'" :active="view === 'atlas'" :nodes="gNodes" :links="gLinks" :tick="gTick" :auto-rotate="autoRotate" :palette="graphPalette" @node-click="onNodeClick" />

  <div class="hud" v-if="view === 'atlas'">
    <div class="brand">HEIMDALL<span class="brand-sub">SITE ATLAS · 站点克隆工作台</span></div>
    <div class="brand-rule"></div>
    <div class="stats">
      <div class="stat"><b>{{ hudPages }}</b><i title="本次侦察抓取到的页面数。站点实际页面数通常更多 —— 侦察有页数上限（见站点配方的 maxPages）。">页面</i></div>
      <div class="stat"><b>{{ hudEdges }}</b><i :title="`这 ${hudPages} 个页面之间的站内链接数（不是页面数）。星图上当前已渲染 ${hudEdgesRendered} 条。`">站内链接</i></div>
      <div class="stat"><b>{{ hudOrigin }}</b><i title="被克隆的原始站点。镜像与原站的对比都以它为准。">原站</i></div>
    </div>
    <div class="status" v-if="statusText && !runningTask" :class="{ live }" role="status" aria-live="polite">{{ statusText }}</div>
  </div>

  <!-- 星图之外的视图也要能看到进度（同一个 statusText，见 .status-global 的注释）。
       任务在跑的时候两个状态条都让位给下面的「进行中」轨道 —— 同一个事实不该有两套呈现
       （那时 statusText 就是"克隆中 · xx"，比轨道少了阶段、时长和日志）。 -->
  <div class="status status-global" v-if="statusText && view !== 'atlas' && !runningTask" :class="{ live }" role="status" aria-live="polite">{{ statusText }}</div>

  <ActivityRail v-if="railVisible" :task="runningTask" :median="forgeMedianSec"
                :can-focus="canFocusTask" :can-stop="!!runningTask?.taskId" @focus="focusTask" @stop="cancelJob()" />

  <!-- 首启向导：一个站点都没有时，星图是空的，用户不知道该做什么。
       把"侦察 → 克隆 → 拿走"三步写在空态里，比让他对着空白星空猜要强。 -->
  <div class="first-run surface" v-if="!sites.length && sitesLoaded && view === 'atlas'">
    <div class="fr-title">还没有任何站点</div>
    <ol class="fr-steps">
      <li><b>侦察</b>：在上面输入框填一个域名并回车 —— 先看清全站有哪些页面（几十页通常 1–3 分钟）</li>
      <li><b>克隆</b>：侦察完成后在星图或「页面」清单里勾选页面克隆；只想先试一页就点「只克隆此页」</li>
      <li><b>拿走</b>：「报告」页导出可独立部署的交付包；「改站起点」列出换成你的域名 / 图片 / 文案各要动哪些文件</li>
    </ol>
    <p class="fr-note">需要登录的站点：先「本站操作 → 登录并保存会话」，之后的侦察 / 克隆 / 审计会自动带上这份登录态。</p>
    <!-- 空状态必须带一个**真的能点的下一步**：上面三步是说明，这里才是入口。
         输入框与星图顶部那个是同一个 targetInput —— 不用教用户去哪找。 -->
    <div class="fr-cta">
      <input v-model="targetInput" aria-label="要克隆的站点网址" placeholder="贴一个网址，例如 apify.com" spellcheck="false"
             @keyup.enter="startRecon" />
      <button class="wv-primary" @click="startRecon" :disabled="live" :aria-busy="live">{{ live ? '侦察中…' : '开始侦察' }}</button>
      <button @click="forgeSingle" :disabled="singleBusy" :aria-busy="singleBusy">{{ singleBusy ? '克隆中…' : '只克隆这一页' }}</button>
    </div>
  </div>

  <!-- 左下角一列：仪表面板 + 任务中心。
       两者原先各自 position:fixed 锚在同一个角（面板 left:28/bottom:64、任务中心 left:20/bottom:58），
       而任务中心更宽、z-index 更高 —— 展开时盖住面板的「显示」段，包括「星图自转」那个勾选框。
       现在共用一层列容器，由 .bottom-left 负责排布（见 ui.css 里那段说明）。 -->
  <div class="bottom-left" v-if="(view === 'atlas' && showPanel) || (tasks.length && view !== 'jobs')">
  <!-- 仪表面板 -->
  <div class="panel surface" v-if="view === 'atlas' && showPanel">
    <div class="panel-title">仪表面板<button class="panel-collapse" @click="showPanel = false" title="收起" aria-label="收起仪表面板">—</button></div>
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
      <div class="eng-detail" v-if="engine.ok" title="克隆槽 = 正在跑的整页克隆（一个槽一个浏览器）。0/2 表示空闲。">克隆槽 {{ engine.forge?.slots ?? 0 }}/{{ engine.forge?.max ?? 2 }}{{ (engine.forge?.slots ?? 0) === 0 ? '（空闲）' : '' }} · 侦察 {{ engine.recon ? '进行中' : '空闲' }}</div>
    </div>
  </div>
  <!-- 任务浮层：只在不专门看任务的时候出现。
       此前没有视图守卫，于是「任务」视图里同一份任务列表会显示两遍
       （浮层 + 视图各一份）—— 这正是"重复赘余"的典型。 -->
  <div class="task-center surface" v-if="tasks.length && view !== 'jobs'">
    <div class="tc-head">
      <span>任务中心</span>
      <span class="tc-meta">{{ tasks.filter(t => !t.done && !t.failed).length }} 运行中 / {{ tasks.length }}</span>
      <button class="tc-toggle" @click="tasksOpen = !tasksOpen" :aria-expanded="tasksOpen" aria-label="展开或收起任务中心">{{ tasksOpen ? '—' : '＋' }}</button>
    </div>
    <div class="tc-rows" v-show="tasksOpen">
      <!-- 能点开详情的行才有 role/tabindex —— 判据统一走 taskRowClickable，
           免得"看着可点、点了没反应"（见它的注释）。 -->
      <div class="tc-row" v-for="t in [...tasks].reverse()" :key="t.localId" :class="taskState(t)"
           :role="taskRowClickable(t) ? 'button' : undefined" :tabindex="taskRowClickable(t) ? 0 : undefined"
           @click="taskRowClickable(t) && (activeTaskId = t.localId)"
           @keydown.enter.prevent="taskRowClickable(t) && (activeTaskId = t.localId)"
           @keydown.space.prevent="taskRowClickable(t) && (activeTaskId = t.localId)"
           :title="t.error || t.url || (taskRowClickable(t) ? '点击查看这个任务的详情' : (t.kind === 'clone' ? '整站克隆的进度在上面一行' : '在星图里选中一个页面后，任务行才能点开详情'))">
        <span class="tc-name">{{ t.label ?? t.pageName }}</span>
        <span class="tc-state">{{ taskLabel(t) }}</span>
        <span class="tc-score" v-if="t.kind === 'audit' && t.auditScore != null">{{ t.auditScore }} 分</span>
        <span class="tc-score" v-else-if="t.score">{{ (t.score.pixel * 100).toFixed(1) }}%</span>
        <!-- 失败项给一句可执行的下一步。塞进 title 只能靠悬停发现，
             而"体检没通过"恰恰是用户最需要知道往哪走的时候。 -->
        <span class="tc-hint" v-if="t.failed && t.hint">{{ t.hint }}</span>
      </div>
    </div>
  </div>
  </div>
  <button class="panel-open" v-if="view === 'atlas' && !showPanel" @click="showPanel = true" aria-label="展开仪表面板" title="仪表面板"><Icon name="menu" decorative /></button>

  <div class="seek surface">
    <button class="theme-btn" @click="toggleTheme" :aria-label="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'" :title="theme === 'dark' ? '切换浅色' : '切换深色'"><Icon :name="theme === 'dark' ? 'moon' : 'sun'" decorative /></button>
    <input v-model="targetInput" aria-label="目标站点域名" placeholder="输入目标域名或页面地址 · apify.com 或 apify.com/store" spellcheck="false" @keyup.enter="startRecon"
      title="要分析的站点域名（可带 https://）。带路径时：侦察只认域名，克隆按整条地址走。回车或点「侦察」开始" />
    <!-- 进行中的按钮要有进行态文案：只有一个 spinner（或干脆没变化）时，
         用户不知道按钮是没点中、还是在跑。 -->
    <button @click="startRecon" :disabled="live"
      :aria-busy="live"
      title="全站侦察：从 sitemap 与站内链接找出页面，逐页抓标题/类型/缩略图，产出星图与全站视图。页数上限由站点配方的 maxPages 决定，几十页通常 1-3 分钟">{{ live ? '侦察中…' : '侦察' }}</button>
    <button class="seek-alt" @click="forgeSingle" :disabled="singleBusy" :aria-busy="singleBusy"
      title="不侦察整站，只克隆输入框里这一个页面（带路径就按路径克隆，如 apify.com/store）：捕获 → 校准 → 评分，约 2-3 分钟。克隆产物照样能导出成可部署的离线包">{{ singleBusy ? '克隆中…' : '只克隆此页' }}</button>
  </div>

  <!-- 站点切换 + 本站操作（星图与工作视图现在共用 SiteBar；原先星图这里是把每个站点
       一个按钮加一个 ×、再并上四个功能按钮平铺，站点到八个就折成三行） -->
  <SiteBar v-if="view === 'atlas'" class="sites" :sites="sites" :host="host" :actions="siteActions" :busy="!!engine.audit || !!engine.clone" @pick="pickSiteByHost" @action="onSiteAction" />

    <!-- 工作台视图：页面 / 任务 / 报告 / 设置 -->
  <PagesView
    v-if="view === 'pages'"
    :key="'pages-' + host"
    :host="host" :sites="sites" :theme="theme"
    :nodes="tableNodes" :scores="pageScores" :verify="pageVerify" :meta="pageMeta" :loading="pagesLoading"
    :actions="workViewActions"
    @pick="pickSiteByHost" @action="onSiteAction" @close="view = 'atlas'"
    @detail="onNodeClick" @forge="startForge" @delete="deletePage"
    @forge-checked="forgeChecked" @remove-checked="removeChecked"
  />
  <JobsView
    v-if="view === 'jobs'"
    :tasks="tasks" :jobs="jobHistory" :sites="sites" :host="host" :engine="engine"
    :actions="workViewActions"
    @pick="pickSiteByHost" @action="onSiteAction" @close="view = 'atlas'" @retry="retryJob" @export-live="runLiveExport"
    @stop="cancelJob"
  />

  <AcceptanceWorkbench v-if="view === 'acceptance'" @close="view = 'atlas'" />

  <section class="work-view surface" v-if="view === 'reports'">
    <div class="wv-head">
      <b>报告中心 · {{ host || '未选择站点' }}</b>
      <span class="wv-stat">克隆档案 / SEO / 体检 / 交互镜像 / 对标 / 情报</span>
      <SiteBar :sites="sites" :host="host" :actions="workViewActions" @pick="pickSiteByHost" @action="onSiteAction" />
      <button class="wv-close" @click="view = 'atlas'" title="返回星图（Esc）"><Icon name="close" decorative /> 返回星图</button>
    </div>
    <nav class="report-shortcuts" aria-label="常用报告入口" v-if="['archive', 'compare', 'seo', 'verify', 'intel'].some(hasReport)">
      <a v-if="hasReport('archive')" :href="reportUrl('archive')" target="_blank" rel="noopener">克隆档案</a>
      <a v-if="hasReport('compare')" :href="reportUrl('compare')" target="_blank" rel="noopener">同步对比</a>
      <a v-if="hasReport('seo')" :href="reportUrl('seo')" target="_blank" rel="noopener">SEO 报告</a>
      <a v-if="hasReport('verify')" :href="reportUrl('verify')" target="_blank" rel="noopener">体检 JSON</a>
      <a v-if="hasReport('intel')" :href="reportUrl('intel')" :target="staticBridgeNeeded() ? '_blank' : undefined" :download="staticBridgeNeeded() ? null : ''">情报 Excel</a>
    </nav>
    <div class="reports-scroll">
    <AcceptanceSummary :host="host" />
    <div class="report-card surface">
      <h3>克隆档案</h3>
      <p v-if="pagesLoading" role="status" aria-live="polite">逐页状态统计中…</p>
      <p v-else>{{ doneCount }} 页已克隆 · 平均视觉 {{ avgVisual }}</p>
      <a v-if="hasReport('archive')" :href="reportUrl('archive')" target="_blank" rel="noopener">打开档案</a>
      <p v-else class="trend-hint">还没有档案可开 —— 克隆任意一页之后这里就会出现</p>
    </div>
    <div class="report-card surface">
      <h3>改站起点</h3>
      <p v-if="editManifest">
        共 {{ editManifest.counts.pages }} 页 · {{ editManifest.counts.assets }} 个资源 ·
        <span :class="{ 'edit-warn': editManifest.counts.remoteVisual > 0 }">{{ editManifest.counts.remoteVisual }} 个仍是外链的视觉资产</span> ·
        域名出现在 {{ editManifest.counts.domainFiles }} 个文件里（{{ editManifest.counts.domainTotal }} 处）
      </p>
      <p v-else class="trend-hint">
        还没生成 —— 生成后会列出「换成你的域名 / 图片 / 文案」各要动哪些地方（只有已克隆的页会进清单）
      </p>
      <div class="edit-row">
        <button @click="runEditManifest()" :disabled="!host || !!engine.editManifest">生成 / 刷新清单</button>
        <a v-if="editManifest" :href="wsOpenUrl(host, 'deliver/edit-manifest.md')" target="_blank" rel="noopener">打开清单（Markdown）</a>
      </div>
      <!-- 最该先换的那几个（按被引页数排序）：换 logo 时从这里直接定位到文件，
           不用自己去 clone/assets/** 里翻 -->
      <ul class="edit-list" v-if="editManifest && editManifest.assets && editManifest.assets.length">
        <li v-for="a in editManifest.assets.slice(0, 6)" :key="a.url">
          <span class="edit-kind">{{ a.kind }}</span>
          <code :title="a.url">{{ a.local || '（仍是外链）' }}</code>
          <span class="edit-meta">{{ a.pageCount }} 页 · {{ a.size ? fmtBytes(a.size) : '—' }}</span>
          <button v-if="a.local" @click="revealManifestAsset(a)" title="在资源管理器里定位这个文件">定位</button>
        </li>
      </ul>
      <div class="edit-row domain-row">
        <label :for="'domain-to-' + host">把 <code>{{ originHostOf() }}</code> 换成</label>
        <input :id="'domain-to-' + host" v-model="newDomain" placeholder="mysite.com" autocomplete="off" />
        <button @click="runReplaceDomain(false)" :disabled="!host || !newDomain.trim()">预览</button>
        <button
          v-if="domainResult && domainResult.mode === 'preview' && domainResult.occurrences > 0"
          class="danger" @click="runReplaceDomain(true)">
          确认替换 {{ domainResult.occurrences }} 处
        </button>
      </div>
      <p class="trend-hint" v-if="domainResult">
        <template v-if="domainResult.mode === 'apply'">
          已替换 {{ domainResult.changed }} 个文件；原文件备份在 <code>workspace/{{ host }}/{{ domainResult.backup }}</code>（按相同路径复制回去即可还原）。
          <b>建议接着跑一次「多视口体检」</b>确认没有改坏。
        </template>
        <template v-else-if="domainResult.occurrences">
          命中 {{ domainResult.files }} 个文件 / {{ domainResult.occurrences }} 处，含主机名
          {{ domainResult.subdomains.slice(0, 4).map(s => s.name).join('、') }}<template v-if="domainResult.subdomains.length > 4"> 等 {{ domainResult.subdomains.length }} 个</template>。
          <b>预览不会改任何文件</b>，确认无误再点「确认替换」（替换前会逐文件备份）
        </template>
        <template v-else>没找到原站域名 —— 这个站点可能本来就没写死域名</template>
      </p>
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
      <a v-if="auditReport" :href="wsOpenUrl(auditReport.host, 'seo/seo.html')" target="_blank" rel="noopener">打开报告</a>
      <div class="run-row" v-if="auditTask || !auditReport">
        <button class="wv-primary" :disabled="!!auditTask" :aria-busy="!!auditTask" @click="runAudit">
          {{ auditTask ? ('正在审计…' + (auditTask.progress ? ' ' + auditTask.progress : '')) : (auditReport ? '重新审计' : '运行审计') }}
        </button>
        <button v-if="auditTask" :disabled="!!auditTask.stopping" @click="cancelJob(auditTask)"
                :title="'停下这次审计；已经跑完的页会留在报告里'">{{ auditTask.stopping ? '停止中…' : '停止' }}</button>
      </div>
    </div>
    <div class="report-card surface">
      <h3>变更监控</h3>
      <p v-if="watchReport">{{ watchReport.changes }} 处变化（高 {{ watchReport.bySeverity?.high ?? 0 }}）</p>
      <p v-else>对比基线快照，发现标题/描述/canonical/正文变化</p>
      <a v-if="watchReport" :href="wsOpenUrl(host, 'watch/watch.html')" target="_blank" rel="noopener">打开变更报告</a>
      <button v-else class="wv-primary" @click="runWatch">运行监控</button>
    </div>
    <div class="report-card surface">
      <h3>同步滚动对比</h3>
      <p>原站快照 vs 镜像，逐屏目检</p>
      <a v-if="hasReport('compare')" :href="reportUrl('compare')" target="_blank" rel="noopener">打开对比</a>
      <p v-else class="trend-hint">克隆任意一页后自动生成</p>
    </div>
    <div class="report-card surface">
      <h3>竞品情报包</h3>
      <p>概览 / 语义情报 / 定价与 CTA</p>
      <a v-if="hasReport('intel')" :href="reportUrl('intel')" :target="staticBridgeNeeded() ? '_blank' : undefined" :download="staticBridgeNeeded() ? null : ''">下载 Excel</a>
      <p v-else class="trend-hint">情报在克隆阶段入库 —— 克隆一页后即可下载</p>
    </div>

    <div class="report-card surface">
      <h3>跨站对标矩阵</h3>
      <p v-if="matrixReport">与 {{ matrixReport.sites[1] }} 的 SEO 对标已生成</p>
      <p v-else>选择另一站点，生成站点分/覆盖率/LCP/页面类型对比</p>
      <div v-if="matrixReport"><a :href="artifactOpenUrl(matrixReport.url)" target="_blank" rel="noopener">打开矩阵报告</a></div>
      <div v-else class="matrix-run">
        <select v-model="matrixPeer" aria-label="选择要对标的站点"><option value="">选择对标站点</option><option v-for="s in sites.filter(x => x.host !== host)" :key="s.host" :value="s.host">{{ s.host }}</option></select>
        <button class="wv-primary" :disabled="!matrixPeer" @click="runMatrix">生成对标</button>
      </div>
    </div>
    <div class="report-card surface">
      <h3>资产缺口</h3>
      <p v-if="assetAuditReport">{{ assetAuditReport.visualGaps }} 个视觉缺口（原站 {{ assetAuditReport.visualOrigin }} / 第三方 {{ assetAuditReport.visualThird }}）</p>
      <p v-else>扫描图片/图标/SVG/CSS 引用，区分视觉缺口与元数据噪声</p>
      <a v-if="assetAuditReport" :href="wsOpenUrl(host, 'audit/asset-gaps.html')" target="_blank" rel="noopener">打开缺口报告</a>
      <button v-else class="wv-primary" @click="runAssetsAudit">运行扫描</button>
    </div>
    <div class="report-card surface">
      <h3>全站体检</h3>
      <p v-if="lastVerify">{{ lastVerify.mode === 'all' ? '全站' : '抽样' }} {{ lastVerify.measured }}/{{ lastVerify.targetTotal }} 页完整测量 · 已测平均 {{ lastVerify.average == null ? '未测到' : lastVerify.average + '%' }}<template v-if="lastVerify.worst"><br /><span class="score-note">最差 {{ lastVerify.worst.page }} · {{ lastVerify.worst.name }} {{ (lastVerify.worst.score * 100).toFixed(1) }}%</span></template></p>
      <p v-else>多视口（375/768/1440）逐页像素 diff，输出最差视口</p>
      <div class="report-list" v-if="lastVerify"><a :href="wsOpenUrl(host, 'verify/verify-summary.json')" target="_blank" rel="noopener">体检 JSON</a></div>
      <button class="wv-primary" @click="runVerifyAll">{{ lastVerify ? '重新体检' : '运行全站体检' }}</button>
      <button @click="runResponsiveUpgrade" title="对 minViewport<0.97 的页面做多视口快照，verify 提升才保留">响应式升级</button>
    </div>
    <div class="report-card surface">
      <h3>交互镜像</h3>
      <!-- 导出与体检此前是两张卡片，但它们说的是同一件产物（离线包 + 它的健康报告）——
           放在一起才知道"导出什么、导出来怎么样"。 -->
      <template v-if="liveHealth">
        <p>最近导出：<b>{{ liveHealth.bundle }}</b></p>
        <p class="score-note" :style="{ color: liveStrictPassed ? 'var(--ok)' : 'var(--warn)' }">{{ liveStrictPassed ? '静态资源与已发现路径通过离线检查；动态交互待浏览器验收' : (liveHealth.strict ? '静态资源或已发现路径未通过离线检查' : '历史包未做严格离线检查，动态交互仍待浏览器验收') }}</p>
        <p>离线资源 {{ liveHealth.assets?.local ?? 0 }} 本地 / {{ liveHealth.assets?.har ?? 0 }} HAR 回放 · <b :style="{ color: (liveHealth.assets?.unresolved ?? 0) ? 'var(--warn)' : 'var(--ok)' }">缺口 {{ liveHealth.assets?.unresolved ?? 0 }}</b></p>
        <p class="score-note">页面 {{ liveHealth.pages ?? 0 }}<template v-if="liveHealth.liveMissing">（少 {{ liveHealth.liveMissing }} 页）</template> · 未镜像链接 {{ liveHealth.links?.missing ?? 0 }}</p>
        <!-- 与上一次导出的差异：增量是"读出来的"，不是靠人回忆上次导了什么 -->
        <p class="score-note" v-if="liveHealth.changes">
          与上次导出相比：新增 <b>{{ liveHealth.changes.counts.added }}</b> · 变化 <b>{{ liveHealth.changes.counts.changed }}</b> · 删除 <b>{{ liveHealth.changes.counts.removed }}</b> · 不变 {{ liveHealth.changes.counts.same }}
          <template v-if="liveHealth.changes.prev">（对比 {{ (liveHealth.changes.prev.at ?? '').slice(0, 16).replace('T', ' ') }} 那一版）</template>
          <template v-else>（首次导出）</template>
        </p>
        <!-- 站外引用分两个口径显示。此前只显示 externalAssets，于是
             YouTube 嵌入这类"没有资源扩展名的外链"在界面上完全看不到 ——
             实测 apify 站外引用 1826 条，其中静态资源 1419 条，差额 407 条被隐藏。 -->
        <p class="score-note">
          站外静态资源 <b :title="'图片/CSS/脚本等带扩展名的站外资源。离线时一定会裂，需要本地化。'">{{ liveHealth.assets?.externalAssets ?? 0 }}</b>
          · 站外引用共 <b :title="'含 YouTube 嵌入、地图、统计脚本等无扩展名的外链。在线可用，离线为空 —— 这类无法本地化，属固有边界。'">{{ liveHealth.assets?.external ?? 0 }}</b>
          · 动态图 {{ liveHealth.assets?.dynamic ?? 0 }}
        </p>
      </template>
      <p v-else>导出交互镜像包时会验收本地快照、HAR 回放和离线资源；有缺口则保留旧包，并在任务日志中给出候选包体检结果。
        <template v-if="curSiteMirrored === 0"><br />
          <b style="color:var(--warn)">本站还没有本地镜像</b> —— 在导出之前，
          <code>{{ host }}.localhost</code> 打开的是<b>原站本身</b>（镜像路由：本地无快照就反代回原站）。
          点下面的按钮导出一次，它才会变成真镜像。</template>
      </p>
      <!-- 交付：这个目录就是要交给同事的东西。路径、复制、打开文件夹三个动作都在这里，
           因为"导出成功了"和"我拿到了"之间还差一步 —— 找到它在哪。 -->
      <div class="bundle" v-if="liveHealth?.bundlePath">
        <code class="bundle-path" :title="liveHealth.bundlePath">{{ liveHealth.bundlePath }}</code>
        <div class="bundle-btns">
          <button @click="copyBundlePath" :title="'复制这一整行路径'">复制路径</button>
          <button @click="revealBundle" title="在资源管理器里定位这个目录">打开文件夹</button>
        </div>
        <p class="score-note" v-if="liveStrictPassed">交给同事：整个目录拷走即可，对方跑 <code>node serve.mjs --port 8080</code>（零依赖）或 <code>docker compose up -d</code>。纯前端站已按 <code>--root mirror</code> 导出。</p>
        <p class="score-note" v-else>这是历史已发布目录；重新导出并通过严格离线验收后，才能按完整离线包交付。</p>
      </div>
      <label class="sw" style="margin-bottom:8px;display:flex"><input type="checkbox" v-model="liveRebuild" /><span>先重建 live 页面（站点改版后勾选）</span></label>
      <!-- 必须写成 runLiveExport()：直接写函数名时 Vue 会把 MouseEvent 当第一个参数传进来，
           而第一个参数现在是 host —— 于是导出目标会变成 "[object MouseEvent]" -->
      <div class="run-row">
        <button class="wv-primary" :disabled="!!liveTask" :aria-busy="!!liveTask" @click="runLiveExport()">
          {{ liveTask ? ('正在导出…' + (liveTask.progress ? ' ' + liveTask.progress : '')) : (liveHealth ? '重新导出并验收' : '导出并验收离线包') }}
        </button>
        <button v-if="liveTask" :disabled="!!liveTask.stopping" @click="cancelJob(liveTask)"
                :title="'停下这次导出；旧包会保留，线上镜像不受影响'">{{ liveTask.stopping ? '停止中…' : '停止' }}</button>
      </div>
    </div>
    <!-- 产物到底落在磁盘的哪里 —— 控制台里能看到分数、能打开镜像，但"那个目录在哪"
         此前只能靠人翻。不存在的产物按钮置灰并写明原因，不做"点了没反应"。 -->
    <div class="report-card report-wide surface">
      <h3>产物位置</h3>
      <div class="artifact-list">
        <div class="artifact-row" v-for="a in artifactDirs" :key="a.what">
          <div class="artifact-name">
            <b>{{ a.what }}</b>
            <span class="score-note">{{ a.note }}</span>
          </div>
          <button :disabled="!a.ok || !a.path" @click="revealPath(a.path, a.what)"
                  :title="a.ok && a.path ? '在资源管理器里定位这个目录' : '还没有这个产物 —— 先跑一次再定位'">打开文件夹</button>
          <code class="artifact-path" :title="a.path || '还没有这个产物'">{{ a.path || '——' }}</code>
        </div>
      </div>
      <p class="score-note">路径相对数据目录（默认 <code>core/</code>，可用 <code>HEIMDALL_DATA_DIR</code> 改）。点击路径可整行选中复制。</p>
    </div>
    <div class="report-card report-wide surface">
      <h3>设计资产</h3>
      <!-- 只列**没有专属卡片**的报告。此前这块叫"更多报告"，
           把上面已有卡片的 7 项又列了一遍 —— 同一个链接在同一页出现两次。
           真正只在这里出现的只有设计令牌与组件画廊。 -->
      <div class="report-list" v-if="designReports.length">
        <a v-for="r in designReports" :key="r.id" :href="artifactOpenUrl(r.url)" target="_blank" rel="noopener">{{ r.name }}</a>
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
        <div class="set-row"><span>最近删除</span><button @click="trashOpen = true">查看并恢复</button></div>
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
    :mirrored="curSiteMirrored"
    :page-meta="pageMeta" :detail-intel="detailIntel" :detail-score="detailScore"
    @close="selected = null" @open-forge="openForge" @forge-all="forgeAll" @verify="runVerifyPage"
    @reveal="(p, what) => revealPath(p, what)"
  />

  <a class="audit-link" v-if="auditReport" :href="wsOpenUrl(auditReport.host, 'seo/seo.html')" target="_blank" rel="noopener">SEO 报告 · {{ auditReport.score }} 分</a>
  <!-- 这个链接指向**克隆档案**（静态镜像的索引页），所以数字必须是"已克隆页数"。
       此前显示的是 hudPages（侦察抓到的页面数）—— 于是刚克隆完一页，这个数字纹丝不动，
       看起来像"没算进去"。两个数属于不同的集合，从一个跳到另一个会骗人。 -->
  <a class="archive-link" v-if="doneCount && !dockOpen" :href="wsOpenUrl(host, 'index.html')" target="_blank" rel="noopener"
     :title="`克隆档案：本站 ${doneCount} 个已克隆页面的索引${hudPages > doneCount ? `（侦察共发现 ${hudPages} 页）` : ''}`">克隆档案 · {{ doneCount }} 页</a>
  <div class="keys" v-if="view === 'atlas' && !forge">
    <span>拖拽 = 旋转</span><span>滚轮 = 缩放</span><span>Ctrl+拖拽 = 平移</span><span class="k-amber">点击星球 = 打开页面详情</span>
  </div>
  <!-- 错误提示：一句人话 + 下一步 + 可展开的技术详情。
       此前这里只有一行 `{{ errMsg }}`，而多数调用方传的是 String(e) —— 屏幕上
       直接摆 `TypeError: Failed to fetch`。技术信息照给，但收进 details：
       想看的人在，不想看的人不必先绕过它才看得见"该怎么办"。 -->
  <div class="toast" v-if="errMsg" role="alert" aria-live="assertive">
    <div class="toast-main">
      <span class="toast-msg">{{ errMsg }}</span>
      <button class="toast-x" type="button" @click="clearErr()" aria-label="关闭这条提示">×</button>
    </div>
    <p class="toast-hint" v-if="errHint">{{ errHint }}</p>
    <details class="toast-detail" v-if="errDetail">
      <summary>技术详情</summary>
      <pre>{{ errDetail }}</pre>
    </details>
  </div>
  <div class="toast ok" v-if="okMsg" role="status" aria-live="polite">{{ okMsg }}</div>
  <TrashDialog v-if="trashOpen" @close="trashOpen = false" @restored="onTrashRestored" />
  <div class="view-nav surface" style="max-width: calc(100vw - 16px); overflow-x: auto">
    <button v-for="v in VIEWS" :key="v.id" :class="{ on: view === v.id }" :aria-current="view === v.id ? 'page' : undefined" :title="v.hint" @click="selectView(v.id)">
      <b aria-hidden="true"><Icon v-if="v.iconName" :name="v.iconName" decorative /><template v-else>{{ v.icon }}</template></b><span>{{ v.label }}</span>
    </button>
  </div>
</template>
