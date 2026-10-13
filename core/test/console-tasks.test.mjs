/**
 * 任务行上的两个判定（会出现在哪一行、点了导出谁）。
 *
 * 这些守卫来自一次真事故的形状：**"点了没反应"和"点错了站"是同一类错**——
 * 从产物反推站点身份时多一步或少一步。引擎按 host 建目录（`workspace/<host>/`），
 * 而 host 是由 `/api/live-export` 那三下归一出来的：去协议、去 `www.`、去路径。
 * 控制台这边只要多带一个 `www.`，导出就会指向一个不存在的站点，而错误信息
 * 只是一句"导出失败"。
 *
 * 抽成纯函数就是为了能在这里钉住：**判定只能看这一行，不能看"当前选中的站"**。
 * 实测过的那条路径：当前选中 moonshot.cn，点 apify 那一行的按钮 ——
 * 请求体必须是 `{host: 'apify.com'}`（见下面的用例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { hostOfTask, canExportLive, canRetry, RETRY_CN, medianForgeSec } = await import('../../console/src/tasks.js');

test('hostOfTask 与引擎侧同一条归一规则：去协议、去 www.、去路径', () => {
  assert.equal(hostOfTask({ url: 'https://www.moonshot.cn/' }), 'moonshot.cn');
  assert.equal(hostOfTask({ url: 'https://www.moonshot.cn/about' }), 'moonshot.cn');
  assert.equal(hostOfTask({ url: 'https://apify.com/store/categories/seo-tools' }), 'apify.com');
  assert.equal(hostOfTask({ url: 'http://linear.app/build' }), 'linear.app');
  assert.equal(hostOfTask({ url: 'https://x.test:8443/a' }), 'x.test', '端口不算 host 的一部分');
});

test('hostOfTask 对非法/缺失 url 返回空串而不是抛 —— 历史数据里什么都有', () => {
  for (const bad of [{}, { url: '' }, { url: 'not a url' }, { url: null }, null]) {
    assert.equal(hostOfTask(bad), '');
  }
});

test('canExportLive：克隆/整站克隆跑完的行才出现按钮', () => {
  const apify = { kind: 'forge', status: 'done', url: 'https://apify.com/store' };
  assert.equal(canExportLive(apify), true);
  assert.equal(canExportLive({ kind: 'clone', status: 'done', url: 'https://thordata.com/' }), true);
});

test('canExportLive：会话里的单页克隆没有 kind 字段，靠 pageName 认出来', () => {
  // startForge 建的会话任务就是这个形状：没有 kind，但有 pageName / url / done
  assert.equal(canExportLive({ pageName: 'store', url: 'https://apify.com/store', done: true, failed: false }), true);
  assert.equal(canExportLive({ pageName: 'store', url: 'https://apify.com/store', done: false, failed: false }), false);
  assert.equal(canExportLive({ pageName: 'store', url: 'https://apify.com/store', done: true, failed: true }), false);
});

test('canExportLive：别把按钮发给不相干的行', () => {
  const url = 'https://apify.com/';
  assert.equal(canExportLive({ kind: 'live', status: 'done', url }), false, '导出行自己不该再提供一次导出');
  assert.equal(canExportLive({ kind: 'audit', status: 'done', url }), false);
  assert.equal(canExportLive({ kind: 'assets', status: 'done', url }), false);
  assert.equal(canExportLive({ kind: 'forge', status: 'running', url }), false);
  assert.equal(canExportLive({ kind: 'forge', status: 'failed', url }), false);
  assert.equal(canExportLive({ kind: 'forge', status: 'done', url: '' }), false, '没有 url 就推不出站点');
});

test('导出目标只取自那一行 —— 与"当前选中的站"无关', () => {
  // 实测场景：站点下拉停在 moonshot.cn，用户点的是 apify 那一行
  const rowOnAnotherSite = { kind: 'forge', status: 'done', url: 'https://apify.com/store' };
  assert.equal(canExportLive(rowOnAnotherSite), true, '别的站的行照样能导出，不是只有当前站才有按钮');
  assert.equal(hostOfTask(rowOnAnotherSite), 'apify.com', '请求体里的 host 必须是行上的站，不是选中的站');
  assert.notEqual(hostOfTask(rowOnAnotherSite), 'moonshot.cn');
});

test('canRetry：只有中断/失败、且是可重发的 kind 才有"继续克隆"', () => {
  assert.equal(canRetry({ status: 'interrupted', kind: 'clone', url: 'https://a.test/' }), true);
  assert.equal(canRetry({ status: 'failed', kind: 'forge', url: 'https://a.test/' }), true);
  assert.equal(canRetry({ status: 'done', kind: 'clone', url: 'https://a.test/' }), false);
  assert.equal(canRetry({ status: 'failed', kind: 'audit', url: 'https://a.test/' }), false);
  assert.equal(canRetry({ status: 'failed', kind: 'clone', url: '' }), false);
  assert.equal(canRetry(null), false);
  assert.deepEqual(RETRY_CN, { clone: '继续克隆', forge: '重新克隆' });
});

/**
 * 「还要等多久」的中位耗时 —— 界面上那句"同类中位 0:38"的依据。
 * 它是**有主张的**（会让人据此决定要不要离开），所以规则要钉死：
 * 样本不够就不说，只算真正跑完的，优先信本站。
 */
