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
import { loadWorkspace } from '../src/qa/workspace.mjs';
import { runQa, submitFindings, retriageRun, readRun } from '../src/qa/run.mjs';
import { recordVerdict } from '../src/qa/memory.mjs';
import { fileable } from '../src/qa/report.mjs';
import { writeBaseline, readBaseline } from '../src/qa/baseline.mjs';
import { invoke } from '../src/agent/registry/invoke.mjs';

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

test('qa e2e: writes.allow whitelists read-semantics POST endpoints (POST-for-query backends)', { timeout: 120_000 }, async () => {
  const srv = await server();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const root = mkdtempSync(join(tmpdir(), 'heimdall-qa-allow-'));
  mkdirSync(join(root, '.heimdall'), { recursive: true });
  writeFileSync(join(root, '.heimdall', 'qa.json'), JSON.stringify({
    project: 'Allow',
    sites: { web: { url: `${origin}/`, pages: ['/'], environment: 'test', writes: { allow: ['/api/track'] } } },
    defaults: { settleMs: 300, timeoutMs: 15000 },
  }));
  try {
    const ws = loadWorkspace(root);
    assert.deepEqual(ws.sites.web.writeAllow, ['/api/track']);
    const run = await runQa(ws, { site: 'web', viewports: [1280] });
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
