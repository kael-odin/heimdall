/**
 * 路径归属与敏感文件判断
 *
 * 这两条来自一次引擎审计，都是**会真出事的**：
 *   · `/api/reveal` 用字符串前缀判"在不在数据目录里"，于是 `DATA_ROOT\..\..\任意路径` 能过
 *   · `/static/**` 会把 workspace 里的任意文件原样发出去 —— 包括
 *     `session.json`（登录凭据）与 `network.har`（未脱敏的原始抓包）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInside, isSecretFile } from '../src/paths.mjs';

const ROOT = process.platform === 'win32' ? 'D:\\data' : '/data';
const child = (...p) => [ROOT, ...p].join(process.platform === 'win32' ? '\\' : '/');

test('isInside：子路径、父子孙路径都算在内', () => {
  assert.equal(isInside(ROOT, child('workspace')), true);
  assert.equal(isInside(ROOT, child('workspace', 'a.test', 'session.json')), true);
});

test('isInside：`..` 逃逸必须被拒（前缀判断会漏掉这一条）', () => {
  assert.equal(isInside(ROOT, child('..', '..', 'Windows')), false);
  assert.equal(isInside(ROOT, child('workspace', '..', '..', 'etc')), false);
  // 关键对照：这两个字符串**都是**以 ROOT 开头的，前缀检查会放行
  assert.ok(child('..', '..', 'Windows').startsWith(ROOT), '前提：前缀检查确实会放行它');
});

test('isInside：同前缀的兄弟目录不算在内（/data 与 /database）', () => {
  assert.equal(isInside(ROOT, ROOT + 'base'), false);
});

test('isInside：根目录自身不算"在里面"（调用方要的是一个具体产物）', () => {
  assert.equal(isInside(ROOT, ROOT), false);
});

test('isSecretFile：登录凭据与原始抓包一律不外发', () => {
  assert.equal(isSecretFile(child('a.test', 'session.json')), true);
  assert.equal(isSecretFile('/static/a.test/session.json'), true);
  assert.equal(isSecretFile(child('a.test', 'pages', 'home', 'network.har')), true);
  assert.equal(isSecretFile(child('a.test', 'operation-plan.json')), true);
  assert.equal(isSecretFile('/static/a.test/operation-plan.json'), true);
  for (const backup of ['session.json.bak', 'network.har.bak', 'operation-plan.json.bak', '.operation-plan.json.swp', 'operation-plan.json~']) {
    assert.equal(isSecretFile(child('a.test', backup)), true, backup);
  }
});

test('isSecretFile：名字相近的正常产物不受影响（别把 har.json 也拦了）', () => {
  for (const ok of ['score.json', 'har.json', 'mysession.json', 'health.json']) {
    assert.equal(isSecretFile(child('a.test', ok)), false, `${ok} 不该被拦`);
  }
});
