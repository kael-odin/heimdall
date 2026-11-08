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
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { comparePngBuffers } from '../verify/compare.mjs';
import { isSitePath } from './workspace.mjs';

export const BASELINE_SCHEMA = 'heimdall.qa-baseline/1';
export const DEFAULT_BASELINE_THRESHOLD = 0.98;

export const baselineFile = (ws) => join(ws.dataDir, 'baseline.json');

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const round = (value) => Math.round(value * 10000) / 10000;
const runIdValid = value => typeof value === 'string' && /^qa-\d{8}-\d{6}-[0-9a-f]{4}$/.test(value);
const viewportValid = value => typeof value === 'string' && /^\d+x\d+$/.test(value);
const screenshotValid = value => typeof value === 'string' && /^shots\/[a-z0-9_.-]+\.png$/i.test(value);
const pageKey = page => JSON.stringify([page.path, page.viewport]);
const originOf = value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
};

function baselineState(ws) {
  let text;
  try { text = readFileSync(baselineFile(ws), 'utf8'); }
  catch (error) {
    return error.code === 'ENOENT' ? { status: 'unconfigured' } : { status: 'invalid', reason: '基线文件无法读取' };
  }
  let data;
  try { data = JSON.parse(text); } catch { return { status: 'invalid', reason: '基线文件为空或不是合法 JSON' }; }
  if (data?.schema === BASELINE_SCHEMA && data.cleared === true) return { status: 'cleared' };
  if (data?.schema !== BASELINE_SCHEMA || !runIdValid(data.runId) || typeof data.site !== 'string' || !data.site
    || typeof data.environment !== 'string' || !data.environment || !Array.isArray(data.pages) || !data.pages.length
    || (data.missing != null && !Array.isArray(data.missing))) {
    return { status: 'invalid', reason: '基线格式或必填信息不完整' };
  }
  const keys = new Set();
  for (const page of [...data.pages, ...(data.missing ?? [])]) {
    if (!page || !isSitePath(page.path) || !viewportValid(page.viewport) || keys.has(pageKey(page))) {
      return { status: 'invalid', reason: '基线页面或视口无效或重复' };
    }
    keys.add(pageKey(page));
  }
  if (data.pages.some(page => !runIdValid(page.runId) || page.runId !== data.runId || !screenshotValid(page.screenshot))
    || (data.origin != null && !originOf(data.origin))) {
    return { status: 'invalid', reason: '基线截图路径或来源无效' };
  }
  return { status: 'ready', baseline: data };
}

