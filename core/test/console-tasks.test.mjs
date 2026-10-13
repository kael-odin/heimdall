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

const { hostOfTask, canExportLive, canRetry, RETRY_CN } = await import('../../console/src/tasks.js');

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
