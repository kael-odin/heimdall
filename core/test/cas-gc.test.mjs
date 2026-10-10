/**
 * store/cas — 孤儿判定与回收
 *
 * 关键不变量：CAS 与 workspace 副本共用 inode（去重后是硬链接）。所以
 *   nlink > 1  → 还有站点文件在用 → 必须保留
 *   nlink === 1 → 只剩 CAS 这一个链接 → 孤儿，可回收（CAS 从不被直接读取）
 * 回收必须**不碰**在用的 blob，且工作区文件在回收后仍可读。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, linkSync, rmSync, statSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { putAsset, scanCas, gcCas, casPath } from '../src/store/cas.mjs';

const root = mkdtempSync(join(tmpdir(), 'hd-cas-'));
const storeDir = join(root, 'assets-cas');
const siteDir = join(root, 'workspace', 'a.test', 'pages', 'home', 'assets');
mkdirSync(siteDir, { recursive: true });

/** 建一个"去重后"的文件：CAS 有副本，workspace 侧是同一 inode 的硬链接 */
function dedupedFile(name, body) {
  const src = join(siteDir, name);
  writeFileSync(src, body);
  const { hash, path } = putAsset(storeDir, src);
  // 复刻 linkOver 的"先改名、再链接、删临时"顺序（目标已存在时 linkSync 会 EEXIST）
  const tmp = src + '.heimdall-tmp';
  renameSync(src, tmp);
  linkSync(path, src);
  unlinkSync(tmp);
  return { src, hash, casFile: casPath(storeDir, hash, '.png') };
}

test('cas: nlink>1 的 blob 保留，nlink===1 的判为孤儿', () => {
  const keep = dedupedFile('a.png', 'AAA-keep-me');
  const src = join(siteDir, 'orphan-src.png');
  writeFileSync(src, 'BBB-orphan');
  const orphan = putAsset(storeDir, src);   // 只登记进 CAS，没有硬链接回去
  // 删掉源文件 → CAS 副本成为无引用孤儿（模拟站点被删除后的状态）
  rmSync(src);

  assert.equal(statSync(keep.casFile).nlink, 2, '在用 blob 应有 2 个链接');
  assert.equal(statSync(orphan.path).nlink, 1, '孤儿 blob 只有 1 个链接');

  const s = scanCas(storeDir);
  assert.equal(s.files, 2);
  assert.equal(s.linkedFiles, 1);
  assert.equal(s.orphanFiles, 1);
  assert.deepEqual(s.orphans, [orphan.path]);
  assert.ok(s.orphanBytes > 0 && s.linkedBytes > 0);
});

test('cas: dry-run 不动任何文件', () => {
  const before = scanCas(storeDir);
  const r = gcCas(storeDir, { apply: false });
  assert.equal(r.applied, false);
  assert.equal(r.freed, 0);
  assert.equal(scanCas(storeDir).files, before.files, '文件数不变');
});

test('cas: apply 回收孤儿，但在用 blob 与工作区文件完好', () => {
  const keepPath = readdirSyncSafe(storeDir).find(p => statSync(p).nlink > 1);
  assert.ok(keepPath, '前置：应存在一个在用 blob');
  const keepSize = statSync(keepPath).size;

  const r = gcCas(storeDir, { apply: true });
  assert.equal(r.applied, true);
  assert.equal(r.failed, 0);
  assert.equal(r.freed, r.orphanBytes);
  assert.ok(existsSync(keepPath), '在用 blob 不能被删');
  assert.equal(statSync(keepPath).size, keepSize);

  const after = scanCas(storeDir);
  assert.equal(after.files, 1);
  assert.equal(after.orphanFiles, 0);

  // 工作区文件仍可读（硬链接的另一端还在）
  const siteFile = join(siteDir, 'a.png');
  assert.ok(existsSync(siteFile), '站点文件必须还在');
  assert.equal(readFileSync(siteFile, 'utf8'), 'AAA-keep-me');
  assert.equal(statSync(siteFile).nlink, 2, '在用文件仍与 CAS 共用 inode（两个链接都在）');

  // 真正的闭环：站点删掉后，这个 blob 才变孤儿，下次 GC 才回收
  rmSync(siteDir, { recursive: true, force: true });
  assert.equal(scanCas(storeDir).orphanFiles, 1, '站点删除后原在用 blob 变为孤儿');
  const r2 = gcCas(storeDir, { apply: true });
  assert.equal(r2.freed, keepSize);
  assert.equal(scanCas(storeDir).files, 0, '全部回收完毕');
});

test('cas: 0 字节文件直接算孤儿（绝无价值）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hd-cas0-'));
  const dir = join(tmp, 'cas');
  mkdirSync(join(dir, 'aa', 'bb'), { recursive: true });
  writeFileSync(join(dir, 'aa', 'bb', 'empty.bin'), '');
  const s = scanCas(dir);
  assert.equal(s.files, 1);
  assert.equal(s.empty, 1);
  assert.equal(s.orphanFiles, 1);
  const r = gcCas(dir, { apply: true });
  assert.equal(r.freed, 0);
  assert.equal(scanCas(dir).files, 0);
  assert.ok(!existsSync(join(dir, 'aa', 'bb')), '空目录应被清理');
  rmSync(tmp, { recursive: true, force: true });
});

test('cas: 空 CAS / 不存在的目录不报错', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'hd-casx-'));
  const s = scanCas(join(tmp, 'nope'));
  assert.equal(s.files, 0);
  assert.deepEqual(s.orphans, []);
  rmSync(tmp, { recursive: true, force: true });
});

function readdirSyncSafe(dir) {
  const out = [];
  const go = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) go(p); else out.push(p);
    }
  };
  go(dir);
  return out;
}

test.after(() => { rmSync(root, { recursive: true, force: true }); });
