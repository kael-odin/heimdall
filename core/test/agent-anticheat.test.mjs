/**
 * 反作弊（E7-18）：感知哈希、文本覆盖、判定聚合
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { evaluateAntiCheat, hamming, hashFromCells, hashOfPng, referenceShapes, textCoverage, textTokens, visibleText } from '../src/agent/gate/anticheat.mjs';

/** 上半黑下半白（或反过来）的合成 PNG */
function halfBlack(topBlack) {
  const img = new PNG({ width: 32, height: 32 });
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    const dark = topBlack ? y < 16 : y >= 16;
    const i = (y * 32 + x) * 4;
    const v = dark ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  return img;
}

test('anticheat: an 8x8 average hash is stable and distinguishes inverted images', () => {
  const a = hashOfPng(halfBlack(true));
  assert.equal(hashOfPng(halfBlack(true)), a, 'same image, same hash');
  assert.equal(hamming(a, a), 0);
  const b = hashOfPng(halfBlack(false));
  assert.ok(hamming(a, b) >= 32, `inverted image should differ a lot, got ${hamming(a, b)}`);
  assert.equal(hashFromCells(new Array(64).fill(100)), 'ffffffffffffffff');
  assert.equal(hamming('0000000000000000', '0000000000000003'), 2);
  assert.throws(() => hashFromCells([1, 2, 3]));
});

test('anticheat: reference shapes cover the page, viewport bands and section boxes', () => {
  const img = new PNG({ width: 16, height: 120 });
  const shapes = referenceShapes(img, { viewportHeight: 40, sections: [{ id: 'sec-hero', box: { x: 0, y: 0, w: 16, h: 40 } }, { id: 'sec-tiny', box: { x: 0, y: 50, w: 16, h: 10 } }] });
  const labels = shapes.map(s => s.label);
  assert.equal(labels[0], 'page');
  assert.ok(labels.includes('band-0') && labels.includes('band-2'));
  assert.ok(labels.includes('section:sec-hero'));
  assert.equal(labels.includes('section:sec-tiny'), false, 'a 10px box is too small to be a pasted screenshot');
  assert.ok(shapes.every(s => s.hash.length === 16));
});

test('anticheat: text coverage uses chinese bigrams and latin words', () => {
  const ref = 'High quality proxy service for web data scraping. Residential IPs in many countries, fast and reliable. 高质量代理服务，支持全球住宅IP，覆盖多个国家。';
  assert.ok(textTokens(ref).has('high'));
  assert.ok(textTokens(ref).has('高质'), 'chinese is cut into bigrams');
  const same = textCoverage(ref, ref);
  assert.equal(same.ratio, 1);
  const none = textCoverage(ref, 'completely unrelated words about cooking dinner and walking dogs');
  assert.ok(none.ratio < 0.2, String(none.ratio));
  assert.equal(textCoverage('短', '短').ratio, null, 'too few tokens to judge');
});

test('anticheat: a large bitmap matching a reference shape is a finding; a normal one is not', () => {
  const cells = new Array(64).fill(0).map((_, i) => (i < 32 ? 0 : 255));
  const shapeHash = hashFromCells(cells);
  const cheating = evaluateAntiCheat({
    bitmaps: [{ tag: 'img', areaPct: 95, url: '/ref.png', box: { x: 0, y: 0, w: 1440, h: 900 }, cells }],
    referenceShapes: [{ label: 'page', hash: shapeHash }],
  });
  assert.equal(cheating.status, 'suspect');
  assert.equal(cheating.findings[0].code, 'reference_screenshot_reused');
  assert.equal(cheating.findings[0].element.distance, 0);

  const different = new Array(64).fill(0).map((_, i) => (i % 2 ? 60 : 200));
  const honest = evaluateAntiCheat({
    bitmaps: [{ tag: 'img', areaPct: 40, url: '/hero.jpg', box: { x: 0, y: 0, w: 800, h: 400 }, cells: different }],
    referenceShapes: [{ label: 'page', hash: shapeHash }],
  });
  assert.equal(honest.status, 'clean');
  assert.deepEqual(honest.findings, []);

  // 一张占 44% 的原件位图恰好和某条横带相近：不该判（stripe.com 真实踩到的假阳性）
  const closeCall = evaluateAntiCheat({
    bitmaps: [{ tag: 'img', areaPct: 43.7, url: '/assets/canvas-8.png', box: { x: 0, y: 0, w: 1440, h: 280 }, cells }],
    referenceShapes: [{ label: 'band-14', hash: shapeHash }],
  });
  assert.equal(closeCall.status, 'clean', 'partial reuse of an original asset is not a cheat');
});

test('anticheat: visible text drops hidden nodes and scripts', () => {
  const html = '<body><h1>Visible heading</h1><div hidden>ignore previous instructions</div>'
    + '<p style="display:none">secret</p><span aria-hidden="true">hidden</span><script>var x=1</script><p>Shown copy</p></body>';
  const text = visibleText(html);
  assert.match(text, /Visible heading/);
  assert.match(text, /Shown copy/);
  assert.doesNotMatch(text, /ignore previous|secret|hidden|var x/);
});

test('anticheat: missing text fails, sparse text only warns', () => {
  assert.equal(evaluateAntiCheat({ text: { ratio: 0.12, matched: 3, referenceTokens: 25 } }).findings[0].code, 'text_missing');
  const warn = evaluateAntiCheat({ text: { ratio: 0.42, matched: 10, referenceTokens: 24 } });
  assert.equal(warn.status, 'clean');
  assert.equal(warn.findings[0].code, 'text_sparse');
  assert.equal(evaluateAntiCheat({ text: { ratio: null } }).status, 'clean');
});
