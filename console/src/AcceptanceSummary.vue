<script setup>
import { ref, watch, onBeforeUnmount } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders, tokenOf, wsOpenUrl, wsUrl } from './api.js';
import { ACCEPTANCE_SOURCES, VERIFICATION_LABELS, acceptanceMarkdown, buildAcceptanceSummary } from './acceptance.js';

const props = defineProps({ host: { type: String, default: '' } });
const summary = ref(null);
const loading = ref(false);
let controller = null;
let serial = 0;

async function fetchJson(url, signal) {
  try {
    const response = await fetch(url, { headers: apiHeaders(), signal });
    if (response.status === 404) return { status: 'missing' };
    if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };
    if (!(response.headers.get('content-type') ?? '').includes('json')) {
      return { status: 'error', reason: '返回内容不是 JSON' };
    }
    return { status: 'ok', data: await response.json(), mtime: response.headers.get('last-modified') };
  } catch (error) {
    return { status: 'error', reason: String(error?.message ?? error) };
  }
}

async function load() {
  controller?.abort();
  const h = props.host;
  const current = ++serial;
  summary.value = null;
  if (!h) { loading.value = false; return; }
  controller = new AbortController();
  loading.value = true;
  const signal = controller.signal;
  const entries = Object.entries(ACCEPTANCE_SOURCES);
  const results = await Promise.all(entries.map(([key, source]) => fetchJson(
    key === 'pages' ? `${API}/api/pages/${encodeURIComponent(h)}` : wsUrl(h, source.path), signal,
  )));
  if (serial !== current || signal.aborted) return;
  const sources = Object.fromEntries(entries.map(([key], i) => [key, results[i]]));
  summary.value = buildAcceptanceSummary({ site: { host: h }, sources });
  loading.value = false;
}

watch(() => props.host, load, { immediate: true });
onBeforeUnmount(() => { serial++; controller?.abort(); });

const number = value => value == null ? '—' : value.toLocaleString('zh-CN');
const status = (key) => {
  if (!summary.value) return '';
  const s = summary.value.states[key];
  return s === 'missing' ? '未生成' : s === 'error' ? '读取失败' : summary.value.stale[key] ? '需重跑' : '已生成';
};
const sourceHref = key => key === 'pages'
  ? tokenOf() && API !== location.origin ? '' : `${API}/api/pages/${encodeURIComponent(props.host)}`
  : ACCEPTANCE_SOURCES[key]?.path ? wsOpenUrl(props.host, ACCEPTANCE_SOURCES[key].path) : '';
const evidenceHref = path => path && !path.startsWith('GET ') ? wsOpenUrl(props.host, path) : '';

