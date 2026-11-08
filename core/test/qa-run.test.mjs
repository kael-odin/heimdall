/**
 * qa 端到端：本地夹具站 + 真浏览器
 *
 * 夹具埋了：坏链、坏图、横向溢出、控制台报错、接口 500、复制按钮、需要登录的页面、打开就发的写请求。
 * 验证：登录档（localStorage 声明式注入）生效；剪贴板检查点用真实点击通过；
 * 检查点选择器写错时报「检查点待修」而不是 bug；裁决记下后，第二次运行自动过滤；agent 提交走证据门槛。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { loadWorkspace } from '../src/qa/workspace.mjs';
import { runQa, submitFindings, retriageRun, readRun } from '../src/qa/run.mjs';
import { recordVerdict } from '../src/qa/memory.mjs';
import { fileable } from '../src/qa/report.mjs';
import { writeBaseline, readBaseline } from '../src/qa/baseline.mjs';
import { invoke } from '../src/agent/registry/invoke.mjs';
import { fingerprintOf } from '../src/qa/findings.mjs';
import { newQaPage, qaBrowserLaunchOptions, routeQaRequest } from '../src/qa/http-policy.mjs';
import { normalizeCheck } from '../src/qa/probe.mjs';

const PAGES = {
  '/': `<!doctype html><meta charset="utf-8"><title>首页</title>
    <h1>代理 IP</h1><a href="/pricing">定价</a> <a href="/missing">文档</a>
    <img src="/nope.png" alt="横幅" width="100" height="40">
    <button id="copy" onclick="navigator.clipboard.writeText('203.0.113.7:8080')">复制</button>
    <script>console.error('boom: widget failed'); fetch('/api/stats'); fetch('/api/track', { method: 'POST', body: '{}' });</script>`,
  '/pricing': `<!doctype html><meta charset="utf-8"><title>定价</title><h1>定价</h1><div style="width:2400px">宽表格</div><p id="price">¥95/月</p>`,
  '/console': `<!doctype html><meta charset="utf-8"><title>控制台</title><div id="app"></div>
    <script>document.getElementById('app').textContent = localStorage.getItem('_token') ? '欢迎回来 tester' : '请登录';</script>`,
  '/detector-regression': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>检测对照</title>
    <style>
      .clip { display:block; width:65px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis }
      .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap }
      .table-outer { width:160px; overflow:hidden }
      .table-scroll { width:100%; overflow-x:auto }
      table { width:600px }
    </style></head><body><h1>检测对照页面</h1>
    <button id="named-icon"><svg role="img" aria-label="search" width="20" height="20"></svg></button>
    <button id="unlabeled-icon"><svg aria-hidden="true" aria-label="hidden" width="20" height="20"></svg></button>
    <button id="hidden-child-text"><span aria-hidden="true">隐藏的图标说明</span></button>
    <span id="label-text" hidden>通过隐藏标签引用命名</span><button id="labelled" aria-labelledby="label-text"></button>
    <h2 id="sr-only" class="sr-only">供读屏使用的完整标题</h2>
    <p id="real-clip" class="clip">这是一段被裁切并且无法恢复的完整文字。</p>
    <p id="title-clip" class="clip" title="这是可以通过标题提示看到的完整文字。">这是可以通过标题提示看到的完整文字。</p>
    <p id="wrong-title" class="clip" title="提示不完整">这是一段标题提示并没有覆盖的完整文字。</p>
    <div id="table-outer" class="table-outer"><div id="table-header" style="overflow:hidden"><table><thead><tr><th>可以左右滚动查看的完整表头</th></tr></thead></table></div>
      <div class="table-scroll"><table><tbody><tr><td>可以左右滚动查看的完整表格内容</td></tr></tbody></table></div></div>
  </body></html>`,
  '/user/login': `<!doctype html><html lang="zh-CN"><title>登录</title><h1>扫码登录</h1>
    <button id="login-retry" type="button" onclick="fetch('/api/login-click')">刷新二维码</button></html>`,
  '/guarded-after': `<!doctype html><html lang="zh-CN"><title>业务页</title><h1>业务页</h1>
    <button id="expire-session" type="button" onclick="location.href='/user/login'">查看内容</button></html>`,
  '/detector-failure': `<!doctype html><html lang="zh-CN"><title>检测异常对照</title><h1>检测异常对照</h1>
    <script>const query = document.querySelectorAll.bind(document); document.querySelectorAll = function(selector) {
      if (selector.startsWith('button, a[href]')) throw new Error('fixture secret must not be recorded');
      return query(selector);
    };</script></html>`,
  '/check-rows': `<!doctype html><html lang="zh-CN"><title>表格检查对照</title><h1>表格检查对照</h1>
    <div id="bad"><span class="date">2026-11-08</span><span class="date">2026-11-09T08:09:10Z</span></div>
    <div id="good"><span class="date" style="visibility:hidden">measurement</span><span class="date">2026-11-08</span><span class="date">2026-11-09</span></div>
    <div id="hidden"><span class="date" style="display:none">measurement</span></div>
    <div id="late"></div><div id="ready" hidden>已加载</div><div id="loading">加载中</div><div id="many"></div><div id="long"></div><div id="slow-regex"></div>
    <script>
      document.getElementById('many').innerHTML = '<span class="date">2026-11-08</span>'.repeat(1001);
      document.getElementById('long').textContent = 'x'.repeat(4001);
      document.getElementById('slow-regex').textContent = 'a'.repeat(100) + '!';
    </script>
    <script>setTimeout(() => {
      document.getElementById('late').innerHTML = '<span class="date">2026-11-08</span><span class="date">2026-11-09</span>';
      document.getElementById('ready').hidden = false;
      document.getElementById('loading').remove();
    }, 500);</script></html>`,
};

function server() {
  const hits = { trackPost: 0, loginClick: 0 };
  const srv = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (path === '/guarded') { res.writeHead(302, { location: '/user/login?return=%2Fguarded' }); return res.end(); }
    if (path === '/api/login-click') { hits.loginClick++; res.writeHead(204); return res.end(); }
    if (path === '/api/stats') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":"x"}'); }
    if (path === '/api/track') { if (req.method === 'POST') hits.trackPost++; res.writeHead(204); return res.end(); }
    if (PAGES[path]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGES[path]); }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  });
  srv.hits = hits;
  return new Promise(done => srv.listen(0, '127.0.0.1', () => done(srv)));
}

test('qa checks: all visible rows, readiness and empty results remain explicit', { timeout: 120_000 }, async () => {
  const srv = await server();
  const root = workspaceFor(`http://127.0.0.1:${srv.address().port}`);
  try {
    const ws = loadWorkspace(root);
    ws.defaults.settleMs = 0;
    ws.defaults.timeoutMs = 2000;
    const date = selector => ({ kind: 'text', selector, matches: '^\\d{4}-\\d{2}-\\d{2}$' });
    const each = selector => ({ ...date(selector), scope: 'all-visible' });
    const checks = [
      { id: 'legacy-first', title: '旧版首条行为', path: '/check-rows', expect: [date('#bad .date')] },
      { id: 'bad-second', title: '第二行格式异常', path: '/check-rows', expect: [each('#bad .date')] },
      { id: 'hidden-measurement', title: '排除隐藏测量行', path: '/check-rows', expect: [each('#good .date')] },
      { id: 'empty', title: '没有匹配结果', path: '/check-rows', expect: [each('#empty .date')] },
      { id: 'hidden-only', title: '只有隐藏结果', path: '/check-rows', expect: [each('#hidden .date')] },
      { id: 'short-list', title: '数据条数不足', path: '/check-rows', expect: [{ ...each('#good .date'), minMatches: 3 }] },
      { id: 'wait-ready', title: '等待数据就绪', path: '/check-rows', steps: [{ action: 'waitFor', selector: '#ready' }], expect: [{ ...each('#late .date'), minMatches: 2 }] },
      { id: 'never-ready', title: '数据没有就绪', path: '/check-rows', steps: [{ action: 'waitFor', selector: '#never' }], expect: [each('#late .date')] },
      { id: 'too-many', title: '匹配项超过上限', path: '/check-rows', expect: [each('#many .date')] },
      { id: 'too-long', title: '文本超过上限', path: '/check-rows', expect: [each('#long')] },
      { id: 'slow-regex', title: '正则匹配超时', path: '/check-rows', expect: [{ ...each('#slow-regex'), matches: '^(a+)+$' }] },
      { id: 'bad-navigation', title: '检查点页面不存在', path: '/missing', expect: [{ kind: 'text', selector: 'body', contains: 'not found' }] },
      { id: 'bad-goto', title: '检查点跳转失败', path: '/check-rows', steps: [{ action: 'goto', path: '/missing' }], expect: [{ kind: 'text', selector: 'body', contains: 'not found' }] },
      { id: 'contains', title: '逐项包含文本', path: '/check-rows', expect: [{ kind: 'text', selector: '#good .date', scope: 'all-visible', contains: '2026-11' }] },
      { id: 'equals', title: '逐项完全相等', path: '/check-rows', expect: [{ kind: 'text', selector: '#good .date:nth-child(2)', scope: 'all-visible', equals: '2026-11-08' }] },
      { id: 'wait-hidden', title: '等待加载提示消失', path: '/check-rows', steps: [{ action: 'waitFor', selector: '#loading', state: 'hidden' }], expect: [{ ...each('#late .date'), minMatches: 2 }] },
    ];
    const options = { site: 'web', pages: ['/check-rows'], viewports: [1280], linkCheck: false, detect: false, baseline: false };
    const run = await runQa(ws, { ...options, checks: checks.slice(0, 3) });
    const byId = Object.fromEntries(run.run.coverage.checks.map(c => [c.id, c]));
    assert.equal(byId['legacy-first'].pass, true, 'the default remains a first-match check');
    assert.equal(byId['bad-second'].pass, false, 'a bad later row must not be missed');
    assert.deepEqual(byId['bad-second'].assertions[0], { scope: 'all-visible', selector: '#bad .date', matched: 2, failed: 1 });
    assert.match(run.findings.find(f => f.target === 'bad-second').observed, /2026-11-09T08:09:10Z/);
    assert.equal(byId['hidden-measurement'].pass, true, 'hidden measurement nodes are not business rows');
    assert.deepEqual(byId['hidden-measurement'].assertions[0], { scope: 'all-visible', selector: '#good .date', matched: 2, failed: 0 });
    assert.match(readFileSync(run.files.report, 'utf8'), /可见 2 项，不符 1 项/);
    const pending = await runQa(ws, { ...options, checks: checks.slice(3) });
    Object.assign(byId, Object.fromEntries(pending.run.coverage.checks.map(c => [c.id, c])));
    assert.match(readFileSync(pending.files.bugs, 'utf8'), /未能核实的检查点未完成检查/);
    for (const id of ['empty', 'hidden-only', 'short-list', 'never-ready', 'too-many', 'too-long', 'slow-regex', 'bad-navigation', 'bad-goto']) {
      assert.equal(byId[id].pass, false, `${id} cannot pass`);
      assert.ok(byId[id].error, `${id} must be classified as an incomplete check`);
      assert.equal(pending.findings.find(f => f.target === id).confidence, 'check-error');
    }
    assert.match(byId['slow-regex'].error, /正则匹配超时/);
    assert.equal(byId['wait-ready'].pass, true);
    assert.deepEqual(byId['wait-ready'].assertions[0], { scope: 'all-visible', selector: '#late .date', matched: 2, failed: 0 });
    assert.equal(byId.contains.pass, true);
    assert.equal(byId.equals.pass, true);
    assert.equal(byId['wait-hidden'].pass, true);
    const ci = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/check-rows'], viewports: [1280],
      checks: [checks[3]], linkCheck: false, detect: false, baseline: false, failOn: 'none' }, { client: 'mcp' });
    assert.equal(ci.error?.code, 'qa_incomplete', 'no matches cannot make CI green');
    assert.equal(ci.result.ci.status, 'incomplete');
    const readyCi = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/check-rows'], viewports: [1280],
      checks: [checks[6]], linkCheck: false, detect: false, baseline: false, failOn: 'none' }, { client: 'mcp' });
    assert.equal(readyCi.ok, true, 'MCP accepts and executes waitFor, all-visible and minMatches');
    assert.equal(readyCi.result.ci.status, 'passed');
    const invalid = expect => () => normalizeCheck({ id: 'invalid', expect: [expect] });
    assert.throws(invalid({ ...each('#good .date'), matches: '[' }), /正则/);
    assert.throws(invalid({ ...each('#good .date'), minMatches: 0 }), /minMatches/);
    assert.throws(invalid({ kind: 'attribute', selector: '#good', attribute: 'id', scope: 'all-visible' }), /scope/);
    assert.throws(invalid({ ...each('#good .date'), contains: '2026' }), /只能指定/);
    assert.throws(() => normalizeCheck({ id: 'invalid', steps: [{ action: 'waitFor', selector: '#ready', state: 'missing' }], expect: [each('#late .date')] }), /state/);
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('qa detectors: browser names and recoverable clipping retain real defects', { timeout: 120_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = workspaceFor(origin);
  try {
    const ws = loadWorkspace(root);
    ws.defaults.detect = { maxPerDetector: 30 };
    const run = await runQa(ws, { site: 'web', pages: ['/detector-regression'], viewports: [1280, 390], linkCheck: false });
    const by = (detector, target) => run.findings.filter(f => f.detector === detector && f.target === target);
    assert.equal(by('a11y-control-name', '#named-icon').length, 0, 'named descendant contributes to the button name');
    assert.equal(by('a11y-control-name', '#labelled').length, 0, 'aria-labelledby can reference hidden text');
    assert.equal(by('a11y-control-name', '#unlabeled-icon').length, 1, 'aria-hidden icon does not name its button');
    assert.equal(by('a11y-control-name', '#hidden-child-text').length, 1, 'aria-hidden text does not name its button');
    assert.equal(by('layout-text-clipped', '#sr-only').length, 0, 'screen-reader-only text is intentionally clipped');
    assert.equal(by('layout-text-clipped', '#real-clip').length, 1, 'unrecoverable clipping remains reportable');
    assert.equal(by('layout-text-clipped', '#wrong-title').length, 1, 'an unrelated title does not restore clipped text');
    assert.equal(by('layout-text-clipped', '#table-outer').length, 0, 'a scrollable table is not lost text');
    const tableHeader = by('layout-text-clipped', '#table-header');
    assert.equal(tableHeader.length, 1);
    assert.equal(tableHeader[0].tier, 'tolerable', 'a matching table scroller needs review, not an automatic bug');
    const tooltip = by('layout-text-clipped', '#title-clip');
    assert.equal(tooltip.length, 1);
    assert.ok(tooltip.every(f => f.tier === 'tolerable'), 'a matching title is a usability observation, not lost text');
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa login redirect: do not inspect, click or baseline a login page as business content', { timeout: 120_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = workspaceFor(origin);
  try {
    const configFile = join(root, '.heimdall', 'qa.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.sites.web.login = 'user';
    config.sites.web.loginPath = '/login';
    writeFileSync(configFile, JSON.stringify(config));
    const ws = loadWorkspace(root);
    const good = await runQa(ws, { site: 'web', pages: ['/pricing'], viewports: [1280], linkCheck: false });
    writeBaseline(ws, good.run, good.run.coverage.pages);
    const before = readBaseline(ws);
    const run = await runQa(ws, {
      site: 'web', pages: ['/guarded'], viewports: [1280], linkCheck: false, explore: true,
      checks: [
        { id: 'guarded-check', path: '/guarded', steps: [{ action: 'click', selector: '#login-retry' }], expect: [{ kind: 'visible', selector: '#login-retry' }] },
        { id: 'expires-during-check', path: '/guarded-after', steps: [{ action: 'click', selector: '#expire-session' }, { action: 'click', selector: '#login-retry' }], expect: [{ kind: 'visible', selector: '#login-retry' }] },
      ],
    });
    assert.ok(run.findings.some(f => f.kind === 'login-expired' && f.confidence === 'environment'));
    assert.ok(!run.findings.some(f => f.detector || f.kind === 'regression' || f.kind === 'assertion'));
    assert.equal(run.run.coverage.pages[0].unavailableReason, 'login-expired');
    assert.equal(run.run.coverage.baseline.compared, 0);
    assert.equal(run.run.coverage.checks[0].blockedReason, 'login-expired');
    assert.equal(run.run.coverage.checks[1].blockedReason, 'login-expired');
    assert.equal(srv.hits.loginClick, 0, 'neither checks nor exploration click the login page');
    assert.throws(() => writeBaseline(ws, run.run, run.run.coverage.pages), /登录/);
    assert.deepEqual(readBaseline(ws), before, 'an unusable run cannot replace the approved baseline');
    const ci = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/guarded'], viewports: [1280], linkCheck: false, failOn: 'none' }, { client: 'mcp' });
    assert.equal(ci.error.code, 'qa_incomplete');
    assert.equal(ci.result.ci.status, 'incomplete');
    const cli = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'qa', 'ci', 'web',
        '--workspace', root, '--pages', '/guarded', '--viewports', '1280', '--fail-on', 'none', '--json'], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, envelope: JSON.parse(stdout.trim().split(/\r?\n/).at(-1)) }));
    });
    assert.equal(cli.code, 3);
    assert.equal(cli.envelope.error.code, 'qa_incomplete');
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa detector failure: report incomplete coverage and prevent a passing CI result', { timeout: 120_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = workspaceFor(origin);
  try {
    const ws = loadWorkspace(root);
    const run = await runQa(ws, { site: 'web', pages: ['/detector-failure'], viewports: [1280], linkCheck: false });
    assert.equal(run.run.coverage.pages[0].detectorError, 'detector-failed');
    assert.equal(run.run.coverage.detection.pages, 0);
    assert.deepEqual(run.run.coverage.detection.failedPages, [{ path: '/detector-failure', viewport: '1280x900' }]);
    assert.match(readFileSync(run.files.report, 'utf8'), /检测器执行失败/);
    assert.match(readFileSync(run.files.bugs, 'utf8'), /未完成检查/);
    assert.doesNotMatch(readFileSync(run.files.report, 'utf8'), /fixture secret/);
    const ci = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/detector-failure'], viewports: [1280], linkCheck: false, failOn: 'none' }, { client: 'mcp' });
    assert.equal(ci.error.code, 'qa_incomplete');
    assert.equal(ci.result.ci.status, 'incomplete');
    assert.match(ci.result.ci.incompleteReasons.join(' '), /检测器/);
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa ci: a failed page navigation is incomplete even with fail-on none', { timeout: 120_000 }, async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/disconnect') return req.socket.destroy();
    res.writeHead(503, { 'content-type': 'text/html' }); res.end('<title>Unavailable</title>');
  });
  await new Promise(done => srv.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = workspaceFor(origin);
  try {
    const ci = await invoke('qa_ci', { workspace: root, site: 'web', pages: ['/', '/disconnect'], viewports: [1280], linkCheck: false, failOn: 'none' }, { client: 'mcp' });
    assert.equal(ci.error?.code, 'qa_incomplete', 'unavailable pages cannot produce a green gate');
    assert.equal(ci.result.ci.status, 'incomplete');
    assert.equal(ci.result.navigation.failedPages[0].error, 'HTTP 503');
    assert.equal(ci.result.navigation.failedPages.length, 2);
    assert.match(ci.result.ci.incompleteReasons.join(' '), /页面/);
    const cli = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'qa', 'ci', 'web',
        '--workspace', root, '--pages', '/', '--viewports', '1280', '--no-links', '--fail-on', 'none', '--json'], { windowsHide: true });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, envelope: JSON.parse(stdout.trim().split(/\r?\n/).at(-1)) }));
    });
    assert.equal(cli.code, 3);
    assert.equal(cli.envelope.error.code, 'qa_incomplete');
    assert.equal(cli.envelope.result.navigation.failedPages[0].error, 'HTTP 503');
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});

function workspaceFor(origin) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-e2e-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, 'keys.md'), 'JWT: eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo3fQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ\n');
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'Fixture',
    sites: {
      web: { url: `${origin}/`, pages: ['/', '/pricing'], environment: 'test' },
      app: { url: `${origin}/`, pages: ['/console'], login: 'user', loggedOutText: ['请登录'], environment: 'test' },
      anon: { url: `${origin}/`, pages: ['/console'], login: 'stale', loggedOutText: ['请登录'], environment: 'test' },
    },
    logins: {
      user: { kind: 'localStorage', origin, items: { _token: { fromFile: 'keys.md', match: 'jwt' } } },
      stale: { kind: 'localStorage', origin, items: { _other: 'x' } },
    },
    defaults: { settleMs: 300, timeoutMs: 15000 },
  }));
  writeFileSync(join(root, 'checks.json'), JSON.stringify({ checks: [
    { id: 'copy-ip', title: '复制按钮复制出 IP:端口', path: '/', steps: [{ action: 'click', selector: '#copy' }], expect: [{ kind: 'clipboard', matches: '^\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+$' }], prd: 'PRD §2.1' },
    { id: 'price', title: '定价页显示月价', path: '/pricing', expect: [{ kind: 'text', selector: '#price', contains: '¥95' }] },
    { id: 'typo', title: '套餐卡片存在', path: '/pricing', expect: [{ kind: 'text', selector: '#plan-card', contains: '套餐' }], tier: 'wall', loss: '访客看不到套餐' },
  ] }));
  return root;
}

test('qa header login: credentials stay on the configured origin across assets, redirects and exploration', { timeout: 120_000 }, async () => {
  const seen = { trusted: [], other: [] };
  let origin;
  const untrusted = createServer((req, res) => {
    seen.other.push({ path: req.url, method: req.method, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    if (req.url === '/back') { res.writeHead(302, { location: `${origin}/returned` }); return res.end(); }
    if (req.url === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(`<img src="${origin}/from-foreign-frame"><script>fetch('${origin}/query-foreign', {method:'POST', mode:'no-cors'}).catch(()=>{})</script>`);
    }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end();
  });
  await new Promise(done => untrusted.listen(0, '127.0.0.1', done));
  const other = `http://localhost:${untrusted.address().port}`;
  const trusted = createServer((req, res) => {
    seen.trusted.push({ path: req.url, method: req.method, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    if (req.url === '/redirect') { res.writeHead(302, { location: `${other}/redirected` }); return res.end(); }
    if (req.url === '/return') { res.writeHead(302, { location: `${other}/back` }); return res.end(); }
    if (req.url === '/query-redirect') { res.writeHead(307, { location: '/forbidden' }); return res.end(); }
    if (req.url === '/own-frame') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<img src="/from-own-frame">'); }
    if (req.url !== '/') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<html lang="zh-CN"><title>Fixture</title><h1>Fixture</h1><img src="${other}/asset" alt="asset"><img src="/redirect" alt="redirect"><img src="/return" alt="return"><iframe src="${other}/frame"></iframe><iframe src="/own-frame"></iframe><a href="/redirect">link</a><a href="/return">return</a><script>fetch('/query-ok',{method:'POST'}).catch(()=>{}); fetch('/query-redirect',{method:'POST'}).catch(()=>{}); window.open('${other}/popup'); window.open('/popup-own')</script></html>`);
  });
  await new Promise(done => trusted.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${trusted.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-header-origin-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  const authorization = 'Bearer fixture-authorization-value';
  const apiKey = 'fixture-api-key-value';
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'Header origin fixture', sites: { web: { url: origin, pages: ['/'], login: 'headers', writes: { allow:
      ['/query-ok', '/query-redirect', '/query-foreign'].map(path => ({ method: 'POST', origin, path })) } } },
    logins: { headers: { kind: 'headers', headers: { Authorization: authorization, 'X-Api-Key': apiKey } } },
    defaults: { settleMs: 100, timeoutMs: 15000 },
  }));
  try {
    const ws = loadWorkspace(root);
    const result = await runQa(ws, { site: 'web', pages: ['/'], viewports: [1280], linkCheck: true, detect: false, baseline: false, explore: true, exploreMax: 0,
      checks: [{ id: 'title', path: '/', expect: [{ kind: 'title', equals: 'Fixture' }] }] });
    assert.ok(seen.trusted.some(r => r.authorization === authorization && r.apiKey === apiKey), 'configured origin receives the login headers');
    assert.ok(seen.other.some(r => r.path === '/asset'), `cross-origin asset was requested: ${JSON.stringify({ pages: result.run.coverage.pages, paths: seen.trusted.map(r => r.path), errors: result.findings.filter(f => ['network', 'console'].includes(f.kind)).map(f => f.observed) })}`);
    assert.ok(seen.other.some(r => r.path === '/redirected'), 'cross-origin redirect was followed');
    assert.ok(seen.other.some(r => r.path === '/popup'), 'cross-origin popup was opened');
    assert.ok(seen.trusted.some(r => r.path === '/popup-own'), 'same-origin popup was opened');
    assert.ok(seen.trusted.filter(r => r.path === '/popup-own').every(r => !r.authorization && !r.apiKey), 'new popups do not inherit credentials');
    assert.ok(seen.trusted.some(r => r.path === '/from-own-frame' && r.authorization === authorization), 'same-origin frame receives credentials');
    assert.ok(seen.trusted.some(r => r.path === '/from-foreign-frame'), 'cross-origin frame reached the configured origin');
    assert.ok(!seen.trusted.some(r => r.path === '/query-foreign'), 'cross-origin frame cannot use the write whitelist');
    assert.ok(seen.trusted.filter(r => r.path === '/from-foreign-frame' || r.path === '/query-foreign').every(r => !r.authorization && !r.apiKey), 'cross-origin frame cannot cause header injection');
    assert.ok(seen.trusted.some(r => r.path === '/returned'), 'cross-origin redirect returned to the configured origin');
    assert.ok(seen.trusted.filter(r => r.path === '/returned').every(r => !r.authorization && !r.apiKey), 'redirect chains that leave trusted origins do not regain credentials');
    assert.ok(seen.trusted.some(r => r.path === '/query-ok' && r.authorization === authorization), 'allowlisted query retains credentials');
    assert.ok(seen.trusted.some(r => r.path === '/query-redirect'), 'allowlisted redirecting query was sent');
    assert.ok(!seen.trusted.some(r => r.path === '/forbidden'), '307 redirect cannot bypass the write whitelist');
    assert.ok(result.run.coverage.checks.some(c => c.id === 'title' && c.pass), 'checks retain authenticated navigation');
    assert.deepEqual(seen.other.filter(r => r.authorization || r.apiKey).map(r => ({ path: r.path, method: r.method,
      authorization: !!r.authorization, apiKey: !!r.apiKey })), [], 'no configured login header reaches another origin');
    for (const output of [JSON.stringify(result.run), JSON.stringify(result.findings), readFileSync(result.files.report, 'utf8'), readFileSync(result.files.bugs, 'utf8')]) {
      assert.ok(!output.includes(authorization) && !output.includes(apiKey), 'reports do not contain credentials');
    }
    const login = { contextOptions: { extraHTTPHeaders: { Authorization: authorization } } };
    const browser = await chromium.launch(qaBrowserLaunchOptions(login));
    try {
      const context = await browser.newContext({ serviceWorkers: 'block' });
      const site = { origin, writes: 'block', writeAllow: ['/query-ok', '/query-redirect', '/query-foreign'].map(path => ({ method: 'POST', origin, path })) };
      await context.route('**/*', route => routeQaRequest(route, { site, login }));
      const page = await newQaPage(context, { site, login });
      await page.goto(origin, { waitUntil: 'networkidle', timeout: 10000 });
      await context.close();
    } finally { await browser.close(); }
  } finally {
    trusted.close(); untrusted.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa header login: an explicit API origin receives credentials instead of the site origin', { timeout: 120_000 }, async () => {
  const seen = { site: [], api: [] };
  const api = createServer((req, res) => {
    seen.api.push(req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'image/png' }); res.end();
  });
  await new Promise(done => api.listen(0, '127.0.0.1', done));
  const apiOrigin = `http://localhost:${api.address().port}`;
  const site = createServer((req, res) => {
    seen.site.push(req.headers['x-api-key']);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Different origin</title><img src="${apiOrigin}/api">`);
  });
  await new Promise(done => site.listen(0, '127.0.0.1', done));
  const siteOrigin = `http://127.0.0.1:${site.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-header-api-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  const key = 'fixture-explicit-api-key';
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'API origin fixture', sites: { web: { url: siteOrigin, pages: ['/'], login: 'headers' } },
    logins: { headers: { kind: 'headers', origin: apiOrigin, headers: { 'X-Api-Key': key } } },
    defaults: { settleMs: 100, timeoutMs: 15000 },
  }));
  try {
    const result = await runQa(loadWorkspace(root), { site: 'web', viewports: [1280], linkCheck: false, detect: false, baseline: false });
    assert.equal(result.run.coverage.pages[0].navError, null);
    assert.ok(seen.site.length && seen.site.every(value => !value), 'site origin does not receive API credentials');
    assert.ok(seen.api.includes(key), 'explicit API origin receives credentials');
  } finally {
    site.close(); api.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa header login: interception setup fails closed', async () => {
  let closed = false;
  const browser = { newBrowserCDPSession: async () => ({ send: async () => ({ arguments: ['--site-per-process'] }), detach: async () => {} }) };
  const context = { browser: () => browser, newPage: async () => ({}), newCDPSession: async () => { throw new Error('fixture setup failure'); },
    close: async () => { closed = true; } };
  await assert.rejects(newQaPage(context, { site: { origin: 'http://example.test' },
    login: { contextOptions: { extraHTTPHeaders: { Authorization: 'fixture-secret' } } } }), /凭据隔离/);
  assert.equal(closed, true);
});

