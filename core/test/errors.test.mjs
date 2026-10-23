/**
 * errors — 只钉一件事：用户看到的必须是"人话 + 下一步"，原始技术细节原样保留。
 *
 * 这里不测文案措辞（文案会改），只测分类与"细节不丢"这两条契约：
 * 分类错了用户会被指向错误的下一步操作，细节丢了排障就只能靠猜。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainError } from '../src/errors.mjs';

test('errors: 连不上引擎 → 指向检查 /api/status', () => {
  for (const raw of ['fetch failed', 'connect ECONNREFUSED 127.0.0.1:8900', 'Failed to fetch']) {
    const e = explainError(new Error(raw));
    assert.equal(e.kind, 'engine-down', raw);
    assert.match(e.hint, /api\/status/);
    assert.ok(e.detail.includes(raw.split(' ')[0]), '原始信息必须保留在 detail 里');
  }
});

test('errors: 鉴权 / 忙 / 超时 / 缺文件 / 缺浏览器 各有独立出路', () => {
  assert.equal(explainError({ status: 401, error: 'unauthorized' }).kind, 'auth');
  assert.equal(explainError({ status: 409, error: 'busy' }).kind, 'busy');
  assert.equal(explainError(new Error('page.goto: Timeout 30000ms exceeded')).kind, 'timeout');
  assert.equal(explainError(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })).kind, 'not-found');
  assert.equal(explainError(new Error("Executable doesn't exist at ...")).kind, 'browser');
});

test('errors: 未知错误也给一句可执行的话，且不丢细节', () => {
  const e = explainError({ error: 'weird server failure', code: 'E_Q_UNIQUE' });
  assert.equal(e.kind, 'unknown');
  assert.ok(e.hint.length > 10);
  assert.match(e.detail, /E_Q_UNIQUE/);
  assert.match(e.detail, /weird server failure/);
});

test('errors: 字符串 / null / 后端错误对象都能吃', () => {
  assert.equal(explainError('plain text failure').detail, 'plain text failure');
  assert.equal(explainError(null).kind, 'unknown');
  assert.equal(explainError({ status: 404 }).kind, 'not-found');
});
