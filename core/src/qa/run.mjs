/**
 * qa/run — 一次测试运行：探测 → 指纹 → 套裁决 → 报告
 *
 * 运行目录 <dataDir>/runs/<runId>/：
 *   run.json        参数与覆盖（不含任何凭据）
 *   findings.json   所有发现（检查器 + agent 提交），每条带 triage
 *   report.md       给人看的全量报告
 *   bugs.md         只含「该提单」的问题，可以直接贴给开发
 *   shots/          截图
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { loadWorkspace, findWorkspace, resolveLogin, describeLogin, inWorkspace, scrubSecrets, scrubValues } from './workspace.mjs';
import { probeSite, normalizeCheck } from './probe.mjs';
import { exploreSite, EXPLORE_DEFAULTS } from './explore.mjs';
import { compareWithBaseline, readBaseline, DEFAULT_BASELINE_THRESHOLD } from './baseline.mjs';
import { normalizeFinding, VERDICT_LABEL } from './findings.mjs';
import { readRules, applyVerdicts, ruleHits } from './memory.mjs';
import { renderReport, renderBugs, fileable } from './report.mjs';

const fail = (message, code = 'invalid_args') => { const e = new Error(message); e.code = code; throw e; };
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

/** 找到并读取工作区：显式路径 > HEIMDALL_QA_WORKSPACE > 调用目录向上找 */
export function openWorkspace(dir, ctx = {}) {
  const start = dir ?? process.env.HEIMDALL_QA_WORKSPACE ?? ctx.cwd ?? process.env.HEIMDALL_INVOKE_CWD ?? process.cwd();
  const found = findWorkspace(start);
  if (!found) fail(`在 ${start} 及上级目录没找到 .heimdall/qa.json。先在测试工作区运行 heimdall qa init，或传 workspace 参数`, 'not_found');
  return loadWorkspace(found);
}

export const runsDir = (ws) => join(ws.dataDir, 'runs');
const newRunId = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `qa-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomBytes(2).toString('hex')}`;
};

export function listRuns(ws, limit = 20) {
  const dir = runsDir(ws);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.startsWith('qa-')).sort().reverse().slice(0, limit)
    .map(id => readJson(join(dir, id, 'run.json'))).filter(Boolean);
}

export function readRun(ws, runId) {
  const id = runId === 'latest' || !runId ? listRuns(ws, 1)[0]?.runId : runId;
  if (!id || !/^qa-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/.test(id)) fail(runId ? `运行编号不合法：${runId}` : '还没有任何运行', 'not_found');
  const dir = join(runsDir(ws), id);
  const run = readJson(join(dir, 'run.json'));
  if (!run) fail(`没有运行 ${id}`, 'not_found');
  return { dir, run, findings: readJson(join(dir, 'findings.json')) ?? [] };
}

/** 读检查点：内联数组，或工作区里的 JSON 文件（{ checks: [...] } 或数组） */
export function loadChecks(ws, { checks, checksFile, site }) {
  let raw = checks ?? [];
  if (checksFile) {
    const file = inWorkspace(ws, checksFile);
    const data = readJson(file);
    if (!data) fail(`检查点文件读不出来：${checksFile}`);
    raw = raw.concat(Array.isArray(data) ? data : (data.checks ?? []).filter(c => !c.site || c.site === site));
  }
  return raw.map((c, i) => normalizeCheck(c, i));
}

/** qa.json 里带 match 的约定 → 「团队约定」规则 */
function conventionRules(ws) {
  return ws.conventions.filter(c => c.match).map(c => ({ id: `conv:${c.id}`, verdict: 'convention', reason: c.text, match: c.match, by: 'qa.json', at: '1970-01-01T00:00:00.000Z' }));
}

export function allRules(ws) {
  return [...conventionRules(ws), ...readRules(ws.dataDir)];
}

/** 给发现编号并套裁决；已有编号的保留 */
export function triage(ws, findings, { environment } = {}) {
  const triaged = applyVerdicts(findings, allRules(ws), { environment });
  let n = Math.max(0, ...triaged.map(f => Number(String(f.id ?? '').replace(/^F/, '')) || 0));
  return triaged.map(f => (f.id ? f : { ...f, id: `F${++n}` }));
}

