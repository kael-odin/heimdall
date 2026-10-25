/**
 * heimdall probe —— 复现 PRD 01 §1.4 的数字（E14-06）
 *
 *   heimdall probe sizes   [--site S] [--max N]   产物体量：页面目录、镜像、交付包
 *   heimdall probe outline [--site S] [--max N]   大纲压缩：dom.html → 结构大纲
 *   heimdall probe har     [--site S] [--max N]   第一方端点：只报方法与路径模板的计数，不含查询串与正文
 *
 * 全部读工作区，不需要引擎；outline 用与 heimdall_brief 完全相同的算法（buildOutline），
 * 所以探针数字与简报数字同源。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../../paths.mjs';
import { ok, fromError, exitCodeOf, CapabilityError } from '../envelope.mjs';
import { parseArgs } from '../cli.mjs';
import { buildOutline } from '../brief/outline.mjs';
import { listSites } from '../workspace.mjs';

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
    } else {
      throw new CapabilityError('invalid_args', '用法：heimdall probe sizes|outline|har [--site S] [--max N]');
    }
  } catch (error) { env = fromError(error); }
  if (json) process.stdout.write(JSON.stringify(env) + '\n');
  else {
    process.stdout.write(env.summary + '\n');
    if (env.ok && what === 'sizes') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId + '/' + r.page).padEnd(44)} 镜像 ${String(r.cloneMB).padStart(7)} MB  ${String(r.files).padStart(3)} 个文件  dom ${r.domKB} KB\n`);
    if (env.ok && what === 'outline') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId + '/' + r.page).padEnd(44)} 原始 ${String(r.rawKB).padStart(7)} KB → 大纲 ${String(r.outlineKB).padStart(6)} KB（${r.ratio}×）  ~${r.tokens} tok\n`);
    if (env.ok && what === 'har') for (const r of env.result.rows) process.stdout.write(`  ${(r.siteId + '/' + r.page).padEnd(44)} 第一方 ${String(r.firstParty).padStart(3)}/${r.entries} 条，${r.endpoints.length} 个端点\n`);
    if (!env.ok) process.stdout.write(`[${env.error.code}] ${env.error.message}\n下一步：${env.error.hint}\n`);
  }
  return exitCodeOf(env);
}