test('qa header login: an externally supplied browser without site isolation fails closed', { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ headless: true, args: ['--enable-automation'] });
  try {
    const context = await browser.newContext();
    await assert.rejects(newQaPage(context, { site: { origin: 'http://example.test' },
      login: { contextOptions: { extraHTTPHeaders: { Authorization: 'fixture-secret' } } } }), /凭据隔离/);
    assert.equal(context.pages().length, 0, 'context is closed on an unsafe setup');
  } finally { await browser.close(); }
});

test('qa run: text artifacts and exploration redact login secrets', { timeout: 120_000 }, async () => {
  const secret = 'fixture-visible-credential-value';
  const srv = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html lang="en"><title>Fixture</title><p>${secret}</p><button id="inspect" type="button" onclick="throw new Error('${secret}')">Inspect</button></html>`);
  });
  await new Promise(done => srv.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-secret-output-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, 'session.json'), JSON.stringify({ cookies: [], origins: [{ origin, localStorage: [{ name: 'token', value: secret }] }] }));
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'Secret fixture', sites: { web: { url: origin, pages: ['/'], login: 'headers' } },
    logins: { headers: { kind: 'headers', headers: { 'X-Api-Key': secret } }, state: { kind: 'storageState', file: 'session.json' } },
    defaults: { settleMs: 100, timeoutMs: 15000 },
  }));
  try {
    for (const login of ['headers', 'state']) {
      const result = await runQa(loadWorkspace(root), { site: 'web', login, viewports: [1280], linkCheck: false, detect: false, baseline: false,
        collectTexts: true, explore: true, exploreMax: 1, checks: [{ id: 'label', title: secret, path: '/', expect: [{ kind: 'title', equals: 'Fixture' }] }] });
      assert.ok(result.findings.some(f => f.kind === 'interaction'), 'exploration captured the page error');
      for (const file of ['texts.json', 'run.json', 'findings.json', 'report.md', 'bugs.md']) {
        assert.ok(!readFileSync(join(result.dir, file), 'utf8').includes(secret), `${login}: ${file} does not contain the credential`);
      }
      assert.ok(!JSON.stringify(result.run).includes(secret) && !JSON.stringify(result.findings).includes(secret));
    }
  } finally { srv.close(); rmSync(root, { recursive: true, force: true }); }
});

test('qa e2e: writes.allow whitelists read-semantics POST endpoints (POST-for-query backends)', { timeout: 120_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-allow-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'Allow',
    sites: { web: { url: `${origin}/`, pages: ['/'], environment: 'test', writes: { allow: [{ method: 'POST', origin, path: '/api/track' }] } } },
    defaults: { settleMs: 300, timeoutMs: 15000 },
  }));
  try {
    const ws = loadWorkspace(root);
    assert.deepEqual(ws.sites.web.writeAllow, [{ method: 'POST', origin, path: '/api/track' }]);
    const run = await runQa(ws, { site: 'web', viewports: [1280] });
    assert.deepEqual(run.run.requestPolicy, { mode: 'block', allowedQueries: [{ method: 'POST', origin, path: '/api/track' }] });
    assert.match(readFileSync(run.files.report, 'utf8'), /1 条精确 POST 例外/);
    assert.ok(!run.findings.some(f => f.kind === 'blocked-write'), 'allowlisted POST passes the read-only gate');
    assert.ok(!run.findings.some(f => /BLOCKED_BY_CLIENT/.test(f.title ?? '')), 'no blocked-by-client console noise');
    assert.ok(srv.hits.trackPost > 0, 'the whitelisted POST actually reached the server');
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa ci MCP capability runs the workspace and writes gate sidecars', { timeout: 120_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = workspaceFor(origin);
  try {
    const env = await invoke('qa_ci', {
      workspace: root,
      site: 'web',
      pages: ['/'],
      viewports: [1280],
      linkCheck: false,
      failOn: 'none',
    }, { client: 'mcp' });
    assert.equal(env.ok, true, JSON.stringify(env.error));
    assert.equal(env.result.ci.status, 'passed');
    assert.ok(existsSync(join(root, '.heimdall', 'qa', 'runs', env.result.runId, 'qa-ci.json')));
    assert.ok(existsSync(join(root, '.heimdall', 'qa', 'runs', env.result.runId, 'qa-ci.md')));
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('qa e2e: probe, login profile, real clipboard, verdict memory across runs, agent submissions', { timeout: 180_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = workspaceFor(origin);
  try {
    const ws = loadWorkspace(root);
    const first = await runQa(ws, { site: 'web', checksFile: 'checks.json', viewports: [1280] });
    const kinds = new Set(first.findings.map(f => f.kind));
    for (const k of ['broken-link', 'broken-image', 'overflow', 'console', 'network', 'blocked-write']) assert.ok(kinds.has(k), `detects ${k}`);
    const blocked = first.findings.find(f => f.kind === 'blocked-write');
    const target = `${origin}/api/track`;
    assert.equal(blocked.fingerprint, fingerprintOf({ site: 'web', path: '/', kind: 'blocked-write', target,
      text: `打开页面就发了写请求，已拦下：POST ${target.slice(-60)}` }), 'existing verdict fingerprints are retained');
    const checks = Object.fromEntries(first.run.coverage.checks.map(c => [c.id, c.pass]));
    assert.equal(checks['copy-ip'], true, 'clipboard check passes with a real click and granted permission');
    assert.equal(checks.price, true);
    assert.equal(checks.typo, false);
    const typo = first.findings.find(f => f.kind === 'assertion');
    assert.equal(typo.confidence, 'check-unverified', 'missing element = the check needs fixing, not a product bug');
    assert.equal(fileable(typo), false);
    const link = first.findings.find(f => f.kind === 'broken-link');
    assert.equal(link.tier, 'degrade');
    assert.ok(fileable(link), 'a broken same-origin link is worth filing');
    const bugs = readFileSync(first.files.bugs, 'utf8');
    assert.match(bugs, /链接打不开/);
    assert.doesNotMatch(bugs, /横向溢出|控制台报错/, 'tolerable findings stay out of bugs.md');
    assert.ok(existsSync(join(first.dir, 'shots')));

    recordVerdict(ws.dataDir, { verdict: 'false-positive', reason: '文档页还没上线，已知', match: { fingerprint: link.fingerprint } });
    recordVerdict(ws.dataDir, { verdict: 'by-design', reason: '埋点接口，正常', match: { kind: 'blocked-write', text: '/api/track' } });
    const second = await runQa(ws, { site: 'web', viewports: [1280], checks: [] });
    const link2 = second.findings.find(f => f.fingerprint === link.fingerprint);
    assert.equal(link2.triage.status, 'suppressed', 'same problem, second run: filtered by the recorded verdict');
    assert.equal(second.findings.find(f => f.kind === 'blocked-write').triage.status, 'suppressed', 'pattern rule');
    assert.match(readFileSync(second.files.report, 'utf8'), /按以往裁决过滤掉的/);

    const sub = submitFindings(ws, second.run.runId, [
      { title: '定价页「月付」和「年付」切换后价格没变', path: '/pricing', basis: 'wrong', tier: 'degrade', loss: '想看年付价的访客看到的还是月付价（实测 3 次）', evidence: { observed: '切换后 #price 仍为 ¥95/月' } },
      { title: '首页加载可能偏慢', basis: 'friction', tier: 'degrade', loss: '用户可能流失', evidence: { observed: '体感' } },
      { title: '没证据的猜测', basis: 'wrong' },
    ]);
    assert.equal(sub.added.length, 1);
    assert.equal(sub.rejected.length, 2);
    assert.ok(fileable(sub.added[0]));
    const again = submitFindings(ws, second.run.runId, [{ title: '定价页「月付」和「年付」切换后价格没变', path: '/pricing', basis: 'wrong', evidence: { observed: 'x' } }]);
    assert.match(again.rejected[0].problems[0], /已经有同一条/);

    const login = await runQa(ws, { site: 'app', viewports: [1280], linkCheck: false });
    assert.ok(!login.findings.some(f => f.kind === 'login-expired'), 'declared localStorage login takes effect before page scripts run');
    const stale = await runQa(ws, { site: 'anon', viewports: [1280], linkCheck: false });
    const expired = stale.findings.find(f => f.kind === 'login-expired');
    assert.ok(expired, 'logged-out page is reported as an environment problem');
    assert.equal(fileable(expired), false);
    assert.match(readFileSync(stale.files.report, 'utf8'), /环境问题/);
    assert.ok(!readFileSync(join(stale.dir, 'findings.json'), 'utf8').includes('c2lnbmF0dXJl'), 'no credential value in run files');

    const env = await invoke('qa_findings', { workspace: root, action: 'verdict', runId: second.run.runId, id: sub.added[0].id, verdict: 'bug', reason: '已提单' }, { client: 'mcp' });
    assert.equal(env.ok, true, JSON.stringify(env.error));
    assert.equal(readRun(ws, second.run.runId).findings.find(f => f.id === sub.added[0].id).triage.status, 'known-bug');
    const status = await invoke('qa_status', { workspace: root }, { client: 'mcp' });
    assert.equal(status.ok, true);
    assert.equal(status.result.logins.find(l => l.name === 'user').ready, true);
    assert.ok(status.result.guidance.triageRules.length >= 5);
    const missing = await invoke('qa_status', { workspace: join(tmpdir(), 'no-such-qa-ws') }, { client: 'mcp' });
    assert.equal(missing.error.code, 'not_found');
    retriageRun(ws, second.run.runId);
  } finally {
    srv.close();
    rmSync(root, { recursive: true, force: true });
  }
});
