/**
 * heimdall gate baseline —— 正式基线供给与体检（E7-19，PRD 05 §1.5）
 *
 *   heimdall gate baseline <siteId> <page> [--viewport 1440] [--json]
 *
 * 起一个只读、回环、随机端口、无令牌、不加 CSP 的静态服务供基线；体检不过就先做
 * 「正式基线副本」（去掉外部请求与断链引用）再体检一次。结果写
 * workspace/<siteId>/agent/gate/<page>/baseline.json：healthy / sanitized / blocked。
 */
import { ok, fromError, exitCodeOf, nextAction, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';
import { launchBrowser } from '../evidence/capture.mjs';
import { prepareBaseline } from '../gate/baseline.mjs';

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const json = !!flags.json;
  const [sub, siteId, page] = positional;
  let env;
  if (sub !== 'baseline' || !siteId || !page) {
    env = { ok: false, error: { code: 'invalid_args', message: '用法：heimdall gate baseline <siteId> <page> [--viewport 1440]', hint: 'siteId 与页面名见 `heimdall overview` / `heimdall site <siteId>`' } };
  } else {
    let browser;
    try {
      browser = await launchBrowser();
      const r = await prepareBaseline(browser, { siteId, page, viewport: Number(flags.viewport ?? 1440) });
      const warnings =(r.status === 'sanitized' ? r.sanitizedProbe : r.probe).issues.filter(i => i.severity === 'warn')
        .map(i => ({ code: i.code, message: i.detail }));
      const summary = r.status === 'healthy'
        ? `正式基线健康：${siteId}/${page} 没有外部请求，也没有本地失败（${r.probe.stats.requests} 个请求）。`
        : r.status === 'sanitized'
          ? `镜像不健康（原体检 ${r.probe.issues.filter(i => i.severity === 'error').length} 项错误），已生成正式基线副本：${r.sanitized.changes.length} 处改动，副本体检通过。`
          : `镜像与副本都不健康，这一维将记 blocked（不是失败）：${r.reason}`;
      env = ok({ siteId, page, status: r.status, dir: r.dir, reportPath: r.reportPath, evidence: r.evidence, probe: r.probe, sanitizedProbe: r.sanitizedProbe ?? null,
        changes: r.sanitized?.changes ?? [] }, {
        summary,
        nextActions: r.status === 'blocked'
          ? [nextAction('heimdall_clone', { siteId, pageName: page, force: true }, '重新克隆这一页，或在报告里标 blocked 继续')]
          : [nextAction('heimdall_compare', { siteId, page }, '基线就绪，下一次正式门禁可用它')],
        warnings: [...warnings, ...(r.sanitized?.changes?.length ? [{ code: 'baseline_sanitized', message: `副本改动 ${r.sanitized.changes.length} 处，明细在 ${r.reportPath}` }] : [])],
      });
    } catch (error) {
      env = fromError(error);
    } finally {
      await browser?.close().catch(() => {});
    }
  }
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
    if (env.ok) {
      const p = env.result.status === 'sanitized' ? env.result.sanitizedProbe : env.result.probe;
      for (const i of p.issues.slice(0, 12)) process.stdout.write(`${i.severity === 'error' ? '✗' : '!'} ${i.code.padEnd(22)} ${i.detail}\n`);
    }
    for (const w of env.warnings ?? []) process.stdout.write(`! ${w.message}\n`);
  }
  return exitCodeOf(env);
}

export { CapabilityError };
