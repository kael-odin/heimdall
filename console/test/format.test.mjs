/**
 * 控制台文案的纯函数部分。
 *
 * 这些函数以前没有任何测试：它们不碰 DOM，改错了也只在界面上"看起来还行"，
 * 而进度条上的"还剩约 N 分钟"和失败项的"下一步"恰恰是长任务里唯一的反馈。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyPageProgress } from '../src/format.js';

test('verify 进度：带页码与分数', () => {
  const text = verifyPageProgress({ page: 'checkout', index: 3, total: 41, overall: 0.872, measured: true,
    minViewport: { name: '375x812', score: 0.71 } });
  assert.match(text, /^体检 3\/41 checkout/);
  assert.match(text, /87\.2%/);
  assert.match(text, /最低 375x812 71\.0%/);
});

test('verify 进度：未测到时不说成分数', () => {
  const text = verifyPageProgress({ page: 'a', overall: null, measured: false });
  assert.match(text, /未测到/);
  assert.ok(!/%/.test(text), text);
});

test('verify 进度：还剩多久按本次会话速度估算', () => {
  const startedAt = Date.now() - 60_000;   // 已跑 1 分钟
  const text = verifyPageProgress({ page: 'a', index: 2, total: 12, overall: 0.9, measured: true }, { startedAt });
  assert.match(text, /还剩约 \d+ 分钟/, text);
});

test('verify 进度：复用的页不参与耗时估算（否则 ETA 会塌成 1 秒）', () => {
  const startedAt = Date.now() - 60_000;
  const text = verifyPageProgress({ page: 'a', index: 2, total: 12, overall: 0.9, measured: true, reused: true }, { startedAt });
  assert.ok(!/还剩约/.test(text), text);
});

test('verify 进度：最后一页不再显示剩余时间', () => {
  const text = verifyPageProgress({ page: 'a', index: 12, total: 12, overall: 0.9, measured: true }, { startedAt: Date.now() - 60_000 });
  assert.ok(!/还剩约/.test(text), text);
  assert.match(text, /体检 12\/12/);
});
