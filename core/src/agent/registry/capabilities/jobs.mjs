/**
 * capability: jobs —— 统一的任务控制（附录 A §2.6，E2-07、E1-08、E1-10）
 *
 * list / status / wait / cancel / events。任务住在引擎里（门面排队与执行）：
 * 在引擎进程内直接用 ctx.jobs；在 CLI / MCP 里转发到引擎的 HTTP v1。
 */
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { connectEngine, engineFetch } from '../../engine-client.mjs';
import { publicJob } from '../../jobs.mjs';

const summaryOf = (job) => {
  const stages = (job.stages ?? []).map(s => `${s.name}:${s.status}`).join(' → ');
  const pos = job.status === 'queued' && job.queue?.position ? `（排队第 ${job.queue.position} 位）` : '';
  return `任务 ${job.jobId}：${job.status}${pos}${stages ? ' · ' + stages : ''}`;
};

export function nextForJob(job) {
  if (!job) return [];
  if (job.status === 'queued' || job.status === 'running') return [nextAction('heimdall_jobs', { action: 'wait', jobId: job.jobId }, '继续等待')];
  if (job.status === 'succeeded' && job.capability === 'clone' && job.result?.siteId) {
    const page = job.result.pages?.[0]?.page;
    return page ? [nextAction('heimdall_brief', { siteId: job.result.siteId, page, detail: 'sections' }, '取简报与分段，开始重建')]
      : [nextAction('heimdall_site', { siteId: job.result.siteId }, '查看站点')];
  }
  if (job.status === 'failed') return [nextAction('heimdall_jobs', { action: 'events', jobId: job.jobId }, '看事件找原因'), nextAction('heimdall_doctor', null, '自检')];
  return [];
}

export async function localJobs(args, jobs) {
  const { action, jobId } = args;
  if (action === 'list') {
    const list = jobs.list({ status: args.status, capability: args.capability, limit: args.limit }).map(publicJob);
    return ok({ jobs: list }, { summary: list.length ? `${list.length} 个任务。` : '没有任务。' });
  }
  if (!jobId) throw new CapabilityError('invalid_args', `${action} 需要 jobId`);
  let job = jobs.get(jobId);
  if (!job) throw new CapabilityError('not_found', `没有任务 ${jobId}`, { nextActions: [nextAction('heimdall_jobs', { action: 'list' }, '列出任务')] });
  if (action === 'events') {
    const events = jobs.events(jobId, args.after, args.limit);
    return ok({ jobId, events, nextAfter: events.at(-1)?.seq ?? args.after }, { summary: `${events.length} 条事件。` });
  }
  let timedOut = false;
  if (action === 'cancel') job = await jobs.cancel(jobId);
  if (action === 'wait') ({ job, timedOut } = await jobs.wait(jobId, Math.min(60_000, args.waitMs)));
  const result = { ...publicJob(job), ...(action === 'wait' ? { timedOut } : {}) };
  const env = ok(result, { summary: summaryOf(job) + (timedOut ? '；本次等待到时，任务仍在进行。' : ''), nextActions: nextForJob(job), jobId });
  if (job.status === 'failed' && job.error) env.warnings = [{ code: job.error.code ?? 'internal', message: job.error.message }];
  return env;
}

export default {
  id: 'jobs',
  title: '任务：列出、等待、取消、看事件',
  description: 'Control long-running jobs (e.g. heimdall_clone returns a jobId). action="wait" blocks up to waitMs (max 60000) and can be '
    + 'called repeatedly; a timeout is not an error (timedOut=true). action="status" returns stages and progress, "events" returns '
    + 'progress events after a sequence number, "cancel" stops the job and its browser processes, "list" shows recent jobs. '
    + 'Jobs that wait for a free engine slot are "queued" with a position; this is not a failure.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'status', 'wait', 'cancel', 'events'], default: 'list' },
      jobId: { type: 'string', pattern: '^job_[0-9a-z]{8}$' },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 30000 },
      after: { type: 'integer', minimum: 0, default: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      status: { type: 'string', enum: ['queued', 'running', 'waiting_input', 'succeeded', 'failed', 'cancelled', 'expired'] },
      capability: { type: 'string', maxLength: 40 },
    },
  },
  cli: { usage: 'jobs list | jobs status|wait|cancel|events <jobId> [--wait-ms N]', positional: ['action', 'jobId'] },
  async handler(args, ctx) {
    if (ctx.jobs) return localJobs(args, ctx.jobs);
    let engine;
    try { engine = await connectEngine({ start: false }); }
    catch (error) {
      if (args.action === 'list' && error.code === 'engine_unreachable') return ok({ jobs: [] }, { summary: '引擎没在跑，没有任务。' });
      throw error;
    }
    const id = args.jobId ? encodeURIComponent(args.jobId) : '';
    const path = args.action === 'list' ? `/api/v1/jobs?limit=${args.limit}${args.status ? '&status=' + args.status : ''}`
      : args.action === 'events' ? `/api/v1/jobs/${id}/events?after=${args.after}&limit=${args.limit}`
        : args.action === 'cancel' ? `/api/v1/jobs/${id}/cancel`
          : `/api/v1/jobs/${id}${args.action === 'wait' ? `?waitMs=${Math.min(60_000, args.waitMs)}` : ''}`;
    const { data } = await engineFetch(engine.base, path, { method: args.action === 'cancel' ? 'POST' : 'GET', timeoutMs: (args.action === 'wait' ? args.waitMs : 0) + 15_000,
      headers: { Accept: 'application/json' } });
    if (!data || typeof data.ok !== 'boolean') throw new CapabilityError('internal', '引擎返回了意外的结果');
    return data;
  },
};
