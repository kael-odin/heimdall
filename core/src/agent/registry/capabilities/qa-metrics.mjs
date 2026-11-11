/**
 * capability: qa_metrics - aggregate QA evidence and make a conservative detector decision.
 *
 * It reads a sanitized aggregate JSON file, inline aggregate data, or the
 * run.json summaries in a QA workspace. It never returns raw findings.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { analyzeQaMetrics } from '../../../qa/metrics.mjs';
import { listRuns, openWorkspace } from '../../../qa/run.mjs';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

function readMetricsFile(file, ctx) {
  const path = resolve(ctx.cwd ?? process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), file);
  if (extname(path).toLowerCase() !== '.json') throw new CapabilityError('invalid_args', '指标文件必须是 .json');
  if (!existsSync(path)) throw new CapabilityError('not_found', `指标文件不存在：${file}`);
  const stat = statSync(path);
  if (!stat.isFile()) throw new CapabilityError('invalid_args', '指标路径必须是普通 JSON 文件');
  if (stat.size > MAX_FILE_BYTES) throw new CapabilityError('invalid_args', '指标文件超过 5 MiB；请先导出脱敏聚合摘要');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new CapabilityError('invalid_args', `指标文件不是有效 JSON：${file}`); }
}

function percent(value) {
  return value === null || value === undefined ? '不可计算' : `${value}%`;
}

function roundSeconds(ms) {
  return ms === null || ms === undefined ? '不可计算' : (ms / 1000).toFixed(2);
}

function summaryOf(result) {
  const alarms = result.alarms;
  const oracle = result.oracle;
  const runtime = result.runtime;
  const alarmText = alarms.available ? `误报占已复核报警 ${percent(alarms.falseDiscoveryRate.percent)}` : '报警复核标签不完整';
  const missText = oracle.falseNegativeRate ? `定向漏报 ${percent(oracle.falseNegativeRate.percent)}` : '漏报率不可计算';
  const timeText = runtime.p50Ms === null ? '运行时长不可计算' : `时长 p50 ${roundSeconds(runtime.p50Ms)} 秒 / p95 ${roundSeconds(runtime.p95Ms)} 秒`;
  return `${result.coverage.runs} 次运行：${alarmText}，${missText}，${timeText}；新增通用检测器：${result.decision.detectorExpansion}。`;
}

const WORKSPACE = { type: 'string', minLength: 1, maxLength: 2000, description: '包含 .heimdall/qa.json 的测试工作区' };

export default {
  id: 'qa_metrics',
  title: 'QA 实战指标：统计误报、漏报、耗时与失败分类',
  description: 'Read a sanitized QA aggregate or QA run summaries and recompute reviewed alarms, false-discovery rate, classic false-positive rate when exhaustive normal samples exist, oracle false-negative rate, runtime p50/p95, failure categories and coverage. Then apply the conservative detector-expansion rule used by the Xspark pilot. This is an evidence summary, not a browser run; missing labels, incomplete measurements and a non-exhaustive oracle keep generic detector expansion blocked. Raw findings, cookies, tokens and request bodies are never returned.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      file: { type: 'string', minLength: 1, maxLength: 2000, description: '脱敏聚合指标 JSON；也接受单个 run.json 或运行数组' },
      data: { type: 'object', additionalProperties: true, description: '内联脱敏聚合指标，不能与 file 或 workspace 同时使用' },
      workspace: WORKSPACE,
      site: { type: 'string', maxLength: 64, description: '只分析 QA 工作区中的这个站点' },
      limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100, description: '从 QA 工作区最多读取多少次运行' },
    },
  },
  cli: { usage: 'qa-metrics [--file metrics.json] [--workspace DIR] [--site NAME] [--limit N]', positional: [] },
  async handler(args, ctx) {
    const selected = [args.file !== undefined, args.data !== undefined, args.workspace !== undefined].filter(Boolean).length;
    if (selected > 1) throw new CapabilityError('invalid_args', 'file、data、workspace 三选一');

    let data;
    let source = 'workspace';
    if (args.file !== undefined) {
      data = readMetricsFile(args.file, ctx);
      source = 'file';
    } else if (args.data !== undefined) {
      data = args.data;
      source = 'inline';
    } else {
      const ws = openWorkspace(args.workspace, ctx);
      const runs = listRuns(ws, args.limit);
      data = { runs: args.site ? runs.filter(run => run.site === args.site) : runs };
    }

    let result;
    try { result = analyzeQaMetrics(data); }
    catch (error) { throw new CapabilityError('invalid_args', error.message); }
    result.source = { kind: source };
    if (args.site !== undefined) result.source.site = args.site;
    const nextActions = [];
    if (result.decision.primaryAction === 'collect-more-evidence') {
      nextActions.push(nextAction('heimdall_qa_metrics', null, '补齐标签、定向样本和失败证据后重新统计'));
    }
    if (result.decision.secondaryActions.includes('fix-existing-detectors') || result.decision.primaryAction === 'fix-existing-detectors') {
      nextActions.push(nextAction('heimdall_qa_run', { detect: true }, '先修正已有检测器边界，再用同一批次复测'));
    }
    if (result.decision.secondaryActions.includes('add-business-check') || result.decision.primaryAction === 'add-business-check') {
      nextActions.push(nextAction('heimdall_qa_run', { checks: [] }, '把业务规则写成声明式检查点，再复测漏报'));
    }
    return ok(result, { summary: summaryOf(result), nextActions });
  },
};
