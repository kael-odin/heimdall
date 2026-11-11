/**
 * agent/gate/formal — 正式裁判（E7-07，PRD 03 §5.5、05 §1.5）
 *
 * 只有它有权对外宣布「通过」。做法是把现有的验收 Mirror 用起来，而不是另写一套判定：
 *
 *   1. 按 E7-19 准备正式基线（回环只读服务，不健康就先做清洗副本）；
 *   2. 按配置视口分别起基线服务，向引擎 `POST /api/acceptance/runs` 提交 mirror 模式计划；
 *   3. 轮询到结束，读 report.json（health / structure / behavior / 首屏视觉）；
 *   4. Heimdall 评估器同一套快速对比给出整页视觉（E7-20）与六维里的其余维度；
 *   5. 合成 `heimdall.gate/1`：**每一维都要过，验收门禁也要 passed**，才叫通过。
 *
 * 验收子系统有 10 个「指纹冻结」文件不能改（PRD README §3），所以这里只调用公开接口，不碰内部实现。
 * 基线/目标都是本机回环，引擎必须已在跑（`heimdall serve 8900`）。
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../ids.mjs';
import { agentDir, mirrorEntry } from '../workspace.mjs';
import { projectFingerprint } from '../deliver/project.mjs';
import { launchBrowser } from '../evidence/capture.mjs';
import { fastCompare, readProjectConfig } from '../evidence/compare.mjs';
import { prepareBaseline, startBaselineServer, copySanitizedBaseline } from './baseline.mjs';
import { composeGate } from './report.mjs';
import { startFormalAttempt, writeFormalAttempt } from './attempt.mjs';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const VIEWPORTS = Object.freeze([
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
]);

export const configuredViewports = (cfg) => {
  const raw = cfg.viewports ?? VIEWPORTS.map(v => v.width);
  if (!Array.isArray(raw)) throw new Error('正式门禁的 viewports 必须是数组');
  const widths = raw.map(Number);
  if (!widths.length) throw new Error('正式门禁没有可用视口；viewports 只能取 375 / 768 / 1440');
  if (widths.some(width => !VIEWPORTS.some(v => v.width === width))) throw new Error('正式门禁的 viewports 只能取 375 / 768 / 1440');
  if (new Set(widths).size !== widths.length) throw new Error('正式门禁的 viewports 不能重复');
  return widths.map(width => VIEWPORTS.find(v => v.width === width));
};

const routeOf = (cfg, page) => (cfg.pages ?? []).find(item => item.name === page)?.route ?? '/';
const routePath = (route) => {
  try { return new URL(String(route || '/'), 'http://127.0.0.1').pathname || '/'; } catch { return '/'; }
};

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
  if (status !== 'completed' || report.status !== 'completed') {
    return { id: 'acceptance', status: 'not_measured', detail: `验收任务或报告未完成（任务状态 ${status}）`, gate: report.gate ?? 'blocked' };
  }
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

export function acceptanceDimensions(lanes, expectedViewports) {
  const dimensions = lanes.map(lane => ({
    width: lane.width,
    ...acceptanceDimension(lane.report, lane.status),
  }));
  const statuses = dimensions.map(d => d.status);
  const complete = dimensions.length === expectedViewports.length && statuses.every(status => status === 'pass');
  const hasUnknown = dimensions.length !== expectedViewports.length || statuses.includes('not_measured');
  const hasFailure = statuses.includes('fail');
  const status = complete ? 'pass' : hasUnknown ? 'not_measured' : hasFailure ? 'fail' : 'not_measured';
  const gate = complete ? 'passed' : hasUnknown ? 'blocked' : hasFailure ? 'failed' : 'blocked';
  return {
    id: 'acceptance', status,
    value: { gate, viewports: dimensions.map(d => ({ width: d.width, status: d.status, gate: d.value?.gate ?? null })) },
    detail: `验收 ${gate}：${dimensions.map(d => `${d.width}px ${d.status}`).join('、')}`,
    notes: dimensions.flatMap(d => (d.notes ?? []).map(note => `${d.width}px ${note}`)).slice(0, 8),
    dimensions,
  };
}

async function runAcceptanceLane({ engine, plan, deadline, pollMs, onProgress, viewport }) {
  const created = await fetchJson(`${engine}/api/acceptance/runs`, { method: 'POST', body: JSON.stringify(plan) });
  const runId = created.runId;
  if (!runId) throw new Error(`引擎没有返回 ${viewport.width}px 的 runId`);
  let view = null;
  while (Date.now() < deadline) {
    view = await fetchJson(`${engine}/api/acceptance/runs/${runId}`);
    const pct = Number.isFinite(view.progress) ? ` ${Math.round(view.progress * 100)}%` : '';
    onProgress({ stage: 'acceptance', message: `${viewport.width}px 验收 ${view.status}${pct}` });
    if (view.status !== 'running') break;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  if (!view || view.status === 'running') return { runId, status: 'timeout', report: null };
  let report = null;
  try { report = await fetchJson(`${engine}/api/acceptance/runs/${runId}/report`); } catch { report = null; }
  return { runId, status: view.status, report };
}

/**
 * 跑一次正式门禁。
 * @returns {Promise<{status:'passed'|'failed'|'incomplete', reportPath, acceptance:{runId,runIds,gate,summary}, fast, report, reports}>}
 */
