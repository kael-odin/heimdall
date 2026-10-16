#!/usr/bin/env node
/** Fixed API truth cases, with case-level metrics and separate execution-policy guards. */
import { mkdir, writeFile } from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { startAcceptanceApiFixture, ACCEPTANCE_API_CASES, ACCEPTANCE_API_RESPONSE_SCHEMA } from '../test/fixtures/acceptance-api.mjs';
import { previewOpenApi, openApiDocumentFingerprint } from '../src/acceptance/openapi.mjs';
import { runSpecAcceptance } from '../src/acceptance/spec-runner.mjs';
import { normalizeSpecPlan } from '../src/acceptance/spec-schema.mjs';
import { summarizeAcceptanceReport, acceptanceMarkdown } from '../src/acceptance/report.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const scope = '离线复现：固定 API 缺陷注入与执行策略反例，只证明这组已声明合同和观察窗口，不代表真实项目检出率或完整 OpenAPI 兼容性。';
const ratio = (a, b) => b ? +(a / b).toFixed(4) : null;
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const pct = value => value === null ? '无分母' : `${(value * 100).toFixed(2)}%`;

export function acceptanceApiOpenApiDocument() {
  return { openapi: '3.1.1', info: { title: 'Heimdall 固定 API 验收夹具', version: '1.0.0' },
    // This intentionally invalid external server must never become an execution destination.
    servers: [{ url: 'https://not-authorized.invalid' }],
    components: { schemas: { Healthy: ACCEPTANCE_API_RESPONSE_SCHEMA } },
    paths: Object.fromEntries(ACCEPTANCE_API_CASES.map(item => [item.path, { [item.method.toLowerCase()]: {
      summary: `固定合同 ${item.id}`, responses: { 200: item.method === 'HEAD' ? { description: 'No response body' }
        : { description: 'Healthy contract', content: { 'application/json': { schema: { $ref: '#/components/schemas/Healthy' } } } } },
    } }])) };
}

