import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  parseFigmaUrl, normalizeNodeId, safeNodeId, pullDesign, createFigmaClient, selectFrames, extractFrame,
  budgetFile, budgetStatus, humanWait, DESIGN_SCHEMA,
} from '../src/design/figma.mjs';

const TOKEN = 'figd_TEST-token-ABCDEF0123456789';
const FILE_KEY = 'TestFileKey0123456789A';
const URL_105 = `https://www.figma.com/design/${FILE_KEY}/Xspark?node-id=105-3`;
const DAY = 86_400_000;

function pngBytes(width, height, rgb = [255, 0, 0]) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([...rgb, 255], i);
  return PNG.sync.write(png);
}

const solid = (r, g, b, extra = {}) => ({ type: 'SOLID', color: { r, g, b, a: 1 }, ...extra });
const box = (x, y, width, height) => ({ x, y, width, height });
const text = (id, characters, abs, style, fills) => ({ id, name: characters.slice(0, 12), type: 'TEXT', characters, absoluteBoundingBox: abs, style, fills });

function canvasDoc() {
  return {
    id: '105:3', name: '首页', type: 'CANVAS',
    children: [
      {
        id: '105:10', name: '首页', type: 'FRAME', absoluteBoundingBox: box(100, 200, 375, 812), fills: [solid(1, 1, 1)],
        children: [
          text('105:11', '欢迎使用 Xspark', box(116, 264, 200, 32), { fontFamily: 'PingFang SC', fontSize: 24, fontWeight: 600, lineHeightPx: 32 },
            [solid(0, 0, 0, { visible: false }), solid(0.1, 0.2, 0.3)]),
          text('105:12', '¥99/月', box(116, 400, 80, 40), { fontFamily: 'PingFang SC', fontSize: 32, fontWeight: 700, lineHeightPx: 40 }, [solid(1, 0.35, 0)]),
          { ...text('105:13', '隐藏的提示', box(116, 500, 80, 20), { fontFamily: 'PingFang SC', fontSize: 12, fontWeight: 400 }, [solid(0.5, 0.5, 0.5)]), visible: false },
        ],
      },
      { id: '105:14', name: '旁注', type: 'TEXT', characters: '画板外的说明', visible: true, absoluteBoundingBox: box(0, 0, 10, 10) },
      {
        id: '105:20', name: '定价', type: 'FRAME', absoluteBoundingBox: box(600, 200, 375, 812), fills: [solid(1, 1, 1)],
        children: [
          text('105:21', '选择套餐', box(616, 240, 120, 28), { fontFamily: 'Inter', fontSize: 20, fontWeight: 700, lineHeightPx: 28 }, [solid(0.1, 0.2, 0.3)]),
          { id: '105:22', name: '隐藏组', type: 'GROUP', visible: false, children: [text('105:23', '不该出现', box(0, 0, 1, 1), { fontFamily: 'Inter', fontSize: 9 }, [solid(0, 1, 0)])] },
        ],
      },
    ],
  };
}

const nodesBody = (version = '42') => ({ name: 'Xspark', lastModified: '2026-10-01T00:00:00Z', version, nodes: { '105:3': { document: canvasDoc() } } });

