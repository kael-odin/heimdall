<script setup>
/**
 * DetailDock — 单页详情面板（概览 / SEO 剖析 / 质检 / 克隆 四个标签页）
 *
 * 质检那一页的数据加载（loadQuality）**属于本组件**，不下发到父组件：
 * 它要读 5 个按页产物文件，且只在切到该标签页时才有意义。
 * 放父组件的话，每次打开详情都会白拉一遍 —— 而其中 asset-gaps.json 有 300KB。
 * （asset-gaps.json 按站点缓存：逐页切换时不重复下载，换站点才失效。）
 *
 * 面板打开时父组件会隐藏右下角的「克隆档案」链接 —— 本面板是全高右侧浮层，
 * 会把它整块盖住（实测 154×32），留着就等于点不到。
 */
import { ref, reactive, computed } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders, wsJson } from './api.js';
import { typeColor, typeCn } from './types.js';
import { fmtBytes, fmtDate } from './format.js';
import { pageNameOf, liveUrl } from './pages.js';

const props = defineProps({
  host: { type: String, default: '' },
  selected: { type: Object, default: null },
  forge: { type: Object, default: null },
  pageMeta: { type: Object, default: () => ({}) },
  detailIntel: { type: Object, default: null },
  detailScore: { type: Object, default: null },
  theme: { type: String, default: 'dark' },
});
const emit = defineEmits(['close', 'open-forge', 'forge-all', 'verify']);

const STAGES = { capture: '捕获骨架', build: '注入皮肤', shot: '渲染校准', fixup: 'AI 校准', diff: '像素定谳', harvest: '情报入库' };

const detailTab = ref('overview');
const detailQuality = reactive({ loading: false, verify: null, fixup: null, gaps: null, history: null, liveGaps: null, cloneGaps: null, linker: null });
const assetGapsCache = ref(null);
const assetGapsHost = ref(null);
let liveHealth = null, liveHealthHost = '';

const typeColorThemed = (t) => typeColor(t, props.theme);
const pageName = computed(() => (props.selected ? pageNameOf(props.selected) : ''));

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
  Object.assign(detailQuality, { verify: null, fixup: null, gaps: null, history: null, liveGaps: null, cloneGaps: null, linker: null });
  const name = pageNameOf(n);
  const h = props.host;
  const [v, fu, hist, cg, lk] = await Promise.all([
    wsJson(h, 'verify/' + name + '/verify.json'),
    wsJson(h, 'pages/' + name + '/fixup-history.json'),
    fetch(API + '/api/history/' + encodeURIComponent(h) + '/' + encodeURIComponent(name), { headers: apiHeaders() }).then(r => r.ok ? r.json() : null).catch(() => null),
    wsJson(h, 'pages/' + name + '/clone-gaps.json'),
    wsJson(h, 'linker-report.json'),
  ]);
  if (props.selected !== n) return;
  detailQuality.verify = v; detailQuality.fixup = fu; detailQuality.history = hist; detailQuality.cloneGaps = cg;
  detailQuality.linker = lk?.pages?.find(p => p.name === name) ?? null;

  // asset-gaps.json 可达数百 KB，按站点缓存；换站点才失效
  if (!assetGapsCache.value || assetGapsHost.value !== h) {
    assetGapsCache.value = null;
    const gaps = await wsJson(h, 'audit/asset-gaps.json');
    if (gaps) { assetGapsCache.value = gaps; assetGapsHost.value = h; }
  }
  detailQuality.gaps = assetGapsCache.value?.pages?.find(p => p.page === name) ?? null;

  try {
    if (!liveHealth || liveHealthHost !== h) {
      const r = await fetch(API + '/api/live-health/' + encodeURIComponent(h), { headers: apiHeaders() });
      liveHealth = r.ok ? await r.json() : null;
      liveHealthHost = h;
    }
    const p = (n.path || '/').replace(/\/+$/, '') || '/';
    const key = p === '/' ? '/' : p + '/';
    detailQuality.liveGaps = liveHealth?.details?.find(d => d.page === key) ?? { page: key, unresolvedCount: 0, unresolved: [] };
  } catch { detailQuality.liveGaps = null; }
  detailQuality.loading = false;
}

function switchTab(t) {
  detailTab.value = t;
  if (t === 'quality') loadQuality();
}
</script>

