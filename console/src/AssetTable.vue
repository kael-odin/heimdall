<script setup>
/**
 * AssetTable — 资产清单（服务端筛选 + 截断预览 + 孤儿回收）
 *
 * 筛选在**服务端**做（/api/assets/:host?q=&ext=&page=&minSize=&orphan=&sort=&limit=），
 * 不是本地过滤 —— 一个已克隆站点的资产数以万计，全量传回浏览器再筛会拖垮页面。
 * 所以本组件每次改筛选条件都重新请求，并用 250ms 防抖合并连续输入。
 *
 * 孤儿回收的判据与 CAS 回收不同，不要混：
 *   · 这里回收的是 **clone 内已无引用的文件**（assets/styles 目录下）
 *   · CAS 回收（见 StorageCard）判的是 nlink=1 的内容寻址副本
 * 前者是"这个站不用了"，后者是"没有任何站用"。
 */
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { API, apiHeaders, artifactOpenUrl, tokenOf } from './api.js';
import AuthImage from './AuthImage.vue';

const props = defineProps({
  host: { type: String, default: '' },
});

const info = ref(null);
const reclaimResult = ref('');
const filter = reactive({ q: '', ext: '', page: '', minSize: false, orphan: false, sort: 'size' });

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico', '.bmp']);
const isImg = (ext) => IMG_EXT.has(ext);

const exts = computed(() => Object.entries(info.value?.byExt ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 14));
const pages = computed(() => Object.entries(info.value?.byPage ?? {}).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 60));
// 服务端已完成过滤与排序，这里不再二次处理
const rows = computed(() => info.value?.items ?? []);

let timer = null;
async function load() {
  if (!props.host) return;
  try {
    const p = new URLSearchParams({ limit: '200', sort: filter.sort });
    if (filter.q.trim()) p.set('q', filter.q.trim());
    if (filter.ext) p.set('ext', filter.ext);
    if (filter.page) p.set('page', filter.page);
    if (filter.minSize) p.set('minSize', String(100 * 1024));
    if (filter.orphan) p.set('orphan', '1');
    const r = await fetch(API + '/api/assets/' + encodeURIComponent(props.host) + '?' + p.toString(), { headers: apiHeaders() });
    if (r.ok) info.value = await r.json();
  } catch { /* 资产清单是附加信息，取不到不影响主流程 */ }
}

async function runReclaim(apply) {
  const n = info.value?.orphans?.count ?? 0;
  if (apply && !window.confirm(`确认回收 ${n} 个孤儿资产？此操作会删除文件（仅限 clone/assets|styles）。`)) return;
  reclaimResult.value = apply ? '回收执行中…' : '回收预览中…';
  try {
    const r = await fetch(API + '/api/reclaim', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ host: props.host, apply: !!apply }) });
    const j = await r.json();
    if (j.error) { reclaimResult.value = '失败：' + j.error; return; }
    const s = j.summary;
    if (!s) { reclaimResult.value = '无结果'; return; }
    const mb = (v) => (v / 1048576).toFixed(1) + 'MB';
    // 字段名必须和 reclaim-orphans.mjs 的 @@RAWS@@ 一致：真正搬走的数量是 `moved` / `movedBytes`，
    // 载荷里**没有 `removed`** —— 以前写的是 `s.removed ?? 0`，于是无论回收了多少个，
    // 结果永远显示"已回收 0 个"（`?? 0` 把字段名写错这件事伪装成了"这次没回收到东西"）。
    // 另外：回滚过就不能说"已回收" —— 那是把失败报成成功。
    if (!apply) {
      reclaimResult.value = `可回收 ${s.count} 个 / ${mb(s.bytes)}`;
    } else if (s.rolledBack) {
      reclaimResult.value = `已回滚（回收 ${s.moved ?? 0} 个后资产缺口反而变大，文件已放回）`;
    } else {
      reclaimResult.value = `已回收 ${s.moved ?? 0} 个 / ${mb(s.movedBytes ?? s.bytes)}`;
    }
    reclaimResult.value += (s.after ? `；剩余孤儿 ${s.after.orphans} / ${mb(s.after.orphanBytes)}` : '');
    if (apply) { filter.orphan = false; load(); }
  } catch (e) { reclaimResult.value = '失败：' + String(e).slice(0, 80); }
}

