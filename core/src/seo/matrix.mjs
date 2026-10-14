#!/usr/bin/env node
/**
 * seo/matrix — 竞品 SEO 对标矩阵（多站点聚合对比）
 *
 * 用法:
 *   node src/seo/matrix.mjs apify.com thordata.com [--max 15] [--refresh]
 *
 * 数据源：workspace/<siteId>/seo/seo.json（缺失或 --refresh 时先跑 seo/audit.mjs）
 * 产物：workspace/_matrix/<slug>/{matrix.json,matrix.csv,matrix.html}
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, localDateStamp } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { buildMatrix, renderMatrixHtml, renderMatrixCsv } from './matrix-core.mjs';
import { resolveMatrixTarget } from './matrix-target.mjs';
import { siteIdForOrigin } from '../site-origin.mjs';

const log = (...a) => console.error('[matrix]', ...a);
const CORE = fileURLToPath(new URL('../..', import.meta.url));

const argv = process.argv.slice(2);
const usage = 'usage: node src/seo/matrix.mjs <siteId|url> <siteId|url> [site3 ...] [--max 15] [--refresh]';
const inputs = [];
let max = 15;
let refresh = false;
try {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh') { refresh = true; continue; }
    if (arg === '--max' || arg.startsWith('--max=')) {
      const value = arg === '--max' ? argv[++i] : arg.slice('--max='.length);
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1) throw new Error('--max must be a positive integer');
      max = Math.min(Number(value), 100);
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    inputs.push(...arg.split(',').map(value => value.trim()).filter(Boolean));
  }
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2); }
let targets;
try {
  targets = [...new Map(inputs.map(input => {
    const target = resolveMatrixTarget(input);
    return [target.origin, target];
  })).values()];
} catch (error) { console.error(`${error.message}\n${usage}`); process.exit(2); }
if (targets.length < 2) { console.error(usage); process.exit(2); }
const MAX = max;
const REFRESH = refresh;
const sites = targets.map(target => target.origin);

const runAudit = (origin) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(CORE, 'src', 'seo', 'audit.mjs'), origin, '--max', String(MAX)], { cwd: CORE, stdio: 'inherit' });
  p.on('exit', (code) => resolve(code === 0));
  p.on('error', () => resolve(false));
});

const audits = [];
emit({ kind: 'matrix-start', sites, total: sites.length });
for (let i = 0; i < sites.length; i++) {
  const origin = sites[i];
  emit({ kind: 'matrix-site', host: origin, index: i + 1, total: sites.length, phase: 'start' });
  let seoPath = join(WORKSPACE, siteIdForOrigin(WORKSPACE, origin), 'seo', 'seo.json');
  let report = null;
  if (!REFRESH && existsSync(seoPath)) {
    try {
      const cached = JSON.parse(readFileSync(seoPath, 'utf8'));
      if (cached.origin === origin && Array.isArray(cached.pages)) report = cached;
      else log(`stale SEO cache for ${origin}: ${cached.origin ?? 'no origin'}`);
    } catch (error) { log(`unreadable SEO cache for ${origin}: ${error.message}`); }
  }
  if (!report) {
    log(`auditing ${origin} (max ${MAX})...`);
    const ok = await runAudit(origin);
    seoPath = join(WORKSPACE, siteIdForOrigin(WORKSPACE, origin), 'seo', 'seo.json');
    if (!ok || !existsSync(seoPath)) {
      log(`skip ${origin}: audit failed`);
      emit({ kind: 'matrix-site', host: origin, index: i + 1, total: sites.length, phase: 'failed' });
      continue;
    }
    try { report = JSON.parse(readFileSync(seoPath, 'utf8')); }
    catch (error) { log(`skip ${origin}: ${error.message}`); }
  }
  if (report?.origin !== origin || !Array.isArray(report.pages)) {
    log(`skip ${origin}: SEO report origin mismatch`);
    emit({ kind: 'matrix-site', host: origin, index: i + 1, total: sites.length, phase: 'failed' });
    continue;
  }
  audits.push(report);
  log(`loaded ${origin}: ${report.pages.length} pages`);
  emit({ kind: 'matrix-site', host: origin, index: i + 1, total: sites.length, phase: 'done' });
}
if (audits.length < 2) { console.error('need at least 2 audits, got', audits.length); process.exit(1); }

const matrix = buildMatrix(audits);
const siteKey = sites.map(origin => siteIdForOrigin(WORKSPACE, origin)).join('_vs_');
const slug = (siteKey.length > 120
  ? `${siteKey.slice(0, 100)}--${createHash('sha256').update(sites.join('\n')).digest('hex').slice(0, 16)}`
  : siteKey) + '-' + localDateStamp();
const outDir = join(WORKSPACE, '_matrix', slug);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(matrix, null, 2));
writeFileSync(join(outDir, 'matrix.csv'), renderMatrixCsv(matrix));
writeFileSync(join(outDir, 'matrix.html'), renderMatrixHtml(matrix));
log(`matrix -> ${join(outDir, 'matrix.html')}`);
emit({ kind: 'matrix-done', sites: audits.map(a => a.origin), path: join(outDir, 'matrix.html') });
