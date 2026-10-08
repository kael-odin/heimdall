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
import { readFileSync, mkdirSync, existsSync, linkSync, copyFileSync, statSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
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
export function dedupeTree(rootDir, storeDir, { dryRun = false, skip = [] } = {}) {
  const files = walkFiles(rootDir).filter(f => !skip.some(s => relative(rootDir, f.path).split(/[\\/]/).includes(s)));
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