<template>
<div class="dock">
  <div class="dock-head">
    <div>
      <div class="dock-title">{{ selected.path === '/' ? 'home' : selected.path.slice(1) }}</div>
      <div class="dock-url">{{ selected.url }}</div>
    </div>
    <div class="dock-headbtns"><button class="dock-all" @click="$emit('forge-all')" title="批量克隆尚未完成的页面（每次最多 10 页，引擎 2 并发）">批量克隆 10 页</button><button class="dock-close" aria-label="关闭页面详情" title="关闭" @click="$emit('close')"><Icon name="close" decorative /></button></div>
  </div>

  <div class="tabs">
    <button class="tab" :class="{ on: detailTab === 'overview' }" @click="switchTab('overview')">概览</button>
    <button class="tab" :class="{ on: detailTab === 'seo' }" @click="switchTab('seo')">SEO 剖析</button>
    <button class="tab" :class="{ on: detailTab === 'quality' }" @click="switchTab('quality')">质检</button>
    <button class="tab" :class="{ on: detailTab === 'forge' }" @click="switchTab('forge')">克隆</button>
  </div>

  <!-- 概览 tab -->
  <div v-show="detailTab === 'overview'">
    <div class="ov-grid">
      <div class="ov-item"><span class="ov-k">类型</span><span class="ov-v" :style="{ color: typeColorThemed(selected.type) }">{{ typeCn(selected.type) }}</span></div>
      <div class="ov-item"><span class="ov-k">层级深度</span><span class="ov-v">{{ selected.depth ?? '-' }}</span></div>
      <div class="ov-item"><span class="ov-k">克隆状态</span><span class="ov-v">{{ selected.forgeState === 'done' ? '已克隆' : selected.forgeState === 'running' ? '克隆中' : selected.forgeState === 'failed' ? '失败' : '未克隆' }}</span></div>
      <div class="ov-item" v-if="detailScore"><span class="ov-k">还原度</span><span class="ov-v" :style="{ color: detailScore.grade === 'A' ? 'var(--ok)' : 'var(--warn)' }">{{ detailScore.total }}% {{ detailScore.grade }}</span></div>
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
    <div class="dock-quick" v-if="selected.forgeState === 'done'">
      <a :href="`/${host}/pages/${pageNameOf(selected)}/clone/index.html`" target="_blank" rel="noopener">打开克隆</a>
      <a :href="liveUrl({ url: selected.url })" target="_blank" rel="noopener">活镜像</a>
      <a :href="`/${host}/compare.html?p=${pageNameOf(selected)}`" target="_blank" rel="noopener">同步对比</a>
      <a :href="`/${host}/pages/${pageNameOf(selected)}/score.json`" target="_blank" rel="noopener">分数 JSON</a>
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
          <div class="q-row" v-if="detailQuality.verify.minViewport && detailQuality.verify.minViewport.score < 0.9"><span class="q-k">建议</span><span class="q-v mid">该视口差异较大（多为客户端响应式变体/JS 渲染），优先使用活镜像</span></div>
        </div>
        <div v-else class="seo-note">未运行多视口验证 <button class="wv-primary" style="margin-left:8px" @click="$emit('verify')">运行本页体检</button>（等价命令：<code>verify {{ host }} {{ pageNameOf(selected) }}</code>）</div>
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
      <div class="ov-sec">
        <div class="panel-sec-name">活镜像离线资源</div>
        <div v-if="detailQuality.liveGaps" class="q-list">
          <div class="q-row"><span class="q-k">离线缺口</span><span class="q-v" :class="detailQuality.liveGaps.unresolvedCount ? 'bad' : 'ok'">{{ detailQuality.liveGaps.unresolvedCount ?? 0 }}</span></div>
          <div class="q-row" v-for="(u, i) in (detailQuality.liveGaps.unresolved || []).slice(0, 8)" :key="i">
            <span class="q-k">缺</span><span class="q-v" :title="u">{{ String(u).slice(0, 60) }}</span>
          </div>
        </div>
        <div v-else class="seo-note">尚无活镜像体检报告（导出时加 --heal --strict 生成 health.json）</div>
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
    </template>
  </div>

  <!-- 克隆 tab -->
  <div v-show="detailTab === 'forge'">
    <div class="forge-cta" v-if="!forge && selected.forgeState !== 'done' && selected.forgeState !== 'running'">
      <button class="forge-btn" @click="$emit('open-forge')">⚡ 开始克隆此页</button>
      <div class="forge-note">六阶段：捕获骨架 → 注入皮肤 → 渲染校准 → AI 校准 → 像素定谳 → 情报入库</div>
    </div>
    <div class="forge-cta" v-if="!forge && selected.forgeState === 'done'">
      <button class="forge-btn alt" @click="$emit('open-forge')"><Icon name="refresh" decorative /> 重新克隆此页</button>
    </div>

    <template v-if="forge">
      <div class="stages">
        <div class="stage" v-for="(label, key, i) in { capture: '捕获骨架', build: '注入皮肤', shot: '渲染校准', fixup: 'AI 校准', diff: '像素定谳', harvest: '情报入库' }" :key="key"
             :class="forge.stages[key]">
          <span class="idx">{{ String(i + 1).padStart(2, '0') }}</span>{{ label }}<span class="dot"></span>
        </div>
      </div>

      <div class="verdict surface" v-if="forge.score">
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
          <div class="refine-bar"><i :style="{ transform: 'scaleX(' + forge.score.breakdown.refinable + ')' }"></i></div>
          <span>可修静态差异 {{ (forge.score.breakdown.refinable * 100).toFixed(0) }}% · 动画噪声 {{ (forge.score.breakdown.dynamicShare * 100).toFixed(0) }}%</span>
        </div>
      </div>
      <div class="verdict pending surface" v-else-if="!forge.done && !forge.error"><span class="scan"></span>克隆中 …</div>
      <div class="dock-err surface" v-if="forge.error">{{ forge.error }}</div>
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
        <a :href="`/${host}/compare.html?p=${forge.pageName}`" target="_blank" rel="noopener"><Icon name="swap" decorative /> 同步滚动对比</a>
        <span class="sep">·</span>
        <a :href="liveUrl(forge)" target="_blank" rel="noopener" title="功能与数据实时回原站（代理通道）">⚡ 活镜像</a>
        <span class="sep">·</span>
        <a :href="`/${host}/pages/${forge.pageName}/clone/index.html`" target="_blank" rel="noopener">静态镜像</a>
      </div>
      <iframe v-if="forge.done" :key="forge.taskId" class="live-clone" :src="`/${host}/pages/${forge.pageName}/clone/index.html`" title="living clone"></iframe>
</template>
  </div>
</div>
</template>
