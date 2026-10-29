/**
 * capability: qa_findings —— 看发现、查重、提交、裁决
 *
 * 一个工具五个动作，免得 agent 面对一堆零碎工具：
 *   list     某次运行的发现（默认最新一次；可按状态筛）
 *   show     一条发现的全部证据
 *   similar  提交前查重：台账与以往运行里有没有相似的，当时怎么判的
 *   submit   把 agent 自己测出的问题写进运行（校验证据门槛、自动降级、拒收推测）
 *   verdict  记一条裁决（人说了算；agent 只在用户明确表态后代记）；之后报告自动重出
 *   revoke   撤销一条裁决规则
 *   rules    列出已记的裁决规则
 */
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { readRun, submitFindings, retriageRun, allRules, relPath } from '../../../qa/run.mjs';
import { recordVerdict, revokeVerdict } from '../../../qa/memory.mjs';
import { findSimilar } from '../../../qa/ledger.mjs';
import { fileable } from '../../../qa/report.mjs';
import { VERDICTS, VERDICT_LABEL, oneLine } from '../../../qa/findings.mjs';
import { WORKSPACE_ARG, wsOrError } from './qa-status.mjs';

const FINDING = {
  type: 'object', additionalProperties: false, required: ['title', 'basis', 'evidence'],
  properties: {
    title: { type: 'string', minLength: 4, maxLength: 160, description: 'One plain sentence a developer understands without context' },
    path: { type: 'string', pattern: '^/', maxLength: 500 }, url: { type: 'string', maxLength: 2000 },
    basis: { type: 'string', enum: ['failed', 'wrong', 'promise', 'friction', 'cosmetic'] },
    tier: { type: 'string', enum: ['wall', 'degrade', 'tolerable'] },
    loss: { type: 'string', maxLength: 300, description: 'Who, doing what, lost what. Required for wall/degrade. No speculative words.' },
    expected: { type: 'string', maxLength: 400 }, observed: { type: 'string', maxLength: 600 },
    prd: { type: 'string', maxLength: 300 }, target: { type: 'string', maxLength: 300, description: 'Selector, API path or UI label' },
    repro: { type: 'array', items: { type: 'string', maxLength: 300 }, maxItems: 12 },
    viewport: { type: 'string', maxLength: 20 },
    evidence: { type: 'object', additionalProperties: true, description: 'At least one of observed / steps / screenshot (workspace-relative path)' },
  },
};

const brief = (f) => ({ id: f.id, fingerprint: f.fingerprint, tier: f.tier, basis: f.basis, kind: f.kind, path: f.path, title: f.title,
  triage: f.triage?.status, ...(f.triage?.reason ? { reason: f.triage.reason } : {}), fileable: fileable(f), source: f.source });

