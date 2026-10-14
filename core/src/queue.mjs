/**
 * queue — 全站批量锻造（持久化队列 + 断点续跑 + 增量重跑 + 引擎并发槽）
 *
 * 读 atlas.json 节点（默认排除登录/法务页；--all-discovered 纳入全部有效同源页），构造 workspace/<host>/queue.json，
 * 逐页向 engine POST /api/forge（槽满自动等待），SSE 监听每页 exit 更新状态落盘。
 * 重跑自动跳过已完成页（clone/index.html + score.json 齐备即视为 done）。
 *
 * 增量模式（--incremental）：对已完成页问一句"源站变了没有"（Node fetch 取
 * 服务端 HTML 指纹，不起浏览器），没变的跳过、变了的重排。判据见 fingerprint.mjs。
 *
 * 用法: node src/queue.mjs <host> [--max 20|--all-discovered] [--force] [--incremental] [--missing-har] [--no-dedupe] [--json-events]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireArg } from './args.mjs';
import { loadProfile, queuePlan, sanitizeHost } from './site-profile.mjs';
import { sourceFingerprint, incrementalDecision, decisionNote } from './fingerprint.mjs';
import { appendHistory } from './seo/history.mjs';
import { WORKSPACE } from './paths.mjs';
import { readSiteOrigin } from './site-origin.mjs';
import { emit as emitRaw } from './emit.mjs';
import { canonUrl, createPageNameResolver } from './url-canon.mjs';
import { runScript } from './child-run.mjs';

const host = sanitizeHost(requireArg(process.argv[2], 'node src/queue.mjs <host> [--max N|--all-discovered] [--force] [--incremental] [--missing-har] [--no-dedupe]', '站点 host'));
const maxIdx = process.argv.indexOf('--max');
const ALL_DISCOVERED = process.argv.includes('--all-discovered');
if (ALL_DISCOVERED && process.argv.some(arg => arg === '--max' || arg.startsWith('--max='))) {
  console.error('[queue] --all-discovered 与 --max 不能同时使用：完整侦察范围不能再截断');
  process.exit(2);
}
const workspaceOrigin = readSiteOrigin(join(WORKSPACE, host));
const profileHost = workspaceOrigin ? new URL(workspaceOrigin).hostname.replace(/^www\./, '') : host;
const profile0 = loadProfile(profileHost);   // 站点配方仍按真实 hostname 选取
const PLAN = queuePlan(profile0, Number(process.env.HEIMDALL_QUEUE_WORKERS || process.env.HEIMDALL_FORGE_SLOTS || 2), { allDiscovered: ALL_DISCOVERED });
const MAX = maxIdx > -1 ? Number(process.argv[maxIdx + 1] ?? PLAN.maxPages) : PLAN.maxPages;
const FORCE = process.argv.includes('--force');       // 忽略已有产物，强制重锻
const INCREMENTAL = process.argv.includes('--incremental');   // 只重跑源站变了的页
const MISSING_HAR = process.argv.includes('--missing-har');   // 只重锻缺 network.har 的页（交互镜像离线补录）
const JSON_EVENTS = process.argv.includes('--json-events');    // 输出 @@EVENT@@ 行，供引擎 SSE 转发
const API = process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900';
const TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const HEADERS = { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-heimdall-token': TOKEN } : {}) };
const BASE = join(WORKSPACE, host);
const queuePath = join(BASE, 'queue.json');

/** 机器可读进度（引擎 SSE 用）；普通 CLI 跑时只是多几行带前缀的日志 */
const emit = JSON_EVENTS ? emitRaw : () => {};

const atlas = JSON.parse(readFileSync(join(BASE, 'recon', 'atlas.json'), 'utf8'));
if (!Array.isArray(atlas.nodes)) {
  console.error('[queue] 需要有效的 atlas.nodes 数组');
  process.exit(2);
}
let atlasOrigin = null;
try { if (atlas.origin) atlasOrigin = new URL(atlas.origin).origin; } catch {}
if (!workspaceOrigin || (atlas.origin && atlasOrigin !== workspaceOrigin)) {
  console.error('[queue] 无法确认 atlas 与站点工作区属于同一 origin');
  process.exit(2);
}
const engineName = createPageNameResolver(BASE);
const atlasRows = atlas.nodes
  .filter(n => ALL_DISCOVERED || !PLAN.excludeTypes.includes(n?.type))
  .map(n => ({ url: canonUrl(n?.url), type: n?.type }))
  .filter(n => n.url && /^https?:$/.test(new URL(n.url).protocol) && new URL(n.url).origin === workspaceOrigin);
