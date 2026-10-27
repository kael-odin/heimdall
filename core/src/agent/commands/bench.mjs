/**
 * heimdall bench —— Heimdall-Bench 驱动（E14-01 ~ E14-03，PRD 09 §1–§2）
 *
 *   heimdall bench score --site <siteId> --page <page> --candidate 标签=目录 [--candidate …] [--level gold] [--json]
 *   heimdall bench run   --site <siteId> --page <page> --project <dir> [--arm a1|a2|a3] [--iterations 2] [--model M] [--json]
 *
 * score：只测量已有候选（不调模型），适合把「人写的 / 脚手架 / 镜像自身」放在一张表里。
 * run：用模型跑一个消融臂（A1 只给简报，A2 加标量反馈，A3 加完整修复包），每轮都对比并记分。
 * 结果写 workspace/<siteId>/agent/bench/<时间>.json，同时打印一张 Markdown 表。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ok, fail, fromError, exitCodeOf, nextAction, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';
import { agentDir } from '../workspace.mjs';
import { runArm, runSectionLoop } from '../bench/agent.mjs';
import { scoreCandidate, benchReport, benchTable, summarizeRuns, summaryTable } from '../bench/score.mjs';

const pairs = (list) => String(list ?? '').split(',').map(s => s.trim()).filter(Boolean).map((s) => {
  const i = String(s).indexOf('=');
  return i > 0 ? { label: String(s).slice(0, i), dir: resolve(String(s).slice(i + 1)) } : { label: String(s), dir: resolve(String(s)) };
});

export async function run(argv) {
  const { flags, positional } = parseArgs(argv);
  const json = !!flags.json;
  const sub = positional[0];
  const siteId = flags.site, page = flags.page;
  let env;
  try {
    if (!siteId || !page) throw new CapabilityError('invalid_args', '需要 --site 与 --page', { hint: '例：heimdall bench score --site S --page home --candidate 脚手架=工作区目录' });
    const level = String(flags.level ?? 'silver');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const outDir = join(agentDir(siteId), 'bench');
    mkdirSync(outDir, { recursive: true });

    if (sub === 'score') {
      const candidates = pairs(flags.candidate);
      if (!candidates.length) throw new CapabilityError('invalid_args', '至少给一个 --candidate 标签=目录');
      const rows = [];
      for (const c of candidates) {
        process.stderr.write(`… 测量 ${c.label}\n`);
        rows.push(await scoreCandidate({ siteId, page, candidateDir: c.dir, level, label: c.label }));
      }
      const report = benchReport({ fixture: { siteId, page }, level, rows });
      const file = join(outDir, `score-${stamp}.json`);
      writeFileSync(file, JSON.stringify(report, null, 1) + '\n');
      env = ok({ ...report, reportPath: file }, { summary: benchTable(report) + `\n报告：${file}`, nextActions: [] });
    } else if (sub === 'run') {
      const projectDir = resolve(String(flags.project ?? '.'));
      const arm = String(flags.arm ?? 'a3');
      const feedbackMode = String(flags.feedback ?? 'full');
      const editMode = String(flags.edit ?? 'rewrite');
      const iterations = Math.max(1, Math.min(8, Number(flags.iterations ?? 2)));
      const res = await runArm({ projectDir, siteId, page, arm, iterations, model: flags.model ?? null, feedbackMode, editMode, revert: flags['no-revert'] !== true,
        ...(flags['max-tokens'] ? { maxTokens: Math.max(1000, Number(flags['max-tokens'])) } : {}),
        onProgress: (p) => process.stderr.write(`… ${p.message}\n`) });
      const last = res.rows.at(-1);
      const row = { label: `${arm}${arm === 'a3' && feedbackMode === 'targeted' ? '-targeted' : ''}${editMode === 'surgical' ? '-surgical' : ''}${flags.model ? ` · ${flags.model}` : ''}`, dir: projectDir, runId: last?.runId ?? null,
        pixel: last?.pixel ?? {}, minPixel: last?.pixel ? Math.min(...Object.values(last.pixel)) : null,
        gate: { status: last?.verdict === 'pass-candidate' ? 'passed' : 'failed', reached: last?.reached ?? null, failed: [], notMeasured: [] },
        antitheft: last?.anticheat ?? null, iterations: res.iterations, compareMs: res.rows.reduce((s, r) => s + r.ms, 0) };
      const report = benchReport({ fixture: { siteId, page }, level: res.level, rows: [row], model: res.model,
        note: `臂 ${arm}${feedbackMode === 'targeted' ? '（定向反馈）' : ''}${editMode === 'surgical' ? '（外科式改动）' : ''}${flags['no-revert'] === true ? '（不回退）' : ''}，${res.iterations} 轮；token 输入 ${res.usage.prompt} / 输出 ${res.usage.completion}。分数是快速裁判口径。` });
      report.attempts = res.rows;
      const file = join(outDir, `run-${arm}-${stamp}.json`);
      writeFileSync(file, JSON.stringify(report, null, 1) + '\n');
      env = ok({ ...report, reportPath: file, usage: res.usage }, { summary: benchTable(report) + `\n报告：${file}`,
        nextActions: [nextAction('cli:shell', { command: `heimdall rebuild deliver --project "${projectDir}"` }, '按 Floor=Mirror 交付这次重建')] });
    } else if (sub === 'summary') {
      // 把 agent/bench 下所有模型臂报告按臂汇总：中位数与极值（PRD 09 §1.5）
      const dir = join(agentDir(siteId), 'bench');
      const runs = existsSync(dir) ? readdirSync(dir).filter(n => /^run-.*\.json$/.test(n)).map((n) => {
        try { return JSON.parse(readFileSync(join(dir, n), 'utf8')); } catch { return null; }
      }).filter(Boolean).flatMap(r => (r.rows ?? []).map(row => ({ label: row.label, pixel: row.pixel }))) : [];
      if (!runs.length) throw new CapabilityError('not_found', '还没有模型臂的报告', { hint: '先跑 heimdall bench run --arm a3 …' });
      const summary = summarizeRuns(runs);
      const file = join(dir, `summary-${stamp}.json`);
      writeFileSync(file, JSON.stringify({ schema: 'heimdall.bench.summary/1', generatedAt: new Date().toISOString(), siteId, page, summary }, null, 1) + '\n');
      env = ok({ siteId, page, summary, reportPath: file }, { summary: summaryTable(summary) + `\n报告：${file}`, nextActions: [] });
    } else if (sub === 'sections') {
      const projectDir = resolve(String(flags.project ?? '.'));
      const maxPerSection = Math.max(1, Math.min(6, Number(flags.iterations ?? 2)));
      const res = await runSectionLoop({ projectDir, siteId, page, maxPerSection, model: flags.model ?? null,
        ...(flags['max-tokens'] ? { maxTokens: Math.max(1000, Number(flags['max-tokens'])) } : {}),
        revert: flags['no-revert'] !== true,
        onProgress: (p) => process.stderr.write(`… ${p.message}\n`) });
      const file = join(outDir, `sections-${stamp}.json`);
      writeFileSync(file, JSON.stringify({ schema: 'heimdall.bench.sections/1', generatedAt: new Date().toISOString(), siteId, page, ...res }, null, 1) + '\n');
      const lines = [`分段循环：${res.sectionsDone}/${res.sectionsTotal} 段到 pass-candidate；整页 ${Object.entries(res.final).map(([w, v]) => `${w}:${(v * 100).toFixed(2)}%`).join(' ')}（${res.finalVerdict}）`];
      for (const r of res.rows) {
        lines.push(`  ${r.sectionId.padEnd(24)} ${r.skipped ? `跳过（${r.skipped}）` : `第 ${r.iteration} 轮 ${(r.score * 100).toFixed(2)}%（保留 ${(r.kept * 100).toFixed(2)}%）${r.reverted ? ' 回退' : ''} · ${r.verdict}`}`);
      }
      env = ok({ ...res, reportPath: file }, { summary: lines.join('\n'), nextActions: [nextAction('cli:shell', { command: `heimdall rebuild deliver --project "${projectDir}"` }, '按 Floor=Mirror 交付这次重建')] });
    } else {
      env = fail('invalid_args', '用法：heimdall bench score|run …', { hint: 'score：测量已有候选；run：用模型跑一个消融臂' });
    }
  } catch (error) {
    env = fromError(error);
  }
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
  }
  return exitCodeOf(env);
}
