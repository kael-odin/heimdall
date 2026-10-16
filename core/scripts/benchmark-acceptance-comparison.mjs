#!/usr/bin/env node
/** Real local runner/store comparisons against fixed retest and false-closure cases. */
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeAcceptancePlan } from '../src/acceptance/schema.mjs';
import { runAcceptance } from '../src/acceptance/runner.mjs';
import { summarizeAcceptanceReport } from '../src/acceptance/report.mjs';
import { createAcceptanceRun, acceptanceRunDir, finishAcceptanceRun, readAcceptanceSnapshot, readAcceptanceRun } from '../src/acceptance/store.mjs';
import { compareAcceptanceSnapshots, comparisonMarkdown } from '../src/acceptance/comparison.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const SCOPE = '离线复现：本机固定版本、缺陷和假关闭反例，通过真实 browser/Spec runner、store 落盘与当前证据校验完成；只证明本组声明范围，不代表真实项目检出率、根因识别或持久缺陷自动关闭。';
const MOBILE = { name: 'mobile', width: 375, height: 812 };
const DESKTOP = { name: 'desktop', width: 960, height: 720 };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ');
const dump = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

async function startComparisonFixture() {
  let baselineChanged = false;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.local');
    const [, surface, version, route] = url.pathname.split('/');
    requests.push({ method: req.method, path: url.pathname });
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (surface === 'api' && ['before', 'after', 'limited', 'still'].includes(version) && ['quota', 'items'].includes(route)) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const broken = route === 'quota' ? ['before', 'still'].includes(version) : version === 'after';
      const body = version === 'limited' ? { payload: 'x'.repeat(8000) } : { code: broken ? 400 : 0, value: 7 };
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      return;
    }
    if (surface === 'browser' && ['reference', 'before', 'after'].includes(version) && ['home', 'details'].includes(route)) {
      const shifted = route === 'home' && (version === 'before' || version === 'reference' && baselineChanged);
      const brokenToggle = version === 'before';
      const brokenCopy = version === 'after' && route === 'details';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Comparison fixture</title>
        <style>*{box-sizing:border-box}body{margin:0;background:${shifted ? '#b91c1c' : '#f8fafc'};color:#17223a;font:16px Arial,sans-serif}main{padding:28px}h1{margin:0 0 20px}.panel{background:white;padding:24px;border:1px solid #ccd6e2}button{font:inherit;padding:10px}</style></head>
        <body><main><h1>${route === 'home' ? 'Project overview' : 'Project details'}</h1><section class="panel"><button id="toggle" aria-expanded="false">Toggle details</button><p id="copy">${brokenCopy ? 'Unexpected value' : 'Ready'}</p></section></main>
        <script>document.querySelector('#toggle').onclick=()=>{${brokenToggle ? '' : "document.querySelector('#toggle').setAttribute('aria-expanded','true')"}};</script></body></html>`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Fixture route not found');
  });
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, requests, changeBaseline: () => { baselineChanged = true; },
    close: () => new Promise((ready, reject) => { server.close(error => error ? reject(error) : ready()); server.closeAllConnections(); }) };
}

function browserPlan(origin, version, patch = {}) {
  return normalizeAcceptancePlan({ name: `Browser ${version}`, mode: 'regression',
    baselineUrl: `${origin}/browser/reference`, targetUrl: `${origin}/browser/${version}`,
    routes: ['/home', '/details'], viewports: [MOBILE, DESKTOP], timeoutMs: 1500, settleMs: 80,
    points: [
      { id: 'toggle', title: 'Toggle exposes expanded state', route: '/home', steps: [{ action: 'click', selector: '#toggle' }],
        assertions: [{ kind: 'attribute', selector: '#toggle', attribute: 'aria-expanded', equals: 'true' }] },
      { id: 'copy', title: 'Detail copy remains correct', route: '/details', assertions: [{ kind: 'text', selector: '#copy', equals: 'Ready' }] },
    ], ...patch });
}

function apiPlan(origin, version, patch = {}) {
  const spec = { source: { id: 'REQ-COMPARISON', revision: 'v1', type: 'manual', title: 'Fixed API source' }, approved: true,
    checks: ['quota', 'items'].map(id => ({ id, title: `Contract ${id}`, method: 'GET', path: `/${id}`,
      expect: { status: 200, contentType: 'application/json', json: [{ pointer: '/code', kind: 'equals', value: 0 }] } })), omissions: [] };
  return normalizeAcceptancePlan({ name: `API ${version}`, mode: 'spec', targetUrl: `${origin}/api/${version}`, timeoutMs: 1000,
    maxResponseBytes: 4096, spec, ...patch });
}

function matchingRow(result, run, predicate) {
  const check = run.report.checks.find(predicate);
  return check ? result.checks.find(row => row.before?.checkId === check.id) : null;
}
const hasReason = (row, code) => !!row?.reasons.some(item => item.code === code);

function markdownFor(result) {
  return ['# 验收运行对比固定反例基准', '', `运行：${result.runId}`, `生成时间：${result.generatedAt}`, '', `**${SCOPE}**`, '',
    `基准门禁：${result.passed ? '通过' : '失败'}；固定反例 ${result.cases.filter(item => item.passed).length}/${result.cases.length}；真实运行 ${result.runs.length}；耗时 ${result.durationMs} ms。`, '',
    '统计单位是固定比较反例；修复、新增、缺测、不可比和篡改分别有明确真值，不把检查数转换成真实项目检出率。', '',
    '| 反例 | 校验 | 真值与边界 | 问题 |', '| --- | --- | --- | --- |',
    ...result.cases.map(item => `| ${cell(item.id)} | ${item.passed ? '通过' : '失败'} | ${cell(item.description)} | ${cell(item.reasons.join('；'))} |`), '',
    '## 比较报告', '', ...result.cases.filter(item => item.comparison).map(item => `- [${item.id}](${item.comparison.replace(/\.json$/, '.md')})：JSON 同目录保存。`), '',
    '## 原始运行', '', ...result.runs.map(run => `- [${run.label}](${run.report})：原门禁 ${run.gate}，检查 ${run.checkCount}。`), '',
    '## 边界', '',
    '仅访问本机临时夹具，退出时关闭服务器。报告和证据保留；历史端口不可继续访问。对比结果只引用检查状态和原因，不改写原报告、门禁或批准状态。部分视口复验只对其自身成立；旧尺寸或缺失检查不能继承通过。', '',
    '证据篡改反例只修改本次基准自己的响应证据，保存当前完整性校验结果后恢复原字节；不触碰其他历史运行。', ''].join('\n');
}

export async function benchmarkAcceptanceComparison({ outputDir = join(CORE, 'workspace', '_runs', 'acceptance-comparison-benchmark') } = {}) {
  const started = Date.now();
  const runId = `comparison-benchmark-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  outputDir = resolve(outputDir);
  const runDir = join(outputDir, runId), root = join(runDir, 'runs'), comparisonDir = join(runDir, 'comparisons');
  await mkdir(comparisonDir, { recursive: true });
  const fixture = await startComparisonFixture();
  const runs = [], cases = [];
  const execute = async (label, input) => {
    const manifest = createAcceptanceRun(input, { root });
    const raw = await runAcceptance(manifest.plan, { runId: manifest.runId, outputDir: acceptanceRunDir(manifest.runId, root) });
    raw.scope = SCOPE;
    const expectedGate = summarizeAcceptanceReport(raw).gate;
    const report = finishAcceptanceRun(manifest.runId, raw, { root });
    if (report.gate !== expectedGate) throw new Error(`${label}: store changed the original gate`);
    const bytes = await readFile(join(acceptanceRunDir(manifest.runId, root), 'report.json'));
    const run = { label, runId: manifest.runId, report, reportSha256: sha256(bytes) };
    runs.push(run);
    console.log(`[acceptance-comparison-benchmark] run ${label}: gate=${report.gate}; checks=${report.checks.length}`);
    return run;
  };
  const compare = async (id, description, before, after, validate) => {
    const result = compareAcceptanceSnapshots(readAcceptanceSnapshot(before.runId, { root }), readAcceptanceSnapshot(after.runId, { root }));
    const reasons = validate(result);
    await dump(join(comparisonDir, `${id}.json`), result);
    await writeFile(join(comparisonDir, `${id}.md`), comparisonMarkdown(result));
    cases.push({ id, description, passed: reasons.length === 0, reasons, comparison: `comparisons/${id}.json`, summary: result.summary, status: result.status });
    console.log(`[acceptance-comparison-benchmark] ${id}: ${reasons.length ? 'FAIL' : 'PASS'}${reasons.length ? '; ' + reasons.join('; ') : ''}`);
    return result;
  };
  try {
    const beforeBrowserPlan = browserPlan(fixture.origin, 'before');
    const afterBrowserPlan = browserPlan(fixture.origin, 'after', { name: 'Renamed browser run', routes: ['/details', '/home'],
      viewports: [{ ...DESKTOP, name: 'wide-renamed' }, { ...MOBILE, name: 'phone-renamed' }],
      points: [...beforeBrowserPlan.points].reverse().map(point => ({ ...point, title: 'Renamed point', severity: 'low' })) });
    const browserBefore = await execute('browser-before', beforeBrowserPlan);
    const browserAfter = await execute('browser-after-reordered', afterBrowserPlan);
    await compare('browser-reordered-fixed-and-new', '真实浏览器：计划重排仍配对，原视觉和按钮问题复验通过，另一操作点出现新增失败。', browserBefore, browserAfter, result => {
      const reasons = [];
      if (result.status !== 'completed' || result.summary.incomparable || result.summary.unverified) reasons.push('稳定重排出现不可比或未复验');
      for (const width of [MOBILE.width, DESKTOP.width]) {
        if (matchingRow(result, browserBefore, c => c.identity?.pointId === 'toggle' && c.identity.viewport.width === width)?.relation !== 'verified_passed') reasons.push(`${width}px 原按钮问题未形成可靠复验`);
        if (matchingRow(result, browserBefore, c => c.identity?.pointId === 'copy' && c.identity.viewport.width === width)?.relation !== 'new_failure') reasons.push(`${width}px 新文字问题没有保持新增失败`);
      }
      return reasons;
    });
    const partialPlan = { ...afterBrowserPlan, viewports: [{ ...DESKTOP, name: 'desktop-only' }] };
    const browserPartial = await execute('browser-desktop-only', partialPlan);
    await compare('partial-viewports-do-not-close-phone', '仅桌面通过不能关闭旧手机视口问题；每个视口独立保留复验事实。', browserBefore, browserPartial, result => {
      const mobile = matchingRow(result, browserBefore, c => c.identity?.pointId === 'toggle' && c.identity.viewport.width === MOBILE.width);
      const desktop = matchingRow(result, browserBefore, c => c.identity?.pointId === 'toggle' && c.identity.viewport.width === DESKTOP.width);
      return [mobile?.relation === 'verified_passed' ? '手机未运行却被算为已修复' : '', desktop?.relation !== 'verified_passed' ? '桌面自身的复验事实丢失' : ''].filter(Boolean);
    });
    const browserMissing = await execute('browser-deleted-route', { ...afterBrowserPlan, routes: ['/details'], points: afterBrowserPlan.points.filter(point => point.route === '/details') });
    await compare('deleted-route-is-unverified', '删除原失败路由不算修复。', browserBefore, browserMissing, result => {
      const row = matchingRow(result, browserBefore, c => c.identity?.pointId === 'toggle');
      return row?.relation === 'unverified' && hasReason(row, 'check-not-rerun') ? [] : ['删除的操作点没有保持未复验'];
    });
    fixture.changeBaseline();
    const browserDrift = await execute('browser-same-url-reference-drift', browserPlan(fixture.origin, 'before', {
      routes: ['/home'], viewports: [MOBILE], points: beforeBrowserPlan.points.filter(point => point.route === '/home') }));
    await compare('same-url-reference-drift-incomparable', '相同参考 URL 被改成目标外观后视觉通过，也不能证明旧视觉问题已修复。', browserBefore, browserDrift, result => {
      const row = matchingRow(result, browserBefore, c => c.route === '/home' && c.identity?.facet === 'visual' && c.identity.viewport.width === MOBILE.width);
      const current = browserDrift.report.checks.find(c => c.identity?.facet === 'visual');
      return current.status === 'passed' && row?.relation === 'incomparable' && hasReason(row, 'oracle-changed') ? [] : ['基线漂移没有保守阻止视觉修复声明'];
    });
    const beforeApiPlan = apiPlan(fixture.origin, 'before');
    const afterApiPlan = apiPlan(fixture.origin, 'after', { name: 'Renamed API run', spec: { ...beforeApiPlan.spec,
      source: { ...beforeApiPlan.spec.source, title: 'Renamed source title' }, checks: [...beforeApiPlan.spec.checks].reverse().map(check => ({ ...check, title: 'Renamed contract', severity: 'low' })) } });
    const apiBefore = await execute('api-before', beforeApiPlan);
    const apiAfter = await execute('api-after-reordered', afterApiPlan);
    await compare('api-reordered-fixed-and-new', '真实 Spec：合同重排、目标版本和来源标题变化不破坏身份；一个合同修复，另一合同新增失败。', apiBefore, apiAfter, result =>
      result.status === 'completed' && result.summary.verifiedPassed === 1 && result.summary.newFailure === 1 && result.summary.incomparable === 0 ? [] : ['Spec 修复/新增事实或稳定配对不符合固定真值']);
    const apiStill = await execute('api-still-failed', apiPlan(fixture.origin, 'still'));
    await compare('same-contract-still-failed', '同一合同仍违反断言，保持仍失败。', apiBefore, apiStill, result => result.summary.stillFailed === 1 && result.summary.verifiedPassed === 0 ? [] : ['持续缺陷被错误计为修复']);
    const apiWeaker = await execute('api-weaker-contract', { ...afterApiPlan, spec: { ...afterApiPlan.spec,
      checks: afterApiPlan.spec.checks.map(check => ({ ...check, expect: { status: 200, contentType: 'application/json' } })) } });
    await compare('weaker-criteria-incomparable', '删除 JSON 业务成功断言后通过属于判据变化，不属于修复。', apiBefore, apiWeaker, result =>
      result.summary.verifiedPassed === 0 && result.checks.every(row => row.relation === 'incomparable' && hasReason(row, 'definition-changed')) ? [] : ['判据放宽被当成了修复']);
    const apiSource = await execute('api-source-revision-changed', { ...afterApiPlan, spec: { ...afterApiPlan.spec, source: { ...afterApiPlan.spec.source, revision: 'v2' } } });
    await compare('changed-source-incomparable', '同合同的来源版本变化，必须保留不可比原因。', apiBefore, apiSource, result =>
      result.summary.verifiedPassed === 0 && result.checks.every(row => row.relation === 'incomparable' && hasReason(row, 'oracle-changed')) ? [] : ['来源变化被当成了修复']);
    const apiMissing = await execute('api-deleted-contract', { ...afterApiPlan, spec: { ...afterApiPlan.spec, checks: afterApiPlan.spec.checks.filter(check => check.id === 'items') } });
    await compare('deleted-contract-is-unverified', '删除旧失败合同不能算修复，也不能由健康 HTTP 状态替代业务断言。', apiBefore, apiMissing, result => {
      const row = matchingRow(result, apiBefore, c => c.identity?.contractId === 'quota');
      return row?.relation === 'unverified' && hasReason(row, 'check-not-rerun') && result.summary.verifiedPassed === 0 ? [] : ['删合同导致假修复'];
    });
    const apiLimited = await execute('api-response-budget-blocked', apiPlan(fixture.origin, 'limited'));
    await compare('execution-limit-is-not-fixed', '同规则下的响应预算阻塞不能关闭此前 BUG。', apiBefore, apiLimited, result => {
      const row = matchingRow(result, apiBefore, c => c.identity?.contractId === 'quota');
      return apiLimited.report.gate === 'blocked' && row?.relation === 'unverified' && result.summary.verifiedPassed === 0 ? [] : ['运行预算阻塞被算成修复'];
    });
    const tamperedCheck = apiAfter.report.checks.find(check => check.identity.contractId === 'quota');
    const tamperedPath = join(acceptanceRunDir(apiAfter.runId, root), tamperedCheck.evidence.response);
    const originalEvidence = await readFile(tamperedPath);
    try {
      const changedEvidence = Buffer.concat([originalEvidence, Buffer.from('\n ')]);
      await writeFile(tamperedPath, changedEvidence);
      const snapshot = readAcceptanceSnapshot(apiAfter.runId, { root });
      await dump(join(runDir, 'tamper-observation.json'), { runId: apiAfter.runId, file: tamperedCheck.evidence.response,
        originalSha256: sha256(originalEvidence), modifiedSha256: sha256(changedEvidence), integrity: snapshot.integrity });
      await compare('tampered-evidence-blocks-retest', '完成后响应证据被修改，即使历史 gate 仍在，也必须阻止复验修复声明。', apiBefore, apiAfter, result =>
        result.status === 'blocked' && result.summary.verifiedPassed === 0 && result.checks.every(row => hasReason(row, 'after-evidence-integrity')) ? [] : ['篡改证据仍可形成可靠复验']);
    } finally { await writeFile(tamperedPath, originalEvidence); }
    const unchanged = [];
    for (const run of runs) {
      const bytes = await readFile(join(acceptanceRunDir(run.runId, root), 'report.json'));
      const manifest = readAcceptanceRun(run.runId, { root });
      if (sha256(bytes) !== run.reportSha256 || manifest.gate !== run.report.gate || !readAcceptanceSnapshot(run.runId, { root }).integrity.valid) unchanged.push(run.label);
    }
    cases.push({ id: 'original-gates-and-reports-unchanged', description: '比较和证据验证不改写原报告或原门禁；篡改反例恢复原证据后仍能通过完整性校验。',
      passed: unchanged.length === 0, reasons: unchanged.map(label => `${label} 的原事实发生变化`) });
    await dump(join(runDir, 'fixture-requests.json'), fixture.requests);
  } finally { await fixture.close(); }
  const result = { schemaVersion: 1, runId, generatedAt: new Date().toISOString(), scope: SCOPE, outputDir: runDir,
    durationMs: Date.now() - started, passed: cases.length === 12 && cases.every(item => item.passed),
    metrics: { unit: 'fixed-comparison-case', totalCases: cases.length, passedCases: cases.filter(item => item.passed).length,
      failedCases: cases.filter(item => !item.passed).length, realRuns: runs.length }, cases,
    runs: runs.map(run => ({ label: run.label, runId: run.runId, mode: run.report.mode, gate: run.report.gate,
      checkCount: run.report.checks.length, report: relative(runDir, join(acceptanceRunDir(run.runId, root), 'report.md')).replaceAll('\\', '/') })) };
  await dump(join(runDir, 'truth.json'), { scope: SCOPE, cases: cases.map(({ id, description }) => ({ id, description })) });
  await dump(join(runDir, 'benchmark.json'), result);
  await writeFile(join(runDir, 'benchmark.md'), markdownFor(result));
  await dump(join(outputDir, 'latest.json'), { runId, outputDir: runDir, passed: result.passed, metrics: result.metrics, generatedAt: result.generatedAt });
  console.log(`[acceptance-comparison-benchmark] ${JSON.stringify({ passed: result.passed, ...result.metrics, outputDir: runDir })}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || ['--help', '-h'].includes(process.argv[2])) {
    console.log('Usage: node core/scripts/benchmark-acceptance-comparison.mjs [outputDir]');
    process.exitCode = process.argv.length > 3 ? 2 : 0;
  } else {
    try { const result = await benchmarkAcceptanceComparison({ outputDir: process.argv[2] }); process.exitCode = result.passed ? 0 : 1; }
    catch (error) { console.error('[acceptance-comparison-benchmark]', error?.stack ?? error); process.exitCode = 1; }
  }
}
