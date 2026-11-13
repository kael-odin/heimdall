/**
 * heimdall probe —— 复现 PRD 01 §1.4 的数字（E14-06）
 *
 *   heimdall probe sizes   [--site S] [--max N]   产物体量：页面目录、镜像、交付包
 *   heimdall probe outline [--site S] [--max N]   大纲压缩：dom.html → 结构大纲
 *   heimdall probe har     [--site S] [--max N]   第一方端点：只报方法与路径模板的计数，不含查询串与正文
 *   heimdall probe contract [--site S] [--max N] [--include-readonly-data]  清洗 HAR → 观察型 B0/B1 接口契约
 *   heimdall probe adapter [--site S] [--max N] [--out D] --include-api-bodies [--include-readonly-data] [--force]
 *                                                    训练集生成适配器 + 留出集验证报告
 *
 * 全部读工作区，不需要引擎；outline 用与 heimdall_brief 完全相同的算法（buildOutline），
 * 所以探针数字与简报数字同源。adapter 仍只生成观察回放，不等价于真实后端。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKSPACE } from '../../paths.mjs';
import { writeAtomicFileSync } from '../../acceptance/atomic-file.mjs';
import { ok, fromError, exitCodeOf, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';
import { buildOutline } from '../brief/outline.mjs';
import { listSites } from '../workspace.mjs';
import { sanitizeHar } from '../../live/har.mjs';
import { buildObservedApiContract } from '../../live/contract.mjs';
import { buildObservedReplayAdapter, writeObservedReplayAdapter } from '../../live/adapter-generator.mjs';
import { splitObservedApiEntries, validateObservedReplayAdapter } from '../../live/adapter-validation.mjs';
import { readDataPlan } from '../../live/read-data-plan.mjs';
import { readSiteOrigin } from '../../site-origin.mjs';

const dirSize = (dir) => {
  let bytes = 0, files = 0;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = statSync(p); if (st.isDirectory()) walk(p); else { bytes += st.size; files++; } } };
  try { walk(dir); } catch {}
  return { bytes, files };
};
const mb = (b) => +(b / 1e6).toFixed(2);
const kb = (b) => +(b / 1e3).toFixed(1);

function pagesOf(sampleSites) {
  const out = [];
  for (const site of sampleSites) {
    const pages = join(WORKSPACE, site.siteId, 'pages');
    if (!existsSync(pages)) continue;
    for (const page of readdirSync(pages)) {
      const dir = join(pages, page);
      try { if (statSync(dir).isDirectory()) out.push({ siteId: site.siteId, page, dir }); } catch {}
    }
  }
  return out;
}

function sizes(sample) {
  const rows = sample.map(({ siteId, page, dir }) => {
    const clone = dirSize(join(dir, 'clone'));
    const deliver = existsSync(join(WORKSPACE, siteId, 'deliverable')) ? dirSize(join(WORKSPACE, siteId, 'deliverable')) : null;
    return { siteId, page, pageMB: mb(dirSize(dir).bytes), cloneMB: mb(clone.bytes), files: clone.files, deliverableMB: deliver ? mb(deliver.bytes) : null,
      hasHar: existsSync(join(dir, 'network.har')), domKB: existsSync(join(dir, 'dom.html')) ? kb(statSync(join(dir, 'dom.html')).size) : null };
  });
  return rows;
}

function outlines(sample) {
  const rows = [];
  for (const { siteId, page, dir } of sample) {
    const dom = join(dir, 'dom.html');
    if (!existsSync(dom)) continue;
    const html = readFileSync(dom, 'utf8');
    const o = buildOutline(html);
    rows.push({ siteId, page, rawKB: kb(Buffer.byteLength(html)), outlineKB: kb(o.bytes), tokens: Math.round(o.bytes / 3.5), ratio: +(Buffer.byteLength(html) / Math.max(1, o.bytes)).toFixed(0), nodes: o.nodes, hiddenSkipped: o.hiddenSkipped });
  }
  return rows;
}

/** 第一方端点：只统计 host + 方法 + 路径模板（去掉查询串与数字段），不含正文 */
function har(sample) {
  const rows = [];
  for (const { siteId, page, dir } of sample) {
    const f = join(dir, 'network.har');
    if (!existsSync(f)) continue;
    let har; try { har = JSON.parse(readFileSync(f, 'utf8')); } catch { continue; }
    const entries = har?.log?.entries ?? [];
    let origin = null;
    try { origin = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).target; } catch {}
    const host = origin ? new URL(origin).host : null;
    const counts = new Map();
    let total = 0, firstParty = 0, withBody = 0;
    for (const e of entries) {
      total++;
      let u; try { u = new URL(e.request?.url ?? ''); } catch { continue; }
      if (host && u.host !== host) continue;
      firstParty++;
      if ((e.response?.content?.text ?? '').length > 0) withBody++;
      const path = u.pathname.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f]{8,}(?=\/|$)/g, '/:hash');
      const key = `${e.request?.method ?? 'GET'} ${path}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    rows.push({ siteId, page, entries: total, firstParty, withBody,
      endpoints: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([key, n]) => ({ key, count: n })) });
  }
  return rows;
}

function readOnlyOptions(siteId, origin, enabled) {
  if (!enabled) return {};
  const base = join(WORKSPACE, siteId);
  if (readSiteOrigin(base) !== origin) throw new CapabilityError('origin_conflict', `只读接口许可的站点来源不一致或不唯一：${siteId}`);
  const plan = readDataPlan(base, origin);
  if (plan.status !== 'ok') throw new CapabilityError('invalid_args', `只读接口许可计划不可用：${siteId}（${plan.status}）`, {
    hint: '先在站点工作区配置有效的 read-data-plan.json，只列出已批准的同源公开 GET 路径与查询。',
  });
  return { readOnlyOrigin: origin, readOnlyGetUrls: plan.urls };
}

function contracts(sample, includeReadOnlyData) {
  const groups = new Map();
  for (const { siteId, page, dir } of sample) {
    const file = join(dir, 'network.har');
    if (!existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    let target;
    try { target = new URL(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).target); } catch { continue; }
    const key = `${siteId} ${target.origin}`;
    const group = groups.get(key) ?? { siteId, origin: target.origin, pages: 0, entries: [],
      readOnly: readOnlyOptions(siteId, target.origin, includeReadOnlyData) };
    const sanitized = sanitizeHar(raw, { includeApiBodies: true, contractOnly: true, ...group.readOnly });
    group.pages++;
    group.entries.push(...sanitized.entries);
    groups.set(key, group);
    void page;
  }
  return [...groups.values()].map(group => buildObservedApiContract(group.entries, group));
}

function persistContracts(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.siteId, (counts.get(row.siteId) ?? 0) + 1);
  const persisted = [];
  const ambiguous = [];
  for (const row of rows) {
    if (counts.get(row.siteId) !== 1) { ambiguous.push(row.siteId); continue; }
    const file = join(WORKSPACE, row.siteId, 'api-contract.json');
    writeAtomicFileSync(file, JSON.stringify(row, null, 2) + '\n');
    persisted.push(file);
  }
  return { persisted, ambiguous: [...new Set(ambiguous)] };
}

async function adapter(sample, siteId, { includeApiBodies, includeReadOnlyData, out, force }) {
  const pages = sample.filter(item => item.siteId === siteId);
  if (!pages.length) throw new CapabilityError('not_found', `没有站点页面 ${siteId}`, { hint: '`heimdall overview` 列出已有站点。' });
  if (!includeApiBodies) throw new CapabilityError('invalid_args', '生成观察回放适配器需要显式加 --include-api-bodies', { hint: '确认允许把已清洗的 API 响应用于本地回放，再重试。' });
  let origin = '';
  let readOnly = {};
  const entries = [];
  for (const { dir } of pages) {
    const file = join(dir, 'network.har');
    if (!existsSync(file)) continue;
    let raw;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
    let target;
    try { target = new URL(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).target); } catch { continue; }
    if (!origin) {
      origin = target.origin;
      readOnly = readOnlyOptions(siteId, origin, includeReadOnlyData);
    }
    if (target.origin !== origin) continue;
    entries.push(...sanitizeHar(raw, { includeApiBodies, ...readOnly }).entries);
  }
  const split = splitObservedApiEntries(entries, { origin });
  let generated;
  try { generated = buildObservedReplayAdapter(split.train, { siteId, origin, pages: pages.length }); }
  catch (error) { throw new CapabilityError('invalid_args', `无法生成观察回放适配器：${String(error?.message ?? error)}`, { hint: '若需使用已批准的只读查询，配置 read-data-plan.json 并加 --include-readonly-data；否则补充同源 API 录制，或减少响应体和路由数量后重试。' }); }
  if (out === true) throw new CapabilityError('invalid_args', '--out 需要目录路径', { hint: '例如 `--out .\\runtime-adapter-draft`。' });
  const base = process.env.HEIMDALL_INVOKE_CWD ?? process.cwd();
  const target = resolve(base, out || join(WORKSPACE, siteId, 'runtime-adapter'));
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new CapabilityError('invalid_args', `适配器输出目录不能是符号链接：${target}`, { hint: '换一个普通目录后重试。' });
  }
  if (existsSync(target) && !statSync(target).isDirectory()) {
    throw new CapabilityError('invalid_args', `适配器输出路径不是目录：${target}`, { hint: '换一个目录路径后重试。' });
  }
  const existing = existsSync(target) ? readdirSync(target) : [];
  if (existing.length && !force) {
    throw new CapabilityError('invalid_args', `已有适配器目录：${target}`, { hint: '确认要覆盖后加 --force，或用 --out 指向新目录。' });
  }
  if (existing.some(name => !['index.mjs', 'manifest.json'].includes(name))) {
    throw new CapabilityError('invalid_args', `适配器目录含有不受支持的文件：${target}`, { hint: '清理或换一个空目录；不会自动删除额外文件。' });
  }
  const report = await validateObservedReplayAdapter(generated, {
    trainingEntries: split.train,
    heldoutEntries: split.heldout,
  });
  const reportPath = join(resolve(target, '..'), 'adapter-report.json');
  if (existsSync(reportPath) && !force) {
    throw new CapabilityError('invalid_args', `已有适配器验证报告：${reportPath}`, { hint: '确认要覆盖后加 --force，或用 --out 指向新目录。' });
  }
  writeObservedReplayAdapter(target, generated);
  writeFileSync(reportPath, JSON.stringify({
    ...report,
    observed: { total: split.total, eligible: split.eligible, excluded: split.excluded, duplicateEntries: split.duplicateEntries },
    endpoints: split.endpoints,
  }, null, 2));
  return { ...generated.report, gapLedger: report.gapLedger, out: target, reportPath, origin, files: ['manifest.json', 'index.mjs'],
    observedEntries: split.total, trainEntries: split.train.length, heldoutEntries: split.heldout.length,
    validation: report.results, unknowns: [...new Set([...(report.unknowns ?? []), ...(report.gapLedger?.unknowns ?? [])])] };
}

const summarise = (label, rows) => `${label}：${rows.length} 页。`;

export async function run(argv) {
  const [what, ...rest] = argv;
  const { flags } = parseArgs(rest);
  const json = !!flags.json;
  let env;
  try {
    const sites = listSites().filter(s => !flags.site || s.siteId === flags.site);
    if (flags.site && !sites.length) throw new CapabilityError('not_found', `没有站点 ${flags.site}`);
    const max = Math.min(500, Number(flags.max) || 40);
    const sample = pagesOf(sites).slice(0, max);
    if (what === 'sizes') {
      const rows = sizes(sample);
      const clone = rows.reduce((s, r) => s + r.cloneMB, 0);
      env = ok({ rows }, { summary: `${summarise('产物', rows)} 镜像合计 ${clone.toFixed(1)} MB，中位 ${(rows.map(r => r.cloneMB).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0).toFixed(1)} MB。` });
    } else if (what === 'outline') {
      const rows = outlines(sample);
      const ratios = rows.map(r => r.ratio).sort((a, b) => a - b);
      const tokens = rows.map(r => r.tokens).sort((a, b) => a - b);
      const p = (q) => tokens[Math.min(tokens.length - 1, Math.floor(tokens.length * q))] ?? 0;
      env = ok({ rows }, { summary: `${summarise('大纲', rows)} 压缩 ${ratios[0] ?? 0}–${ratios[ratios.length - 1] ?? 0} 倍；token 中位 ${p(0.5)}，p90 ${p(0.9)}。` });
    } else if (what === 'har') {
      const rows = har(sample);
      env = ok({ rows }, { summary: `${summarise('接口', rows)} 第一方请求合计 ${rows.reduce((s, r) => s + r.firstParty, 0)} 条；只统计方法与路径模板，不含查询串与正文。` });
    } else if (what === 'contract') {
      const rows = contracts(sample, !!flags['include-readonly-data']);
      const endpoints = rows.reduce((sum, row) => sum + row.summary.endpoints, 0);
      const b1 = rows.filter(row => row.tier === 'B1').length;
      const saved = persistContracts(rows);
      env = ok({ rows, persisted: saved.persisted, ambiguous: saved.ambiguous }, {
        summary: `${summarise('契约', rows)} ${b1} 个站点达到 B1，观察到 ${endpoints} 个接口；输出只含接口形状和未知项，不含请求值与响应示例。${saved.persisted.length ? ` 已写入 ${saved.persisted.length} 个工作区契约。` : ''}`,
        ...(saved.ambiguous.length ? { warnings: [{ code: 'contract_origin_ambiguous', message: `以下站点有多个来源，未自动覆盖根契约：${saved.ambiguous.join('、')}` }] } : {}),
        evidence: saved.persisted.map(path => ({ kind: 'file', path })),
      });
    } else if (what === 'adapter') {
      if (!flags.site) throw new CapabilityError('invalid_args', 'probe adapter 必须指定 --site S', { hint: '`heimdall overview` 列出已有站点。' });
      const result = await adapter(sample, flags.site, { includeApiBodies: !!flags['include-api-bodies'], includeReadOnlyData: !!flags['include-readonly-data'], out: flags.out, force: !!flags.force });
      env = ok(result, { summary: `已生成观察回放适配器：${result.routes} 条路由、${result.entries} 个响应；留出验证 ${result.validation.status}，这不是与源站等价的后端。` });
    } else {
      throw new CapabilityError('invalid_args', '用法：heimdall probe sizes|outline|har|contract|adapter [--site S] [--max N] [--include-readonly-data]');
    }
  } catch (error) { env = fromError(error); }
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (env.ok && what === 'sizes') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId + '/' + r.page).padEnd(44)} 镜像 ${String(r.cloneMB).padStart(7)} MB  ${String(r.files).padStart(3)} 个文件  dom ${r.domKB} KB\n`);
    if (env.ok && what === 'outline') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId + '/' + r.page).padEnd(44)} 原始 ${String(r.rawKB).padStart(7)} KB → 大纲 ${String(r.outlineKB).padStart(6)} KB（${r.ratio}×）  ~${r.tokens} tok\n`);
    if (env.ok && what === 'har') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId + '/' + r.page).padEnd(44)} 第一方 ${String(r.firstParty).padStart(3)}/${r.entries} 条，${r.endpoints.length} 个端点\n`);
    if (env.ok && what === 'contract') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId || '-').padEnd(36)} ${r.tier} 端点 ${String(r.summary.endpoints).padStart(3)}  schema ${String(r.summary.withResponseSchema).padStart(3)}  未知 ${String(r.summary.unknowns).padStart(3)}\n`);
    if (env.ok && what === 'adapter') process.stdout.write(`  输出 ${env.result.out}\n  报告 ${env.result.reportPath}\n  训练 ${env.result.trainEntries}  留出 ${env.result.heldoutEntries}  留出状态 ${env.result.validation.status}\n  路由 ${env.result.routes}  响应 ${env.result.entries}  脱敏响应 ${env.result.redactedBodies}  未知 ${env.result.unknowns.join('、')}\n`);
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
  }
  return exitCodeOf(env);
}