function saveBaseline(ws, data) {
  mkdirSync(ws.dataDir, { recursive: true });
  const file = baselineFile(ws);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  let owned = false;
  try {
    const fd = openSync(temp, 'wx');
    owned = true;
    try { writeFileSync(fd, JSON.stringify(data, null, 2) + '\n'); } finally { closeSync(fd); }
    renameSync(temp, file);
  } finally {
    if (owned) { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}

export function readBaseline(ws) {
  return baselineState(ws).baseline ?? null;
}

/**
 * 把一次运行登记为基线。pages 来自 run.coverage.pages（path / viewport / screenshot）。
 * 任何页面或截图不完整时保留原基线，不用部分结果替换。
 */
export function writeBaseline(ws, run, pages) {
  if (!runIdValid(run?.runId) || typeof run.site !== 'string' || !run.site || typeof run.environment !== 'string' || !run.environment
    || !originOf(run.siteUrl) || !Array.isArray(pages)) {
    const error = new Error('运行的站点、环境或来源不完整，不能登记基线；原基线未更改');
    error.code = 'invalid_args';
    throw error;
  }
  const entries = [];
  const missing = [];
  const keys = new Set();
  for (const page of pages) {
    if (!page || !isSitePath(page.path) || !viewportValid(page.viewport) || keys.has(pageKey(page))) {
      missing.push({ path: page?.path ?? '', viewport: page?.viewport ?? '', reason: '页面或视口无效或重复' });
      continue;
    }
    keys.add(pageKey(page));
    if (page.unavailableReason) { missing.push({ path: page.path, viewport: page.viewport, reason: page.unavailableReason === 'login-expired' ? '登录失效' : '页面不可用' }); continue; }
    if (page.navError) { missing.push({ path: page.path, viewport: page.viewport, reason: '页面打不开' }); continue; }
    if (!page.screenshot) { missing.push({ path: page.path, viewport: page.viewport, reason: '没有截图' }); continue; }
    if (!screenshotValid(page.screenshot)) { missing.push({ path: page.path, viewport: page.viewport, reason: '截图路径无效' }); continue; }
    const file = join(ws.dataDir, 'runs', run.runId, page.screenshot);
    try {
      const image = PNG.sync.read(readFileSync(file));
      if (!image.width || !image.height) throw new Error('empty image');
      entries.push({ path: page.path, viewport: page.viewport, screenshot: page.screenshot, bytes: statSync(file).size, runId: run.runId });
    } catch { missing.push({ path: page.path, viewport: page.viewport, reason: '截图缺失或无法读取' }); }
  }
  if (missing.length && (entries.length || missing.some(page => ['登录失效', '页面不可用', '页面打不开'].includes(page.reason)))) {
    const error = new Error(`不能登记不完整基线；原基线未更改：${missing.map(page => `${page.path}（${page.viewport}）${page.reason}`).join('；')}`);
    error.code = 'invalid_args';
    throw error;
  }
  if (!entries.length) {
    const error = new Error(`${missing.some(page => page.reason === '登录失效') ? '登录失效，' : ''}没有可登记的业务页面截图；原基线未更改`);
    error.code = 'invalid_args';
    throw error;
  }
  const baseline = {
    schema: BASELINE_SCHEMA,
    runId: run.runId,
    site: run.site,
    environment: run.environment,
    origin: originOf(run.siteUrl),
    labelledAt: new Date().toISOString(),
    pages: entries,
  };
  saveBaseline(ws, baseline);
  return baseline;
}

export function clearBaseline(ws) {
  saveBaseline(ws, { schema: BASELINE_SCHEMA, cleared: true });
  return { cleared: true };
}

const viewportKey = (page) => `${page.viewport}`;

/** 新运行里与基线可比的页面：同 path、同视口、两边都有截图。 */
export function comparablePairs(baseline, pages) {
  const byKey = new Map();
  for (const page of pages) {
    if (!page.screenshot || page.unavailableReason || page.navError) continue;
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
  const state = baselineState(ws);
  const empty = (status, reason, enabled = false) => ({ status, enabled, findings: [], compared: 0,
    skipped: [{ reason, ...(status === 'incomplete' ? { incomplete: true } : {}) }], scope: `${reason}，未进行跨运行视觉比对。` });
  if (state.status === 'invalid') return empty('incomplete', state.reason, true);
  const baseline = state.baseline;
  if (!baseline) return empty('unconfigured', state.status === 'cleared' ? '基线已清除' : '没有登记基线');
  if (baseline.site !== run.site) {
    return empty('not_applicable', `基线属于站点 ${baseline.site}，本次是 ${run.site}`);
  }
  if (baseline.environment !== run.environment) return empty('incomplete', '基线与本次运行的环境不同', true);
  const original = baseline.origin ? null : readJson(join(ws.dataDir, 'runs', baseline.runId, 'run.json'));
  const baseOrigin = baseline.origin ? originOf(baseline.origin)
    : original?.runId === baseline.runId && original.site === baseline.site && original.environment === baseline.environment ? originOf(original.siteUrl) : null;
  const currentOrigin = originOf(run.siteUrl);
  if (!baseOrigin || !currentOrigin) return empty('incomplete', '无法确认基线或本次运行的站点来源', true);
  if (baseOrigin !== currentOrigin) return empty('incomplete', '基线与本次运行的站点来源不同', true);
  const byKey = new Map(baseline.pages.map(base => [pageKey(base), base]));
  const formerlyMissing = new Set((baseline.missing ?? []).map(pageKey));
  const findings = [];
  let compared = 0;
  const skipped = [];
  const skip = (page, reason, incomplete = true) => skipped.push({ path: page.path, viewport: page.viewport, reason, ...(incomplete ? { incomplete: true } : {}) });
  if (diffDir) mkdirSync(diffDir, { recursive: true });
  for (const page of pages) {
    const base = byKey.get(pageKey(page));
    if (!base) {
      skip(page, formerlyMissing.has(pageKey(page)) ? '历史基线登记时截图缺失' : '该页面或视口未登记基线', formerlyMissing.has(pageKey(page)));
      continue;
    }
    if (page.unavailableReason || page.navError) { skip(page, page.unavailableReason === 'login-expired' ? '登录失效' : '页面打不开'); continue; }
    if (!screenshotValid(page.screenshot)) { skip(page, page.screenshot ? '本次截图路径无效' : '本次截图缺失'); continue; }
    const baseFile = join(ws.dataDir, 'runs', base.runId, base.screenshot);
    const nowFile = join(ws.dataDir, 'runs', run.runId, page.screenshot);
    if (!existsSync(baseFile)) { skip(page, '基线截图缺失'); continue; }
    if (!existsSync(nowFile)) { skip(page, '本次截图缺失'); continue; }
    let result;
    try {
      result = comparePngBuffers(readFileSync(baseFile), readFileSync(nowFile));
    } catch (error) {
      skip(page, `截图无法读取：${String(error?.message ?? error).slice(0, 80)}`);
      continue;
    }
    compared++;
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
    status: skipped.some(item => item.incomplete) ? 'incomplete' : !compared ? 'unmatched' : skipped.length ? 'partial' : 'compared',
    enabled: true,
    findings,
    compared,
    skipped,
    scope: `本次同站、同环境、同来源、同页同视口比对 ${compared} 对；${skipped.length} 项未比对。低于 ${(threshold * 100).toFixed(0)}% 的记一条回归发现，动态内容需人工复核。`,
  };
}

/** 基线摘要：给 qa status / 报告用 */
export function describeBaseline(ws) {
  const state = baselineState(ws);
  const baseline = state.baseline;
  if (!baseline) return { exists: state.status === 'invalid', status: state.status, ...(state.reason ? { reason: state.reason } : {}) };
  const missingScreenshots = baseline.pages.filter(page => {
    try { return !statSync(join(ws.dataDir, 'runs', page.runId, page.screenshot)).isFile(); } catch { return true; }
  }).length;
  return { exists: true, status: missingScreenshots ? 'incomplete' : 'registered',
    ...(missingScreenshots ? { missingScreenshots, reason: `${missingScreenshots} 张基线截图缺失或无法读取` } : {}),
    runId: baseline.runId, site: baseline.site, labelledAt: baseline.labelledAt, pages: baseline.pages.length,
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
