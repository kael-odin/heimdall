/**
 * 登录态落盘
 *
 * 这个文件等同于"某站点的登录凭据"，所以三条性质必须有测试钉住：
 *   1. 不存在时不能炸 —— 绝大多数站点是公开的，没会话就是没会话
 *   2. 覆盖写必须原子 —— login 进程每 2 秒重写一次，读者不该看到半截 JSON
 *   3. 只落在 workspace/<host>/session.json，路径口径与引擎其余部分一致
 *
 * 测试用 HEIMDALL_DATA_DIR 指向临时目录（paths.mjs 支持），不碰真实 workspace。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA = mkdtempSync(join(tmpdir(), 'heimdall-session-'));
process.env.HEIMDALL_DATA_DIR = DATA;
const { saveSession, loadSession, sessionContext, sessionInfo, clearSession, hostKey, sessionPath } = await import('../src/session/store.mjs');

test('hostKey：去协议 / 去 www / 去路径 / 小写（与引擎其余部分同一口径）', () => {
  assert.equal(hostKey('https://WWW.Example.com/a/b?c=1'), 'example.com');
  assert.equal(hostKey('example.com'), 'example.com');
  assert.equal(hostKey('blog.example.com'), 'blog.example.com', '子域不能被当成 www 删掉');
});

test('没有会话时：loadSession 返回 undefined，sessionContext 返回空对象', () => {
  assert.equal(loadSession('nobody.test'), undefined);
  assert.deepEqual(sessionContext('nobody.test'), {}, '调用点不该为了它写 if');
  assert.equal(sessionInfo('nobody.test').exists, false);
});

test('存-读往返：cookie 与 origin 原样保留', () => {
  const state = {
    cookies: [{ name: 'sid', value: 'x', domain: '.example.com', path: '/' }],
    origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'y' }] }],
  };
  const info = saveSession('example.com', state);
  assert.equal(info.exists, true);
  assert.equal(info.cookies, 1);
  assert.deepEqual(info.origins, ['https://example.com']);
  assert.equal(info.sameSite, 1, '本域名下的 cookie 数要单独报 —— 那才是"真的登进去了"的证据');
  assert.deepEqual(loadSession('example.com'), state);
  assert.deepEqual(sessionContext('example.com'), { storageState: state });
});

test('子域 cookie 也算本站的（很多站点用 .example.com 下发）', () => {
  saveSession('shop.example.com', { cookies: [{ name: 'a', value: '1', domain: '.example.com' }], origins: [] });
  assert.equal(sessionInfo('shop.example.com').sameSite, 1);
});

test('坏文件不炸：JSON 截断时当成没有会话', () => {
  saveSession('broken.test', { cookies: [], origins: [] });
  writeFileSync(sessionPath('broken.test'), '{"cookies":[{"na');
  assert.equal(loadSession('broken.test'), undefined);
});

test('空壳不算会话（没有 cookies 也没有 origins）', () => {
  saveSession('empty.test', {});
  assert.equal(loadSession('empty.test'), undefined);
});

test('覆盖写是原子的：目录里不留 .tmp，新内容完整可读', () => {
  saveSession('swap.test', { cookies: [{ name: 'a', value: '1', domain: 'swap.test' }], origins: [] });
  saveSession('swap.test', { cookies: [{ name: 'a', value: '2', domain: 'swap.test' }], origins: [] });
  assert.equal(loadSession('swap.test').cookies[0].value, '2');
  const files = readdirSync(join(DATA, 'workspace', 'swap.test'));
  assert.deepEqual(files.filter(f => f.endsWith('.tmp')), [], '临时文件必须被 rename 掉');
  assert.ok(readFileSync(sessionPath('swap.test'), 'utf8').trim().endsWith('}'), '不会读到半截 JSON');
});

test('clearSession：删掉之后就当没有会话（退出登录/换账号用）', () => {
  saveSession('bye.test', { cookies: [{ name: 'a', value: '1', domain: 'bye.test' }], origins: [] });
  assert.equal(sessionInfo('bye.test').exists, true);
  assert.equal(clearSession('bye.test').exists, false);
  assert.equal(loadSession('bye.test'), undefined);
});

test.after(() => rmSync(DATA, { recursive: true, force: true }));
