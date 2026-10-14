/**
 * 控制台 E2E —— 唯一一块此前没有任何自动化覆盖的地方
 *
 * core 有 380+ 条单测，控制台一条都没有：改界面只能靠手工点验，
 * 而这一轮里控制台恰恰是改动最重的部分（对话框焦点、标签页方向键、排序表头、
 * 改站起点卡片、首启向导）。手工点验的问题不是不准，是**下次不会重跑**。
 *
 * 这个测试起一个真的引擎（临时数据目录 + 一个最小 fixture 站点），
 * 用真的 Chromium 打开控制台，跑几条"改坏了立刻能发现"的断言。
 *
 * 需要 console/dist（`pnpm -C console build`）。没构建就跳过并说明原因 ——
 * 静默通过比没有测试更糟。
 *
 * **但"跳过"本身也有一个更隐蔽的版本，实际发生过**：CI 里 core 与 console 是两个
 * 独立的 job，互不共享产物，所以 core job 里 `console/dist` 永远不存在 ——
 * 这条守卫每次都被跳过，**在 CI 里等于不存在**。本地有 dist 所以一直是绿的，
 * 一如既往地看不出来。所以现在：CI 里缺 dist 直接**失败**并说清该怎么办，
 * 只有本地手工跑才允许跳过。（配套：ci.yml 的 core job 先构建控制台。）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(CORE, '..', 'console', 'dist');

/**
 * 先问操作系统要一个真的空闲端口，再起引擎。
 *
 * 原来是在 8960–8980 里随机取 —— 串行跑两次 E2E 时（先单跑一遍、再跑全量），
 * 上一次的引擎可能还没放开端口，撞上就整个测试挂掉。**偶发失败是一种会撒谎的自检**：
 * 它既不指向真实缺陷，又教人习惯性重试。端口冲突是这条测试唯一一类"与本功能无关"
 * 的失败，那就把它从源头去掉。
 */
