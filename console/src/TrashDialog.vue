<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';
import { API, apiHeaders } from './api.js';

const emit = defineEmits(['close', 'restored']);
const dialog = ref(null);
const entries = ref([]);
const purged = ref([]);
const summary = ref(null);
const loading = ref(false);
const busyId = ref('');
const previewId = ref('');
const previews = ref({});
const confirmIds = ref({});
const acceptSameFilesystem = ref({});
const error = ref('');
const status = ref('');
const available = computed(() => entries.value.filter(entry => ['ready', 'prepared'].includes(entry.state)));
const REFRESH_INTERVAL_MS = 1500;
const REFRESH_WINDOW_MS = 30_000;
let refreshUntil = 0;
let refreshTimer = null;
let loadGeneration = 0;
let disposed = false;

async function load({ silent = false, reportError = !silent } = {}) {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  const generation = ++loadGeneration;
  if (!silent) loading.value = true;
  if (reportError) error.value = '';
  try {
    const response = await fetch(`${API}/api/trash`, { headers: apiHeaders(), credentials: 'omit' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (disposed || generation !== loadGeneration) return;
    entries.value = Array.isArray(body.entries) ? body.entries : [];
    purged.value = Array.isArray(body.purged) ? body.purged : [];
    summary.value = body.summary ?? null;
    if (summary.value && (summary.value.pending || summary.value.stale || summary.value.scanning)
        && Date.now() + REFRESH_INTERVAL_MS <= refreshUntil) {
      refreshTimer = setTimeout(() => load({ silent: true }), REFRESH_INTERVAL_MS);
    }
  } catch (cause) {
    if (!disposed && generation === loadGeneration && reportError) {
      error.value = `读取失败：${String(cause.message ?? cause)}`;
    }
  } finally {
    if (!disposed && generation === loadGeneration && !silent) loading.value = false;
  }
}

function refreshCapacity() {
  refreshUntil = Date.now() + REFRESH_WINDOW_MS;
  load({ silent: true, reportError: true });
}

async function preview(entry) {
  previewId.value = entry.id;
  error.value = '';
  try {
    const response = await fetch(`${API}/api/trash/${encodeURIComponent(entry.id)}/preview`, {
      headers: apiHeaders(), credentials: 'omit',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    previews.value = { ...previews.value, [entry.id]: body };
  } catch (cause) { error.value = `预览失败：${String(cause.message ?? cause)}`; }
  finally { previewId.value = ''; }
}

async function purge(entry) {
  const inspected = previews.value[entry.id];
  if (!inspected?.purgeable || confirmIds.value[entry.id] !== entry.id) return;
  busyId.value = entry.id;
  error.value = '';
  status.value = '';
  try {
    const response = await fetch(`${API}/api/trash/${encodeURIComponent(entry.id)}`, {
      method: 'DELETE', headers: apiHeaders(), credentials: 'omit',
      body: JSON.stringify({ confirmId: entry.id, revision: inspected.revision,
        acceptSameFilesystem: acceptSameFilesystem.value[entry.id] === true }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    status.value = inspected.payloadPresent
      ? `已清理隔离副本 ${entry.id}；外部备份与本机清理收据仍保留。`
      : `已清理记录 ${entry.id}；本机保留清理收据。`;
    delete previews.value[entry.id];
    delete confirmIds.value[entry.id];
    refreshUntil = Date.now() + REFRESH_WINDOW_MS;
    await load({ silent: true, reportError: true });
  } catch (cause) { error.value = `清理失败：${String(cause.message ?? cause)}`; }
  finally { busyId.value = ''; }
}

async function backup(entry) {
  const inspected = previews.value[entry.id];
  if (!inspected) return;
  busyId.value = entry.id;
  error.value = '';
  status.value = '';
  try {
    const response = await fetch(`${API}/api/trash/${encodeURIComponent(entry.id)}/backup`, {
      method: 'POST', headers: apiHeaders(), credentials: 'omit',
      body: JSON.stringify({ revision: inspected.revision }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    status.value = `已逐文件校验备份：${body.directory}`;
    await preview(entry);
  } catch (cause) { error.value = `备份失败：${String(cause.message ?? cause)}`; }
  finally { busyId.value = ''; }
}

async function recover(entry) {
  if (confirmIds.value[entry.id] !== entry.id || !entry.backup?.available || entry.state !== 'purged') return;
  busyId.value = entry.id;
  error.value = '';
  status.value = '';
  try {
    const response = await fetch(`${API}/api/trash/${encodeURIComponent(entry.id)}/recover-backup`, {
      method: 'POST', headers: apiHeaders(), credentials: 'omit',
      body: JSON.stringify({ confirmId: entry.id, revision: entry.revision }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    status.value = `已从外部备份重建隔离条目 ${entry.id}；可继续恢复到工作区。`;
    delete confirmIds.value[entry.id];
    refreshUntil = Date.now() + REFRESH_WINDOW_MS;
    await load({ silent: true, reportError: true });
  } catch (cause) { error.value = `从备份重建失败：${String(cause.message ?? cause)}`; }
  finally { busyId.value = ''; }
}

async function restore(entry) {
  busyId.value = entry.id;
  error.value = '';
  status.value = '';
  try {
    const response = await fetch(`${API}/api/trash/${encodeURIComponent(entry.id)}/restore`, {
      method: 'POST', headers: apiHeaders(), credentials: 'omit', body: '{}',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (body.restored === false) status.value = '记录已结束，原目录未发生移动。';
    else {
      status.value = `已恢复 ${entry.kind === 'site' ? '站点' : '页面'} ${entry.host}${entry.kind === 'page' ? '/' + entry.name : ''}`;
      emit('restored', body);
    }
    delete previews.value[entry.id];
    refreshUntil = Date.now() + REFRESH_WINDOW_MS;
    await load({ silent: true, reportError: true });
  } catch (cause) { error.value = `恢复失败：${String(cause.message ?? cause)}`; }
  finally { busyId.value = ''; }
}

function label(entry) {
  return entry.kind === 'site' ? entry.host : `${entry.host} / ${entry.name}`;
}

function dateLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
}

function bytesLabel(value) {
  if (!Number.isFinite(value)) return '待盘点';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

onMounted(() => { dialog.value?.showModal(); refreshUntil = Date.now() + REFRESH_WINDOW_MS; load(); });
onBeforeUnmount(() => {
  disposed = true;
  loadGeneration++;
  if (refreshTimer) clearTimeout(refreshTimer);
  if (dialog.value?.open) dialog.value.close();
});
</script>

<template>
  <dialog ref="dialog" class="trash-dialog" aria-labelledby="trash-title" @cancel.prevent="emit('close')">
    <div class="trash-header">
      <h2 id="trash-title">最近删除</h2>
      <button class="trash-close" type="button" @click="emit('close')" aria-label="关闭最近删除" title="关闭"><Icon name="close" decorative /></button>
    </div>
    <p class="trash-note">隔离文件持续保留；清理可恢复条目前需配置外部备份目录并通过哈希校验。恢复不会覆盖已重建的站点或后来修改的星图。</p>
    <div class="trash-body">
      <div v-if="summary" class="trash-summary" :class="{ 'trash-summary-warn': summary.warning }" role="status">
        <div class="trash-summary-head">
          <strong>隔离区占用 {{ bytesLabel(summary.uniqueBytes) }}</strong>
          <button type="button" title="刷新容量" aria-label="刷新容量" @click="refreshCapacity"><Icon name="refresh" decorative /></button>
        </div>
        <span v-if="summary.warning">已达到容量告警阈值 {{ bytesLabel(summary.warningBytes) }}，请先导出并核验备份，再处理条目。</span>
        <span v-else-if="summary.pending || summary.stale || summary.scanning">容量盘点正在更新。</span>
        <span v-else>按隔离区内硬链接去重；可能与其它目录共享，不等于清理后可释放空间。不会自动过期或清空。</span>
      </div>
      <p v-if="loading" role="status">正在读取…</p>
      <p v-else-if="!entries.length && !purged.length && !error" class="trash-empty">没有最近删除的站点或页面。</p>
      <ul v-else class="trash-list">
        <li v-for="entry in entries" :key="entry.id" class="trash-row">
          <div class="trash-main">
            <strong :title="label(entry)">{{ label(entry) }}</strong>
            <span>{{ entry.kind === 'site' ? '整站' : '单页' }} · {{ dateLabel(entry.createdAt) }} · {{ available.some(item => item.id === entry.id) ? '可恢复' : '已结束' }}<template v-if="entry.state === 'prepared'"> · 待确认记录</template></span>
            <code :title="entry.id">{{ entry.id }}</code>
          </div>
          <div class="trash-actions">
            <button type="button" :disabled="!!busyId || !!previewId" @click="preview(entry)">{{ previewId === entry.id ? '读取中…' : '预览' }}</button>
            <button v-if="available.some(item => item.id === entry.id)" type="button" :disabled="!!busyId || !!previewId" @click="restore(entry)">{{ busyId === entry.id ? '恢复中…' : '恢复' }}</button>
          </div>
          <div v-if="previews[entry.id]" class="trash-preview">
            <span>{{ bytesLabel(previews[entry.id].logicalBytes) }} · {{ previews[entry.id].files }} 文件</span>
            <template v-if="!previews[entry.id].purgeable">
              <span>{{ previews[entry.id].reason }}</span>
              <span v-if="!previews[entry.id].backup?.configured">请预先创建数据目录之外的备份目录，并在服务端将其绝对路径设为 HEIMDALL_TRASH_BACKUP_DIR。</span>
              <span v-else-if="previews[entry.id].backup?.reason">备份状态：{{ previews[entry.id].backup.reason }}</span>
              <button v-if="entry.state !== 'prepared' && previews[entry.id].backup?.configured" type="button" :disabled="!!busyId || previews[entry.id].backup?.reason === 'trash backup root must exist'" @click="backup(entry)">创建并核验备份</button>
            </template>
            <template v-else>
              <span v-if="previews[entry.id].backup?.verified">外部备份已核验：{{ previews[entry.id].backup.directory }}</span>
              <label v-if="previews[entry.id].backup?.sameFilesystem" class="trash-risk"><input v-model="acceptSameFilesystem[entry.id]" type="checkbox" /> 备份与数据目录在同一文件系统，无法抵御单盘故障；我接受此风险。</label>
              <label :for="'purge-' + entry.id">输入完整 ID 以{{ previews[entry.id].payloadPresent ? '清理隔离副本' : '清理已结束记录' }}</label>
              <input :id="'purge-' + entry.id" v-model="confirmIds[entry.id]" type="text" autocomplete="off" spellcheck="false" />
              <button type="button" :disabled="!!busyId || confirmIds[entry.id] !== entry.id || (previews[entry.id].backup?.sameFilesystem && !acceptSameFilesystem[entry.id])" @click="purge(entry)">{{ previews[entry.id].payloadPresent ? '清理隔离副本' : '永久清理记录' }}</button>
            </template>
          </div>
        </li>
      </ul>
      <section v-if="purged.length" class="trash-purged">
        <h3>已清理的隔离副本</h3>
        <ul class="trash-list">
          <li v-for="entry in purged" :key="entry.id" class="trash-row">
            <div class="trash-main"><strong>{{ label(entry) }}</strong><span>{{ dateLabel(entry.createdAt) }} · {{ entry.state === 'needs-review' ? '清理中断，需人工检查' : entry.backup.available ? '备份待完整核验' : '备份不可用' }}</span><code>{{ entry.id }}</code></div>
            <div class="trash-preview">
              <span v-if="entry.backup.available">{{ entry.backup.directory }}</span>
              <span v-if="entry.backup.sameFilesystem">同一文件系统，不能抵御单盘故障。</span>
              <span v-if="!entry.backup.available">{{ entry.backup.reason }}</span>
              <span v-if="entry.state === 'needs-review'">{{ entry.reconciliation }}；不会自动清理或覆盖暂存文件。</span>
              <template v-if="entry.backup.available && entry.state === 'purged'">
                <label :for="'recover-' + entry.id">输入完整 ID 从备份重建隔离条目</label>
                <input :id="'recover-' + entry.id" v-model="confirmIds[entry.id]" type="text" autocomplete="off" spellcheck="false" />
                <button type="button" :disabled="!!busyId || confirmIds[entry.id] !== entry.id" @click="recover(entry)">从备份重建</button>
              </template>
            </div>
          </li>
        </ul>
      </section>
      <p v-if="error" class="trash-error" role="alert">{{ error }}</p>
      <p v-if="status" class="trash-status" role="status">{{ status }}</p>
    </div>
  </dialog>
</template>

<style scoped>
.trash-dialog {
  width: min(560px, calc(100vw - 32px)); max-height: min(80vh, 680px); padding: 0; margin: auto;
  border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface); color: var(--text);
}
.trash-dialog::backdrop { background: color-mix(in srgb, var(--bg) 72%, transparent); }
.trash-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.trash-header h2 { margin: 0; font-size: 17px; font-weight: 600; }
.trash-close { width: 44px; height: 44px; display: grid; place-items: center; border: 0; background: transparent; color: var(--text-dim); cursor: pointer; font-size: 19px; }
.trash-close:hover { color: var(--text); }
.trash-note { margin: 0; padding: 12px 18px; color: var(--text-dim); font-size: 12px; line-height: 1.5; border-bottom: 1px solid var(--border); }
.trash-body { padding: 10px 18px 18px; max-height: 52vh; overflow: auto; }
.trash-summary { display: flex; flex-direction: column; gap: 3px; margin: 0 0 10px; padding: 9px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); color: var(--text-dim); font-size: 11px; line-height: 1.4; }
.trash-summary strong { color: var(--text); font-size: 12px; }
.trash-summary-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.trash-summary-head button { flex: none; width: 44px; height: 44px; display: grid; place-items: center; border: 0; background: transparent; color: var(--text-dim); cursor: pointer; font-size: 16px; }
.trash-summary-head button:hover { color: var(--text); }
.trash-summary-warn { border-color: var(--bad); }
.trash-summary-warn strong, .trash-summary-warn span { color: var(--bad); }
.trash-empty { color: var(--text-dim); font-size: 13px; }
.trash-list { list-style: none; margin: 0; padding: 0; }
.trash-row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; min-height: 60px; border-bottom: 1px solid var(--border); }
.trash-row:last-child { border-bottom: 0; }
.trash-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.trash-main strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.trash-main span { color: var(--text-dim); font-size: 11px; }
.trash-main code { color: var(--text-dim); font-size: 10px; word-break: break-all; }
.trash-actions { display: flex; gap: 8px; }
.trash-row button { min-width: 58px; min-height: 44px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text); cursor: pointer; }
.trash-row button:hover:enabled { border-color: var(--accent); color: var(--accent); }
.trash-row button:disabled { opacity: .5; cursor: default; }
.trash-error, .trash-status { font-size: 12px; line-height: 1.5; }
.trash-error { color: var(--bad); }
.trash-status { color: var(--ok); }
.trash-preview { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--text-dim); font-size: 11px; padding: 0 0 8px; }
.trash-preview label { flex-basis: 100%; }
.trash-preview input { flex: 1; min-width: 0; height: 36px; padding: 0 7px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--surface-2); color: var(--text); font: inherit; }
.trash-preview .trash-risk { display: flex; align-items: center; gap: 8px; line-height: 1.5; }
.trash-preview .trash-risk input { flex: none; width: 16px; height: 16px; }
.trash-purged { margin-top: 18px; border-top: 1px solid var(--border); }
.trash-purged h3 { margin: 12px 0 5px; font-size: 13px; font-weight: 600; }
</style>