/** 本机 Figma 桩：按路径记录请求；routes 可覆盖默认响应，返回 false 时回落到默认 */
async function startMock(t, routes = {}) {
  const log = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const entry = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), token: req.headers['x-figma-token'] ?? null };
    log.push(entry);
    const send = (status, body, headers = {}) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      res.writeHead(status, { 'content-type': Buffer.isBuffer(body) ? 'image/png' : 'application/json', ...headers });
      res.end(buf);
    };
    const kind = url.pathname.endsWith('/meta') ? 'meta' : url.pathname.endsWith('/nodes') ? 'nodes'
      : url.pathname.startsWith('/v1/images/') ? 'images' : url.pathname.startsWith('/s3/') ? 's3' : 'other';
    entry.kind = kind;
    const custom = routes[kind];
    if (custom && custom(req, res, { send, url, entry, count: log.filter(e => e.kind === kind).length, base }) !== false) return;
    if (kind === 'meta') return send(200, { file: { name: 'Xspark', version: '42', last_touched_at: '2026-10-01T00:00:00Z' } });
    if (kind === 'nodes') return send(200, nodesBody());
    if (kind === 'images') {
      const ids = url.searchParams.get('ids').split(',');
      return send(200, { err: null, images: Object.fromEntries(ids.map(id => [id, `${base}/s3/${encodeURIComponent(id)}.png?sig=abc`])) });
    }
    if (kind === 's3') return send(200, pngBytes(url.pathname.includes('105%3A10') ? 4 : 3, 2));
    send(404, { status: 404, err: 'Not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  return { base, log, tier1: () => log.filter(e => e.kind === 'nodes' || e.kind === 'images') };
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-design-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const pullOpts = (base, cacheDir, extra = {}) => ({ url: URL_105, cacheDir, token: TOKEN, apiBase: base, env: {}, ...extra });

/* ---------------- 链接 ---------------- */

test('parseFigmaUrl: design / file / proto / branch / 编码的 node-id', () => {
  assert.deepEqual(parseFigmaUrl(URL_105), { fileKey: FILE_KEY, nodeId: '105:3' });
  assert.deepEqual(parseFigmaUrl(`https://figma.com/file/${FILE_KEY}/Xspark?node-id=105%3A3&t=abc-1`), { fileKey: FILE_KEY, nodeId: '105:3' });
  assert.deepEqual(parseFigmaUrl(`https://www.figma.com/proto/${FILE_KEY}/Xspark?node-id=1-2&starting-point-node-id=1%3A2`), { fileKey: FILE_KEY, nodeId: '1:2' });
  assert.deepEqual(parseFigmaUrl(`https://www.figma.com/design/${FILE_KEY}/branch/BrAnCh123/Xspark?node-id=7-8`), { fileKey: FILE_KEY, nodeId: '7:8', branchKey: 'BrAnCh123' });
  assert.deepEqual(parseFigmaUrl(`https://www.figma.com/design/${FILE_KEY}/Xspark`), { fileKey: FILE_KEY, nodeId: null });
  assert.equal(parseFigmaUrl(`https://www.figma.com/design/${FILE_KEY}/X?node-id=105:3`).nodeId, '105:3');
  assert.equal(normalizeNodeId('I1-2;3-4'), 'I1:2;3:4');
  assert.equal(safeNodeId('I1:2;3:4'), 'I1-2_3-4');
});

test('parseFigmaUrl: 拒绝别的主机与残缺链接', () => {
  for (const bad of [
    `https://evil.com/design/${FILE_KEY}/X?node-id=1-2`,
    `https://figma.com.evil.com/design/${FILE_KEY}/X`,
    `https://notfigma.com/design/${FILE_KEY}/X`,
    `ftp://www.figma.com/design/${FILE_KEY}/X`,
    'https://www.figma.com/community/file/123',
    'https://www.figma.com/design/',
    `https://www.figma.com/design/${FILE_KEY}/X?node-id=abc`,
    'not a url',
  ]) assert.throws(() => parseFigmaUrl(bad), { code: 'figma_bad_url' }, bad);
});

test('humanWait 用天 / 小时 / 分钟', () => {
  assert.equal(humanWait(172_800), '约 2 天');
  assert.equal(humanWait(5_400), '约 1.5 小时');
  assert.equal(humanWait(300), '约 5 分钟');
  assert.equal(humanWait(12), '12 秒');
});

/* ---------------- 拉取、缓存、额度 ---------------- */

test('pullDesign: 两次一级调用拉下画板、文字、颜色与 PNG；再拉走缓存，零请求', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  const { design, dir, cached } = await pullDesign(pullOpts(mock.base, cacheDir));
  assert.equal(cached, false);
  assert.equal(dir, join(cacheDir, FILE_KEY, '105-3'));

  assert.equal(mock.tier1().length, 2);
  const nodesReq = mock.log.find(e => e.kind === 'nodes'), imagesReq = mock.log.find(e => e.kind === 'images');
  assert.deepEqual(nodesReq.query, { ids: '105:3' });
  assert.deepEqual(imagesReq.query, { ids: '105:10,105:20', format: 'png', scale: '1' });
  assert.ok(mock.log.filter(e => e.kind !== 's3').every(e => e.token === TOKEN), 'API 请求带 X-Figma-Token');
  assert.ok(mock.log.filter(e => e.kind === 's3').every(e => e.token === null), '图片下载不带令牌');
  assert.deepEqual(mock.log.map(e => e.kind), ['meta', 'nodes', 'images', 's3', 's3']);

  assert.equal(design.schema, DESIGN_SCHEMA);
  assert.deepEqual({ ...design.source, fetchedAt: undefined }, {
    via: 'api', fileKey: FILE_KEY, nodeId: '105:3', name: 'Xspark', version: '42', lastModified: '2026-10-01T00:00:00Z', fetchedAt: undefined, scale: 1,
  });
  assert.ok(Date.parse(design.source.fetchedAt));
  assert.deepEqual(design.root, { id: '105:3', name: '首页', type: 'CANVAS', split: 'children', available: 2, truncated: false });
  assert.deepEqual(design.frames.map(f => [f.id, f.name, f.type, f.width, f.height]), [['105:10', '首页', 'FRAME', 375, 812], ['105:20', '定价', 'FRAME', 375, 812]]);

  const [home, pricing] = design.frames;
  assert.deepEqual(home.texts[0], {
    id: '105:11', name: '欢迎使用 Xspark', characters: '欢迎使用 Xspark', fontFamily: 'PingFang SC', fontSize: 24, fontWeight: 600, lineHeightPx: 32,
    color: '#1a334d', box: { x: 16, y: 64, w: 200, h: 32 },
  });
  assert.deepEqual(home.texts.map(x => x.characters), ['欢迎使用 Xspark', '¥99/月'], 'visible: false 的 TEXT 被跳过');
  assert.deepEqual(home.colors, [{ hex: '#ffffff', count: 1 }, { hex: '#1a334d', count: 1 }, { hex: '#ff5900', count: 1 }], '隐藏的填充与隐藏节点的颜色不计');
  assert.deepEqual(home.fonts, [{ family: 'PingFang SC', size: 24, weight: 600, count: 1 }, { family: 'PingFang SC', size: 32, weight: 700, count: 1 }]);
  assert.deepEqual(pricing.texts.map(x => x.characters), ['选择套餐'], '隐藏组里的文字被跳过');
  assert.ok(!pricing.colors.some(c => c.hex === '#00ff00'));

  assert.equal(home.image, 'frames/105-10.png');
  assert.deepEqual([home.imageWidth, home.imageHeight, pricing.imageWidth], [4, 2, 3]);
  assert.deepEqual(readdirSync(join(dir, 'frames')).sort(), ['105-10.png', '105-20.png']);
  assert.equal(PNG.sync.read(readFileSync(join(dir, 'frames', '105-20.png'))).width, 3);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8')), design);
  assert.ok(JSON.parse(readFileSync(join(dir, 'raw-nodes.json'), 'utf8')).nodes['105:3'].document.children.length === 3);

  const ledger = JSON.parse(readFileSync(budgetFile(cacheDir), 'utf8'));
  assert.deepEqual(ledger.calls.map(c => [c.kind, c.key]), [['nodes', FILE_KEY], ['images', FILE_KEY]]);
  assert.equal(budgetStatus(budgetFile(cacheDir)).used, 2);
  assert.ok(!readFileSync(budgetFile(cacheDir), 'utf8').includes(TOKEN));

  const before = mock.log.length;
  const again = await pullDesign(pullOpts(mock.base, cacheDir));
  assert.equal(again.cached, true);
  assert.deepEqual(again.design, design);
  assert.equal(mock.log.length, before, '有缓存时不发任何请求');
});

test('pullDesign: 额度用完时 refresh 在发请求前拒绝；force 绕过并照样记账', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  await pullDesign(pullOpts(mock.base, cacheDir, { monthlyBudget: 2 }));
  const before = mock.log.length;
  await assert.rejects(pullDesign(pullOpts(mock.base, cacheDir, { monthlyBudget: 2, refresh: true })), (error) => {
    assert.equal(error.code, 'figma_budget_exhausted');
    assert.match(error.message, /已调用 2 次，上限 2 次/);
    assert.match(error.message, /最早一次在 \d{4}-\d\d-\d\dT[\d:.]+Z 移出 30 天窗口（约 30 天后）/);
    assert.match(error.message, /force: true/);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.equal(mock.log.length, before, '拒绝时一个请求都不发');

  const forced = await pullDesign(pullOpts(mock.base, cacheDir, { monthlyBudget: 2, refresh: true, force: true }));
  assert.equal(forced.cached, false);
  assert.equal(mock.tier1().length, 4);
  assert.equal(mock.log.filter(e => e.kind === 'meta').length, 2, 'force 只绕过一级额度，三级的 meta 预检照做');
  assert.equal(budgetStatus(budgetFile(cacheDir), { monthlyBudget: 2 }).used, 4);

  await pullDesign(pullOpts(mock.base, cacheDir, { refresh: true, force: true, preflight: false }));
  assert.equal(mock.log.filter(e => e.kind === 'meta').length, 2, 'preflight: false 跳过 meta');
});

test('pullDesign: 只剩 1 次额度时整次拉取在开始前拒绝，不花半次', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  const at = new Date(Date.now() - 29 * DAY).toISOString();
  writeFileSync(budgetFile(cacheDir), JSON.stringify({ calls: Array.from({ length: 5 }, () => ({ at, kind: 'nodes' })) }));
  await assert.rejects(pullDesign(pullOpts(mock.base, cacheDir)), (error) => {
    assert.equal(error.code, 'figma_budget_exhausted');
    assert.match(error.message, /已调用 5 次，上限 6 次.*需要 2 次/);
    assert.match(error.message, /约 1 天后/);
    return true;
  });
  assert.equal(mock.log.length, 0);
});

test('pullDesign: 30 天以前的调用不计数', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  const old = new Date(Date.now() - 31 * DAY).toISOString();
  writeFileSync(budgetFile(cacheDir), JSON.stringify({ calls: Array.from({ length: 6 }, () => ({ at: old, kind: 'nodes' })) }));
  await pullDesign(pullOpts(mock.base, cacheDir));
  const ledger = JSON.parse(readFileSync(budgetFile(cacheDir), 'utf8'));
  assert.equal(ledger.calls.length, 2, '过期记录在写入时清掉');
});

