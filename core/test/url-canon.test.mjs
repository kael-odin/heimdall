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
import { readFileSync } from 'node:fs';
import { pageNameOfUrl, canonUrl, sameCanonUrl, stableNodeId, asUrl } from '../src/url-canon.mjs';

/**
 * 补协议这条来自一个真实的崩溃：CLI 帮助文本写的例子就是 `heimdall recon apify.com 30`，
 * 而 recon 第一件事是 `new URL(TARGET).origin` —— 照着自己的文档敲命令会抛
 * `TypeError: Invalid URL  input: 'apify.com'`。引擎那条路没暴露，是因为它先 `new URL(url).href`
 * 把非法输入变成 400，只有 CLI 会真的崩栈。
 */
test('asUrl：裸主机名补 https', () => {
  assert.equal(asUrl('apify.com'), 'https://apify.com/');
  assert.equal(asUrl('apify.com/actors'), 'https://apify.com/actors');
  assert.equal(asUrl('  example.com  '), 'https://example.com/', '两侧空白要去掉');
});

test('asUrl：已有协议的原样保留（local http 不能被升级成 https）', () => {
  assert.equal(asUrl('http://localhost:3000'), 'http://localhost:3000/');
  assert.equal(asUrl('https://example.com/x'), 'https://example.com/x');
  assert.equal(asUrl('//example.com/x'), 'https://example.com/x', '协议相对补 https');
});

test('asUrl：补完仍不可解析时返回 null，由调用方决定文案', () => {
  assert.equal(asUrl(''), null);
  assert.equal(asUrl(null), null);
  assert.equal(asUrl('http://'), null);
});

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

// ---------- 页目录名 ----------
test('pageNameOfUrl: 根路径 → home，普通路径去掉首斜杠', () => {
  assert.equal(pageNameOfUrl('https://x.test/'), 'home');
  assert.equal(pageNameOfUrl('https://x.test'), 'home');
  assert.equal(pageNameOfUrl('https://x.test/customers'), 'customers');
  assert.equal(pageNameOfUrl('https://x.test/customers/'), 'customers');
});

test('pageNameOfUrl: 多级路径折成 - ，查询与锚点不进名字', () => {
  assert.equal(pageNameOfUrl('https://x.test/a/b'), 'a-b');
  assert.equal(pageNameOfUrl('https://x.test/pricing?plan=pro#faq'), 'pricing');
});

test('pageNameOfUrl: 解析不了用 fallback，不抛', () => {
  assert.equal(pageNameOfUrl('not a url'), 'home');
  assert.equal(pageNameOfUrl(undefined), 'home');
  assert.equal(pageNameOfUrl(null, 'page'), 'page');
});

test('pageNameOfUrl: 超长路径截断到 60 字符（Windows 路径长度)', () => {
  assert.equal(pageNameOfUrl('https://x.test/' + 'a'.repeat(200)).length, 60);
});

test('pageNameOfUrl: 接受 URL 对象', () => {
  assert.equal(pageNameOfUrl(new URL('https://x.test/docs/intro')), 'docs-intro');
});

/**
 * 控制台不能 import core 的模块（浏览器侧，另一套构建），所以 src/pages.js 里
 * 必然存在一份**同规则的副本** —— 这正是会漂移的地方，而且漂移不报错：
 * 规则不一致时链接指向不存在的产物目录，打开只是 404。
 * 所以不靠人记，直接把两边的规则表达式抽出来比。
 */
test('控制台的 pageNameOf 规则与 pageNameOfUrl 一字不差', () => {
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const core = read('../src/url-canon.mjs');
  const console_ = read('../../console/src/pages.js');
  const ruleOf = (src) => {
    const m = /\.pathname((?:\.replace\([^)]*\))+\.slice\(0,\s*60\))/.exec(src);
    return m ? m[1].replace(/\s+/g, '') : null;
  };
  const a = ruleOf(core), b = ruleOf(console_);
  assert.ok(a, '在 url-canon.mjs 里找不到页名规则 —— 抽取正则过期了，别直接放过');
  assert.equal(b, a, '控制台那份页名规则已经漂移，链接会指向不存在的目录');
});
