/**
 * @@EVENT@@ 协议只能有一处实现
 *
 * 引擎（engine-server.mjs 的 spawnTask）只把 stdout 里以 `@@EVENT@@` 开头的行
 * 当机器事件解析，其余全当人类日志。这一行的前缀/格式就是协议 —— 多写一处、
 * 抄错一个字符，事件就静默丢失（不报错，界面只是"没有进度"，极难查）。
 *
 * 这条守卫来自一次清理：此前 12 个脚本各自复制了一份 emit，其中 queue.mjs 那份
 * 还悄悄多了个"仅 --json-events 时输出"的条件。现在统一到 src/emit.mjs。
 * 以后有人图省事再内联一行 `process.stdout.write('@@EVENT@@'...)`，这里会拦下。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.mjs')) out.push(p);
  }
  return out;
}

test('只有 src/emit.mjs 直接写 @@EVENT@@ 行', () => {
  const offenders = [];
  for (const f of walk(SRC)) {
    const rel = relative(SRC, f).split('\\').join('/');
    if (rel === 'emit.mjs') continue;
    const text = readFileSync(f, 'utf8');
    if (text.includes("process.stdout.write('@@EVENT@@")) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    '这些文件内联了 @@EVENT@@ 协议（应改为 import { emit } from …/emit.mjs）：\n' + offenders.join('\n'));
});

test('守卫自身：emit.mjs 里确实有那一行（否则上面那条会因为文件改名而变成空检查）', () => {
  const text = readFileSync(join(SRC, 'emit.mjs'), 'utf8');
  assert.ok(text.includes("process.stdout.write('@@EVENT@@"), 'emit.mjs 应当是协议的唯一定义处');
});
