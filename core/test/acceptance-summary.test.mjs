import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceMarkdown, buildAcceptanceSummary, pageKey } from '../../console/src/acceptance.js';

const artifact = (data, mtime = '2026-10-14T12:00:00.000Z') => ({ status: 'ok', data, mtime });
const missing = { status: 'missing' };
const page = (name, target, updatedAt, verify = {}) => ({ name, target, updatedAt, ...verify });

test('URL identity keeps query and origin while treating a non-root trailing slash as equal', () => {
  assert.equal(pageKey('https://site.test/docs/?page=1#intro'), 'https://site.test/docs?page=1');
  assert.notEqual(pageKey('https://site.test/docs?page=1'), pageKey('https://site.test/docs?page=2'));
  assert.notEqual(pageKey('http://site.test/docs'), pageKey('https://site.test/docs'));
});

test('missing plan and whole-site verify stay unknown, while v2 page measurement counts only current clones', () => {
  const summary = buildAcceptanceSummary({ site: { host: 'site.test' }, sources: {
    atlas: artifact({ nodes: [{ url: 'https://site.test/' }, { url: 'https://site.test/docs' }], meta: { maxPages: 20 } }),
    queue: missing,
    pages: artifact({ pages: [page('home', 'https://site.test/', 1000, {
      verifyFresh: true, verifyMeasured: true, verifyScoreVersion: 2, minViewport: { score: 0.9 },
    })] }),
    verify: missing, assets: missing, linker: missing,
  } });
  assert.equal(summary.discovered, 2);
  assert.equal(summary.planned, null);
  assert.equal(summary.cloned, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.untested, 1);
  assert.equal(summary.visualGaps, null);
  assert.equal(summary.verificationState, 'missing');
  assert.match(acceptanceMarkdown(summary), /计划克隆（唯一 URL） \| 未生成 \/ 不可统计/);
});

test('stale gap scan and old or incomplete verification cannot produce a green verdict', () => {
  const late = Date.parse('2026-10-14T12:00:00.000Z');
  const summary = buildAcceptanceSummary({ site: { host: 'site.test' }, sources: {
    atlas: artifact({ nodes: [{ url: 'https://site.test/a' }, { url: 'https://site.test/b' }], failures: [] }),
    queue: artifact([{ name: 'a', url: 'https://site.test/a', status: 'done' },
      { name: 'b', url: 'https://site.test/b', status: 'failed', error: 'navigation timeout' }]),
    pages: artifact({ pages: [page('a', 'https://site.test/a', late, {
      verifyFresh: true, verifyMeasured: true, verifyScoreVersion: 1,
    }), page('other', 'https://site.test/other', late, {
      verifyFresh: true, verifyMeasured: false, verifyScoreVersion: 2,
    })] }),
    verify: artifact({ mode: 'all', passed: true, pages: [] }, '2026-10-13T12:00:00.000Z'),
    assets: artifact({ generatedAt: '2026-10-13T12:00:00.000Z', summary: { visual: 0, gaps: 0 }, pages: [] }),
    linker: artifact({ pages: [] }, '2026-10-13T12:00:00.000Z'),
  } });
  assert.equal(summary.planned, 2);
  assert.equal(summary.plannedCloned, 1);
  assert.equal(summary.cloned, 2);
  assert.equal(summary.verified, 0);
  assert.equal(summary.legacy, 1);
  assert.equal(summary.partial, 1);
  assert.equal(summary.untested, 3);
  assert.equal(summary.visualGaps, null);
  assert.equal(summary.assetFailed, null);
  assert.equal(summary.verificationState, 'stale');
  assert.equal(summary.scoreVersion, 1);
  assert.ok(summary.failures.some(f => f.reason.includes('navigation timeout')));
  assert.ok(summary.failures.some(f => f.evidence === 'verify/other/verify.json'));
  const md = acceptanceMarkdown(summary);
  assert.match(md, /\| 资产扫描 \| 需重跑 \| GET \/static\/site\.test\/audit\/asset-gaps\.json \|/);
  assert.match(md, /\| 克隆产物 \| 已生成 \| GET \/api\/pages\/site\.test \|/);
});

