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
 *  3. **隔离不释放空间。** 交付包里的文件与 workspace 克隆可能共享 inode；
 *     nlink===1 的字节仅表示将来永久清理时的潜在收益。
 *
 * 默认 dry-run，--apply 把旧包移入同卷隔离区。
 *
 * 用法:
 *   node src/audit/deliver-prune.mjs [--keep 2] [--json]
 *   node src/audit/deliver-prune.mjs [--keep 2] --apply --revision <预览 revision>
 */
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERABLE, DATA_ROOT } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { makeArgs } from '../args.mjs';
import { writeFileAtomic } from '../fsutil.mjs';

/** 上次运行的结果落盘，供控制台读取（与 storage.json 同样的模式：
 *  遍历/删除都在子进程里做，主进程只读结果，避免冻住事件循环） */
export const PLAN_FILE = join(DATA_ROOT, 'deliver-plan.json');

const log = (...a) => console.error('[deliver-prune]', ...a);

const argv = process.argv.slice(2);
const { argOf, has, num } = makeArgs(argv);
const APPLY = has('apply');
const JSON_OUT = has('json');
const KEEP = Math.max(0, Math.floor(num('keep', 2)));
const EXPECTED_REVISION = argOf('revision', null);
const RUN_ID = argOf('run-id', null);
const RESTORE_ID = argOf('restore', null);
const LIST_TRASH = has('list-trash');
const TRASH_NAME = '.prune-trash';
const ENTRY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT_VERSION = 2;
const digest = value => createHash('sha256').update(value).digest('hex');

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

const exactStat = path => lstatSync(path, { bigint: true });
const statIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.nlink];
const sameStat = (a, b) => statIdentity(a).every((value, index) => value === statIdentity(b)[index]);
const preciseIdentity = stat => Number.isSafeInteger(Number(stat.dev)) && Number.isSafeInteger(Number(stat.ino));

function legacyStat(path, expected) {
  const legacy = lstatSync(path);
  if (!sameStat(expected, exactStat(path)) || legacy.dev !== Number(expected.dev)
      || legacy.ino !== Number(expected.ino) || legacy.mode !== Number(expected.mode)
      || legacy.size !== Number(expected.size) || legacy.nlink !== Number(expected.nlink)) {
    throw new Error('path changed during scan');
  }
  return legacy;
}

function hashFile(path, expected, hashes) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameStat(opened, expected)) {
      throw new Error('file changed during scan');
    }
    let read;
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (const hash of hashes) hash.update(buffer.subarray(0, read));
    }
    if (!sameStat(fstatSync(fd, { bigint: true }), expected) || !sameStat(exactStat(path), expected)) {
      throw new Error('file changed during scan');
    }
  } finally { closeSync(fd); }
}

