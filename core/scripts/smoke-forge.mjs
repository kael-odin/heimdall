#!/usr/bin/env node
/**
 * smoke-forge — 端到端冒烟：本地 fixture 站点 → recon → forge → 产物断言 → 安全断言
 *
 * 设计目标：
 *   - 不碰外网、不碰真实 workspace（HEIMDALL_DATA_DIR = 临时目录）
 *   - 不调用 LLM（HEIMDALL_LLM=0）
 *   - 使用随机端口，可与用户正在运行的 :8900/:5173 并存
 *
 * 用法: node scripts/smoke-forge.mjs
 */
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import assert from 'node:assert/strict';
// 这条断言复用生产实现本身，而不是再写一个正则：属性名也会出现在
// `alt="…with crossorigin"` 这种文字里，手写正则会先把自己骗过去（第一版就是这么红的）
import { dropCrossoriginOnLocalRefs } from '../src/dom-refs.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_DIR = join(CORE, 'test', 'fixtures', 'site');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const log = (...a) => console.log('[smoke]', ...a);

/**
 * 扫一棵目录树，找出所有含截图冻结样式的 HTML。
 * 冻结样式是 `page.addStyleTag()` 注入的、只为让截图可复现的东西 —— 它出现在任何产物里都是 bug：
 * 静态镜像与交互镜像都靠"样式表还在"来播 CSS 动画，冻住就自相矛盾了。
 * （真实故障：它曾跟着 dom.html 进了交互镜像，apify 61/61 页的 hover 过渡全变成瞬移。）
 */
function scanForFreeze(root) {
  const hits = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.html?$/i.test(e.name)) {
        let s = '';
        try { s = readFileSync(p, 'utf8'); } catch { continue; }
        if (/animation-duration:\s*0s\s*!important/i.test(s) && /caret-color:\s*transparent/i.test(s)) hits.push(p);
      }
    }
  };
  walk(root);
  return hits;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

/**
 * fixture 站点跑在**两个端口**上，这不是手滑。
 *
 * 附件样式表故意放到另一个 origin 上，复现真实故障：现代站点爱把 CSS 放独立域名
 * （`static.linear.app` 之类），而同源策略下 `sheet.cssRules` 对跨域样式表直接抛异常 ——
 * 于是这些表被静默跳过。实测 linear.app 因此丢掉 **58 份**样式表（reset / 设计变量 / 布局），
 * 克隆页渲染成默认样式的竖排链接，而 DOM 分依然是 100%，只有像素分掉到 59% 才露馅。
 *
 * 所以：CSS 走 :cssPort（跨域），页面走 :sitePort。捕获侧必须把跨域表按 URL 取回来，
 * 否则下面"关键帧必须进镜像"的断言会立刻变红。
 */
function startFixtureServer({ cssOrigin = null, port = 0 } = {}) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = join(FIXTURE_DIR, rel.replace(/^\/+/, ''));
      if (!file.startsWith(FIXTURE_DIR) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
      const type = MIME[extname(file)] ?? 'application/octet-stream';
      let body = readFileSync(file);
      // 页面上的样式表引用改指向另一个 origin，制造"跨域样式表"
      if (cssOrigin && /^\.html?$/.test(extname(file))) {
        body = Buffer.from(String(body).replaceAll('href="/styles.css"', `href="${cssOrigin}/styles.css"`));
      }
      res.writeHead(200, { 'Content-Type': type });
      res.end(body);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function waitFor(fn, { timeout = 30_000, interval = 250, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - start > timeout) throw new Error('timeout waiting for ' + label);
    await new Promise(r => setTimeout(r, interval));
  }
}

