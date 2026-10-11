#!/usr/bin/env node
/**
 * seo/matrix — 竞品 SEO 对标矩阵（多站点聚合对比）
 *
 * 用法:
 *   node src/seo/matrix.mjs apify.com thordata.com [--max 15] [--refresh]
 *
 * 数据源：workspace/<host>/seo/seo.json（缺失或 --refresh 时先跑 seo/audit.mjs）
 * 产物：workspace/_matrix/<slug>/{matrix.json,matrix.csv,matrix.html}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, localDateStamp } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { buildMatrix, renderMatrixHtml, renderMatrixCsv } from './matrix-core.mjs';
import { makeArgs } from '../args.mjs';

const log = (...a) => console.error('[matrix]', ...a);
const CORE = fileURLToPath(new URL('../..', import.meta.url));

const argv = process.argv.slice(2);
const { has, num } = makeArgs(argv);
const sites = argv.filter(a => !a.startsWith('--') && !/^\d+$/.test(a)).flatMap(s => s.split(',')).map(s => s.trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')).filter(Boolean);
if (sites.length < 2) { console.error('usage: node src/seo/matrix.mjs <site1> <site2> [site3 ...] [--max 15] [--refresh]'); process.exit(2); }
const MAX = Math.max(1, Math.min(num('max', 15), 100));
const REFRESH = has('refresh');

const runAudit = (host) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(CORE, 'src', 'seo', 'audit.mjs'), host, '--max', String(MAX)], { cwd: CORE, stdio: 'inherit' });
  p.on('exit', (code) => resolve(code === 0));
  p.on('error', () => resolve(false));
});

const audits = [];
emit({ kind: 'matrix-start', sites, total: sites.length });
for (let i = 0; i < sites.length; i++) {
  const host = sites[i];
  emit({ kind: 'matrix-site', host, index: i + 1, total: sites.length, phase: 'start' });
  const seoPath = join(WORKSPACE, host, 'seo', 'seo.json');
  if (REFRESH || !existsSync(seoPath)) {
    log(`auditing ${host} (max ${MAX})...`);
    const ok = await runAudit(host);
    if (!ok || !existsSync(seoPath)) { log(`skip ${host}: audit failed`); emit({ kind: 'matrix-site', host, index: i + 1, total: sites.length, phase: 'failed' }); continue; }
  }
  try { audits.push(JSON.parse(readFileSync(seoPath, 'utf8'))); log(`loaded ${host}: ${JSON.parse(readFileSync(seoPath, 'utf8')).pages.length} pages`); emit({ kind: 'matrix-site', host, index: i + 1, total: sites.length, phase: 'done' }); }
  catch (e) { log(`skip ${host}: ${String(e).slice(0, 80)}`); emit({ kind: 'matrix-site', host, index: i + 1, total: sites.length, phase: 'failed' }); }
}
if (audits.length < 2) { console.error('need at least 2 audits, got', audits.length); process.exit(1); }

const matrix = buildMatrix(audits);
const slug = sites.join('_vs_').replace(/[^a-z0-9_.-]+/gi, '-') + '-' + localDateStamp();
const outDir = join(WORKSPACE, '_matrix', slug);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(matrix, null, 2));
writeFileSync(join(outDir, 'matrix.csv'), renderMatrixCsv(matrix));
writeFileSync(join(outDir, 'matrix.html'), renderMatrixHtml(matrix));
log(`matrix -> ${join(outDir, 'matrix.html')}`);
emit({ kind: 'matrix-done', sites: audits.map(a => a.host), path: join(outDir, 'matrix.html') });
