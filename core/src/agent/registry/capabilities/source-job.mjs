import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { WORKSPACE } from '../../../paths.mjs';
import { siteIdForOrigin } from '../../../site-origin.mjs';
import { ok, fail, CapabilityError } from '../../envelope.mjs';
import { connectEngine, engineFetch } from '../../engine-client.mjs';
import { publicJob } from '../../jobs.mjs';
import { nextForJob } from './jobs.mjs';

export function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function httpOrigin(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new CapabilityError('invalid_args', '地址不是合法 URL'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new CapabilityError('invalid_args', '只接受不含用户名的 HTTP(S) 地址');
  }
  return url.origin;
}

export function siteForTarget(value) {
  const origin = httpOrigin(value);
  try { return { origin, siteId: siteIdForOrigin(WORKSPACE, origin) }; }
  catch (error) { throw new CapabilityError('origin_conflict', String(error?.message ?? error).slice(0, 300)); }
}

export function workspacePath(file) {
  const absolute = resolve(file);
  const rel = relative(WORKSPACE, absolute).replaceAll('\\', '/');
  if (!rel || rel.startsWith('../') || rel === '..') throw new CapabilityError('forbidden', '产物路径越过工作区');
  return { absolute, relative: rel };
}

export function existingWorkspaceJson(file) {
  if (!existsSync(file)) return null;
  const info = workspacePath(file);
  return { ...info, json: readJson(info.absolute) };
}

/**
 * A source-network command exposed through the same durable job facade as clone.
 * The engine owns the legacy task slot; CLI/MCP forward to the engine when they are outside it.
 */
export async function runSourceJob({ capability, args, ctx, plan, finish, runningSummary, doneSummary, nextActions = [] }) {
  if (ctx.jobs) {
    const { job, reused, conflict } = ctx.jobs.create({
      capability, args, plan, finish, idempotencyKey: args.idempotencyKey,
    });
    if (conflict) return fail('idempotency_conflict', '同一个幂等键对应了不同的参数', { details: { jobId: job.jobId } });
    let current = job;
    let timedOut = false;
    if (args.waitMs > 0) ({ job: current, timedOut } = await ctx.jobs.wait(job.jobId, args.waitMs));
    const done = ctx.jobs.TERMINAL.has(current.status);
    const next = done ? (typeof nextActions === 'function' ? nextActions(current) : nextActions) : nextForJob(current);
    return ok({
      status: current.status,
      ...(reused ? { reusedJob: true } : {}),
      plan: { stages: plan.map(stage => stage.name) },
      ...(done ? { result: current.result ?? null } : {}),
      job: publicJob(current),
      ...(args.waitMs ? { timedOut } : {}),
    }, {
      summary: done ? doneSummary(current) : runningSummary,
      nextActions: next,
      jobId: job.jobId,
    });
  }

  const engine = await connectEngine({ start: true, detached: ctx.client === 'mcp' || ctx.detachEngine === true });
  const { data } = await engineFetch(engine.base, `/api/v1/tools/${capability}`, {
    method: 'POST',
    body: args,
    timeoutMs: (args.waitMs ?? 0) + 30_000,
  });
  if (!data || typeof data.ok !== 'boolean') throw new CapabilityError('internal', '引擎返回了意外的结果');
  return data;
}