async function postJson(base, path, body) {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

/** 读取 SSE，直到 exit 事件（引擎会先重放历史事件） */
async function waitExit(base, taskId, timeoutMs = 240_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/events?task=${taskId}`, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.kind === 'exit') return ev;
      }
    }
    throw new Error('SSE ended without exit event');
  } finally { clearTimeout(timer); }
}

async function main() {
  const cssPort = await freePort();
  const { server: fixture, port: fixturePort } = await startFixtureServer({ cssOrigin: `http://127.0.0.1:${cssPort}` });
  const { server: cssFixture } = await startFixtureServer({ port: cssPort });   // 跨域样式表另起一个 origin
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(tmpdir(), 'heimdall-smoke-'));
  log('fixture :' + fixturePort, '(页面) /', cssPort, '(样式表，另一个 origin)', '| engine :' + port, '| data', dataDir);

  const engine = spawn(process.execPath, ['src/engine-server.mjs', String(port)], {
    cwd: CORE,
    env: {
      ...process.env,
      HEIMDALL_DATA_DIR: dataDir,
      HEIMDALL_HOST: '127.0.0.1',
      HEIMDALL_LLM: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let engineLog = '';
  engine.stdout.on('data', d => { engineLog += d; });
  engine.stderr.on('data', d => { engineLog += d; });

  try {
    await waitFor(async () => (await fetch(base + '/api/status')).ok, { label: 'engine boot', timeout: 20_000 });
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.bind, '127.0.0.1', 'engine must bind to localhost by default');

    // 1) recon
    const recon = await postJson(base, '/api/recon', { url: `http://127.0.0.1:${fixturePort}/`, maxPages: 5 });
    assert.equal(recon.status, 200, 'recon must start: ' + JSON.stringify(recon.body));
    const reconExit = await waitExit(base, recon.body.taskId, 120_000);
    assert.equal(reconExit.status, 'done', 'recon exit status');

    const atlas = await (await fetch(`${base}/api/atlas/${recon.body.taskId}`)).json();
    assert.ok(atlas.nodes.length >= 2, `atlas should discover >=2 pages, got ${atlas.nodes.length}`);
    assert.equal(atlas.status, 'ok');

    // 2) forge（hostPost=false：批量语义，站点级汇总由调用方统一跑）
    const forge = await postJson(base, '/api/forge', { url: `http://127.0.0.1:${fixturePort}/`, hostPost: false });
    assert.equal(forge.status, 200, 'forge must start: ' + JSON.stringify(forge.body));
    const forgeExit = await waitExit(base, forge.body.taskId, 240_000);
    assert.equal(forgeExit.status, 'done', 'forge exit status (engine log tail: ' + engineLog.slice(-400) + ')');

    // 2b) 单页锻造历史（持久化）应可查
    await waitFor(async () => {
      const r = await fetch(base + '/api/history/127.0.0.1/home');
      if (!r.ok) return false;
      const h = await r.json();
      return h.jobs?.length >= 1;
    }, { label: 'forge history', timeout: 15_000 });

    // 3) 产物断言
    const pageDir = join(dataDir, 'workspace', '127.0.0.1', 'pages', 'home');
    const cloneHtml = join(pageDir, 'clone', 'index.html');
    const scorePath = join(pageDir, 'score.json');
    assert.ok(existsSync(cloneHtml), 'clone/index.html must exist: ' + cloneHtml);
    assert.ok(existsSync(scorePath), 'score.json must exist: ' + scorePath);
    const score = JSON.parse(readFileSync(scorePath, 'utf8'));
    assert.ok(score.pixel >= 0.5, `pixel score too low: ${score.pixel}`);
    assert.ok(score.dom.dom >= 0.9, `dom score too low: ${score.dom.dom}`);
    const html = readFileSync(cloneHtml, 'utf8');
    assert.ok(html.includes('styles/cssom.css'), 'clone must reference the captured CSSOM');
    assert.ok(!/<script\b/i.test(html), 'static clone must strip scripts');
    const assetMap = JSON.parse(readFileSync(join(pageDir, 'asset-map.json'), 'utf8'));
    assert.ok((assetMap.resources ?? []).some(r => (r.kinds ?? []).includes('icon')), 'asset-map must record the icon resource');
    const iconMatch = /<link[^>]+rel="icon"[^>]*href="(assets\/[^"]+)"/i.exec(html);
    assert.ok(iconMatch, 'favicon must be localized in the static clone');
    assert.ok(existsSync(join(pageDir, 'clone', iconMatch[1])), 'localized favicon file must exist: ' + iconMatch[1]);

    // 3b) 动效与冻结样式 —— 两条方向相反的断言，缺一条都会让上面那个故障再回来：
    //     · CSS 关键帧**必须**活着进镜像（样式表原样保留，这是"CSS 动效已复刻"的依据）
    //     · 截图冻结样式**必须**不进任何产物（它只是让截图可复现；混进去就把动画全冻住了）
    const cloneCss = readFileSync(join(pageDir, 'clone', 'styles', 'cssom.css'), 'utf8');
    assert.match(cloneCss, /@keyframes\s+heimdall-pulse/, 'CSS 关键帧必须保留在镜像样式表里');
    // 注意 CSSOM 序列化会把简写规范化，动画名挪到最后：
    // `animation: 1.6s ease-in-out 0s infinite normal none running heimdall-pulse`
    assert.match(cloneCss, /animation:[^;}]*heimdall-pulse/, '动画的引用也必须保留');
    assert.deepEqual(scanForFreeze(pageDir), [], '截图冻结样式不得进入原站产物（dom.html / clone）');

    // 3c) 本地化引用上不得留 crossorigin：留着的话，用 file:// 打开克隆页（"双击即看"）
    //     会以 CORS 模式去取本地文件，图片一律被拦成裂图 —— 而经 http 打开完全正常，
    //     所以只有这条离线断言看得见它（实测 apify.com/home，像素分 100% → 84.8%）。
    const cloneForCors = readFileSync(join(pageDir, 'clone', 'index.html'), 'utf8');
    assert.equal(dropCrossoriginOnLocalRefs(cloneForCors).count, 0,
      '克隆页里还有本地引用挂着 crossorigin —— file:// 打开会变成裂图');

    // 4) 安全断言
    const evil = await fetch(base + '/px/evil.example/x');
    assert.equal(evil.status, 403, 'proxy must reject non-workspace hosts');
    const lmEvil = await fetch(base + '/lm/evil.example/x');
    assert.equal(lmEvil.status, 403, 'live mirror must reject non-workspace hosts');
    const cloneUrl = `${base}/static/127.0.0.1/pages/home/clone/index.html`;
    assert.equal((await fetch(cloneUrl)).status, 200, 'clone page must be served');

    // 5) 任务清单
    const jobs = await (await fetch(base + '/api/jobs')).json();
    assert.ok(jobs.jobs.length >= 2, 'jobs endpoint should list recon + forge');
    assert.ok(jobs.jobs.every(j => ['done', 'failed', 'cancelled', 'running'].includes(j.status)));

    // 6) SEO 审计（复用同一 fixture + 临时数据目录）
    const audit = await postJson(base, '/api/audit', { url: `http://127.0.0.1:${fixturePort}/`, maxPages: 5 });
    assert.equal(audit.status, 200, 'audit must start: ' + JSON.stringify(audit.body));
    const auditExit = await waitExit(base, audit.body.taskId, 240_000);
    assert.equal(auditExit.status, 'done', 'audit exit status (engine log tail: ' + engineLog.slice(-500) + ')');
    const seoJson = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.json'), 'utf8'));
    assert.ok(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'seo', 'seo.html')), 'seo.html must exist');
    assert.ok(seoJson.pages.length >= 2, 'audit should cover >=2 pages, got ' + seoJson.pages.length);
    assert.ok(seoJson.score > 0, 'audit score should be > 0');

    // 7) 交互镜像 L3：导出可部署包 + 离线启动验证（不碰外网）
    const bundleDir = join(dataDir, 'bundle');
    const exp = spawnSync(process.execPath, ['src/live/export.mjs', '127.0.0.1', '--out', bundleDir, '--offline', '--root', 'mirror'], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_LLM: '0' },
      encoding: 'utf8',
    });
    assert.equal(exp.status, 0, 'live export failed: ' + String(exp.stderr || exp.stdout).slice(-500));
    for (const name of ['serve.mjs', 'har.mjs', 'har.json', 'heimdall-live.json', 'landing.html', 'health.json', 'Dockerfile', 'docker-compose.yml', 'checksums.json']) {
      assert.ok(existsSync(join(bundleDir, name)), 'bundle must contain ' + name);
    }
    const healthJson = JSON.parse(readFileSync(join(bundleDir, 'health.json'), 'utf8'));
    // 交互镜像卖的就是"能跑起来看动效" —— 冻结样式混进来就把它的卖点冻没了
    assert.deepEqual(scanForFreeze(bundleDir), [], '截图冻结样式不得进入交互镜像包');

    assert.ok(healthJson.pages >= 1, 'health.json must cover live pages');
    assert.equal(typeof healthJson.assets?.unresolved, 'number', 'health asset gap count must be numeric');
    assert.equal(healthJson.assets.unresolved, 0, 'fixture live bundle must be fully self-contained: ' + JSON.stringify(healthJson.details?.slice(0, 2)));
    const livePort = await freePort();
    const live = spawn(process.execPath, ['serve.mjs', '--port', String(livePort), '--offline'], { cwd: bundleDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let liveLog = '';
    live.stdout.on('data', d => { liveLog += d; });
    live.stderr.on('data', d => { liveLog += d; });
    try {
      await waitFor(async () => (await fetch('http://127.0.0.1:' + livePort + '/__heimdall/health')).ok, { label: 'live bundle boot', timeout: 20_000 });
      const health = await (await fetch('http://127.0.0.1:' + livePort + '/__heimdall/health')).json();
      assert.equal(health.offline, true, 'offline mode flag');
      assert.equal(health.root, 'mirror', 'export --root mirror must persist into bundle config');
      const rootHome = await fetch('http://127.0.0.1:' + livePort + '/');
      assert.equal(rootHome.status, 200, 'root=mirror status (log: ' + liveLog.slice(-300) + ')');
      assert.ok((await rootHome.text()).includes('Fixture Site'), 'root=mirror must serve the fixture page at /');
      const home = await fetch('http://127.0.0.1:' + livePort + '/lm/127.0.0.1/');
      assert.equal(home.status, 200, 'live home status (log: ' + liveLog.slice(-300) + ')');
      assert.ok((await home.text()).includes('Fixture Site'), 'live home must be the fixture page');
      const cssRes = await fetch('http://127.0.0.1:' + livePort + '/static/127.0.0.1/pages/home/clone/styles/cssom.css');
      assert.equal(cssRes.status, 200, 'live bundle must serve clone CSS');
      const miss = await fetch('http://127.0.0.1:' + livePort + '/lm/127.0.0.1/never-captured');
      assert.ok([404, 502].includes(miss.status), 'offline miss status: ' + miss.status);
    } finally {
      live.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 300));
    }

    // 8) 变更监控：引擎 watch 任务（首次建立基线）
    const watch = await postJson(base, '/api/watch', { url: 'http://127.0.0.1:' + fixturePort + '/', maxPages: 5 });
    assert.equal(watch.status, 200, 'watch must start: ' + JSON.stringify(watch.body));
    const watchExit = await waitExit(base, watch.body.taskId, 240_000);
    assert.equal(watchExit.status, 'done', 'watch exit status (log: ' + engineLog.slice(-400) + ')');
    const watchDir = join(dataDir, 'workspace', '127.0.0.1', 'watch');
    const watchJson = JSON.parse(readFileSync(join(watchDir, 'watch.json'), 'utf8'));
    assert.ok(watchJson.summary.total >= 2, 'watch should cover >=2 pages');
    assert.equal(watchJson.summary.firstRun, true, 'first watch run creates baseline');
    assert.ok(existsSync(join(watchDir, 'watch.html')), 'watch.html must exist');
    assert.ok(existsSync(join(watchDir, 'baseline.json')), 'watch baseline must exist');

    // 9) 删除能力：单页（产物+atlas 节点）与整站；坏请求返回 4xx
    const badDel = await fetch(base + '/api/sites/%2e%2e', { method: 'DELETE' });
    assert.ok([400, 404].includes(badDel.status), 'bad host delete must be rejected, got ' + badDel.status);
    const delPage = await fetch(base + '/api/sites/127.0.0.1/pages/home', { method: 'DELETE' });
    assert.equal(delPage.status, 200, 'delete page status');
    const delPageBody = await delPage.json();
    assert.equal(delPageBody.removedArtifacts, true, 'page artifacts removed');
    assert.equal(existsSync(join(dataDir, 'workspace', '127.0.0.1', 'pages', 'home')), false, 'page dir must be gone');
    const atlasAfter = JSON.parse(readFileSync(join(dataDir, 'workspace', '127.0.0.1', 'recon', 'atlas.json'), 'utf8'));
    assert.ok(!atlasAfter.nodes.some(n => { try { return new URL(n.url).pathname === '/'; } catch { return false; } }), 'atlas node must be removed');
    const delSite = await fetch(base + '/api/sites/127.0.0.1', { method: 'DELETE' });
    assert.equal(delSite.status, 200, 'delete site status');
    assert.equal(existsSync(join(dataDir, 'workspace', '127.0.0.1')), false, 'site dir must be gone');
    assert.ok([400, 404].includes((await fetch(base + '/api/sites/127.0.0.1', { method: 'DELETE' })).status), 'second delete must 404');

    // 10) 任务持久化：jobs.db + 引擎重启后历史仍在
    const jobsBefore = await (await fetch(base + '/api/jobs')).json();
    assert.ok(jobsBefore.store, 'job store should be active');
    assert.ok(jobsBefore.history.length >= 3, 'job history should cover recon/forge/audit/watch, got ' + jobsBefore.history.length);
    assert.ok(existsSync(join(dataDir, 'jobs.db')), 'jobs.db must exist');
    engine.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 900));
    const engine2 = spawn(process.execPath, ['src/engine-server.mjs', String(port)], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: dataDir, HEIMDALL_HOST: '127.0.0.1', HEIMDALL_LLM: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitFor(async () => (await fetch(base + '/api/status')).ok, { label: 'engine restart', timeout: 20_000 });
      const jobsAfter = await (await fetch(base + '/api/jobs')).json();
      assert.ok(jobsAfter.history.length >= jobsBefore.history.length, 'history must persist across restart');
      assert.ok(!jobsAfter.history.some(j => j.status === 'running'), 'no stale running jobs after restart');
    } finally { engine2.kill('SIGTERM'); }

    log('PASS — recon pages =', atlas.nodes.length, '| visual =', (score.pixel * 100).toFixed(1) + '%', '| dom =', (score.dom.dom * 100).toFixed(1) + '%', '| seo =', seoJson.score, '(', seoJson.summary.issues, 'issues )', '| live bundle ok (health unresolved=' + healthJson.assets.unresolved + ' externalAssets=' + healthJson.assets.externalAssets + ')', '| watch ok', '| jobs persistent');
  } finally {
    engine.kill('SIGTERM');
    fixture.close();
    cssFixture.close();
    await new Promise(r => setTimeout(r, 500));
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(e => { console.error('[smoke] FAIL —', e.message); process.exit(1); });