watch(filter, () => { clearTimeout(timer); timer = setTimeout(load, 250); }, { deep: true });
watch(() => props.host, () => { info.value = null; reclaimResult.value = ''; load(); });
onMounted(load);
</script>

<template>
  <div class="report-card report-wide surface">
    <h3>资产清单 <span class="wv-stat" v-if="info">共 {{ info.count }} 个文件 · {{ (info.totalBytes / 1024 / 1024).toFixed(1) }}MB · 匹配 {{ info.filtered ?? info.count }} · 显示 {{ rows.length }}<template v-if="info.orphans"> · 孤儿 {{ info.orphans.count }}（{{ (info.orphans.bytes / 1048576).toFixed(1) }}MB）</template><template v-if="info.ledger"> · 去重节省 {{ (info.ledger.bytesSaved / 1048576).toFixed(0) }}MB（重复 {{ info.ledger.duplicates }}）</template></span></h3>
    <div class="asset-controls" v-if="info?.items?.length">
      <input v-model="filter.q" aria-label="搜索资产路径或原始 URL" placeholder="搜索路径…" spellcheck="false" />
      <select v-model="filter.ext" aria-label="按文件类型筛选"><option value="">全部类型</option><option v-for="e in exts" :key="e[0]" :value="e[0]">{{ e[0] || '(none)' }} ({{ e[1] }})</option></select>
      <select v-model="filter.page" aria-label="按页面筛选"><option value="">全部页面</option><option v-for="p in pages" :key="p[0]" :value="p[0]">{{ p[0] }} ({{ p[1].count }})</option></select>
      <select v-model="filter.sort" aria-label="排序方式"><option value="size">按体积</option><option value="name">按路径</option><option value="page">按页面</option></select>
      <label class="sw"><input type="checkbox" v-model="filter.minSize" /><span>≥100KB</span></label>
      <label class="sw"><input type="checkbox" v-model="filter.orphan" /><span>仅孤儿</span></label>
      <button v-if="info?.orphans?.count" class="wv-primary" @click="runReclaim(false)">回收预览</button>
      <button v-if="info?.orphans?.count" class="danger" @click="runReclaim(true)">执行回收</button>
    </div>
    <div class="asset-table" v-if="rows.length">
      <div class="asset-row asset-th"><span>页面</span><span>类型</span><span>大小</span><span>路径</span><span>预览</span></div>
      <div class="asset-row" v-for="a in rows.slice(0, 200)" :key="a.path">
        <span>{{ a.page }}</span><span>{{ a.ext || '—' }}</span><span>{{ (a.size / 1024).toFixed(0) }}KB</span>
        <span class="asset-path" :title="a.src ? (a.src + '  ←  ' + a.path) : a.path">{{ a.path }}</span>
        <span class="asset-actions"><a :href="artifactOpenUrl(a.url)" target="_blank" rel="noopener" :aria-label="'在新标签打开资产 ' + a.path"><AuthImage v-if="isImg(a.ext)" class="asset-thumb" :src="a.url" :token="tokenOf()" loading="lazy" alt="" /><template v-else>打开</template></a><a v-if="a.src" :href="a.src" target="_blank" rel="noopener" class="asset-src">原站</a></span>
      </div>
    </div>
    <p class="score-note" v-if="reclaimResult" style="margin:6px 0">{{ reclaimResult }}</p>
    <p v-else-if="info?.items?.length">无匹配资产</p>
    <p v-else>暂无资产数据（先克隆页面）</p>
  </div>
</template>