/** 同一次运行里指纹相同的发现合并（多个视口看到同一个问题只算一条） */
function dedupe(findings) {
  const byFp = new Map();
  for (const f of findings) {
    const prev = byFp.get(f.fingerprint);
    if (!prev) { byFp.set(f.fingerprint, { ...f, seen: 1, viewports: f.viewport || f.evidence?.viewport ? [f.viewport ?? f.evidence.viewport] : [] }); continue; }
    prev.seen++;
    const vp = f.viewport ?? f.evidence?.viewport;
    if (vp && !prev.viewports.includes(vp)) prev.viewports.push(vp);
  }
  return [...byFp.values()];
}

export function writeRunFiles(ws, dir, run, findings) {
  writeFileSync(join(dir, 'run.json'), JSON.stringify(run, null, 2));
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(findings, null, 2));
  const hits = ruleHits(findings);
  writeFileSync(join(dir, 'report.md'), renderReport({ ws, run, findings, hits }));
  writeFileSync(join(dir, 'bugs.md'), renderBugs({ ws, run, findings }));
  return { report: join(dir, 'report.md'), bugs: join(dir, 'bugs.md') };
}

export function summarize(findings) {
  const s = { total: findings.length, fileable: 0, new: 0, knownBug: 0, suppressed: 0, reopened: 0, tolerable: 0, environment: 0, checkNeedsFix: 0 };
  for (const f of findings) {
    const t = f.triage?.status;
    if (t === 'suppressed') s.suppressed++;
    else if (t === 'known-bug') s.knownBug++;
    else if (t === 'reopened') s.reopened++;
    else s.new++;
    if (fileable(f)) s.fileable++;
    else if (f.kind === 'login-expired' || f.confidence === 'environment') s.environment++;
    else if (f.confidence === 'check-unverified' || f.confidence === 'check-error') s.checkNeedsFix++;
    else if (t !== 'suppressed' && f.tier === 'tolerable') s.tolerable++;
  }
  return s;
}

/**
 * 跑一次。args：{ site, pages?, checks?, checksFile?, viewports?, linkCheck?, collectTexts?, label? }
 * 返回 { run, findings, files }
 */
