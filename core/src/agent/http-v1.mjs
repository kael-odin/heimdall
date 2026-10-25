/**
 * agent/http-v1 — HTTP v1 门面（E5-01 ~ E5-05，PRD 附录 A §6），挂在引擎里，与旧 /api/* 并存
 *
 *   GET  /api/v1/capabilities          能力清单（含 schema、effects、scope）与 dataRoot
 *   POST /api/v1/tools/{name}          调用能力；请求体是入参；长任务 202 + jobId
 *   GET  /api/v1/jobs                  任务清单（?status=&limit=&active=1）
 *   GET  /api/v1/jobs/{id}             状态（?waitMs= 最多等 60 秒）
 *   GET  /api/v1/jobs/{id}/events      事件：text/event-stream（?after= / Last-Event-ID 续传，15 秒心跳），
 *                                      或 Accept: application/json 时返回一页 JSON
 *   POST /api/v1/jobs/{id}/cancel      取消
 *   GET  /api/v1/artifacts?uri=…       读取资源（图片直接回字节）
 *
 * 鉴权沿用引擎：x-heimdall-token 或 Authorization: Bearer（由引擎在进入本模块前校验）。
 * 状态码按错误码映射（附录 A §1.5）；响应体永远是信封。
 */
import { DATA_ROOT } from '../paths.mjs';
import { fail, httpStatusOf, nextAction } from './envelope.mjs';
import { invoke } from './registry/invoke.mjs';
import { describeCapabilities } from './registry/index.mjs';
import { localJobs } from './registry/capabilities/jobs.mjs';
import { readFileResource, resolveUri } from './resources.mjs';

const MAX_BODY = 1024 * 1024;

function send(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(data);
}
const sendEnv = (res, env, headers = {}) => {
  const extra = { ...headers };
  if (env.ok && env.result?.status === 'queued' && env.result?.job?.queue?.position) {
    extra['X-Heimdall-Queue-Position'] = String(env.result.job.queue.position);
    extra['Retry-After'] = '2';
  }
  send(res, httpStatusOf(env), env, extra);
};

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { tooLarge: true })); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @returns {boolean} 是否已处理
 */
export async function handleV1(req, res, u, { jobs }) {
  if (!u.pathname.startsWith('/api/v1/')) return false;
  const ctx = { client: 'http', jobs, scope: 'admin' };
  const path = u.pathname.slice('/api/v1'.length);
  try {
    if (req.method === 'GET' && path === '/capabilities') {
      send(res, 200, { ok: true, result: { capabilities: describeCapabilities(), dataRoot: DATA_ROOT, protocol: 'heimdall.v1' }, summary: `${describeCapabilities().length} 个能力。`, nextActions: [], evidence: [] });
      return true;
    }
    const tool = path.match(/^\/tools\/([a-z_-]{2,40})$/);
    if (tool) {
      if (req.method !== 'POST') { sendEnv(res, fail('invalid_args', '用 POST 调用能力')); return true; }
      let args = {};
      const raw = await readBody(req).catch((e) => { throw e; });
      if (raw.trim()) {
        try { args = JSON.parse(raw); } catch { sendEnv(res, fail('invalid_args', '请求体不是合法 JSON')); return true; }
      }
      if (req.headers['idempotency-key'] && !args.idempotencyKey) args.idempotencyKey = String(req.headers['idempotency-key']).slice(0, 120);
      const env = await invoke(tool[1], args, ctx);
      // 图片（compare 的内联裁剪图）在 HTTP 下不放进响应体；要看用 /api/v1/artifacts
      sendEnv(res, env);
      return true;
    }
    if (req.method === 'GET' && path === '/jobs') {
      const active = u.searchParams.get('active') === '1';
      const env = await localJobs({ action: 'list', status: u.searchParams.get('status') ?? undefined, limit: Math.min(500, Number(u.searchParams.get('limit')) || 50) }, jobs);
      if (active) env.result.jobs = env.result.jobs.filter(j => !jobs.TERMINAL.has(j.status));
      sendEnv(res, env);
      return true;
    }
    const jobPath = path.match(/^\/jobs\/(job_[0-9a-z]{8})(\/events|\/cancel)?$/);
    if (jobPath) {
      const [, jobId, sub] = jobPath;
      if (sub === '/cancel') {
        if (req.method !== 'POST') { sendEnv(res, fail('invalid_args', '用 POST 取消')); return true; }
        sendEnv(res, await localJobs({ action: 'cancel', jobId }, jobs));
        return true;
      }
      if (sub === '/events') {
        const after = Math.max(0, Number(u.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0);
        const job = jobs.get(jobId);
        if (!job) { sendEnv(res, fail('not_found', `没有任务 ${jobId}`)); return true; }
        if ((req.headers.accept ?? '').includes('application/json')) {
          sendEnv(res, await localJobs({ action: 'events', jobId, after, limit: Math.min(500, Number(u.searchParams.get('limit')) || 100) }, jobs));
          return true;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        const write = (ev) => { try { res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`); } catch {} };
        for (const ev of jobs.events(jobId, after, 2000)) write(ev);
        if (jobs.TERMINAL.has(job.status)) { res.end(); return true; }
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
        const off = jobs.subscribe(jobId, (ev) => { write(ev); if (ev.kind === 'exit') { clearInterval(ping); off(); res.end(); } });
        req.on('close', () => { clearInterval(ping); off(); });
        return true;
      }
      if (req.method !== 'GET') { sendEnv(res, fail('invalid_args', '用 GET 查询任务')); return true; }
      const waitMs = Math.min(60_000, Math.max(0, Number(u.searchParams.get('waitMs')) || 0));
      sendEnv(res, await localJobs({ action: waitMs ? 'wait' : 'status', jobId, waitMs }, jobs));
      return true;
    }
    if (req.method === 'GET' && path === '/artifacts') {
      const uri = u.searchParams.get('uri') ?? '';
      const r = resolveUri(uri);
      if (r.file && (r.mime.startsWith('image/') || (req.headers.accept ?? '').startsWith('text/plain'))) {
        const data = readFileResource(r, { maxBytes: Number(u.searchParams.get('maxBytes')) || 1_500_000 });
        const body = data.image ? data.image.data : Buffer.from(data.text);
        res.writeHead(200, { 'Content-Type': data.image ? 'image/png' : 'text/plain; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'X-Heimdall-Sha256': data.sha256 });
        res.end(body);
        return true;
      }
      sendEnv(res, await invoke('artifact', { uri }, ctx));
      return true;
    }
    sendEnv(res, fail('not_found', '没有这个 v1 路由', { nextActions: [nextAction('heimdall_overview', null, 'GET /api/v1/capabilities 查看能力')] }));
    return true;
  } catch (error) {
    if (error?.tooLarge) { sendEnv(res, fail('invalid_args', '请求体超过 1 MB')); return true; }
    const { fromError } = await import('./envelope.mjs');
    sendEnv(res, fromError(error));
    return true;
  }
}
