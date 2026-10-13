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
import { API, apiHeaders, tokenOf } from './api.js';
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
    // 回收在引擎侧的子进程里跑（遍历整个 CAS，不能占请求线程），结果通过 cas-gc 事件回来
    const q = tokenOf();
    const es = new EventSource(`${API}/api/events?task=${j.taskId}${q ? '&token=' + encodeURIComponent(q) : ''}`);
    const finish = () => { try { es.close(); } catch {} gcing.value = false; };
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.kind === 'cas-gc') {
        gcResult.value = ev;
        gcConfirm.value = false;
        emit('ok', ev.apply ? `已回收 ${fmtBytes(ev.freed ?? 0)} CAS 孤儿` : `可回收 ${fmtBytes(ev.orphanBytes ?? 0)} CAS 孤儿`);
        finish();
        load(false);   // 引擎已在后台重新盘点，这里的数字会随后刷新
      } else if (ev.kind === 'exit') {
        if (ev.status !== 'done' && !gcResult.value) error.value = '回收任务中断';
        finish();
      }
    };
    es.onerror = () => { finish(); };
  } catch (e) { error.value = String(e).replace(/^Error:\s*/, ''); gcing.value = false; }
}

// ---------- 交付包保留策略 ----------
const plan = ref(null);
const planLoading = ref(false);
const planGcing = ref(false);
const planConfirm = ref(false);
const planError = ref('');

async function fetchPlanOnce() {
  const r = await fetch(API + '/api/deliver/plan', { headers: apiHeaders() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

async function loadPlan(force = false) {
  planLoading.value = true; planError.value = ''; stopPoll();
  const deadline = Date.now() + 60_000;
  const loop = () => {
    poll = setTimeout(async () => {
      try {
        const n = await fetchPlanOnce();
        if (!n.pending) { plan.value = n; planLoading.value = false; stopPoll(); return; }
      } catch { /* 下一轮再试 */ }
      if (Date.now() > deadline) { planError.value = '盘点超时（60 秒内未完成）'; planLoading.value = false; stopPoll(); return; }
      loop();
    }, 1500);
  };
  try {
    const s = force
      ? await fetch(API + '/api/deliver/prune', { method: 'POST', headers: apiHeaders(), body: JSON.stringify({ apply: false }) }).then(r => r.json().catch(() => ({})))
      : await fetchPlanOnce();
    if (force) { loop(); return; }
    plan.value = s.pending ? null : s;
    if (s.pending || s.scanning) { loop(); return; }
  } catch (e) { planError.value = String(e).replace(/^Error:\s*/, ''); }
  planLoading.value = false;
}

async function runPrune() {
  if (planGcing.value) return;
  if (!planConfirm.value) { planConfirm.value = true; return; }
  planGcing.value = true; planError.value = '';
  try {
    const r = await fetch(API + '/api/deliver/prune', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ apply: true, confirm: 'HEIMDALL_DELIVER_PRUNE' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    planConfirm.value = false;
    emit('ok', `交付包清理已启动（后台执行，完成后数字自动刷新）`);
    setTimeout(() => loadPlan(false), 2500);
  } catch (e) { planError.value = String(e).replace(/^Error:\s*/, ''); }
  finally { planGcing.value = false; }
}

onMounted(() => { load(false); loadPlan(false); });
onBeforeUnmount(stopPoll);
</script>

<template>
  <div class="report-card report-wide storage-card surface">
    <div class="storage-head">
      <div><h3>存储治理</h3><p>站点、CAS 与交付包的实际磁盘占用；删除站点后可安全回收无引用 CAS。</p></div>
      <button @click="load(true)" :disabled="loading">{{ loading ? '扫描中…' : '重新扫描' }}</button>
    </div>
    <div v-if="loading && !info" class="storage-empty" role="status" aria-live="polite">正在后台盘点磁盘（引擎侧子进程遍历，约 10 秒；期间其他操作不受影响）…</div>
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
          <!-- 字段名与 cas-gc.mjs 的 emit 一致：是 `apply`（不是 `applied`）、失败数是 `failed`（没有 `skipped`）。
               写错字段名的后果很有迷惑性：条件永远为假，于是**真回收完了仍显示"预览：可回收 …"**，
               看起来像按钮没生效。本文件第 88 行的 toast 一直用的是 `ev.apply`，两处曾经不一致。 -->
          <p class="storage-note" v-if="gcResult" role="status" aria-live="polite">{{ gcResult.apply ? `已回收 ${fmtBytes(gcResult.freed || 0)}，失败 ${gcResult.failed || 0}` : `预览：可回收 ${fmtBytes(gcResult.orphanBytes || 0)}` }}</p>
          <p class="storage-note">安全判据：CAS 文件只有自身链接（nlink=1）时才会进入候选；仍被站点使用的硬链接不会删除。</p>
        </div>
      </div>
    </template>
    <div v-else class="storage-empty">尚未盘点。点击“重新扫描”获取当前占用。</div>

    <!-- 交付包保留策略：deliverable/ 每次导出留一个目录，此前没有任何清理机制 -->
    <div class="storage-deliver">
      <div class="storage-subhead">交付包保留</div>
      <div v-if="planLoading && !plan" class="storage-empty" role="status" aria-live="polite">正在盘点交付包（后台子进程遍历）…</div>
      <div v-else-if="planError" class="storage-error">{{ planError }} <button @click="loadPlan(true)">重试</button></div>
      <template v-else-if="plan">
        <p>
          共 {{ plan.total?.bundles ?? 0 }} 个包 · {{ fmtBytes(plan.total?.bytes ?? 0) }}。
          策略：每个「站点 + 类型」保留最近 {{ plan.keep }} 个。
        </p>
        <div class="deliver-groups">
          <div class="deliver-group" v-for="g in plan.groups" :key="g.key">
            <span class="dg-key">{{ g.key }}</span>
            <span class="dg-n">{{ g.count }} 个</span>
            <span class="dg-keep" :title="g.keep.join('\n')">保留 {{ g.keep.length }}</span>
            <span class="dg-remove" :class="{ bad: g.remove.length }" :title="g.remove.join('\n')">{{ g.remove.length ? '待删 ' + g.remove.length : '无需清理' }}</span>
          </div>
        </div>
        <p class="storage-note" v-if="plan.unclassified?.length">
          <b class="warn-text">{{ plan.unclassified.length }} 个无法归类的包不会自动删除</b>
          （命名不含日期，可能是手工产物）：
          <span v-for="(u, i) in plan.unclassified" :key="u.name">{{ i ? ' · ' : '' }}{{ u.name }}（{{ fmtBytes(u.bytes) }}）</span>
        </p>
        <div class="storage-buttons">
          <button @click="loadPlan(true)" :disabled="planLoading">{{ planLoading ? '盘点中…' : '重新盘点' }}</button>
          <button class="danger" @click="runPrune" :disabled="planGcing || !plan.total?.reclaimable">
            {{ planConfirm ? '再次点击确认删除' : (plan.total?.reclaimable ? `执行清理（释放约 ${fmtBytes(plan.total.reclaimable)}）` : '无可清理') }}
          </button>
          <button v-if="planConfirm" @click="planConfirm = false">取消</button>
        </div>
        <p class="storage-note">
          释放量按硬链接算（nlink=1 才真的省）：交付包里的文件与 workspace 克隆共享 inode，删掉一个链接并不释放空间。
          无法归类的包永不自动删除。
        </p>
      </template>
      <div v-else class="storage-empty">尚未盘点交付包。</div>
    </div>
  </div>
</template>