test('pullDesign: 账本损坏时拒绝，不当成清零', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  writeFileSync(budgetFile(cacheDir), '{ not json');
  await assert.rejects(pullDesign(pullOpts(mock.base, cacheDir)), { code: 'figma_budget_corrupt' });
  assert.equal(mock.log.length, 0);
});

/* ---------------- 429 与错误消息 ---------------- */

test('429 且 Retry-After 172800：不重试，抛 figma_rate_limited，写明天数、类型与升级入口，并记下封锁', async t => {
  const mock = await startMock(t, {
    nodes: (req, res, { send }) => send(429, { status: 429, err: 'Rate limit exceeded' }, {
      'retry-after': '172800', 'x-figma-rate-limit-type': 'low', 'x-figma-plan-tier': 'starter', 'x-figma-upgrade-link': 'https://www.figma.com/upgrade',
    }),
  });
  const cacheDir = tempDir(t), slept = [];
  await assert.rejects(pullDesign(pullOpts(mock.base, cacheDir, { sleep: async ms => { slept.push(ms); } })), (error) => {
    assert.equal(error.code, 'figma_rate_limited');
    assert.equal(error.status, 429);
    assert.match(error.message, /约 2 天/);
    assert.match(error.message, /限流类型 low/);
    assert.match(error.message, /https:\/\/www\.figma\.com\/upgrade/);
    assert.equal(error.details.retryAfterSeconds, 172800);
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.equal(mock.log.filter(e => e.kind === 'nodes').length, 1, '不重试');
  assert.equal(mock.log.filter(e => e.kind === 'images').length, 0);
  assert.deepEqual(slept, []);
  assert.equal(budgetStatus(budgetFile(cacheDir)).used, 1, '被 429 的那次也算一次调用');

  const before = mock.log.length;
  await assert.rejects(pullDesign(pullOpts(mock.base, cacheDir)), (error) => {
    assert.equal(error.code, 'figma_rate_limited');
    assert.equal(error.details.local, true);
    assert.match(error.message, /还要约 2 天/);
    return true;
  });
  assert.equal(mock.log.length, before, '封锁期内本地就拒绝，不再请求');
});

test('429 且 Retry-After 1：等 1 秒后重试一次并成功，重试也记账', async t => {
  const mock = await startMock(t, {
    nodes: (req, res, { send, count }) => (count === 1 ? send(429, { status: 429, err: 'Rate limit exceeded' }, { 'retry-after': '1' }) : false),
  });
  const cacheDir = tempDir(t), slept = [];
  const { design } = await pullDesign(pullOpts(mock.base, cacheDir, { sleep: async ms => { slept.push(ms); } }));
  assert.equal(design.frames.length, 2);
  assert.deepEqual(slept, [1000]);
  assert.equal(mock.log.filter(e => e.kind === 'nodes').length, 2);
  const calls = JSON.parse(readFileSync(budgetFile(cacheDir), 'utf8')).calls;
  assert.deepEqual(calls.map(c => [c.kind, Boolean(c.retry)]), [['nodes', false], ['nodes', true], ['images', false]]);
});

test('429 连续两次（Retry-After 1）：只重试一次，第二次直接抛', async t => {
  const mock = await startMock(t, { nodes: (req, res, { send }) => send(429, {}, { 'retry-after': '1' }) });
  await assert.rejects(pullDesign(pullOpts(mock.base, tempDir(t), { sleep: async () => {} })), { code: 'figma_rate_limited' });
  assert.equal(mock.log.filter(e => e.kind === 'nodes').length, 2);
});

test('403 / 404 给出清楚的原因；令牌不出现在任何错误消息里', async t => {
  const echo = (status) => (req, res, { send }) => send(status, { status, err: `bad token ${req.headers['x-figma-token']}` });
  const cases = [
    { routes: { meta: echo(403), nodes: echo(403) }, code: 'figma_forbidden', re: /file_content:read/ },
    { routes: { meta: echo(404) }, code: 'figma_not_found', re: /检查链接/ },
    { routes: { nodes: echo(500) }, code: 'figma_server_error', re: /HTTP 500/ },
  ];
  for (const c of cases) {
    const mock = await startMock(t, c.routes);
    await assert.rejects(pullDesign(pullOpts(mock.base, tempDir(t))), (error) => {
      assert.equal(error.code, c.code);
      assert.match(error.message, c.re);
      assert.ok(!error.message.includes(TOKEN), `${c.code} 消息含令牌：${error.message}`);
      assert.ok(!String(error.stack).includes(TOKEN));
      assert.ok(!JSON.stringify(error.details ?? {}).includes(TOKEN));
      return true;
    });
  }
});

test('meta 只缺范围时不挡拉取；meta 404 时省下一级调用', async t => {
  const scopeOnly = await startMock(t, { meta: (req, res, { send }) => send(403, { status: 403, err: 'Missing scope file_metadata:read' }) });
  const ok = await pullDesign(pullOpts(scopeOnly.base, tempDir(t)));
  assert.equal(ok.design.frames.length, 2);

  const gone = await startMock(t, { meta: (req, res, { send }) => send(404, { status: 404, err: 'Not found' }) });
  const cacheDir = tempDir(t);
  await assert.rejects(pullDesign(pullOpts(gone.base, cacheDir)), { code: 'figma_not_found' });
  assert.equal(gone.tier1().length, 0);
  assert.equal(existsSync(budgetFile(cacheDir)), false);
});

test('没有令牌：有缓存照常返回；要拉取时给出创建令牌的指引', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  await assert.rejects(pullDesign({ url: URL_105, cacheDir, apiBase: mock.base, env: {} }), (error) => {
    assert.equal(error.code, 'figma_no_token');
    assert.match(error.message, /Personal access tokens/);
    assert.match(error.message, /HEIMDALL_FIGMA_TOKEN/);
    return true;
  });
  assert.equal(mock.log.length, 0);
  await pullDesign(pullOpts(mock.base, cacheDir));
  const cached = await pullDesign({ url: URL_105, cacheDir, apiBase: mock.base, env: {} });
  assert.equal(cached.cached, true);
});

test('令牌与 apiBase 可从环境变量读；非 https 的远端 apiBase 被拒', async t => {
  const mock = await startMock(t);
  const { design } = await pullDesign({ url: URL_105, cacheDir: tempDir(t), env: { FIGMA_TOKEN: TOKEN, HEIMDALL_FIGMA_API: mock.base } });
  assert.equal(design.frames.length, 2);
  assert.ok(mock.log.filter(e => e.kind !== 's3').every(e => e.token === TOKEN));
  assert.throws(() => createFigmaClient({ token: TOKEN, env: {}, apiBase: 'http://example.com' }), { code: 'figma_bad_input' });
  assert.throws(() => createFigmaClient({ token: 'abc def', env: {} }), (error) => error.code === 'figma_bad_token' && !error.message.includes('abc def'));
});

test('API 返回重定向时不跟随，令牌不会被带去别处', async t => {
  const mock = await startMock(t, { nodes: (req, res, { send, base }) => send(302, '', { location: `${base}/s3/stolen.png` }) });
  await assert.rejects(pullDesign(pullOpts(mock.base, tempDir(t))), (error) => error.code === 'figma_http' && /不跟随/.test(error.message));
  assert.equal(mock.log.filter(e => e.kind === 's3').length, 0);
});

test('请求超时报 figma_timeout', async t => {
  const mock = await startMock(t, { nodes: () => {} });
  await assert.rejects(pullDesign(pullOpts(mock.base, tempDir(t), { timeoutMs: 100 })), { code: 'figma_timeout' });
});

/* ---------------- 版本核对、部分失败、分支 ---------------- */

test('checkVersion：版本没变只花一次三级调用；变了才重拉；变了但没额度时说清楚', async t => {
  let version = '42';
  const mock = await startMock(t, {
    meta: (req, res, { send }) => send(200, { file: { name: 'Xspark', version, last_touched_at: '2026-10-01T00:00:00Z' } }),
    nodes: (req, res, { send }) => send(200, nodesBody(version)),
  });
  const cacheDir = tempDir(t), opts = (extra) => pullOpts(mock.base, cacheDir, { monthlyBudget: 4, ...extra });
  await pullDesign(opts());

  const same = await pullDesign(opts({ checkVersion: true }));
  assert.equal(same.cached, true);
  assert.equal(same.versionCheck.changed, false);
  assert.equal(mock.tier1().length, 2);

  version = '43';
  const changed = await pullDesign(opts({ checkVersion: true }));
  assert.equal(changed.cached, false);
  assert.equal(changed.versionCheck.changed, true);
  assert.equal(changed.design.source.version, '43');
  assert.equal(mock.tier1().length, 4);

  version = '44';
  await assert.rejects(pullDesign(opts({ checkVersion: true })), (error) => {
    assert.equal(error.code, 'figma_budget_exhausted');
    assert.match(error.message, /设计稿已更新（版本 43 → 44）/);
    return true;
  });
  assert.equal(mock.tier1().length, 4);
});

test('GET image 失败：文字照样落盘并标 incomplete；上一份 PNG 留用并标 imageStale', async t => {
  let failImages = false;
  const mock = await startMock(t, { images: (req, res, { send }) => (failImages ? send(500, { status: 500, err: 'Render timeout' }) : false) });
  const cacheDir = tempDir(t);
  await pullDesign(pullOpts(mock.base, cacheDir));
  failImages = true;
  const { design, dir } = await pullDesign(pullOpts(mock.base, cacheDir, { refresh: true }));
  assert.equal(design.incomplete.code, 'figma_server_error');
  assert.match(design.incomplete.message, /文字已保存/);
  assert.deepEqual(design.frames.map(f => f.texts.length), [2, 1]);
  assert.ok(design.frames.every(f => f.imageStale === true && f.image && f.imageErrorCode === 'figma_server_error'));
  assert.deepEqual(readdirSync(join(dir, 'frames')).sort(), ['105-10.png', '105-20.png']);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'design.json'), 'utf8')).incomplete, design.incomplete);
  assert.equal(budgetStatus(budgetFile(cacheDir)).used, 4);
});

