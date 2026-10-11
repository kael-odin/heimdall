#!/usr/bin/env node
/**
 * audit/deliver-prune — 交付包保留策略
 *
 * 背景：每次 deliver / live 导出都会在 deliverable/ 下留一个新目录，
 * 实测本地已经积到 8 个包 / 约 1.7GB，且没有任何清理机制 ——
 * 磁盘会一直涨，而且没人知道哪些还能删。
 *
 * 设计上的三个判断：
 *
 *  1. **分组按 (host, 类型)，不是全局按时间。** 全局保留最近 N 个的话，
 *     导出一个新站点就会把另一个站点仅有的包挤掉。
 *
 *  2. **认不出命名规则的包一律不动。** `apify-live-healed`、`heal-live-test`
 *     这种可能是手工产物或调试样本，静默删掉是灾难。它们只列进"无法归类"。
 *
 *  3. **报告的是"实际释放"，不是"目录大小"。** 交付包里的文件与 workspace
 *     克隆共享 inode（去重），删掉一个链接并不释放空间。
 *     所以按 nlink 算：只有 nlink===1 的那部分才是真能省出来的。
 *
 * 默认 dry-run，--apply 才删。
 *
 * 用法:
 *   node src/audit/deliver-prune.mjs [--keep 2] [--apply] [--json]
 */
import { readdirSync, statSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERABLE, DATA_ROOT } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { makeArgs } from '../args.mjs';

/** 上次运行的结果落盘，供控制台读取（与 storage.json 同样的模式：
 *  遍历/删除都在子进程里做，主进程只读结果，避免冻住事件循环） */
export const PLAN_FILE = join(DATA_ROOT, 'deliver-plan.json');

const log = (...a) => console.error('[deliver-prune]', ...a);

const argv = process.argv.slice(2);
const { has, num } = makeArgs(argv);
const APPLY = has('apply');
const JSON_OUT = has('json');
const KEEP = Math.max(0, num('keep', 2));

/** 目录名 → { host, kind, dated, date }。认不出返回 null。 */
export function parseBundleName(name) {
  // 只认 <host>[-live]-<YYYY-MM-DD>，且日期必须是**真日期**。
  // 「形状像但不是真日期」（a-2026-13-99）说明它不是本工具生成的目录，
  // 那就不是我们该清理的东西。拒绝的方向是安全的：最坏情况只是留着不删。
  const isRealDate = (s) => {
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  };
  let m = /^(.+)-live-(\d{4}-\d{2}-\d{2})$/.exec(name);
  if (m && isRealDate(m[2])) return { host: m[1], kind: 'live', dated: true, date: m[2] };
  m = /^(.+)-(\d{4}-\d{2}-\d{2})$/.exec(name);
  if (m && isRealDate(m[2])) return { host: m[1], kind: 'static', dated: true, date: m[2] };
  return null;
}

/** 递归统计一个目录：文件数、逻辑字节、以及"独占"字节（nlink===1，删了才真省） */
export function measureDir(dir) {
  let files = 0, bytes = 0, exclusive = 0;
  const seen = new Set();
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const n of entries) {
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { walk(p); continue; }
      files++;
      bytes += st.size;
      // 同一个 inode 只算一次（硬链接在包内重复出现时别重复计）
      const key = st.dev + ':' + st.ino;
      if (seen.has(key)) continue;
      seen.add(key);
      if (st.nlink === 1) exclusive += st.size;
    }
  };
  walk(dir);
  return { files, bytes, exclusive };
}

/** 扫描 deliverable/ 下的全部包 */
export function scanBundles(root = DELIVERABLE) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    let st;
    try { st = statSync(dir); } catch { continue; }
    if (!st.isDirectory()) continue;
    const parsed = parseBundleName(name);
    const m = measureDir(dir);
    out.push({
      name, dir,
      host: parsed?.host ?? null,
      kind: parsed?.kind ?? null,
      dated: !!parsed?.dated,
      date: parsed?.date ?? null,
      mtime: st.mtimeMs,
      ...m,
    });
  }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.mtime - a.mtime);
}

/**
 * 制定保留计划。纯函数，便于测试。
 * @returns {{ groups, keep, remove, unclassified, total, reclaimable }}
 */