export default {
  id: 'qa_findings',
  title: '发现：查看、查重、提交、裁决',
  description: 'Work with test findings. action="list" lists findings of a run (default latest; filter by status fileable|new|suppressed|known-bug|all). '
    + 'action="show" returns one finding with all evidence. action="similar" searches the existing issue ledger and past runs for similar problems '
    + 'and how they were judged; call it before submitting. action="submit" adds findings you tested yourself to a run: each needs title, basis and '
    + 'evidence; wall/degrade also need a measured loss; speculative loss is rejected, cosmetic is capped at tolerable, duplicates are rejected. '
    + 'action="verdict" records the human decision for a finding (bug | false-positive | convention | deferred | by-design | wont-fix | env) with a '
    + 'reason; with pattern=true it becomes a rule for the whole class (same kind + text on the site). Only record verdicts the user stated. '
    + 'Reports are re-rendered after submit and verdict. action="revoke" removes a rule; action="rules" lists rules.',
  effects: ['read', 'write-local'], scope: 'build', idempotent: false, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      workspace: WORKSPACE_ARG,
      action: { type: 'string', enum: ['list', 'show', 'similar', 'submit', 'verdict', 'revoke', 'rules'] },
      runId: { type: 'string', maxLength: 40, description: 'Run id, or "latest" (default)' },
      id: { type: 'string', maxLength: 40, description: 'Finding id (F3) or fingerprint (fp_…)' },
      status: { type: 'string', enum: ['fileable', 'new', 'suppressed', 'known-bug', 'all'], default: 'fileable' },
      title: { type: 'string', maxLength: 300, description: 'similar: the problem you are about to report' },
      text: { type: 'string', maxLength: 1000 },
      path: { type: 'string', maxLength: 500 },
      findings: { type: 'array', items: FINDING, minItems: 1, maxItems: 30 },
      verdict: { type: 'string', enum: VERDICTS },
      reason: { type: 'string', minLength: 2, maxLength: 500 },
      pattern: { type: 'boolean', default: false, description: 'verdict: apply to the class of finding, not just this one' },
      match: { type: 'object', additionalProperties: false, description: 'verdict: explicit match instead of a finding id',
        properties: { kind: { type: 'string' }, site: { type: 'string' }, path: { type: 'string' }, pathPrefix: { type: 'string' }, text: { type: 'string' }, target: { type: 'string' }, environment: { type: 'string' } } },
      until: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'verdict=deferred: report again after this date' },
      reopenIf: { type: 'string', maxLength: 300 },
      ruleId: { type: 'string', maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    },
  },
  cli: { usage: 'qa findings [--status all] | qa show F3 | qa similar "标题" | qa submit file.json | qa verdict F3 <裁决> "理由" [--pattern] | qa rules', positional: [] },
  async handler(args, ctx) {
    const ws = wsOrError(args, ctx);
    const pick = (findings) => {
      const f = findings.find(x => x.id === args.id || x.fingerprint === args.id);
      if (!f) throw new CapabilityError('not_found', `这次运行里没有 ${args.id}`, { hint: '先 action="list" 看编号' });
      return f;
    };
    try {
      switch (args.action) {
        case 'list': {
          const { run, findings } = readRun(ws, args.runId);
          const sel = findings.filter(f => args.status === 'all' ? true : args.status === 'fileable' ? fileable(f) : f.triage?.status === args.status);
          return ok({ runId: run.runId, site: run.site, summary: run.summary, findings: sel.slice(0, args.limit).map(brief), total: sel.length },
            { summary: `${run.runId}：${args.status} ${sel.length} 条。\n` + sel.slice(0, 8).map(f => `${f.id} ${oneLine(f)}`).join('\n') });
        }
        case 'show': {
          const { run, findings } = readRun(ws, args.runId);
          const f = pick(findings);
          return ok({ runId: run.runId, finding: f, similar: findSimilar(ws, { title: f.title, path: f.path, limit: 3 }).filter(s => s.fingerprint !== f.fingerprint) },
            { summary: `${f.id} ${oneLine(f)}`, nextActions: [nextAction('heimdall_qa_findings', { action: 'verdict', id: f.id, verdict: 'bug', reason: '…' }, '用户确认后记下裁决')] });
        }
        case 'similar': {
          if (!args.title && !args.text) throw new CapabilityError('invalid_args', 'similar 需要 title 或 text');
          const hits = findSimilar(ws, { title: args.title, text: args.text, path: args.path, limit: Math.min(args.limit, 10) });
          const summary = hits.length ? `找到 ${hits.length} 条相似：\n` + hits.map(h => `${h.id}（${h.score}）${h.status}：${h.title}${h.reason ? ` —— ${h.reason}` : ''}`).join('\n') : '没有相似的历史问题。';
          return ok({ hits }, { summary });
        }
        case 'submit': {
          if (!args.findings?.length) throw new CapabilityError('invalid_args', 'submit 需要 findings');
          const r = submitFindings(ws, args.runId, args.findings, { by: ctx.client === 'cli' ? 'human' : 'agent' });
          const summary = `收下 ${r.added.length} 条${r.rejected.length ? `，退回 ${r.rejected.length} 条：` + r.rejected.map(x => `「${x.title ?? '#' + x.index}」${x.problems.join('；')}`).join(' / ') : ''}。`
            + (r.added.some(f => f.triage?.status === 'suppressed') ? ` 其中 ${r.added.filter(f => f.triage?.status === 'suppressed').length} 条命中以往裁决，已过滤。` : '');
          return ok({ runId: r.run.runId, added: r.added.map(brief), rejected: r.rejected, report: relPath(ws, r.files.report), bugs: relPath(ws, r.files.bugs) }, { summary });
        }
        case 'verdict': {
          if (!args.verdict || !args.reason) throw new CapabilityError('invalid_args', 'verdict 需要 verdict 和 reason');
          let match = args.match, run;
          if (!match) {
            if (!args.id) throw new CapabilityError('invalid_args', 'verdict 需要 id（发现编号）或 match');
            const r = readRun(ws, args.runId);
            run = r.run;
            const f = pick(r.findings);
            match = args.pattern
              ? { kind: f.kind, site: f.site, text: f.kind === 'agent' || f.kind === 'assertion' ? f.title : (f.target ?? f.title) }
              : { fingerprint: f.fingerprint };
          }
          const rule = recordVerdict(ws.dataDir, { verdict: args.verdict, reason: args.reason, match, until: args.until, reopenIf: args.reopenIf, by: ctx.client === 'cli' ? 'human' : 'agent' });
          const re = retriageRun(ws, args.runId ?? run?.runId);
          return ok({ rule, runId: re.run.runId, summary: re.run.summary, report: relPath(ws, re.files.report) },
            { summary: `记下：${VERDICT_LABEL[rule.verdict]} —— ${rule.reason}（规则 ${rule.id}）。报告已更新：建议提单 ${re.run.summary.fileable} 条。` });
        }
        case 'revoke': {
          if (!args.ruleId) throw new CapabilityError('invalid_args', 'revoke 需要 ruleId');
          revokeVerdict(ws.dataDir, args.ruleId, args.reason ?? '');
          const re = retriageRun(ws, args.runId);
          return ok({ revoked: args.ruleId, summary: re.run.summary }, { summary: `已撤销 ${args.ruleId}，报告已更新。` });
        }
        case 'rules': {
          const rules = allRules(ws);
          return ok({ rules }, { summary: `${rules.length} 条规则。\n` + rules.slice(-10).map(r => `${r.id} ${VERDICT_LABEL[r.verdict]}：${r.reason}`).join('\n') });
        }
        default: throw new CapabilityError('invalid_args', `未知动作 ${args.action}`);
      }
    } catch (e) {
      if (e instanceof CapabilityError) throw e;
      if (e.code === 'invalid_args' || e.code === 'not_found') throw new CapabilityError(e.code, e.message);
      throw e;
    }
  },
};