test('逐张下载：5xx 重试后成功；空地址记在画板上；404 不重试；下载不带令牌、不记账', async t => {
  let s3Count = 0;
  const mock = await startMock(t, {
    images: (req, res, { send, base }) => send(200, { err: null, images: { '105:10': `${base}/s3/a.png`, '105:20': null } }),
    s3: (req, res, { send }) => (s3Count++ === 0 ? send(503, 'busy') : send(200, pngBytes(4, 2))),
  });
  const slept = [], cacheDir = tempDir(t);
  const { design } = await pullDesign(pullOpts(mock.base, cacheDir, { sleep: async ms => { slept.push(ms); } }));
  assert.equal(design.frames[0].image, 'frames/105-10.png');
  assert.equal(design.frames[1].image, null);
  assert.equal(design.frames[1].imageErrorCode, 'figma_render_empty');
  assert.equal(design.incomplete, undefined);
  assert.deepEqual(slept, [500]);
  assert.equal(budgetStatus(budgetFile(cacheDir)).used, 2);

  const gone = await startMock(t, { s3: (req, res, { send }) => send(404, 'expired') });
  const r = await pullDesign(pullOpts(gone.base, tempDir(t), { sleep: async () => {} }));
  assert.ok(r.design.frames.every(f => f.image === null && f.imageErrorCode === 'figma_download_failed'));
  assert.equal(gone.log.filter(e => e.kind === 's3').length, 2, '404 每张只下载一次');
});

