/**
 * agent/gate/formal — 正式裁判（E7-07，PRD 03 §5.5、05 §1.5）
 *
 * 只有它有权对外宣布「通过」。做法是把现有的验收 Mirror 用起来，而不是另写一套判定：
 *
 *   1. 按 E7-19 准备正式基线（回环只读服务，不健康就先做清洗副本）；
 *   2. 起基线服务，向引擎 `POST /api/acceptance/runs` 提交 mirror 模式计划（基线 + 目标 + 路由 + 三视口）；
 *   3. 轮询到结束，读 report.json（health / structure / behavior / 首屏视觉）；
 *   4. Heimdall 评估器同一套快速对比给出整页视觉（E7-20）与六维里的其余维度；
 *   5. 合成 `heimdall.gate/1`：**每一维都要过，验收门禁也要 passed**，才叫通过。
 *
 * 验收子系统有 10 个「指纹冻结」文件不能改（PRD README §3），所以这里只调用公开接口，不碰内部实现。
 * 基线/目标都是本机回环，引擎必须已在跑（`heimdall serve 8900`）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../../fsutil.mjs';
import { sha256 } from '../ids.mjs';
import { agentDir } from '../workspace.mjs';
import { launchBrowser } from '../evidence/capture.mjs';
import { fastCompare, readProjectConfig } from '../evidence/compare.mjs';
import { prepareBaseline, startBaselineServer, copySanitizedBaseline } from './baseline.mjs';
import { composeGate } from './report.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]);

async function fetchJson(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    const e = new Error(`连不上引擎 ${url}：${String(error?.message ?? error).slice(0, 120)}`);
    e.code = 'engine_unreachable';
    throw e;
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const e = new Error(`引擎返回 HTTP ${res.status}：${body.error ?? body.code ?? text.slice(0, 200)}`);
    e.code = 'acceptance_rejected';
    e.status = res.status;
    throw e;
  }
  return body;
}

/** 把验收报告的维度拍平成门禁能读的形状 */
export function acceptanceDimension(report, status) {
  if (!report) return { id: 'acceptance', status: 'not_measured', detail: `验收没有给出报告（任务状态 ${status}）`, gate: status };
  const d = report.summary?.dimensions ?? {};
  const pick = (k) => (d[k] ? `${d[k].passed}/${d[k].total}` : '—');
  const gate = report.gate ?? 'blocked';
  return {
    id: 'acceptance',
    status: gate === 'passed' ? 'pass' : gate === 'failed' ? 'fail' : 'not_measured',
    value: { gate, visual: d.visual?.score ?? null, checks: report.summary?.total ?? 0 },
    detail: `验收 ${gate}：视觉 ${pick('visual')}、结构 ${pick('structure')}、健康 ${pick('health')}、行为 ${pick('behavior')}`,
    notes: (report.checks ?? []).filter(c => c.status !== 'passed').slice(0, 5).map(c => `${c.id} ${c.verdict}：${c.actual ?? c.title ?? ''}`.slice(0, 160)),
  };
}

/**
 * 跑一次正式门禁。
 * @returns {Promise<{status:'passed'|'failed'|'incomplete', reportPath, acceptance:{runId,gate,summary}, fast, report}>}
 */