function evidenceExists(caseDir, file) {
  if (typeof file !== 'string') return false;
  const rel = relative(caseDir, resolve(caseDir, file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  try { return statSync(resolve(caseDir, file)).isFile(); } catch { return false; }
}

function evaluateCase(item, report, caseDir, redirectStayedLocal) {
  const checks = report.checks ?? [];
  const predictedBug = checks.some(check => check.verdict === 'bug');
  const expectedGate = item.targetBug ? 'failed' : item.expectedVerdict === 'environment' ? 'blocked' : 'passed';
  const complete = checks.length === 1 && report.coverage?.planned === 1 && report.coverage?.completed === 1 && !report.coverage?.capped;
  const reasons = [];
  if (predictedBug !== item.targetBug) reasons.push(item.targetBug ? '已知目标缺陷漏检' : '非目标缺陷被误报为 BUG');
  if (!checks.some(check => check.verdict === item.expectedVerdict)) reasons.push(`没有预期分类 ${item.expectedVerdict}`);
  if (report.gate !== expectedGate) reasons.push(`预期门禁 ${expectedGate}，实际 ${report.gate}`);
  if (!complete || report.summary?.missing || report.summary?.invalid) reasons.push('执行覆盖缺失、截断或结果状态无效');
  if (item.id === 'redirect' && !redirectStayedLocal) reasons.push('重定向被跟随后访问了健康目标');
  for (const check of checks) {
    for (const key of ['source', 'contract', 'request', 'response']) if (!evidenceExists(caseDir, check.evidence?.[key])) reasons.push(`${check.id} 的 ${key} 证据缺失或越界`);
    if (evidenceExists(caseDir, check.evidence?.source)) {
      try {
        const source = JSON.parse(readFileSync(resolve(caseDir, check.evidence.source), 'utf8'));
        const fingerprint = openApiDocumentFingerprint(source.document);
        if (fingerprint !== source.source?.sha256 || fingerprint !== check.oracle?.documentSha256) reasons.push(`${check.id} 原始 OpenAPI 证据无法独立复核文档 SHA-256`);
      } catch { reasons.push(`${check.id} 原始 OpenAPI 来源证据格式或指纹不合法`); }
    }
    if (!check.reproduction?.length || !check.oracle?.contractFingerprint || !check.oracle?.documentSha256) reasons.push(`${check.id} 缺少可追溯合同指纹或复现步骤`);
    if (check.verdict === 'bug' && check.status !== 'failed') reasons.push('BUG 结果必须是 failed');
  }
  return { id: item.id, path: item.path, method: item.method, targetBug: item.targetBug, predictedBug,
    expectedVerdict: item.expectedVerdict, expectedGate, actualGate: report.gate,
    verdicts: [...new Set(checks.map(check => check.verdict))], checkCount: checks.length, complete,
    passed: reasons.length === 0, reasons, report: `${item.id}/report.json`, markdown: `${item.id}/report.md` };
}

function markdownFor(result) {
  const m = result.metrics;
  return ['# API Spec 固定注入基准', '', `运行：${result.runId}`, `生成时间：${result.generatedAt}`, '', `**${scope}**`, '',
    `基准门禁：${result.passed ? '通过' : '失败'}；案例校验 ${result.cases.filter(item => item.passed).length}/${result.cases.length}；执行策略守卫 ${result.guards.filter(item => item.passed).length}/${result.guards.length}。`, '',
    '## 计算口径', '', `统计单位是独立 API 案例，每个案例一条固定合同；已知 BUG ${m.knownBugCases}，非 BUG ${m.nonBugCases}，总案例 ${m.totalCases}。草稿、遗漏与只读拒绝守卫单独检查，不加入检出率分母。`, '',
    'TP/FN 由已知 BUG 是否产出 bug 分类决定；FP/TN 由非 BUG 是否被误报决定。环境阻塞保持非通过；不能因超时或预算不足免除真实 BUG 漏检。重定向不跟随，但已观察到 302 与约定 200 不同，构成确定 HTTP 合同缺陷。', '',
    '| 指标 | 数值 |', '| --- | ---: |', `| TP / FP / FN / TN | ${m.truePositive} / ${m.falsePositive} / ${m.falseNegative} / ${m.trueNegative} |`,
    `| Precision | ${pct(m.precision)} |`, `| Recall | ${pct(m.recall)} |`, `| False positive rate | ${pct(m.falsePositiveRate)} |`, `| 耗时 | ${result.durationMs} ms |`, '',
    '## 案例', '', '| 案例 | 真值 | 检出 | 门禁 | 校验 | 问题 |', '| --- | --- | --- | --- | --- | --- |',
    ...result.cases.map(item => `| ${cell(item.id)} | ${item.targetBug ? 'BUG' : cell(item.expectedVerdict)} | ${item.predictedBug ? 'BUG' : '无 BUG'} | ${cell(item.actualGate)} | ${item.passed ? '通过' : '失败'} | ${cell(item.reasons.join('；'))} |`), '',
    '## 执行策略守卫', '', ...result.guards.map(item => `- ${cell(item.id)}：${item.passed ? '通过' : '失败'}；${cell(item.description)}`), '',
    '## 证据', '', ...result.cases.map(item => `- [${item.id} 报告](${item.markdown})：同目录包含原始 OpenAPI 来源、合同、HTTP 请求摘要、响应/错误证据与指纹；文档指纹独立重算核对。`), '',
    '基准只访问本机临时夹具。运行结束后服务器关闭，历史端口不可继续访问；JSON/Markdown 和合同证据供离线核查。真实认证、写入、数据库状态、视觉和未支持的 OpenAPI 语义均未验收。', ''].join('\n');
}

export async function benchmarkAcceptanceSpec({ outputDir = join(CORE, 'workspace', '_runs', 'acceptance-spec-benchmark') } = {}) {
  const started = Date.now();
  const runId = `spec-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  outputDir = resolve(outputDir);
  const runDir = join(outputDir, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'truth.json'), JSON.stringify({ scope, cases: ACCEPTANCE_API_CASES }, null, 2));
  const fixture = await startAcceptanceApiFixture();
  const cases = [], guards = [];
  try {
    const document = acceptanceApiOpenApiDocument();
    const preview = previewOpenApi(document, { targetUrl: fixture.targetUrl });
    await writeFile(join(runDir, 'openapi.json'), JSON.stringify(document, null, 2));
    await writeFile(join(runDir, 'preview.json'), JSON.stringify(preview, null, 2));
    guards.push({ id: 'preview-no-requests', passed: fixture.requests.length === 0 && preview.plan.spec.approved === false && preview.coverage.complete
      && openApiDocumentFingerprint(preview.plan.spec.document) === preview.plan.spec.source.sha256,
      description: `OpenAPI 转候选不访问 servers；候选保留完整来源且保持未批准；本地请求 ${fixture.requests.length}。` });
    const draftDir = join(runDir, '_draft');
    const draft = summarizeAcceptanceReport(await runSpecAcceptance(preview.plan, { runId: `${runId}-draft`, outputDir: draftDir }));
    await writeFile(join(draftDir, 'report.json'), JSON.stringify(draft, null, 2));
    guards.push({ id: 'draft-no-requests', passed: fixture.requests.length === 0 && draft.gate === 'blocked' && draft.checks.length === ACCEPTANCE_API_CASES.length && draft.checks.every(check => check.actual.requested === false),
      description: `未批准的全部 ${ACCEPTANCE_API_CASES.length} 个候选只生成阻塞证据；HTTP 请求 ${fixture.requests.length}。` });
    const omittedPreview = previewOpenApi({ openapi: '3.1.1', info: { title: 'Write-only omission guard', version: '1.0.0' },
      paths: { '/write': { post: { responses: { 200: { description: 'Not executed' } } } } } }, { targetUrl: fixture.targetUrl });
    const omissionPlan = { ...omittedPreview.plan, spec: { ...omittedPreview.plan.spec, approved: true } };
    const omissionDir = join(runDir, '_omission');
    const omitted = summarizeAcceptanceReport(await runSpecAcceptance(omissionPlan, { runId: `${runId}-omission`, outputDir: omissionDir }));
    await writeFile(join(omissionDir, 'report.json'), JSON.stringify(omitted, null, 2));
    guards.push({ id: 'omission-no-requests', passed: fixture.requests.length === 0 && omitted.gate === 'blocked' && omitted.checks.length === 1,
      description: '明确漏项生成阻塞门禁，不能被空检查或批准标记变成通过。' });
    let rejectedWrite = false;
    try { normalizeSpecPlan({ ...preview.plan, spec: { ...preview.plan.spec, checks: [{ ...preview.plan.spec.checks[0], method: 'POST' }] } }); } catch { rejectedWrite = true; }
    guards.push({ id: 'write-method-rejected', passed: rejectedWrite && fixture.requests.length === 0, description: '将候选篡改为 POST 时，在请求之前拒绝。' });
    for (const item of ACCEPTANCE_API_CASES) {
      const caseDir = join(runDir, item.id);
      await mkdir(caseDir, { recursive: true });
      const contract = preview.plan.spec.checks.find(check => check.path === item.path && check.method === item.method);
      if (!contract) throw new Error(`OpenAPI preview omitted required benchmark case ${item.id}`);
      const plan = { ...preview.plan, timeoutMs: 1000, maxResponseBytes: 16384, spec: { ...preview.plan.spec, approved: true, checks: [contract], omissions: [] } };
      await writeFile(join(caseDir, 'plan.json'), JSON.stringify(plan, null, 2));
      const healthyRequests = fixture.requestCounts['/healthy'] ?? 0;
      let report;
      try {
        const raw = await runSpecAcceptance(plan, { runId: `${runId}-${item.id}`, outputDir: caseDir });
        raw.scope = scope;
        raw.checks = raw.checks.map(check => ({ ...check, evidenceLevel: 'offline-reproduced' }));
        report = summarizeAcceptanceReport(raw);
      } catch (error) {
        report = summarizeAcceptanceReport({ runId: `${runId}-${item.id}`, name: plan.name, mode: 'spec', targetUrl: plan.targetUrl, status: 'failed', scope,
          coverage: { planned: 1, completed: 0 }, checks: [], error: String(error?.message ?? error) });
      }
      await writeFile(join(caseDir, 'report.json'), JSON.stringify(report, null, 2));
      await writeFile(join(caseDir, 'report.md'), acceptanceMarkdown(report));
      const evaluated = evaluateCase(item, report, caseDir, (fixture.requestCounts['/healthy'] ?? 0) === healthyRequests);
      cases.push(evaluated);
      console.log(`[acceptance-spec-benchmark] ${item.id}: ${evaluated.passed ? 'PASS' : 'FAIL'}; targetBug=${item.targetBug}; detected=${evaluated.predictedBug}; gate=${report.gate}${evaluated.reasons.length ? '; ' + evaluated.reasons.join('; ') : ''}`);
    }
    await writeFile(join(runDir, 'fixture-requests.json'), JSON.stringify({ requests: fixture.requests, counts: fixture.requestCounts }, null, 2));
  } finally { await fixture.close(); }
  const truePositive = cases.filter(item => item.targetBug && item.predictedBug).length;
  const falsePositive = cases.filter(item => !item.targetBug && item.predictedBug).length;
  const falseNegative = cases.filter(item => item.targetBug && !item.predictedBug).length;
  const trueNegative = cases.filter(item => !item.targetBug && !item.predictedBug).length;
  const knownBugCases = cases.filter(item => item.targetBug).length;
  const nonBugCases = cases.length - knownBugCases;
  const result = { schemaVersion: 1, runId, generatedAt: new Date().toISOString(), scope, outputDir: runDir,
    durationMs: Date.now() - started, passed: cases.length === ACCEPTANCE_API_CASES.length && cases.every(item => item.passed) && guards.every(item => item.passed),
    metrics: { unit: 'case', totalCases: cases.length, knownBugCases, nonBugCases, truePositive, falsePositive, falseNegative, trueNegative,
      precision: ratio(truePositive, truePositive + falsePositive), recall: ratio(truePositive, knownBugCases), falsePositiveRate: ratio(falsePositive, nonBugCases) }, cases, guards };
  await writeFile(join(runDir, 'benchmark.json'), JSON.stringify(result, null, 2));
  await writeFile(join(runDir, 'benchmark.md'), markdownFor(result));
  await writeFile(join(outputDir, 'latest.json'), JSON.stringify({ runId, outputDir: runDir, passed: result.passed, metrics: result.metrics, generatedAt: result.generatedAt }, null, 2));
  console.log(`[acceptance-spec-benchmark] ${JSON.stringify({ ...result.metrics, passed: result.passed, outputDir: runDir })}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: node core/scripts/benchmark-acceptance-spec.mjs [outputDir]');
    process.exitCode = process.argv.length > 3 ? 2 : 0;
  } else {
    try { const result = await benchmarkAcceptanceSpec({ outputDir: process.argv[2] }); process.exitCode = result.passed ? 0 : 1; }
    catch (error) { console.error('[acceptance-spec-benchmark]', error?.stack ?? error); process.exitCode = 1; }
  }
}