test('分支链接：请求用分支 key，缓存目录按分支分开，source 里两个 key 都在', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  const url = `https://www.figma.com/design/${FILE_KEY}/branch/BrAnCh123/Xspark?node-id=105-3`;
  const { design, dir } = await pullDesign({ ...pullOpts(mock.base, cacheDir), url });
  assert.equal(dir, join(cacheDir, 'BrAnCh123', '105-3'));
  assert.deepEqual([design.source.fileKey, design.source.branchKey], [FILE_KEY, 'BrAnCh123']);
  assert.ok(mock.log.filter(e => e.kind !== 's3').every(e => e.path.includes('/BrAnCh123')));
});

test('maxFrames 截断并保持顺序；refresh 后不再用的旧 PNG 被清掉；raw-nodes.json 可离线重抽', async t => {
  const mock = await startMock(t), cacheDir = tempDir(t);
  await pullDesign(pullOpts(mock.base, cacheDir));
  const { design, dir } = await pullDesign(pullOpts(mock.base, cacheDir, { refresh: true, maxFrames: 1 }));
  assert.deepEqual(design.frames.map(f => f.id), ['105:10']);
  assert.equal(design.root.truncated, true);
  assert.equal(mock.log.filter(e => e.kind === 'images').at(-1).query.ids, '105:10');
  assert.deepEqual(readdirSync(join(dir, 'frames')), ['105-10.png']);

  const raw = JSON.parse(readFileSync(join(dir, 'raw-nodes.json'), 'utf8'));
  const again = selectFrames(raw.nodes['105:3'].document, { maxFrames: 1 }).frames.map(extractFrame);
  assert.deepEqual(again.map(f => f.texts), design.frames.map(f => f.texts));
});

