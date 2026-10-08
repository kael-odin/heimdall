/**
 * Core unit tests — zero-dependency, run with `node --test test/`.
 *
 * Scope: pure deterministic functions (adapters, harvest, domdiff).
 * Browser-dependent stages are covered by the smoke test / manual E2E.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickAdapter, nextjs, vueVite, generic } from '../src/adapters/index.mjs';
import { extractProfile, dataScore } from '../src/harvest/harvest.mjs';
import { domSimilarity } from '../src/differ/domdiff.mjs';

test('adapter: nextjs detection + media path healing', () => {
  const html = '<html><body><script id="__NEXT_DATA__" type="application/json">{}</script><div class="x">hi</div></body></html>';
  assert.equal(pickAdapter(html), nextjs);
  assert.deepEqual(
    nextjs.cssRefCandidates('https://a.com/media/font.woff2'),
    ['https://a.com/media/font.woff2', 'https://a.com/_next/static/media/font.woff2'],
  );
});

test('adapter: vue-vite detection', () => {
  const html = '<div data-v-1a2b3c4d class="hero">x</div>';
  assert.equal(pickAdapter(html), vueVite);
});

test('adapter: generic fallback', () => {
  assert.equal(pickAdapter('<html><body><h1>plain</h1></body></html>'), generic);
});

const PAGE = `<!doctype html><html lang="en"><head>
<title>Example page</title>
<meta name="description" content="A description">
<meta property="og:title" content="OG">
<link rel="canonical" href="https://example.com/">
<script>window.__DATA__ = ["$","$5",null,{"price":"$999"}];</script>
</head><body>
<h1>Main heading</h1><h2>Sub heading</h2>
<p>Starts at $19 / month and $1,299 for teams.</p>
<a class="btn primary" href="/pricing">See pricing</a>
<a href="https://external.test/x">External</a>
<table><tbody><tr><th>Plan</th><td>Free</td></tr></tbody></table>
<img src="/a.png" alt="a"><img src="/b.png">
</body></html>`;

test('harvest: extracts visible structure without RSC payload pollution', () => {
  const p = extractProfile(PAGE);
  assert.equal(p.meta.title, 'Example page');
  assert.equal(p.meta.description, 'A description');
  assert.deepEqual(p.headings.map(h => h.text), ['Main heading', 'Sub heading']);
  assert.ok(p.prices.includes('$19'));
  assert.ok(p.prices.includes('$1,299'));
  assert.ok(!p.prices.some(x => x.includes('999')), 'prices inside <script> must not leak');
  assert.ok(p.cta.includes('See pricing'));
  assert.equal(p.tables.length, 1);
  assert.ok(p.links.includes('/pricing'));
});

test('harvest: dataScore of identical documents is 1', () => {
  const s = dataScore(PAGE, PAGE);
  assert.equal(s.data, 1);
  assert.equal(s.dims.meta, '100%');
});

test('domdiff: identical DOM scores 1, different structure scores lower', () => {
  const a = '<html><body><div class="a"><span>x</span></div></body></html>';
  const b = '<html><body><section class="b"><p>y</p><p>z</p></section></body></html>';
  const same = domSimilarity(a, a);
  assert.equal(same.dom, 1);
  const diff = domSimilarity(a, b);
  assert.ok(diff.dom < 1, `expected < 1, got ${diff.dom}`);
  assert.ok(diff.classJac < 1);
});
