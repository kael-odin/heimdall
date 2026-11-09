/**
 * capability: clone —— 取得或刷新镜像（真值），可附带验证（附录 A §2.7，E2-02）
 *
 * 把旧的 recon / forge / queue / verify 入口统一成一个，按 scope × level 调度：
 *   page · mirror    forge
 *   page · verified  forge → verify（单页三视口）
 *   site · mirror    recon → clone-site（增量）
 *   site · verified  recon → clone-site → verify（全站）
 * 门面在引擎里排队执行（旧槽不动）；CLI / MCP 里转发给引擎，引擎没在跑就自起一台。
 * reuse:"auto" 时页面已有镜像就直接复用，不重新抓取。源站脚本、登录态与资源请求可能产生副作用。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../../../paths.mjs';
import { siteIdForOrigin } from '../../../site-origin.mjs';
import { resolvePageNameOfUrl } from '../../../url-canon.mjs';
import { ok, fail, nextAction, CapabilityError } from '../../envelope.mjs';
import { connectEngine, engineFetch } from '../../engine-client.mjs';
import { publicJob } from '../../jobs.mjs';
import { nextForJob } from './jobs.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function parseTarget(url) {
  let u;
  try { u = new URL(url); } catch { throw new CapabilityError('invalid_args', 'url 不是合法的网址'); }
  if (!/^https?:$/.test(u.protocol)) throw new CapabilityError('invalid_args', '只接受 http / https 网址');
  return u;
}

function pageResult(siteId, page) {
  const dir = join(WORKSPACE, siteId, 'pages', page);
  const score = readJson(join(dir, 'score.json'));
  const verify = readJson(join(WORKSPACE, siteId, 'verify', page, 'verify.json'));
  return { page, mirror: existsSync(join(dir, 'clone', 'index.html')), score: score ? { total: score.total, grade: score.grade } : null,
    verify: verify ? { measured: !!verify.measured, overall: verify.overall ?? null, minViewport: verify.minViewport?.name ? { name: verify.minViewport.name, score: verify.minViewport.score } : null } : null };
}

/** 在引擎进程里：生成阶段计划，交给任务门面 */
export function planClone(args) {
  const scope = args.scope, level = args.level;
  let siteId = args.siteId, url = args.url, pageName = args.pageName;
  if (url) {
    const u = parseTarget(url);
    try { siteId = siteIdForOrigin(WORKSPACE, u.href); } catch (error) { throw new CapabilityError('origin_conflict', String(error.message ?? error).slice(0, 200)); }
    if (scope === 'page') pageName ??= resolvePageNameOfUrl(u.href, join(WORKSPACE, siteId));
  }
  if (!siteId) throw new CapabilityError('invalid_args', '需要 url 或 siteId');
  const plan = [];
  if (scope === 'page') {
    if (!url) {
      const target = pageName ? readJson(join(WORKSPACE, siteId, 'pages', pageName, 'manifest.json'))?.target : null;
      if (!target) throw new CapabilityError('invalid_args', 'page 范围需要 url（或已有页面的 siteId + pageName）');
      url = target;
    }
    plan.push({ name: 'forge', route: '/api/forge', body: { url, hostPost: args.siteSummary !== false } });
    if (level === 'verified') plan.push({ name: 'verify', route: '/api/verify', body: (job) => ({ host: siteId, page: job.stages[0].response?.pageName ?? pageName }) });
  } else {
    if (!args.siteOnlyVerify) plan.push({ name: 'recon', route: '/api/recon', body: { url: url ?? `https://${siteId}/`, maxPages: Math.min(80, args.maxPages ?? 40) } });
    if (!args.reconOnly) {
      plan.push({ name: 'clone-site', route: '/api/clone-site', body: args.allDiscovered ? { host: siteId, allDiscovered: true } : { host: siteId, max: args.maxPages ?? 40, incremental: args.incremental !== false, force: !!args.force } });
      if (level === 'verified') plan.push({ name: 'verify', route: '/api/verify', body: { host: siteId } });
    }
  }
  return { siteId, pageName, plan };
}

export function finishClone(siteId, scope, pageName) {
  return (job) => {
    const page = job.stages[0]?.response?.pageName ?? pageName;
    if (scope === 'page' && page) return { siteId, scope, pages: [pageResult(siteId, page)] };
    const pagesDir = join(WORKSPACE, siteId, 'pages');
    const names = existsSync(pagesDir) ? (readJson(join(WORKSPACE, siteId, 'verify', 'verify-summary.json'))?.pages ?? []).map(p => p.page) : [];
    const summary = readJson(join(WORKSPACE, siteId, 'verify', 'verify-summary.json'));
    return { siteId, scope, pages: names.slice(0, 50).map(n => pageResult(siteId, n)),
      coverage: summary ? { measured: summary.measured, unmeasured: summary.unmeasured, average: summary.average } : null };
  };
}

