/**
 * audit/storage — 磁盘占用盘点
 *
 * 关键不变量：workspace 与 assets-cas 去重后**共用 inode**，所以
 *   ① `logicalBytes` 会把硬链接重复计算（回答"这个站多大"）
 *   ② `uniqueBytes` 必须跨目录用同一张 (dev, ino) 表去重（回答"真实占多少"）
 * 把两者混为一谈，"能省多少"直接算错。
 *
 * 用临时 HEIMDALL_DATA_DIR 隔离（paths.mjs 在模块加载时解析目录，所以必须在 import 前设置）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'hd-storage-'));
process.env.HEIMDALL_DATA_DIR = dataDir;

const { computeStorage } = await import('../src/audit/storage.mjs');

const WS = join(dataDir, 'workspace');
const CAS = join(dataDir, 'assets-cas');
const DEL = join(dataDir, 'deliverable');

/** 新建一个独立文件 */
function put(file, body) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return Buffer.byteLength(body);
}
/** 把 existing 与 newPath 变成同一 inode（模拟去重 / 硬链接拷贝） */
function hardlink(existing, newPath) {
  mkdirSync(dirname(newPath), { recursive: true });
  linkSync(existing, newPath);
}

// ---------- 固定装置 ----------
const A1 = join(WS, 'a.test', 'pages', 'home', 'clone', 'index.html');       // 100B 独占
const A2 = join(WS, 'a.test', 'pages', 'home', 'clone', 'assets', 'logo.png'); // 200B，与 CAS 同 inode
const CAS_LINKED = join(CAS, 'ab', 'cd', 'abcd-logo.png');
const CAS_ORPHAN = join(CAS, 'ef', '01', 'ef01-orphan.png');                 // 300B 孤儿
const B1 = join(WS, 'b.test', 'recon', 'atlas.json');                        // 50B
const DEL_FILE = join(DEL, 'a.test-2026', 'index.html');                     // 与 A1 同 inode
const ROOT_STRAY = join(WS, 'debug-shot.png');                               // 40B（workspace 根）
const MATRIX = join(WS, '_matrix', 'matrix.json');                           // 10B（下划线目录）

put(A1, 'A'.repeat(100));
put(A2, 'B'.repeat(200));
hardlink(A2, CAS_LINKED);
put(CAS_ORPHAN, 'E'.repeat(300));
put(B1, 'C'.repeat(50));
hardlink(A1, DEL_FILE);
put(ROOT_STRAY, 'F'.repeat(40));
put(MATRIX, 'G'.repeat(10));

test('storage: 跨目录硬链接只算一次实际占用，但逻辑体积各算各的', () => {
  const s = computeStorage();

  const a = s.sites.find(x => x.host === 'a.test');
  const b = s.sites.find(x => x.host === 'b.test');
  assert.ok(a && b, '两个站点都应出现在清单里');
  assert.equal(a.files, 2);
  assert.equal(a.logicalBytes, 300);
  assert.equal(a.uniqueBytes, 300, '站点内部无重复，全部算作它自己的占用');
  assert.equal(b.logicalBytes, 50);

  assert.equal(s.cas.files, 2);
  assert.equal(s.cas.logicalBytes, 500, 'CAS 逻辑体积把两个文件都算上');
  assert.equal(s.cas.uniqueBytes, 300, 'CAS 里只有孤儿是"新"的（另一个与站点同 inode）');

  assert.equal(s.deliverable.files, 1);
  assert.equal(s.deliverable.logicalBytes, 100);
  assert.equal(s.deliverable.uniqueBytes, 0, '交付包里的拷贝与站点文件同 inode');

  // 实际占用 = 100 + 200 + 300 + 50 + 40 + 10 = 700
  assert.equal(s.totals.uniqueBytes, 700);
  // 逻辑体积 = 100*2 + 200*2 + 300 + 50 + 40 + 10 = 1000
  assert.equal(s.totals.logicalBytes, 1000);
  assert.equal(s.totals.files, 8, 'A1 A2 CAS×2 B1 交付包 根散落 _matrix');
  assert.ok(s.totals.uniqueBytes < s.totals.logicalBytes, '硬链接场景下实际必然小于逻辑');
});

test('storage: 孤儿 CAS 计入可回收，在用 CAS 不计入', () => {
  const s = computeStorage();
  assert.equal(s.cas.orphanFiles, 1);
  assert.equal(s.cas.orphanBytes, 300);
  assert.equal(s.cas.linkedFiles, 1);
  assert.equal(s.cas.linkedBytes, 200);
});

test('storage: workspace 根的散落文件与下划线目录分开统计，且不算成站点', () => {
  const s = computeStorage();
  assert.equal(s.workspaceRootFiles.files, 1);
  assert.equal(s.workspaceRootFiles.logicalBytes, 40);
  assert.deepEqual(s.workspaceRootFiles.names.map(n => n.name), ['debug-shot.png']);
  assert.deepEqual(s.workspaceOtherDirs, ['_matrix']);
  assert.equal(s.workspaceOther.logicalBytes, 10);
  assert.deepEqual(s.sites.map(x => x.host).sort(), ['a.test', 'b.test'], '_matrix 不得被当成站点');
});

test('storage: 可指定站点清单；不存在的站点给出 exists:false 而不是抛错', () => {
  const s = computeStorage({ sites: ['a.test', 'nope.test'] });
  assert.equal(s.sites.length, 2);
  assert.equal(s.sites.find(x => x.host === 'a.test').exists, true);
  const missing = s.sites.find(x => x.host === 'nope.test');
  assert.equal(missing.exists, false);
  assert.equal(missing.files, 0);
  assert.equal(missing.logicalBytes, 0);
});

test('storage: 空站点清单不报错', () => {
  const s = computeStorage({ sites: [] });
  assert.deepEqual(s.sites, []);
  assert.ok(s.totals.uniqueBytes >= 0);
});

test('storage: 最近删除容量在目录内去重，总量仍跨目录去重', () => {
  const trash = join(dataDir, 'trash', 'entry');
  const metadata = put(join(trash, 'record.json'), '{"state":"ready"}');
  hardlink(A2, join(trash, 'site', 'logo.png'));
  hardlink(A2, join(trash, 'site', 'logo-copy.png'));
  try {
    const s = computeStorage();
    assert.equal(s.trash.files, 3);
    assert.equal(s.trash.logicalBytes, metadata + 400);
    assert.equal(s.trash.uniqueBytes, metadata + 200,
      '容量告警要看到隔离区内的共享硬链接，且在隔离区内部只计算一次');
    assert.equal(s.trash.uniqueContributionBytes, metadata,
      '共享 inode 已由 workspace/CAS 计入总量');
    assert.equal(s.totals.uniqueBytes, 700 + metadata);
  } finally { rmSync(trash, { recursive: true, force: true }); }
});

test.after(() => { rmSync(dataDir, { recursive: true, force: true }); });
