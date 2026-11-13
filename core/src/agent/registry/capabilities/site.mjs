/**
 * capability: site —— 站点级结构化信息（附录 A §2.2，E2-02）
 *
 * view: summary（默认）/ pages / coverage / gaps。读工作区，不需要引擎。
 * 页面 URL 来自网页（manifest.target），按不可信字段处理。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { createFence } from '../../fence.mjs';
import { redactText } from '../../redact.mjs';
import { listPages, pageDir, siteDir } from '../../workspace.mjs';
import { measurementCoverage, scanMeasurementsAsync } from '../../../verify/measurement-status.mjs';
import { readCurrentScore } from '../../../score-status.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

function pageRow(siteId, page, fence, measurement, scanStatus) {
  const dir = pageDir(siteId, page);
  const manifest = readJson(join(dir, 'manifest.json'));
  const { score, status: scoreStatus } = readCurrentScore(dir);
  const verify = measurement?.status === 'verified' ? measurement.result : null;
  return {
    page,
    target: manifest?.target ? fence.inline(redactText(manifest.target).text, 300, 'target') : null,
    mirror: existsSync(join(dir, 'clone', 'index.html')),
    score: score ? { total: score.total ?? null, grade: score.grade ?? null, pixel: score.pixel ?? null } : null,
    scoreStatus,
    verify: verify ? { measured: !!verify.measured, overall: verify.overall ?? null, minViewport: verify.minViewport ? { name: verify.minViewport.name, score: verify.minViewport.score } : null } : null,
    verifyStatus: scanStatus === 'ok' ? measurement?.status ?? 'unavailable' : scanStatus,
  };
}

export default {
  id: 'site',
  title: '站点：页面、覆盖与缺口',
  description: 'Structured information about one cloned site: summary, the page list (mirror present, clone score, multi-viewport verify score), '
    + 'coverage (discovered vs cloned vs verified) or known gaps. Use to decide which pages to rebuild and to find unmeasured pages. '
    + 'Read-only. For per-page rebuild evidence use heimdall_brief.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false, required: ['siteId'],
    properties: {
      siteId: { type: 'string', minLength: 1, maxLength: 253, description: 'Site id from heimdall_overview, e.g. "example.org"' },
      view: { type: 'string', enum: ['summary', 'pages', 'coverage', 'gaps'], default: 'summary' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
      cursor: { type: 'integer', minimum: 0, default: 0, description: 'Offset into the page list (from meta.nextCursor)' },
    },
  },
  cli: { usage: 'site <siteId> [--view summary|pages|coverage|gaps] [--limit N]', positional: ['siteId'] },
  async handler(args) {
    const { siteId, view, limit, cursor } = args;
    const pages = listPages(siteId);
    const fence = createFence();
    const atlas = readJson(join(siteDir(siteId), 'recon', 'atlas.json'));
    const mirrors = pages.filter(p => existsSync(join(pageDir(siteId, p), 'clone', 'index.html')));
    const selected = view === 'pages' ? pages.slice(cursor, cursor + limit) : view === 'gaps' ? [] : pages;
    const scan = await scanMeasurementsAsync(siteDir(siteId), selected);
    const measurements = new Map(scan.pages.map(row => [row.page, row]));
    const verification = measurementCoverage(scan, selected.length);
    const coverage = {
      discovered: atlas?.nodes?.length ?? null, pages: pages.length, cloned: mirrors.length,
      verified: verification.verified, unmeasured: verification.unmeasured,
      verifyAverage: verification.average, verificationStatus: verification.status,
    };
    let result, summary, meta;
    if (view === 'pages') {
      const rows = selected.map(p => pageRow(siteId, p, fence, measurements.get(p), scan.status));
      const next = cursor + limit < pages.length ? cursor + limit : null;
      result = { siteId, pages: rows, total: pages.length };
      meta = next !== null ? { nextCursor: next, truncated: true } : undefined;
      summary = `${siteId}：第 ${cursor + 1}–${cursor + rows.length} 页，共 ${pages.length} 页。`;
    } else if (view === 'coverage') {
      result = { siteId, coverage };
      summary = `${siteId}：${coverage.cloned}/${coverage.pages} 页有镜像${coverage.verified !== null ? `，多视口验证测到 ${coverage.verified} 页` : ''}。`;
    } else if (view === 'gaps') {
      const gaps = [];
      for (const p of mirrors.slice(0, 200)) {
        const g = readJson(join(pageDir(siteId, p), 'gaps.json'));
        const n = (g?.failed?.length ?? 0) + (g?.notCaptured?.length ?? 0) + (g?.cssSheetsUnreadable?.length ?? 0);
        if (n) gaps.push({ page: p, failed: g.failed?.length ?? 0, notCaptured: g.notCaptured?.length ?? 0, cssUnreadable: g.cssSheetsUnreadable?.length ?? 0 });
      }
      result = { siteId, gaps: gaps.slice(0, limit), pagesWithGaps: gaps.length };
      summary = gaps.length ? `${siteId}：${gaps.length} 页有资源缺口。` : `${siteId}：镜像里没有记录到资源缺口。`;
    } else {
      result = { siteId, coverage, samplePages: mirrors.slice(0, 10) };
      summary = `${siteId}：${pages.length} 页，其中 ${mirrors.length} 页有镜像。`;
    }
    if (!pages.length) throw new CapabilityError('not_found', `${siteId} 下没有页面`, { nextActions: [nextAction('heimdall_clone', { siteId }, '先克隆页面')] });
    const firstMirror = mirrors[0];
    const nextActions = firstMirror
      ? [nextAction('heimdall_brief', { siteId, page: firstMirror, detail: 'sections' }, '取这一页的简报与分段，开始重建')]
      : [nextAction('heimdall_clone', { siteId }, '还没有镜像：先克隆')];
    return ok(result, { summary, nextActions, meta, ...(view === 'pages' ? { trust: fence.trust(['result.pages[*].target']), warnings: fence.warnings() } : {}) });
  },
};