export function planPrune(bundles, { keep = 2 } = {}) {
  const groups = new Map();
  const unclassified = [];
  for (const b of bundles) {
    if (!b.dated) { unclassified.push(b); continue; }   // 认不出 → 绝不动
    const key = b.host + '/' + b.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }

  const keepList = [];
  const removeList = [];
  const groupInfo = [];
  // 排序主键是**名字里的日期**，不是目录 mtime。
  // 目录 mtime 会因为内部文件增删而变化（不只是创建时刻），
  // 拿它判"哪个更新"会把改动过的旧包当成新的。日期是构建时的权威事实。
  const newestFirst = (a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.mtime - a.mtime;
  for (const [key, list] of groups) {
    const sorted = [...list].sort(newestFirst);
    const kept = sorted.slice(0, keep);
    const dropped = sorted.slice(keep);
    keepList.push(...kept);
    removeList.push(...dropped);
    groupInfo.push({
      key, count: list.length, keep: kept.map(b => b.name), remove: dropped.map(b => b.name),
      bytes: list.reduce((n, b) => n + b.bytes, 0),
      reclaimable: dropped.reduce((n, b) => n + b.exclusive, 0),
    });
  }

  return {
    groups: groupInfo,
    keep: keepList,
    remove: removeList,
    unclassified,
    total: {
      bundles: bundles.length,
      bytes: bundles.reduce((n, b) => n + b.bytes, 0),
      reclaimable: removeList.reduce((n, b) => n + b.exclusive, 0),
    },
  };
}

/** 执行删除。返回实际结果 —— 失败要如实上报，不能吞。 */
export function applyPrune(plan) {
  const removed = [];
  const failed = [];
  for (const b of plan.remove) {
    try { rmSync(b.dir, { recursive: true, force: true }); removed.push({ name: b.name, exclusive: b.exclusive }); }
    catch (e) { failed.push({ name: b.name, error: String(e).slice(0, 120) }); }
  }
  return { removed, failed, freed: removed.reduce((n, r) => n + r.exclusive, 0) };
}

const fmt = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + 'GB'
  : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + 'KB' : n + 'B');

export function renderText(plan, { apply = false } = {}) {
  const L = [];
  L.push(`交付包：${plan.total.bundles} 个 / ${fmt(plan.total.bytes)}（逻辑）`);
  L.push(`保留策略：每 (站点, 类型) 保留最近 ${KEEP} 个`);
  L.push('');
  for (const g of plan.groups) {
    L.push(`${g.key}  ${g.count} 个`);
    for (const n of g.keep) L.push(`  保留  ${n}`);
    for (const n of g.remove) L.push(`  删除  ${n}`);
  }
  if (plan.unclassified.length) {
    L.push('');
    L.push(`无法归类（命名不含日期，**不会**自动删除 —— 可能是手工产物）：`);
    for (const b of plan.unclassified) L.push(`  ${b.name}  ${fmt(b.bytes)}`);
  }
  L.push('');
  L.push(`可回收 ${plan.remove.length} 个包，实际可释放 ${fmt(plan.total.reclaimable)}`);
  L.push('（"实际"按 nlink 计算：交付包里的文件与 workspace 克隆共享 inode，'
    + '删掉一个链接并不释放空间，只有 nlink=1 的部分才真的省）');
  if (!apply && plan.remove.length) L.push('\n这是预览。加 --apply 才会真的删除。');
  return L.join('\n') + '\n';
}

// ---------- CLI ----------
// 仅在直接执行时跑；被 import（单测）时只暴露纯函数
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const bundles = scanBundles();
    if (!bundles.length) { log('deliverable/ 为空或不存在'); if (JSON_OUT) console.log(JSON.stringify({ bundles: 0 })); else log('无事可做'); process.exit(0); }
    const plan = planPrune(bundles, { keep: KEEP });

    let result = null;
    if (APPLY && plan.remove.length) result = applyPrune(plan);

    if (JSON_OUT) {
      console.log(JSON.stringify({ keep: KEEP, apply: APPLY, ...plan, result }, null, 2));
    } else {
      process.stderr.write(renderText(plan, { apply: APPLY }));
      if (result) {
        log(`已删除 ${result.removed.length} 个包，释放 ${fmt(result.freed)}`);
        for (const f of result.failed) log(`失败：${f.name} — ${f.error}`);
      }
    }
    // 结果落盘供控制台读（不含 dir 之类的内部字段之外其实都可给，但保持紧凑）
    try {
      writeFileSync(PLAN_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        keep: KEEP, applied: APPLY,
        groups: plan.groups,
        unclassified: plan.unclassified.map(b => ({ name: b.name, bytes: b.bytes })),
        total: plan.total,
        result,
      }, null, 2));
    } catch { /* 落盘失败不影响主流程 */ }
    emit({
      kind: 'deliver-prune',
      apply: APPLY, keep: KEEP,
      removed: result ? result.removed.length : 0,
      planned: plan.remove.length,
      freed: result ? result.freed : 0,
      reclaimable: plan.total.reclaimable,
      failed: result ? result.failed.length : 0,
    });
    process.exit(result?.failed?.length ? 1 : 0);
  } catch (e) {
    log('FATAL', String(e?.stack ?? e).slice(0, 500));
    emit({ kind: 'deliver-prune-error', error: String(e).slice(0, 300) });
    process.exit(1);
  }
}