function download() {
  if (!summary.value) return;
  const file = new Blob([acceptanceMarkdown(summary.value)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.host}-acceptance.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
</script>

<template>
  <section class="acceptance report-wide" aria-labelledby="acceptance-title">
    <div class="ac-head">
      <div>
        <h2 id="acceptance-title">验收摘要</h2>
        <p>本站当前证据 · 侦察、队列、产物、验证与缺口</p>
      </div>
      <div class="ac-actions">
        <button type="button" :disabled="!host || loading" @click="load" title="重新读取本站验收证据"><Icon name="refresh" decorative /> 刷新</button>
        <button type="button" :disabled="!summary || summary.states.pages !== 'ok'" @click="download">下载 Markdown</button>
      </div>
    </div>
    <div v-if="!host" class="ac-empty">先选择一个站点。</div>
    <div v-else-if="loading" class="ac-empty" role="status">正在读取 {{ host }} 的验收证据…</div>
    <template v-else-if="summary">
      <div class="ac-verdict" :class="summary.verificationState" role="status" aria-live="polite">
        <strong>{{ VERIFICATION_LABELS[summary.verificationState] }}</strong>
        <span>多视口评分 {{ summary.scoreVersion == null ? '未标版本' : `v${summary.scoreVersion}` }} · {{ number(summary.verified) }}/{{ number(summary.targetTotal) }} 页有当前产物的 v2 完整测量</span>
      </div>
      <div class="ac-metrics">
        <div><b>{{ number(summary.discovered) }}</b><span>侦察发现</span><small v-if="summary.reconCapped">达到侦察上限，站点可能还有页面</small></div>
        <div><b>{{ number(summary.planned) }}</b><span>计划克隆</span><small v-if="summary.planned != null">其中 {{ number(summary.plannedCloned) }} 页已有产物</small><small v-else>没有队列，不能推断计划数</small></div>
        <div><b>{{ number(summary.cloned) }}</b><span>实际克隆</span><small v-if="summary.cloned != null && summary.clonedDistinct !== summary.cloned">{{ number(summary.clonedDistinct) }} 个唯一 URL</small></div>
        <div><b>{{ number(summary.verified) }}</b><span>v2 完整验证</span><small>仅计当前克隆产物对应的测量</small></div>
        <div><b>{{ number(summary.untested) }}</b><span>未完整验证</span><small>侦察、队列与产物目标并集</small></div>
        <div><b>{{ number(summary.visualGaps) }}</b><span>视觉资源缺口</span><small v-if="summary.stale.assets">资产扫描过期，需重跑</small><small v-else>全部引用缺口 {{ number(summary.resourceRefs) }}</small></div>
      </div>
      <div class="ac-detail">
        <div>
          <h3>证据状态</h3>
          <div class="ac-sources">
            <div v-for="(source, key) in ACCEPTANCE_SOURCES" :key="key">
              <span>{{ source.label }}</span>
              <strong :class="summary.states[key] === 'ok' && !summary.stale[key] ? 'ok' : 'warn'" :title="summary.sourceErrors[key] || ''">{{ status(key) }}</strong>
              <a v-if="sourceHref(key) && summary.states[key] === 'ok'" :href="sourceHref(key)" target="_blank" rel="noopener">查看 JSON</a>
              <code v-else-if="key === 'pages'">GET /api/pages/{{ host }}</code>
              <code v-else>{{ source.path }}</code>
              <em v-if="summary.sourceErrors[key]">{{ summary.sourceErrors[key] }}</em>
            </div>
          </div>
        </div>
        <div>
          <h3>缺口与失败</h3>
          <dl class="ac-gaps">
            <div><dt>队列失败 / 未完成</dt><dd>{{ number(summary.queueFailed) }} / {{ number(summary.queueUnfinished) }}</dd></div>
            <div><dt>历史口径 / 部分测量</dt><dd>{{ number(summary.legacy) }} / {{ number(summary.partial) }}</dd></div>
            <div><dt>v2 最差视口低于 85%</dt><dd>{{ number(summary.lowScore) }}</dd></div>
            <div><dt>资源本地化失败 / 本地引用缺失</dt><dd>{{ number(summary.assetFailed) }} / {{ number(summary.missingLocal) }}</dd></div>
            <div><dt>回原站链接</dt><dd>{{ number(summary.linksToLive) }}</dd></div>
          </dl>
          <p class="ac-note">“—”表示证据未生成、读取失败或已经过期；回原站链接是离线交付待核对项，未必是坏链。</p>
        </div>
      </div>
      <div class="ac-failures" v-if="summary.failures.length">
        <h3>失败原因与逐页缺口 <span>{{ summary.failures.length }}</span></h3>
        <ul>
          <li v-for="(item, index) in summary.failures.slice(0, 5)" :key="index">
            <b>{{ item.stage }}</b><span>{{ item.page || host }}</span><span>{{ item.reason }}</span>
            <a v-if="evidenceHref(item.evidence)" :href="evidenceHref(item.evidence)" target="_blank" rel="noopener">证据</a>
          </li>
        </ul>
        <details v-if="summary.failures.length > 5">
          <summary>查看其余 {{ summary.failures.length - 5 }} 项</summary>
          <ul>
            <li v-for="(item, index) in summary.failures.slice(5)" :key="index">
              <b>{{ item.stage }}</b><span>{{ item.page || host }}</span><span>{{ item.reason }}</span>
              <a v-if="evidenceHref(item.evidence)" :href="evidenceHref(item.evidence)" target="_blank" rel="noopener">证据</a>
            </li>
          </ul>
        </details>
      </div>
      <p v-else class="ac-note">当前可用证据没有记录失败原因。缺失、过期或仅抽样的证据仍需补跑；这不等于离线交付通过。</p>
    </template>
  </section>
</template>

<style scoped>
.acceptance { grid-column: 1 / -1; padding: 18px 20px; border-bottom: 1px solid var(--border); background: var(--surface-2); border-radius: var(--r-sm); min-width: 0; }
.ac-head { display: flex; align-items: start; justify-content: space-between; gap: 16px; }
.ac-head h2 { margin: 0; font-size: 16px; color: var(--text); }
.ac-head p { margin: 3px 0 0; font-size: 11px; color: var(--text-faint); }
.ac-actions { display: flex; gap: 8px; flex: none; }
.ac-actions button { display: inline-flex; align-items: center; gap: 5px; min-height: 34px; padding: 5px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg-2); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
.ac-actions button:disabled { opacity: .5; cursor: default; }
.ac-actions button:focus-visible, .ac-sources a:focus-visible, .ac-failures a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ac-empty { padding: 20px 0; color: var(--text-dim); font-size: 12px; }
.ac-verdict { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 15px; margin: 15px 0; padding: 9px 12px; border-left: 3px solid var(--warn); background: color-mix(in srgb, var(--warn) 7%, transparent); font-size: 12px; color: var(--text-dim); }
.ac-verdict strong { color: var(--warn); font-size: 13px; }
.ac-verdict.passed { border-color: var(--ok); background: color-mix(in srgb, var(--ok) 7%, transparent); }
.ac-verdict.passed strong { color: var(--ok); }
.ac-verdict.failed, .ac-verdict.error { border-color: var(--bad); background: color-mix(in srgb, var(--bad) 7%, transparent); }
.ac-verdict.failed strong, .ac-verdict.error strong { color: var(--bad); }
.ac-metrics { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.ac-metrics > div { min-width: 0; padding: 13px 10px; border-right: 1px solid var(--border); }
.ac-metrics > div:last-child { border-right: 0; }
.ac-metrics b { display: block; font-size: 21px; line-height: 1.2; color: var(--text); font-variant-numeric: tabular-nums; }
.ac-metrics span { display: block; margin-top: 5px; font-size: 11px; color: var(--text-dim); }
.ac-metrics small { display: block; margin-top: 4px; font-size: 10px; line-height: 1.35; color: var(--text-faint); }
.ac-detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 26px; margin-top: 17px; }
.ac-detail h3, .ac-failures h3 { margin: 0 0 8px; font-size: 12px; color: var(--text); }
.ac-sources { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 15px; }
.ac-sources > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 7px; min-width: 0; padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 11px; }
.ac-sources strong { font-size: 10px; color: var(--warn); }
.ac-sources strong.ok { color: var(--ok); }
.ac-sources a { color: var(--accent); text-decoration: none; }
.ac-sources code { color: var(--text-faint); overflow-wrap: anywhere; }
.ac-sources em { flex: 1 1 100%; color: var(--bad); font-style: normal; overflow-wrap: anywhere; }
.ac-gaps { margin: 0; }
.ac-gaps > div { display: flex; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--border); padding: 5px 0; font-size: 11px; }
.ac-gaps dt { color: var(--text-dim); }
.ac-gaps dd { margin: 0; color: var(--text); font-variant-numeric: tabular-nums; }
.ac-note { margin: 9px 0 0; font-size: 10.5px; line-height: 1.5; color: var(--text-faint); }
.ac-failures { margin-top: 16px; }
.ac-failures h3 span { color: var(--warn); }
.ac-failures ul { list-style: none; margin: 0; padding: 0; }
.ac-failures li { display: grid; grid-template-columns: 58px minmax(100px, .7fr) minmax(0, 2fr) auto; gap: 8px; align-items: baseline; padding: 5px 0; border-top: 1px solid var(--border); font-size: 11px; min-width: 0; }
.ac-failures li > * { min-width: 0; overflow-wrap: anywhere; }
.ac-failures b { color: var(--warn); }
.ac-failures a { color: var(--accent); text-decoration: none; }
.ac-failures details { margin-top: 8px; }
.ac-failures summary { color: var(--accent); cursor: pointer; font-size: 11px; }
@media (max-width: 1100px) { .ac-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); } .ac-metrics > div:nth-child(3) { border-right: 0; } .ac-metrics > div:nth-child(-n+3) { border-bottom: 1px solid var(--border); } }
@media (max-width: 700px) { .acceptance { padding: 14px 12px; } .ac-head { flex-wrap: wrap; } .ac-actions { width: 100%; } .ac-actions button { min-height: 44px; } .ac-sources a, .ac-failures a { display: inline-flex; align-items: center; min-height: 44px; } .ac-detail { grid-template-columns: 1fr; gap: 17px; } .ac-failures li { grid-template-columns: 55px minmax(0, 1fr) auto; } .ac-failures li > span:nth-child(3) { grid-column: 2 / 4; } }
@media (max-width: 450px) { .ac-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .ac-metrics > div:nth-child(3) { border-right: 1px solid var(--border); } .ac-metrics > div:nth-child(even) { border-right: 0; } .ac-metrics > div:nth-child(4) { border-bottom: 1px solid var(--border); } .ac-sources { grid-template-columns: 1fr; } }
</style>
