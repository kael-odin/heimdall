/**
 * audit/storage — 磁盘占用盘点（每站逻辑体积 / 真实占用 / CAS 状态）
 *
 * 为什么需要它：删掉站点后 CAS 不会自己缩水，"删了 10 个站磁盘只涨不跌"。
 * 这里把"哪些字节是谁占的"讲清楚，配合 cas-gc 才能真正释放。
 *
 * 硬链接口径（重要，别把两个数字混为一谈）：
 *   logical  该目录下所有文件大小之和 —— 硬链接会被重复计算，适合回答"这个站多大"
 *   unique   按 (dev, ino) 去重后的字节 —— 真实磁盘占用，适合回答"能省多少"
 * workspaces 与 assets-cas 共用 inode（去重后是硬链接），所以两者的 unique 不能相加，
 * 必须**在同一遍遍历里跨目录一起去重**，totals.uniqueBytes 就是这么算的。
 *
 * 用法: node src/audit/storage.mjs [--out <file>]   → 写 DATA_ROOT/storage.json
 */
import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT, WORKSPACE, DELIVERABLE } from '../paths.mjs';
import { emit } from '../emit.mjs';
import { scanCas } from '../store/cas.mjs';

const CAS_DIR = join(DATA_ROOT, 'assets-cas');
const TRASH_DIR = join(DATA_ROOT, 'trash');

/** seen 跨目录计入总量；localSeen 只在指定目录内去重。 */
function walk(root, seen, localSeen = null) {
  const out = { files: 0, dirs: 0, logicalBytes: 0, uniqueBytes: 0 };
  if (localSeen) out.containedUniqueBytes = 0;
  if (!existsSync(root)) return out;
  const go = (dir) => {
    out.dirs++;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { go(p); continue; }
      if (!e.isFile()) continue;
      let st;
      // NTFS inode/dev values can exceed Number.MAX_SAFE_INTEGER. Asking for
      // BigInt avoids two distinct files rounding to the same dedupe key.
      try { st = statSync(p, { bigint: true }); } catch { continue; }
      out.files++;
      const size = Number(st.size);
      out.logicalBytes += size;
      if (!seen) { out.uniqueBytes += size; continue; }
      const key = st.dev + ':' + st.ino;
      if (localSeen && !localSeen.has(key)) {
        localSeen.add(key);
        out.containedUniqueBytes += size;
      }
      if (!seen.has(key)) { seen.add(key); out.uniqueBytes += size; }
    }
  };
  go(root);
  return out;
}

/**
 * 盘点整个 DATA_ROOT。
 * @param {{sites?: string[]}} [opts] sites 已知站点列表；缺省时从 workspace 目录推断
 */
