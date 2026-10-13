#!/usr/bin/env node
/**
 * audit/reclaim-orphans — 孤儿资产回收（安全模式）
 *
 * 安全设计：
 *  1) 保守判定：候选必须 ① 在 orphans.json 中，且 ② 其 basename 未出现在全站任何文本（含转义形式）。
 *  2) 隔离而非删除：文件移动到 audit/quarantine/<ts>/ 保留原目录结构。
 *  3) 自校验：回收前后各跑一次资产缺口扫描；若 visualGaps 增加 → 自动回滚全部移动并报错。
 *
 * 用法: node src/audit/reclaim-orphans.mjs <host> [--apply]
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, renameSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from '../paths.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SAFE = /^pages\/[^/]+\/clone\/(assets|styles)\//;
const TEXT_RE = /\.(html?|css|js|mjs|json|xml|svg)$/i;
const MAX_TEXT = 3 * 1024 * 1024;
const FILE_TOKEN = /[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,6}/g;

function walkFiles(root, cb) {
  if (!existsSync(root)) return;
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      cb(p, st);
    }
  };
  walk(root);
}

export function scanOrphans(host) {
  const r = spawnSync(process.execPath, [join(HERE, 'orphans.mjs'), host], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('orphans scan failed: ' + String(r.stderr || '').slice(0, 200));
  return JSON.parse(readFileSync(join(WORKSPACE, host, 'audit', 'orphans.json'), 'utf8'));
}

function assetGaps(host) {
  const r = spawnSync(process.execPath, [join(HERE, 'assets.mjs'), host], { encoding: 'utf8' });
  const line = String(r.stdout || '').split('\n').find(l => l.startsWith('@@EVENT@@') && l.includes('asset-gaps-done'));
  if (!line) return null;
  try { return JSON.parse(line.slice(9)).visualGaps; } catch { return null; }
}

/**
 * 该不该回滚？—— 纯函数，单独拎出来是为了能单测（这条判断本身出过一次事）。
 *
 * 原来的写法是 `baselineGaps != null && afterGaps != null && afterGaps > baselineGaps`，
 * 于是**"量不出来"和"量了没变差"落进同一个分支**：一个安全自检在它自己坏掉的时候
 * （assets 扫描崩了、事件行没了、stdout 被截断）恰好放行，还会把这次操作记成成功。
 *
 * 反过来才对：拿不到两次测量就回滚。quarantine 是可逆的（文件只是改名搬走），
 * 而**丢掉的资产不是**。
 *
 * @returns {{rollback: boolean, reason: 'unmeasured'|'gaps-worse'|null}}
 */
export function rollbackDecision(baselineGaps, afterGaps) {
  if (baselineGaps == null || afterGaps == null) return { rollback: true, reason: 'unmeasured' };
  if (afterGaps > baselineGaps) return { rollback: true, reason: 'gaps-worse' };
  return { rollback: false, reason: null };
}

function globalBasenames(host) {
  const seen = new Set();
  for (const root of [join(WORKSPACE, host, 'pages'), join(WORKSPACE, host, 'live')]) {
    walkFiles(root, (p, st) => {
      if (!TEXT_RE.test(p) || st.size > MAX_TEXT) return;
      try { for (const m of readFileSync(p, 'utf8').matchAll(FILE_TOKEN)) seen.add(m[0]); } catch {}
    });
  }
  return seen;
}

export function planReclaim(host) {
  const report = scanOrphans(host);
  const names = globalBasenames(host);
  const list = [];
  let bytes = 0;
  for (const p of report.orphanPaths ?? []) {
    const rel = p.startsWith(host + '/') ? p.slice(host.length + 1) : p;
    if (!SAFE.test(rel)) continue;
    const b = rel.split('/').pop();
    if (names.has(b)) continue;                                   // 保守：任何文本中出现过 basename → 不回收
    const abs = join(WORKSPACE, p);
    let st; try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    list.push({ path: p, size: st.size });
    bytes += st.size;
  }
  const byPage = {};
  for (const f of list) {
    const pg = f.path.split('/')[2] ?? '?';
    const b2 = byPage[pg] ?? (byPage[pg] = { count: 0, bytes: 0 });
    b2.count++; b2.bytes += f.size;
  }
  return { host, generatedAt: new Date().toISOString(), scanGeneratedAt: report.generatedAt, count: list.length, bytes, files: list, byPage };
}

