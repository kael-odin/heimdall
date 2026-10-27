/**
 * Heimdall-Bench 驱动（E14-01~03）：输出解析与报表
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySurgical, ensureSectionLinks, parseFiles, parseSurgical, replaceSection, scalarFeedback, sectionHtmlOf, targetedFeedback } from '../src/agent/bench/agent.mjs';
import { benchReport, benchTable, quantile, summarizeRuns, summaryTable } from '../src/agent/bench/score.mjs';

test('bench: parses the two fenced files and refuses a partial answer', () => {
  const out = '好的：\n```html index.html\n<!doctype html><html><body><h1>x</h1></body></html>\n```\n```css styles.css\nh1{color:red}\n```\n';
  const f = parseFiles(out);
  assert.match(f.html, /^<!doctype html>/);
  assert.match(f.css, /^h1\{/);
  assert.throws(() => parseFiles('```html index.html\n<p>x</p>\n```'), /index\.html 与 styles\.css/);
  // 模型没写文件名时按语言回退
  const loose = parseFiles('```html\n<p>a</p>\n```\n```css\np{margin:0}\n```');
  assert.match(loose.html, /<p>a<\/p>/);
});

test('bench: the A2 arm gets numbers but no location', () => {
  const text = scalarFeedback({ perViewport: { 375: { pixelSimilarity: 0.9123, maxBlobPct: 3.4 }, 1440: { pixelSimilarity: 0.95, maxBlobPct: 1 } },
    verdict: { status: 'needs-work', target: 'silver' } });
  assert.match(text, /375px：像素 91\.23%/);
  assert.match(text, /needs-work/);
  assert.doesNotMatch(text, /bbox|裁剪|crops|sec-|建议/);
});

test('bench: targeted feedback keeps the top regions and forbids touching the rest', () => {
  const region = (id, cause) => ({ id, sectionId: 'sec-hero', bbox: { x: 0, y: 10, w: 100, h: 20 }, areaPct: 2, cause, hint: `修 ${id}` });
  const text = targetedFeedback({ verdict: { status: 'needs-work', target: 'silver' }, perViewport: { 1440: { pixelSimilarity: 0.8 } },
    order: ['r1', 'r2', 'r3'], regions: [region('r1', 'shift'), region('r2', 'font'), region('r3', 'color')] }, { top: 2 });
  assert.match(text, /\[r1\][^\n]*cause=shift/);
  assert.match(text, /修 r1/);
  assert.doesNotMatch(text, /\[r3\]/, 'only the top regions are handed back');
  assert.match(text, /只改这些/);
});

test('bench: repeats are summarised with median and range, and n is stated', () => {
  assert.equal(quantile([1, 2, 3], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const summary = summarizeRuns([
    { label: 'a2', pixel: { 1440: 0.70 } }, { label: 'a2', pixel: { 1440: 0.74 } }, { label: 'a2', pixel: { 1440: 0.80 } },
    { label: 'a3', pixel: { 1440: 0.75 } },
  ]);
  const a2 = summary.find(s => s.label === 'a2');
  assert.equal(a2.n, 3);
  assert.equal(a2.viewports['1440'].median, 0.74);
  assert.equal(a2.viewports['1440'].min, 0.70);
  assert.equal(a2.viewports['1440'].max, 0.80);
  const table = summaryTable(summary);
  assert.match(table, /\| a2 \| 3 \| 74\.00%（70\.00%–80\.00%） \|/);
  assert.match(table, /\| a3 \| 1 \|/);
});

test('bench: surgical edits touch only the named section and append css', () => {
  const html = '<html><body><section data-heimdall-section="sec-hero-aaaaaa"><h1>old</h1></section>'
    + '<section data-heimdall-section="sec-cta-bbbbbb"><h2>keep me</h2></section></body></html>';
  const r = replaceSection(html, 'sec-hero-aaaaaa', '<section data-heimdall-section="sec-hero-aaaaaa"><h1>new</h1></section>');
  assert.equal(r.replaced, true);
  assert.match(r.html, /new/);
  assert.doesNotMatch(r.html, /old/);
  assert.match(r.html, /keep me/, 'the other section is untouched');

  const miss = replaceSection(html, 'sec-hero-cccccc', '<section data-heimdall-section="sec-hero-cccccc">x</section>');
  assert.equal(miss.replaced, false, 'a wrong id changes nothing');
  assert.equal(miss.html, html);
  // 模型把别的分段回给这一段：不能替换，否则两段内容对调
  const swapped = replaceSection(html, 'sec-hero-aaaaaa', '<section data-heimdall-section="sec-cta-bbbbbb"><h2>wrong</h2></section>');
  assert.equal(swapped.replaced, false, 'the replacement must carry the same id');
  assert.equal(swapped.html, html);

  const parsed = parseSurgical('```html sec-hero-aaaaaa\n<section data-heimdall-section="sec-hero-aaaaaa"><h1>n</h1></section>\n```\n```css add\n.hero h1{font-size:52px}\n```');
  assert.equal(parsed.sections.length, 1);
  assert.match(parsed.cssAdd, /font-size:52px/);
  assert.throws(() => parseSurgical('这里什么都没有'), /没有给出任何分段改动/);
});

test('bench: a section can be read back out of the current page', () => {
  const html = '<html><body><section data-heimdall-section="sec-hero-aaaaaa"><h1>hero</h1></section>'
    + '<section data-heimdall-section="sec-cta-bbbbbb"><h2>cta</h2></section></body></html>';
  const hero = sectionHtmlOf(html, 'sec-hero-aaaaaa');
  assert.match(hero, /^<section data-heimdall-section="sec-hero-aaaaaa">/);
  assert.match(hero, /hero/);
  assert.doesNotMatch(hero, /cta/, 'only one section comes back');
  assert.equal(sectionHtmlOf(html, 'sec-x-cccccc'), null);
});

test('bench: applying a surgical edit writes both files and reports misses', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-surgical-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<html><body><section data-heimdall-section="sec-hero-aaaaaa"><h1>old</h1></section></body></html>');
    writeFileSync(join(dir, 'styles.css'), 'body{margin:0}\n');
    const applied = applySurgical(dir, {
      sections: [{ id: 'sec-hero-aaaaaa', html: '<section data-heimdall-section="sec-hero-aaaaaa"><h1>new</h1></section>' },
        { id: 'sec-cta-bbbbbb', html: '<section data-heimdall-section="sec-cta-bbbbbb">x</section>' }],
      cssAdd: '.hero h1{font-size:52px}',
    });
    assert.deepEqual(applied.replaced, ['sec-hero-aaaaaa']);
    assert.deepEqual(applied.missed, ['sec-cta-bbbbbb']);
    assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /new/);
    const css = readFileSync(join(dir, 'styles.css'), 'utf8');
    assert.match(css, /body\{margin:0\}/, 'existing css survives');
    assert.match(css, /surgical additions[\s\S]*font-size:52px/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bench: the per-section stylesheets are wired back into the head, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-links-'));
  try {
    writeFileSync(join(dir, 'index.html'), '<html><head><link rel="stylesheet" href="/tokens.css">\n<link rel="stylesheet" href="/styles.css">\n</head><body></body></html>');
    const first = ensureSectionLinks(dir, ['sec-hero-aaaaaa', 'sec-cta-bbbbbb']);
    assert.deepEqual(first.added, ['sec-hero-aaaaaa', 'sec-cta-bbbbbb']);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(html, /styles\.css">\n<link rel="stylesheet" href="\/sections\/sec-hero-aaaaaa\.css">\n<link rel="stylesheet" href="\/sections\/sec-cta-bbbbbb\.css">\n<\/head>/,
      'section sheets come after the global ones');
    assert.deepEqual(ensureSectionLinks(dir, ['sec-hero-aaaaaa']).added, [], 'idempotent');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bench: the table shows every viewport, the gate and the iterations', () => {
  const report = benchReport({ fixture: { siteId: 'f1.test', page: 'home' }, level: 'silver', rows: [
    { label: '脚手架', dir: 'a', pixel: { 375: 0.05, 768: 0.07, 1440: 0.09 }, gate: { status: 'failed', reached: null, failed: ['visual', 'structure'] }, iterations: 0, compareMs: 2300 },
    { label: '人写', dir: 'b', pixel: { 375: 1, 768: 1, 1440: 1 }, gate: { status: 'passed', reached: 'gold', failed: [] }, iterations: 1, compareMs: 2100 },
  ] });
  const table = benchTable(report);
  assert.match(table, /Heimdall-Bench · f1\.test\/home · silver/);
  assert.match(table, /脚手架 \| 5\.00% \| 7\.00% \| 9\.00% \| failed: visual,structure \| 0 \|/);
  assert.match(table, /人写 \| 100\.00% \| 100\.00% \| 100\.00% \| passed \(gold\) \| 1 \|/);
  assert.match(table, /快速裁判的 passed 不是正式裁判的通过/);
});
