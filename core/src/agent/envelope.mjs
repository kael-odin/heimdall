/**
 * agent/envelope — 所有能力的统一返回（PRD 附录 C §1）与错误码表（附录 A §1.5、§1.6）
 *
 * CLI 的 `--json` 最后一行、MCP 的 structuredContent、HTTP v1 的响应体都是同一个信封。
 * 错误码同时决定 HTTP 状态与 CLI 退出码，所以只在这里定义一次（E1-06、E3-03、E5-04）。
 *
 * `summary`、`nextActions[].reason`、`error.hint` 由 Heimdall 的模板与 ID 组成，
 * **不拼接网页字符串**（PRD 08 §3.2(d)）：否则等于在围栏外给提示注入开口子。
 */

/** code → { http, exit, hint }；hint 必须可执行（一条命令或一次工具调用） */
export const ERRORS = Object.freeze({
  invalid_args: { http: 400, exit: 2, hint: '对照入参修正；`heimdall --help --json` 查看每个命令的参数 schema' },
  unauthorized: { http: 401, exit: 5, hint: '设置 HEIMDALL_TOKEN 或加 --token' },
  forbidden: { http: 403, exit: 5, hint: '换用作用域更高的令牌；破坏性能力需 admin 令牌加本机确认' },
  not_found: { http: 404, exit: 2, hint: '`heimdall site <siteId>` 或 `heimdall overview` 列出已有站点与页面' },
  engine_unreachable: { http: 503, exit: 3, hint: '`heimdall serve` 起引擎，或 `heimdall doctor` 排查' },
  data_root_mismatch: { http: 409, exit: 3, hint: '统一 HEIMDALL_DATA_DIR，或停掉另一个引擎' },
  chromium_missing: { http: 503, exit: 3, hint: '`pnpm -C core exec playwright install chromium`，或 `heimdall doctor --fix`' },
  queued: { http: 202, exit: 4, hint: '`heimdall jobs wait <jobId>` 继续等，或 `heimdall jobs cancel <jobId>`' },
  idempotency_conflict: { http: 409, exit: 2, hint: '换一个幂等键，或用原来的参数重试' },
  budget_exceeded: { http: 429, exit: 6, hint: '停下来，向用户说明用量并请求调高预算' },
  render_not_settled: { http: 422, exit: 1, hint: '检查长轮询请求或懒加载；必要时改用 --allow-bounded' },
  origin_conflict: { http: 409, exit: 2, hint: '用落地后的 origin 重试，或指定 sibling siteId' },
  candidate_unreachable: { http: 502, exit: 2, hint: '启动 heimdall.config.json 里的 devServer.command，确认 devServer.url 能打开' },
  reference_missing: { http: 412, exit: 2, hint: '先 `heimdall clone <url>` 取得镜像，再重试' },
  gate_failed: { http: 422, exit: 1, hint: '按修复包修复后重新 compare' },
  timeout: { http: 504, exit: 4, hint: '用 --no-wait 拿 jobId，再 `heimdall jobs wait <jobId>`' },
  internal: { http: 500, exit: 7, hint: '附上 meta.requestId 反馈；先运行 `heimdall doctor` 自检' },
});

/** 能力内部抛它；外壳（CLI / MCP / HTTP）统一转成 ok:false 的信封 */
export class CapabilityError extends Error {
  constructor(code, message, { hint, details, retryable, result, nextActions } = {}) {
    super(message);
    this.code = ERRORS[code] ? code : 'internal';
    this.hint = hint;
    this.details = details;
    this.retryable = retryable;
    this.result = result;
    this.nextActions = nextActions;
  }
}

export const nextAction = (tool, args, reason) => ({ tool, ...(args ? { args } : {}), reason });

export function ok(result, { summary, nextActions = [], evidence = [], jobId, warnings, meta, trust, redactions } = {}) {
  return {
    ok: true,
    result: result ?? {},
    summary: summary ?? '完成。',
    nextActions,
    ...(jobId ? { jobId } : {}),
    evidence,
    ...(warnings?.length ? { warnings } : {}),
    ...(meta ? { meta } : {}),
    ...(trust ? { trust } : {}),
    ...(redactions ? { redactions } : {}),
  };
}

export function fail(code, message, { hint, details, retryable, result, nextActions = [], summary, meta, warnings } = {}) {
  const known = ERRORS[code] ? code : 'internal';
  return {
    ok: false,
    ...(result ? { result } : {}),
    error: {
      code: known,
      message: String(message ?? known).slice(0, 300),
      hint: hint ?? ERRORS[known].hint,
      ...(retryable !== undefined ? { retryable } : {}),
      ...(details ? { details } : {}),
    },
    summary: summary ?? String(message ?? known).slice(0, 200),
    nextActions,
    evidence: [],
    ...(warnings?.length ? { warnings } : {}),
    ...(meta ? { meta } : {}),
  };
}

export function fromError(error) {
  if (error instanceof CapabilityError) {
    return fail(error.code, error.message, { hint: error.hint, details: error.details, retryable: error.retryable,
      result: error.result, nextActions: error.nextActions ?? [] });
  }
  // 未预期的异常：不把堆栈和本机路径交给代理（PRD 02 T4）
  return fail('internal', '内部错误：' + String(error?.message ?? error).split('\n')[0].slice(0, 160));
}

/** CLI 退出码（附录 A §1.6）：--no-wait 拿到 jobId 是成功（0）；等待中超时或仍在排队是 4 */
export function exitCodeOf(envelope) {
  if (!envelope) return 7;
  if (envelope.ok) {
    if (envelope.result?.timedOut || envelope.result?.status === 'queued') return 4;
    if (envelope.result?.gateFailed) return 1;
    return 0;
  }
  return ERRORS[envelope.error?.code]?.exit ?? 7;
}

export const httpStatusOf = (envelope) => envelope.ok
  ? (envelope.jobId && envelope.result?.status && !['succeeded', 'failed', 'cancelled'].includes(envelope.result.status) ? 202 : 200)
  : (ERRORS[envelope.error?.code]?.http ?? 500);