const freePort = () => new Promise((resolve) => {
  const srv = createServer();
  srv.on('error', () => resolve(null));
  srv.listen(0, '127.0.0.1', () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});

const PORT = (await freePort()) ?? 8960 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_TOKEN = process.env.HEIMDALL_E2E_TOKEN ?? '';
const CDP_URL = process.env.HEIMDALL_E2E_CDP_URL ?? '';
const EVIDENCE_DIR = process.env.HEIMDALL_E2E_EVIDENCE_DIR ?? '';
const API_HOST = process.env.HEIMDALL_E2E_API_HOST ?? '';
const SEPARATE_CONSOLE = process.env.HEIMDALL_E2E_SEPARATE_CONSOLE === '1';
const CONSOLE_PORT = SEPARATE_CONSOLE ? await freePort() : PORT;
const CONSOLE_BASE = `http://127.0.0.1:${CONSOLE_PORT}`;
const API_BASE = API_HOST ? `http://${API_HOST}:${PORT}` : BASE;
const STATIC_BRIDGE = !!API_HOST || SEPARATE_CONSOLE;

/**
 * 夹具里必须有 fixup-history.json，而且 `rounds` 要是空的 —— 这不是随手加的装饰。
 *
 * 克隆 tab 的「AI 校准」块是 `v-if rounds?.length ... v-else 未运行`，而详情面板
 * 四个标签页是 v-show（全都在渲染），所以**点开任意一个已克隆页面**都会走到那个 v-else。
 * 它一度读的是 `detailQuality.fixup.detail`，而那份数据只有切到「质检」标签才会加载
 * → `null.detail` 抛在 patch 阶段（画面留着上一帧、看着正常，实际那次更新整个被中止）。
 * 语料里 290 页有 285 页带这个文件，所以这是一条"人人会踩、但只会看到面板不动"的坑。
 * 夹具没有这个文件时整块 `v-if` 直接不成立，测试全绿 —— 骗过了上一轮。
 */
const FIXUP_DETAIL = '夹具校准结论：这一行必须出现在克隆 tab';

/** 一个最小站点：2 页克隆 + atlas + 一份改站清单所需的产物 */
function writeFixture(dataRoot) {
  const ws = join(dataRoot, 'workspace', 'fixture.test');
  const put = (p, body) => { mkdirSync(join(ws, dirname(p)), { recursive: true }); writeFileSync(join(ws, p), body); };
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  const image = PNG.sync.write(png);
  const pages = [{ name: 'home', path: '/' }, { name: 'docs', path: '/docs' }];
  for (const { name, path } of pages) {
    put(`pages/${name}/clone/index.html`, `<html><head><link rel="canonical" href="https://fixture.test${path}"></head><body><h1>${name}</h1></body></html>`);
    put(`pages/${name}/clone/assets/image000.png`, image);
    put(`pages/${name}/shot-src.png`, image);
    put(`pages/${name}/shot-clone.png`, image);
    put(`pages/${name}/manifest.json`, JSON.stringify({ target: `https://fixture.test${path}` }));
    put(`pages/${name}/score.json`, JSON.stringify({ total: 98, pixel: 0.98, grade: 'A' }));
    const viewport = { name: 'mobile', width: 375, score: name === 'home' ? 0.9 : 1, grade: 'B', coverageRatio: 0.9,
      sourceSize: { width: 375, height: 1000 }, cloneSize: { width: 375, height: 900 }, heightDelta: 100, missingPixels: 37_500 };
    put(`verify/${name}/verify.json`, JSON.stringify({ scoreVersion: 2, overall: viewport.score, measured: name === 'home',
      grade: 'B', minViewport: viewport, viewports: [viewport] }));
    // rounds 故意留空：这就是把「AI 校准」块推进 v-else 分支的真实形状（见 FIXUP_DETAIL 注释）
    put(`pages/${name}/fixup-history.json`, JSON.stringify({ at: '2026-10-13T00:00:00.000Z', rounds: [], skipped: 'noise', detail: FIXUP_DETAIL }));
    put(`pages/${name}/intel/intel.json`, JSON.stringify({ meta: { title: name + ' 标题' }, headings: [{ level: 'h1', text: name }], cta: ['开始'], prices: [] }));
  }
  put('live/index.html', '<html><body><h1 id="spa-result"></h1><script>document.querySelector("#spa-result").textContent = location.pathname === "/" ? "fixture live home" : "fixture SPA 404"</script></body></html>');
  put('live/docs/index.html', '<html><body><h1 id="spa-result"></h1><script>document.querySelector("#spa-result").textContent = location.pathname === "/docs/" ? "fixture live docs" : "fixture SPA 404"</script></body></html>');
  put('intel/fixture.test-intel.xlsx', Buffer.from('fixture download bytes')); // 仅验证受保护文件的浏览器下载路径
  put('pages/home/asset-map.json', JSON.stringify({ imgMap: { 'https://cdns.fixture.test/logo.png': 'assets/image000.png' } }));
  put('recon/atlas.json', JSON.stringify({
    origin: 'https://fixture.test', status: 'ok', failures: [], generatedAt: new Date().toISOString(),
    meta: { pages: 4, edges: 1 },
    nodes: [
      { id: 'n11111111', url: 'https://fixture.test/', path: '/', title: '首页', type: 'marketing', depth: 0 },
      { id: 'n22222222', url: 'https://fixture.test/docs', path: '/docs', title: '文档', type: 'docs', depth: 1 },
      { id: 'n33333333', url: 'https://fixture.test/list?page=1', path: '/list', title: '列表第一页', type: 'generic', depth: 1 },
      { id: 'n44444444', url: 'https://fixture.test/list?page=2', path: '/list', title: '列表第二页', type: 'generic', depth: 1 },
    ],
    edges: [{ from: 'n11111111', to: 'n22222222' }],
  }));
  put('deliver/edit-manifest.json', JSON.stringify({
    host: 'fixture.test', origin: 'https://fixture.test', hostname: 'fixture.test', generatedAt: new Date().toISOString(),
    counts: { pages: 2, assets: 1, remoteVisual: 0, copyPages: 2, domainFiles: 2, domainTotal: 4 },
    domain: { hostname: 'fixture.test', total: 4, files: [{ path: 'pages/home/clone/index.html', count: 2 }] },
    assets: [{ url: 'https://cdns.fixture.test/logo.png', local: 'assets/image000.png', ext: '.png', kind: '图片', size: 3, pages: ['home'], pageCount: 1 }],
    remote: [], copy: [],
  }));
  put('index.html', `<html><body><h1>fixture archive</h1><img src="pages/home/clone/assets/image000.png" alt="fixture asset"><script>
    fetch('/api/sites', { credentials: 'include' })
      .then(() => { window.__apiReadSucceeded = true; })
      .catch(() => { window.__apiReadBlocked = true; });
    fetch('/api/auth/logout', { method: 'POST', credentials: 'include', mode: 'no-cors',
      headers: { 'content-type': 'text/plain' }, body: 'logout' });
  </script></body></html>`);
  const other = join(dataRoot, 'workspace', 'e2e-target.test');
  mkdirSync(join(other, 'pages', 'home', 'clone'), { recursive: true });
  writeFileSync(join(other, 'pages', 'home', 'clone', 'index.html'), '<html><body><h1>other site</h1></body></html>');
  writeFileSync(join(other, 'pages', 'home', 'manifest.json'), JSON.stringify({ target: 'https://e2e-target.test/' }));
  writeFileSync(join(other, 'index.html'), '<html><body><h1>other archive</h1></body></html>');
  return ws;
}

const canRun = existsSync(DIST) && existsSync(join(DIST, 'index.html'));
/** CI 里 core 与 console 是两个 job，产物不互通 —— 缺 dist 就跳过 = 这条守卫在 CI 里不存在 */
const inCI = !!process.env.CI;

test('控制台 E2E：真引擎 + 真浏览器，跑一遍关键路径', {
  timeout: 180_000,
  skip: canRun || inCI ? false : 'console/dist 不存在，先运行 pnpm -C console build',
}, async (t) => {
  if (!canRun) {
    assert.fail('CI 里 console/dist 不存在 —— 跑测试前要先构建控制台（pnpm -C console build）。'
      + '这条守卫跳过就等于不存在，所以这里选择失败而不是跳过。');
  }
  const dataRoot = mkdtempSync(join(tmpdir(), 'heimdall-e2e-'));
  writeFixture(dataRoot);
  const consoleServer = SEPARATE_CONSOLE ? createHttpServer((req, res) => {
    const pathname = new URL(req.url, CONSOLE_BASE).pathname;
    const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    if (!/^(index\.html|assets\/[a-z0-9._-]+)$/i.test(file)) { res.writeHead(404); res.end(); return; }
    try {
      const contentType = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(readFileSync(join(DIST, file)));
    } catch { res.writeHead(404); res.end(); }
  }) : null;
  if (consoleServer) await new Promise(resolve => consoleServer.listen(CONSOLE_PORT, '127.0.0.1', resolve));

  const engine = spawn(process.execPath, [join(CORE, 'src', 'engine-server.mjs'), String(PORT)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: DIST,
      ...(TEST_TOKEN ? { HEIMDALL_TOKEN: TEST_TOKEN } : {}),
      ...(STATIC_BRIDGE ? { HEIMDALL_CORS_ORIGIN: CONSOLE_BASE } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  engine.stdout.on('data', (d) => { engineLog += d.toString(); });
  engine.stderr.on('data', (d) => { engineLog += d.toString(); });

  let browser;
  let page;
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  try {
    // 等引擎就绪（最多 30s）。预算放长一点：这条测试同时要起 sqlite、一个 HTTP 服务
    // 和一个 Chromium，机器上另有别的浏览器/引擎在跑时 20s 会不够 —— 而它报出来的
    // 只是"引擎未就绪"，看起来像产品坏了。
    const ready = await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (engineLog.includes('engine-server @')) { clearInterval(tick); resolve(true); }
        else if (Date.now() - t0 > 30_000) { clearInterval(tick); resolve(false); }
      }, 200);
    });
    assert.ok(ready, '引擎未在 30s 内就绪。日志：\n' + engineLog.slice(-800));

    browser = CDP_URL ? await chromium.connectOverCDP(CDP_URL) : await chromium.launch();
    page = await (CDP_URL ? (browser.contexts()[0] ?? await browser.newContext())
      : await browser.newContext()).newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    if (TEST_TOKEN) await page.addInitScript(({ token, api }) => {
      localStorage.setItem('heimdall-token', token);
      if (api) localStorage.setItem('heimdall-api', api);
    }, { token: TEST_TOKEN, api: STATIC_BRIDGE ? API_BASE : '' });
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('requestfailed', (r) => failedRequests.push(`${r.method()} ${r.url()} :: ${r.failure()?.errorText ?? 'failed'}`));

    // 无侦察数据的控制台应保持轻量，直到用户真的打开有节点的星图。
    const graphRequests = [];
    page.on('request', request => {
      if (/\/assets\/Graph3D-[^/]+\.js(?:\?|$)/.test(request.url())) graphRequests.push(request.url());
    });
    const emptySites = route => route.fulfill({ json: { sites: [] } });
    await page.route('**/api/sites', emptySites);
    await page.goto(CONSOLE_BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.getByText('还没有任何站点').waitFor();
    await page.waitForTimeout(200);
    assert.deepEqual(graphRequests, [], '空态不应下载 3D 运行时');
    await page.unroute('**/api/sites', emptySites);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hud', { timeout: 20_000 });

    // ① 星图有可访问名（canvas 本身进不去，靠 role=img 说明）
    const mapLabel = await page.locator('.g3d').first().getAttribute('aria-label');
    assert.match(mapLabel ?? '', /站点星图/, '星图应带 role=img 的可读说明');

    // ② 站点清单里有 fixture 站（说明 /api/sites 与静态产物通了）
    const options = await page.locator('.sb-select option').allInnerTexts();
    assert.ok(options.some(o => o.includes('fixture.test')), '站点下拉应包含 fixture.test，实际：' + options.join(' / '));
    if (TEST_TOKEN) {
      const artifactStatus = await page.evaluate(async ({ api, token }) => {
        const response = await fetch(api + '/static/fixture.test/pages/home/manifest.json', {
          headers: { 'x-heimdall-token': token }, credentials: 'omit',
        });
        return response.status;
      }, { api: API_BASE, token: TEST_TOKEN });
      assert.equal(artifactStatus, 200, 'Token 初始化后应能从配置的引擎读取受保护的静态产物');
    }

    // ③ 页面视图：排序表头可键盘操作，回车后 aria-label 的方向随之翻转
    await page.getByRole('button', { name: '页面' }).click();
    await page.waitForSelector('.wv-th .c-path.sortable', { timeout: 15_000 });
    const scoreTitle = await page.locator('.wv-rows .wv-row:not(.wv-th) .wv-score').first().getAttribute('title');
    assert.match(scoreTitle ?? '', /多视口 v2.*覆盖 90\.0%.*原图 375×1000 \/ 镜像 375×900/,
      '清单需区分单页旧分数和多视口 v2，并给出覆盖率及尺寸');
    await page.waitForFunction(() => !document.querySelector('.wv-head .wv-stat')?.textContent?.includes('正在载入'));
    assert.match(await page.locator('.wv-head .wv-stat').first().innerText(), /完整测量 1 页最差视口均值 90\.0%/,
      '部分视口 100% 不能混入 v2 最差视口均值');
    const partialDocs = page.locator('.wv-rows .wv-row:not(.wv-th)')
      .filter({ has: page.locator('.c-path[role="button"]').filter({ hasText: /^\/docs$/ }) })
      .locator('.wv-score .partial');
    await partialDocs.waitFor({ state: 'visible', timeout: 10_000 });
    assert.equal(await page.locator('.wv-score .partial').count(), 1,
      '部分视口结果应在对应页面明确标为未完整测量');
    const queryLabels = await page.locator('.wv-rows .wv-row:not(.wv-th) .c-path').allInnerTexts();
    assert.ok(queryLabels.includes('/list?page=1') && queryLabels.includes('/list?page=2'),
      'query 页面在清单中必须有不同的主标签：' + queryLabels.join(', '));
    const th = page.locator('.wv-th .c-path.sortable');
    const before = await th.getAttribute('aria-label');
    await th.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const after = await th.getAttribute('aria-label');
    assert.notEqual(after, before, '回车应切换排序方向（aria-label 里的"升序/降序"要变）');

    // ④ 详情面板：对话框语义 + 打开即聚焦关闭按钮 + Esc 关闭
    await page.locator('.wv-rows .wv-row:not(.wv-th) .c-path[role="button"]')
      .filter({ hasText: /^\/$/ }).click();
    // 面板打不开时给出指向，别让下一个人从 "waiting for locator('.dock')" 猜起：
    // 实测过的失败形状就是渲染抛异常 → 组件挂载失败 → .dock 永远不出现（见 ④b）
    await page.waitForSelector('.dock', { timeout: 10_000 }).catch(() => {
      assert.fail('详情面板没能打开 —— 先看控制台有没有渲染期异常（历史事故：克隆 tab 的「AI 校准」块读错数据源，抛 null.detail，整块渲染被中止）');
    });
    assert.equal(await page.locator('.dock').getAttribute('role'), 'dialog');
    assert.equal(await page.locator('.dock').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('.dock [role="tablist"]').count(), 1, '标签页应有 tablist 语义');
    await page.locator('#tab-quality').click();
    await page.waitForFunction(() => document.querySelector('#panel-quality')?.textContent?.includes('缺失区域计入差异'));
    assert.match(await page.locator('#panel-quality').innerText(), /覆盖 90\.0%.*原图 375×1000 \/ 镜像 375×900/);

    // ④b 「克隆」tab 的校准结论必须真的渲染出来 —— 不能只断言"没抛异常"。
    //     那个块一度读错了数据源（detailQuality.fixup 只有切到「质检」标签才加载），
    //     于是点开任意已克隆页面都会在 patch 阶段抛 null.detail：画面留着上一帧、
    //     看着正常，那次更新却被整个中止（面板此后不再响应任何状态变化）。
    await page.locator('#tab-forge').click();
    await page.waitForTimeout(400);
    assert.ok((await page.locator('.dock').innerText()).includes(FIXUP_DETAIL),
      '克隆 tab 应渲染出 AI 校准结论 —— 缺了就是又读到了没加载的那份数据');

    // Token 模式先经主域短期票据，再进入子域根路径；SPA 应读到原站 pathname。
    await page.locator('#tab-overview').click();
    const liveLink = page.locator('.dock-quick a, .dock-quick button', { hasText: '交互镜像' }).first();
    const liveHref = await liveLink.getAttribute('href');
    if (TEST_TOKEN) {
      const crossOrigin = STATIC_BRIDGE;
      if (crossOrigin) assert.equal(await liveLink.evaluate(el => el.tagName), 'BUTTON', 'cross-origin launch needs an authenticated POST');
      else {
        assert.equal(new URL(liveHref).origin, BASE);
        assert.equal(new URL(liveHref).pathname, '/api/mirror-launch');
        assert.doesNotMatch(liveHref, /fixture-test-secret/);
      }
      if (EVIDENCE_DIR) {
        mkdirSync(EVIDENCE_DIR, { recursive: true });
        await page.screenshot({ path: join(EVIDENCE_DIR, crossOrigin ? (API_HOST ? 'token-cross-host-spa-control.png' : 'token-two-port-spa-control.png') : 'token-spa-control.png') });
      }
      const popupPromise = page.waitForEvent('popup');
      const issuedPromise = crossOrigin ? page.waitForResponse(r => r.url().endsWith('/api/mirror-ticket') && r.request().method() === 'POST') : null;
      await liveLink.click();
      const popup = await popupPromise;
      const issued = issuedPromise ? await issuedPromise : null;
      if (issued) {
        assert.equal(issued.status(), 200, 'cross-host ticket issuance must pass CORS and Token auth');
        assert.equal(issued.request().headers()['x-heimdall-token'], TEST_TOKEN);
      }
      const target = new URL(issued ? issued.request().postDataJSON().url : new URL(liveHref).searchParams.get('url'));
      await popup.waitForURL(url => url.hostname === 'fixture.test.localhost' && url.pathname === target.pathname, { timeout: 10_000 });
      await popup.waitForFunction(() => document.querySelector('#spa-result')?.textContent?.startsWith('fixture live'), null, { timeout: 10_000 });
      assert.equal(new URL(popup.url()).search, target.search, 'query must survive both redirects');
      assert.doesNotMatch(popup.url(), /ticket=|fixture-test-secret/, 'final browser URL must be clean');
      const spaResult = await popup.locator('h1').innerText();
      assert.match(spaResult, /fixture live (home|docs)/,
        'SPA must render its real route instead of its own 404 page');
      if (EVIDENCE_DIR) {
        const label = crossOrigin ? (API_HOST ? 'token-cross-host-spa' : 'token-two-port-spa') : 'token-spa';
        await popup.screenshot({ path: join(EVIDENCE_DIR, label + '-open.png') });
        writeFileSync(join(EVIDENCE_DIR, label + '.json'), JSON.stringify({
          passed: true, consoleOrigin: CONSOLE_BASE, apiOrigin: API_BASE,
          launchMethod: crossOrigin ? 'POST' : 'GET', issuedStatus: issued?.status() ?? 302,
          targetUrl: target.href, finalUrl: popup.url(), finalPathname: new URL(popup.url()).pathname,
          spaResult, ticketAbsentFromFinalUrl: !popup.url().includes('ticket='),
          tokenAbsentFromFinalUrl: !popup.url().includes(TEST_TOKEN),
        }, null, 2));
      }
      await popup.close();
    } else {
      const launch = new URL(liveHref);
      assert.equal(launch.origin, BASE);
      assert.equal(launch.pathname, '/api/mirror-launch');
      const target = new URL(launch.searchParams.get('url'));
      const popupPromise = page.waitForEvent('popup');
      await liveLink.click();
      const popup = await popupPromise;
      await popup.waitForURL(url => url.hostname === 'fixture.test.localhost' && url.pathname === target.pathname, { timeout: 10_000 });
      await popup.waitForFunction(() => document.querySelector('#spa-result')?.textContent?.startsWith('fixture live'), null, { timeout: 10_000 });
      assert.equal(new URL(popup.url()).search, target.search, 'query must survive the unauthenticated launch redirect');
      assert.match(await popup.locator('h1').innerText(), /fixture live (home|docs)/);
      await popup.close();
    }

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.dock').count(), 0, 'Esc 应关闭详情面板');

    // ⑤ 报告页：改站起点卡片读到了引擎产物
    await page.getByRole('button', { name: '报告' }).click();
    const card = page.locator('.report-card', { hasText: '改站起点' });
    await card.waitFor({ timeout: 10_000 });
    assert.match(await card.innerText(), /个资源/, '改站起点卡片应显示清单统计');
    // 品牌资产列表：换 logo 时的入口，必须能直接从清单定位到文件
    const assetRows = card.locator('.edit-list li');
    assert.ok(await assetRows.count() > 0, '改站起点应列出最该先换的品牌资产');
    assert.ok(await card.getByRole('button', { name: '定位' }).count() > 0, '本地化的资源应带「定位」按钮');
    const archive = page.locator('.report-shortcuts a', { hasText: '克隆档案' });
    const archiveHref = await archive.getAttribute('href');
    assert.equal(new URL(archiveHref).origin, TEST_TOKEN && STATIC_BRIDGE ? CONSOLE_BASE : API_BASE,
      '跨源 Token 的产物链接需先进入控制台同源跳转页');
    if (TEST_TOKEN && !STATIC_BRIDGE) {
      const nativeTab = await page.context().newPage();
      await nativeTab.goto(archiveHref, { waitUntil: 'domcontentloaded' });
      await nativeTab.waitForFunction(() => document.querySelector('img')?.naturalWidth === 2);
      assert.equal(await nativeTab.locator('h1').innerText(), 'fixture archive');
      assert.equal(await nativeTab.evaluate(() => window.origin), 'null',
        'same-origin token documents remain sandboxed');
      await nativeTab.close();
    }
    if (TEST_TOKEN && STATIC_BRIDGE) {
      const artifactLabel = API_HOST ? 'remote-artifact-cross-host' : 'remote-artifact-two-port';
      assert.equal(new URL(archiveHref).searchParams.get('artifact'), '/static/fixture.test/index.html');
      assert.doesNotMatch(archiveHref, /test-token|ticket=/, '链接不得暴露长期 Token 或一次性票据');
      await page.context().clearCookies();
      const directStatus = await page.evaluate(async url =>
        (await fetch(url, { credentials: 'omit' })).status,
      API_BASE + '/static/fixture.test/index.html');
      assert.equal(directStatus, 401, '跨源无会话的产物直链必须受保护');
      const issuedPromise = page.context().waitForEvent('response', { predicate: r =>
        r.url() === API_BASE + '/api/artifact-ticket' && r.request().method() === 'POST' });
      const forbiddenWritePromise = page.context().waitForEvent('response', { predicate: r =>
        r.url() === API_BASE + '/api/auth/logout' && r.request().method() === 'POST' });
      const popupPromise = page.waitForEvent('popup');
      await archive.click();
      const issued = await issuedPromise;
      assert.equal(issued.status(), 200, '跨源产物入口需成功领票');
      assert.equal(issued.request().headers()['x-heimdall-token'], TEST_TOKEN);
      assert.equal(issued.request().postDataJSON().path, '/static/fixture.test/index.html');
      const popup = await popupPromise;
      await popup.waitForURL(API_BASE + '/static/fixture.test/index.html', { timeout: 10_000 });
      assert.equal(await popup.locator('h1').innerText(), 'fixture archive');
      await popup.waitForFunction(() => document.querySelector('img')?.naturalWidth === 2);
      const forbiddenWrite = await forbiddenWritePromise;
      assert.equal(forbiddenWrite.status(), 403,
        'sandboxed artifact script must not write to the engine API');
      await popup.waitForFunction(() => window.__apiReadBlocked === true);
      assert.equal(await popup.evaluate(() => window.origin), 'null',
        'the artifact must keep an opaque origin after ticket exchange');
      assert.equal(await popup.evaluate(() => window.__apiReadSucceeded), undefined,
        'sandboxed artifact script must not read the engine API');
      assert.doesNotMatch(popup.url(), /ticket=|test-token/, '产物最终 URL 不能带票据或长期 Token');
      if (EVIDENCE_DIR) {
        await popup.screenshot({ path: join(EVIDENCE_DIR, artifactLabel + '-open.png') });
        writeFileSync(join(EVIDENCE_DIR, artifactLabel + '.json'), JSON.stringify({
          passed: true, consoleOrigin: CONSOLE_BASE, apiOrigin: API_BASE, issuedStatus: issued.status(),
          finalUrl: popup.url(), imageWidth: await popup.locator('img').evaluate(img => img.naturalWidth),
          opaqueOrigin: await popup.evaluate(() => window.origin), apiReadBlocked: true,
          apiWriteStatus: forbiddenWrite.status(),
        }, null, 2));
      }
      await popup.close();

      // 中键或右键「在新标签打开」只导航 href，不触发原页 click 处理器。
      await page.context().clearCookies();
      const nativeTab = await browser.newPage();
      await nativeTab.addInitScript(({ token, api }) => {
        localStorage.setItem('heimdall-token', token);
        localStorage.setItem('heimdall-api', api);
      }, { token: TEST_TOKEN, api: API_BASE });
      const nativeIssuedPromise = nativeTab.waitForResponse(r => r.url() === API_BASE + '/api/artifact-ticket'
        && r.request().method() === 'POST');
      await nativeTab.goto(archiveHref, { waitUntil: 'domcontentloaded' });
      const nativeIssued = await nativeIssuedPromise;
      assert.equal(nativeIssued.status(), 200, '直接加载 href 的新标签也应领到产物票据');
      assert.equal(nativeIssued.request().headers()['x-heimdall-token'], TEST_TOKEN);
      await nativeTab.waitForURL(API_BASE + '/static/fixture.test/index.html', { timeout: 10_000 });
      assert.equal(await nativeTab.locator('h1').innerText(), 'fixture archive');
      await nativeTab.waitForFunction(() => document.querySelector('img')?.naturalWidth === 2);
      assert.doesNotMatch(nativeTab.url(), /ticket=|test-token/, '原生新标签最终 URL 不得含票据或 Token');
      if (EVIDENCE_DIR) {
        writeFileSync(join(EVIDENCE_DIR, artifactLabel + '-native.json'), JSON.stringify({
          passed: true, method: 'direct new-tab navigation to href', bridgeUrl: archiveHref,
          issuedStatus: nativeIssued.status(), issuedPath: nativeIssued.request().postDataJSON().path,
          finalUrl: nativeTab.url(), imageWidth: await nativeTab.locator('img').evaluate(img => img.naturalWidth),
          tokenAbsentFromUrls: !archiveHref.includes(TEST_TOKEN) && !nativeTab.url().includes(TEST_TOKEN),
        }, null, 2));
      }
      await nativeTab.close();

      const excelLink = page.getByRole('link', { name: '下载 Excel' });
      const excelHref = await excelLink.getAttribute('href');
      assert.equal(new URL(excelHref).origin, CONSOLE_BASE);
      assert.equal(new URL(excelHref).searchParams.get('artifact'), '/static/fixture.test/intel/fixture.test-intel.xlsx');
      assert.equal(await excelLink.getAttribute('download'), null, '同源跳转页不能被 download 属性下载为 HTML');
      assert.equal(await excelLink.getAttribute('target'), '_blank', '下载时应保留控制台页面');
      const excelResponsePromise = page.context().waitForEvent('response', { predicate: r =>
        r.url() === API_BASE + '/static/fixture.test/intel/fixture.test-intel.xlsx' });
      const excelPopupPromise = page.waitForEvent('popup');
      const excelDownloadPromise = excelPopupPromise.then(p => p.waitForEvent('download', { timeout: 10_000 }));
      await excelLink.click();
      const excelPopup = await excelPopupPromise;
      const excelResponse = await excelResponsePromise;
      const excelDownload = await excelDownloadPromise;
      assert.equal(excelResponse.status(), 200, 'Excel 链接应经票据到达受保护的文件');
      assert.match(excelResponse.headers()['content-type'] ?? '', /application\/octet-stream/);
      assert.equal(excelDownload.suggestedFilename(), 'fixture.test-intel.xlsx', 'Chromium 应真正启动 Excel 下载');
      if (EVIDENCE_DIR) {
        writeFileSync(join(EVIDENCE_DIR, artifactLabel + '-excel.json'), JSON.stringify({
          passed: true, bridgeUrl: excelHref, fileUrl: excelResponse.url(),
          fileStatus: excelResponse.status(), contentType: excelResponse.headers()['content-type'],
          suggestedFilename: excelDownload.suggestedFilename(), consoleUrl: page.url(),
        }, null, 2));
      }
      await excelPopup.close();

      const thumbnail = page.locator('.asset-thumb').first();
      await thumbnail.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelector('.asset-thumb')?.naturalWidth === 2);
      assert.match(await thumbnail.getAttribute('src'), /^blob:/,
        '跨源 Token 缩略图应通过带请求头的 fetch 加载');
    }

    // ⑤b 「只克隆此页」必须**真的发出** POST /api/forge。
    //     这条守卫来自一个把主按钮整个弄哑的 bug：startForge 里已经算好了 url，
    //     却在 fetch 的 body 里写成了 `node.url` —— 而这正是 `node === null` 的那条路
    //     （首屏按钮与任务中心的「重新克隆」都走它），于是抛 TypeError、请求根本没发出去，
    //     用户只看到一句红字，还以为引擎忙。这里拦下请求本身（顺带不发真任务）。
    let forgeBody = null;
    await page.route('**/api/forge', async (route) => {
      forgeBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ taskId: 'e2e-stub', pageName: 'home' }) });
    });
    await page.getByRole('button', { name: '星图', exact: true }).click();
    // 故意带路径：这条守卫同时盯着两件事 —— 按钮真的发请求，以及**路径不被丢掉**。
    // 曾经的事故：归一器返回 origin，于是 `host/store` 被克隆成首页，不报错、只是做错事。
    await page.fill('input[aria-label="目标站点域名"]', 'e2e-target.test/guides/start');
    await page.getByRole('button', { name: '只克隆此页' }).click();
    await page.waitForTimeout(800);
    assert.ok(forgeBody, '「只克隆此页」必须发出 POST /api/forge —— 没发出就是按钮哑了');
    assert.equal(forgeBody.url, 'https://e2e-target.test/guides/start', '请求体里要带上完整的目标 URL（含路径）');
    await page.unroute('**/api/forge');

    // ⑤c 跨站单页克隆后，页面清单必须立即切到新站上下文；旧站行不能带着新站 host 执行删除。
    // 新站单页克隆会直接打开该站页面清单。
    await page.waitForFunction(() => document.querySelector('.work-view .wv-stat')?.textContent?.includes('1/1'), null, { timeout: 10_000 });
    assert.match(await page.locator('.work-view .wv-head').innerText(), /e2e-target\.test/);
    assert.equal(await page.locator('.wv-rows .wv-row:not(.wv-th)').count(), 1, '新站只应出现自己的首页');
    assert.doesNotMatch(await page.locator('.wv-rows').innerText(), /fixture\.test/, '旧站页面不能留在新站清单');
    const deleteButton = page.locator('.wv-rows .wv-actions button.danger');
    assert.equal(await deleteButton.count(), 1);

    // ⑤d 手机页面操作与报告入口保留足够触控尺寸，报告链接无需长滚动寻找。
    await page.setViewportSize({ width: 390, height: 844 });
    const actionRect = await deleteButton.boundingBox();
    assert.ok(actionRect?.height >= 44, '手机页面操作按钮至少 44 CSS px 高');
    await page.getByRole('button', { name: '报告', exact: true }).click();
    const shortcut = page.locator('.report-shortcuts a', { hasText: '克隆档案' });
    await shortcut.waitFor({ timeout: 10_000 });
    const shortcutRect = await shortcut.boundingBox();
    assert.ok(shortcutRect?.height >= 44 && shortcutRect.y < 350, '报告主入口应在手机首屏且易触达');

    if (TEST_TOKEN) {
      // 侦察链路单独模拟长任务，核对浏览器对 SSE 与最终 atlas 的鉴权请求。
      let eventUrl = '', atlasToken = '';
      await page.route('**/api/recon', route => route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ taskId: 'e2e-recon' }) }));
      await page.route('**/api/events?task=e2e-recon*', route => {
        eventUrl = route.request().url();
        return route.fulfill({ status: 200, contentType: 'text/event-stream',
          body: 'data: {"kind":"exit","status":"done"}\n\n' });
      });
      await page.route('**/api/atlas/e2e-recon', route => {
        atlasToken = route.request().headers()['x-heimdall-token'] ?? '';
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ origin: 'https://e2e-target.test', meta: { pages: 0, edges: 0 }, nodes: [], edges: [] }) });
      });
      await page.getByRole('button', { name: '星图', exact: true }).click();
      await page.fill('input[aria-label="目标站点域名"]', 'e2e-target.test');
      const atlasResponse = page.waitForResponse(r => r.url().includes('/api/atlas/e2e-recon'), { timeout: 10_000 });
      await page.getByRole('button', { name: '侦察', exact: true }).click();
      await atlasResponse;
      assert.equal(new URL(eventUrl).searchParams.get('token'), TEST_TOKEN, '侦察 SSE 需带 Token');
      assert.equal(atlasToken, TEST_TOKEN, '最终 atlas 请求需带 Token');
    }

    // 全站体检必须交给引擎遍历全部页；隐含 maxPages 会生成 sample 摘要，阻断响应式升级。
    let verifyBody = null;
    await page.route('**/api/verify', route => {
      verifyBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ taskId: 'e2e-verify' }) });
    });
    await page.route('**/api/events?task=e2e-verify*', route => route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: 'data: {"kind":"verify-done","pages":1,"targetTotal":1,"measured":1,"untested":0,"average":1,"passed":true}\n\n' }));
    await page.getByRole('button', { name: '报告', exact: true }).click();
    await page.locator('.storage-card').getByText('实际占用', { exact: true }).waitFor({ timeout: 30_000 });
    await page.locator('.storage-deliver').getByText(/共 0 个包/).waitFor({ timeout: 30_000 });
    const verifyResponse = page.waitForResponse(response => response.url().endsWith('/api/verify'));
    await page.getByRole('button', { name: /运行全站体检|重新体检/ }).click();
    await verifyResponse;
    assert.ok(verifyBody, '全站体检按钮应发出 API 请求');
    assert.equal(verifyBody.page, undefined);
    assert.equal(verifyBody.maxPages, undefined, '全站体检不得隐含抽样上限');

    // 删除页要能在控制台里找回，恢复后原产物必须重新出现在工作区。
    await page.getByRole('button', { name: '页面', exact: true }).click();
    await page.locator('.wv-rows .wv-actions button.danger').waitFor();
    page.once('dialog', dialog => dialog.accept());
    const deletedResponse = page.waitForResponse(response => response.request().method() === 'DELETE'
      && new URL(response.url()).pathname === '/api/sites/e2e-target.test/pages/home');
    await page.locator('.wv-rows .wv-actions button.danger').click();
    const deleted = await deletedResponse;
    assert.equal(deleted.status(), 200);
    const trashId = (await deleted.json()).trashId;
    assert.ok(trashId, '删除 API 应返回恢复标识');
    const targetPage = join(dataRoot, 'workspace', 'e2e-target.test', 'pages', 'home');
    assert.equal(existsSync(targetPage), false);

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '查看并恢复' }).click();
    const trashDialog = page.getByRole('dialog', { name: '最近删除' });
    const trashRow = trashDialog.locator('.trash-row', { hasText: 'e2e-target.test / home' });
    await trashRow.waitFor();
    const restoredResponse = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/trash/${trashId}/restore`);
    await trashRow.getByRole('button', { name: '恢复', exact: true }).click();
    assert.equal((await restoredResponse).status(), 200);
    await trashRow.getByText('已结束', { exact: false }).waitFor();
    assert.equal(await trashRow.getByRole('button', { name: '恢复', exact: true }).count(), 0);
    assert.equal(existsSync(targetPage), true);
    await trashDialog.getByRole('button', { name: '关闭最近删除' }).click();

    if (TEST_TOKEN && STATIC_BRIDGE) {
      // 设置页验证跨源状态请求只去已配置的引擎，并且错误口令不能覆盖可用口令。
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const tokenInput = page.getByRole('textbox', { name: '引擎 API 口令' });
      const tokenRow = page.locator('.set-row', { has: tokenInput });
      const saveToken = tokenRow.getByRole('button', { name: '保存', exact: true });
      assert.equal(await page.getByRole('textbox', { name: '引擎 API 地址' }).inputValue(), API_BASE);

      const statusRequests = [];
      const logoutRequests = [];
      const onRequest = request => {
        if (new URL(request.url()).pathname === '/api/status') statusRequests.push(request);
        if (new URL(request.url()).pathname === '/api/auth/logout') logoutRequests.push(request);
      };
      page.on('request', onRequest);
      try {
        await tokenInput.fill(TEST_TOKEN);
        const validStatus = page.waitForResponse(r => r.url() === API_BASE + '/api/status'
          && r.request().headers()['x-heimdall-token'] === TEST_TOKEN);
        await saveToken.click();
        assert.equal((await validStatus).status(), 200, '保存有效 Token 应校验配置的引擎');
        await page.getByRole('status').filter({ hasText: 'Token 已保存' }).waitFor();

        await tokenInput.fill('invalid-e2e-token');
        const invalidStatus = page.waitForResponse(r => r.url() === API_BASE + '/api/status'
          && r.request().headers()['x-heimdall-token'] === 'invalid-e2e-token');
        await saveToken.click();
        assert.equal((await invalidStatus).status(), 401, '错误 Token 应被配置的引擎拒绝');
        await page.getByRole('alert').filter({ hasText: 'Token 无效' }).waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('heimdall-token')), TEST_TOKEN,
          '错误 Token 校验失败后应回滚到上一个可用口令');

        await tokenInput.fill('');
        const unauthenticatedSites = page.waitForResponse(r => r.url() === API_BASE + '/api/sites'
          && !r.request().headers()['x-heimdall-token']);
        await saveToken.click();
        assert.equal((await unauthenticatedSites).status(), 401, '清除 Token 后后续请求应不带口令');
        await page.getByRole('status').filter({ hasText: '已打开的镜像会话可能持续' }).waitFor();
        assert.equal(await page.evaluate(() => localStorage.getItem('heimdall-token')), null);
        assert.equal(logoutRequests.length, 0, '跨源清除 Token 不应向引擎发注销请求');
        assert.ok(statusRequests.length >= 2 && statusRequests.every(r => new URL(r.url()).origin === API_BASE),
          'Token 校验请求只应发送给设置的引擎主机');
      } finally {
        page.off('request', onRequest);
      }
    }

    // ⑥ 全程不应有未捕获的页面异常
    assert.deepEqual(pageErrors, [], '控制台不应抛未捕获异常，实际：\n' + pageErrors.join('\n'));
  } catch (err) {
    /**
     * 偶发失败要留下现场。
     *
     * 这条测试在机器忙时会偶发挂掉（实测 6-10 次里一次），而它给出的只有一句断言或超时 ——
     * 没有现场就只能靠重跑猜，那等于把"会撒谎的自检"换成"会飘的自检"。
     * 这里把断言、页面未捕获异常、引擎日志和一张截图一起落盘
     * （截图写在 gitignore 过的 workspace 下，不污染仓库）。
     */
    try {
      if (page) {
        const dir = join(CORE, 'workspace');
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, '_e2e-failure.png') }).catch(() => {});
        writeFileSync(join(dir, '_e2e-failure.txt'),
          '=== 断言 ===\n' + (err?.message ?? String(err))
          + '\n\n=== 页面未捕获异常 ===\n' + pageErrors.join('\n')
          + '\n\n=== 控制台错误 ===\n' + consoleErrors.join('\n')
          + '\n\n=== 请求失败 ===\n' + failedRequests.join('\n')
          + '\n\n=== 引擎日志（尾部 4000 字）===\n' + engineLog.slice(-4000) + '\n');
      }
    } catch { /* 留现场本身不该再抛，别盖掉真正的失败 */ }
    throw err;
  } finally {
    try { await browser?.close(); } catch { /* 浏览器可能没起来 */ }
    try { engine.kill(); } catch { /* 已退出 */ }
    if (consoleServer) await new Promise(resolve => consoleServer.close(resolve));
    // 给进程一点时间释放 sqlite/端口句柄，Windows 上句柄未放时会删不掉
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
  }
});
