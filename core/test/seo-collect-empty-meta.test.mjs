/**
 * SEO 采集：缺失的元数据必须保持"缺失"。
 *
 * 此前页内的 abs() 对空串也做 new URL('', location.href)，结果是页面自身地址：
 * 没有 canonical / og:image / twitter:image 的页面采集出来反而"都有值"，
 * index-canonical-missing 与 structured-og-image 两条规则对真实页面永远不会触发。
 * 而规则单测都是手工构造 page 对象，恰好绕开了采集层，所以一直没被发现。
 *
 * 这条用例走真实的 collectPage → evaluatePage，守住整条链路。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { collectPage } from '../src/seo/collect.mjs';
import { evaluatePage } from '../src/seo/rules.mjs';

const BARE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Bare page without social or canonical tags</title>
<meta name="description" content="A page that deliberately omits canonical, og:image and twitter:image, and uses a relative hreflang.">
<link rel="alternate" hreflang="fr" href="/fr/">
</head><body><h1>Bare</h1><p>some body text some body text some body text</p></body></html>`;

const COMPLETE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Complete page with canonical and images</title>
<link rel="canonical" href="/complete">
<meta property="og:image" content="/og.png"><meta name="twitter:image" content="/tw.png">
<link rel="alternate" hreflang="en" href="{{ORIGIN}}/complete">
</head><body><h1>Complete</h1><p>some body text some body text some body text</p></body></html>`;

async function withPages(t, fn) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // 端口是动态的，所以对照页的 hreflang 用请求的 Host 现场拼成绝对地址
    res.end((req.url.startsWith('/complete') ? COMPLETE : BARE).replaceAll('{{ORIGIN}}', `http://${req.headers.host}`));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  return fn(browser, `http://127.0.0.1:${server.address().port}`);
}

const idsOf = page => evaluatePage(page, { host: new URL(page.url).host }).map(i => i.id);

test('采集：缺少 canonical / og:image / twitter:image 时保持空串，规则能报缺失', async t => {
  await withPages(t, async (browser, origin) => {
    const page = await collectPage(browser, `${origin}/bare`, { settleMs: 50 });
    assert.equal(page.canonical, '', 'canonical 不该被填成页面自身地址');
    assert.equal(page.og.image, '');
    assert.equal(page.twitter.image, '');
    const ids = idsOf(page);
    assert.ok(ids.includes('index-canonical-missing'), `应报缺少 canonical：${ids}`);
    assert.ok(ids.includes('structured-og-image'), `应报缺少 og:image：${ids}`);
  });
});

test('采集：相对地址的 canonical / 图片仍按页面地址绝对化，不误报缺失', async t => {
  await withPages(t, async (browser, origin) => {
    const page = await collectPage(browser, `${origin}/complete`, { settleMs: 50 });
    assert.equal(page.canonical, `${origin}/complete`);
    assert.equal(page.og.image, `${origin}/og.png`);
    assert.equal(page.twitter.image, `${origin}/tw.png`);
    const ids = idsOf(page);
    assert.ok(!ids.includes('index-canonical-missing'));
    assert.ok(!ids.includes('structured-og-image'));
  });
});

test('采集：hreflang 的 href 绝对化，同时保留标签原值，使"相对地址"规则对真实页面生效', async t => {
  await withPages(t, async (browser, origin) => {
    const page = await collectPage(browser, `${origin}/bare`, { settleMs: 50 });
    assert.deepEqual(page.hreflang, [{ lang: 'fr', href: `${origin}/fr/`, rawHref: '/fr/' }]);
    assert.ok(idsOf(page).includes('index-hreflang-relative'), '标签写的是 /fr/，应被判为相对地址');

    // 对照：标签本来就写绝对地址的页面不该被报
    const ok = await collectPage(browser, `${origin}/complete`, { settleMs: 50 });
    assert.equal(ok.hreflang[0].rawHref, `${origin}/complete`);
    assert.ok(!idsOf(ok).includes('index-hreflang-relative'));
  });
});
