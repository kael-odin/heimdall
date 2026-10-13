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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(CORE, '..', 'console', 'dist');

const PORT = 8960 + Math.floor(Math.random() * 20);
const BASE = `http://127.0.0.1:${PORT}`;

/** 一个最小站点：2 页克隆 + atlas + 一份改站清单所需的产物 */
function writeFixture(dataRoot) {
  const ws = join(dataRoot, 'workspace', 'fixture.test');
  const put = (p, body) => { mkdirSync(join(ws, dirname(p)), { recursive: true }); writeFileSync(join(ws, p), body); };
  const pages = [{ name: 'home', path: '/' }, { name: 'docs', path: '/docs' }];
  for (const { name, path } of pages) {
    put(`pages/${name}/clone/index.html`, `<html><head><link rel="canonical" href="https://fixture.test${path}"></head><body><h1>${name}</h1></body></html>`);
    put(`pages/${name}/clone/assets/image000.png`, 'PNG');
    put(`pages/${name}/manifest.json`, JSON.stringify({ target: `https://fixture.test${path}` }));
    put(`pages/${name}/score.json`, JSON.stringify({ total: 98, pixel: 0.98, grade: 'A' }));
    put(`pages/${name}/intel/intel.json`, JSON.stringify({ meta: { title: name + ' 标题' }, headings: [{ level: 'h1', text: name }], cta: ['开始'], prices: [] }));
  }
  put('pages/home/asset-map.json', JSON.stringify({ imgMap: { 'https://cdns.fixture.test/logo.png': 'assets/image000.png' } }));
  put('recon/atlas.json', JSON.stringify({
    origin: 'https://fixture.test', status: 'ok', failures: [], generatedAt: new Date().toISOString(),
    meta: { pages: 2, edges: 1 },
    nodes: [
      { id: 'n11111111', url: 'https://fixture.test/', path: '/', title: '首页', type: 'marketing', depth: 0 },
      { id: 'n22222222', url: 'https://fixture.test/docs', path: '/docs', title: '文档', type: 'docs', depth: 1 },
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

  const engine = spawn(process.execPath, [join(CORE, 'src', 'engine-server.mjs'), String(PORT)], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: dataRoot, HEIMDALL_CONSOLE_DIR: DIST },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  engine.stdout.on('data', (d) => { engineLog += d.toString(); });
  engine.stderr.on('data', (d) => { engineLog += d.toString(); });

  let browser;
  try {
    // 等引擎就绪（最多 20s）
    const ready = await new Promise((resolve) => {
      const t0 = Date.now();
      const tick = setInterval(() => {
        if (engineLog.includes('engine-server @')) { clearInterval(tick); resolve(true); }
        else if (Date.now() - t0 > 20_000) { clearInterval(tick); resolve(false); }
      }, 200);
    });
    assert.ok(ready, '引擎未在 20s 内就绪。日志：\n' + engineLog.slice(-800));

    browser = await chromium.launch();
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hud', { timeout: 20_000 });

    // ① 星图有可访问名（canvas 本身进不去，靠 role=img 说明）
    const mapLabel = await page.locator('.g3d').first().getAttribute('aria-label');
    assert.match(mapLabel ?? '', /站点星图/, '星图应带 role=img 的可读说明');

    // ② 站点清单里有 fixture 站（说明 /api/sites 与静态产物通了）
    const options = await page.locator('.sb-select option').allInnerTexts();
    assert.ok(options.some(o => o.includes('fixture.test')), '站点下拉应包含 fixture.test，实际：' + options.join(' / '));

    // ③ 页面视图：排序表头可键盘操作，回车后 aria-label 的方向随之翻转
    await page.getByRole('button', { name: '页面' }).click();
    await page.waitForSelector('.wv-th .c-path.sortable', { timeout: 15_000 });
    const th = page.locator('.wv-th .c-path.sortable');
    const before = await th.getAttribute('aria-label');
    await th.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const after = await th.getAttribute('aria-label');
    assert.notEqual(after, before, '回车应切换排序方向（aria-label 里的"升序/降序"要变）');

    // ④ 详情面板：对话框语义 + 打开即聚焦关闭按钮 + Esc 关闭
    await page.locator('.wv-rows .wv-row:not(.wv-th) .c-path[role="button"]').first().click();
    await page.waitForSelector('.dock', { timeout: 10_000 });
    assert.equal(await page.locator('.dock').getAttribute('role'), 'dialog');
    assert.equal(await page.locator('.dock').getAttribute('aria-modal'), 'true');
    assert.equal(await page.locator('.dock [role="tablist"]').count(), 1, '标签页应有 tablist 语义');
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
    await page.fill('input[aria-label="目标站点域名"]', 'e2e-target.test');
    await page.getByRole('button', { name: '只克隆此页' }).click();
    await page.waitForTimeout(800);
    assert.ok(forgeBody, '「只克隆此页」必须发出 POST /api/forge —— 没发出就是按钮哑了');
    assert.equal(forgeBody.url, 'https://e2e-target.test', '请求体里要带上目标 URL');
    await page.unroute('**/api/forge');

    // ⑥ 全程不应有未捕获的页面异常
    assert.deepEqual(pageErrors, [], '控制台不应抛未捕获异常，实际：\n' + pageErrors.join('\n'));
  } finally {
    try { await browser?.close(); } catch { /* 浏览器可能没起来 */ }
    try { engine.kill(); } catch { /* 已退出 */ }
    // 给进程一点时间释放 sqlite/端口句柄，Windows 上句柄未放时会删不掉
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
  }
});
