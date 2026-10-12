/**
 * forge-slots — 锻造槽计数
 *
 * 这条守卫来自一个真实的读数：控制台显示「克隆槽 -1/2」。
 * 根因是引擎在任务退出时用兜底的 `else slots--` 归还槽位，
 * 于是**没占过槽的任务类型**（cas-gc / editmanifest / replace-domain）退出时也减一。
 * 后果不只是数字难看：`used >= max` 这道闸门从此永不触发，并发上限静默失效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { makeSlotBox } = await import('../src/forge-slots.mjs');

test('占满就拒绝，且拒绝时计数不变', () => {
  const s = makeSlotBox(2);
  assert.equal(s.acquire(), true);
  assert.equal(s.acquire(), true);
  assert.equal(s.acquire(), false, '满了必须返回 false');
  assert.equal(s.used, 2, '被拒绝的那次不能把计数推上去');
});

test('**归还没有对应占用时不变负** —— 就是"克隆槽 -1/2"那条', () => {
  const s = makeSlotBox(2);
  assert.equal(s.release(), false, '没占过就归还 → 必须被拒绝');
  assert.equal(s.used, 0, '计数不能变成 -1');
  assert.equal(s.acquire(), true, '闸门也不能因此失灵');
  assert.equal(s.acquire(), true);
  assert.equal(s.acquire(), false, '上限依然有效（记账错误不该把并发放开）');
  assert.equal(s.errors, 1, '这次异常要留痕，别静静吞掉');
});

test('正常一来一回：计数回到 0 且不留错误', () => {
  const s = makeSlotBox(3);
  for (let i = 0; i < 3; i++) assert.equal(s.acquire(), true);
  for (let i = 0; i < 3; i++) assert.equal(s.release(), true);
  assert.equal(s.used, 0);
  assert.equal(s.errors, 0);
});

test('max 非法时兜底为 1（宁可只开一个，也不要"无限并发"）', () => {
  for (const bad of [0, -3, NaN, undefined, 'x']) {
    const s = makeSlotBox(bad);
    assert.equal(s.max, 1, String(bad) + ' 应该兜底成 1');
    assert.equal(s.acquire(), true);
    assert.equal(s.acquire(), false);
  }
  assert.equal(makeSlotBox(4.7).max, 4, '小数向下取整');
});
