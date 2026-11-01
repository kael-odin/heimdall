/**
 * qa/baseline — 跨运行的视觉回归：上一次批准的页面长什么样，这一次变了没有
 *
 * 没有参照站时，同类项目最容易漏的是「这次改坏了上次好的地方」。
 * 把某次运行显式登记为基线（`heimdall qa baseline`），之后每次 `qa run` 都对
 * 同一页面、同一视口的截图做像素比对；低于阈值就生成一条 `regression` 发现，
 * 附基线截图、本次截图与差异图。
 *
 * 边界：
 *   · 只比对**同一站点、同一页面、同一视口**的截图；新增页面不算回归。
 *   · 动态内容（广告、时间、随机图）会造成噪声，报告里如实写相似度与差异图，
 *     由人裁决；顶层可用 `qa verdict ... false-positive --pattern` 过滤一类噪声。
 *   · 基线只引用运行目录里的截图；运行目录被清理后，比对会明确报「基线截图缺失」，
 *     不会静默通过。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { comparePngBuffers } from '../verify/compare.mjs';

export const BASELINE_SCHEMA = 'heimdall.qa-baseline/1';
export const DEFAULT_BASELINE_THRESHOLD = 0.98;

export const baselineFile = (ws) => join(ws.dataDir, 'baseline.json');

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const round = (value) => Math.round(value * 10000) / 10000;

export function readBaseline(ws) {
  const data = readJson(baselineFile(ws));
  return data?.schema === BASELINE_SCHEMA && Array.isArray(data.pages) ? data : null;
}

/**
 * 把一次运行登记为基线。pages 来自 run.coverage.pages（path / viewport / screenshot）。
 * 截图缺失的页面不登记，并在结果里列出，避免基线里出现读不到的引用。
 */