/* ---------------- 选画板与抽取（纯函数） ---------------- */

test('selectFrames：画板集合才拆，自动布局与上下叠放的区块按一张图', () => {
  const fr = (id, x, w, extra = {}) => ({ id, name: id, type: 'FRAME', absoluteBoundingBox: box(x, 0, w, 100), children: [], ...extra });
  const parent = (extra, children) => ({ id: '1:1', name: 'p', type: 'FRAME', absoluteBoundingBox: box(0, 0, 1000, 500), children, ...extra });
  const ids = (r) => r.frames.map(f => f.id);

  assert.deepEqual(ids(selectFrames(parent({}, [fr('1:2', 0, 375), fr('1:3', 400, 375)]))), ['1:2', '1:3']);
  assert.deepEqual(ids(selectFrames(parent({ layoutMode: 'VERTICAL' }, [fr('1:2', 0, 375), fr('1:3', 400, 375)]))), ['1:1']);
  assert.deepEqual(ids(selectFrames(parent({ absoluteBoundingBox: box(0, 0, 375, 812) }, [fr('1:2', 0, 375), fr('1:3', 0, 375)]))), ['1:1']);
  assert.deepEqual(ids(selectFrames(parent({}, [fr('1:2', 0, 375), { id: '1:9', type: 'TEXT' }]))), ['1:1']);
  assert.deepEqual(ids(selectFrames({ id: '2:1', type: 'SECTION', children: [fr('2:2', 0, 10), { id: '2:3', type: 'TEXT' }] })), ['2:2']);
  assert.deepEqual(ids(selectFrames({ id: '3:1', type: 'GROUP', children: [fr('3:2', 0, 10), fr('3:3', 20, 10, { visible: false })] })), ['3:2']);
  assert.deepEqual(ids(selectFrames(parent({}, [fr('1:2', 0, 375), fr('1:3', 400, 375)]), { split: 'self' })), ['1:1']);
  const capped = selectFrames({ id: '0:1', type: 'CANVAS', children: [fr('4:1', 0, 1), fr('4:2', 9, 1), fr('4:3', 3, 1)] }, { maxFrames: 2 });
  assert.deepEqual([ids(capped), capped.available], [['4:1', '4:2'], 3]);
  assert.throws(() => selectFrames({ id: '0:1', type: 'CANVAS', name: '空页', children: [{ id: '5:1', type: 'TEXT' }] }), { code: 'figma_no_frames' });
});

