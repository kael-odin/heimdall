/**
 * store/cas — 内容寻址资产库（SHA-256）+ 硬链接去重
 *
 * 背景：实测 apify 资产 259.6MB 中 76% 是重复字节（同图/同字体跨页重复拷贝）。
 * 方案：相同内容只保留一份 CAS 副本，其余文件用硬链接指向它（同卷 NTFS/ext4 支持）；
 * 替换采用"先改名再链接、失败回滚"的顺序，绝不先删数据。
 *
 * 产物：DATA_ROOT/assets-cas/<aa>/<bb>/<sha256><ext>
 */
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, linkSync, copyFileSync, statSync, readdirSync, renameSync, unlinkSync, rmdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function casPath(storeDir, hash, ext = '') {
  return join(storeDir, hash.slice(0, 2), hash.slice(2, 4), hash + ext);
}

/** 把文件登记进 CAS；返回 { hash, path, existed } */
export function putAsset(storeDir, file) {
  const hash = sha256File(file);
  const dest = casPath(storeDir, hash, extname(file).toLowerCase());
  if (existsSync(dest)) return { hash, path: dest, existed: true };
  mkdirSync(join(storeDir, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
  copyFileSync(file, dest);
  return { hash, path: dest, existed: false };
}

/** 安全地把 target 替换为指向 casFile 的硬链接；失败则原样回滚 */
function linkOver(casFile, target) {
  if (!existsSync(casFile)) return false;
  const tmp = target + '.heimdall-tmp';
  try {
    renameSync(target, tmp);
    try {
      linkSync(casFile, target);
      unlinkSync(tmp);
      return true;
    } catch {
      renameSync(tmp, target);
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * 扫描 CAS，按硬链接数分类。
 *
 * 为什么 nlink===1 就等于"可回收"：去重后 CAS 与 workspace 里的每个副本**共用同一个 inode**
 * （linkOver 把原文件 rename 走、再 link CAS 过去）。所以：
 *   nlink === 1  → 只剩 CAS 这一个链接，没有任何站点文件在用它 → 孤儿，可回收
 *   nlink >= 2   → 至少还有一个 workspace 副本在用 → 保留
 * CAS 从不被直接读取（纯去重源），因此删掉孤儿不会破坏任何产物。
 *
 * @returns {{files:number, bytes:number, linkedFiles:number, linkedBytes:number,
 *            orphanFiles:number, orphanBytes:number, orphans:string[], ms:number, empty:number}}
 */
export function scanCas(storeDir) {
  const started = Date.now();
  const out = { files: 0, bytes: 0, linkedFiles: 0, linkedBytes: 0, orphanFiles: 0, orphanBytes: 0, orphans: [], empty: 0, ms: 0 };
  if (!existsSync(storeDir)) { out.ms = Date.now() - started; return out; }

  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      let st;
      try { st = statSync(p); } catch { continue; }
      out.files++;
      out.bytes += st.size;
      if (st.size === 0) { out.empty++; out.orphans.push(p); out.orphanFiles++; continue; }   // 0 字节：绝无价值，直接算孤儿
      if (st.nlink > 1) { out.linkedFiles++; out.linkedBytes += st.size; }
      else { out.orphanFiles++; out.orphanBytes += st.size; out.orphans.push(p); }
    }
  };
  walk(storeDir);
  out.ms = Date.now() - started;
  return out;
}

/**
 * 回收 CAS 孤儿。
 * @param {string} storeDir
 * @param {{apply?:boolean, limit?:number}} [opts] apply=false 时只统计
 */
export function gcCas(storeDir, { apply = false } = {}) {
  const scan = scanCas(storeDir);
  if (!apply) return { ...scan, applied: false, freed: 0, failed: 0, skipped: 0 };

  let freed = 0, failed = 0, skipped = 0;
  for (const p of scan.orphans) {
    try {
      // 删除前**再看一次** nlink：扫描与删除之间可能有并发去重刚把它链上（窗口极小，但代价也很小）
      const st = statSync(p);
      if (st.nlink > 1) { skipped++; continue; }
      unlinkSync(p);
      freed += st.size;
    } catch { failed++; }
  }
  // 清掉空目录（aa/bb），避免 CAS 里堆积成千上万个空文件夹
  try {
    for (const aa of readdirSync(storeDir, { withFileTypes: true })) {
      if (!aa.isDirectory()) continue;
      const aaDir = join(storeDir, aa.name);
      for (const bb of readdirSync(aaDir, { withFileTypes: true })) {
        if (!bb.isDirectory()) continue;
        const bbDir = join(aaDir, bb.name);
        try { if (readdirSync(bbDir).length === 0) rmdirSync(bbDir); } catch { /* 非空或占用 */ }
      }
      try { if (readdirSync(aaDir).length === 0) rmdirSync(aaDir); } catch { /* 非空 */ }
    }
  } catch { /* 清理失败不影响主流程 */ }

  return { ...scan, applied: true, freed, failed, skipped, orphans: undefined };
}

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (st.isFile() && !name.endsWith('.heimdall-tmp')) out.push({ path: p, size: st.size });
  }
  return out;
}

/**
 * 对一棵目录树做去重。返回 ledger：
 * { files, unique, duplicates, bytesTotal, bytesSaved, linked, skipped, storeDir, dryRun }
 */
export function dedupeTree(rootDir, storeDir, { dryRun = false, skip = [], onlyUnder = [] } = {}) {
  const segsOf = (p) => relative(rootDir, p).split(/[\\/]/);
  const files = walkFiles(rootDir)
    .filter(f => !skip.some(s => segsOf(f.path).includes(s)))
    // onlyUnder：只对"写一次就不再改"的**产物资产树**去重（clone/ 与 live/）。
    // 捕获输入（cssom*.css / dom*.html / network.har）和各种清单、评分文件会被后续步骤
    // 反复重写，硬链接它们等于让一次写入改到别处去 —— 实测就是这么把源站的 cssom.css
    // 覆盖成构建产物的（linear.app 三页，详见 fsutil.mjs 的 writeFileAtomic）。
    // 去重的收益本来也全在这两棵树里（图片、字体被几十页共用），缩范围几乎不损失什么。
    .filter(f => {
      if (!onlyUnder.length) return true;
      const parents = segsOf(f.path).slice(0, -1);
      return onlyUnder.some(d => parents.includes(d));
    });
  const byHash = new Map();
  let bytesTotal = 0, bytesSaved = 0, duplicates = 0, linked = 0, skipped = 0;

  for (const f of files) {
    bytesTotal += f.size;
    let hash;
    try { hash = sha256File(f.path); } catch { skipped++; continue; }
    const first = byHash.get(hash);

    if (first) {
      duplicates++;
      bytesSaved += f.size;   // 逻辑上省下的重复字节（实际以硬链接为准）
      if (dryRun) continue;
      const cas = casPath(storeDir, hash, extname(f.path).toLowerCase());
      if (!existsSync(cas)) { try { putAsset(storeDir, f.path); } catch {} }
      if (linkOver(cas, f.path)) linked++; else { skipped++; bytesSaved -= f.size; }
      continue;
    }

    byHash.set(hash, f.path);
    if (dryRun) continue;
    try {
      const cas = putAsset(storeDir, f.path);
      // 首个副本也替换为 CAS 硬链接：CAS 成为唯一权威副本
      if (linkOver(cas.path, f.path)) linked++;
    } catch { skipped++; }
  }

  return { rootDir, storeDir, files: files.length, unique: byHash.size, duplicates, bytesTotal, bytesSaved, linked, skipped, dryRun };
}