export function writeBaseline(ws, run, pages) {
  const entries = [];
  const missing = [];
  for (const page of pages) {
    if (!page.screenshot) { missing.push({ path: page.path, viewport: page.viewport, reason: '没有截图' }); continue; }
    const file = join(ws.dataDir, 'runs', run.runId, page.screenshot);
    if (!existsSync(file)) { missing.push({ path: page.path, viewport: page.viewport, reason: '截图文件不存在' }); continue; }
    const stat = statSync(file);
    entries.push({ path: page.path, viewport: page.viewport, screenshot: page.screenshot, bytes: stat.size, runId: run.runId });
  }
  const baseline = {
    schema: BASELINE_SCHEMA,
    runId: run.runId,
    site: run.site,
    environment: run.environment,
    labelledAt: new Date().toISOString(),
    pages: entries,
    ...(missing.length ? { missing } : {}),
  };
  mkdirSync(ws.dataDir, { recursive: true });
  writeFileSync(baselineFile(ws), JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

export function clearBaseline(ws) {
  const file = baselineFile(ws);
  if (existsSync(file)) writeFileSync(file, '');
  return { cleared: true };
}

const viewportKey = (page) => `${page.viewport}`;

/** 新运行里与基线可比的页面：同 path、同视口、两边都有截图。 */
export function comparablePairs(baseline, pages) {
  const byKey = new Map();
  for (const page of pages) {
    if (!page.screenshot) continue;
    byKey.set(`${page.path}|${viewportKey(page)}`, page);
  }
  const pairs = [];
  for (const base of baseline.pages) {
    const page = byKey.get(`${base.path}|${base.viewport}`);
    if (page) pairs.push({ base, page });
  }
  return pairs;
}

/**
 * 用基线比对本次运行。返回 { findings, compared, skipped, scope }。
 * 每对页面产生至多一条发现；相似度与差异图都写进证据。
 */
export function compareWithBaseline(ws, run, pages, { threshold = DEFAULT_BASELINE_THRESHOLD, diffDir } = {}) {
  const baseline = readBaseline(ws);
  if (!baseline) return { findings: [], compared: 0, skipped: [{ reason: '没有登记基线' }], scope: '未登记基线，跳过跨运行回归比对。' };
  if (baseline.site !== run.site) {
    return { findings: [], compared: 0, skipped: [{ reason: `基线属于站点 ${baseline.site}，本次是 ${run.site}` }],
      scope: '基线与本次运行的站点不同，跳过回归比对。' };
  }
  const pairs = comparablePairs(baseline, pages);
  const findings = [];
  const skipped = [];
  if (diffDir) mkdirSync(diffDir, { recursive: true });
  for (const { base, page } of pairs) {
    const baseFile = join(ws.dataDir, 'runs', base.runId, base.screenshot);
    const nowFile = join(ws.dataDir, 'runs', run.runId, page.screenshot);
    if (!existsSync(baseFile)) { skipped.push({ path: base.path, viewport: base.viewport, reason: '基线截图缺失' }); continue; }
    if (!existsSync(nowFile)) { skipped.push({ path: page.path, viewport: page.viewport, reason: '本次截图缺失' }); continue; }
    let result;
    try {
      result = comparePngBuffers(readFileSync(baseFile), readFileSync(nowFile));
    } catch (error) {
      skipped.push({ path: page.path, viewport: page.viewport, reason: `截图无法读取：${String(error?.message ?? error).slice(0, 80)}` });
      continue;
    }
    const score = round(result.score);
    if (score >= threshold) continue;
    let diffFile = null;
    if (diffDir && result.diffPng) {
      diffFile = `shots/regression-${String(page.path).replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}-${page.viewport}.png`;
      try { writeFileSync(join(ws.dataDir, 'runs', run.runId, diffFile), result.diffPng); } catch { diffFile = null; }
    }
    findings.push({
      kind: 'regression', path: page.path, target: `${page.viewport}`,
      match: `baseline ${base.runId} ${page.viewport}`,
      title: `页面外观与基线不一致（${page.viewport}）：相似度 ${(score * 100).toFixed(2)}%`,
      basis: 'wrong', tier: 'degrade',
      observed: `与基线运行 ${base.runId} 同页同视口截图比较，相似度 ${(score * 100).toFixed(2)}%，低于阈值 ${(threshold * 100).toFixed(0)}%`,
      loss: '访客看到的外观和上次批准的版本不同，可能是改动引入的回归',
      repro: [`打开 ${page.path}（${page.viewport}）`, `与基线截图 ${base.runId} 比对`, '查看差异图'],
      viewport: page.viewport,
      evidence: {
        url: page.url ?? null, viewport: page.viewport, screenshot: page.screenshot,
        baselineScreenshot: `runs/${base.runId}/${base.screenshot}`,
        ...(diffFile ? { diff: diffFile } : {}),
        score,
        threshold,
      },
    });
  }
  return {
    findings,
    compared: pairs.length,
    skipped,
    scope: `基线与本次同站同页同视口比对 ${pairs.length} 对；低于 ${(threshold * 100).toFixed(0)}% 的记一条回归发现。动态内容会对相似度有影响，请结合差异图复核。`,
  };
}

/** 基线摘要：给 qa status / 报告用 */
export function describeBaseline(ws) {
  const baseline = readBaseline(ws);
  if (!baseline) return { exists: false };
  return { exists: true, runId: baseline.runId, site: baseline.site, labelledAt: baseline.labelledAt, pages: baseline.pages.length,
    ...(baseline.missing?.length ? { missing: baseline.missing.length } : {}) };
}

/** 列出可用的运行（基线候选），按时间倒序 */
export function listRunCandidates(ws, limit = 10) {
  const dir = join(ws.dataDir, 'runs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => /^qa-\d{8}-\d{6}-[0-9a-f]{4}$/.test(name)).sort().reverse().slice(0, limit)
    .map(id => readJson(join(dir, id, 'run.json')))
    .filter(Boolean)
    .map(run => ({ runId: run.runId, site: run.site, startedAt: run.startedAt, summary: run.summary }));
}

export const relativeToRun = (runDir, file) => relative(runDir, file).replace(/\\/g, '/');
