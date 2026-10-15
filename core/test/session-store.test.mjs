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
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const DATA = mkdtempSync(join(tmpdir(), 'heimdall-session-'));
process.env.HEIMDALL_DATA_DIR = DATA;
const { captureSessionState, restoreSessionStorage, saveSession, loadSession, sessionContext, sessionInfo, clearSession, hostKey, sessionPath } = await import('../src/session/store.mjs');

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

test('命名会话与默认会话互不覆盖，且非法名字直接拒绝', () => {
  const anonymous = { cookies: [{ name: 'anon', value: 'a', domain: 'named.test' }], origins: [] };
  const admin = { cookies: [{ name: 'admin', value: 'secret-admin-cookie', domain: 'named.test' }], origins: [] };
  saveSession('named.test', anonymous);
  saveSession('named.test', admin, 'admin');
  assert.equal(sessionPath('named.test'), join(DATA, 'workspace', 'named.test', 'session.json'));
  assert.equal(sessionPath('named.test', 'admin'), join(DATA, 'workspace', 'named.test', 'session.admin.json'));
  assert.equal(loadSession('named.test').cookies[0].name, 'anon');
  assert.equal(loadSession('named.test', 'admin').cookies[0].name, 'admin');
  assert.equal(sessionInfo('named.test', 'admin').cookies, 1);
  assert.equal(clearSession('named.test', 'admin').exists, false);
  assert.equal(loadSession('named.test', 'admin'), undefined);
  assert.equal(loadSession('named.test').cookies[0].name, 'anon', '清掉命名会话不能碰默认会话');
  assert.throws(() => sessionPath('named.test', '../escape'), /invalid session name/);
});

test('扩展会话字段只用于初始化脚本，不能传入 Playwright storageState', async () => {
  const state = {
    cookies: [], origins: [],
    sessionStorage: [{ origin: 'https://private.test', entries: [{ name: 'token', value: 'secret' }] }],
  };
  saveSession('private.test', state);
  assert.deepEqual(loadSession('private.test'), state);
  assert.deepEqual(sessionContext('private.test'), { storageState: { cookies: [], origins: [] } });
  assert.equal(sessionInfo('private.test').sessionStorageOrigins, 1);
  const calls = [];
  assert.equal(await restoreSessionStorage({ addInitScript: async (...args) => calls.push(args) }, 'private.test'), true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { 'https://private.test': [{ name: 'token', value: 'secret' }] });
  assert.equal(await restoreSessionStorage({ addInitScript: async () => assert.fail('legacy state needs no script') }, 'example.com'), false);
});

test('新 context 恢复 sessionStorage 与 IndexedDB，且只恢复保存的 origin', async t => {
  let browser;
  try { browser = await chromium.launch(); }
  catch (error) { t.skip(`Chromium unavailable: ${String(error).slice(0, 100)}`); return; }
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>session fixture</title>'); });
  const other = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>other origin</title>'); });
  try {
    await Promise.all([server, other].map(s => new Promise(resolve => s.listen(0, '127.0.0.1', resolve))));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const otherOrigin = `http://127.0.0.1:${other.address().port}`;
    const host = '127.0.0.1';
    const first = await browser.newContext();
    const page = await first.newPage();
    await page.goto(origin);
    await page.evaluate(async () => {
      sessionStorage.setItem('session-token', 'session-value');
      await new Promise((resolve, reject) => {
        const open = indexedDB.open('heimdall-auth', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('tokens');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('tokens', 'readwrite');
          tx.objectStore('tokens').put('idb-value', 'idb-token');
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        };
      });
    });
    const state = await captureSessionState(first);
    assert.equal(state.sessionStorage[0].origin, origin);
    assert.ok(state.origins[0].indexedDB?.length, 'IndexedDB must be present in Playwright storageState');
    await page.close();
    const afterClose = await captureSessionState(first, state);
    assert.deepEqual(afterClose.sessionStorage, state.sessionStorage, 'closing the login tab must retain its last sessionStorage snapshot');
    saveSession(host, state);
    await first.close();

    const second = await browser.newContext(sessionContext(host));
    await restoreSessionStorage(second, host);
    const restored = await second.newPage();
    await restored.goto(origin);
    assert.equal(await restored.evaluate(() => sessionStorage.getItem('session-token')), 'session-value');
    assert.equal(await restored.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('heimdall-auth');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction('tokens', 'readonly');
        const get = tx.objectStore('tokens').get('idb-token');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      };
    })), 'idb-value');
    await restored.goto(otherOrigin);
    assert.equal(await restored.evaluate(() => sessionStorage.getItem('session-token')), null);
    await second.close();
  } finally {
    await browser.close();
    await Promise.all([server, other].map(s => new Promise(resolve => s.close(resolve))));
  }
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
