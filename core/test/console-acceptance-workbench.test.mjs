import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptanceEvidenceEntries, acceptanceEvidenceFilename, acceptanceScore, acceptanceViewport,
  buildAcceptanceInput, filterAcceptanceChecks,
} from '../../console/src/acceptance-workbench.js';

const form = overrides => ({ name: '首页验收', mode: 'mirror', baselineUrl: 'https://baseline.test',
  targetUrl: 'http://127.0.0.1:3000', routes: '/', points: '', maskSelectors: '', ...overrides });

test('acceptance form submits distinct routes and lets the engine choose default viewports', () => {
  assert.deepEqual(buildAcceptanceInput(form({ routes: '/\n /products?category=all \n/\n' })), {
    name: '首页验收', mode: 'mirror', baselineUrl: 'https://baseline.test/', targetUrl: 'http://127.0.0.1:3000/',
    routes: ['/', '/products?category=all'],
  });
});

test('acceptance form keeps behavior points and normalization configuration', () => {
  const points = [{ id: 'MENU', title: '菜单', assertions: [{ kind: 'visible', selector: 'nav' }] }];
  const result = buildAcceptanceInput(form({ name: ' ', mode: 'regression', points: JSON.stringify(points), maskSelectors: '[".clock"]' }));
  assert.equal(result.name, '项目回归验收');
  assert.deepEqual(result.points, points);
  assert.deepEqual(result.normalization, { maskSelectors: ['.clock'] });
});

test('invalid URLs, routes and advanced configuration fail before creating a task', () => {
  for (const value of ['javascript:alert(1)', 'file:///test', 'https://user:password@test/', 'https://test/#fragment']) {
    assert.throws(() => buildAcceptanceInput(form({ baselineUrl: value })), /基线 URL/);
  }
  assert.throws(() => buildAcceptanceInput(form({ targetUrl: 'https://baseline.test/' })), /不同的地址/);
  for (const routes of ['', 'https://foreign.test', '//foreign.test', '/%2fexample.com', '/%252e%252e/private', '/a\\b', '/a#fragment', '/bad%encoding']) {
    assert.throws(() => buildAcceptanceInput(form({ routes })), /路由/);
  }
  assert.throws(() => buildAcceptanceInput(form({ routes: Array.from({ length: 9 }, (_, i) => `/route-${i}`).join('\n') })), /8 条/);
  for (const points of ['{', '{}', '[null]', '["click"]']) assert.throws(() => buildAcceptanceInput(form({ points })), /验收点/);
  for (const maskSelectors of ['{}', '[12]', '[""]']) assert.throws(() => buildAcceptanceInput(form({ maskSelectors })), /忽略区域/);
});

const checks = [
  { id: 'visual', title: '视觉像素差异', dimension: 'visual', route: '/', status: 'failed', verdict: 'bug', expected: { score: 0.97 }, actual: { score: 0.8 } },
  { id: 'baseline', title: '基线交互失败', dimension: 'behavior', route: '/menu', status: 'blocked', verdict: 'baseline_failed' },
  { id: 'review', title: '交互需复核', dimension: 'behavior', route: '/products', status: 'needs_review', verdict: 'needs_review' },
  { id: 'passed', title: '页面结构一致', dimension: 'structure', route: '/', status: 'passed', verdict: 'match' },
];

test('attention filters preserve baseline and review findings without classifying them as target bugs', () => {
  assert.deepEqual(filterAcceptanceChecks(checks).map(x => x.id), ['visual', 'baseline', 'review']);
  assert.deepEqual(filterAcceptanceChecks(checks, { verdict: 'bug' }).map(x => x.id), ['visual']);
  assert.deepEqual(filterAcceptanceChecks(checks, { dimension: 'behavior' }).map(x => x.id), ['baseline', 'review']);
  assert.deepEqual(filterAcceptanceChecks(checks, { verdict: 'all', query: '0.97' }).map(x => x.id), ['visual']);
  assert.deepEqual(filterAcceptanceChecks(checks, { verdict: 'all', query: '/products' }).map(x => x.id), ['review']);
  assert.equal(filterAcceptanceChecks(checks, { verdict: 'all' }).length, 4);
  assert.equal(checks.length, 4);
});

test('evidence accepts only flat PNG/JSON files from the acceptance API', () => {
  assert.equal(acceptanceEvidenceFilename('run-1.desktop-target.png'), 'run-1.desktop-target.png');
  assert.equal(acceptanceEvidenceFilename('details.json'), 'details.json');
  for (const value of ['https://remote.test/a.png', '../a.png', '/a.png', 'nested/a.png', 'nested\\a.png', 'a.svg', 'a.png?token=secret', '..', null, { filename: 'a.png' }]) {
    assert.equal(acceptanceEvidenceFilename(value), '');
  }
});

test('unmeasured values remain unmeasured in report presentation', () => {
  assert.equal(acceptanceScore(null), '未测量');
  assert.equal(acceptanceScore(0.97), '97.0%');
  assert.equal(acceptanceScore(97), '97.0%');
  assert.equal(acceptanceScore(0), '0.0%');
  assert.equal(acceptanceViewport({ width: 375, height: 812 }), '375 × 812');
  assert.equal(acceptanceViewport('desktop'), 'desktop');
});

test('paired JSON evidence is available for current and persisted report layouts', () => {
  const current = acceptanceEvidenceEntries({ evidence: { baselineScreenshot: 'base.png', baselineDetails: 'base.json', targetDetails: 'target.json', diff: 'diff.png' } });
  assert.deepEqual(current.map(item => item.filename), ['base.png', 'diff.png', 'base.json', 'target.json']);
  const previous = acceptanceEvidenceEntries({ evidence: { baselineDetails: 'base.json', details: { baseline: 'base.json', target: 'target.json' }, diff: 'https://foreign.test/diff.png' } });
  assert.deepEqual(previous.map(item => item.filename), ['base.json', 'target.json']);
});