export async function runQa(ws, args = {}, { onProgress = () => {}, browser } = {}) {
  const siteName = args.site ?? Object.keys(ws.sites)[0];
  const site = ws.sites[siteName];
  if (!site) fail(`qa.json 里没有站点 ${siteName}；有：${Object.keys(ws.sites).join('、')}`, 'not_found');
  const pages = (args.pages?.length ? args.pages.map(p => (typeof p === 'string' ? { path: p } : p)) : site.pages)
    .filter(p => typeof p.path === 'string' && p.path.startsWith('/') && !p.path.startsWith('//')).slice(0, 40);
  if (!pages.length) fail('没有要测的页面');
  const checks = loadChecks(ws, { checks: args.checks, checksFile: args.checksFile, site: siteName });
  const viewports = (args.viewports?.length ? args.viewports : [ws.defaults.viewport.width ?? 1440])
    .slice(0, 3).map(w => (typeof w === 'object' ? w : { width: Number(w), height: Number(w) < 500 ? 844 : Number(w) < 1000 ? 1024 : 900 }));
  const login = resolveLogin(ws, args.login ?? site.login);
  const runId = newRunId();
  const dir = join(runsDir(ws), runId);
  mkdirSync(join(dir, 'shots'), { recursive: true });
  const startedAt = new Date().toISOString();
  // 截图按「名字的稳定哈希」命名：跨运行同名同文件，基线比对与报告链接才稳定。
  const shoot = async (page, name) => {
    const safe = String(name).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 60);
    const stamp = createHash('sha1').update(String(name)).digest('hex').slice(0, 6);
    const file = `shots/${safe}-${stamp}.png`;
    try { await page.screenshot({ path: join(dir, file), timeout: 10_000 }); return file; } catch { return null; }
  };
  const probe = await probeSite({ site, login, pages, checks, viewports, settleMs: ws.defaults.settleMs, timeoutMs: ws.defaults.timeoutMs,
    linkCheck: args.linkCheck !== false, linkLimit: args.linkLimit ?? 60, collectTexts: !!args.collectTexts,
    detect: detectEnabled(ws, args), detectOptions: detectOptionsOf(ws, args), shoot, browser, onProgress });
  // 交互探索会改变页面状态，默认关闭；显式开启后只点声明页面里的有限控件。
  const exploreOptions = exploreOptionsOf(ws, args);
  const exploration = exploreEnabled(ws, args)
    ? await exploreSite({ site, login, pages, viewport: viewports[0], maxPerPage: exploreOptions.maxPerPage,
        budgetMs: exploreOptions.budgetMs, settleMs: ws.defaults.settleMs, browser, onProgress })
    : null;
  const pageEntries = probe.pages.map(p => ({ path: p.path, viewport: `${p.viewport.width}x${p.viewport.height}`, screenshot: p.screenshot, url: p.url,
    navError: p.navError, ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}) }));
  // 跨运行回归：只有显式登记过基线且站点一致时才比对；动态内容会带来噪声，结果按可裁决的发现输出。
  const baselineCfg = ws.defaults?.baseline && typeof ws.defaults.baseline === 'object' ? ws.defaults.baseline : {};
  const regression = args.baseline === false
    ? { findings: [], compared: 0, skipped: [{ reason: '本次显式关闭' }], scope: '本次运行关闭了跨运行回归比对。' }
    : compareWithBaseline(ws, { site: siteName, runId, environment: site.environment }, pageEntries,
      { threshold: baselineCfg.threshold ?? DEFAULT_BASELINE_THRESHOLD, diffDir: join(dir, 'shots') });
  const raw = scrubValues([...probe.findings, ...(exploration?.findings ?? []), ...regression.findings], login.secrets).map((f) => {
    const notFound = f.kind === 'assertion' && f.confidence === 'observed' && /实际：null/.test(f.observed ?? '');
    const confidence = f.kind === 'login-expired' ? 'environment' : f.confidence === 'check-error' ? 'check-error' : notFound ? 'check-unverified' : f.confidence;
    return normalizeFinding({ ...f, confidence }, { site: siteName, runId, source: 'check' }).finding;
  });
  const findings = scrubValues(triage(ws, dedupe(raw), { environment: site.environment }), login.secrets);
  const run = {
    schema: 'heimdall.qa-run/1', runId, project: ws.project, site: siteName, siteUrl: site.url, environment: site.environment,
    label: args.label ?? null, startedAt, endedAt: new Date().toISOString(),
    login: login.name ? { ...describeLogin(ws, login.name), expiresAt: login.expiresAt } : null,
    requestPolicy: { mode: site.writes, allowedQueries: site.writeAllow ?? [] },
    coverage: {
      pages: probe.pages.map(p => ({ path: p.path, viewport: `${p.viewport.width}x${p.viewport.height}`, navError: p.navError,
        ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}), ...(p.detectorError ? { detectorError: p.detectorError } : {}),
        title: p.title ? scrubSecrets(p.title, login.secrets) : null, counts: p.counts, screenshot: p.screenshot })),
      checks: probe.checks.map(c => ({ id: c.id, title: c.title, pass: c.pass, error: c.error, screenshot: c.screenshot,
        ...(c.blockedReason ? { blockedReason: c.blockedReason } : {}) })),
      viewports: viewports.map(v => `${v.width}x${v.height}`),
      detection: {
        enabled: detectEnabled(ws, args),
        pages: detectEnabled(ws, args) ? probe.pages.filter(p => !p.navError && !p.unavailableReason && !p.detectorError).length : 0,
        failedPages: probe.pages.filter(p => p.detectorError).map(p => ({ path: p.path, viewport: `${p.viewport.width}x${p.viewport.height}` })),
        findings: probe.findings.filter(f => f.detector).length,
        detectors: [...new Set(probe.pages.flatMap(p => p.counts?.detectors ?? []))].sort(),
      },
      explore: exploration
        ? {
          enabled: true,
          pages: exploration.pages.map(p => ({ path: p.path, controls: p.controls, clicked: p.clicked, skipped: p.skipped, findings: p.findings, budgetExhausted: p.budgetExhausted })),
          scope: exploration.scope,
        }
        : { enabled: false },
      baseline: {
        enabled: readBaseline(ws) !== null && args.baseline !== false,
        compared: regression.compared,
        skipped: regression.skipped,
        scope: regression.scope,
      },
    },
    summary: summarize(findings),
  };
  const safeRun = scrubValues(run, login.secrets);
  if (args.collectTexts) writeFileSync(join(dir, 'texts.json'), JSON.stringify(scrubValues(probe.texts, login.secrets), null, 1));
  const files = writeRunFiles(ws, dir, safeRun, findings);
  return { run: safeRun, findings, files, dir };
}

