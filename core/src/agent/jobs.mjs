/**
 * agent/jobs — 任务门面（E1-08、E1-10、E2-07，PRD 03 §3.1、附录 C §10），运行在引擎进程里
 *
 * 不改现有任务机制：门面通过引擎自己的旧路由（POST /api/forge、/api/verify、/api/recon、/api/clone-site）
 * 发起底层任务，从 /api/jobs 读状态、从 /api/events 读事件。改变的只有对外语义：
 *   · 槽被占用时不再回 409 busy，而是**排队**，返回位置；底层空出来自动开始（槽计数不动）
 *   · 一个门面任务可以有多个阶段（forge → verify），对应多个底层任务（engineTasks）
 *   · 统一事件 {seq, ts, kind, stage?, pct?, message?, data?}，seq 单调递增，支持 ?after= 续传
 *   · 取消：转发到底层 /api/jobs/:id/cancel（会清理整棵子进程树），排队中的直接取消
 * 状态快照持久化到 <数据根>/agent/jobs.json（引擎重启后仍能查到历史；运行中的记为 failed: interrupted）。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_ROOT } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { newJobId, sha256 } from './ids.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired']);
const KEEP = 200;
const STORE = join(DATA_ROOT, 'agent', 'jobs.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * @param {{ selfBase: () => string, token: () => string, onChange?: (job) => void }} opts
 *   selfBase：本引擎的 http://127.0.0.1:<port>；token：本引擎的令牌（门面调旧路由时带上）
 */
