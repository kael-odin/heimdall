/**
 * audit/deliver-prune — 交付包保留策略
 *
 * 这组测试钉住的是**"不会误删"**，不是返回值好看：
 * 清理工具的失败模式是不可逆的 —— 删错一个包，用户的交付物就没了。
 * 所以重点覆盖三条：认不出的包绝不动、分组不跨站点串、独占字节按 nlink 算。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { parseBundleName, measureDir, scanBundles, planPrune, applyPrune, renderText } =
  await import('../src/audit/deliver-prune.mjs');

// ---------- 命名解析 ----------
test('parseBundleName: 识别静态镜像包', () => {
  assert.deepEqual(parseBundleName('apify.com-2026-10-08'), { host: 'apify.com', kind: 'static', dated: true, date: '2026-10-08' });
  assert.deepEqual(parseBundleName('thordata.com-2026-09-30'), { host: 'thordata.com', kind: 'static', dated: true, date: '2026-09-30' });
});

test('parseBundleName: 识别活镜像包（-live- 优先于日期）', () => {
  assert.deepEqual(parseBundleName('apify.com-live-2026-10-09'), { host: 'apify.com', kind: 'live', dated: true, date: '2026-10-09' });
  assert.deepEqual(parseBundleName('thordata.com-live-2026-10-08'), { host: 'thordata.com', kind: 'live', dated: true, date: '2026-10-08' });
});

test('parseBundleName: 必须带出日期 —— 排序以它为准，不是目录 mtime', () => {
  assert.equal(parseBundleName('a.com-live-2026-03-04').date, '2026-03-04');
  assert.equal(parseBundleName('a.com-2026-03-04').date, '2026-03-04');
});

test('parseBundleName: 认不出的一律返回 null（宁可不认，不可猜错）', () => {
  for (const n of ['apify-live-healed', 'heal-live-test', 'backup', 'apify.com', 'apify.com-2026-13-99', 'x-20261009']) {
    assert.equal(parseBundleName(n), null, `${n} 不应被识别为可清理的包`);
  }
});

test('parseBundleName: 日期必须是 YYYY-MM-DD 形状', () => {
  assert.equal(parseBundleName('a-2026-1-1'), null);
  assert.equal(parseBundleName('a-26-01-01'), null);
  assert.ok(parseBundleName('a-2026-01-01'));
});

// ---------- 分组与保留 ----------
const B = (name, mtime, extra = {}) => ({ name, dir: '/x/' + name, mtime, bytes: 100, exclusive: 100, files: 1, dated: true, ...parseBundleName(name), ...extra });

test('planPrune: 每个 (站点,类型) 各自保留 N 个，互不挤占', () => {
  const bundles = [
    B('apify.com-2026-10-01', 1), B('apify.com-2026-10-02', 2), B('apify.com-2026-10-03', 3),
    B('thordata.com-2026-09-01', 10),   // 另一个站点只有 1 个
  ];
  const plan = planPrune(bundles, { keep: 2 });
  // apify 保留最新 2 个（10-03, 10-02），淘汰最旧的
  assert.deepEqual(plan.remove.map(b => b.name), ['apify.com-2026-10-01']);
  // thordata 只有 1 个 → 不受影响（全局按时间保留的话它会被挤掉）
  assert.ok(plan.keep.some(b => b.name === 'thordata.com-2026-09-01'));
});

test('planPrune: 静态包与活镜像包分开计数', () => {
  const bundles = [
    B('s.com-2026-10-01', 1), B('s.com-2026-10-02', 2),
    B('s.com-live-2026-10-01', 3), B('s.com-live-2026-10-02', 4),
  ];
  const plan = planPrune(bundles, { keep: 1 });
  assert.deepEqual(plan.remove.map(b => b.name).sort(), ['s.com-2026-10-01', 's.com-live-2026-10-01']);
  assert.equal(plan.groups.length, 2, '两个分组各自独立');
});

test('planPrune: 认不出的包绝不进入 remove', () => {
  const bundles = [
    B('apify.com-2026-10-01', 1), B('apify.com-2026-10-02', 2), B('apify.com-2026-10-03', 3),
    { name: 'apify-live-healed', dir: '/x/h', mtime: 1, bytes: 999, exclusive: 999, files: 1, host: null, kind: null, dated: false },
    { name: 'heal-live-test', dir: '/x/t', mtime: 1, bytes: 999, exclusive: 999, files: 1, host: null, kind: null, dated: false },
  ];
  const plan = planPrune(bundles, { keep: 1 });
  assert.equal(plan.remove.length, 2, '只删可归类的陈旧包');
  assert.ok(!plan.remove.some(b => !b.dated));
  assert.deepEqual(plan.unclassified.map(b => b.name), ['apify-live-healed', 'heal-live-test']);
});

test('planPrune: keep=0 时全部淘汰，但仍不碰无法归类的', () => {
  const plan = planPrune([B('a.com-2026-10-01', 1), { name: 'misc', dated: false, bytes: 5, exclusive: 5 }], { keep: 0 });
  assert.equal(plan.remove.length, 1);
  assert.equal(plan.unclassified.length, 1);
});

test('planPrune: 排序按名字里的日期，不按目录 mtime', () => {
  // 旧包因为内部文件被改动过，mtime 反而更新 —— 按 mtime 排会把老包当新的留下。
  // 目录 mtime 会随内容增删变化，不是"这个包什么时候构建的"。
  const bundles = [
    B('a.com-2026-10-01', 9999),   // 日期旧，但 mtime 最新（被改过）
    B('a.com-2026-10-05', 100),
    B('a.com-2026-10-09', 200),
  ];
  const plan = planPrune(bundles, { keep: 1 });
  assert.deepEqual(plan.keep.map(b => b.name), ['a.com-2026-10-09']);
  assert.deepEqual(plan.remove.map(b => b.name).sort(), ['a.com-2026-10-01', 'a.com-2026-10-05']);
});

test('planPrune: 可回收按 exclusive（nlink=1）而不是目录大小', () => {
  const bundles = [
    B('a.com-2026-10-01', 1, { bytes: 1000, exclusive: 0 }),   // 全部与 workspace 共享 inode
    B('a.com-2026-10-02', 2, { bytes: 1000, exclusive: 1000 }),
  ];
  const plan = planPrune(bundles, { keep: 1 });
  assert.equal(plan.total.reclaimable, 0, '被淘汰的包若全是硬链接，删了也不省空间');
  assert.match(renderText(plan), /实际可释放 0B/);
});

test('planPrune: 空输入不炸', () => {
  const plan = planPrune([], { keep: 2 });
  assert.deepEqual(plan.remove, []);
  assert.equal(plan.total.bundles, 0);
  assert.doesNotThrow(() => renderText(plan));
});

test('renderText: 预览时明确说明还没删', () => {
  const plan = planPrune([B('a.com-2026-10-01', 1), B('a.com-2026-10-02', 2)], { keep: 1 });
  assert.match(renderText(plan, { apply: false }), /预览.*--apply/);
  assert.doesNotMatch(renderText(plan, { apply: true }), /这是预览/);
});

// ---------- 真实文件系统 ----------
const root = mkdtempSync(join(tmpdir(), 'hd-prune-'));

function makeBundle(name, files) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

test('fs: measureDir 统计文件数与字节', () => {
  const d = makeBundle('m.test', { 'index.html': 'x'.repeat(100), 'assets/a.png': 'y'.repeat(50) });
  const m = measureDir(d);
  assert.equal(m.files, 2);
  assert.equal(m.bytes, 150);
  assert.equal(m.exclusive, 150, '无外部链接时全部是独占');
});

test('fs: 与外部共享 inode 的部分不计入 exclusive', () => {
  const outside = join(root, 'outside.bin');
  writeFileSync(outside, 'z'.repeat(80));
  const d = makeBundle('shared.test', { 'a.bin': 'a'.repeat(20) });
  linkSync(outside, join(d, 'linked.bin'));

  const m = measureDir(d);
  assert.equal(m.files, 2);
  assert.equal(m.bytes, 100);
  assert.equal(m.exclusive, 20, 'linked.bin 有 2 个链接 → 删包不释放它的 80 字节');
});

test('fs: scanBundles 从真实目录读出并归类', () => {
  const r2 = mkdtempSync(join(tmpdir(), 'hd-prune2-'));
  for (const n of ['a.com-2026-10-01', 'a.com-live-2026-10-02', 'weird-name']) {
    mkdirSync(join(r2, n), { recursive: true });
    writeFileSync(join(r2, n, 'f.txt'), 'x');
  }
  const got = scanBundles(r2);
  assert.equal(got.length, 3);
  assert.ok(got.find(b => b.name === 'a.com-2026-10-01')?.dated);
  assert.equal(got.find(b => b.name === 'weird-name')?.dated, false);
  rmSync(r2, { recursive: true, force: true });
});

test('fs: applyPrune 真的删除，且只删 remove 里列出的', () => {
  const r3 = mkdtempSync(join(tmpdir(), 'hd-prune3-'));
  for (const n of ['a.com-2026-10-01', 'a.com-2026-10-02', 'a.com-2026-10-03', 'keep-me']) {
    mkdirSync(join(r3, n), { recursive: true });
    writeFileSync(join(r3, n, 'f.txt'), 'x'.repeat(10));
  }
  const plan = planPrune(scanBundles(r3), { keep: 1 });
  assert.equal(plan.remove.length, 2);
  const res = applyPrune(plan);

  assert.equal(res.failed.length, 0);
  assert.equal(res.removed.length, 2);
  assert.equal(res.freed, 20);
  assert.ok(existsSync(join(r3, 'a.com-2026-10-03')), '最新的必须留下');
  assert.ok(existsSync(join(r3, 'keep-me')), '无法归类的不许动');
  assert.ok(!existsSync(join(r3, 'a.com-2026-10-01')));
  rmSync(r3, { recursive: true, force: true });
});

test.after(() => rmSync(root, { recursive: true, force: true }));