const discoveredTargets = ALL_DISCOVERED ? new Set(atlasRows.map(n => n.url)) : null;
if (ALL_DISCOVERED && !discoveredTargets.size) {
  console.error('[queue] --all-discovered 的 atlas 没有有效同源页面');
  process.exit(2);
}

// ---------- 构造/载入队列 ----------
let queue;
let fresh = false;                      // 这次是新建的队列（--max 仍然生效）
if (existsSync(queuePath)) {
  queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  if (!Array.isArray(queue)) {
    console.error('[queue] 现有 queue.json 不是数组，已拒绝覆盖');
    process.exit(2);
  }
  if (queue.some(row => !row || typeof row !== 'object' || !canonUrl(row.url)
    || !['pending', 'queued', 'done', 'failed'].includes(row.status))) {
    console.error('[queue] 现有队列包含无效 URL 或状态行，已拒绝续跑和覆盖');
    process.exit(2);
  }
  if (queue.some(row => {
    const url = new URL(canonUrl(row.url));
    return !/^https?:$/.test(url.protocol) || url.origin !== workspaceOrigin;
  })) {
    console.error('[queue] 现有队列包含站外或非 HTTP URL，已拒绝续跑和覆盖');
    process.exit(2);
  }
  const knownUrls = new Set();
  queue = queue.filter(q => {
    const canonical = canonUrl(q.url);
    if (!canonical || knownUrls.has(canonical)) return false;
    knownUrls.add(canonical);
    q.url = canonical;
    const name = engineName(canonical);
    if (q.name !== name) { q.previousName = q.name; q.name = name; }
    return true;
  });
  console.log(`resume queue: ${queue.filter(q => q.status === 'done').length} done / ${queue.length} total`);
} else {
  fresh = true;
  const seen = new Set();
  queue = atlasRows
    .filter(n => { if (seen.has(n.url)) return false; seen.add(n.url); return true; })
    .map(n => ({ url: n.url, name: engineName(n.url), type: n.type, status: 'pending' }));
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  console.log(ALL_DISCOVERED
    ? `new queue: ${queue.length} pages (all-discovered; atlas ${atlas.nodes.length} nodes, ${discoveredTargets.size} valid same-origin URLs)`
    : `new queue: ${queue.length} pages (max ${MAX})`);
}

// ---------- 与 atlas 对齐 ----------
// 队列一旦落盘就再也没看过 atlas，于是"重新侦察发现了新页"这件事永远进不了队列 ——
// 全站克隆会一直停在第一次侦察的那批页上，而且**看起来像已经跑完了**。
// 这里把 atlas 里有、队列里没有的页补进来（按 url 排序，保证同样输入得到同样队列）。
// 注意 --max 只约束**新建**队列：已存在的队列代表"这就是我要的全部页面"，
// 补进来的页不该因为它而再被砍掉（那正是这个 bug 要修的东西）。
let synced = 0;
{
  const known = new Set(queue.map(q => q.url));
  const added = atlasRows
    .filter(n => !known.has(n.url) && (known.add(n.url), true))
    .map(n => ({ url: n.url, name: engineName(n.url), type: n.type, status: 'pending', addedBy: 'recon-sync' }))
    .sort((a, b) => a.url.localeCompare(b.url));
  if (added.length) {
    synced = added.length;
    queue.push(...added);
    console.log(`recon-sync: 侦察到 ${added.length} 个队列里没有的页 → 补入队列（共 ${queue.length}）`);
    for (const q of ALL_DISCOVERED ? added.slice(0, 20) : added) console.log(`  + ${q.name}`);
    if (ALL_DISCOVERED && added.length > 20) console.log(`  ...另有 ${added.length - 20} 页已补入`);
  }
}
if (ALL_DISCOVERED) {
  const priorExtras = queue.filter(q => !discoveredTargets.has(q.url)).length;
  console.log(`all-discovered: ${discoveredTargets.size} valid same-origin URLs / ${atlas.nodes.length} atlas nodes; ${synced} added; ${queue.length} queue rows${priorExtras ? ` (${priorExtras} retained from prior scope)` : ''}`);
}
// --max 在新队列上仍然生效：先与 atlas 对齐、再截断，顺序反了就等于没限制
if (fresh && !ALL_DISCOVERED && queue.length > MAX) {
  console.log(`--max ${MAX}: 队列从 ${queue.length} 截到 ${MAX}`);
  queue = queue.slice(0, MAX);
}

