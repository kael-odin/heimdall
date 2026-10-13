/**
 * 回收孤儿资产的自检：**量不出来时必须回滚**。
 *
 * 这条来自一次真实的"最该拦人的时候放行"：
 *
 *     const worse = baselineGaps != null && afterGaps != null && afterGaps > baselineGaps;
 *
 * `afterGaps == null`（assets 扫描崩了 / 事件行丢了 / stdout 被截断）时 `worse` 为 false，
 * 于是走"保留"分支 —— 文件已经搬进 quarantine，却没做任何验证，还被记成一次成功。
 * 而 assets 扫描正是这个工具用来判断"有没有把页面搞坏"的**唯一手段**。
 *
 * 反向才对：拿不到两次测量就回滚。quarantine 是可逆的，丢掉的资产不是。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rollbackDecision } = await import('../src/audit/reclaim-orphans.mjs');

test('两次数得出来、且没变差 → 保留', () => {
  assert.deepEqual(rollbackDecision(3, 3), { rollback: false, reason: null });
  assert.deepEqual(rollbackDecision(5, 0), { rollback: false, reason: null }, '缺口变少当然更好');
});

test('缺口变多 → 回滚', () => {
  assert.deepEqual(rollbackDecision(3, 4), { rollback: true, reason: 'gaps-worse' });
});

test('**量不出来 → 回滚**（这条就是那次放行的反面）', () => {
  assert.deepEqual(rollbackDecision(3, null), { rollback: true, reason: 'unmeasured' });
  assert.deepEqual(rollbackDecision(null, 3), { rollback: true, reason: 'unmeasured' });
  assert.deepEqual(rollbackDecision(null, null), { rollback: true, reason: 'unmeasured' });
});

test('边界：0 是有效测量，不是"没量到"', () => {
  assert.deepEqual(rollbackDecision(0, 0), { rollback: false, reason: null });
  assert.deepEqual(rollbackDecision(0, 1), { rollback: true, reason: 'gaps-worse' });
  // undefined 与 null 同类：都没量到
  assert.equal(rollbackDecision(undefined, 0).rollback, true);
  assert.equal(rollbackDecision(0, undefined).rollback, true);
});
