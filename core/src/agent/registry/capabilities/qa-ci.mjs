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
      description: 'Findings at or above this tier fail the gate: all | wall | degrade | none',
    },
    maxFindings: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      default: 0,
      description: 'Allow at most this many findings through the gate; the default allows none',
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
  title: 'QA CI：运行只读巡检并执行门禁',
  description: 'Run the same read-only QA workspace as qa_run, then apply a deterministic CI gate. '
    + 'It writes qa-ci.json and qa-ci.md beside the normal report, returns GitHub Actions annotations, '
    + 'and uses stable exit codes for CI. failOn controls whether all fileable findings, wall/degrade only, '
    + 'or a limited number of findings fail the gate. This does not replace human acceptance and never turns '
    + 'a network or environment failure into a product bug.',
  effects: ['browser', 'source-network', 'write-local'],
  scope: 'clone',
  idempotent: false,
  cost: 'heavy',
  input: QA_CI_INPUT,
  cli: { usage: 'qa-ci [site] [--pages /a,/b] [--viewports 1440,390] [--fail-on all|wall|degrade|none] [--max-findings N] [--github]', positional: ['site'] },
  async handler(args, ctx) {
    const { failOn = 'all', maxFindings = 0, github = false, ...qaArgs } = args ?? {};
    const result = await runQaCi({
      args: qaArgs,
      failOn: String(failOn),
      maxFindings: Number(maxFindings),
      github: github === true,
      client: ctx.client ?? 'cli',
      onProgress: ctx.onProgress,
    });
    return result.env;
  },
};