const hasProduct = (name) => existsSync(join(BASE, 'pages', name, 'clone', 'index.html')) && existsSync(join(BASE, 'pages', name, 'score.json'));
if (FORCE) for (const q of queue) q.status = 'pending';   // 强制重锻：全部重新排队
else if (MISSING_HAR) {
  for (const q of queue) {
    const har = join(BASE, 'pages', q.name, 'network.har');
    if (!existsSync(har)) q.status = 'pending';                                       // 缺 HAR → 补录
    else if (q.status !== 'done' && hasProduct(q.name)) q.status = 'done';
  }
} else for (const q of queue) {
  if (q.status === 'done' && !hasProduct(q.name)) { q.status = 'pending'; continue; }
  if (q.status !== 'done' && hasProduct(q.name)) { q.status = 'done'; continue; }   // 有产物即认完成
  if (q.status === 'failed' && (q.attempts ?? 0) < 2) q.status = 'pending';         // 失败页给第二次机会
}

// ---------- 增量：只重跑源站变了的页 ----------
if (INCREMENTAL && !FORCE) {
  const done = queue.filter(q => q.status === 'done');
  if (done.length) {
    console.log(`incremental: 校验 ${done.length} 个已完成页的源站指纹（不起浏览器）…`);
    emit({ kind: 'queue-progress', phase: 'check', total: done.length, done: 0 });
    const pool = [...done];
    let checked = 0, changed = 0, same = 0, unknown = 0;
    const CONC = Math.min(6, Math.max(1, pool.length));
    await Promise.all(Array.from({ length: CONC }, async () => {
      while (pool.length) {
        const q = pool.shift();
        const fpPath = join(BASE, 'pages', q.name, 'fingerprint.json');
        const prev = existsSync(fpPath) ? (() => { try { return JSON.parse(readFileSync(fpPath, 'utf8')); } catch { return null; } })() : null;
        const next = await sourceFingerprint(q.url);
        const { action, reason } = incrementalDecision(prev, next);
        if (action === 'reforge') { q.status = 'pending'; q.reforgeReason = reason; changed++; }
        else if (reason === 'unreachable') unknown++; else same++;
        checked++;
        if (checked % 5 === 0 || checked === done.length) emit({ kind: 'queue-progress', phase: 'check', total: done.length, done: checked });
      }
    }));
    console.log(`incremental: 未变 ${same} · 变了 ${changed} · 不可达 ${unknown}`);
    for (const q of queue) if (q.reforgeReason) console.log(`  ↻ ${q.name} — ${decisionNote(q.reforgeReason)}`);
    emit({ kind: 'queue-progress', phase: 'check-done', total: done.length, done: checked, changed, same, unknown });
  }
}
writeFileSync(queuePath, JSON.stringify(queue, null, 2));

const pending = queue.filter(q => q.status === 'pending' || q.status === 'queued');
if (!pending.length) {
  const d = queue.filter(q => q.status === 'done').length, f = queue.filter(q => q.status === 'failed').length;
  console.log(`queue has no pending pages: ${d} done, ${f} failed; refreshing host outputs`);
}
console.log(`to forge: ${pending.length} (workers ${PLAN.workers})`);
emit({ kind: 'queue-start', total: queue.length, pending: pending.length, workers: PLAN.workers,
  ...(ALL_DISCOVERED ? { scope: 'all-discovered', discoveredTargets: discoveredTargets.size } : {}) });

