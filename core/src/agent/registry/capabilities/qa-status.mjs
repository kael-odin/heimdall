/**
 * capability: qa_status —— 测试工作区的状态与测试须知
 *
 * agent 开始测试前先调它：拿到站点、登录档状态、最近几次运行，以及「测试须知」——
 * 分诊规则、团队约定、台账里被人工推翻或暂缓过的条目（教训）、已记的裁决规则。
 */
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { openWorkspace, listRuns } from '../../../qa/run.mjs';
import { describeLogin, resolveLogin } from '../../../qa/workspace.mjs';
import { guidance, readLedger } from '../../../qa/ledger.mjs';

export const WORKSPACE_ARG = { type: 'string', minLength: 1, maxLength: 1000, description: 'Test workspace directory containing .heimdall/qa.json. Defaults to HEIMDALL_QA_WORKSPACE, then the directory the command was run from (searching upward).' };

export function wsOrError(args, ctx) {
  try { return openWorkspace(args.workspace, ctx); }
  catch (e) { throw new CapabilityError(e.code === 'not_found' ? 'not_found' : 'invalid_args', e.message, { hint: '在测试工作区运行 `heimdall qa init`，或在 MCP 配置里设置 HEIMDALL_QA_WORKSPACE' }); }
}

function loginHealth(ws, name) {
  const d = describeLogin(ws, name);
  try {
    const r = resolveLogin(ws, name);
    const expired = r.expiresAt && Date.parse(r.expiresAt) < Date.now();
    return { ...d, ready: !expired, expiresAt: r.expiresAt, ...(expired ? { problem: '已过期' } : {}) };
  } catch (e) { return { ...d, ready: false, problem: e.message }; }
}

export default {
  id: 'qa_status',
  title: '测试工作区：站点、登录档与测试须知',
  description: 'Start here for testing work. Reads the test workspace (.heimdall/qa.json): sites with their URLs, pages and environment, login '
    + 'profiles and whether each is ready or expired (never their values), recent test runs, and the testing guidance: triage rules (evidence '
    + 'level decides the highest severity; cosmetic is at most tolerable; wall/degrade need a measured loss without speculative words), team '
    + 'conventions that must not be reported, lessons from the existing issue ledger (findings humans closed as not reproducible, out of scope or '
    + 'deferred, with the reason), and recorded verdict rules. Read the guidance before testing and before submitting any finding.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      workspace: WORKSPACE_ARG,
      guidance: { type: 'boolean', default: true, description: 'Include the testing guidance block' },
    },
  },
  cli: { usage: 'qa status [--workspace DIR]', positional: [] },
  async handler(args, ctx) {
    const ws = wsOrError(args, ctx);
    const sites = Object.values(ws.sites).map(s => ({ name: s.name, label: s.label, url: s.url, environment: s.environment, pages: s.pages.map(p => p.path), login: s.login, writes: s.writes }));
    const logins = Object.keys(ws.logins).map(n => loginHealth(ws, n));
    const runs = listRuns(ws, 5).map(r => ({ runId: r.runId, site: r.site, startedAt: r.startedAt, summary: r.summary }));
    const ledger = readLedger(ws);
    const result = { project: ws.project, root: ws.root, sites, logins, runs,
      ledger: ws.ledger?.file ? { file: ws.ledger.file, entries: ledger.length, open: ledger.filter(e => e.status === 'open').length } : null,
      ...(args.guidance ? { guidance: guidance(ws) } : {}) };
    const broken = logins.filter(l => !l.ready);
    const summary = `${ws.project}：${sites.length} 个站点，${logins.length} 个登录档${broken.length ? `（${broken.map(l => `${l.name} ${l.problem}`).join('；')}）` : ''}，最近运行 ${runs.length} 次`
      + (result.ledger ? `，台账 ${result.ledger.entries} 条（未解决 ${result.ledger.open}）` : '') + '。';
    const nextActions = [
      ...broken.filter(l => l.kind === 'storageState').map(l => nextAction('cli:shell', { command: `heimdall qa login ${l.name}` }, `登录档 ${l.name} 需要人工登录一次`)),
      nextAction('heimdall_qa_run', { site: sites[0].name }, `测一遍 ${sites[0].label}`),
    ];
    return ok(result, { summary, nextActions });
  },
};