test('medianForgeSec：样本不够就不说 —— 宁可没有，也不给编出来的预计时间', () => {
  const rows = [1, 2].map(i => ({ kind: 'forge', status: 'done', url: 'https://a.test/', createdAt: 0, endedAt: i * 30000 }));
  assert.equal(medianForgeSec(rows, 'a.test'), null, '本站只有 2 条，全站也不足 5 条 → 不显示');
  assert.equal(medianForgeSec([], 'a.test'), null);
  assert.equal(medianForgeSec(null, 'a.test'), null);
});

test('medianForgeSec：本站满 3 条就只信本站', () => {
  const j = (host, sec) => ({ kind: 'forge', status: 'done', url: 'https://' + host + '/', createdAt: 0, endedAt: sec * 1000 });
  const rows = [j('a.test', 30), j('a.test', 40), j('a.test', 50), j('big.test', 900)];
  assert.deepEqual(medianForgeSec(rows, 'a.test'), { sec: 40, scope: 'host' }, '不能把 big.test 那一页的 900s 混进来');
});

test('medianForgeSec：本站不足 3 条时放宽到跨站，但要够 5 条 —— 而且口径要标出来', () => {
  const j = (host, sec, status = 'done') => ({ kind: 'forge', status, url: 'https://' + host + '/', createdAt: 0, endedAt: sec * 1000 });
  assert.equal(medianForgeSec([j('a.test', 10), j('a.test', 20), j('b.test', 60), j('c.test', 80)], 'a.test'), null, '全站 4 条还不够');
  // scope:'all' 是给界面用的：这时文案必须是「跨站中位」，不能写成"同类"。
  // 实测踩过：example.com 一页 30 秒跑完，轨道上却写着"同类中位 1:18"（46 个 apify 页面的中位数）。
  assert.deepEqual(medianForgeSec([j('a.test', 10), j('a.test', 20), j('b.test', 40), j('c.test', 60), j('d.test', 80)], 'a.test'), { sec: 40, scope: 'all' });
});

test('medianForgeSec：只算真正跑完的，且 www. 归一后算同一个站', () => {
  const j = (host, sec, status) => ({ kind: 'forge', status, url: 'https://' + host + '/', createdAt: 0, endedAt: sec * 1000 });
  const rows = [
    j('www.a.test', 30, 'done'), j('a.test', 40, 'done'), j('a.test', 50, 'done'),
    j('a.test', 9999, 'failed'), j('a.test', 8888, 'running'),
    { kind: 'forge', status: 'done', url: 'https://a.test/', createdAt: 0, endedAt: 0 },  // 时长为 0 的脏数据
  ];
  assert.deepEqual(medianForgeSec(rows, 'a.test'), { sec: 40, scope: 'host' }, '失败/在跑/零时长都不进样本；www. 与裸域是同一个站');
});
