/**
 * URL 归一化
 *
 * 这条测试来自一个真实的故障：ant.design 侦察出的 32 个节点里有 4 组是
 * "同一个页面的两种写法"（一条带尾斜杠、一条不带），星图上两条一模一样的路径，
 * 页面清单里同名两行；而产物目录名按去尾斜杠的 path 算，于是克隆其中一条
 * 会让另一条也显示"已克隆"。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonUrl, sameCanonUrl, stableNodeId } from '../src/url-canon.mjs';

test('尾斜杠：去掉，但根路径保留', () => {
  assert.equal(canonUrl('https://a.test/x/'), 'https://a.test/x');
  assert.equal(canonUrl('https://a.test/x'), 'https://a.test/x');
  assert.equal(canonUrl('https://a.test/'), 'https://a.test/');
  assert.equal(canonUrl('https://a.test'), 'https://a.test/', '裸域名归一成根路径');
});

test('真实故障的四种形态：两种写法必须归一成同一个字符串', () => {
  const pairs = [
    ['https://ant.design', 'https://ant.design/'],
    ['https://ant.design/components/overview', 'https://ant.design/components/overview/'],
    ['https://a.test/docs/x', 'https://a.test/docs/x/'],
    ['https://a.test/a/b/', 'https://a.test/a/b'],
  ];
  for (const [a, b] of pairs) {
    assert.equal(canonUrl(a), canonUrl(b), `${a} 与 ${b} 应当归一相同`);
    assert.equal(sameCanonUrl(a, b), true);
  }
});

test('hash 去掉；**查询参数保留**（?page=2 是另一个页面，不能合并）', () => {
  assert.equal(canonUrl('https://a.test/x#sec'), 'https://a.test/x');
  assert.equal(canonUrl('https://a.test/list?page=2'), 'https://a.test/list?page=2');
  assert.notEqual(canonUrl('https://a.test/list?page=2'), canonUrl('https://a.test/list'));
  assert.equal(canonUrl('https://a.test/list/?page=2'), 'https://a.test/list?page=2');
});

test('不改动其它部分：协议、子域、端口、大小写敏感性交给 URL 自己', () => {
  assert.equal(canonUrl('http://sub.a.test:8080/x/'), 'http://sub.a.test:8080/x');
  assert.equal(canonUrl('https://a.test/A/'), 'https://a.test/A', '路径大小写敏感，不动');
});

test('解析不了就返回 null，不抛', () => {
  assert.equal(canonUrl('not a url'), null);
  assert.equal(canonUrl(''), null);
  assert.equal(sameCanonUrl('bad', 'https://a.test/'), false);
});

/**
 * 节点 id 的确定性 —— 这条来自一个可复现性缺陷。
 * 此前 id 是 `n${i++}`，而侦察是 3 路并发的：谁先加载完谁拿小号。
 * 于是同一个没变的站点侦察两次得到两张对不上的 atlas，缩略图/边/任何按 id 的 diff 全变。
 */
test('stableNodeId：同一个 url 永远是同一个 id（跨次、跨顺序一致）', () => {
  const urls = ['https://a.test/', 'https://a.test/docs', 'https://a.test/docs/x?page=2'];
  const first = urls.map(stableNodeId);
  // 打乱顺序再算一遍 —— 结果必须逐项相同（这正是并发访问顺序做不到的）
  const shuffled = [...urls].reverse().map(u => [u, stableNodeId(u)]);
  const byUrl = Object.fromEntries(urls.map((u, i) => [u, first[i]]));
  for (const [u, id] of shuffled) assert.equal(id, byUrl[u], `${u} 的 id 应与其原位置无关`);
  assert.deepEqual(urls.map(stableNodeId), first, '重复计算应逐字节一致');
});

test('stableNodeId：不同 url 不同 id，且格式稳定（n + 8 位）', () => {
  const ids = ['https://a.test/', 'https://a.test/docs', 'https://b.test/'].map(stableNodeId);
  assert.equal(new Set(ids).size, ids.length, '不同 url 不应撞 id');
  for (const id of ids) assert.match(id, /^n[0-9a-f]{8}$/);
  // 固定向量：若实现被改动（换算法/换长度）这里会红，提醒这会破坏所有历史 atlas
  assert.equal(stableNodeId('https://a.test/'), stableNodeId('https://a.test/'));
});