/** agent 提交发现：校验证据门槛，套裁决，写回运行并重出报告 */
export function submitFindings(ws, runId, items, { by = 'agent' } = {}) {
  const { dir, run, findings } = readRun(ws, runId);
  const accepted = [], rejected = [];
  for (const [i, item] of items.entries()) {
    const { finding, problems } = normalizeFinding({ ...item, path: item.path ?? '/' }, { site: item.site ?? run.site, runId: run.runId, source: 'agent' });
    const hard = problems.filter(p => !p.includes('已自动降级'));
    if (hard.length) { rejected.push({ index: i, title: item.title ?? null, problems: hard }); continue; }
    if (findings.some(f => f.fingerprint === finding.fingerprint)) { rejected.push({ index: i, title: finding.title, problems: ['本次运行里已经有同一条发现'], fingerprint: finding.fingerprint }); continue; }
    finding.by = by;
    const notes = problems.filter(p => p.includes('已自动降级'));
    accepted.push({ ...finding, ...(notes.length ? { notes } : {}) });
  }
  const merged = triage(ws, [...findings, ...accepted], { environment: run.environment });
  run.summary = summarize(merged);
  const files = writeRunFiles(ws, dir, run, merged);
  const added = merged.filter(f => accepted.some(a => a.fingerprint === f.fingerprint));
  return { run, added, rejected, files };
}

/** 记过裁决之后，把最新运行重新套一遍，报告随之更新 */
export function retriageRun(ws, runId) {
  const { dir, run, findings } = readRun(ws, runId);
  const merged = triage(ws, findings.map(({ triage: _t, ...f }) => f), { environment: run.environment });
  run.summary = summarize(merged);
  const files = writeRunFiles(ws, dir, run, merged);
  return { run, findings: merged, files };
}

export function relPath(ws, file) {
  return relative(ws.root, file).replace(/\\/g, '/');
}

/** 无参照物检测的开关：args.detect > qa.json defaults.detect.enabled > 默认开 */
export function detectEnabled(ws, args = {}) {
  if (args.detect === false) return false;
  if (args.detect === true) return true;
  const cfg = ws.defaults?.detect;
  if (cfg && typeof cfg === 'object' && cfg.enabled === false) return false;
  return true;
}

/** 检测阈值：qa.json defaults.detect 与本次参数合并（数值型覆盖） */
export function detectOptionsOf(ws, args = {}) {
  const cfg = ws.defaults?.detect && typeof ws.defaults.detect === 'object' ? ws.defaults.detect : {};
  const { enabled: _enabled, thresholds: cfgThresholds = {}, ...rest } = cfg;
  return { ...rest, thresholds: { ...cfgThresholds, ...(args.detectThresholds ?? {}) } };
}

/** 交互探索默认关闭：它会点击页面，必须由操作者显式开启。 */
export function exploreEnabled(ws, args = {}) {
  if (args.explore === true) return true;
  if (args.explore === false) return false;
  return ws.defaults?.explore === true;
}

export function exploreOptionsOf(ws, args = {}) {
  const cfg = ws.defaults?.explore && typeof ws.defaults.explore === 'object' ? ws.defaults.explore : {};
  return {
    maxPerPage: args.exploreMax ?? cfg.maxPerPage ?? EXPLORE_DEFAULTS.maxPerPage,
    budgetMs: args.exploreBudgetMs ?? cfg.budgetMs ?? EXPLORE_DEFAULTS.budgetMs,
  };
}

export { VERDICT_LABEL };