test('whole-site v2 pass requires every target measured; explicit verification failure stays failed', () => {
  const time = Date.parse('2026-10-14T10:00:00.000Z');
  const measuredAt = '2026-10-14T11:00:00.000Z';
  const summaryPages = [
    { page: 'home', measured: true, measuredAt, overall: 0.95, minViewport: { name: 'mobile', score: 0.94 } },
    { page: 'docs', measured: true, measuredAt, overall: 0.97, minViewport: { name: 'mobile', score: 0.96 } },
  ];
  const sources = {
    atlas: artifact({ nodes: [{ url: 'https://site.test/' }, { url: 'https://site.test/docs' }] }),
    queue: artifact([{ name: 'home', url: 'https://site.test/', status: 'done' },
      { name: 'docs', url: 'https://site.test/docs', status: 'done' }]),
    pages: artifact({ pages: [page('home', 'https://site.test/', time, {
      verifyFresh: true, verifyMeasured: true, verifyScoreVersion: 2, verifyMeasuredAt: measuredAt,
      verifyOverall: 0.95, minViewport: { name: 'mobile', score: 0.94 },
    }), page('docs', 'https://site.test/docs', time, {
      verifyFresh: true, verifyMeasured: true, verifyScoreVersion: 2, verifyMeasuredAt: measuredAt,
      verifyOverall: 0.97, minViewport: { name: 'mobile', score: 0.96 },
    })] }),
    verify: artifact({ generatedAt: '2026-10-14T12:00:00.000Z', scoreVersion: 2, mode: 'all', passed: true, pages: summaryPages }),
    assets: artifact({ summary: { visual: 0, gaps: 0 }, pages: [{ page: 'home' }, { page: 'docs' }] }),
    linker: artifact({ pages: [{ name: 'home', assetFailed: 0, missingLocal: [], linksToLive: 0 },
      { name: 'docs', assetFailed: 0, missingLocal: [], linksToLive: 0 }] }),
  };
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'passed');
  assert.match(acceptanceMarkdown(buildAcceptanceSummary({ site: { host: 'site.test' }, sources })), /当前目标多视口状态：多视口验证通过/);
  sources.verify = artifact({ scoreVersion: 2, mode: 'sample', passed: true, pages: [] });
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'sample');
  sources.verify = artifact({ scoreVersion: 2, mode: 'all', passed: false, pages: [] });
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'failed');
  sources.verify = artifact({ scoreVersion: 2, mode: 'all', passed: false,
    pages: [{ page: 'home', measured: false }] });
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'stale', 'a later single-page success supersedes the old failure');
  sources.verify = artifact({ scoreVersion: 2, mode: 'all', passed: true, pages: summaryPages });
  sources.pages.data.pages[1].verifyMeasuredAt = '2026-10-14T12:01:00.000Z';
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'stale', 'a later single-page measurement cannot reuse the old verdict');
  sources.pages.data.pages[1].verifyMeasuredAt = measuredAt;
  sources.pages.data.pages[1].verifyOverall = 0.80;
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'stale', 'a changed score cannot reuse the old verdict');
  sources.pages.data.pages[1].verifyOverall = 0.97;
  sources.pages.data.pages[1].verifyFresh = false;
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'stale');
});

test('failed evidence is carried into downloadable Markdown with source path', () => {
  const summary = buildAcceptanceSummary({ site: { host: 'site.test' }, sources: {
    atlas: artifact({ nodes: [], failures: [{ url: 'https://site.test/x', reason: 'HTTP 500' }] }),
    queue: artifact([{ name: 'x', url: 'https://site.test/x', status: 'failed', error: 'browser closed' }]),
    pages: artifact({ pages: [] }), verify: missing, assets: missing, linker: missing,
  } });
  const md = acceptanceMarkdown(summary);
  assert.match(md, /HTTP 500（recon\/atlas\.json）/);
  assert.match(md, /browser closed（queue\.json）/);
  assert.match(md, /评分版本：未生成 \/ 不可统计/);
  assert.match(md, /\| 多视口验证 \| 未生成 \| GET \/static\/site\.test\/verify\/verify-summary\.json \|/);
});

test('discovered clone scope keeps the denominator and not-queued gap separate from the default plan', () => {
  const summary = buildAcceptanceSummary({ site: { host: 'site.test' }, sources: {
    atlas: artifact({ nodes: [
      { url: 'https://site.test/' }, { url: 'https://site.test/login', type: 'auth' },
      { url: 'https://site.test/terms', type: 'legal' },
    ] }),
    queue: artifact([{ url: 'https://site.test/', status: 'done' }]),
    scope: artifact({ scope: {
      status: 'ok', discovered: 3, eligible: 1, excludedByDefault: 2,
      inQueue: 1, notQueued: 2, limitReached: true, maxPages: 3, maxDepth: 2,
      excludedByType: 2, excludedByPageLimit: 0,
      invalidNodes: 1, foreignNodes: 1, reconFailures: 2,
    } }),
    pages: artifact({ pages: [] }), verify: missing, assets: missing, linker: missing,
  } });
  assert.equal(summary.states.scope, 'ok');
  assert.equal(summary.scopeDiscovered, 3);
  assert.equal(summary.scopeEligible, 1);
  assert.equal(summary.scopeExcludedByDefault, 2);
  assert.equal(summary.scopeExcludedByType, 2);
  assert.equal(summary.scopeExcludedByPageLimit, 0);
  assert.equal(summary.scopeNotQueued, 2);
  assert.equal(summary.scopeInvalidNodes, 1);
  assert.equal(summary.scopeForeignNodes, 1);
  assert.equal(summary.scopeReconFailures, 2);
  assert.equal(summary.planned, 1);
  const md = acceptanceMarkdown(summary);
  assert.match(md, /\| 已发现有效同源 URL（范围分母） \| 3 \|/);
  assert.match(md, /\| 已发现但未入队 \| 2 \|/);
  assert.match(md, /\| 侦察达到页数上限 \| 是 \|/);
  assert.match(md, /\| 站外侦察节点（不计入分母） \| 1 \|/);
  assert.match(md, /仅统计当前侦察已发现的有效同源 URL，不代表站点全部页面/);
  assert.match(md, /\| 队列范围 \| 已生成 \| GET \/api\/queue\/site\.test \|/);
});

test('invalid clone scope is unknown rather than a zero-page success', () => {
  const summary = buildAcceptanceSummary({ site: { host: 'site.test' }, sources: {
    scope: artifact({ scope: { status: 'ok', discovered: 4, eligible: 2, inQueue: 1 } }),
    pages: artifact({ pages: [] }),
  } });
  assert.equal(summary.states.scope, 'error');
  assert.equal(summary.scopeDiscovered, null);
  assert.equal(summary.scopeNotQueued, null);
  assert.match(acceptanceMarkdown(summary), /\| 已发现但未入队 \| 未生成 \/ 不可统计 \|/);
});