/** 一次遍历计算大小与内容指纹；不跟随符号链接或特殊文件。 */
export function measureDir(dir, { legacyFingerprint = false } = {}) {
  let files = 0, bytes = 0, exclusive = 0;
  const hash = createHash('sha256');
  const legacyHash = legacyFingerprint ? createHash('sha256') : null;
  let unsafe = false;
  let legacyIdentityPrecise = true;
  const rootStat = exactStat(dir);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('bundle is not a regular directory');
  const checkIdentity = st => {
    if (st.ino === 0n || st.dev < 0n) unsafe = true;
    if (!preciseIdentity(st)) legacyIdentityPrecise = false;
  };
  checkIdentity(rootStat);
  hash.update(JSON.stringify([rootStat.dev, rootStat.ino, rootStat.mode].map(String)));
  if (legacyHash) {
    const st = legacyStat(dir, rootStat);
    legacyHash.update(JSON.stringify([st.dev, st.ino, st.mode]));
  }
  const walk = (d, expectedDir, prefix = '') => {
    let entries;
    try {
      if (!sameStat(expectedDir, exactStat(d))) throw new Error('directory changed during scan');
      entries = readdirSync(d).sort();
    }
    catch { unsafe = true; return; }
    for (const n of entries) {
      const p = join(d, n);
      let st;
      try { st = exactStat(p); } catch { unsafe = true; continue; }
      const relativePath = prefix ? `${prefix}/${n}` : n;
      checkIdentity(st);
      hash.update(JSON.stringify([relativePath, ...statIdentity(st).map(String)]));
      if (legacyHash) {
        try {
          const old = legacyStat(p, st);
          legacyHash.update(JSON.stringify([relativePath, old.dev, old.ino, old.mode, old.size, old.mtimeMs, old.nlink]));
        } catch { unsafe = true; }
      }
      if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) { unsafe = true; continue; }
      if (st.isDirectory()) { walk(p, st, relativePath); continue; }
      files++;
      const size = Number(st.size);
      bytes += size;
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(bytes)) unsafe = true;
      try { hashFile(p, st, legacyHash ? [hash, legacyHash] : [hash]); } catch { unsafe = true; }
      // A single-link file cannot appear twice as a hard link. Avoid numeric
      // inode deduplication, which can merge distinct Windows file IDs.
      if (st.nlink === 1n) exclusive += size;
    }
    try { if (!sameStat(expectedDir, exactStat(d))) unsafe = true; } catch { unsafe = true; }
  };
  walk(dir, rootStat);
  return { files, bytes, exclusive, unsafe, fingerprintVersion: FINGERPRINT_VERSION,
    fingerprint: hash.digest('hex'),
    ...(legacyHash ? { legacyFingerprint: legacyHash.digest('hex'), legacyIdentityPrecise } : {}) };
}

