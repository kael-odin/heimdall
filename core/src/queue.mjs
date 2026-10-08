/**
 * queue — 全站批量锻造（持久化队列 + 断点续跑 + 引擎并发槽）
 *
 * 读 atlas.json 全节点（排除登录/法务页），构造 workspace/<host>/queue.json，
 * 逐页向 engine POST /api/forge（槽满自动等待），SSE 监听每页 exit 更新状态落盘。
 * 重跑自动跳过已完成页（clone/index.html + score.json 齐备即视为 done）。
 *
 * 用法: node src/queue.mjs <host> [--max 20]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { WORKSPACE } from './paths.mjs';

const host = process.argv[2] ?? 'thordata.com';
const maxIdx = process.argv.indexOf('--max');
const MAX = maxIdx > -1 ? Number(process.argv[maxIdx + 1] ?? 20) : 20;
const API = process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900';
const TOKEN = process.env.HEIMDALL_TOKEN ?? '';
const HEADERS = { 'Content-Type': 'application/json', ...(TOKEN ? { 'x-heimdall-token': TOKEN } : {}) };
const BASE = join(WORKSPACE, host);
const queuePath = join(BASE, 'queue.json');

const atlas = JSON.parse(readFileSync(join(BASE, 'recon', 'atlas.json'), 'utf8'));
const engineName = (u) => {
  const p = new URL(u).pathname.replace(/\/$/, '').replace(/^\//, '').replace(/[/?&#]+/g, '-').slice(0, 60);
  return p || 'home';
};

// ---------- 构造/载入队列 ----------
let queue;
if (existsSync(queuePath)) {
  queue = JSON.parse(readFileSync(queuePath, 'utf8'));
  console.log(`resume queue: ${queue.filter(q => q.status === 'done').length} done / ${queue.length} total`);
} else {
  const seen = new Set();
  queue = atlas.nodes
    .filter(n => !['auth', 'legal'].includes(n.type))
    .map(n => ({ url: n.url, name: engineName(n.url), type: n.type, status: 'pending' }))
    .filter(q => { const k = q.name; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, MAX);
  writeFileSync(queuePath, JSON.stringify(queue, null, 2));
  console.log(`new queue: ${queue.length} pages (max ${MAX})`);
}

const hasProduct = (name) => existsSync(join(BASE, 'pages', name, 'clone', 'index.html')) && existsSync(join(BASE, 'pages', name, 'score.json'));
for (const q of queue) if (q.status !== 'done' && hasProduct(q.name)) q.status = 'done';   // 有产物即认完成
writeFileSync(queuePath, JSON.stringify(queue, null, 2));

const pending = queue.filter(q => q.status === 'pending' || q.status === 'queued');
if (!pending.length) {
  const d = queue.filter(q => q.status === 'done').length, f = queue.filter(q => q.status === 'failed').length;
  console.log(`queue already complete: ${d} done, ${f} failed`);
  process.exit(0);
}
console.log(`to forge: ${pending.length}`);

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
    } catch (e) { clearTimeout(timer); resolve('sse-error'); }
  });
}

const save = () => writeFileSync(queuePath, JSON.stringify(queue, null, 2));
let doneCount = queue.filter(q => q.status === 'done').length;

// 双 worker 消费（引擎 2 槽）
const workQueue = [...pending];
async function worker(id) {
  while (workQueue.length) {
    const job = workQueue.shift();
    // 入队（槽满则等待）
    let taskId = null;
    for (let attempt = 0; !taskId; attempt++) {
      const r = await fetch(`${API}/api/forge`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ url: job.url, hostPost: false }) });
      if (r.status === 200) { taskId = (await r.json()).taskId; break; }
      if (attempt % 4 === 0) console.log(`[w${id}] slot busy, waiting... (${job.name})`);
      await new Promise(res => setTimeout(res, 15000));
    }
    job.status = 'queued';
    save();
    console.log(`[w${id}] forge ${job.name} (${job.url})`);
    const status = await awaitExit(taskId);
    job.status = status === 'done' ? 'done' : 'failed';
    if (job.status === 'done') doneCount++;
    save();
    console.log(`[w${id}] ${job.name}: ${job.status}  [${doneCount}/${queue.length}]`);
  }
}
await Promise.all([worker(1), worker(2)]);

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
  console.log('\n[host-post] xlsx / linker / index-page (once for the whole batch)');
  await runNode(join('src', 'harvest', 'xlsx.mjs'), [host]);
  await runNode(join('src', 'crawler', 'linker.mjs'), [host]);
  await runNode(join('src', 'crawler', 'index-page.mjs'), [host]);
}
console.log(`\nQUEUE COMPLETE ${host}: ${d} done / ${f} failed / ${queue.length} total`);