export async function formalGate({ siteId, page, projectDir, engine = process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900', level = 'silver', timeoutMs = 8 * 60_000, pollMs = 3000, browser = null, onProgress = () => {} } = {}) {
  const cfg = readProjectConfig(projectDir);
  const targetUrl = cfg.devServer.url;
  if (!targetUrl) throw new Error('heimdall.config.json 缺 devServer.url');
  const viewports = cfg.viewports ?? [375, 768, 1440];

  const own = !browser;
  browser ??= await launchBrowser();
  let server = null;
  try {
    onProgress({ stage: 'baseline', message: '准备正式基线（E7-19）' });
    const base = await prepareBaseline(browser, { siteId, page });
    // 验收的结构检查比的是控件语义（含 href）：基线里的绝对链接（http://原站/signup）与重建页里的
    // 相对链接（/signup）指同一个站内目标，却会被判成结构缺陷。供基线前把绝对 href 归一成站内路径，
    // 视觉不受影响（链接不参与渲染），结构才比得公平。
    const formalDir = join(agentDir(siteId), 'gate', page, 'baseline-formal');
    const normalized = copySanitizedBaseline(base.dir, formalDir, { normalizeLinks: true });
    onProgress({ stage: 'baseline', message: `正式基线：归一化 ${normalized.changes.filter(c => c.kind === 'anchor_normalized').length} 个链接` });
    server = await startBaselineServer(formalDir);
    // prepareBaseline 把入口放在 source.entry（相对镜像的 clone 目录）
    const entry = base.source?.entry ?? 'index.html';
    const baselineUrl = `${server.origin}/${entry.replace(/^\/+/, '')}`;

    onProgress({ stage: 'acceptance', message: `提交验收：基线 ${baselineUrl} → 目标 ${targetUrl}` });
    const plan = {
      schemaVersion: 1, name: `${siteId}/${page} 正式门禁`, mode: 'mirror',
      baselineUrl, targetUrl, routes: ['/'], viewports: VIEWPORTS, points: [],
      thresholds: { visual: cfg.gate?.thresholds?.visual?.pixel?.[level] ?? 0.97 },
    };
    const created = await fetchJson(`${engine}/api/acceptance/runs`, { method: 'POST', body: JSON.stringify(plan) });
    const runId = created.runId;
    if (!runId) throw new Error('引擎没有返回 runId');

    const deadline = Date.now() + timeoutMs;
    let view = null;
    while (Date.now() < deadline) {
      view = await fetchJson(`${engine}/api/acceptance/runs/${runId}`);
      const pct = Number.isFinite(view.progress) ? ` ${Math.round(view.progress * 100)}%` : '';
      onProgress({ stage: 'acceptance', message: `验收 ${view.status}${pct}` });
      if (view.status !== 'running') break;
      await sleep(pollMs);
    }
    if (!view || view.status === 'running') {
      return { status: 'incomplete', reason: 'acceptance_timeout', runId, acceptance: { runId, gate: 'blocked' }, reportPath: null };
    }
    let report = null;
    try { report = await fetchJson(`${engine}/api/acceptance/runs/${runId}/report`); } catch { report = null; }

    onProgress({ stage: 'evaluate', message: '评估器：整页视觉与六维' });
    const fastR = await fastCompare({ siteId, page, candidate: { dir: projectDir }, viewports }, { browser, record: false });
    const fast = composeGate(fastR.packet, { level, thresholds: cfg.gate?.thresholds ?? null });
    const acceptance = acceptanceDimension(report, view.status);

    const dims = [...fast.dimensions, acceptance];
    const anyFail = dims.some(d => d.status === 'fail');
    const anyUnknown = dims.some(d => d.status === 'not_measured');
    const status = anyFail ? 'failed' : anyUnknown ? 'incomplete' : 'passed';

    const gate = {
      schema: 'heimdall.gate/1', judge: 'formal', level,
      siteId, page, projectDir: resolve(projectDir), generatedAt: new Date().toISOString(),
      acceptance: { runId, gate: report?.gate ?? 'blocked', engine, baseline: baselineUrl, target: targetUrl },
      dimensions: dims, status,
      thresholds: fast.thresholds,
      note: status === 'passed'
        ? '正式裁判通过：验收与评估器每一维都过了。'
        : status === 'incomplete'
          ? '有维度没测到（基线被 blocked 或验收未出报告），不当作通过。'
          : '至少一维没过；按 dimensions 与验收报告定位。',
    };
    const outDir = join(agentDir(siteId), 'gate', page);
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `formal-${runId}.json`);
    const body = JSON.stringify(gate, null, 1) + '\n';
    writeFileAtomic(file, body);
    if (report) writeFileSync(join(outDir, `${runId}.acceptance.md`), JSON.stringify(report.summary ?? {}, null, 1));
    return { status, gate, fast, report, acceptance: { runId, gate: report?.gate ?? 'blocked', summary: report?.summary ?? null }, reportPath: file, evidence: { sha256: sha256(body), bytes: body.length } };
  } finally {
    if (server) await server.close().catch(() => {});
    if (own) await browser.close().catch(() => {});
  }
}