export function createJobManager({ selfBase, token, onChange, storePath = STORE } = {}) {
  const jobs = new Map();
  const subs = new Map();   // jobId → Set<(event) => void>
  let saveTimer = null;

  // 恢复历史：上一次引擎退出时还在跑或在排队的任务不会再继续，记为 interrupted
  try {
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    for (const j of saved.jobs ?? []) {
      if (!TERMINAL.has(j.status)) Object.assign(j, { status: 'failed', endedAt: j.endedAt ?? new Date().toISOString(), error: { code: 'internal', message: '引擎重启，任务中断', hint: '重新发起这个任务' } });
      j.events = j.events ?? [];
      jobs.set(j.jobId, j);
    }
  } catch {}

  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        mkdirSync(dirname(storePath), { recursive: true });
        const list = [...jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-KEEP)
          .map(j => ({ ...j, events: j.events.slice(-300), runtime: undefined }));
        writeFileAtomic(storePath, JSON.stringify({ schema: 'heimdall.jobs/1', jobs: list }));
      } catch {}
    }, 200);
  };

  const emit = (job, ev) => {
    const event = { seq: (job.events.at(-1)?.seq ?? 0) + 1, ts: new Date().toISOString(), ...ev };
    job.events.push(event);
    if (job.events.length > 2000) job.events.splice(0, job.events.length - 2000);
    for (const fn of subs.get(job.jobId) ?? []) { try { fn(event); } catch {} }
    onChange?.(job);
    persist();
    return event;
  };

  const setStatus = (job, status, extra = {}) => {
    job.status = status;
    Object.assign(job, extra);
    if (status === 'running' && !job.startedAt) job.startedAt = new Date().toISOString();
    if (TERMINAL.has(status)) job.endedAt = new Date().toISOString();
    persist();
  };

  const callSelf = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(selfBase() + path, {
      method, headers: { ...(token() ? { 'x-heimdall-token': token() } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  /** 等底层任务结束，期间把它的事件转成门面事件 */
  const followEngineTask = async (job, stage, taskId) => {
    const ctrl = new AbortController();
    job.runtime = { ...(job.runtime ?? {}), followCtrl: ctrl };
    const sse = (async () => {
      try {
        const res = await fetch(`${selfBase()}/api/events?task=${encodeURIComponent(taskId)}`, { headers: token() ? { 'x-heimdall-token': token() } : {}, signal: ctrl.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split('\n').find(l => l.startsWith('data: '));
            if (!line) continue;
            let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
            if (ev.kind === 'log') continue;   // 逐行日志不入门面事件（沿用现有行为：只在运行中推送）
            const pct = typeof ev.pct === 'number' ? ev.pct : typeof ev.index === 'number' && typeof ev.total === 'number' && ev.total ? Math.round(ev.index / ev.total * 100) : undefined;
            emit(job, { kind: ev.kind === 'exit' ? 'stage' : 'progress', stage, ...(pct !== undefined ? { pct } : {}),
              message: typeof ev.stage === 'string' ? `${ev.kind}: ${ev.stage}` : ev.kind, data: { legacy: ev } });
          }
        }
      } catch {}
    })();
    // 状态以 /api/jobs 为准（SSE 断了也不影响判断）
    for (;;) {
      if (job.cancelRequested) break;
      const { data } = await callSelf('/api/jobs').catch(() => ({ data: null }));
      const t = data?.jobs?.find(x => x.id === taskId);
      if (t && t.status !== 'running') { ctrl.abort(); await sse.catch(() => {}); return t.status; }
      if (!t && data) { ctrl.abort(); return 'failed'; }
      await sleep(1000);
    }
    ctrl.abort();
    return 'cancelled';
  };

  /** 发起一个阶段：busy 时排队重试，直到拿到底层 taskId 或被取消。body 可以是函数（依赖前一阶段的返回） */
  const startStage = async (job, stage, st) => {
    let announced = false;
    for (;;) {
      if (job.cancelRequested) return null;
      const body = typeof stage.body === 'function' ? stage.body(job) : stage.body;
      const { status, data } = await callSelf(stage.route, { method: 'POST', body });
      if (status === 200 && data?.taskId) { st.response = data; return data.taskId; }
      if (status === 409 && data?.error === 'busy') {
        if (job.status !== 'queued') setStatus(job, 'queued');
        const position = [...jobs.values()].filter(j => j.status === 'queued' && j.createdAt <= job.createdAt).length;
        job.queue = { position };
        if (!announced) { emit(job, { kind: 'queued', stage: stage.name, message: `等待空闲槽位（第 ${position} 位）` }); announced = true; }
        await sleep(1500);
        continue;
      }
      throw Object.assign(new Error(data?.error ? String(data.error).slice(0, 200) : `HTTP ${status}`), { code: status === 400 ? 'invalid_args' : status === 409 ? 'origin_conflict' : 'internal' });
    }
  };

  const run = async (job) => {
    try {
      for (const stage of job.plan) {
        const st = job.stages.find(s => s.name === stage.name);
        const taskId = await startStage(job, stage, st);
        if (!taskId) break;
        if (job.status !== 'running') setStatus(job, 'running', { queue: undefined });
        job.engineTasks.push(taskId);
        Object.assign(st, { status: 'running', startedAt: new Date().toISOString(), engineTask: taskId });
        emit(job, { kind: 'stage', stage: stage.name, message: `开始 ${stage.name}` });
        const outcome = await followEngineTask(job, stage.name, taskId);
        Object.assign(st, { status: outcome === 'done' ? 'succeeded' : outcome, endedAt: new Date().toISOString() });
        if (outcome !== 'done') {
          if (job.cancelRequested || outcome === 'cancelled') break;
          // Keep a bounded, capability-owned snapshot so a failed verify still
          // reports the mirror pages that were cloned and measured.
          try { job.result = await job.finish?.(job) ?? null; } catch {}
          setStatus(job, 'failed', { error: { code: 'internal', message: `${stage.name} 阶段失败`, hint: '`heimdall jobs events <jobId>` 查看事件；修正后重新发起' } });
          emit(job, { kind: 'exit', message: `${stage.name} 失败` });
          return;
        }
      }
      if (job.cancelRequested) { setStatus(job, 'cancelled'); emit(job, { kind: 'exit', message: '已取消' }); return; }
      job.result = await job.finish?.(job) ?? {};
      setStatus(job, 'succeeded');
      emit(job, { kind: 'result', message: '完成' });
      emit(job, { kind: 'exit', message: '完成' });
    } catch (error) {
      setStatus(job, 'failed', { error: { code: error.code ?? 'internal', message: String(error.message ?? error).slice(0, 300), hint: '`heimdall doctor` 自检后重试' } });
      emit(job, { kind: 'exit', message: '失败' });
    } finally {
      delete job.runtime;
      persist();
    }
  };

  return {
    /**
     * 创建并开始一个门面任务。plan: [{ name, route, body }]；finish(job) 生成 result。
     * idempotencyKey：同键同参返回原任务（E1-09 的最小形态，Ph2 换成 agent.db）
     */
    create({ capability, args, plan, finish, idempotencyKey }) {
      const argsHash = sha256(JSON.stringify(args ?? {}));
      if (idempotencyKey) {
        const prev = [...jobs.values()].find(j => j.idempotencyKey === idempotencyKey);
        if (prev) return prev.argsHash === argsHash ? { job: prev, reused: true } : { conflict: true, job: prev };
      }
      const job = {
        schema: 'heimdall.job/1', jobId: newJobId(), capability, argsHash, args, ...(idempotencyKey ? { idempotencyKey } : {}),
        createdAt: new Date().toISOString(), status: 'queued', cancelRequested: false,
        stages: plan.map(s => ({ name: s.name, status: 'pending' })), engineTasks: [], events: [], plan, finish,
      };
      jobs.set(job.jobId, job);
      emit(job, { kind: 'queued', message: `已创建：${plan.map(s => s.name).join(' → ')}` });
      run(job);
      return { job };
    },
    get: (id) => jobs.get(id) ?? null,
    list: ({ status, capability, limit = 50 } = {}) => [...jobs.values()]
      .filter(j => (!status || j.status === status) && (!capability || j.capability === capability))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit),
    events: (id, after = 0, limit = 100) => (jobs.get(id)?.events ?? []).filter(e => e.seq > after).slice(0, limit),
    subscribe(id, fn) { if (!subs.has(id)) subs.set(id, new Set()); subs.get(id).add(fn); return () => subs.get(id)?.delete(fn); },
    async cancel(id) {
      const job = jobs.get(id);
      if (!job || TERMINAL.has(job.status)) return job;
      job.cancelRequested = true;
      emit(job, { kind: 'cancel-requested', message: '请求取消' });
      const running = job.stages.find(s => s.status === 'running');
      if (running?.engineTask) await callSelf(`/api/jobs/${encodeURIComponent(running.engineTask)}/cancel`, { method: 'POST' }).catch(() => {});
      job.runtime?.followCtrl?.abort();
      if (job.status === 'queued') { setStatus(job, 'cancelled'); emit(job, { kind: 'exit', message: '已取消' }); }
      return job;
    },
    async wait(id, ms) {
      const job = jobs.get(id);
      if (!job || TERMINAL.has(job.status)) return { job, timedOut: false };
      return new Promise((resolveWait) => {
        const timer = setTimeout(() => { off(); resolveWait({ job, timedOut: true }); }, ms);
        const off = this.subscribe(id, (ev) => { if (ev.kind === 'exit') { clearTimeout(timer); off(); setTimeout(() => resolveWait({ job, timedOut: false }), 0); } });
      });
    },
    running: () => [...jobs.values()].filter(j => !TERMINAL.has(j.status)).length,
    TERMINAL,
  };
}

/** 门面任务对外的形状（去掉内部字段） */
export function publicJob(job) {
  if (!job) return null;
  const { plan, finish, runtime, events, ...rest } = job;
  return { ...rest, events: events?.length ?? 0, lastEvent: events?.at(-1) ?? null };
}
