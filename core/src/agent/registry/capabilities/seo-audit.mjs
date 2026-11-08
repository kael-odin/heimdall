import { join } from 'node:path';
import { WORKSPACE } from '../../../paths.mjs';
import { nextAction } from '../../envelope.mjs';
import { existingWorkspaceJson, runSourceJob, siteForTarget } from './source-job.mjs';

function finishAudit(siteId) {
  return () => {
    const report = existingWorkspaceJson(join(WORKSPACE, siteId, 'seo', 'seo.json'))?.json;
    if (!report) throw new Error('SEO audit finished without seo.json');
    return {
      siteId,
      origin: report.origin,
      score: report.score,
      grade: report.summary?.baselineEligible === true ? (report.score >= 90 ? 'A' : report.score >= 75 ? 'B' : 'C') : null,
      summary: report.summary,
      categories: report.categories,
      field: report.field ?? null,
      reports: {
        json: `workspace/${siteId}/seo/seo.json`,
        html: `workspace/${siteId}/seo/seo.html`,
        csv: `workspace/${siteId}/seo/seo.csv`,
        diff: report.summary?.baselineCompared === true ? `workspace/${siteId}/seo/diff.md` : null,
        uri: `heimdall://site/${encodeURIComponent(siteId)}/seo`,
      },
    };
  };
}

export default {
  id: 'seo_audit',
  title: 'SEO：全站只读审计',
  description: 'Run Heimdall\'s deterministic 66-rule SEO audit against an authorized HTTP(S) site. The source is read with Chromium; '
    + 'the capability writes local JSON/CSV/HTML reports, never submits forms or mutates the source. It is long-running and returns a jobId; '
    + 'wait with heimdall_jobs, then read the evidence through heimdall://site/<siteId>/seo. This is a current-state audit, not a visual clone.',
  effects: ['source-network', 'browser', 'write-local'], scope: 'clone', idempotent: false, cost: 'heavy', longRunning: true,
  input: {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: {
      url: { type: 'string', pattern: '^https?://', maxLength: 2000 },
      maxPages: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 0 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
    },
  },
  cli: { usage: 'seo-audit <url> [--max-pages N] [--no-wait]', positional: ['url'] },
  async handler(args, ctx) {
    const { origin, siteId } = siteForTarget(args.url);
    return runSourceJob({
      capability: 'seo_audit', args, ctx,
      plan: [{ name: 'seo-audit', route: '/api/audit', body: { url: origin, maxPages: args.maxPages } }],
      finish: finishAudit(siteId),
      runningSummary: `已开始 SEO 审计 ${origin}（最多 ${args.maxPages} 页）。`,
      doneSummary: job => job.status !== 'succeeded'
        ? `SEO 审计结束：${job.status}。`
        : job.result?.summary?.initialHtmlUnchecked > 0
          ? `SEO 审计部分完成：${job.result.summary.initialHtmlUnchecked} 页未核对初始 HTML，未进行基线比对。`
          : ['partial', 'unavailable'].includes(job.result?.summary?.sitemapCoverage)
            ? 'SEO 审计部分完成：sitemap 采集不完整，分数仅供参考，未进行基线比对。'
            : job.result?.summary?.failedPages > 0 || job.result?.summary?.baselinePagesUnchecked > 0
              ? 'SEO 审计部分完成：存在未成功采集或未检查的页面，未进行基线比对。'
              : job.result?.summary?.legacyBaseline
                ? 'SEO 审计完成，但旧基线未记录采集完整性，本次未进行基线比对。'
          : `SEO 审计完成：${siteId}。`,
      nextActions: job => job.status === 'succeeded'
        ? [nextAction('heimdall_artifact', { uri: `heimdall://site/${encodeURIComponent(siteId)}/seo` }, '读取结构化 SEO 报告')]
        : [],
    });
  },
};
