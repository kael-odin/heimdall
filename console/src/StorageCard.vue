<script setup>
/**
 * StorageCard — 存储治理（磁盘占用 + CAS 孤儿回收）
 *
 * 整个「盘点 → 轮询 → 回收 → 再盘点」的状态机都在本组件内。
 * 抽出来的理由不只是行数：这段逻辑有三个容易踩的坑，集中在一处才好写清楚 ——
 *
 *  ① 盘点在引擎侧走**子进程**（同步遍历会冻住事件循环 12 秒，所有 API 一起卡），
 *     所以 GET /api/storage 可能返回 { pending:true }（从没盘过）
 *     或 { scanning:true }（正在盘）—— 两者都不是"失败"，必须轮询而不是报错。
 *  ② 轮询必须有截止时间。没有的话引擎异常时前端会永远显示"扫描中"。
 *  ③ 真回收要二次确认（点两次），且回收后引擎会在后台重新盘点，
 *     所以这里不能直接把数字改掉，要重新拉一次。
 *
 * 存储是**全局**的，不按站点 —— 所以本组件不接收 host。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { API, apiHeaders } from './api.js';
import { fmtBytes } from './format.js';

const emit = defineEmits(['ok']);

const info = ref(null);
const loading = ref(false);
const error = ref('');
const gcing = ref(false);
const gcResult = ref(null);
const gcConfirm = ref(false);

let poll = null;
function stopPoll() { if (poll) { clearTimeout(poll); poll = null; } }

async function fetchOnce() {
  const r = await fetch(API + '/api/storage', { headers: apiHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

/** @param {boolean} force true = 让引擎重新盘一次（否则只读已有结果） */
async function load(force = false) {
  loading.value = true; error.value = ''; stopPoll();
  const deadline = Date.now() + 40_000;
  const loop = () => {
    poll = setTimeout(async () => {
      try {
        const n = await fetchOnce();
        if (!n.pending) { info.value = n; loading.value = false; stopPoll(); return; }
      } catch { /* 下一轮再试 */ }
      if (Date.now() > deadline) { error.value = '盘点超时（40 秒内未完成）'; loading.value = false; stopPoll(); return; }
      loop();
    }, 1500);
  };
  try {
    if (force) {
      const r = await fetch(API + '/api/storage/scan', { method: 'POST', headers: apiHeaders() });
      const j = await r.json().catch(() => ({}));
      if (r.status !== 202 && !r.ok) throw new Error(j.error || ('HTTP ' + r.status));
      loop();
      return;
    }
    const s = await fetchOnce();
    info.value = s.pending ? null : s;
    if (s.pending || s.scanning) { loop(); return; }
  } catch (e) { error.value = String(e).replace(/^Error:\s*/, ''); }
  loading.value = false;
}

async function runGc(apply = false) {
  if (gcing.value) return;
  // 删除是不可逆的，所以真回收要点两次
  if (apply && !gcConfirm.value) { gcConfirm.value = true; return; }
  gcing.value = true; error.value = '';
  try {
    const body = apply ? { apply: true, confirm: 'HEIMDALL_CAS_GC' } : { apply: false };
    const r = await fetch(API + '/api/storage/gc', { method: 'POST', headers: apiHeaders(), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    gcResult.value = j;
    if (j.storage) info.value = j.storage;
    gcConfirm.value = false;
    emit('ok', apply ? `已回收 ${fmtBytes(j.freed ?? 0)} CAS 孤儿` : `可回收 ${fmtBytes(j.orphanBytes ?? 0)} CAS 孤儿`);
    load(false);   // 引擎已在后台重新盘点，这里的数字会随后刷新
  } catch (e) { error.value = String(e).replace(/^Error:\s*/, ''); }
  finally { gcing.value = false; }
}

onMounted(() => load(false));
onBeforeUnmount(stopPoll);
</script>

<template>
  <div class="report-card report-wide storage-card surface">
    <div class="storage-head">
      <div><h3>存储治理</h3><p>站点、CAS 与交付包的实际磁盘占用；删除站点后可安全回收无引用 CAS。</p></div>
      <button @click="load(true)" :disabled="loading">{{ loading ? '扫描中…' : '重新扫描' }}</button>
    </div>
    <div v-if="loading && !info" class="storage-empty">正在后台盘点磁盘（引擎侧子进程遍历，约 10 秒；期间其他操作不受影响）…</div>
    <div v-else-if="error" class="storage-error">{{ error }} <button @click="load(true)">重试</button></div>
    <template v-else-if="info">
      <div class="storage-kpis">
        <div><b>{{ fmtBytes(info.totals?.uniqueBytes ?? 0) }}</b><span>实际占用</span></div>
        <div><b>{{ fmtBytes(info.totals?.logicalBytes ?? 0) }}</b><span>逻辑体积</span></div>
        <div><b>{{ fmtBytes(info.cas?.orphanBytes ?? 0) }}</b><span>可回收 CAS</span></div>
        <div><b>{{ info.sites?.length ?? 0 }}</b><span>站点</span></div>
      </div>
      <div class="storage-body">
        <div class="storage-sites">
          <div class="storage-subhead">站点占用</div>
          <div class="storage-site-row" v-for="s in (info.sites || []).slice(0, 8)" :key="s.host">
            <span>{{ s.host }}</span><i><em :style="{ width: Math.min(100, (s.logicalBytes / Math.max(1, info.sites?.[0]?.logicalBytes || 1)) * 100) + '%' }"></em></i><b>{{ fmtBytes(s.logicalBytes) }}</b><small>{{ s.files }} 文件</small>
          </div>
          <div class="storage-empty" v-if="!info.sites?.length">暂无站点产物</div>
        </div>
        <div class="storage-actions">
          <div class="storage-subhead">CAS 回收</div>
          <p v-if="info.cas?.orphanFiles">检测到 <b class="warn-text">{{ info.cas.orphanFiles }} 个</b> 无引用文件，可释放 <b class="warn-text">{{ fmtBytes(info.cas.orphanBytes) }}</b>。</p>
          <p v-else>CAS 没有检测到可回收孤儿。</p>
          <div class="storage-buttons">
            <button @click="runGc(false)" :disabled="gcing">预览回收</button>
            <button class="danger" @click="runGc(true)" :disabled="gcing || !info.cas?.orphanFiles">{{ gcConfirm ? '再次点击确认回收' : '执行回收' }}</button>
            <button v-if="gcConfirm" @click="gcConfirm = false">取消</button>
          </div>
          <p class="storage-note" v-if="gcResult">{{ gcResult.applied ? `已回收 ${fmtBytes(gcResult.freed || 0)}，跳过 ${gcResult.skipped || 0}` : `预览：可回收 ${fmtBytes(gcResult.orphanBytes || 0)}` }}</p>
          <p class="storage-note">安全判据：CAS 文件只有自身链接（nlink=1）时才会进入候选；仍被站点使用的硬链接不会删除。</p>
        </div>
      </div>
    </template>
    <div v-else class="storage-empty">尚未盘点。点击“重新扫描”获取当前占用。</div>
  </div>
</template>
