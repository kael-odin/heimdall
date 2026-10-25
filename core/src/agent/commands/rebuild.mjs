/**
 * heimdall rebuild init | status —— 重建工作区（CLI 专属，PRD 附录 A §5.2、E7-01）
 *
 *   heimdall rebuild init <url|siteId> [--page P] [--stack html-css|vite-react-ts-tailwind]
 *                         [--fidelity faithful|balanced|idiomatic] [--gate bronze|silver|gold]
 *                         [--dir D] [--port 5199] [--model-class frontier|standard|economy]
 *                         [--no-git] [--no-install] [--registry URL] [--json]
 *   heimdall rebuild status [--project .] [--json]
 *
 * init 给的是 URL 且本机还没有镜像时，先走 clone（引擎排队执行）；给 siteId 时用已有镜像。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKSPACE } from '../../paths.mjs';
import { siteIdForOrigin } from '../../site-origin.mjs';
import { resolvePageNameOfUrl } from '../../url-canon.mjs';
import { ok, fail, fromError, exitCodeOf, nextAction, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';
import { invoke } from '../registry/invoke.mjs';
import { initWorkspace } from '../rebuild/init.mjs';
import { readProjectConfig } from '../evidence/compare.mjs';
import { listPages } from '../workspace.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

async function init(flags, positional, log) {
  const target = positional[0];
  if (!target) throw new CapabilityError('invalid_args', '用法：heimdall rebuild init <url|siteId> [--page P] [--stack …] [--dir D]');
  let siteId, page = flags.page;
  if (/^https?:\/\//i.test(target)) {
    const u = new URL(target);
    siteId = siteIdForOrigin(WORKSPACE, u.href);
    page ??= resolvePageNameOfUrl(u.href, join(WORKSPACE, siteId));
    if (!existsSync(join(WORKSPACE, siteId, 'pages', page, 'clone', 'index.html'))) {
      log(`本机还没有 ${siteId}/${page} 的镜像，先克隆（约 1–2 分钟）…`);
      const env = await invoke('clone', { url: u.href, waitMs: 60_000 }, { client: 'cli', onProgress: (p) => log(`… ${p.message ?? p.stage}`) });
      if (!env.ok) return env;
      let status = env.result?.status;
      while (env.jobId && !['succeeded', 'failed', 'cancelled'].includes(status)) {
        const w = await invoke('jobs', { action: 'wait', jobId: env.jobId, waitMs: 60_000 }, { client: 'cli' });
        if (!w.ok) return w;
        status = w.result.status;
        log(`… 克隆任务 ${status}`);
      }
      if (status !== 'succeeded') throw new CapabilityError('internal', `克隆没有成功（${status}）`, { hint: `heimdall jobs events ${env.jobId}` });
    }
  } else {
    siteId = target;
    const pages = listPages(siteId);
    page ??= pages.includes('home') ? 'home' : pages.find(p => existsSync(join(WORKSPACE, siteId, 'pages', p, 'clone', 'index.html')));
    if (!page) throw new CapabilityError('reference_missing', `${siteId} 下没有可用的镜像页面`);
  }
  const dir = resolve(String(flags.dir ?? `rebuild-${siteId}-${page}`.replace(/[^\w.-]+/g, '-')));
  const port = Number(flags.port ?? 5199);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new CapabilityError('invalid_args', '--port 取 1024–65535');
  const result = await initWorkspace({
    siteId, page, stack: flags.stack ?? 'html-css', fidelity: flags.fidelity ?? 'balanced', gateLevel: flags.gate ?? 'silver', dir, port,
    modelClass: flags['model-class'] ?? 'standard', git: !flags['no-git'], install: !flags['no-install'], registry: flags.registry,
    onProgress: (p) => log(`… ${p.message ?? p.stage}`),
  });
  const warnings = [];
  if (result.install && !result.install.ok) warnings.push({ code: 'install_failed', message: `依赖安装失败：${result.install.error}` });
  if (result.git && !result.git.ok) warnings.push({ code: 'git_unavailable', message: result.git.error });
  if (result.assets.fontsMissing) warnings.push({ code: 'fonts_missing', message: `${result.assets.fontsMissing} 个字体文件在镜像里找不到（外链或缺失），已跳过` });
  if (result.coverage?.needsReview) warnings.push({ code: 'sections_need_review', message: `分段覆盖 ${result.coverage.heightPct}%，低于 98%，分段计划需要复核` });
  return ok(result, {
    summary: `重建工作区已生成：${result.dir}\n${result.flowSections} 个分段，${result.assets.files} 个原件资产、${result.assets.fonts} 个字体文件。先读 AGENTS.md，再启动 dev server：${result.devServer.command}`,
    nextActions: [
      nextAction('cli:shell', { command: result.devServer.command, cwd: result.dir }, '启动 dev server（保持运行）'),
      ...(result.firstSection ? [nextAction('heimdall_brief', { project: result.dir, detail: 'full', sectionId: result.firstSection }, '取第一个分段的证据，开始写')] : []),
    ],
    warnings,
  });
}

function status(flags) {
  const dir = resolve(String(flags.project === true || !flags.project ? '.' : flags.project));
  const cfg = readProjectConfig(dir);
  const runsDir = join(dir, '.heimdall', 'runs');
  const runs = existsSync(runsDir) ? readdirSync(runsDir).filter(n => /^run_/.test(n)).sort() : [];
  const ledger = existsSync(join(dir, '.heimdall', 'ledger.jsonl'))
    ? readFileSync(join(dir, '.heimdall', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const sections = readJson(join(dir, '.heimdall', 'sections', `${cfg.pages[0].name}.json`))?.sections?.filter(s => !s.overlay) ?? [];
  const bySection = new Map();
  for (const e of ledger) {
    const key = e.sectionIds?.length === 1 ? e.sectionIds[0] : (e.sectionIds ? e.sectionIds.join('+') : 'page');
    const s = bySection.get(key) ?? { iterations: 0, last: null, best: null };
    s.iterations++;
    s.last = e;
    const minPx = Math.min(...Object.values(e.pixel ?? {}));
    if (!s.best || minPx > s.best.minPixel) s.best = { runId: e.runId, minPixel: minPx, verdict: e.verdict };
    bySection.set(key, s);
  }
  const rows = sections.map(s => {
    const st = bySection.get(s.id);
    return { sectionId: s.id, role: s.role, iterations: st?.iterations ?? 0, verdict: st?.last?.verdict ?? 'not-started', reached: st?.last?.reached ?? null,
      minPixel: st?.last ? Math.min(...Object.values(st.last.pixel ?? {})) : null };
  });
  const page = bySection.get('page');
  const done = rows.filter(r => r.verdict === 'pass-candidate').length;
  return ok({ dir, siteId: cfg.siteId, stack: cfg.stack, gate: cfg.gate, sections: rows, page: page ? { iterations: page.iterations, verdict: page.last.verdict, reached: page.last.reached } : null,
    compareRuns: runs.length, lastRunId: runs.at(-1) ?? null }, {
    summary: `${done}/${rows.length} 个分段到 pass-candidate；共对比 ${runs.length} 次${page ? `；整页最近一次 ${page.last.verdict}` : ''}。`,
    nextActions: rows.find(r => r.verdict !== 'pass-candidate')
      ? [nextAction('heimdall_brief', { project: dir, detail: 'full', sectionId: rows.find(r => r.verdict !== 'pass-candidate').sectionId }, '下一个要做的分段')]
      : [nextAction('heimdall_compare', { candidate: { dir } }, '所有分段都到了 pass-candidate：整页对比一次')],
  });
}

export async function run(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  const json = !!flags.json;
  const log = (s) => process.stderr.write(s + '\n');
  let env;
  try {
    if (sub === 'init') env = await init(flags, positional, log);
    else if (sub === 'status') env = status(flags);
    else env = fail('invalid_args', '用法：heimdall rebuild init <url|siteId> … | heimdall rebuild status [--project .]');
  } catch (error) { env = fromError(error); }
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
    for (const w of env.warnings ?? []) process.stdout.write(`! ${w.message}\n`);
    if (env.ok && sub === 'status') for (const r of env.result.sections) process.stdout.write(`  ${r.sectionId}  ${r.role.padEnd(8)} ${String(r.iterations).padStart(2)} 次  ${r.verdict}${r.minPixel !== null ? `  最低 ${(r.minPixel * 100).toFixed(1)}%` : ''}\n`);
  }
  return exitCodeOf(env);
}