test('extractFrame：跳过隐藏与透明的子树和填充；box 相对画板；颜色取第一个可见实色', () => {
  const frame = {
    id: '9:1', name: 'F', type: 'FRAME', absoluteBoundingBox: box(1000, 2000, 300, 600),
    fills: [solid(1, 1, 1, { opacity: 0 })],
    children: [
      text('9:2', 'A1', box(1010, 2020, 50, 20), { fontFamily: 'Inter', fontSize: 14, fontWeight: 400 }, [{ type: 'GRADIENT_LINEAR' }, solid(0, 0, 1)]),
      text('9:3', '无填充', box(1000, 2000, 10, 10), {}, []),
      { id: '9:4', type: 'GROUP', opacity: 0, children: [text('9:5', '透明组', box(0, 0, 1, 1), {}, [solid(1, 0, 0)])] },
    ],
  };
  const r = extractFrame(frame);
  assert.deepEqual([r.width, r.height], [300, 600]);
  assert.deepEqual(r.texts.map(x => [x.characters, x.color, x.box]), [['A1', '#0000ff', { x: 10, y: 20, w: 50, h: 20 }], ['无填充', null, { x: 0, y: 0, w: 10, h: 10 }]]);
  assert.deepEqual(r.colors, [{ hex: '#0000ff', count: 1 }]);
  assert.deepEqual(r.fonts, [{ family: 'Inter', size: 14, weight: 400, count: 1 }]);
});
