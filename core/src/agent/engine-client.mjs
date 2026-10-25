/**
 * agent/engine-client — CLI 与 MCP 连接本机引擎（E3-07、E2-06）
 *
 * 读类能力直接读工作区，不需要引擎；任务类能力（clone、jobs）交给引擎的 HTTP v1 门面去排队与执行。
 * 连接顺序：HEIMDALL_API → http://127.0.0.1:8900；**只复用数据根一致的引擎**——用着别的数据目录的引擎
 * 会报告「完成」却在另一处落盘（handoff.mjs 吃过这个亏）。都没有时按需自起一台临时引擎：
 *   · 前台等待（--wait）：本进程退出时一并关掉
 *   · 不等（--no-wait）或 MCP 服务：引擎带 HEIMDALL_IDLE_EXIT_MS，空闲一段时间后自己退出
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { CORE_ROOT, DATA_ROOT } from '../paths.mjs';
import { CapabilityError } from './envelope.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 引擎状态文件：<数据根>/agent/engine.json，记本机引擎的地址与 pid。
 * 引擎在 listen 时写、正常退出时清；CLI 连不上时也读它——否则自起的临时引擎（随机端口）
 * 只有当时那个进程知道地址，随后的命令又会以为「引擎没在跑」。
 */
export const engineStateFile = () => join(DATA_ROOT, 'agent', 'engine.json');
export function readEngineState() {
  try { const s = JSON.parse(readFileSync(engineStateFile(), 'utf8')); return s?.base && s?.pid ? s : null; } catch { return null; }
}
export function writeEngineState(state) {
  try { mkdirSync(join(DATA_ROOT, 'agent'), { recursive: true }); writeFileSync(engineStateFile(), JSON.stringify(state)); } catch {}
}
export function clearEngineState(pid) {
  const s = readEngineState();
  if (!s || (pid !== undefined && s.pid !== pid)) return;
  try { unlinkSync(engineStateFile()); } catch {}
}
const token = () => process.env.HEIMDALL_TOKEN || '';
export const authHeaders = () => (token() ? { 'x-heimdall-token': token() } : {});

async function freePort() {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); });
  });
}

/** 探测一个引擎：可达且数据根一致才返回状态 */
export async function probeEngine(base, { timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(base.replace(/\/$/, '') + '/api/status', { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { base, reachable: true, unauthorized: true };
    if (!res.ok) return null;
    const status = await res.json().catch(() => ({}));
    const root = status.dataRoot ? resolve(status.dataRoot) : null;
    return { base: base.replace(/\/$/, ''), reachable: true, status, dataRoot: root, sameRoot: root === resolve(DATA_ROOT) };
  } catch { return null; }
}

let owned = null;   // 本进程自起的引擎 { base, child }

/**
 * 找到（或启动）一台数据根一致的引擎。
 * @param {{ start?: boolean, detached?: boolean, idleExitMs?: number }} opts
 */
export async function connectEngine({ start = true, detached = false, idleExitMs = 10 * 60_000 } = {}) {
  if (owned) return { base: owned.base, owned: true };
  const candidates = [...new Set([process.env.HEIMDALL_API, readEngineState()?.base, 'http://127.0.0.1:8900'].filter(Boolean))];
  let mismatch = null;
  for (const base of candidates) {
    const p = await probeEngine(base);
    if (!p) continue;
    if (p.unauthorized) throw new CapabilityError('unauthorized', `引擎 ${base} 要求令牌`);
    if (p.sameRoot) return { base: p.base, owned: false, status: p.status };
    mismatch = p;
  }
  if (!start) {
    if (mismatch) throw new CapabilityError('data_root_mismatch', `引擎 ${mismatch.base} 的数据根与本机不一致`, { details: { engine: mismatch.dataRoot, local: resolve(DATA_ROOT) } });
    throw new CapabilityError('engine_unreachable', '本机没有在跑的引擎');
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HEIMDALL_INVOKE_CWD: process.cwd(), ...(detached ? { HEIMDALL_IDLE_EXIT_MS: String(idleExitMs) } : {}) };
  const child = spawn(process.execPath, [join(CORE_ROOT, 'src', 'engine-server.mjs'), String(port)], {
    cwd: CORE_ROOT, stdio: 'ignore', env, detached, windowsHide: true,
  });
  child.on('error', () => {});
  if (detached) child.unref();
  else process.once('exit', () => { try { child.kill(); } catch {} });
  for (let i = 0; i < 120; i++) {
    await sleep(250);
    const p = await probeEngine(base, { timeoutMs: 1000 });
    if (p?.sameRoot) {
      if (detached) writeEngineState({ base, pid: child.pid, startedAt: new Date().toISOString(), detached: true });
      else owned = { base, child };
      return { base, owned: !detached, started: true, status: p.status };
    }
  }
  try { child.kill(); } catch {}
  throw new CapabilityError('engine_unreachable', `临时引擎 30 秒内没有应答：${base}`);
}

export function stopOwnedEngine() {
  if (!owned) return;
  try { owned.child.kill(); } catch {}
  owned = null;
}

/** 调引擎接口；网络错误转成 engine_unreachable，v1 信封原样返回 */
export async function engineFetch(base, path, { method = 'GET', body, timeoutMs = 30_000, headers = {} } = {}) {
  let res;
  try {
    res = await fetch(base + path, {
      method, headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new CapabilityError('engine_unreachable', `连不上引擎 ${base}`, { details: { reason: String(error?.message ?? error).slice(0, 160) } });
  }
  if (res.status === 401) throw new CapabilityError('unauthorized', '引擎拒绝了请求：缺少或无效的令牌');
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
