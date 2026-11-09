/**
 * audit/deliver-prune — 交付包保留策略
 *
 * 这组测试钉住的是候选身份、内容与恢复能力。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, linkSync, rmSync, existsSync, renameSync, symlinkSync, lstatSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { parseBundleName, measureDir, scanBundles, planPrune, applyPrune, listPrunedBundles, restorePrunedBundle, renderText } =
  await import('../src/audit/deliver-prune.mjs');

// ---------- 命名解析 ----------
test('parseBundleName: 识别静态镜像包', () => {
  assert.deepEqual(parseBundleName('apify.com-2026-10-08'), { host: 'apify.com', kind: 'static', dated: true, date: '2026-10-08' });
  assert.deepEqual(parseBundleName('thordata.com-2026-09-30'), { host: 'thordata.com', kind: 'static', dated: true, date: '2026-09-30' });
});

test('parseBundleName: 识别交互镜像包（-live- 优先于日期）', () => {
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

test('planPrune: 静态包与交互镜像包分开计数', () => {
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
  assert.match(renderText(plan), /未来永久清理潜在可释放 0B/);
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

function oldFingerprint(dir) {
  const hash = createHash('sha256');
  const rootStat = lstatSync(dir);
  hash.update(JSON.stringify([rootStat.dev, rootStat.ino, rootStat.mode]));
  const walk = (d, prefix = '') => {
    for (const name of readdirSync(d).sort()) {
      const path = join(d, name);
      const st = lstatSync(path);
      const relative = prefix ? `${prefix}/${name}` : name;
      hash.update(JSON.stringify([relative, st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.nlink]));
      if (st.isDirectory()) walk(path, relative);
      else if (st.isFile()) hash.update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

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

test('fs: exclusive byte count does not merge distinct files with rounded inode numbers', () => {
  const files = Object.fromEntries(Array.from({ length: 512 }, (_, index) => [`f${index}`, 'x']));
  const m = measureDir(makeBundle('many-files.test', files));
  assert.equal(m.files, 512);
  assert.equal(m.bytes, 512);
  assert.equal(m.exclusive, 512);
  assert.equal(m.unsafe, false);
});

test('fs: hard links inside one bundle remain excluded from exclusive bytes', () => {
  const d = makeBundle('internal-links.test', { 'a.bin': 'a'.repeat(20) });
  linkSync(join(d, 'a.bin'), join(d, 'b.bin'));
  const m = measureDir(d);
  assert.equal(m.files, 2);
  assert.equal(m.bytes, 40);
  assert.equal(m.exclusive, 0);
});

test('fs: exact identity notices same-content file swaps, including rounded inode collisions', t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-exact-'));
  try {
    const bundle = join(dataRoot, 'a.test-2026-10-01');
    mkdirSync(bundle);
    mkdirSync(join(dataRoot, 'a.test-2026-10-02'));
    const ids = new Map();
    let collision;
    const names = [];
    for (let index = 0; index < 512; index++) {
      const name = `f${index}`;
      const path = join(bundle, name);
      writeFileSync(path, 'x');
      utimesSync(path, 1600000000, 1600000000);
      const ino = lstatSync(path, { bigint: true }).ino;
      const rounded = Number(ino);
      if (!collision && ids.has(rounded) && ids.get(rounded).ino !== ino) collision = [ids.get(rounded).name, name];
      ids.set(rounded, { ino, name });
      names.push(name);
    }
    const plan = planPrune(scanBundles(dataRoot), { keep: 1 });
    const before = measureDir(bundle, { legacyFingerprint: true });
    const [a, b] = collision ?? names;
    renameSync(join(bundle, a), join(bundle, 'temporary-swap'));
    renameSync(join(bundle, b), join(bundle, a));
    renameSync(join(bundle, 'temporary-swap'), join(bundle, b));
    const after = measureDir(bundle, { legacyFingerprint: true });
    assert.equal(before.unsafe, false);
    assert.equal(after.unsafe, false);
    assert.notEqual(after.fingerprint, before.fingerprint);
    if (collision) {
      assert.equal(after.legacyFingerprint, before.legacyFingerprint);
      assert.equal(before.legacyIdentityPrecise, false);
      t.diagnostic('Reproduced two distinct file IDs with the same rounded number');
    } else {
      t.diagnostic('This filesystem did not allocate a rounded-ID collision in 512 files');
    }
    const result = applyPrune(plan);
    assert.equal(result.removed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(existsSync(bundle), true);
    if (collision) {
      const id = '01234567-89ab-4cde-8f01-23456789abd0';
      const entry = join(dataRoot, '.prune-trash', id);
      mkdirSync(entry, { recursive: true });
      const record = { id, root: dataRoot, name: 'a.test-2026-10-01',
        fingerprint: before.legacyFingerprint, state: 'ready' };
      writeFileSync(join(entry, 'record.json'), JSON.stringify(record));
      renameSync(bundle, join(entry, 'bundle'));
      assert.throws(() => restorePrunedBundle(id, { root: dataRoot }), /manual recovery required/);
      writeFileSync(join(entry, 'record.json'), JSON.stringify({ ...record, state: 'prepared' }));
      assert.equal(listPrunedBundles(dataRoot).find(row => row.id === id).state, 'needs-review');
      assert.equal(existsSync(join(entry, 'bundle', a)), true);
    }
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: replacing a file between lstat and open makes the scan unsafe', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-open-race-'));
  try {
    const a = join(dataRoot, 'a');
    const b = join(dataRoot, 'b');
    writeFileSync(a, 'same');
    writeFileSync(b, 'same');
    utimesSync(a, 1600000000, 1600000000);
    utimesSync(b, 1600000000, 1600000000);
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const original = fs.openSync;
      let swapped = false;
      fs.openSync = function(path, ...args) {
        if (!swapped && path === process.env.TARGET) {
          swapped = true;
          fs.renameSync(path, process.env.TEMPORARY);
          fs.renameSync(process.env.OTHER, path);
          fs.renameSync(process.env.TEMPORARY, process.env.OTHER);
        }
        return original.call(fs, path, ...args);
      };
      syncBuiltinESMExports();
      const { measureDir } = await import(pathToFileURL(process.env.MODULE).href);
      const measured = measureDir(process.env.DATA_ROOT);
      if (!swapped || !measured.unsafe) process.exitCode = 1;
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, DATA_ROOT: dataRoot, TARGET: a, OTHER: b,
        TEMPORARY: join(dataRoot, 'swap'), MODULE: fileURLToPath(new URL('../src/audit/deliver-prune.mjs', import.meta.url)) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(a, 'utf8'), 'same');
    assert.equal(readFileSync(b, 'utf8'), 'same');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: a changed bundle is returned and marked for review after quarantine move', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-move-race-'));
  try {
    const name = 'a.test-2026-10-01';
    const source = join(dataRoot, name);
    mkdirSync(source);
    mkdirSync(join(dataRoot, 'a.test-2026-10-02'));
    writeFileSync(join(source, 'index.html'), 'original');
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const original = fs.renameSync;
      let changed = false;
      fs.renameSync = function(from, to) {
        const result = original.call(fs, from, to);
        if (!changed && from === process.env.SOURCE && to.endsWith('bundle')) {
          changed = true;
          fs.writeFileSync(join(to, 'index.html'), 'changed during move');
        }
        return result;
      };
      syncBuiltinESMExports();
      const { scanBundles, planPrune, applyPrune } = await import(pathToFileURL(process.env.MODULE).href);
      const result = applyPrune(planPrune(scanBundles(process.env.DATA_ROOT), { keep: 1 }));
      if (!changed || result.removed.length !== 0 || result.failed.length !== 1) process.exitCode = 1;
      else process.stdout.write(JSON.stringify(result.failed[0]));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, DATA_ROOT: dataRoot, SOURCE: source,
        MODULE: fileURLToPath(new URL('../src/audit/deliver-prune.mjs', import.meta.url)) },
    });
    assert.equal(run.status, 0, run.stderr);
    const failed = JSON.parse(run.stdout);
    assert.match(failed.error, /changed during quarantine move/);
    assert.equal(readFileSync(join(source, 'index.html'), 'utf8'), 'changed during move');
    const receipt = JSON.parse(readFileSync(join(dataRoot, '.prune-trash', failed.trashId, 'record.json'), 'utf8'));
    assert.equal(receipt.state, 'needs-review');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: rollback does not move a substituted quarantine directory', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-folder-race-'));
  try {
    const source = join(dataRoot, 'a.test-2026-10-01');
    mkdirSync(source);
    mkdirSync(join(dataRoot, 'a.test-2026-10-02'));
    writeFileSync(join(source, 'index.html'), 'original');
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      import { join, dirname } from 'node:path';
      const original = fs.renameSync;
      let substituted = false;
      fs.renameSync = function(from, to) {
        const result = original.call(fs, from, to);
        if (!substituted && from === process.env.SOURCE && to.endsWith('bundle')) {
          substituted = true;
          original.call(fs, to, join(dirname(to), 'original-held'));
          fs.mkdirSync(to);
          fs.writeFileSync(join(to, 'index.html'), 'substitute');
        }
        return result;
      };
      syncBuiltinESMExports();
      const { scanBundles, planPrune, applyPrune } = await import(pathToFileURL(process.env.MODULE).href);
      const result = applyPrune(planPrune(scanBundles(process.env.DATA_ROOT), { keep: 1 }));
      if (!substituted || result.removed.length !== 0 || result.failed.length !== 1) process.exitCode = 1;
      else process.stdout.write(JSON.stringify(result.failed[0]));
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, DATA_ROOT: dataRoot, SOURCE: source,
        MODULE: fileURLToPath(new URL('../src/audit/deliver-prune.mjs', import.meta.url)) },
    });
    assert.equal(run.status, 0, run.stderr);
    const failed = JSON.parse(run.stdout);
    const entry = join(dataRoot, '.prune-trash', failed.trashId);
    assert.equal(existsSync(source), false);
    assert.equal(readFileSync(join(entry, 'bundle', 'index.html'), 'utf8'), 'substitute');
    assert.equal(readFileSync(join(entry, 'original-held', 'index.html'), 'utf8'), 'original');
    assert.equal(JSON.parse(readFileSync(join(entry, 'record.json'), 'utf8')).state, 'needs-review');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
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

test('fs: an unavailable deliverable root identity blocks automatic quarantine', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-no-root-id-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      mkdirSync(join(dataRoot, name));
      writeFileSync(join(dataRoot, name, 'index.html'), name);
    }
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const original = fs.lstatSync;
      fs.lstatSync = function(path, options) {
        const stat = original.call(fs, path, options);
        if (path === process.env.DATA_ROOT && options?.bigint) stat.ino = 0n;
        return stat;
      };
      syncBuiltinESMExports();
      const { scanBundles, planPrune } = await import(pathToFileURL(process.env.MODULE).href);
      const plan = planPrune(scanBundles(process.env.DATA_ROOT), { keep: 1 });
      if (plan.remove.length || !plan.groups[0].blocked) process.exitCode = 1;
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, DATA_ROOT: dataRoot,
        MODULE: fileURLToPath(new URL('../src/audit/deliver-prune.mjs', import.meta.url)) },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(join(dataRoot, 'a.test-2026-10-01', 'index.html')), true);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: applyPrune 隔离候选，可恢复且当前释放量为零', () => {
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
  assert.equal(res.freed, 0);
  assert.equal(res.quarantinedBytes, 20);
  assert.ok(existsSync(join(r3, 'a.com-2026-10-03')), '最新的必须留下');
  assert.ok(existsSync(join(r3, 'keep-me')), '无法归类的不许动');
  assert.ok(!existsSync(join(r3, 'a.com-2026-10-01')));
  const listed = listPrunedBundles(r3);
  assert.equal(listed.length, 2);
  assert.ok(listed.every(row => row.state === 'ready'));
  const restored = restorePrunedBundle(res.removed[0].trashId, { root: r3 });
  assert.equal(restored.restored, true);
  assert.equal(readFileSync(join(r3, restored.name, 'f.txt'), 'utf8'), 'x'.repeat(10));
  assert.equal(listPrunedBundles(r3).find(row => row.id === restored.id)?.state, 'restored');
  rmSync(r3, { recursive: true, force: true });
});

test('fs: 预览后新增同组包或改写候选内容均拒绝隔离', () => {
  for (const change of ['new-sibling', 'file-content']) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-stale-'));
    try {
      for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
        mkdirSync(join(dataRoot, name));
        writeFileSync(join(dataRoot, name, 'index.html'), name);
      }
      const plan = planPrune(scanBundles(dataRoot), { keep: 1 });
      if (change === 'new-sibling') {
        mkdirSync(join(dataRoot, 'a.test-2026-10-03'));
      } else {
        writeFileSync(join(dataRoot, 'a.test-2026-10-01', 'index.html'), 'changed');
      }
      const result = applyPrune(plan, { expectedRevision: plan.revision });
      assert.equal(result.removed.length, 0);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0].error, /revision changed/);
      assert.equal(existsSync(join(dataRoot, 'a.test-2026-10-01')), true);
    } finally { rmSync(dataRoot, { recursive: true, force: true }); }
  }
});

test('fs: 符号链接候选阻断整个站点类型组', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-link-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      mkdirSync(join(dataRoot, name));
      writeFileSync(join(dataRoot, name, 'index.html'), name);
    }
    const outside = join(dataRoot, 'outside.txt');
    writeFileSync(outside, 'outside evidence');
    symlinkSync(outside, join(dataRoot, 'a.test-2026-10-01', 'linked.txt'));
    const plan = planPrune(scanBundles(dataRoot), { keep: 1 });
    assert.equal(plan.remove.length, 0);
    assert.equal(plan.groups[0].blocked, true);
    assert.equal(readFileSync(outside, 'utf8'), 'outside evidence');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: 恢复时同名目录冲突不覆盖任何一方', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-conflict-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      mkdirSync(join(dataRoot, name));
      writeFileSync(join(dataRoot, name, 'index.html'), name);
    }
    const plan = planPrune(scanBundles(dataRoot), { keep: 1 });
    const result = applyPrune(plan);
    const id = result.removed[0].trashId;
    const name = result.removed[0].name;
    mkdirSync(join(dataRoot, name));
    writeFileSync(join(dataRoot, name, 'index.html'), 'new sibling');
    assert.throws(() => restorePrunedBundle(id, { root: dataRoot }), /already exists/);
    assert.equal(readFileSync(join(dataRoot, name, 'index.html'), 'utf8'), 'new sibling');
    assert.equal(readFileSync(join(dataRoot, '.prune-trash', id, 'bundle', 'index.html'), 'utf8'), name);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: prepared 收据在中断后根据内容对账，坏收据可见', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-receipt-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      mkdirSync(join(dataRoot, name));
      writeFileSync(join(dataRoot, name, 'index.html'), name);
    }
    const plan = planPrune(scanBundles(dataRoot), { keep: 1 });
    const candidate = plan.remove[0];
    const id = '01234567-89ab-4cde-8f01-23456789abcd';
    const entry = join(dataRoot, '.prune-trash', id);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'record.json'), JSON.stringify({ id, root: dataRoot, name: candidate.name,
      fingerprint: candidate.fingerprint, fingerprintVersion: candidate.fingerprintVersion,
      state: 'prepared', createdAt: new Date().toISOString() }));
    renameSync(join(dataRoot, candidate.name), join(entry, 'bundle'));
    assert.equal(listPrunedBundles(dataRoot).find(row => row.id === id)?.state, 'ready');
    const invalidId = '01234567-89ab-4cde-8f01-23456789abce';
    mkdirSync(join(dataRoot, '.prune-trash', invalidId));
    assert.equal(listPrunedBundles(dataRoot).find(row => row.id === invalidId)?.state, 'needs-review');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: old receipts restore only when their rounded identities are exact', t => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-old-receipt-'));
  try {
    const name = 'a.test-2026-10-01';
    const source = join(dataRoot, name);
    mkdirSync(source);
    mkdirSync(join(source, 'nested'));
    writeFileSync(join(source, 'nested', 'index.html'), 'legacy evidence');
    const original = oldFingerprint(source);
    const measured = measureDir(source, { legacyFingerprint: true });
    assert.equal(measured.legacyFingerprint, original);
    const id = '01234567-89ab-4cde-8f01-23456789abcf';
    const entry = join(dataRoot, '.prune-trash', id);
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'record.json'), JSON.stringify({ id, root: dataRoot, name,
      fingerprint: original, state: 'ready', createdAt: new Date().toISOString() }));
    renameSync(source, join(entry, 'bundle'));
    if (measured.legacyIdentityPrecise) {
      assert.equal(restorePrunedBundle(id, { root: dataRoot }).restored, true);
      assert.equal(readFileSync(join(source, 'nested', 'index.html'), 'utf8'), 'legacy evidence');
      t.diagnostic('Legacy receipt with exact numeric identities was restored');
    } else {
      assert.throws(() => restorePrunedBundle(id, { root: dataRoot }), /manual recovery required/);
      assert.equal(readFileSync(join(entry, 'bundle', 'nested', 'index.html'), 'utf8'), 'legacy evidence');
      t.diagnostic('Legacy receipt with rounded identities was retained for manual recovery');
    }
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: a legacy receipt with exact numeric IDs can still be restored', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-old-exact-'));
  try {
    const source = join(dataRoot, 'a.test-2026-10-01');
    mkdirSync(source);
    writeFileSync(join(source, 'index.html'), 'legacy evidence');
    const script = `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const lstat = fs.lstatSync, fstat = fs.fstatSync, ids = new Map();
      const mapId = (stat, exact) => {
        const key = String(exact.dev) + ':' + String(exact.ino);
        if (!ids.has(key)) ids.set(key, BigInt(ids.size + 1));
        stat.dev = typeof stat.dev === 'bigint' ? 1n : 1;
        stat.ino = typeof stat.ino === 'bigint' ? ids.get(key) : Number(ids.get(key));
        return stat;
      };
      fs.lstatSync = (path, options) => mapId(lstat(path, options), lstat(path, { bigint: true }));
      fs.fstatSync = (fd, options) => mapId(fstat(fd, options), fstat(fd, { bigint: true }));
      syncBuiltinESMExports();
      const root = process.env.DATA_ROOT, source = process.env.SOURCE;
      const rootStat = fs.lstatSync(source), file = join(source, 'index.html'), st = fs.lstatSync(file);
      const hash = createHash('sha256');
      hash.update(JSON.stringify([rootStat.dev, rootStat.ino, rootStat.mode]));
      hash.update(JSON.stringify(['index.html', st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.nlink]));
      hash.update(fs.readFileSync(file));
      const id = '01234567-89ab-4cde-8f01-23456789abd1', entry = join(root, '.prune-trash', id);
      fs.mkdirSync(entry, { recursive: true });
      fs.writeFileSync(join(entry, 'record.json'), JSON.stringify({ id, root, name: 'a.test-2026-10-01',
        fingerprint: hash.digest('hex'), state: 'ready' }));
      fs.renameSync(source, join(entry, 'bundle'));
      const { restorePrunedBundle } = await import(pathToFileURL(process.env.MODULE).href);
      assert.equal(restorePrunedBundle(id, { root }).restored, true);
      assert.equal(fs.readFileSync(join(source, 'index.html'), 'utf8'), 'legacy evidence');
    `;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, DATA_ROOT: dataRoot, SOURCE: source,
        MODULE: fileURLToPath(new URL('../src/audit/deliver-prune.mjs', import.meta.url)) },
    });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: restoring changed quarantine contents preserves both receipt and payload', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-changed-receipt-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      mkdirSync(join(dataRoot, name));
      writeFileSync(join(dataRoot, name, 'index.html'), name);
    }
    const result = applyPrune(planPrune(scanBundles(dataRoot), { keep: 1 }));
    assert.equal(result.failed.length, 0);
    const { trashId, name } = result.removed[0];
    const payload = join(dataRoot, '.prune-trash', trashId, 'bundle');
    writeFileSync(join(payload, 'index.html'), 'changed after quarantine');
    assert.throws(() => restorePrunedBundle(trashId, { root: dataRoot }), /quarantine content changed/);
    assert.equal(existsSync(join(dataRoot, name)), false);
    assert.equal(readFileSync(join(payload, 'index.html'), 'utf8'), 'changed after quarantine');
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test('fs: applyPrune refuses a candidate moved outside its scanned root', () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-prune-boundary-'));
  const outside = mkdtempSync(join(tmpdir(), 'hd-prune-outside-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'index.html'), name);
    }
    writeFileSync(join(outside, 'keep.txt'), 'outside evidence');
    const plan = planPrune(scanBundles(root), { keep: 1 });
    plan.remove[0].dir = outside;
    const result = applyPrune(plan);
    assert.equal(result.removed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside evidence');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('fs: applyPrune refuses a candidate relabeled as a different sibling', () => {
  const root = mkdtempSync(join(tmpdir(), 'hd-prune-sibling-'));
  try {
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      const dir = join(root, name);
      mkdirSync(dir);
      writeFileSync(join(dir, 'index.html'), name);
    }
    const plan = planPrune(scanBundles(root), { keep: 1 });
    plan.remove[0].dir = join(root, 'a.test-2026-10-02');
    const result = applyPrune(plan);
    assert.equal(result.removed.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(existsSync(join(root, 'a.test-2026-10-02', 'index.html')), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI: empty inventory writes a completed plan; after apply the saved plan reflects surviving bundles', () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'hd-prune-cli-'));
  const script = fileURLToPath(new URL('../src/audit/deliver-prune.mjs', import.meta.url));
  const planFile = join(dataRoot, 'deliver-plan.json');
  const run = (args = []) => spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot }, encoding: 'utf8',
  });
  try {
    const empty = run();
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(JSON.parse(readFileSync(planFile, 'utf8')).total.bundles, 0);

    const deliverable = join(dataRoot, 'deliverable');
    for (const name of ['a.test-2026-10-01', 'a.test-2026-10-02']) {
      const dir = join(deliverable, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'index.html'), name);
    }
    const preview = run(['--keep', '1']);
    assert.equal(preview.status, 0, preview.stderr);
    const revision = JSON.parse(readFileSync(planFile, 'utf8')).revision;
    const missingRevision = run(['--keep', '1', '--apply']);
    assert.equal(missingRevision.status, 1);
    assert.equal(existsSync(join(deliverable, 'a.test-2026-10-01')), true);
    const applied = run(['--keep', '1', '--apply', '--revision', revision]);
    assert.equal(applied.status, 0, applied.stderr);
    const saved = JSON.parse(readFileSync(planFile, 'utf8'));
    assert.equal(saved.total.bundles, 1);
    assert.equal(saved.total.reclaimable, 0);
    assert.deepEqual(saved.groups[0].remove, []);
    assert.deepEqual(saved.result.removed.map(row => row.name), ['a.test-2026-10-01']);
    assert.equal(existsSync(join(deliverable, 'a.test-2026-10-02')), true);
  } finally { rmSync(dataRoot, { recursive: true, force: true }); }
});

test.after(() => rmSync(root, { recursive: true, force: true }));

// ---------- 日期戳 ----------
test('localDateStamp: 用本地日历，不是 UTC', async () => {
  const { localDateStamp } = await import('../src/paths.mjs');
  // 构造一个"本地 10-11 凌晨 1 点"的时刻：此时 UTC 可能还是 10-10
  const d = new Date(2026, 9, 11, 1, 0, 0);   // 月份从 0 起 → 10 月
  assert.equal(localDateStamp(d), '2026-10-11');
  // 断言它与 toISOString 在这类时刻**确实可能不同** —— 这正是要修的问题
  const utc = d.toISOString().slice(0, 10);
  const localTzOffsetMin = d.getTimezoneOffset();
  if (localTzOffsetMin < 0) assert.notEqual(localDateStamp(d), utc, '东时区凌晨应与 UTC 日期不同');
});

test('localDateStamp: 月/日补零', async () => {
  const { localDateStamp } = await import('../src/paths.mjs');
  assert.equal(localDateStamp(new Date(2026, 0, 5)), '2026-01-05');
});