// ---------- SSE 等待任务结束 ----------
async function awaitExit(taskId, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  const headers = TOKEN ? { 'x-heimdall-token': TOKEN } : {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/api/events?task=${encodeURIComponent(taskId)}`, { headers, signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(s => s.startsWith('data:'));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim());
          if (ev.kind === 'exit') return { status: ev.status, code: ev.code, killed: ev.killed, error: ev.error };
        } catch {}
      }
    }
  } catch {
    console.log('[queue] SSE disconnected, fallback to job polling');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, Math.min(5000, Math.max(1, deadline - Date.now()))));
    if (Date.now() >= deadline) break;
    try {
      const res = await fetch(API + '/api/jobs', { headers, signal: AbortSignal.timeout(Math.min(8000, Math.max(1, deadline - Date.now()))) });
      if (!res.ok) continue;
      const body = await res.json();
      const job = [...(body.jobs ?? []), ...(body.history ?? [])].find(x => x.id === taskId);
      if (job && ['done', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return { status: job.status, error: job.error };
    } catch {}
  }
  return { status: 'timeout', error: `等不到任务结束（${Math.round(timeoutMs / 1000)}s 超时）；任务可能仍在引擎运行` };
}

const save = () => writeFileSync(queuePath, JSON.stringify(queue, null, 2));
let doneCount = queue.filter(q => q.status === 'done').length;

// 并发消费（worker 数来自配方，且不超过引擎槽位；引擎侧另有单页熔断兜底）
const workQueue = [...pending];
async function worker(id) {
  while (workQueue.length) {
    const job = workQueue.shift();
    // 入队（槽满则等待）
    let taskId = null;
    let admissionError = '';
    const admissionDeadline = Date.now() + Math.max(1000, Number(process.env.HEIMDALL_QUEUE_ADMISSION_MS) || 120_000);
    for (let attempt = 0; !taskId && Date.now() < admissionDeadline; attempt++) {
      try {
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ url: job.url, hostPost: false }), signal: AbortSignal.timeout(10_000) });
        const body = await r.json().catch(() => ({}));
        if (r.ok && body.taskId) { taskId = body.taskId; break; }
        if (![409, 429, 502, 503, 504].includes(r.status)) { admissionError = `forge HTTP ${r.status}: ${String(body.error ?? '').slice(0, 160)}`; break; }
        if (attempt % 4 === 0) console.log(`[w${id}] slot busy, waiting... (${job.name})`);
      } catch (e) {
        if (attempt % 4 === 0) console.log(`[w${id}] engine unreachable, retrying... (${job.name}: ${String(e).slice(0, 60)})`);
      }
      await new Promise(res => setTimeout(res, Math.min(15000, Math.max(1, admissionDeadline - Date.now()))));
    }
    if (!taskId) {
      job.status = 'failed';
      job.attempts = (job.attempts ?? 0) + 1;
      job.error = admissionError || '引擎在入队截止时间内不可用或并发槽始终占满';
      save();
      emit({ kind: 'queue-page', name: job.name, url: job.url, status: 'failed', error: job.error, done: doneCount, total: queue.length });
      continue;
    }
    job.status = 'queued';
    job.attempts = (job.attempts ?? 0) + 1;
    save();
    console.log(`[w${id}] forge ${job.name} (${job.url})`);
    emit({ kind: 'queue-page', name: job.name, url: job.url, status: 'running', worker: id });
    // 客户端等待上限要比引擎熔断略长，否则会先把还活着的页判死
    const res = await awaitExit(taskId, PLAN.pageTimeoutMs + 120_000);
    const productReady = hasProduct(job.name);
    job.status = res.status === 'done' && productReady ? 'done' : 'failed';
    if (job.status === 'done') {
      doneCount++;
      delete job.error;
    } else {
      /**
       * 失败必须**留下原因**。
       *
       * 原先这里只写一个 `'failed'` —— 于是失败页的 `error` 永远是空串，
       * 事后完全查不出发生过什么。本轮实测就撞上了：thordata 一口气 39 页被标失败、
       * `error` 全是空的，只能靠"单独重跑一页看看"来猜（重跑是成功的，说明是瞬时故障）。
       * 现在三路取原因：SSE 的 exit 事件 → 引擎里那条 job 的 error（子进程 stderr 的尾巴）→
       * 实在没有就写明"以 exit N 结束且没留下信息"，绝不空着。
       */
      job.exitCode = res.code ?? null;
      job.error = String(res.error || (res.status === 'done' && !productReady ? '引擎报告完成，但克隆产物或评分文件缺失' : '')).slice(0, 300)
        || `任务以 exit ${res.code ?? '?'} 结束，且没有留下错误信息`;
      if (!res.error) {
        try {
          const body = await (await fetch(API + '/api/jobs', { headers: TOKEN ? { 'x-heimdall-token': TOKEN } : {} })).json();
          const row = [...(body.jobs ?? []), ...(body.history ?? [])].find(x => x.id === taskId);
          if (row?.error) job.error = String(row.error).slice(0, 300);
        } catch { /* 查不到就保留上面那句兜底的说明，不空着 */ }
      }
    }
    save();
    console.log(`[w${id}] ${job.name}: ${job.status}  [${doneCount}/${queue.length}]${job.status === 'failed' ? '  — ' + job.error : ''}`);
    emit({ kind: 'queue-page', name: job.name, url: job.url, status: job.status, done: doneCount, total: queue.length });
  }
}
await Promise.all(Array.from({ length: PLAN.workers }, (_, i) => worker(i + 1)));

// ---------- host 级后处理：整批只跑一次 ----------
/**
 * 后处理步骤。
 *
 * 以前失败是**完全静默**的（只 resolve 一个 false，谁也不看）：linker 挂了 →
 * 站内链接一条没接上；dedupe 挂了 → 资产没去重 —— 而队列照样报"整批成功"。
 * 现在失败会把原因打出来，并记一条事件（控制台的任务日志里能看到）。
 */
async function runStep(script, args, label) {
  try {
    await runScript(script, args);
    return true;
  } catch (e) {
    const msg = String(e?.message ?? e).slice(0, 200);
    console.warn(`  ⚠ ${label} 失败（已克隆的页面不受影响，但这一步的产物缺失）：${msg}`);
    emit({ kind: 'queue-warn', phase: 'finish', step: label, error: msg });
    postFailures.push({ step: label, error: msg });
    return false;
  }
}
const postFailures = [];
const d = queue.filter(q => q.status === 'done').length, f = queue.filter(q => q.status === 'failed').length;
if (d > 0) {
  console.log('\n[host-post] xlsx / linker / index-page / repair-empty (once for the whole batch)');
  emit({ kind: 'queue-progress', phase: 'finish', total: queue.length, done: d });
  await runStep('harvest/xlsx.mjs', [host], '情报表');
  await runStep('crawler/linker.mjs', [host], '站内接线');
  await runStep('crawler/index-page.mjs', [host], '索引与对比页');
  await runStep('crawler/repair-empty-assets.mjs', [host], '0 字节资产清理');   // 追踪信标之类
  await runStep('audit/orphans.mjs', [host], '孤儿资产报告');                   // 可回收清单
  if (!process.argv.includes('--no-dedupe')) {
    console.log('\n[dedupe] content-addressed asset store (hardlinks)');
    await runStep('store/dedupe.mjs', [host], '资产去重');
  }
}

// 分数走势：整批的平均视觉还原度记一笔（单页 forge 不记，太碎）
{
  let sum = 0, n = 0;
  for (const q of queue) {
    if (q.status !== 'done') continue;
    try {
      const s = JSON.parse(readFileSync(join(BASE, 'pages', q.name, 'score.json'), 'utf8'));
      if (typeof s.pixel === 'number') { sum += s.pixel; n++; }
    } catch { /* 缺 score 的页不参与均值 */ }
  }
  if (n) appendHistory(host, { kind: 'clone', pages: n, avgPixel: +((sum / n) * 100).toFixed(2) });
}

console.log(`\nQUEUE COMPLETE ${host}: ${d} done / ${f} failed / ${queue.length} total`);
emit({ kind: 'queue-complete', done: d, failed: f, postFailed: postFailures.length, total: queue.length });
if (f || postFailures.length) process.exitCode = 1;
