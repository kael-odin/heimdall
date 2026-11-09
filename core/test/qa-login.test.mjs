import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { chromium } from 'playwright';
import { login } from '../src/agent/commands/qa.mjs';
import { parseArgs } from '../src/agent/parse-args.mjs';

async function fixture(fn) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-login-'));
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path === '/broken') return req.socket.destroy();
    if (path === '/unavailable') { res.writeHead(503); return res.end('Unavailable'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Local login fixture</title><input id="user">');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const configDir = join(root, '.heimdall');
  const file = join(configDir, 'logins', 'session.json');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'qa.json'), JSON.stringify({
    schema: 'heimdall.qa/1',
    sites: { local: { url: origin, login: 'user', loginPath: '/login' } },
    logins: { user: { kind: 'storageState', file: '.heimdall/logins/session.json', origin } },
  }));
  const browsers = [];
  const state = { stdout: '', stderr: '', launches: 0, browsers };
  const input = new PassThrough();
  const io = {
    stdin: input,
    stdout: { write: value => { state.stdout += value; } },
    stderr: { write: value => { state.stderr += value; } },
    chromium: { launch: async options => {
      assert.equal(options.headless, false);
      state.launches++;
      const browser = await chromium.launch({ headless: true });
      browsers.push(browser);
      return browser;
    } },
  };
  try { await fn({ root, file, origin, io, state, input }); }
  finally {
    input.destroy();
    for (const browser of browsers) await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

function existing(file, origin) {
  mkdirSync(join(file, '..'), { recursive: true });
  const bytes = JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: 'old', value: 'old-fixture-value' }] }] });
  writeFileSync(file, bytes);
  return bytes;
}

async function waitForPrompt(state) {
  const deadline = Date.now() + 10000;
  while (!state.stdout.includes('回到终端') && !state.stdout.includes('输入 REPLACE')) {
    if (Date.now() >= deadline) throw new Error(`login prompt missing: ${state.stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('qa login: remote HTTP requires explicit opt-in before opening a browser', async () => fixture(async ({ root, io, state }) => {
  const secret = 'fixture-private-query-value';
  const url = `http://example.invalid/login?token=${secret}`;
  assert.equal(await login('user', { workspace: root, url }, io), 2);
  assert.equal(state.launches, 0);
  assert.match(state.stderr, /未加密的 HTTP/);
  assert.doesNotMatch(state.stdout + state.stderr, new RegExp(secret));
  assert.equal(parseArgs(['login', 'user', '--allow-insecure-http', '--workspace', root]).flags['allow-insecure-http'], true);
  io.chromium = { launch: async () => { state.launches++; throw new Error('fixture stopped before navigation'); } };
  await assert.rejects(login('user', { workspace: root, url, 'allow-insecure-http': true }, io), /fixture stopped/);
  assert.equal(state.launches, 1);
  assert.doesNotMatch(state.stdout + state.stderr, new RegExp(secret));
}));

test('qa login: malformed and credential-bearing URLs fail before browser launch', async () => fixture(async ({ root, io, state }) => {
  for (const url of ['file:///fixture', 'https://fixture-user:fixture-pass@example.invalid/', 'not a URL']) {
    assert.equal(await login('user', { workspace: root, url }, io), 2);
  }
  assert.equal(state.launches, 0);
  assert.doesNotMatch(state.stderr, /fixture-pass/);
}));

test('qa login: a directory cannot be replaced as a login state file', async () => fixture(async ({ root, file, io, state }) => {
  mkdirSync(file, { recursive: true });
  await assert.rejects(login('user', { workspace: root }, io), /不是普通文件/);
  assert.equal(state.launches, 0);
  assert.equal(statSync(file).isDirectory(), true);
}));

test('qa login: failed navigation and HTTP errors keep the old state', { timeout: 30000 }, async () => {
  for (const path of ['/broken', '/unavailable']) await fixture(async ({ root, file, origin, io, state }) => {
    const before = existing(file, origin);
    assert.equal(await login('user', { workspace: root, url: origin + path + '?token=fixture-private-query' }, io), 3);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(state.browsers[0].isConnected(), false);
    assert.doesNotMatch(state.stdout, /已保存/);
    assert.doesNotMatch(state.stdout + state.stderr, /fixture-private-query/);
    assert.deepEqual(readdirSync(join(file, '..')), ['session.json']);
  });
});

test('qa login: EOF, cancellation, and a closed page cannot replace the old state', { timeout: 30000 }, async () => {
  for (const action of ['eof', 'cancel', 'close']) await fixture(async ({ root, file, origin, io, state, input }) => {
    const before = existing(file, origin);
    const task = login('user', { workspace: root }, io);
    await waitForPrompt(state);
    if (action === 'eof') input.end();
    if (action === 'cancel') input.write('\n');
    if (action === 'close') await state.browsers[0].contexts()[0].pages()[0].close();
    assert.equal(await task, 2);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(state.browsers[0].isConnected(), false);
    assert.deepEqual(readdirSync(join(file, '..')), ['session.json']);
  });
});

test('qa login: a state changed during confirmation is not overwritten', { timeout: 30000 }, async () => fixture(async ({ root, file, origin, io, state, input }) => {
  existing(file, origin);
  const task = login('user', { workspace: root }, io);
  await waitForPrompt(state);
  const changed = JSON.stringify({ cookies: [], origins: [] });
  writeFileSync(file, changed);
  input.write('REPLACE\n');
  assert.equal(await task, 3);
  assert.equal(readFileSync(file, 'utf8'), changed);
  assert.match(state.stderr, /已变化/);
  assert.deepEqual(readdirSync(join(file, '..')), ['session.json']);
}));