export function computeStorage(opts = {}) {
  const started = Date.now();
  const seen = new Set();   // 跨目录共用的 inode 去重表 → 真实占用

  const sites = opts.sites ?? (existsSync(WORKSPACE)
    ? readdirSync(WORKSPACE, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('_')).map(d => d.name)
    : []);

  const siteRows = sites.map((host) => {
    const dir = join(WORKSPACE, host);
    const w = walk(dir, seen);
    return { host, ...w, exists: existsSync(dir) };
  });
  // 站点之外的 workspace 内容（_matrix/_browser 等辅助产物 + 散落的调试图）
  const strayDirs = existsSync(WORKSPACE)
    ? readdirSync(WORKSPACE, { withFileTypes: true }).filter(d => d.isDirectory() && d.name.startsWith('_')).map(d => d.name)
    : [];
  const workspaceOther = { files: 0, dirs: 0, logicalBytes: 0, uniqueBytes: 0 };
  for (const d of strayDirs) {
    const w = walk(join(WORKSPACE, d), seen);
    for (const k of Object.keys(workspaceOther)) workspaceOther[k] += w[k];
  }

  const cas = scanCas(CAS_DIR);
  const casWalk = { files: cas.files, dirs: 0, logicalBytes: cas.bytes, uniqueBytes: 0 };
  // CAS 的 inode 大多与 workspace 共享，所以用同一个 seen 表继续填 unique
  {
    const w = walk(CAS_DIR, seen);
    casWalk.uniqueBytes = w.uniqueBytes;
    casWalk.dirs = w.dirs;
  }

  const deliverable = walk(DELIVERABLE, seen);
  const { uniqueBytes: uniqueContributionBytes, containedUniqueBytes: uniqueBytes, ...trashMetrics } =
    walk(TRASH_DIR, seen, new Set());
  const trash = { ...trashMetrics, uniqueBytes, uniqueContributionBytes };

  // workspace 根下直接躺着的散落文件（调试图等）—— 不属于任何站点，但确实占地方
  const rootFiles = { files: 0, dirs: 0, logicalBytes: 0, uniqueBytes: 0, names: [] };
  if (existsSync(WORKSPACE)) {
    for (const e of readdirSync(WORKSPACE, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      let st;
      try { st = statSync(join(WORKSPACE, e.name), { bigint: true }); } catch { continue; }
      rootFiles.files++;
      const size = Number(st.size);
      rootFiles.logicalBytes += size;
      const key = st.dev + ':' + st.ino;
      if (!seen.has(key)) { seen.add(key); rootFiles.uniqueBytes += size; }
      rootFiles.names.push({ name: e.name, bytes: size });
    }
    rootFiles.names.sort((a, b) => b.bytes - a.bytes);
  }

  const totals = {
    logicalBytes: siteRows.reduce((n, r) => n + r.logicalBytes, 0) + workspaceOther.logicalBytes + rootFiles.logicalBytes + casWalk.logicalBytes + deliverable.logicalBytes + trash.logicalBytes,
    uniqueBytes: siteRows.reduce((n, r) => n + r.uniqueBytes, 0) + workspaceOther.uniqueBytes + rootFiles.uniqueBytes + casWalk.uniqueBytes + deliverable.uniqueBytes + trash.uniqueContributionBytes,
    files: siteRows.reduce((n, r) => n + r.files, 0) + workspaceOther.files + rootFiles.files + casWalk.files + deliverable.files + trash.files,
  };

  return {
    dataRoot: DATA_ROOT,
    sites: siteRows.sort((a, b) => b.logicalBytes - a.logicalBytes),
    workspaceOther,
    workspaceOtherDirs: strayDirs,
    workspaceRootFiles: rootFiles,
    cas: {
      files: cas.files, logicalBytes: cas.bytes, uniqueBytes: casWalk.uniqueBytes,
      linkedFiles: cas.linkedFiles, linkedBytes: cas.linkedBytes,
      orphanFiles: cas.orphanFiles, orphanBytes: cas.orphanBytes, emptyFiles: cas.empty,
    },
    deliverable,
    trash,
    totals,
    ms: Date.now() - started,
    generatedAt: new Date().toISOString(),
  };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('audit/storage.mjs');
if (isMain) {
  const outIdx = process.argv.indexOf('--out');
  const summary = computeStorage();
  const outFile = outIdx > -1 ? process.argv[outIdx + 1] : join(DATA_ROOT, 'storage.json');
  writeFileSync(outFile, JSON.stringify(summary, null, 2));
  const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
  console.log(`storage: ${summary.sites.length} 站点 · 逻辑 ${mb(summary.totals.logicalBytes)} · 实际占用 ${mb(summary.totals.uniqueBytes)} · ${summary.ms}ms`);
  for (const s of summary.sites) console.log(`  ${s.host.padEnd(24)} ${String(s.files).padStart(7)} 文件  逻辑 ${mb(s.logicalBytes).padStart(9)}  独占 ${mb(s.uniqueBytes).padStart(9)}`);
  console.log(`  ${'(CAS)'.padEnd(24)} ${String(summary.cas.files).padStart(7)} 文件  ${mb(summary.cas.uniqueBytes).padStart(9)} 在用 / 孤儿 ${mb(summary.cas.orphanBytes)}（${summary.cas.orphanFiles} 个）`);
  console.log(`  ${'(交付包)'.padEnd(24)} ${String(summary.deliverable.files).padStart(7)} 文件  ${mb(summary.deliverable.uniqueBytes).padStart(9)}`);
  console.log(`  ${'(最近删除)'.padEnd(24)} ${String(summary.trash.files).padStart(7)} 文件  逻辑 ${mb(summary.trash.logicalBytes)} / 目录内去重 ${mb(summary.trash.uniqueBytes)} / 总量新增 ${mb(summary.trash.uniqueContributionBytes)}`);
  console.log('-> ' + outFile);
  // 让引擎/控制台能直接看到本次结果
  emit({ kind: 'storage', sites: summary.sites.length, uniqueBytes: summary.totals.uniqueBytes, orphanBytes: summary.cas.orphanBytes });
}
