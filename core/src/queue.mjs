/**
 * queue — 全站批量锻造（持久化队列 + 断点续跑 + 增量重跑 + 引擎并发槽）
 *
 * 读 atlas.json 全节点（排除登录/法务页），构造 workspace/<host>/queue.json，
 * 逐页向 engine POST /api/forge（槽满自动等待），SSE 监听每页 exit 更新状态落盘。
 * 重跑自动跳过已完成页（clone/index.html + score.json 齐备即视为 done）。
 *
 * 增量模式（--incremental）：对已完成页问一句"源站变了没有"（Node fetch 取
 * 服务端 HTML 指纹，不起浏览器），没变的跳过、变了的重排。判据见 fingerprint.mjs。
 *
 * 用法: node src/queue.mjs <host> [--max 20] [--force] [--incremental] [--missing-har] [--no-dedupe] [--json-events]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { requireArg } from './args.mjs';
import { loadProfile, queuePlan, sanitizeHost } from './site-profile.mjs';
import { sourceFingerprint, incrementalDecision, decisionNote } from './fingerprint.mjs';
import { appendHistory } from './seo/history.mjs';
import { WORKSPACE } from './paths.mjs';
import { emit as emitRaw } from './emit.mjs';
import { pageNameOfUrl } from './url-canon.mjs';

const host = sanitizeHost(requireArg(process.argv[2], 'node src/queue.mjs <host> [--max N] [--force] [--incremental] [--missing-har] [--no-dedupe]', '站点 host'));
const maxIdx = process.argv.indexOf('--max');
const profile0 = loadProfile(host);   // 站点配方：队列排除项、并发、超时
const PLAN = queuePlan(profile0, Number(process.env.HEIMDALL_QUEUE_WORKERS || process.env.HEIMDALL_FORGE_SLOTS || 2));
const MAX = maxIdx > -1 ? Number(process.argv[maxIdx + 1] ?? PLAN.maxPages) : PLAN.maxPages;
const FORCE = process.argv.includes('--force');       // 忽略已有产物，强制重锻
const INCREMENTAL = process.argv.includes('--incremental');   // 只重跑源站变了的页
const MISSING_HAR = process.argv.includes('--missing-har');   // 只重锻缺 network.har 的页（交互镜像离线补录）
const JSON_EVENTS = process.argv.includes('--json-events');    // 输出 @@EVENT@@ 行，供引擎 SSE 转发
const API = process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900';
const TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const HEADERS = { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-heimdall-token': TOKEN } : {}) };
const profile = profile0;
const BASE = join(WORKSPACE, host);
const queuePath = join(BASE, 'queue.json');

/** 机器可读进度（引擎 SSE 用）；普通 CLI 跑时只是多几行带前缀的日志 */
const emit = JSON_EVENTS ? emitRaw : () => {};

const atlas = JSON.parse(readFileSync(join(BASE, 'recon', 'atlas.json'), 'utf8'));
// 页名规则与 forge / 引擎 / 控制台**同一份实现**（src/url-canon.mjs）。
// 以前这里有第四份副本，四处各改各的迟早会漂移 —— 而漂移的后果是产物落错目录。
const engineName = (u) => pageNameOfUrl(u);

// ---------- 构造/载入队列 ----------
let queue;
let fresh = false;                      // 这次是新建的队列（--max 仍然生效）
if (existsSync(queuePath)) {
  queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  console.log(`resume queue: ${queue.filter(q => q.status === 'done').length} done / ${queue.length} total`);
} else {
  fresh = true;
  const seen = new Set();
  queue = atlas.nodes
    .filter(n => !profile.queue.excludeTypes.includes(n.type))
    .map(n => ({ url: n.url, name: engineName(n.url), type: n.type, status: 'pending' }))
    .filter(q => { const k = q.name; if (seen.has(k)) return false; seen.add(k); return true; });
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  console.log(`new queue: ${queue.length} pages (max ${MAX})`);
}

// ---------- 与 atlas 对齐 ----------
// 队列一旦落盘就再也没看过 atlas，于是"重新侦察发现了新页"这件事永远进不了队列 ——
// 全站克隆会一直停在第一次侦察的那批页上，而且**看起来像已经跑完了**。
// 这里把 atlas 里有、队列里没有的页补进来（按 url 排序，保证同样输入得到同样队列）。
// 注意 --max 只约束**新建**队列：已存在的队列代表"这就是我要的全部页面"，
// 补进来的页不该因为它而再被砍掉（那正是这个 bug 要修的东西）。
{
  const known = new Set(queue.map(q => q.name));
  const added = atlas.nodes
    .filter(n => !profile.queue.excludeTypes.includes(n.type))
    .map(n => ({ url: n.url, name: engineName(n.url), type: n.type, status: 'pending', addedBy: 'recon-sync' }))
    .filter(q => !known.has(q.name) && (known.add(q.name), true))
    .sort((a, b) => a.url.localeCompare(b.url));
  if (added.length) {
    queue.push(...added);
    console.log(`recon-sync: 侦察到 ${added.length} 个队列里没有的页 → 补入队列（共 ${queue.length}）`);
    for (const q of added) console.log(`  + ${q.name}`);
  }
}
// --max 在新队列上仍然生效：先与 atlas 对齐、再截断，顺序反了就等于没限制
if (fresh && queue.length > MAX) {
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
  console.log(`queue already complete: ${d} done, ${f} failed`);
  emit({ kind: 'queue-complete', done: d, failed: f, total: queue.length });
  process.exit(0);
}
console.log(`to forge: ${pending.length} (workers ${PLAN.workers})`);
emit({ kind: 'queue-start', total: queue.length, pending: pending.length, workers: PLAN.workers });