/** 扫描 deliverable/ 下的全部包 */
export function scanBundles(root = DELIVERABLE) {
  if (!existsSync(root)) return [];
  const resolvedRoot = resolve(root);
  const rootStat = exactStat(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('deliverable root is not a regular directory');
  const rootIdentityUnsafe = rootStat.ino === 0n || rootStat.dev < 0n;
  const out = [];
  for (const name of readdirSync(resolvedRoot)) {
    if (name === TRASH_NAME) continue;
    const dir = join(resolvedRoot, name);
    let st;
    try { st = exactStat(dir); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const parsed = parseBundleName(name);
    const m = measureDir(dir);
    try { if (rootIdentityUnsafe || !sameStat(st, exactStat(dir))) m.unsafe = true; } catch { m.unsafe = true; }
    out.push({
      name, dir, root: resolvedRoot, dev: String(st.dev), ino: String(st.ino),
      rootDev: String(rootStat.dev), rootIno: String(rootStat.ino),
      host: parsed?.host ?? null,
      kind: parsed?.kind ?? null,
      dated: !!parsed?.dated,
      date: parsed?.date ?? null,
      mtime: Number(st.mtimeNs) / 1e6,
      ...m,
    });
  }
  try {
    if (!sameStat(rootStat, exactStat(resolvedRoot))) for (const bundle of out) bundle.unsafe = true;
  } catch { for (const bundle of out) bundle.unsafe = true; }
  return out.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.mtime - a.mtime || a.name.localeCompare(b.name));
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
    const blocked = sorted.some(b => b.unsafe);
    const kept = blocked ? sorted : sorted.slice(0, keep);
    const dropped = blocked ? [] : sorted.slice(keep);
    keepList.push(...kept);
    removeList.push(...dropped);
    groupInfo.push({
      key, count: list.length, keep: kept.map(b => b.name), remove: dropped.map(b => b.name), blocked,
      bytes: list.reduce((n, b) => n + b.bytes, 0),
      reclaimable: dropped.reduce((n, b) => n + b.exclusive, 0),
    });
  }

  return {
    retention: keep,
    revision: digest(JSON.stringify({ keep, bundles: [...bundles].sort((a, b) => a.name.localeCompare(b.name))
      .map(b => [b.name, b.root, b.dir, b.dev, b.ino, b.rootDev, b.rootIno,
        b.fingerprint, b.unsafe, b.date, b.mtime, b.bytes, b.exclusive]) })),
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

function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function regularDirectory(path) {
  const stat = exactStat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('path is not a regular directory');
  return stat;
}

function quarantineRoot(root, { create = false } = {}) {
  const resolved = resolve(root);
  const rootStat = regularDirectory(resolved);
  const trash = join(resolved, TRASH_NAME);
  if (create && !pathExists(trash)) mkdirSync(trash);
  if (!pathExists(trash)) return null;
  const trashStat = regularDirectory(trash);
  if (trashStat.dev !== rootStat.dev) throw new Error('quarantine must be on the same volume');
  return trash;
}

function receiptEntry(root, id) {
  if (!ENTRY_ID.test(id)) throw new Error('invalid quarantine id');
  const trash = quarantineRoot(root);
  if (!trash) throw new Error('quarantine not found');
  const dir = join(trash, id);
  regularDirectory(dir);
  const recordPath = join(dir, 'record.json');
  const stat = lstatSync(recordPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid quarantine record');
  const record = JSON.parse(readFileSync(recordPath, 'utf8'));
  if (record.id !== id || record.root !== resolve(root)
      || typeof record.name !== 'string' || basename(record.name) !== record.name
      || !parseBundleName(record.name)) throw new Error('invalid quarantine record');
  return { dir, recordPath, record };
}

function saveReceipt(entry, record) {
  writeFileAtomic(entry.recordPath, JSON.stringify(record, null, 2));
}

function measureForReceipt(path, record) {
  const legacy = record.fingerprintVersion === undefined || record.fingerprintVersion === 1;
  if (!legacy && record.fingerprintVersion !== FINGERPRINT_VERSION) throw new Error('unknown fingerprint version');
  const measured = measureDir(path, { legacyFingerprint: legacy });
  if (legacy && !measured.legacyIdentityPrecise) {
    throw new Error('旧收据的文件编号精度不足，请保留隔离区并人工核验（manual recovery required）');
  }
  return { measured, matches: !measured.unsafe
    && (legacy ? measured.legacyFingerprint : measured.fingerprint) === record.fingerprint };
}

function reconcileReceipt(root, id) {
  const entry = receiptEntry(root, id);
  if (entry.record.state !== 'prepared' && entry.record.state !== 'ready') return entry.record;
  const source = join(resolve(root), entry.record.name);
  const payload = join(entry.dir, 'bundle');
  const sourcePresent = pathExists(source);
  const payloadPresent = pathExists(payload);
  if (entry.record.state === 'ready' && payloadPresent) return entry.record;
  let state = 'needs-review';
  if (sourcePresent !== payloadPresent) {
    const present = sourcePresent ? source : payload;
    try {
      if (measureForReceipt(present, entry.record).matches) {
        state = sourcePresent
          ? (entry.record.state === 'ready' ? 'restored' : 'aborted') : 'ready';
      }
    } catch {}
  }
  const record = { ...entry.record, state, reconciledAt: new Date().toISOString() };
  saveReceipt(entry, record);
  return record;
}

export function listPrunedBundles(root = DELIVERABLE) {
  if (!pathExists(root)) return [];
  const trash = quarantineRoot(root);
  if (!trash) return [];
  return readdirSync(trash, { withFileTypes: true })
    .filter(item => item.isDirectory() && ENTRY_ID.test(item.name))
    .flatMap(item => {
      try { return [reconcileReceipt(root, item.name)]; }
      catch (error) { return [{ id: item.name, state: 'needs-review',
        error: String(error.message ?? error).slice(0, 160) }]; }
    })
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || a.id.localeCompare(b.id));
}

export function restorePrunedBundle(id, { root = DELIVERABLE } = {}) {
  const record = reconcileReceipt(root, id);
  if (record.state !== 'ready') throw new Error('quarantine entry is not ready');
  const entry = receiptEntry(root, id);
  const source = join(resolve(root), record.name);
  const payload = join(entry.dir, 'bundle');
  if (pathExists(source)) throw new Error('bundle name already exists');
  if (!measureForReceipt(payload, record).matches) throw new Error('quarantine content changed');
  renameSync(payload, source);
  try {
    if (!measureForReceipt(source, record).matches) throw new Error('quarantine content changed during restore');
    saveReceipt(entry, { ...record, state: 'restored', restoredAt: new Date().toISOString() });
  }
  catch (error) {
    try {
      if (pathExists(payload) || !pathExists(source) || !measureForReceipt(source, record).matches) {
        throw new Error('restore rollback needs manual review');
      }
      renameSync(source, payload);
    } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
  return { id, name: record.name, restored: true };
}

/** 再扫描并绑定预览 revision；执行只做同卷改名，保留恢复收据。 */
export function applyPrune(plan, { expectedRevision = plan.revision } = {}) {
  const removed = [];
  const failed = [];
  const candidates = Array.isArray(plan.remove) ? plan.remove : [];
  const emptyResult = () => ({ removed, failed, freed: 0,
    quarantinedBytes: removed.reduce((n, row) => n + row.bytes, 0) });
  if (!candidates.length) return emptyResult();
  const roots = new Set(candidates.map(b => resolve(b.root ?? DELIVERABLE)));
  if (roots.size !== 1) {
    failed.push(...candidates.map(b => ({ name: b.name, error: 'candidates span multiple roots' })));
    return emptyResult();
  }
  const root = [...roots][0];
  let current, trash;
  try {
    current = planPrune(scanBundles(root), { keep: plan.retention ?? 2 });
    if (!/^[0-9a-f]{64}$/i.test(expectedRevision ?? '')
        || plan.revision !== expectedRevision || current.revision !== expectedRevision) {
      throw new Error('preview revision changed; scan again before applying');
    }
    trash = quarantineRoot(root, { create: true });
  } catch (error) {
    failed.push(...candidates.map(b => ({ name: b.name, error: String(error.message ?? error) })));
    return emptyResult();
  }
  for (const planned of candidates) {
    const live = current.remove.find(b => b.name === planned.name);
    const id = randomUUID();
    const entry = { dir: join(trash, id), recordPath: join(trash, id, 'record.json') };
    let record = null;
    try {
      if (!live || planned.root !== root || planned.dir !== join(root, planned.name)
          || live.dir !== planned.dir || live.fingerprint !== planned.fingerprint
          || live.fingerprintVersion !== planned.fingerprintVersion
          || live.dev !== planned.dev || live.ino !== planned.ino) {
        throw new Error('candidate path or identity changed');
      }
      mkdirSync(entry.dir);
      record = { id, root, name: live.name, host: live.host, kind: live.kind,
        createdAt: new Date().toISOString(), state: 'prepared',
        fingerprint: live.fingerprint, fingerprintVersion: live.fingerprintVersion,
        bundleDev: live.dev, bundleIno: live.ino,
        bytes: live.bytes, exclusive: live.exclusive,
        previewRevision: expectedRevision };
      try { saveReceipt(entry, record); }
      catch (error) { try { rmdirSync(entry.dir); } catch {} throw error; }
      const source = join(root, live.name);
      const payload = join(entry.dir, 'bundle');
      const rootStat = regularDirectory(root);
      const stat = regularDirectory(source);
      const measured = measureDir(source);
      if (String(rootStat.dev) !== live.rootDev || String(rootStat.ino) !== live.rootIno
          || String(stat.dev) !== live.dev || String(stat.ino) !== live.ino || measured.unsafe
          || measured.fingerprint !== live.fingerprint) throw new Error('candidate changed after preview');
      renameSync(source, payload);
      const moved = measureDir(payload);
      if (moved.unsafe || moved.fingerprint !== live.fingerprint) {
        throw new Error('candidate changed during quarantine move');
      }
      saveReceipt(entry, { ...record, state: 'ready', quarantinedAt: new Date().toISOString() });
      removed.push({ name: live.name, bytes: live.bytes, exclusive: live.exclusive, trashId: id });
    } catch (error) {
      if (record) {
        let state = 'needs-review';
        const source = join(root, record.name);
        const payload = join(entry.dir, 'bundle');
        try {
          if (pathExists(payload) && !pathExists(source)) {
            const stat = regularDirectory(payload);
            if (String(stat.dev) === record.bundleDev && String(stat.ino) === record.bundleIno) {
              renameSync(payload, source);
            }
          }
          if (!pathExists(payload) && pathExists(source)) {
            if (measureForReceipt(source, record).matches) state = 'aborted';
          }
        } catch {}
        try { saveReceipt(entry, { ...record, state, failedAt: new Date().toISOString(),
          error: String(error.message ?? error).slice(0, 300) }); } catch {}
      }
      failed.push({ name: planned.name, trashId: record?.id ?? null,
        error: String(error.message ?? error).slice(0, 160) });
    }
  }
  return emptyResult();
}

const fmt = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + 'GB'
  : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB'
  : n >= 1024 ? (n / 1024).toFixed(0) + 'KB' : n + 'B');

export function renderText(plan, { apply = false } = {}) {
  const L = [];
  L.push(`交付包：${plan.total.bundles} 个 / ${fmt(plan.total.bytes)}（逻辑）`);
  L.push(`保留策略：每 (站点, 类型) 保留最近 ${plan.retention} 个`);
  L.push('');
  for (const g of plan.groups) {
    L.push(`${g.key}  ${g.count} 个`);
    for (const n of g.keep) L.push(`  保留  ${n}`);
    for (const n of g.remove) L.push(`  待隔离  ${n}`);
  }
  if (plan.unclassified.length) {
    L.push('');
    L.push(`无法归类（命名不含日期，**不会**自动删除 —— 可能是手工产物）：`);
    for (const b of plan.unclassified) L.push(`  ${b.name}  ${fmt(b.bytes)}`);
  }
  L.push('');
  L.push(`可隔离 ${plan.remove.length} 个包；未来永久清理潜在可释放 ${fmt(plan.total.reclaimable)}`);
  L.push('隔离只移动目录，当前不会释放磁盘空间；收据可用于恢复。');
  if (!apply && plan.remove.length) {
    L.push(`预览 revision: ${plan.revision}`);
    L.push('这是预览。加 --apply --revision <上方 revision> 才会移入同卷隔离区。');
  }
  return L.join('\n') + '\n';
}

// ---------- CLI ----------
// 仅在直接执行时跑；被 import（单测）时只暴露纯函数
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    if (LIST_TRASH || RESTORE_ID) {
      const result = RESTORE_ID ? restorePrunedBundle(RESTORE_ID) : listPrunedBundles();
      if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
      else process.stderr.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(0);
    }
    const bundles = scanBundles();
    const plan = planPrune(bundles, { keep: KEEP });

    let result = null;
    if (APPLY && !/^[0-9a-f]{64}$/i.test(EXPECTED_REVISION ?? '')) {
      throw new Error('--apply requires --revision from a prior preview');
    }
    if (APPLY && plan.revision !== EXPECTED_REVISION) {
      throw new Error('preview revision changed; scan again before applying');
    }
    if (APPLY && plan.remove.length) result = applyPrune(plan, { expectedRevision: EXPECTED_REVISION });
    const currentPlan = result ? planPrune(scanBundles(), { keep: KEEP }) : plan;

    if (JSON_OUT) {
      console.log(JSON.stringify({ keep: KEEP, apply: APPLY, ...plan, result }, null, 2));
    } else {
      process.stderr.write(renderText(plan, { apply: APPLY }));
      if (result) {
        log(`已隔离 ${result.removed.length} 个包；当前释放 0B，可用 --list-trash 查看恢复记录`);
        for (const f of result.failed) log(`失败：${f.name} — ${f.error}`);
      }
    }
    // 结果落盘供控制台读（不含 dir 之类的内部字段之外其实都可给，但保持紧凑）
    writeFileAtomic(PLAN_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      runId: RUN_ID,
      keep: KEEP, applied: APPLY,
      revision: currentPlan.revision,
      candidates: currentPlan.remove.map(b => ({ name: b.name, host: b.host, kind: b.kind,
        bytes: b.bytes, exclusive: b.exclusive, fingerprint: b.fingerprint })),
      groups: currentPlan.groups,
      unclassified: currentPlan.unclassified.map(b => ({ name: b.name, bytes: b.bytes })),
      total: currentPlan.total,
      result,
    }, null, 2));
    emit({
      kind: 'deliver-prune',
      apply: APPLY, keep: KEEP,
      removed: result ? result.removed.length : 0,
      planned: plan.remove.length,
      freed: result ? result.freed : 0,
      quarantinedBytes: result ? result.quarantinedBytes : 0,
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
