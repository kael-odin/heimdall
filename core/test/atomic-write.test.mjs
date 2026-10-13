/**
 * 就地写入 vs 硬链接 —— 一个把**源站捕获文件覆盖成构建产物**的 bug。
 *
 * 实测链条（linear.app 三页）：
 *   1. 某次构建里 CSS 的引用一条都没解析成功 → 写出来的 cssom.css 与捕获输入**逐字节相同**；
 *   2. dedupe 按内容寻址，把 `pages/<p>/cssom.css` 与 `clone/styles/cssom.css` 硬链接成同一个 inode；
 *   3. 下一次构建**再次**本地化并 `writeFileSync` 那个文件 —— 由于是同一个 inode，
 *      **它把自己的输入改了**：源文件被本地化后的内容覆盖；
 *   4. 再下一次构建读到的就是被污染的输入，报出一串莫须有的缺口
 *      （`https://linear.app/ref001.woff2` soft-404），而全程没有任何提示。
 *
 * 两条防线，各钉一条：
 *   · 原子写（rename 换目录项 → 切断硬链接）：写入永远只影响自己
 *   · dedupe 不去重"会被重写的文件"（捕获输入与各种清单），从源头不让这种别名成立
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, linkSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { writeFileAtomic } = await import('../src/fsutil.mjs');
const { dedupeTree } = await import('../src/store/cas.mjs');

test('原子写会切断硬链接：写一个不影响另一个', () => {
  const d = mkdtempSync(join(tmpdir(), 'heimdall-atomic-'));
  try {
    const a = join(d, 'source.css');
    const b = join(d, 'built.css');
    writeFileSync(a, 'ORIGINAL');
    linkSync(a, b);                        // b 与 a 同一个 inode
    assert.equal(statSync(a).ino, statSync(b).ino, '前置条件：两者确实被硬链接了');
    writeFileAtomic(b, 'BUILT');           // 构建产物写自己
    assert.equal(readFileSync(a, 'utf8'), 'ORIGINAL', '源文件必须原封不动');
    assert.equal(readFileSync(b, 'utf8'), 'BUILT');
    assert.notEqual(statSync(a).ino, statSync(b).ino, '写完就不再是同一个 inode');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('对照：普通的 writeFileSync 会穿透硬链接（这就是当初的 bug）', () => {
  const d = mkdtempSync(join(tmpdir(), 'heimdall-atomic2-'));
  try {
    const a = join(d, 'source.css');
    const b = join(d, 'built.css');
    writeFileSync(a, 'ORIGINAL');
    linkSync(a, b);
    writeFileSync(b, 'BUILT');             // 就地写
    assert.equal(readFileSync(a, 'utf8'), 'BUILT', '就地写确实会改到"源"—— 所以构建产物必须走原子写');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('dedupe 只去重资产树：捕获输入与清单不参与（它们会被重写）', () => {
  const d = mkdtempSync(join(tmpdir(), 'heimdall-dedupe-'));
  try {
    mkdirSync(join(d, 'pages', 'p', 'clone', 'assets'), { recursive: true });
    mkdirSync(join(d, 'pages', 'p'), { recursive: true });
    writeFileSync(join(d, 'pages', 'p', 'clone', 'assets', 'a.png'), 'SAME');
    writeFileSync(join(d, 'pages', 'p', 'clone', 'assets', 'b.png'), 'SAME');   // 资产树里 → 该去重
    writeFileSync(join(d, 'pages', 'p', 'cssom.css'), 'SAME');                   // 捕获输入 → 不去重
    const led = dedupeTree(d, join(d, 'cas'), { onlyUnder: ['clone', 'live', 'assets', 'styles'] });
    assert.equal(led.files, 2, '只应看到 clone/assets 下的两个文件');
    assert.equal(led.duplicates, 1, '资产树里的重复照常去重');
  } finally { rmSync(d, { recursive: true, force: true }); }
});