export function purgeQuarantine(host) {
  const qroot = join(WORKSPACE, host, 'audit', 'quarantine');
  if (!existsSync(qroot)) return { host, purged: 0, bytes: 0 };
  let purged = 0, bytes = 0;
  for (const stamp of readdirSync(qroot)) {
    const dir = join(qroot, stamp);
    const walk = (d) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) walk(p); else { bytes += st.size; purged++; }
      }
    };
    try { walk(dir); rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return { host, purged, bytes };
}

export function applyReclaim(host) {
  const plan = planReclaim(host);
  const outDir = join(WORKSPACE, host, 'audit');
  mkdirSync(outDir, { recursive: true });
  const baselineGaps = assetGaps(host);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const qdir = join(outDir, 'quarantine', stamp);
  const moved = [];
  for (const f of plan.files) {
    const abs = join(WORKSPACE, f.path);
    const dst = join(qdir, f.path.replace(new RegExp('^' + host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), ''));
    try { mkdirSync(join(dst, '..'), { recursive: true }); renameSync(abs, dst); moved.push({ src: abs, dst, size: f.size }); } catch {}
  }
  const afterGaps = assetGaps(host);
  // 判断在 rollbackDecision 里（可单测）：**量不出来也要回滚**，见那里的注释
  const decision = rollbackDecision(baselineGaps, afterGaps);
  let rolledBack = false;
  if (decision.rollback) {
    for (const m of moved) { try { mkdirSync(join(m.src, '..'), { recursive: true }); renameSync(m.dst, m.src); } catch {} }
    rolledBack = true;
    if (decision.reason === 'unmeasured') console.warn('[reclaim] 资产缺口量不出来（assets 扫描没给出结果）→ 已回滚，不冒险');
  } else {
    const after = scanOrphans(host);
    plan.after = { orphans: after.orphans, orphanBytes: after.orphanBytes };
  }
  const result = { ...plan, baselineGaps, afterGaps, verified: !decision.rollback, rollbackReason: decision.reason, moved: moved.length, movedBytes: moved.reduce((n, m) => n + m.size, 0), quarantine: relative(WORKSPACE, qdir).split('\\').join('/'), rolledBack };
  writeFileSync(join(outDir, 'reclaim-plan.json'), JSON.stringify(result, null, 2));
  return result;
}

const isMain = process.argv[1] && process.argv[1].endsWith('reclaim-orphans.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const host = argv.find(a => !a.startsWith('--'));
  const apply = argv.includes('--apply');
  if (!host) { console.error('usage: node src/audit/reclaim-orphans.mjs <host> [--apply]'); process.exit(2); }
  if (argv.includes('--purge')) {
    const p = purgeQuarantine(host);
    console.log('[reclaim] PURGE host=' + host + ' files=' + p.purged + ' bytes=' + (p.bytes / 1048576).toFixed(1) + 'MB');
    process.stdout.write('@@RAWS@@' + JSON.stringify({ kind: 'reclaim-purge', host, purged: p.purged, bytes: p.bytes }) + '\n');
    process.exit(0);
  }
  const result = apply ? applyReclaim(host) : planReclaim(host);
  if (!apply) {
    const dir = join(WORKSPACE, host, 'audit');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'reclaim-plan.json'), JSON.stringify(result, null, 2));
  }
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  console.log('[reclaim] host=' + host + (apply ? ' APPLY' : ' dry-run') + ' candidates=' + result.count + ' bytes=' + mb(result.bytes)
    + (apply ? ' moved=' + result.moved + ' gaps ' + result.baselineGaps + '→' + result.afterGaps + (result.rolledBack ? ' ROLLED-BACK' : ' quarantine=' + result.quarantine) : ''));
  process.stdout.write('@@RAWS@@' + JSON.stringify({ kind: 'reclaim-done', host, apply, count: result.count, bytes: result.bytes, moved: result.moved ?? 0, movedBytes: result.movedBytes ?? 0, baselineGaps: result.baselineGaps ?? null, afterGaps: result.afterGaps ?? null, rolledBack: !!result.rolledBack, rollbackReason: result.rollbackReason ?? null, verified: result.verified !== false, quarantine: result.quarantine ?? null, after: result.after ?? null }) + '\n');
}
