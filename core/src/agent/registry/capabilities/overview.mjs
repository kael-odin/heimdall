/**
 * capability: overview —— 「从这里开始」（附录 A §2.1，E2-02、E11-06）
 *
 * 引擎健康、站点清单、进行中和排队的任务、可用能力、建议的下一步。
 * 引擎不可达时照样列出磁盘上的站点，engine.status 标 unreachable（读类能力不需要引擎，E3-07）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE_ROOT, DATA_ROOT } from '../../../paths.mjs';
import { ok, nextAction } from '../../envelope.mjs';
import { engineFetch, probeEngine, readEngineState } from '../../engine-client.mjs';
import { listSites } from '../../workspace.mjs';

const VERSION = (() => { try { return JSON.parse(readFileSync(join(CORE_ROOT, 'package.json'), 'utf8')).version; } catch { return null; } })();

export async function engineSummary() {
  const bases = [...new Set([process.env.HEIMDALL_API, readEngineState()?.base, 'http://127.0.0.1:8900'].filter(Boolean))];
  let mismatch = null;
  for (const base of bases) {
    const p = await probeEngine(base);
    if (!p) continue;
    if (p.unauthorized) return { status: 'unauthorized', base };
    if (!p.sameRoot) { mismatch = { status: 'data_root_mismatch', base, engineDataRoot: p.dataRoot }; continue; }
    const s = p.status;
    const running = Object.fromEntries(['recon', 'audit', 'watch', 'assets', 'matrix', 'verify', 'acceptance', 'live', 'session', 'upgrade', 'clone']
      .filter(k => s[k]).map(k => [k, s[k]]));
    return { status: 'ok', base: p.base, version: VERSION, dataRoot: s.dataRoot, bind: s.bind, auth: !!s.auth, jobsStore: s.jobsStore,
      forge: s.forge, running };
  }
  return mismatch ?? { status: 'unreachable', version: VERSION, dataRoot: DATA_ROOT };
}

export default {
  id: 'overview',
  title: '总览：从这里开始',
  description: 'Start here. Returns engine health, the sites already cloned on this machine (siteId, page counts), running and queued jobs, '
    + 'the capabilities you can call, and suggested next steps. Use at the beginning of a session or whenever unsure what to do next. '
    + 'Read-only; works even when the engine is not running (engine.status = "unreachable").',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      include: { type: 'array', items: { type: 'string', enum: ['engine', 'sites', 'jobs', 'capabilities'] }, description: 'Sections to include (default all)' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 25, description: 'Max sites to list, most-cloned first' },
    },
  },
  cli: { usage: 'overview [--limit N]', positional: [] },
  async handler(args, ctx) {
    const inc = new Set(args.include ?? ['engine', 'sites', 'jobs', 'capabilities']);
    const result = {};
    const engine = inc.has('engine') || inc.has('jobs') ? await engineSummary() : null;
    if (inc.has('engine')) result.engine = engine;
    let sites = [];
    if (inc.has('sites')) {
      sites = listSites();
      result.sites = sites.slice(0, args.limit);
      result.totalSites = sites.length;
    }
    if (inc.has('jobs')) {
      result.jobs = [];
      if (ctx.jobs) result.jobs = ctx.jobs.list({ limit: 20 }).filter(j => !ctx.jobs.TERMINAL.has(j.status)).map(j => ({ jobId: j.jobId, capability: j.capability, status: j.status, createdAt: j.createdAt }));
      else if (engine?.status === 'ok') {
        const { data } = await engineFetch(engine.base, '/api/v1/jobs?active=1', { timeoutMs: 3000 }).catch(() => ({ data: null }));
        result.jobs = data?.result?.jobs ?? [];
      }
    }
    if (inc.has('capabilities')) {
      const { describeCapabilities } = await import('../index.mjs');
      result.capabilities = describeCapabilities().map(c => ({ id: c.id, tool: c.tool, effects: c.effects, scope: c.scope }));
    }
    const nextActions = [];
    if (inc.has('sites') && !sites.length) nextActions.push(nextAction('heimdall_clone', { url: '<page url>' }, '本机还没有站点：先克隆一页作为参考'));
    else if (sites[0]) nextActions.push(nextAction('heimdall_site', { siteId: sites[0].siteId }, '查看站点的页面与缺口'));
    if (engine && engine.status !== 'ok') nextActions.push(nextAction('heimdall_doctor', null, '引擎不可用，自检并按提示修复'));
    const parts = [];
    if (engine) parts.push(engine.status === 'ok' ? '引擎正常' : engine.status === 'unreachable' ? '引擎没在跑（读类工具照常可用）' : `引擎不可用：${engine.status}`);
    if (inc.has('sites')) parts.push(`${sites.length} 个站点`);
    if (inc.has('jobs')) parts.push(result.jobs.length ? `${result.jobs.length} 个任务进行中` : '没有进行中的任务');
    return ok(result, { summary: parts.join('；') + '。', nextActions });
  },
};
