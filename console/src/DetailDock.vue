<script setup>
/**
 * DetailDock — 单页详情面板（概览 / SEO 剖析 / 质检 / 克隆 四个标签页）
 *
 * 质检那一页的数据加载（loadQuality）**属于本组件**，不下发到父组件：
 * 它要读按页产物文件，且只在切到该标签页时才有意义。
 * 放父组件的话，每次打开详情都会白拉一遍 —— 而其中 asset-gaps.json 有 300KB。
 * （asset-gaps.json 按站点缓存：逐页切换时不重复下载，换站点才失效。）
 *
 * 面板打开时父组件会隐藏右下角的「克隆档案」链接 —— 本面板是全高右侧浮层，
 * 会把它整块盖住（实测 154×32），留着就等于点不到。
 */
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders, wsJson, wsUrl, wsOpenUrl, tokenOf, staticBridgeNeeded } from './api.js';
import AuthImage from './AuthImage.vue';
import { typeColor, typeCn } from './types.js';
import { fmtBytes, fmtDate, FORGE_STAGES } from './format.js';
import { pageNameOf, pagePathOf, liveUrl, localEngineSupportsMirror, mirrorBridgeNeeded, openMirrorWithTicket } from './pages.js';
import { assetGapsPrefetch, liveHealthPrefetch } from './prefetch-cache.js';

const props = defineProps({
  host: { type: String, default: '' },
  selected: { type: Object, default: null },
  forge: { type: Object, default: null },
  pageMeta: { type: Object, default: () => ({}) },
  detailIntel: { type: Object, default: null },
  detailScore: { type: Object, default: null },
  theme: { type: String, default: 'dark' },
  /** 交互镜像已导出的页数（/api/sites 的 mirrored）。0 = 没导出过 —— 此时那个入口
   *  打开的是原站本身（镜像路由"本地无快照就反代回原站"），界面必须说出来。null = 还不知道。 */
  mirrored: { type: Number, default: null },
});
defineEmits(['close', 'open-forge', 'forge-all', 'verify', 'reveal']);

/** 交互镜像入口的悬停说明：没导出过时说清"点下去看到的是什么" */
const liveTitle = computed(() => props.mirrored === 0
  ? '本站尚未导出交互镜像 —— 打开等于直接访问原站（经本地代理），不是复刻结果。先导出一次再来看'
  : tokenOf() && !localEngineSupportsMirror()
    ? '独立子域镜像只支持本机引擎地址'
  : tokenOf()
    ? '交互镜像：通过一次性授权进入独立子域，站点路由、登录态和本地存储按原站隔离'
    : '交互镜像：保留脚本、资源实时回原站。用 <域名>.localhost 作独立域名，站点的路由/登录态/本地存储都与原站一致');
const liveOpenError = ref('');
async function openMirror(f) {
  liveOpenError.value = '';
  try { await openMirrorWithTicket(f); }
  catch (error) {
    const raw = String(error?.message ?? error);
    // 技术串保留，但先说人话：这个按钮失败几乎都是"本站还没导出过镜像"或"票据过期"
    liveOpenError.value = /ticket|授权|unauthor|401/i.test(raw)
      ? '打开交互镜像失败：授权票据过期了 —— 刷新页面再点一次。'
      : '打开交互镜像失败：' + raw + ' —— 本站还没导出过镜像时先到「报告 → 交互镜像」导出一次。';
  }
}

/** 阶段条：词表在 format.js —— 任务中心与「进行中」轨道用的是同一份，别在这里再写一遍 */
const STAGES = FORGE_STAGES;

/**
 * 动效驱动画像（捕获阶段采，见 core/src/crawler/motion.mjs）。
 * 只列非零项：一张全是 0 的表比一句话"未检出动效"更难读。
 */
/** fixup 提前返回的原因（core/src/differ/fixup.mjs 的 writeSkip 写进 fixup-history.json 的 skipped） */
const FIXUP_SKIP_CN = {
  'llm-disabled': '模型服务未启用（core/.env 的 HEIMDALL_LLM）',
  'no-artifacts': '缺少克隆产物，没有可比对的两张截图',
  noise: '剩余差异主要是动画/时序噪声，改 CSS 救不了',
};
const skipReasonCn = (k) => FIXUP_SKIP_CN[k] ?? String(k ?? '');

const motion = computed(() => props.pageMeta[props.selected?.id]?.motion ?? null);
const motionRows = computed(() => Object.values(motion.value?.drivers ?? {}).filter(d => d.count > 0));

/**
 * 本面板是一个模态式浮层（盖住右侧 32%），所以它必须像对话框一样对待焦点：
 * 打开时把焦点移进来（否则键盘用户还在身后的星图上）、Tab 在面板内循环、
 * 关闭时把焦点还给打开它的元素（否则焦点落回 body，读屏用户丢失位置）。
 * 父组件已负责 Esc 关闭；这里只管焦点。
 */
