#!/usr/bin/env node
/**
 * handoff — 一条命令走完全程
 *
 *   node src/handoff.mjs <url> [--max-pages N] [--jobs N] [--allow-bounded] [--skip-verify] [--strict] [--privacy-max-file-bytes N]
 *
 * README 承诺的是"给它一个网址，还你一份能核对的复刻件"，但实际要手动串五条命令，
 * 中间还得自己判断哪步可以跳。这里把它们串成一条：
 *
 *   recon → queue（增量）→ verify（断点续跑）→ assets → deliver
 *
 * 最后写 workspace/<站点>/handoff/README.md：**把"哪些页测到了、哪些没测到、为什么"
 * 写在最前面**。一个诚实写着"120 页里测到 96 页"的包，比一个假装全绿的包有用得多。
 *
 * 退出码：0 = 全流程完成且验证门禁通过；1 = 有页面没测到或某一步失败；2 = 参数错误。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DATA_ROOT, DELIVERABLE, WORKSPACE } from './paths.mjs';
import { findSiteIdentity } from './site-origin.mjs';
import { asUrl } from './url-canon.mjs';
import { writeFileAtomic } from './fsutil.mjs';
import { renderHandoff } from './handoff-report.mjs';
import { createMeasurementReader, summaryMatchesMeasurement } from './verify/measurement-status.mjs';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a) => console.error('[handoff]', ...a);

const argv = process.argv.slice(2);
const TARGET = asUrl(argv.find(a => !a.startsWith('--')) ?? '');
const numFlag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const MAX_PAGES = numFlag('--max-pages', 40);
const JOBS = numFlag('--jobs', 1);
const SKIP_VERIFY = argv.includes('--skip-verify');
const STRICT = argv.includes('--strict');
const privacyMaxFileBytesPresent = argv.some(arg => arg === '--privacy-max-file-bytes' || arg.startsWith('--privacy-max-file-bytes='));
const privacyMaxFileBytesValue = (() => {
  const exact = argv.indexOf('--privacy-max-file-bytes');
  if (exact > -1) return argv[exact + 1];
  const eq = argv.find(arg => arg.startsWith('--privacy-max-file-bytes='));
  return eq?.slice('--privacy-max-file-bytes='.length);
})();
const privacyMaxFileBytes = Number(privacyMaxFileBytesValue);

if (!TARGET) {
  console.error('usage: node src/handoff.mjs <url> [--max-pages N] [--jobs N] [--allow-bounded] [--skip-verify] [--strict] [--privacy-max-file-bytes N]');
  process.exit(2);
}
if (privacyMaxFileBytesPresent && !STRICT) {
  console.error('--privacy-max-file-bytes requires --strict');
  process.exit(2);
}
if (privacyMaxFileBytesPresent
  && (!Number.isInteger(privacyMaxFileBytes)
    || privacyMaxFileBytes < 16 * 1024 * 1024
    || privacyMaxFileBytes > 256 * 1024 * 1024)) {
  console.error('--privacy-max-file-bytes must be an integer from 16777216 to 268435456');
  process.exit(2);
}
if (!Number.isInteger(MAX_PAGES) || MAX_PAGES < 1 || !Number.isInteger(JOBS) || JOBS < 1 || JOBS > 8) {
  console.error('--max-pages must be a positive integer; --jobs must be 1..8');
  process.exit(2);
}

/** 跑一个 CLI 子命令。每个子进程都有自己的 playwright 实例，所以只在步骤之间串行。 */
function run(command, args, { fatal = false } = {}) {
  return new Promise(done => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(CORE, command), ...args], {
      cwd: CORE,
      stdio: 'inherit',
      env: engineEnv(),
    });
    child.on('error', error => {
      log(command, 'spawn failed:', error.message);
      if (fatal) process.exit(1);
      done({ code: 1, ms: Date.now() - started });
    });
    child.on('exit', code => {
      const ms = Date.now() - started;
      log(`${command} 结束（退出码 ${code}，用时 ${(ms / 1000).toFixed(1)}s）`);
      if (fatal && code !== 0) {
        console.error(`[handoff] 关键步骤失败：${command} 退出码 ${code}，后续步骤已停止`);
        process.exit(code ?? 1);
      }
      done({ code: code ?? 1, ms });
    });
  });
}

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// ---------- 0. 引擎 ----------
// queue 不是自己抓页的，它把任务 POST 给引擎（并发槽、任务表、SSE 都在引擎里）。
// 手动跑时引擎通常已经在另一个终端开着；一条命令跑时没人给你开，这里自己管。
let engineChild = null;
const engineEnv = () => {
  const env = { ...process.env, HEIMDALL_INVOKE_CWD: process.cwd() };
  if (engine) { env.HEIMDALL_API = engine.api; env.HEIMDALL_PORT = String(engine.port); }
  return env;
};
let engine = null;

