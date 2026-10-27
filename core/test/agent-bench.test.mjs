/**
 * Heimdall-Bench 驱动（E14-01~03）：输出解析与报表
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFiles, scalarFeedback, targetedFeedback } from '../src/agent/bench/agent.mjs';
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
