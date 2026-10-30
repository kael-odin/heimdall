/**
 * 候选侧样式差与元素对齐的纯函数测试（无浏览器）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { styleDiffOf, boxDiffOf } from '../src/agent/evidence/element-style.mjs';
import { leadStyleDiffOf } from '../src/agent/evidence/element-style.mjs';
import { matchCandidateElement, enrichElementHints } from '../src/agent/evidence/candidate-elements.mjs';
import { compactFixPacket } from '../src/agent/activity.mjs';

test('styleDiff: reports numeric deltas and ignores equivalent colours', () => {
  const diffs = styleDiffOf(
    { fontSize: '52px', lineHeight: '62.4px', color: 'rgb(20, 33, 61)', paddingTop: '16px' },
    { fontSize: '46px', lineHeight: '55.2px', color: 'rgb(20,33,61)', paddingTop: '40px' },
  );
  const by = Object.fromEntries(diffs.map(d => [d.prop, d]));
  assert.equal(by.fontSize.delta, -6);
  assert.equal(by.lineHeight.delta, -7.2);
  assert.equal(by.paddingTop.delta, 24);
  assert.equal(by.color, undefined, 'whitespace-only colour differences are not findings');
});

test('styleDiff: missing reference padding means 0px, not silence', () => {
  const diffs = styleDiffOf({}, { paddingTop: '28px', gap: '40px' });
  const by = Object.fromEntries(diffs.map(d => [d.prop, d]));
  assert.equal(by.paddingTop.ref, '0px');
  assert.equal(by.paddingTop.delta, 28);
  assert.equal(by.gap.delta, 40);
});

test('styleDiff: equal styles produce no noise', () => {
  assert.deepEqual(styleDiffOf({ fontSize: '16px', color: 'rgb(1, 2, 3)' }, { fontSize: '16px', color: 'rgb(1, 2, 3)' }), []);
  assert.deepEqual(styleDiffOf({ padding: '0px 0px' }, { padding: '0px' }), [], 'zero shorthand spellings are equal');
});

test('styleDiff: old reference shorthand fills missing per-side values', () => {
  const diffs = styleDiffOf(
    { padding: '0px 40px', margin: '48px 0px 0px', border: '1px solid rgb(0, 0, 0)', gap: '48px' },
    { padding: '0px 40px', margin: '48px 0px 0px', border: '1px solid rgb(0, 0, 0)', gap: '48px', paddingRight: '40px', paddingLeft: '40px', marginTop: '48px', borderTopWidth: '1px', borderLeftWidth: '1px', rowGap: '48px', columnGap: '48px' },
  );
  assert.deepEqual(diffs, [], 'shorthand-derived sides are not false differences');
});

test('styleDiff: a property missing on the candidate is a real difference', () => {
  const diffs = styleDiffOf({ backgroundColor: 'rgb(255, 255, 255)', paddingTop: '16px', width: '114px' }, {});
  const by = Object.fromEntries(diffs.map(d => [d.prop, d]));
  assert.equal(by.backgroundColor.cand, 'rgba(0, 0, 0, 0)');
  assert.equal(by.paddingTop.cand, '0px');
  assert.equal(by.width.cand, 'auto');
});

test('boxDiff: signed width/height deltas', () => {
  assert.deepEqual(boxDiffOf({ x: 0, y: 0, w: 335, h: 885 }, { x: 0, y: 0, w: 335, h: 888 }), { x: 0, y: 0, w: 0, h: 3 });
});

test('match: exact text wins, with same tag and section', () => {
  const ref = { ref: 'sec-hero/e3', sectionId: 'sec-hero', sel: 'h1', text: 'Northwind Atlas', box: { x: 40, y: 160, w: 520, h: 62 } };
  const index = [
    { i: 0, tag: 'section', sectionId: 'sec-hero', root: true, box: { x: 0, y: 100, w: 1440, h: 500 } },
    { i: 1, tag: 'h1', sectionId: 'sec-hero', text: 'Northwind Atlas', box: { x: 40, y: 160, w: 500, h: 60 }, style: { fontSize: '46px' } },
    { i: 2, tag: 'h1', sectionId: 'sec-other', text: 'Northwind Atlas', box: { x: 0, y: 0, w: 500, h: 60 } },
  ];
  const m = matchCandidateElement(ref, index);
  assert.equal(m.by, 'text');
  assert.equal(m.element.i, 1);
});

test('match: section root is matched by marker, not by text', () => {
  const ref = { ref: 'sec-features/e0', sectionId: 'sec-features', sel: 'section', box: { x: 0, y: 800, w: 1440, h: 600 } };
  const index = [{ i: 0, tag: 'section', sectionId: 'sec-features', root: true, box: { x: 0, y: 800, w: 1440, h: 600 } }];
  const m = matchCandidateElement(ref, index);
  assert.equal(m.by, 'section-root');
  assert.equal(m.element.i, 0);
});

test('match: structural fallback uses relative position inside the section', () => {
  const ref = { ref: 'sec-features/e4', sectionId: 'sec-features', sel: 'div', box: { x: 40, y: 900, w: 1200, h: 320 } };
  const index = [
    { i: 0, tag: 'section', sectionId: 'sec-features', root: true, box: { x: 0, y: 800, w: 1440, h: 600 } },
    { i: 1, tag: 'div', sectionId: 'sec-features', box: { x: 40, y: 910, w: 1200, h: 320 } },
    { i: 2, tag: 'div', sectionId: 'sec-features', box: { x: 40, y: 1250, w: 1200, h: 100 } },
  ];
  const m = matchCandidateElement(ref, index, { sectionBoxes: { 'sec-features': { x: 0, y: 800, w: 1440, h: 600 } } });
  assert.equal(m.by, 'structure');
  assert.equal(m.element.i, 1);
});

test('match: a far-away element of the same tag is not claimed', () => {
  const ref = { ref: 'sec-hero/e9', sectionId: 'sec-hero', sel: 'div', box: { x: 40, y: 300, w: 200, h: 40 } };
  const index = [
    { i: 0, tag: 'section', sectionId: 'sec-hero', root: true, box: { x: 0, y: 0, w: 1440, h: 5000 } },
    { i: 1, tag: 'div', sectionId: 'sec-hero', box: { x: 0, y: 4800, w: 200, h: 40 } },
  ];
  assert.equal(matchCandidateElement(ref, index, { sectionBoxes: { 'sec-hero': { x: 0, y: 0, w: 1440, h: 5000 } } }), null);
});

test('enrich: attaches cand, match and styleDiff without mutating the reference fields', () => {
  const hints = { best: [{ ref: 'sec-hero/e3', sectionId: 'sec-hero', sel: 'h1', text: 'Northwind Atlas', box: { x: 40, y: 160, w: 520, h: 62 }, style: { fontSize: '52px' } }], container: null };
  const index = [{ i: 0, tag: 'h1', sectionId: 'sec-hero', text: 'Northwind Atlas', box: { x: 40, y: 160, w: 520, h: 62 }, style: { fontSize: '46px' } }];
  const out = enrichElementHints(hints, index);
  assert.equal(out.best[0].style.fontSize, '52px');
  assert.equal(out.best[0].cand.style.fontSize, '46px');
  assert.equal(out.best[0].match.by, 'text');
  assert.equal(out.best[0].styleDiff.find(d => d.prop === 'fontSize').delta, -6);
});

test('leadStyleDiff: picks the first region with a candidate-side diff', () => {
  const regions = [
    { id: 'r1', element: { best: [{ ref: 'sec-hero/e3', styleDiff: [] }] } },
    { id: 'r2', element: { best: [{ ref: 'sec-hero/e4' }], diffs: [{ ref: 'sec-hero/e5', styleDiff: [{ prop: 'gap', ref: '16px', cand: '40px', delta: 24 }] }] } },
  ];
  const lead = leadStyleDiffOf(regions);
  assert.equal(lead.ref, 'sec-hero/e5');
  assert.equal(lead.diffs[0].prop, 'gap');
});

test('activity: compact fix packet keeps the top regions and their style diffs', () => {
  const packet = {
    runId: 'run_1', generatedAt: '2026-10-31T00:00:00.000Z', verdict: { status: 'needs-work' }, order: ['r1', 'r2'],
    regions: [
      { id: 'r1', sectionId: 'sec-hero', cause: 'font', severity: 'high', bbox: { x: 1, y: 2, w: 3, h: 4 }, hint: '字号',
        element: { best: [{ ref: 'sec-hero/e3', styleDiff: [{ prop: 'fontSize', ref: '52px', cand: '46px', delta: -6 }] }] } },
      { id: 'r2', sectionId: 'sec-hero', cause: 'spacing', element: { best: [{ ref: 'sec-hero/e4' }], diffs: [{ ref: 'sec-hero/e5', styleDiff: [{ prop: 'gap', ref: '16px', cand: '40px', delta: 24 }] }] } },
    ],
  };
  const out = compactFixPacket(packet);
  assert.equal(out.regions.length, 2);
  assert.equal(out.regions[0].diffs[0].prop, 'fontSize');
  assert.equal(out.regions[1].diffs[0].prop, 'gap');
  assert.equal(out.verdict, 'needs-work');
});
