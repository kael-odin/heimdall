/**
 * heimdall gate —— 正式基线与门禁报告（E7-06、E7-19，PRD 05 §1.5）
 *
 *   heimdall gate baseline <siteId> <page> [--viewport 1440] [--json]
 *   heimdall gate report [--project .] [--level bronze|silver|gold] [--viewports 375,768,1440] [--json]
 *
 * baseline：起一个只读、回环、随机端口、无令牌、不加 CSP 的静态服务供基线；体检不过就先做
 * 「正式基线副本」（去掉外部请求与断链引用）再体检一次。结果写
 * workspace/<siteId>/agent/gate/<page>/baseline.json：healthy / sanitized / blocked。
 *
 * report：对重建工作区跑一次快速对比，按六个维度出一份 `heimdall.gate/1` 报告，
 * 写 workspace/<siteId>/agent/gate/<page>/gate-<runId>.json；未通过时退出码 1（CI 用）。
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ok, fail, fromError, exitCodeOf, nextAction } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';
import { launchBrowser } from '../evidence/capture.mjs';
import { fastCompare, readProjectConfig } from '../evidence/compare.mjs';
import { prepareBaseline } from '../gate/baseline.mjs';
import { composeGate, gateText } from '../gate/report.mjs';
import { formalGate } from '../gate/formal.mjs';
import { agentDir } from '../workspace.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';

async function baseline(flags, positional) {
  const siteId = positional[1], page = positional[2];
  if (!siteId || !page) return fail('invalid_args', '用法：heimdall gate baseline <siteId> <page> [--viewport 1440]', { hint: 'siteId 与页面名见 `heimdall overview` / `heimdall site <siteId>`' });
  let browser;
  try {
    browser = await launchBrowser();
    const r = await prepareBaseline(browser, { siteId, page, viewport: Number(flags.viewport ?? 1440) });
    const warnings = (r.status === 'sanitized' ? r.sanitizedProbe : r.probe).issues.filter(i => i.severity === 'warn').map(i => ({ code: i.code, message: i.detail }));
    const summary = r.status === 'healthy'
      ? `正式基线健康：${siteId}/${page} 没有外部请求，也没有本地失败（${r.probe.stats.requests} 个请求）。`
      : r.status === 'sanitized'
        ? `镜像不健康（原体检 ${r.probe.issues.filter(i => i.severity === 'error').length} 项错误），已生成正式基线副本：${r.sanitized.changes.length} 处改动，副本体检通过。`
        : `镜像与副本都不健康，这一维将记 blocked（不是失败）：${r.reason}`;
    return ok({ siteId, page, status: r.status, dir: r.dir, reportPath: r.reportPath, evidence: r.evidence, probe: r.probe, sanitizedProbe: r.sanitizedProbe ?? null,
      changes: r.sanitized?.changes ?? [] }, {
      summary,
      nextActions: r.status === 'blocked'
        ? [nextAction('heimdall_clone', { siteId, pageName: page, force: true }, '重新克隆这一页，或在报告里标 blocked 继续')]
        : [nextAction('heimdall_compare', { siteId, page }, '基线就绪，下一次正式门禁可用它')],
      warnings: [...warnings, ...(r.sanitized?.changes?.length ? [{ code: 'baseline_sanitized', message: `副本改动 ${r.sanitized.changes.length} 处，明细在 ${r.reportPath}` }] : [])],
    });
  } catch (error) {
    return fromError(error);
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function report(flags) {
  const dir = resolve(String(flags.project === true || !flags.project ? '.' : flags.project));
  try {
    const cfg = readProjectConfig(dir);
    const page = cfg.pages?.[0]?.name;
    const level = String(flags.level ?? cfg.gate?.level ?? 'silver');
    const viewports = flags.viewports ? String(flags.viewports).split(',').map(Number) : cfg.viewports;
    const r = await fastCompare({ candidate: { dir }, siteId: cfg.siteId, page, viewports }, {});
    const gate = composeGate(r.packet, { level, thresholds: cfg.gate?.thresholds ?? null });
    const outDir = join(agentDir(cfg.siteId), 'gate', page);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `gate-${r.packet.runId}.json`);
    const body = JSON.stringify(gate, null, 1) + '\n';
    writeFileAtomic(file, body);
    const result = { ...gate, reportPath: file, runId: r.packet.runId, fixpacketPath: join(r.outDir ?? '', 'fixpacket.json') };
    const hint = gate.status === 'passed'
      ? undefined
      : `按修复包把没过的维度改掉再跑：${(r.packet.order ?? []).slice(0, 3).join('、') || '看 gate.json 里的 notes'}`;
    return ok(result, {
      summary: gateText(gate) + `\n报告：${file}`,
      nextActions: gate.status === 'passed'
        ? [nextAction('cli:shell', { command: `heimdall rebuild deliver --project "${dir}"` }, '门禁过了：按 Floor=Mirror 交付')]
        : [nextAction('heimdall_compare', { candidate: { dir } }, '看修复包，按顺序修未通过的区域')],
      ...(gate.status === 'passed' ? {} : { warnings: [{ code: 'gate_not_passed', message: `门禁未通过：${gate.status}（${level}）${hint ? `；${hint}` : ''}` }] }),
    });
  } catch (error) {
    return fromError(error);
  }
}

async function formal(flags) {
  const dir = resolve(String(flags.project === true || !flags.project ? '.' : flags.project));
  try {
    const cfg = readProjectConfig(dir);
    const page = cfg.pages?.[0]?.name ?? 'home';
    const level = String(flags.level ?? cfg.gate?.level ?? 'silver');
    const r = await formalGate({
      siteId: cfg.siteId, page, projectDir: dir, level,
      ...(flags.engine ? { engine: String(flags.engine) } : {}),
      timeoutMs: Math.max(30, Number(flags.timeout ?? 480)) * 1000,
      onProgress: (p) => process.stderr.write(`… ${p.message}\n`),
    });
    const lines = [`正式门禁 ${level}：${r.status} · ${cfg.siteId}/${page}`];
    for (const d of r.gate?.dimensions ?? []) lines.push(` ${d.status === 'pass' ? '✓' : d.status === 'fail' ? '✗' : '—'} ${d.id.padEnd(11)} ${d.detail ?? ''}`);
    if (r.acceptance?.runId) lines.push(` 验收任务：${r.acceptance.runId}（${r.acceptance.gate}）`);
    if (r.reportPath) lines.push(`报告：${r.reportPath}`);
    return ok({ ...r }, {
      summary: lines.join('\n'),
      nextActions: r.status === 'passed'
        ? [nextAction('cli:shell', { command: `heimdall rebuild deliver --project "${dir}"` }, '正式通过：按 Floor=Mirror 交付')]
        : [nextAction('heimdall_compare', { candidate: { dir } }, '看修复包定位未通过的维度')],
      ...(r.status === 'passed' ? {} : { warnings: [{ code: 'gate_not_passed', message: `正式门禁未通过：${r.status}` }] }),
    });
  } catch (error) {
    if (error?.code === 'engine_unreachable') {
      return fail('engine_unreachable', error.message, { hint: '先起引擎：`heimdall serve 8900`（或 `pnpm dev:core`），再重跑正式门禁' });
    }
    return fromError(error);
  }
}

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const json = !!flags.json;
  const sub = positional[0];
  let env;
  if (sub === 'report') env = await report(flags);
  else if (sub === 'formal') env = await formal(flags);
  else if (sub === 'baseline') env = await baseline(flags, positional);
  else env = fail('invalid_args', '用法：heimdall gate baseline <siteId> <page> | gate report [--project .] | gate formal [--project .]', { hint: 'baseline 供正式基线；report 出六维快速门禁；formal 跑正式裁判（需要引擎）' });
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
    for (const w of env.warnings ?? []) process.stdout.write(`! ${w.message}\n`);
  }
  // 门禁没过时退出码 1：CI 与代理据此判断，而不是靠读文本
  if (sub === 'report' && env.ok && env.result?.status !== 'passed') return 1;
  if (sub === 'formal' && env.ok && env.result?.status !== 'passed') return 1;
  return exitCodeOf(env);
}