test('qa login: an insecure page reached after opening is not saved by default', { timeout: 30000 }, async () => fixture(async ({ root, file, origin, io, state, input }) => {
  const before = existing(file, origin);
  const task = login('user', { workspace: root }, io);
  await waitForPrompt(state);
  const page = state.browsers[0].contexts()[0].pages()[0];
  await page.route('http://insecure.example/**', route => route.fulfill({ status: 200, body: '<title>Local route fixture</title>' }));
  await page.goto('http://insecure.example/login');
  input.write('REPLACE\n');
  assert.equal(await task, 3);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.match(state.stderr, /请求可能已经发出/);
}));

test('qa login: an insecure popup also prevents saving', { timeout: 30000 }, async () => fixture(async ({ root, file, origin, io, state, input }) => {
  const before = existing(file, origin);
  const task = login('user', { workspace: root }, io);
  await waitForPrompt(state);
  const context = state.browsers[0].contexts()[0];
  const popup = await context.newPage();
  await popup.route('http://insecure.example/**', route => route.fulfill({ status: 200, body: '<title>Local popup fixture</title>' }));
  await popup.goto('http://insecure.example/login');
  input.write('REPLACE\n');
  assert.equal(await task, 3);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.match(state.stderr, /请求可能已经发出/);
}));

test('qa login: a remaining secure or loopback popup can complete login after the first page closes', { timeout: 30000 }, async () => fixture(async ({ root, file, origin, io, state, input }) => {
  existing(file, origin);
  const task = login('user', { workspace: root }, io);
  await waitForPrompt(state);
  const context = state.browsers[0].contexts()[0];
  const main = context.pages()[0];
  const popup = await context.newPage();
  await popup.goto(origin + '/popup');
  await popup.evaluate(() => localStorage.setItem('popup', 'popup-fixture-state'));
  await main.close();
  input.write('REPLACE\n');
  assert.equal(await task, 0);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.origins.some(item => item.origin === origin && item.localStorage.some(entry => entry.value === 'popup-fixture-state')));
}));

test('qa login: explicit HTTP opt-in works in an intercepted local browser fixture', { timeout: 30000 }, async () => fixture(async ({ root, file, io, state, input }) => {
  const launch = io.chromium.launch;
  io.chromium.launch = async options => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async contextOptions => {
      const context = await newContext(contextOptions);
      await context.route('http://insecure.example/**', route => route.fulfill({ status: 200, body: '<title>Local route fixture</title>' }));
      return context;
    };
    return browser;
  };
  const task = login('user', { workspace: root, url: 'http://insecure.example/login', 'allow-insecure-http': true }, io);
  await waitForPrompt(state);
  const page = state.browsers[0].contexts()[0].pages()[0];
  await page.evaluate(() => localStorage.setItem('fixture', 'value'));
  input.write('\n');
  assert.equal(await task, 0);
  assert.match(state.stderr, /HTTP 不加密/);
  assert.ok(JSON.parse(readFileSync(file, 'utf8')).origins.some(entry => entry.origin === 'http://insecure.example'));
}));

test('qa login: a colliding temporary filename is never removed or overwritten', { timeout: 30000 }, async () => {
  for (const hasExisting of [false, true]) await fixture(async ({ root, file, origin, io, state, input }) => {
    mkdirSync(join(file, '..'), { recursive: true });
    const before = hasExisting ? existing(file, origin) : null;
    const collision = join(file, '..', '.session.json.fixture-collision.tmp');
    writeFileSync(collision, 'unrelated fixture file');
    io.randomUUID = () => 'fixture-collision';
    const task = login('user', { workspace: root }, io);
    await waitForPrompt(state);
    input.write(hasExisting ? 'REPLACE\n' : '\n');
    await assert.rejects(task, error => error.code === 'EEXIST');
    assert.equal(readFileSync(collision, 'utf8'), 'unrelated fixture file');
    if (hasExisting) assert.equal(readFileSync(file, 'utf8'), before);
    assert.deepEqual(readdirSync(join(file, '..')).sort(), hasExisting ? ['.session.json.fixture-collision.tmp', 'session.json'] : ['.session.json.fixture-collision.tmp']);
  });
});

test('qa login: confirmed replacement saves browser state without printing its values', { timeout: 30000 }, async () => fixture(async ({ root, file, origin, io, state, input }) => {
  existing(file, origin);
  const task = login('user', { workspace: root }, io);
  await waitForPrompt(state);
  const page = state.browsers[0].contexts()[0].pages()[0];
  assert.equal(await page.evaluate(() => localStorage.getItem('old')), null);
  await page.evaluate(() => localStorage.setItem('new', 'new-fixture-secret'));
  input.write('REPLACE\n');
  assert.equal(await task, 0);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.origins.some(item => item.origin === origin && item.localStorage.some(entry => entry.name === 'new' && entry.value === 'new-fixture-secret')));
  assert.doesNotMatch(state.stdout + state.stderr, /new-fixture-secret|old-fixture-value/);
  assert.match(state.stdout, /业务权限需要另行验证/);
  assert.deepEqual(readdirSync(join(file, '..')), ['session.json']);
}));

test('qa login: a new profile can be created after explicit confirmation', { timeout: 30000 }, async () => fixture(async ({ root, file, origin, io, state, input }) => {
  const task = login('user', { workspace: root }, io);
  await waitForPrompt(state);
  const page = state.browsers[0].contexts()[0].pages()[0];
  await page.evaluate(() => localStorage.setItem('new', 'fresh-fixture-state'));
  input.write('\n');
  assert.equal(await task, 0);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(saved.origins.some(item => item.origin === origin && item.localStorage.some(entry => entry.value === 'fresh-fixture-state')));
  assert.deepEqual(readdirSync(join(file, '..')), ['session.json']);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
}));