// ---------- SSE 等待任务结束 ----------
function awaitExit(taskId, timeoutMs = 15 * 60_000) {
  return new Promise(async (resolve) => {
    const timer = setTimeout(() => resolve('timeout'), timeoutMs);
    try {
      const res = await fetch(`${API}/api/events?task=${taskId}`, { headers: TOKEN ? { 'x-heimdall-token': TOKEN } : {} });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          if (!chunk.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(chunk.slice(6));
            if (ev.kind === 'exit') { clearTimeout(timer); resolve(ev.status); return; }
          } catch {}
        }
      }
    } catch (e) {
      console.log('[queue] SSE disconnected, fallback to job polling');
      const poll = async () => {
        for (;;) {
          await new Promise(r => setTimeout(r, 5000));
          try {
            const r = await fetch(API + '/api/jobs', { headers: TOKEN ? { 'x-heimdall-token': TOKEN } : {} });
            if (!r.ok) continue;
            const body = await r.json();
            const all = [...(body.jobs ?? []), ...(body.history ?? [])];
            const j = all.find(x => x.id === taskId);
            if (j && ['done', 'failed', 'cancelled', 'interrupted'].includes(j.status)) { clearTimeout(timer); resolve(j.status); return; }
          } catch {}
        }
      };
      poll();
    }
  });
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
    for (let attempt = 0; !taskId; attempt++) {
      try {
        const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ url: job.url, hostPost: false }) });
        if (r.status === 200) { taskId = (await r.json()).taskId; break; }
        if (attempt % 4 === 0) console.log(`[w${id}] slot busy, waiting... (${job.name})`);
      } catch (e) {
        if (attempt % 4 === 0) console.log(`[w${id}] engine unreachable, retrying... (${job.name}: ${String(e).slice(0, 60)})`);
      }
      await new Promise(res => setTimeout(res, 15000));
    }
    job.status = 'queued';
    job.attempts = (job.attempts ?? 0) + 1;
    save();
    console.log(`[w${id}] forge ${job.name} (${job.url})`);
    emit({ kind: 'queue-page', name: job.name, url: job.url, status: 'running', worker: id });
    // 客户端等待上限要比引擎熔断略长，否则会先把还活着的页判死
    const status = await awaitExit(taskId, PLAN.pageTimeoutMs + 120_000);
    job.status = status === 'done' ? 'done' : 'failed';
    if (job.status === 'done') doneCount++;
    save();
    console.log(`[w${id}] ${job.name}: ${job.status}  [${doneCount}/${queue.length}]`);
    emit({ kind: 'queue-page', name: job.name, url: job.url, status: job.status, done: doneCount, total: queue.length });
  }
}
await Promise.all(Array.from({ length: PLAN.workers }, (_, i) => worker(i + 1)));

// ---------- host 级后处理：整批只跑一次 ----------
function runNode(script, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}
const d = queue.filter(q => q.status === 'done').length, f = queue.filter(q => q.status === 'failed').length;
if (d > 0) {
  console.log('\n[host-post] xlsx / linker / index-page / repair-empty (once for the whole batch)');
  emit({ kind: 'queue-progress', phase: 'finish', total: queue.length, done: d });
  await runNode(join('src', 'harvest', 'xlsx.mjs'), [host]);
  await runNode(join('src', 'crawler', 'linker.mjs'), [host]);
  await runNode(join('src', 'crawler', 'index-page.mjs'), [host]);
  await runNode(join('src', 'crawler', 'repair-empty-assets.mjs'), [host]);   // 0 字节资产（追踪信标）自动清理
  await runNode(join('src', 'audit', 'orphans.mjs'), [host]);                 // 孤儿资产报告（可回收清单）
  if (!process.argv.includes('--no-dedupe')) {
    console.log('\n[dedupe] content-addressed asset store (hardlinks)');
    await runNode(join('src', 'store', 'dedupe.mjs'), [host]);
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
emit({ kind: 'queue-complete', done: d, failed: f, total: queue.length });