async function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

async function startEngine() {
  // 已经有一个能应答的引擎（HEIMDALL_API 指向它，或者 8900 上正好开着）可以直接用 ——
  // 但**只在数据根一致时**：任务写进引擎的数据根、产物也从同一个数据根读回来。
  // 复用一个用着别的数据目录的引擎，结果是"引擎报告完成，但克隆产物缺失"——
  // 21 世纪最让人抓狂的报错：每一步都返回成功，最后什么都没留下。
  const wantedRoot = process.env.HEIMDALL_DATA_DIR ? resolve(process.env.HEIMDALL_DATA_DIR) : DATA_ROOT;
  const candidates = [process.env.HEIMDALL_API, 'http://127.0.0.1:8900'].filter(Boolean);
  for (const base of candidates) {
    try {
      const res = await fetch(base + '/api/status', {
        headers: process.env.HEIMDALL_TOKEN ? { 'x-heimdall-token': process.env.HEIMDALL_TOKEN } : {},
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) continue;
      const status = await res.json().catch(() => ({}));
      const engineRoot = status.dataRoot ? resolve(status.dataRoot) : null;
      if (!engineRoot) {
        // 老版本引擎不报数据根 —— 无从判断，宁可自己另起一台，也不要赌
        log(`跳过 ${base}：该引擎没有报告数据根，无法确认它和本次写的是同一目录`);
        continue;
      }
      if (engineRoot !== wantedRoot) {
        log(`跳过 ${base} 上的引擎：它的数据根是 ${engineRoot}，本次要写的是 ${wantedRoot}`);
        continue;
      }
      log('复用在跑的引擎', base);
      return { api: base, port: new URL(base).port, owned: false, stop() {} };
    } catch { /* 没开着，接着自己拉一个 */ }
  }

  const port = await freePort();
  const api = `http://127.0.0.1:${port}`;
  log('启动临时引擎', api);
  engineChild = spawn(process.execPath, [join(CORE, 'src', 'engine-server.mjs'), String(port)], {
    cwd: CORE,
    stdio: 'ignore',       // 引擎日志会淹没 handoff 自己的进度；出问题看交接说明
    env: { ...process.env, HEIMDALL_INVOKE_CWD: process.cwd() },
  });
  engineChild.on('error', error => log('引擎启动失败:', error.message));
  // 任何路径退出都别留下孤儿进程
  process.on('exit', () => { try { engineChild?.kill(); } catch {} });

  for (let i = 0; i < 120; i++) {
    await sleep(500);
    try {
      const res = await fetch(api + '/api/status', { signal: AbortSignal.timeout(2000) });
      if (res.ok) return { api, port, owned: true, stop() { try { engineChild?.kill(); } catch {} } };
    } catch { /* 还没起来 */ }
  }
  throw new Error(`临时引擎 60 秒内没有应答：${api}`);
}

try {
  engine = await startEngine();
} catch (error) {
  console.error('[handoff] 引擎启动失败：' + error.message);
  process.exit(1);
}

// ---------- 1. 侦察 ----------
log('1/5 侦察', TARGET, '（最多', MAX_PAGES, '页）');
await run('src/crawler/recon.mjs', [TARGET, String(MAX_PAGES), '2'], { fatal: true });

// 侦察会跟随重定向（example.com → www.example.com），站点目录由落地 origin 决定，
// 所以这里必须把身份读回来，不能拿输入的 host 猜。
const identity = findSiteIdentity(WORKSPACE, TARGET);
const siteId = identity?.siteId;
if (!siteId) {
  console.error('[handoff] 侦察完成了，但没能在 workspace 里找到这个站点。检查 recon 的输出。');
  process.exit(1);
}
const BASE = join(WORKSPACE, siteId);
const host = identity.origin ? new URL(identity.origin).hostname.replace(/^www\./, '') : siteId.replace(/^www\./, '');
log('站点目录', siteId, '（origin', identity.origin ?? '未知', '）');

// ---------- 2. 批量克隆 ----------
// --max 必须跟侦察用同一个页数：queue 自己的默认上限来自站点配方（通常 20 页），
// 只给侦察传 40 的话，用户以为克隆了 40 页、实际只克隆 20 页，而且没有任何提示。
log('2/5 批量克隆（增量：已克隆且源站没变的页会跳过；上限', MAX_PAGES, '页）');
const clone = await run('src/queue.mjs', [host, '--incremental', '--max', String(MAX_PAGES)]);
const cloneFailed = clone.code !== 0;

// ---------- 3. 多视口验证 ----------
const summaryPath = join(BASE, 'verify', 'verify-summary.json');
const readSummaryText = () => { try { return readFileSync(summaryPath, 'utf8'); } catch { return null; } };
const previousSummary = readSummaryText();
let verify = { code: 0, ms: 0, skipped: false };
if (SKIP_VERIFY) {
  log('3/5 验证 已按 --skip-verify 跳过');
  verify.skipped = true;
} else {
  log('3/5 多视口验证（断点续跑，中断后重跑同样的命令会接着来）');
  const args = ['--all', '--resume', '--jobs', String(JOBS)];
  if (argv.includes('--allow-bounded')) args.push('--allow-bounded');
  verify = await run('src/verify/verify.mjs', [host, ...args]);
}

// ---------- 4. 资产缺口 ----------
log('4/5 资产缺口扫描');
const assets = await run('src/audit/assets.mjs', [host, '--max', '100000']);

// ---------- 5. 打包交付 ----------
log('5/5 打包交付');
const deliver = await run('src/deliver.mjs', [host, siteId]);

// 可选的最终门禁复用 live 导出器：交接默认仍只产出静态素材，--strict 才要求独立离线包通过。
let live = null;
if (STRICT) {
  log('6/6 严格离线交付（复用 live 导出器）');
  const liveReportPath = join(BASE, 'live-export.json');
  let previousLiveText = null;
  try { previousLiveText = readFileSync(liveReportPath, 'utf8'); } catch {}
  const liveArgs = [host, '--offline', '--strict', '--heal', '--materialize-har', '--root', 'mirror'];
  if (privacyMaxFileBytesPresent) liveArgs.push(`--privacy-max-file-bytes=${privacyMaxFileBytes}`);
  const result = await run('src/live/export.mjs', liveArgs);
  let currentLiveText = null;
  try { currentLiveText = readFileSync(liveReportPath, 'utf8'); } catch {}
  live = currentLiveText && currentLiveText !== previousLiveText
    ? readJson(liveReportPath) ?? { status: 'invalid', code: result.code }
    : { status: 'missing', code: result.code };
}

// ---------- 交接说明 ----------
const summaryText = readSummaryText();
let summary = !SKIP_VERIFY && summaryText && summaryText !== previousSummary ? readJson(summaryPath) : null;
let summaryEvidence = null;
if (summary) {
  const reader = createMeasurementReader(BASE);
  const invalidPages = [];
  const structurallyInvalid = summary.mode !== 'all' || summary.scoreVersion !== 2 || !Array.isArray(summary.pages)
    || (summary.passed === true && (summary.untested !== 0 || summary.measured !== summary.targetTotal
      || summary.measured !== summary.pages.length || new Set(summary.pages.map(page => page.page)).size !== summary.pages.length
      || summary.pages.some(page => page.measured !== true)));
  if (!structurallyInvalid) {
    for (const page of summary.pages) if (page.measured === true) {
      const measurement = reader.read(page.page);
      if (measurement.status !== 'verified' || !summaryMatchesMeasurement(page, measurement.result)) {
        invalidPages.push({ page: page.page, status: measurement.status });
      }
    }
  }
  if (structurallyInvalid || invalidPages.length) {
    summaryEvidence = { status: 'incomplete', invalidPages };
  } else summaryEvidence = { status: 'verified', invalidPages: [] };
}
const gaps = assets.code === 0 ? readJson(join(BASE, 'audit', 'asset-gaps.json')) : null;
// 交付包目录名带日期，取最新那个；文件夹 mtime 在 Windows 上不可靠，按名字排即可
const delivered = (() => {
  try {
    return deliver.code === 0 ? readdirSync(DELIVERABLE)
      .filter(name => name.startsWith(siteId + '-'))
      .sort((a, b) => b.localeCompare(a))[0] ?? null : null;
  } catch { return null; }
})();

const handoffDir = join(BASE, 'handoff');
mkdirSync(handoffDir, { recursive: true });
const reportPath = join(handoffDir, 'README.md');
writeFileAtomic(reportPath, renderHandoff({
  siteId, origin: identity.origin ?? TARGET, target: TARGET, summary, gaps, delivered, skippedVerify: SKIP_VERIFY,
  summaryEvidence, verifyFailed: !SKIP_VERIFY && (verify.code !== 0 || !summary || summaryEvidence?.status !== 'verified'), maxPages: MAX_PAGES,
  strictRequested: STRICT, live,
}));

const ok = !cloneFailed && (SKIP_VERIFY || (verify.code === 0 && summary?.passed === true))
  && (SKIP_VERIFY || summaryEvidence?.status === 'verified')
  && assets.code === 0 && deliver.code === 0
  && (!STRICT || (live?.status === 'passed' && live.published === true && live.blockingCount === 0));
log('交接说明 ->', reportPath);
log(ok ? (SKIP_VERIFY ? '流程完成，本次跳过验证' : '全流程完成，验证门禁通过')
  : '流程未全部通过，检查交接说明和步骤日志');
console.log(reportPath);
process.exit(ok ? 0 : 1);
