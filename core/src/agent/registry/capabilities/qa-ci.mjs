/**
 * capability: qa_ci —— 运行一次只读 QA，并给出可机器消费的 CI 门禁结果
 *
 * 它刻意复用 qa_run 的输入与执行器，不复制浏览器测试实现。CLI 的
 * `heimdall qa ci`、MCP 的 `heimdall_qa_ci` 和 HTTP v1 最终拿到的是同一份
 * qa-ci.json / qa-ci.md 和同一组 GitHub Actions 注解。
 */
import qaRun from './qa-run.mjs';
import { WORKSPACE_ARG } from './qa-status.mjs';
import { FAIL_ON, runQaCi } from '../../../qa/ci.mjs';

const QA_CI_INPUT = {
  ...qaRun.input,
  properties: {
    ...qaRun.input.properties,
    workspace: WORKSPACE_ARG,
    failOn: {
      type: 'string',
      enum: FAIL_ON,
      default: 'all',
      description: 'Findings at or above this tier fail the gate: all | wall | degrade | none. Expired login, client-blocked resources, an unverified check, or a detector failure makes the run incomplete even with none.',
    },
    maxFindings: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      default: 0,
      description: 'Allow at most this many findings through the gate; the default allows none',
    },
    requireBaseline: {
      type: 'boolean',
      default: false,
      description: 'Require an approved baseline comparison for every requested page and viewport. Missing, mismatched or disabled baselines make the gate incomplete.',
    },
    github: {
      type: 'boolean',
      default: false,
      description: 'Append the CI summary to GITHUB_STEP_SUMMARY when set by GitHub Actions',
    },
  },
};

export default {
  id: 'qa_ci',
  title: 'QA CI：运行巡检并执行门禁',
  description: 'Run the same QA workspace as qa_run, then apply a deterministic CI gate. '
    + 'Its HTTP policy may permit writes; GET and WebSocket may also cause side effects. '
    + 'It writes qa-ci.json and qa-ci.md beside the normal report, returns GitHub Actions annotations, '
    + 'and uses stable exit codes for CI. failOn controls whether all fileable findings, wall/degrade only, '
    + 'or a limited number of findings fail the gate. This does not replace human acceptance and never turns '
    + 'an expired login, client-blocked resources, an unverified check, or a detector failure into a product bug or a passing run; it returns qa_incomplete instead.',
  effects: ['browser', 'source-network', 'write-local'],
  scope: 'clone',
  idempotent: false,
  cost: 'heavy',
  input: QA_CI_INPUT,
  cli: { usage: 'qa-ci [site] [--pages /a,/b] [--viewports 1440,390] [--require-baseline] [--fail-on all|wall|degrade|none] [--max-findings N] [--github]', positional: ['site'] },
  async handler(args, ctx) {
    const { failOn = 'all', maxFindings = 0, requireBaseline = false, github = false, ...qaArgs } = args ?? {};
    const result = await runQaCi({
      args: qaArgs,
      failOn: String(failOn),
      maxFindings: Number(maxFindings),
      requireBaseline: requireBaseline === true,
      github: github === true,
      client: ctx.client ?? 'cli',
      onProgress: ctx.onProgress,
    });
    return result.env;
  },
};