export async function formalGate({ siteId, page, projectDir, engine = process.env.HEIMDALL_API ?? 'http://127.0.0.1:8900', level = 'silver', timeoutMs = 8 * 60_000, pollMs = 3000, browser = null, onProgress = () => {} } = {}) {
  const attempt = startFormalAttempt({ siteId, page, projectDir, level });
  const own = !browser;
  try {
    const snapshot = { schema: 'heimdall.project-snapshot/1', sha256: projectFingerprint(projectDir) };
    const cfg = readProjectConfig(projectDir);
    const targetUrl = cfg.devServer?.url;
    if (!targetUrl) throw new Error('heimdall.config.json 缺 devServer.url');
    const viewports = configuredViewports(cfg);
    const widths = viewports.map(viewport => viewport.width);
    const route = routeOf(cfg, page);
    const fallbackPath = routePath(route);
    browser ??= await launchBrowser();
    onProgress({ stage: 'baseline', message: '准备正式基线（E7-19）' });
    const prepDir = join(agentDir(siteId), 'gate', page, `baseline-prep-${sha256(attempt.file).slice(0, 16)}`);
    const base = await prepareBaseline(browser, { siteId, page, viewport: widths.at(-1), stateDir: prepDir });
    // 验收的结构检查比的是控件语义（含 href）：基线里的绝对链接（http://原站/signup）与重建页里的
    // 相对链接（/signup）指同一个站内目标，却会被判成结构缺陷。供基线前把绝对 href 归一成站内路径，
    // 视觉不受影响（链接不参与渲染），结构才比得公平。
    const formalDir = join(agentDir(siteId), 'gate', page, `baseline-formal-${sha256(attempt.file).slice(0, 16)}`);
    const normalized = copySanitizedBaseline(base.dir, formalDir, { normalizeLinks: true });
    onProgress({ stage: 'baseline', message: `正式基线：归一化 ${normalized.changes.filter(c => c.kind === 'anchor_normalized').length} 个链接` });
    const deadline = Date.now() + timeoutMs;
    const lanes = [];
    for (const viewport of viewports) {
      if (Date.now() >= deadline) {
        lanes.push(...viewports.slice(lanes.length).map(missing => ({ width: missing.width, status: 'not_started', report: null, runId: null, baseline: null })));
        break;
      }
      const entry = mirrorEntry(siteId, page, viewport.width).replace(/^clone\//, '');
      let server = null;
      try {
        server = await startBaselineServer(formalDir, { entry, fallbackPaths: [fallbackPath] });
        const baselineUrl = server.origin;
        onProgress({ stage: 'acceptance', message: `提交 ${viewport.width}px 验收：${baselineUrl} → ${targetUrl}${route}` });
        const plan = {
          schemaVersion: 1, name: `${siteId}/${page} 正式门禁 ${viewport.width}px`, mode: 'mirror',
          baselineUrl, targetUrl, routes: [route], viewports: [viewport], points: [],
          thresholds: { visual: cfg.gate?.thresholds?.visual?.pixel?.[level] ?? 0.97 },
        };
        const lane = await runAcceptanceLane({ engine, plan, deadline, pollMs, onProgress, viewport });
        lanes.push({ ...lane, width: viewport.width, baseline: baselineUrl });
        if (lane.status === 'timeout') {
          lanes.push(...viewports.slice(lanes.length).map(missing => ({ width: missing.width, status: 'not_started', report: null, runId: null, baseline: null })));
          break;
        }
      } finally {
        await server?.close().catch(() => {});
      }
    }
    const acceptance = acceptanceDimensions(lanes, viewports);
    const runIds = lanes.map(lane => lane.runId).filter(Boolean);
    const acceptanceMeta = {
      runId: runIds.length === 1 ? runIds[0] : null, runIds, gate: acceptance.value.gate, engine,
      route, target: targetUrl, viewports: lanes.map(lane => ({ width: lane.width, status: lane.status, gate: lane.report?.gate ?? null, runId: lane.runId, baseline: lane.baseline })),
    };
    if (acceptance.status === 'not_measured' && lanes.some(lane => ['timeout', 'not_started'].includes(lane.status))) {
      const gate = { ...attempt.gate, generatedAt: new Date().toISOString(), reason: 'acceptance_timeout', projectSnapshot: snapshot,
        acceptance: acceptanceMeta, dimensions: [acceptance], status: 'incomplete', note: '验收没有覆盖全部配置视口，不当作通过。' };
      const body = writeFormalAttempt(attempt.file, gate);
      return { status: 'incomplete', reason: 'acceptance_timeout', gate, acceptance: acceptanceMeta, reportPath: attempt.file, evidence: { sha256: sha256(body), bytes: Buffer.byteLength(body) } };
    }

    onProgress({ stage: 'evaluate', message: '评估器：整页视觉与六维' });
    const fastR = await fastCompare({ siteId, page, candidate: { dir: projectDir }, viewports: widths }, { browser, record: false });
    const fast = composeGate(fastR.packet, { level, thresholds: cfg.gate?.thresholds ?? null });

    const dims = [...fast.dimensions, acceptance];
    const anyFail = dims.some(d => d.status === 'fail');
    const anyUnknown = dims.some(d => d.status === 'not_measured');
    const changed = projectFingerprint(projectDir) !== snapshot.sha256;
    const status = changed ? 'incomplete' : anyUnknown ? 'incomplete' : anyFail ? 'failed' : 'passed';

    const gate = {
      ...attempt.gate, level, projectDir: resolve(projectDir), generatedAt: new Date().toISOString(), projectSnapshot: snapshot,
      acceptance: acceptanceMeta,
      dimensions: dims, status, ...(changed ? { reason: 'project_changed_during_gate' } : { reason: null }),
      thresholds: fast.thresholds,
      note: status === 'passed'
        ? '正式裁判通过：验收与评估器每一维都过了。'
        : status === 'incomplete'
          ? '有维度没测到或项目在测量期间变化，不当作通过。'
          : '至少一维没过；按 dimensions 与验收报告定位。',
    };
    const body = writeFormalAttempt(attempt.file, gate);
    for (const lane of lanes) if (lane.report) writeFileSync(join(agentDir(siteId), 'gate', page, `${lane.runId}.acceptance.md`), JSON.stringify(lane.report.summary ?? {}, null, 1));
    return { status, gate, fast, report: lanes.length === 1 ? lanes[0].report : null, reports: lanes.map(lane => lane.report), acceptance: { ...acceptanceMeta, summary: acceptance }, reportPath: attempt.file, evidence: { sha256: sha256(body), bytes: Buffer.byteLength(body) } };
  } catch (error) {
    try { writeFormalAttempt(attempt.file, { ...attempt.gate, generatedAt: new Date().toISOString(), reason: 'formal_gate_error' }); } catch {}
    throw error;
  } finally {
    if (own) await browser?.close().catch(() => {});
  }
}
