import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { collectPage } from '../src/seo/collect.mjs';
import { renderHtml } from '../src/seo/report.mjs';
import { evaluatePage } from '../src/seo/rules.mjs';

const cases = [
  {
    name: 'a later robots tag can prohibit indexing',
    tags: '<meta name="robots" content="index, follow"><meta name="robots" content="noindex">',
    noindex: true, nofollow: false, evidence: 'noindex',
  },
  {
    name: 'robots name and directives are case insensitive',
    tags: '<meta name="ROBOTS" content="NONE">',
    noindex: true, nofollow: true, evidence: 'none',
  },
  {
    name: 'Googlebot restrictions combine with generic tags',
    tags: '<meta name="robots" content="follow"><meta name="GoogleBot" content="NOINDEX">',
    noindex: true, nofollow: false, evidence: 'googlebot',
  },
  {
    name: 'Googlebot header supplies evidence even with a generic robots tag',
    tags: '<meta name="robots" content="index, follow">',
    headers: ['googlebot: noindex'],
    noindex: true, nofollow: false, evidence: 'x-robots-tag',
  },
  {
    name: 'another crawler header does not prohibit Google indexing',
    headers: ['otherbot: noindex, nofollow'],
    noindex: false, nofollow: false,
  },
  {
    name: 'separate crawler headers keep their scope',
    headers: ['googlebot: nofollow', 'otherbot: noindex, nofollow'],
    noindex: false, nofollow: true,
  },
  {
    name: 'separate crawler headers do not leak nofollow to Googlebot',
    headers: ['googlebot: noindex', 'otherbot: nofollow'],
    noindex: true, nofollow: false, evidence: 'googlebot',
  },
  {
    name: 'one header can change crawler scope between directives',
    headers: ['googlebot: nofollow, otherbot: noindex, nofollow'],
    noindex: false, nofollow: true,
  },
  {
    name: 'generic none header applies to Googlebot',
    headers: ['none'],
    noindex: true, nofollow: true, evidence: 'none',
  },
  {
    name: 'none as a preview value is not the none directive',
    headers: ['max-image-preview: none'],
    noindex: false, nofollow: false,
  },
  {
    name: 'an unknown directive containing noindex is not noindex',
    tags: '<meta name="robots" content="notnoindex, follow">',
    noindex: false, nofollow: false,
  },
  {
    name: 'Google News restriction is not a general Google web restriction',
    tags: '<meta name="googlebot-news" content="noindex">',
    noindex: false, nofollow: false,
  },
  {
    name: 'generic restrictions apply even with other crawler directives',
    tags: '<meta name="robots" content="nofollow">',
    headers: ['otherbot: noindex', 'noindex'],
    noindex: true, nofollow: true, evidence: 'noindex',
  },
  {
    name: 'initial HTML noindex remains relevant after JavaScript removes it',
    tags: '<meta name="robots" content="noindex">',
    script: "document.querySelector('meta[name=robots]').remove()",
    noindex: true, nofollow: false, evidence: 'initial html',
  },
  {
    name: 'a rendered Googlebot restriction remains relevant',
    script: "document.head.insertAdjacentHTML('beforeend', '<meta name=googlebot content=noindex>')",
    noindex: true, nofollow: false, evidence: 'googlebot',
  },
  {
    name: 'none as a meta preview value is not the none directive',
    tags: '<meta name="robots" content="max-image-preview: none">',
    noindex: false, nofollow: false,
  },
  {
    name: 'a later refetch is not treated as the initial HTML',
    script: "history.replaceState(null, '', '/replacement')",
    noindex: false, nofollow: false, initialHtml: 'unavailable', rawSource: 'refetch',
  },
  {
    name: 'evidence identifies a directive beyond a long meta prefix',
    tags: `<meta name="robots" content="${'index, '.repeat(40)}noindex">`,
    noindex: true, nofollow: false, evidence: 'noindex',
  },
];

test('SEO robots signals are collected and attributed for Google web search', { timeout: 60_000 }, async t => {
  const server = createServer((req, res) => {
    if (req.url === '/replacement') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><meta name="robots" content="noindex"><title>Different refetch</title>');
      return;
    }
    const fixture = cases[Number(req.url.slice(1))];
    if (!fixture) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (fixture.headers) res.setHeader('X-Robots-Tag', fixture.headers);
    res.end(`<!doctype html><html lang="en"><head><title>Robots fixture</title>${fixture.tags ?? ''}</head><body><h1>Robots</h1><script>${fixture.script ?? ''}</script></body></html>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const [index, fixture] of cases.entries()) {
    await t.test(fixture.name, async () => {
      const page = await collectPage(browser, `${origin}/${index}`, { settleMs: 20 });
      assert.equal(page.meta.noindex, fixture.noindex);
      assert.equal(page.meta.nofollow, fixture.nofollow);
      assert.equal(page.robotsEvidence.initialHtml, fixture.initialHtml ?? 'checked');
      assert.equal(page.raw.source, fixture.rawSource ?? 'navigation');
      const issue = evaluatePage(page, { host: '127.0.0.1' }).find(item => item.id === 'index-noindex');
      assert.equal(Boolean(issue), fixture.noindex);
      if (fixture.evidence) assert.match(issue.evidence.toLowerCase(), new RegExp(fixture.evidence));
    });
  }
});

test('SEO report shows whether initial HTML was inspected and explains the score boundary', () => {
  const page = (path, initialHtml) => ({
    url: `https://example.com/${path}`, title: path, status: 200, score: 100,
    robotsEvidence: { initialHtml }, wordCount: 100, vitals: {}, issues: [],
  });
  const html = renderHtml({
    host: 'example.com', origin: 'https://example.com', generatedAt: '2026-11-08', score: 100,
    pages: [page('checked', 'checked'), page('unavailable', 'unavailable')], siteIssues: [],
    summary: { pages: 2, issues: 0, bySeverity: {} }, categories: {}, config: { max: 2, viewport: '1440x900' },
  });
  assert.match(html, /初始 HTML 已核对/);
  assert.match(html, /初始 HTML 未核对/);
  assert.match(html, /不代表搜索引擎实际收录、排名或 AI 引用/);
  assert.match(html, /未命中规则/);
});