const dockEl = ref(null);
let lastFocus = null;
onMounted(() => {
  lastFocus = document.activeElement;
  nextTick(() => dockEl.value?.querySelector('.dock-close')?.focus());
});
onBeforeUnmount(() => { if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus(); });
function onDockKeydown(e) {
  if (e.key !== 'Tab') return;
  const items = dockEl.value?.querySelectorAll('button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (!items || !items.length) return;
  const first = items[0], last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/**
 * fixup-history.json —— 克隆 tab 的「AI 校准」块要读它。
 *
 * 它**此前只在 loadQuality() 里取**，而 loadQuality 只有切到「质检」标签才会跑；
 * 那个块的条件又写着 `!forge`（任务是结束时看的）。于是最常见的那条路径
 * ——打开详情 → 克隆 tab——永远看不到它，而注释里写的正是"任务结束后这里要能回答
 * AI 校准做了什么"。曲线于是成了"只在任务进行中的面板里闪过一次"的东西。
 * 这个文件很小，进面板顺手取一次即可；换页要重置，否则会显示上一页的曲线。
 */
const dockFixup = ref(null);
watch(() => props.selected, async (n) => {
  dockFixup.value = null;
  if (!n) return;
  const j = await wsJson(props.host, 'pages/' + pageNameOf(n) + '/fixup-history.json');
  if (props.selected === n) dockFixup.value = j;
}, { immediate: true });

/** 运行计时：只在真的跑着的时候每秒 tick —— 空闲的会话不该养一个空转的定时器 */
const nowTick = ref(Date.now());
let tickTimer = null;
onMounted(() => {
  tickTimer = setInterval(() => { if (props.forge && !props.forge.done) nowTick.value = Date.now(); }, 1000);
});
onBeforeUnmount(() => { if (tickTimer) clearInterval(tickTimer); });

const elapsedText = computed(() => {
  const f = props.forge;
  if (!f) return '0 秒';
  const s = Math.max(0, Math.round(((f.endedAt ?? nowTick.value) - f.startedAt) / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')} 秒`;
});

/** 截图的 cache-buster：重新克隆之后两张图必须刷新，不能吃浏览器缓存 */
const shotStamp = computed(() => props.forge?.endedAt ?? props.pageMeta[props.selected?.id]?.updatedAt ?? '');

const detailTab = ref('overview');
const detailQuality = reactive({ loading: false, fixup: null, gaps: null, history: null, liveGaps: null, cloneGaps: null, linker: null });
const verifiedQuality = computed(() => {
  const page = props.pageMeta[props.selected?.id];
  return page?.verifyFresh === true ? page.verifyDetails ?? null : null;
});
/**
 * 资产缺口与交互镜像体检**不放在组件里**。
 *
 * 父组件给本组件的键是 `'dock-' + selected.id` —— 换一颗星就是一次卸载 + 重挂，
 * 组件内的缓存随之归零。asset-gaps.json 一份可达 300KB，于是"连点五颗星"= 重下五遍。
 * 缓存挪到模块级（prefetch-cache.js：LRU 20 条 / 5 分钟），键按站点 ——
 * 这些文件本来就是一站一份，逐页取用。
 *
 * 迟到的响应在这里丢弃：每一步 await 之后都重新比对 `props.selected`，
 * 用户已经换页时旧结果不再写进面板（否则会出现"这页的缺口"配着上一页的数据）。
 */

const typeColorThemed = (t) => typeColor(t, props.theme);

/** 差异形态的中文标签与配色：集中 = 要去看，弥散 = 多为渲染差异 */
const SHAPE_CN = { concentrated: '集中', mixed: '混合', diffuse: '弥散', identical: '一致', negligible: '极小' };
const shapeLabel = (s) => SHAPE_CN[s] ?? s ?? '—';
const shapeClass = (s) => (s === 'concentrated' ? 'bad' : s === 'mixed' ? 'mid' : 'ok');
/** A≥95 / B≥85 / C<85 —— 与 score.json 的 grade 同一条线 */
const gradeCls = (r) => (r >= 0.95 ? 'ok' : r >= 0.85 ? 'mid' : 'bad');

const seoChecks = computed(() => {
  const sl = props.selected?.seoLite;
  if (!sl) return null;
  const tLen = (sl.title ?? props.selected?.title ?? '').length;
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

async function loadQuality() {
  const n = props.selected;
  if (!n) return;
  detailQuality.loading = true;
  Object.assign(detailQuality, { fixup: null, gaps: null, history: null, liveGaps: null, cloneGaps: null, linker: null });
  const name = pageNameOf(n);
  const h = props.host;
  const artifacts = props.pageMeta[n.id]?.artifacts ?? {};
  const [fu, hist, cg, lk] = await Promise.all([
    artifacts.fixup === false ? null : wsJson(h, 'pages/' + name + '/fixup-history.json'),
    fetch(API + '/api/history/' + encodeURIComponent(h) + '/' + encodeURIComponent(name), { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null),
    artifacts.cloneGaps === false ? null : wsJson(h, 'pages/' + name + '/clone-gaps.json'),
    artifacts.linker === false ? null : wsJson(h, 'linker-report.json'),
  ]);
  if (props.selected !== n) return;
  detailQuality.fixup = fu; detailQuality.history = hist; detailQuality.cloneGaps = cg;
  detailQuality.linker = lk?.pages?.find(p => p.name === name) ?? null;

  // asset-gaps.json 可达数百 KB：走模块级缓存，换页不再重下（见文件头注释与 prefetch-cache.js）
  const gaps = artifacts.assetGaps === false ? null
    : await assetGapsPrefetch.get(h, () => wsJson(h, 'audit/asset-gaps.json'));
  if (props.selected !== n) return;
  detailQuality.gaps = gaps?.pages?.find(p => p.page === name) ?? null;

  try {
    // 体检结果同理：同一站点在同一分钟内反复打开详情，不必重问一次引擎
    const health = await liveHealthPrefetch.get(h, async () => {
      const r = await fetch(API + '/api/live-health/' + encodeURIComponent(h), { headers: apiHeaders() });
      // 404 = 没导出过。这是个**确定的结果**，也该缓存 —— 否则没导出过的站点每点一页问一次。
      if (r.status === 404) return { details: [], strict: false };
      return r.ok ? r.json() : null;
    });
    if (props.selected !== n) return;
    const p = (n.path || '/').replace(/\/+$/, '') || '/';
    const key = p === '/' ? '/' : p + '/';
    detailQuality.liveGaps = health?.details?.find(d => d.page === key) ?? { page: key, unresolvedCount: 0, unresolved: [] };
  } catch { detailQuality.liveGaps = null; }
  detailQuality.loading = false;
  // 注意：上面几个 `if (props.selected !== n) return;` 会跳过这一句 —— 那是**故意的**：
  // 换页时下一次 loadQuality 会立刻把 loading 重新置 true，而旧请求的 false 不该落到新页上
  // （会出现"加载完了"但其实新页的数据还没来）。
}

function switchTab(t) {
  detailTab.value = t;
  if (t === 'quality') loadQuality();
}

/** 标签页的 ARIA 键盘模式：左右箭头在标签间移动并选中，Home/End 跳首尾 */
const TAB_ORDER = ['overview', 'seo', 'quality', 'forge'];
function onTablistKey(e) {
  const i = TAB_ORDER.indexOf(detailTab.value);
  let next = null;
  if (e.key === 'ArrowRight') next = (i + 1) % TAB_ORDER.length;
  else if (e.key === 'ArrowLeft') next = (i + TAB_ORDER.length - 1) % TAB_ORDER.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = TAB_ORDER.length - 1;
  if (next == null) return;
  e.preventDefault();
  switchTab(TAB_ORDER[next]);
  nextTick(() => dockEl.value?.querySelector('#tab-' + TAB_ORDER[next])?.focus());
}
</script>

<template>
<div class="dock" ref="dockEl" role="dialog" aria-modal="true" :aria-label="'页面详情：' + selected.url" @keydown="onDockKeydown">
  <div class="dock-head">
    <div>
      <div class="dock-title">{{ pagePathOf(selected) === '/' ? 'home' : pagePathOf(selected).slice(1) }}</div>
      <div class="dock-url">{{ selected.url }}</div>
    </div>
    <div class="dock-headbtns"><button class="dock-all" @click="$emit('forge-all')" title="批量克隆尚未完成的页面（每次最多 10 页；站点级整站克隆见星图顶部按钮）">批量克隆 10 页</button><button class="dock-close" aria-label="关闭页面详情" title="关闭" @click="$emit('close')"><Icon name="close" decorative /></button></div>
  </div>

  <div class="tabs" role="tablist" aria-label="页面详情分区" @keydown="onTablistKey">
    <button class="tab" role="tab" id="tab-overview" :aria-selected="detailTab === 'overview'" :tabindex="detailTab === 'overview' ? 0 : -1" aria-controls="panel-overview" :class="{ on: detailTab === 'overview' }" @click="switchTab('overview')">概览</button>
    <button class="tab" role="tab" id="tab-seo" :aria-selected="detailTab === 'seo'" :tabindex="detailTab === 'seo' ? 0 : -1" aria-controls="panel-seo" :class="{ on: detailTab === 'seo' }" @click="switchTab('seo')">SEO 剖析</button>
    <button class="tab" role="tab" id="tab-quality" :aria-selected="detailTab === 'quality'" :tabindex="detailTab === 'quality' ? 0 : -1" aria-controls="panel-quality" :class="{ on: detailTab === 'quality' }" @click="switchTab('quality')">质检</button>
    <button class="tab" role="tab" id="tab-forge" :aria-selected="detailTab === 'forge'" :tabindex="detailTab === 'forge' ? 0 : -1" aria-controls="panel-forge" :class="{ on: detailTab === 'forge' }" @click="switchTab('forge')">克隆</button>
  </div>

  <!-- 概览 tab -->
  <div v-show="detailTab === 'overview'" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview" tabindex="0">
    <div class="ov-grid">
      <div class="ov-item"><span class="ov-k">类型</span><span class="ov-v" :style="{ color: typeColorThemed(selected.type) }">{{ typeCn(selected.type) }}</span></div>
      <div class="ov-item"><span class="ov-k">层级深度</span><span class="ov-v">{{ selected.depth ?? '-' }}</span></div>
      <div class="ov-item"><span class="ov-k">克隆状态</span><span class="ov-v">{{ selected.forgeState === 'done' ? '已克隆' : selected.forgeState === 'running' ? '克隆中' : selected.forgeState === 'failed' ? '失败' : '未克隆' }}</span></div>
      <div class="ov-item" v-if="pageMeta[selected.id]?.assets"><span class="ov-k">资产</span><span class="ov-v">{{ fmtBytes(pageMeta[selected.id].assets.bytes) }} · {{ pageMeta[selected.id].assets.count }} 个</span></div>
      <div class="ov-item" v-if="pageMeta[selected.id]?.visualGaps != null"><span class="ov-k">视觉缺口</span><span class="ov-v" :style="{ color: pageMeta[selected.id].visualGaps.visual ? 'var(--bad)' : 'var(--ok)' }">{{ pageMeta[selected.id].visualGaps.visual }}</span></div>
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

    <!-- 还原度就摆在详情里。此前这里只有一个「分数 JSON」下载链接 —— 想知道自己
         这一页到底差在哪，得先把文件下下来自己看，那不是一个界面的做法。 -->
    <div class="ov-sec" v-if="detailScore">
      <div class="panel-sec-name">单页还原度（{{ detailScore.scoreFormulaVersion === 2 ? '当前辅助口径' : '历史旧口径' }}）</div>
      <div class="q-list">
        <div class="q-row">
          <span class="q-k">视觉</span>
          <span class="q-v" :class="gradeCls(detailScore.pixel)">
            {{ (detailScore.pixel * 100).toFixed(2) }}%
            <i class="q-file">克隆时的单页截图比对；缺失区域可能未计入差异。多视口 v2 结果见「质检」</i>
          </span>
        </div>
        <div class="q-row" v-if="detailScore.dom">
          <span class="q-k">结构</span>
          <span class="q-v">{{ ((detailScore.dom.dom ?? 0) * 100).toFixed(1) }}%<i class="q-file">与捕获的 DOM 自比，辅助项</i></span>
        </div>
        <div class="q-row">
          <span class="q-k">数据</span>
          <span class="q-v">{{ detailScore.scoreFormulaVersion !== 2 ? '未重算' : Number.isFinite(detailScore.data?.data) ? (detailScore.data.data * 100).toFixed(1) + '%' : '未测' }}<i class="q-file">抽取字段覆盖率，辅助项</i></span>
        </div>
        <div class="q-row">
          <span class="q-k">综合</span>
          <span class="q-v" :class="gradeCls(detailScore.total / 100)">{{ detailScore.total }} · {{ detailScore.grade }}</span>
        </div>
      </div>
      <div class="score-note">
        {{ detailScore.scoreFormulaVersion !== 2 ? '历史分数未按当前公式重算' : Number.isFinite(detailScore.data?.data) ? '口径 0.5×视觉 + 0.3×结构 + 0.2×数据' : '数据未测，视觉和结构权重归一' }}；等级 A≥95 / B≥85 / C&lt;85。
        <a :href="wsOpenUrl(host, `pages/${pageNameOf(selected)}/score.json`)" target="_blank" rel="noopener">原始数据 JSON</a>
      </div>
      <div class="refine" v-if="detailScore.breakdown">
        <div class="refine-bar"><i :style="{ transform: 'scaleX(' + (detailScore.breakdown.refinable || 0) + ')' }"></i></div>
        <span>剩余差异里可修的静态部分 {{ ((detailScore.breakdown.refinable || 0) * 100).toFixed(0) }}% · 动画噪声 {{ ((detailScore.breakdown.dynamicShare || 0) * 100).toFixed(0) }}%</span>
      </div>
    </div>
    <div class="dock-quick" v-if="selected.forgeState === 'done'">
      <a :href="wsOpenUrl(host, `pages/${pageNameOf(selected)}/clone/index.html`)" target="_blank" rel="noopener" title="静态镜像：剥离脚本、资产本地化，离线可开">静态镜像</a>
      <span v-if="tokenOf() && !localEngineSupportsMirror()" class="quick-disabled" :title="liveTitle">交互镜像 · 仅本机</span>
      <button v-else-if="mirrorBridgeNeeded()" type="button" :class="{ 'quick-off': mirrored === 0 }" :title="liveTitle" @click="openMirror({ url: selected.url })">交互镜像{{ mirrored === 0 ? ' · 未导出' : '' }}</button>
      <a v-else :class="{ 'quick-off': mirrored === 0 }" :href="liveUrl({ url: selected.url })" target="_blank" rel="noopener" :title="liveTitle">交互镜像{{ mirrored === 0 ? ' · 未导出' : '' }}</a>
      <a :href="wsOpenUrl(host, `compare.html?p=${pageNameOf(selected)}`)" target="_blank" rel="noopener" title="左右同步滚动，原站与静态镜像逐段对照">同步对比</a>
      <!-- 能在浏览器里打开一份产物，不等于知道它在磁盘的哪个角落。
           这一页的静态镜像目录（换图、替换文案都要进去改）就在这里给个直达。
           交互镜像与交付包是站点级的，它们的入口在「报告 → 产物位置」。 -->
      <button class="quick-dir" @click="$emit('reveal', `workspace/${host}/pages/${pageNameOf(selected)}/clone`, '静态镜像')"
              title="在资源管理器里打开这一页的静态镜像目录（assets / styles / index.html 都在里面）">打开镜像文件夹</button>
    </div>
    <div v-if="liveOpenError" class="dock-quick-note" role="alert">{{ liveOpenError }}</div>
    <div class="dock-quick-note" v-if="selected.forgeState === 'done' && mirrored === 0">
      <b>本站还没导出过交互镜像</b> —— 镜像路由是"本地有快照就回快照、否则反代回原站"，
      所以现在点「交互镜像」打开的是 <b>{{ host }}</b> 原站本身（经本地代理），不是复刻结果。
      想让它变成真镜像：到站点级「报告 → 交互镜像」导出一次。
    </div>
    <div class="forge-cta" v-if="selected.forgeState !== 'done' && selected.forgeState !== 'running'">
      <button class="forge-btn" @click="$emit('open-forge')"><Icon name="bolt" decorative /> 开始克隆此页</button>
      <div class="forge-note">捕获 → 校准 → 评分，全程约 2-3 分钟；也可点「批量克隆 10 页」</div>
    </div>
    <div class="forge-cta" v-else-if="selected.forgeState === 'done'">
      <button class="forge-btn alt" @click="switchTab('forge')">查看克隆详情 →</button>
    </div>
  </div>

  <!-- SEO tab -->
  <div v-show="detailTab === 'seo'" role="tabpanel" id="panel-seo" aria-labelledby="tab-seo" tabindex="0">
    <div class="seo-note">
      <b>侦察时的轻量体检</b>（6 项：title / description / H1 / 图片 alt / OG / lang）。
      侦察一次就把全站每页都过一遍，用来快速找出问题页。
      完整的 <b>66 条规则、六分类评分</b>在站点级的「SEO 审计」报告里出 —— 那是另一件事。
    </div>
    <div class="seo-list" v-if="selected.seoLite">
      <div class="seo-row" :class="seoChecks.title.ok ? 'ok' : 'warn'"><span class="seo-k">Title</span><span>{{ seoChecks.title.msg }}</span></div>
      <div class="seo-row" :class="seoChecks.desc.ok ? 'ok' : 'warn'"><span class="seo-k">Description</span><span>{{ seoChecks.desc.msg }}</span></div>
      <div class="seo-row" :class="seoChecks.h1.ok ? 'ok' : 'warn'"><span class="seo-k">H1 数量</span><span>{{ seoChecks.h1.msg }}</span></div>
      <div class="seo-row" :class="seoChecks.alt.ok ? 'ok' : 'warn'"><span class="seo-k">图片 Alt</span><span>{{ seoChecks.alt.msg }}</span></div>
      <div class="seo-row" :class="seoChecks.og.ok ? 'ok' : 'warn'"><span class="seo-k">OG 标签</span><span>{{ seoChecks.og.msg }}</span></div>
      <div class="seo-row" :class="seoChecks.lang.ok ? 'ok' : 'warn'"><span class="seo-k">lang 属性</span><span>{{ seoChecks.lang.msg }}</span></div>
    </div>
    <div class="seo-note" v-else>
      这一页没有 SEO 画像。两种可能：<b>该站是旧版引擎侦察的</b>（那时还不采集 SEO 信号），
      或者<b>这页是单独克隆的、不在侦察清单里</b>。
      对该站重新跑一次侦察（星图顶部输入域名 → 侦察），全部页面都会有这份画像。
    </div>
  </div>

  <!-- 质检 tab -->
  <div v-show="detailTab === 'quality'" role="tabpanel" id="panel-quality" aria-labelledby="tab-quality" tabindex="0">
    <div class="seo-note">
      <b>质检</b>把这一页「还原度之外」的几项质量证据汇总在一起。
      它们来自<b>不同的检查、在不同的时机产生</b>，跑过的才有数据：
      <table class="q-when">
        <tbody>
        <tr><td>差异形态</td><td>每次克隆自动算（像素定谳阶段）</td></tr>
        <tr><td>AI 校准曲线</td><td>每次克隆自动（校准阶段，无静态差异时自动豁免）</td></tr>
        <tr><td>多视口视觉 / 交互回放</td><td><b>按需</b>跑到才跑 —— 点下面的「运行本页体检」或星图的「全站体检」</td></tr>
        <tr><td>资产缺口</td><td><b>按需</b> —— 报告 → 资产缺口 → 运行扫描</td></tr>
        <tr><td>交互镜像离线资源</td><td><b>按需</b> —— 导出交互镜像时加 <code>--heal --strict</code></td></tr>
        <tr><td>动效驱动画像</td><td>每次克隆自动（捕获阶段，滚动扫掠之后采样）</td></tr>
        </tbody>
      </table>
    </div>
    <div class="seo-note" v-if="detailQuality.loading" role="status" aria-live="polite">加载质检数据…</div>
    <template v-else>
      <div class="ov-sec">
        <div class="panel-sec-name">视觉保真（多视口）</div>
        <div v-if="verifiedQuality" class="q-list">
          <div class="q-row"><span class="q-k">评分口径</span><span class="q-v">{{ verifiedQuality.scoreVersion === 2 ? 'v2 · 缺失区域计入差异' : '历史旧口径 · 缺失区域可能未计入差异' }}</span></div>
          <div class="q-row" v-for="v in verifiedQuality.viewports" :key="v.name">
            <span class="q-k">{{ v.name }}</span>
            <span class="q-v" :class="v.grade === 'A' ? 'ok' : v.grade === 'B' ? 'mid' : 'bad'">{{ v.score != null ? ((v.score * 100).toFixed(1) + '% ' + v.grade) : (v.skipped || v.error || '—') }}<i class="q-file" v-if="v.sourceSize && v.cloneSize">覆盖 {{ typeof v.coverageRatio === 'number' ? (v.coverageRatio * 100).toFixed(1) + '%' : '未知' }} · 原图 {{ v.sourceSize.width }}×{{ v.sourceSize.height }} / 镜像 {{ v.cloneSize.width }}×{{ v.cloneSize.height }}</i></span>
          </div>
          <div class="q-row"><span class="q-k">综合</span><span class="q-v">{{ verifiedQuality.measured === false || verifiedQuality.overall == null ? '未完整测量' : (verifiedQuality.overall * 100).toFixed(1) + '% ' + (verifiedQuality.grade ?? '') }}</span></div>
          <div class="q-row" v-if="verifiedQuality.minViewport"><span class="q-k">最差视口</span><span class="q-v" :class="verifiedQuality.minViewport.score >= 0.95 ? 'ok' : verifiedQuality.minViewport.score >= 0.85 ? 'mid' : 'bad'">{{ verifiedQuality.minViewport.name }} {{ (verifiedQuality.minViewport.score * 100).toFixed(1) }}% {{ verifiedQuality.minViewport.grade }}</span></div>
          <div class="q-row" v-if="verifiedQuality.minViewport && verifiedQuality.minViewport.score < 0.9"><span class="q-k">建议</span><span class="q-v mid">该视口差异较大（多为客户端响应式变体/JS 渲染），优先使用交互镜像</span></div>
        </div>
        <div v-else class="seo-note">{{ pageMeta[selected.id]?.verifyStatus === 'missing' ? '未运行多视口验证' : ['busy', 'timeout', 'unavailable'].includes(pageMeta[selected.id]?.verifyStatus) ? '当前无法核验体检结果，请稍后重试' : '体检结果不完整或已失效，请重新验证' }} <button class="wv-primary" style="margin-left:8px" @click="$emit('verify')">运行本页体检</button>（等价命令：<code>verify {{ host }} {{ pageNameOf(selected) }}</code>）</div>
        <!-- 差异**形态**：只给百分比的话，用户分不清"少了一张图"（集中）和"文字抗锯齿略不同"（弥散） -->
        <div v-if="detailScore?.diffShape" class="q-list" style="margin-top:8px">
          <div class="q-row">
            <span class="q-k">差异形态</span>
            <span class="q-v" :class="shapeClass(detailScore.diffShape.shape)">
              {{ shapeLabel(detailScore.diffShape.shape) }}
              <i v-if="detailScore.diffShape.blobs" class="q-file">共 {{ detailScore.diffShape.blobs }} 块 · 最大 {{ detailScore.diffShape.largest }}px · 前 5 块占 {{ Math.round((detailScore.diffShape.top5Share || 0) * 100) }}%</i>
            </span>
          </div>
          <div class="q-row">
            <span class="q-k">说明</span>
            <span class="q-v">{{ detailScore.diffShape.note }}</span>
          </div>
        </div>
        <!-- 动效驱动：吸收自 framer-and-motion 的五分类。此前只有一句 dynamicShare 百分比 ——
             那是对"我们抓不到的东西"的总结，不是"它在动什么、怎么动"的描述 -->
        <div v-if="motion" class="q-list" style="margin-top:8px">
          <div class="q-row">
            <span class="q-k">动效驱动</span>
            <span class="q-v">{{ motion.summary }}</span>
          </div>
          <div class="q-row" v-for="d in motionRows" :key="d.cn">
            <span class="q-k">{{ d.cn }}</span>
            <span class="q-v">{{ d.count }} <i class="q-file">{{ d.handling }}</i></span>
          </div>
          <div class="q-row" v-if="motion.why"><span class="q-k">口径</span><span class="q-v">{{ motion.why }}</span></div>
        </div>
      </div>
      <div class="ov-sec">
        <div class="panel-sec-name">交互回放（功能保真）</div>
        <div v-if="verifiedQuality?.functional" class="q-list">
          <div class="q-row"><span class="q-k">通过</span><span class="q-v" :class="verifiedQuality.functional.passed === verifiedQuality.functional.total ? 'ok' : 'bad'">{{ verifiedQuality.functional.passed }}/{{ verifiedQuality.functional.total }}</span></div>
          <div class="q-row" v-for="(ix, i) in (verifiedQuality.interactions || [])" :key="i">
            <span class="q-k">{{ ix.label || ('交互 ' + (i + 1)) }}</span>
            <span class="q-v" :class="ix.pass ? 'ok' : 'bad'">{{ ix.pass ? '通过' : '失败' }}<i v-if="ix.visualScore != null"> · 像素 {{ (ix.visualScore * 100).toFixed(1) }}%</i></span>
          </div>
        </div>
        <div v-else-if="verifiedQuality?.interactions?.some(ix => ix.unverified)" class="seo-note">交互回放未核实，请查看本地验证记录中的错误。</div>
        <div v-else class="seo-note">未运行交互回放或未发现可回放交互。</div>
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
      <div class="ov-sec">
        <div class="panel-sec-name">交互镜像离线资源</div>
        <div v-if="detailQuality.liveGaps" class="q-list">
          <div class="q-row"><span class="q-k">离线缺口</span><span class="q-v" :class="detailQuality.liveGaps.unresolvedCount ? 'bad' : 'ok'">{{ detailQuality.liveGaps.unresolvedCount ?? 0 }}</span></div>
          <div class="q-row" v-for="(u, i) in (detailQuality.liveGaps.unresolved || []).slice(0, 8)" :key="i">
            <span class="q-k">缺</span><span class="q-v" :title="u">{{ String(u).slice(0, 60) }}</span>
          </div>
        </div>
        <div v-else class="seo-note">尚无交互镜像体检报告（导出时加 --heal --strict 生成 health.json）</div>
      </div>
      <div class="ov-sec">
        <div class="panel-sec-name">克隆期 CSS 缺口</div>
        <div v-if="detailQuality.cloneGaps" class="q-list">
          <div class="q-row">
            <span class="q-k">本地化失败引用</span>
            <span class="q-v" :class="(detailQuality.cloneGaps.cssRefsFailed ?? 0) ? 'mid' : 'ok'">{{ detailQuality.cloneGaps.cssRefsFailed ?? 0 }}</span>
          </div>
          <div class="q-row">
            <span class="q-k">残留同源引用</span>
            <span class="q-v" :class="(detailQuality.cloneGaps.leftoverSameOriginRefs ?? 0) ? 'bad' : 'ok'">{{ detailQuality.cloneGaps.leftoverSameOriginRefs ?? 0 }}</span>
          </div>
          <div class="q-row" v-for="(g, i) in (detailQuality.cloneGaps.gaps || []).slice(0, 8)" :key="i">
            <span class="q-k">{{ g.reason === 'unreachable' ? '抓取失败' : '无法解析' }}<i class="q-file"> · {{ g.file }}</i></span>
            <span class="q-v" :title="g.ref">{{ String(g.ref).slice(0, 56) }}</span>
          </div>
          <div class="q-row" v-if="(detailQuality.cloneGaps.gaps || []).length > 8">
            <span class="q-k">…</span><span class="q-v">另有 {{ detailQuality.cloneGaps.gaps.length - 8 }} 处，见 clone-gaps.json</span>
          </div>
          <div class="q-row" v-if="detailQuality.cloneGaps.cssRefsFailed">
            <span class="q-k">说明</span>
            <span class="q-v">多为<b>原站自身</b>已失效的引用（原站上也是 404）。判定是否影响还原度请看上方「视觉保真」——像素比对才是结论。</span>
          </div>
        </div>
        <div v-else class="seo-note">本页无缺口报告（该页克隆于缺口落盘功能之前，重新克隆即可生成）</div>
      </div>
      <div class="ov-sec">
        <div class="panel-sec-name">交付物引用完整性</div>
        <!-- 与上一块的分别：clone-gaps 是 CSS 里的引用，这里是 HTML 里的。
             未本地化的 HTML 引用在本地服务下会 404 —— 而像素分可能仍然很高
             （最终样式已在 cssom.css 里），所以肉眼看不出来，必须显式报。
             实测来源：vitest.dev 的 rel="preload stylesheet" 曾漏掉两条。 -->
        <div v-if="detailQuality.linker" class="q-list">
          <div class="q-row">
            <span class="q-k">未本地化引用</span>
            <span class="q-v" :class="(detailQuality.linker.missingLocal || []).length ? 'bad' : 'ok'">{{ (detailQuality.linker.missingLocal || []).length }}</span>
          </div>
          <div class="q-row" v-for="(m, i) in (detailQuality.linker.missingLocal || []).slice(0, 8)" :key="i">
            <span class="q-k">缺失</span><span class="q-v" :title="m">{{ String(m).slice(0, 56) }}</span>
          </div>
          <div class="q-row">
            <span class="q-k">资源本地化</span>
            <span class="q-v">成功 {{ detailQuality.linker.assetsLocalized ?? 0 }} · 失败 {{ detailQuality.linker.assetFailed ?? 0 }} · HAR 补回 {{ detailQuality.linker.harRecovered ?? 0 }}</span>
          </div>
          <div class="q-row">
            <span class="q-k">跨页接线</span>
            <span class="q-v">站内改写 {{ detailQuality.linker.linksRewired ?? 0 }} · 回原站 {{ detailQuality.linker.linksToLive ?? 0 }}<i class="q-file">未克隆的页指回原站是预期行为</i></span>
          </div>
        </div>
        <div v-else class="seo-note">本页无接线报告（该页克隆于 linker-report 落盘之前，重新克隆即可生成）</div>
      </div>
      <div class="ov-sec" v-if="detailQuality.history?.jobs?.length">
        <div class="panel-sec-name">克隆历史（引擎持久化 · 最近 {{ detailQuality.history.jobs.length }} 次）</div>
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
      <!-- 没跑校准也是结论，要说出来：此前三条提前返回什么都不写，界面上只剩一个空格子，
           用户分不清"校准跑了但没改动"和"压根没跑"。
           数据源必须与上面那句 v-else-if 一致 —— 这一块和克隆 tab 那一块是一对镜像的坑，
           写法见下方克隆 tab 的注释。 -->
      <div class="ov-sec" v-else-if="detailQuality.fixup">
        <div class="panel-sec-name">AI 校准</div>
        <div class="q-list">
          <div class="q-row">
            <span class="q-k">未运行</span>
            <span class="q-v">{{ detailQuality.fixup.detail || skipReasonCn(detailQuality.fixup.skipped) || '这次克隆没留下校准记录（旧版本引擎）' }}</span>
          </div>
        </div>
      </div>
    </template>
  </div>

  <!-- 克隆 tab -->
  <div v-show="detailTab === 'forge'" role="tabpanel" id="panel-forge" aria-labelledby="tab-forge" tabindex="0">
    <div class="forge-cta" v-if="!forge && selected.forgeState !== 'done' && selected.forgeState !== 'running'">
      <button class="forge-btn" @click="$emit('open-forge')">⚡ 开始克隆此页</button>
      <div class="forge-note">六阶段：捕获骨架 → 注入皮肤 → 渲染校准 → AI 校准 → 像素定谳 → 情报入库</div>
    </div>

    <!-- 任务在跑、但我们手上没有它的任务对象（点开的是"克隆中"的页，或刷新过页面）。
         此前这块什么都不渲染 —— 用户点进"克隆中"的页面看到的是空面板。 -->
    <div class="forge-cta" v-if="!forge && selected.forgeState === 'running'">
      <div class="forge-note">这一页正在克隆中。实时进度与日志在右下角的<b>任务中心</b>（点一下即可打开）。</div>
    </div>

    <!-- 校准结论：任务结束后这里要能回答"AI 校准做了什么 / 为什么没做"。
         曲线此前只在任务进行中的面板里，一结束就"消失"了（其实是被写进了 fixup-history.json，
         只是没人读）—— 用户看到的是一次性动画。 -->
    <div class="ov-sec" v-if="selected.forgeState === 'done' && !forge && dockFixup">
      <div class="panel-sec-name">AI 校准</div>
      <div class="q-list">
        <template v-if="dockFixup.rounds?.length">
          <div class="q-row" v-for="r in dockFixup.rounds" :key="r.round">
            <span class="q-k">第 {{ r.round }} 轮</span>
            <span class="q-v">{{ r.before }}% → {{ r.after }}% <b :class="r.kept ? 'ok' : 'bad'">{{ r.kept ? '保留' : '回滚' }}</b></span>
          </div>
        </template>
        <!-- 这一块的数据源必须是 dockFixup（它的 v-if 里就有 dockFixup），
             不能顺手读 detailQuality.fixup —— 那份只有切到「质检」标签才会加载，
             而本块在四个 tab 都是 v-show 的情况下**一进面板就会渲染**。
             写成 detailQuality.fixup.detail 时，285 个带 fixup-history 的页面
             每点开一次详情就抛一次 `Cannot read properties of null (reading 'detail')`，
             而且抛在 patch 阶段：画面留着上一帧、看着正常，实际那次更新整个被中止。 -->
        <div class="q-row" v-else>
          <span class="q-k">未运行</span>
          <span class="q-v">{{ dockFixup.detail || skipReasonCn(dockFixup.skipped) || '这次克隆没留下校准记录（旧版本引擎）' }}</span>
        </div>
      </div>
    </div>

    <!-- 已有产物：把证据摆出来。
         此前这个 tab 在"任务结束 / 刷新过页面"之后只剩一个「重新克隆」按钮 —— 用户点进来
         看到的是空面板，而磁盘上其实躺着两张可直接对比的截图与一份评分。 -->
    <div v-if="selected.forgeState === 'done' && !forge" class="shot-pair">
      <figure class="shot">
        <figcaption>原站</figcaption>
        <AuthImage :key="'s' + shotStamp" :src="wsUrl(host, `pages/${pageNameOf(selected)}/shot-src.png`)" :token="tokenOf()" alt="原站首屏截图" />
      </figure>
      <figure class="shot">
        <figcaption>静态镜像</figcaption>
        <AuthImage :key="'c' + shotStamp" :src="wsUrl(host, `pages/${pageNameOf(selected)}/shot-clone.png`)" :token="tokenOf()" alt="静态镜像首屏截图" />
      </figure>
    </div>
    <div class="forge-cta" v-if="!forge && selected.forgeState === 'done'">
      <button class="forge-btn alt" @click="$emit('open-forge')"><Icon name="refresh" decorative /> 重新克隆此页</button>
    </div>

    <template v-if="forge">
      <div class="stages">
        <div class="stage" v-for="(label, key, i) in STAGES" :key="key"
             :class="forge.stages[key]">
          <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>{{ label }}<span class="dot"></span>
        </div>
      </div>

      <!-- 实时窗口：子进程正在打印什么。整站克隆一页要几分钟，此前界面上唯一的变化
           就是阶段条上一个圆点变色 —— 用户看不出它到底在动还是卡住了。 -->
      <div class="live surface">
        <div class="live-head">
          <span class="live-dot" :class="{ on: !forge.done }" aria-hidden="true"></span>
          <!-- 状态词进 live region；计时每秒都在变，读屏会念个不停 —— 所以对它 aria-hidden -->
          <span role="status" aria-live="polite">{{ forge.done ? (forge.failed ? '已结束（失败）' : '已完成') : '正在运行' }}</span>
          <span aria-hidden="true"> · 已用 {{ elapsedText }}</span>
        </div>
        <pre class="live-log" v-if="forge.logs.length" role="log" aria-live="polite" aria-label="克隆实时输出">{{ forge.logs.slice(-14).join('\n') }}</pre>
        <div class="live-log pending" v-else>等待子进程输出…</div>
      </div>

      <div class="verdict surface" v-if="forge.score">
        <div class="verdict-label">VISUAL FIDELITY · 视觉还原度（可核验口径）</div>
        <div class="score-num" :class="(forge.score.pixel * 100) >= 95 ? 'ok' : (forge.score.pixel * 100) >= 85 ? 'mid' : 'bad'">
          {{ (forge.score.pixel * 100).toFixed(1) }}<small>%</small>
        </div>
        <div class="score-break">
          <span>结构 {{ ((forge.score.dom?.dom ?? 0) * 100).toFixed(1) }}%</span>
          <span>数据 {{ Number.isFinite(forge.score.data?.data) ? (forge.score.data.data * 100).toFixed(1) + '%' : '未测' }}</span>
          <span class="grade">综合 {{ forge.score.total }} · {{ forge.score.grade }}</span>
        </div>
        <div class="score-note">结构/数据与捕获 DOM 同源比对（自证辅助项）；视觉分才是对外可核验口径。</div>
        <div class="refine" v-if="forge.score.breakdown">
          <div class="refine-bar"><i :style="{ transform: 'scaleX(' + forge.score.breakdown.refinable + ')' }"></i></div>
          <span>可修静态差异 {{ (forge.score.breakdown.refinable * 100).toFixed(0) }}% · 动画噪声 {{ (forge.score.breakdown.dynamicShare * 100).toFixed(0) }}%</span>
        </div>
      </div>
      <div class="verdict pending surface" v-else-if="!forge.done && !forge.error"><span class="scan"></span>克隆中 …</div>
      <!-- 失败原因：一句人话在上，原始技术串收进 details —— 不再整段糊在面板里 -->
      <div class="dock-err surface" v-if="forge.error">
        <p class="dock-err-msg">{{ forge.error }}</p>
        <p class="dock-err-hint" v-if="forge.done">克隆没跑完：已生成的阶段产物都还在，重跑会从当前这页重新开始。原始报错与引擎日志可以帮助定位。</p>
        <details><summary>技术详情</summary><pre>{{ forge.error }}&#10;日志目录：core/workspace/_runs/（最新的 engine.log）</pre></details>
      </div>
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
          <AuthImage :src="wsUrl(host, `pages/${forge.pageName}/shot-src.png`)" :token="tokenOf()" alt="原站首屏截图" />
        </div>
        <div class="pane">
          <div class="pane-label">MIRROR · 镜像</div>
          <AuthImage :src="wsUrl(host, `pages/${forge.pageName}/shot-clone.png`)" :token="tokenOf()" alt="静态镜像首屏截图" />
        </div>
      </div>
      <div class="compare-link" v-if="forge.done">
        <a :href="wsOpenUrl(host, `compare.html?p=${forge.pageName}`)" target="_blank" rel="noopener"><Icon name="swap" decorative /> 同步滚动对比</a>
        <span class="sep">·</span>
        <span v-if="tokenOf() && !localEngineSupportsMirror()" class="quick-disabled" :title="liveTitle">交互镜像 · 仅本机</span>
        <button v-else-if="mirrorBridgeNeeded()" type="button" :title="liveTitle" @click="openMirror(forge)">交互镜像</button>
        <a v-else :href="liveUrl(forge)" target="_blank" rel="noopener" title="功能与数据实时回原站（代理通道）">交互镜像</a>
        <span class="sep">·</span>
        <a :href="wsOpenUrl(host, `pages/${forge.pageName}/clone/index.html`)" target="_blank" rel="noopener">静态镜像</a>
      </div>
      <div v-if="liveOpenError" class="dock-quick-note" role="alert">{{ liveOpenError }}</div>
      <iframe v-if="forge.done && !staticBridgeNeeded()" :key="forge.taskId" class="live-clone" :src="wsUrl(host, `pages/${forge.pageName}/clone/index.html`)" title="living clone"></iframe>
      <div v-else-if="forge.done" class="dock-quick-note">跨源预览需在引擎地址打开：<a :href="wsOpenUrl(host, `pages/${forge.pageName}/clone/index.html`)" target="_blank" rel="noopener">打开静态镜像</a></div>
</template>
  </div>
</div>
</template>