export default {
  id: 'clone',
  title: '克隆：取得镜像（真值）',
  description: 'Get or refresh the frozen mirror of a page or site (the ground truth a rebuild is measured against), optionally followed by '
    + 'multi-viewport verification. scope="page" (default) clones one URL; scope="site" crawls the site then clones up to maxPages pages. '
    + 'level="mirror" captures and builds; "verified" also runs 375/768/1440 verification. With reuse="auto" an existing mirror is reused. '
    + 'Long-running: returns a jobId immediately (or the result if it finishes within waitMs); then call heimdall_jobs with action="wait". '
    + 'Source pages execute scripts and may send state-changing or third-party requests; existing site sessions may be used. '
    + 'Obtain authorization and verify the environment before running.',
  effects: ['source-network', 'browser', 'write-local'], scope: 'clone', idempotent: false, cost: 'heavy', longRunning: true,
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      url: { type: 'string', pattern: '^https?://', maxLength: 2000 },
      siteId: { type: 'string', minLength: 1, maxLength: 253 },
      scope: { type: 'string', enum: ['page', 'site'], default: 'page' },
      level: { type: 'string', enum: ['mirror', 'verified'], default: 'mirror' },
      pageName: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,120}$' },
      maxPages: { type: 'integer', minimum: 1, maximum: 2000, default: 40 },
      allDiscovered: { type: 'boolean', default: false },
      incremental: { type: 'boolean', default: true },
      force: { type: 'boolean', default: false },
      reconOnly: { type: 'boolean', default: false },
      siteSummary: { type: 'boolean', default: true },
      reuse: { type: 'string', enum: ['auto', 'never'], default: 'auto' },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 0 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
    },
  },
  cli: { usage: 'clone <url> [--scope page|site] [--level mirror|verified] [--max-pages N] [--no-wait]', positional: ['url'] },
  async handler(args, ctx) {
    if (!args.url && !args.siteId) throw new CapabilityError('invalid_args', '需要 url 或 siteId');
    if (args.allDiscovered && args.maxPages !== 40) throw new CapabilityError('invalid_args', 'allDiscovered 与 maxPages 不能同时给');
    // reuse:auto —— 单页已有镜像就直接复用
    if (args.scope === 'page' && args.reuse === 'auto' && args.url && args.level === 'mirror') {
      try {
        const u = parseTarget(args.url);
        const siteId = siteIdForOrigin(WORKSPACE, u.href);
        const page = args.pageName ?? resolvePageNameOfUrl(u.href, join(WORKSPACE, siteId));
        if (existsSync(join(WORKSPACE, siteId, 'pages', page, 'clone', 'index.html'))) {
          return ok({ status: 'succeeded', reused: true, siteId, scope: 'page', pages: [pageResult(siteId, page)] }, {
            summary: `${siteId}/${page} 已有镜像，直接复用（要重新抓取用 reuse:"never"）。`,
            nextActions: [nextAction('heimdall_brief', { siteId, page, detail: 'sections' }, '取简报与分段，开始重建')],
          });
        }
      } catch (error) { if (error instanceof CapabilityError) throw error; }
    }
    if (ctx.jobs) {
      const { siteId, pageName, plan } = planClone(args);
      const { job, reused, conflict } = ctx.jobs.create({ capability: 'clone', args, plan, finish: finishClone(siteId, args.scope, pageName), idempotencyKey: args.idempotencyKey });
      if (conflict) return fail('idempotency_conflict', '同一个幂等键对应了不同的参数', { details: { jobId: job.jobId } });
      let current = job, timedOut = false;
      if (args.waitMs > 0) ({ job: current, timedOut } = await ctx.jobs.wait(job.jobId, args.waitMs));
      const pub = publicJob(current);
      const done = ctx.jobs.TERMINAL.has(current.status);
      return ok({ status: current.status, ...(reused ? { reusedJob: true } : {}), plan: { stages: plan.map(s => s.name) }, siteId, ...(done ? { result: current.result ?? null } : {}), job: pub, ...(args.waitMs ? { timedOut } : {}) }, {
        summary: done ? `克隆${current.status === 'succeeded' ? '完成' : '结束：' + current.status}（${siteId}）。` : `已开始克隆 ${siteId}：${plan.map(s => s.name).join(' → ')}。`,
        nextActions: nextForJob(current), jobId: job.jobId,
      });
    }
    // CLI / MCP：交给引擎（必要时自起一台；MCP 与 --no-wait 时引擎空闲后自己退出）
    const engine = await connectEngine({ start: true, detached: ctx.client === 'mcp' || ctx.detachEngine === true });
    const { data } = await engineFetch(engine.base, '/api/v1/tools/clone', { method: 'POST', body: args, timeoutMs: (args.waitMs ?? 0) + 30_000 });
    if (!data || typeof data.ok !== 'boolean') throw new CapabilityError('internal', '引擎返回了意外的结果');
    return data;
  },
};
