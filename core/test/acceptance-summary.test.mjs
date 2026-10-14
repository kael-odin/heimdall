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
  const sources = {
    atlas: artifact({ nodes: [{ url: 'https://site.test/' }, { url: 'https://site.test/docs' }] }),
    queue: artifact([{ name: 'home', url: 'https://site.test/', status: 'done' },
      { name: 'docs', url: 'https://site.test/docs', status: 'done' }]),
    pages: artifact({ pages: [page('home', 'https://site.test/', time, {
      verifyFresh: true, verifyMeasured: true, verifyScoreVersion: 2, minViewport: { score: 0.94 },
    }), page('docs', 'https://site.test/docs', time, {
      verifyFresh: true, verifyMeasured: true, verifyScoreVersion: 2, minViewport: { score: 0.96 },
    })] }),
    verify: artifact({ generatedAt: '2026-10-14T12:00:00.000Z', scoreVersion: 2, mode: 'all', passed: true, pages: [] }),
    assets: artifact({ summary: { visual: 0, gaps: 0 }, pages: [{ page: 'home' }, { page: 'docs' }] }),
    linker: artifact({ pages: [{ name: 'home', assetFailed: 0, missingLocal: [], linksToLive: 0 },
      { name: 'docs', assetFailed: 0, missingLocal: [], linksToLive: 0 }] }),
  };
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'passed');
  assert.match(acceptanceMarkdown(buildAcceptanceSummary({ site: { host: 'site.test' }, sources })), /全站多视口状态：多视口验证通过/);
  sources.verify = artifact({ scoreVersion: 2, mode: 'sample', passed: true, pages: [] });
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'sample');
  sources.verify = artifact({ scoreVersion: 2, mode: 'all', passed: false, pages: [] });
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'failed');
  sources.verify = artifact({ scoreVersion: 2, mode: 'all', passed: true, pages: [] });
  sources.pages.data.pages[1].verifyFresh = false;
  assert.equal(buildAcceptanceSummary({ sources }).verificationState, 'incomplete');
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
