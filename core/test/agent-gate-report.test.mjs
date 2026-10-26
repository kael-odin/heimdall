/**
 * 门禁定义与逐维报告（E7-06）：六维、四级阈值、未测不猜
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeGate, gateText, thresholdsFor, DEFAULT_THRESHOLDS } from '../src/agent/gate/report.mjs';

const vp = (over = {}) => ({ pixelSimilarity: 1, maxBlobPct: 0, maxRegionPct: 0, highRegions: 0, ...over });
const health = (over = {}) => ({ externalHosts: [], failedRequests: 0, brokenImages: 0, consoleErrors: 0, pageErrors: 0, overflowPx: 0, perViewport: [], ...over });

function packet(over = {}) {
  return {
    runId: 'run_20261026T000000Z_abcdef', siteId: 'gate.test', page: 'home',
    perViewport: { 375: vp(), 768: vp(), 1440: vp() },
    regions: [],
    anticheat: { status: 'clean', findings: [], stats: { bitmapsScanned: 1, textCoverage: 0.98 } },
    pagehealth: health(),
    ...over,
  };
}

test('gate: a perfect page passes at gold and the report lists every dimension', () => {
  const g = composeGate(packet(), { level: 'gold' });
  assert.equal(g.status, 'passed');
  assert.equal(g.reached, 'gold');
  assert.deepEqual(g.dimensions.map(d => d.id), ['visual', 'structure', 'style', 'assets', 'health', 'anticheat']);
  assert.ok(g.dimensions.every(d => d.status === 'pass'));
  assert.equal(g.judge, 'fast');
  assert.match(g.verdictAuthority, /formal judge/);
});

test('gate: thresholds are per level and can be overridden', () => {
  const g = composeGate(packet({ perViewport: { 1440: vp({ pixelSimilarity: 0.975 }) } }), { level: 'silver' });
  assert.equal(g.status, 'passed');
  assert.equal(g.reached, 'silver');
  const gold = composeGate(packet({ perViewport: { 1440: vp({ pixelSimilarity: 0.975 }) } }), { level: 'gold' });
  assert.equal(gold.status, 'failed');
  assert.equal(gold.dimensions.find(d => d.id === 'visual').status, 'fail');
  assert.match(gold.dimensions.find(d => d.id === 'visual').notes[0], /1440/);

  const loose = composeGate(packet({ perViewport: { 1440: vp({ pixelSimilarity: 0.96 }) } }), { level: 'gold', thresholds: { visual: { pixel: { gold: 0.95 } } } });
  assert.equal(loose.dimensions.find(d => d.id === 'visual').status, 'pass');
  assert.equal(thresholdsFor('gold').visual.pixel, 0.99, 'defaults are untouched');
  assert.equal(DEFAULT_THRESHOLDS.style.maxStyleRegions.silver, 1);
});

test('gate: structure counts missing sections and judges text coverage', () => {
  const missing = composeGate(packet({ regions: [{ id: 'r1', kind: 'missing-section', cause: 'missing-content' }] }), { level: 'bronze' });
  assert.equal(missing.status, 'failed');
  const thin = composeGate(packet({ anticheat: { status: 'clean', findings: [], stats: { textCoverage: 0.5 } } }), { level: 'silver' });
  assert.equal(thin.dimensions.find(d => d.id === 'structure').status, 'fail');
  assert.match(thin.dimensions.find(d => d.id === 'structure').detail, /50%/);
});

test('gate: style counts only font, size and colour regions', () => {
  const regions = [
    { id: 'a', cause: 'font' }, { id: 'b', cause: 'color' }, { id: 'c', cause: 'spacing' }, { id: 'd', cause: 'shift' },
  ];
  const g = composeGate(packet({ regions }), { level: 'silver' });
  const style = g.dimensions.find(d => d.id === 'style');
  assert.equal(style.value.styleRegions, 2, 'spacing and shift are layout, not style');
  assert.equal(style.status, 'fail', 'silver allows 1');
  assert.equal(composeGate(packet({ regions }), { level: 'bronze' }).dimensions.find(d => d.id === 'style').status, 'pass');
});

test('gate: assets and health come from the page itself', () => {
  const ext = composeGate(packet({ pagehealth: health({ externalHosts: ['https://cdn.example'], failedRequests: 1 }) }), { level: 'bronze' });
  assert.equal(ext.dimensions.find(d => d.id === 'assets').status, 'fail', 'any external origin fails at every level');
  const healthyBronze = composeGate(packet({ pagehealth: health({ consoleErrors: 2 }) }), { level: 'bronze' });
  assert.equal(healthyBronze.dimensions.find(d => d.id === 'health').status, 'pass', 'bronze tolerates two console errors');
  const healthySilver = composeGate(packet({ pagehealth: health({ consoleErrors: 2 }) }), { level: 'silver' });
  assert.equal(healthySilver.dimensions.find(d => d.id === 'health').status, 'fail', 'silver tolerates none');
  const overflow = composeGate(packet({ pagehealth: health({ overflowPx: 12 }) }), { level: 'bronze' });
  assert.equal(overflow.dimensions.find(d => d.id === 'health').status, 'fail');
});

test('gate: anti-cheat overrides everything, and missing measurements are never a pass', () => {
  const cheat = composeGate(packet({ anticheat: { status: 'suspect', findings: [{ code: 'reference_screenshot_reused', severity: 'error', detail: 'x' }], stats: { textCoverage: 0.99 } } }), { level: 'bronze' });
  assert.equal(cheat.status, 'failed');
  assert.equal(cheat.dimensions.find(d => d.id === 'anticheat').status, 'fail');

  const noHealth = composeGate(packet({ pagehealth: null }), { level: 'bronze' });
  assert.equal(noHealth.status, 'incomplete');
  assert.equal(noHealth.dimensions.find(d => d.id === 'health').status, 'not_measured');

  const sectionScope = composeGate(packet({ anticheat: { status: 'clean', findings: [], stats: { textCoverage: null } } }), { level: 'bronze' });
  assert.equal(sectionScope.dimensions.find(d => d.id === 'structure').status, 'not_measured');
  assert.equal(sectionScope.status, 'incomplete');
});

test('gate: the human table shows every dimension', () => {
  const text = gateText(composeGate(packet(), { level: 'silver' }));
  for (const id of ['visual', 'structure', 'style', 'assets', 'health', 'anticheat']) assert.match(text, new RegExp(id));
  assert.match(text, /快速裁判/);
});
