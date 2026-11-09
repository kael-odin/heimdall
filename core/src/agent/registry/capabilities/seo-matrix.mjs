import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../../../paths.mjs';
import { CapabilityError, nextAction } from '../../envelope.mjs';
import { readJson, runSourceJob, httpOrigin, existingWorkspaceJson } from './source-job.mjs';

function normalizedSites(values) {
  const sites = [...new Set(values.map(httpOrigin))];
  if (sites.length !== values.length) throw new CapabilityError('invalid_args', 'sites 必须是互不重复的站点 origin');
  return sites;
}

function latestMatrix(sites) {
  const root = join(WORKSPACE, '_matrix');
  let names = [];
  try { names = readdirSync(root).filter(name => {
    try { return statSync(join(root, name)).isDirectory(); } catch { return false; }
  }); } catch { return null; }
  const wanted = new Set(sites);
  const found = [];
  for (const slug of names) {
    const file = join(root, slug, 'matrix.json');
    const matrix = readJson(file);
    if (!matrix || !Array.isArray(matrix.sites) || matrix.sites.length !== sites.length) continue;
    if (!matrix.sites.every(site => wanted.has(site.host))) continue;
    let mtimeMs = 0;
    try { mtimeMs = statSync(file).mtimeMs; } catch {}
    found.push({ slug, matrix, file, mtimeMs });
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

function finishMatrix(sites) {
  return () => {
    const latest = latestMatrix(sites);
    if (!latest) throw new Error('SEO matrix finished without a matching matrix.json');
    const report = existingWorkspaceJson(latest.file);
    const scoreComparison = latest.matrix.scoreComparison ?? { comparable: false, methodVersion: null, reason: 'unknown-method' };
    const jsonldComparison = latest.matrix.jsonldComparison ?? { comparable: false, measurementVersion: null, reason: 'unknown-method' };
    return {
      sites,
      slug: latest.slug,
      generatedAt: latest.matrix.generatedAt,
      scoreComparison,
      jsonldComparison,
      aggregates: latest.matrix.sites.map(site => ({ host: site.host, ...site.aggregate,
        ...(scoreComparison.comparable === true ? {} : { score: null, issuesPerPage: null }),
        ...(jsonldComparison.comparable === true ? {} : { jsonldRate: null, issuesPerPage: null }) })),
      reports: {
        json: report.relative,
        html: `workspace/_matrix/${latest.slug}/matrix.html`,
        csv: `workspace/_matrix/${latest.slug}/matrix.csv`,
        uri: `heimdall://matrix/${encodeURIComponent(latest.slug)}`,
      },
    };
  };
}

export default {
  id: 'seo_matrix',
  title: 'SEO：竞品对标矩阵',
  description: 'Compare the deterministic SEO audit of 2-6 authorized HTTP(S) sites. Missing or stale reports are refreshed through the same '
    + 'SEO pipeline; page scripts may send state-changing or third-party requests, and existing sessions may be used. '
    + 'The tool writes local JSON/CSV/HTML matrices and returns a durable jobId. Aggregate scores are not marketing '
    + 'claims and sample sizes can differ, so compare page-type coverage and per-site summaries before drawing conclusions.',
  effects: ['source-network', 'browser', 'write-local'], scope: 'clone', idempotent: false, cost: 'heavy', longRunning: true,
  input: {
    type: 'object', additionalProperties: false, required: ['sites'],
    properties: {
      sites: { type: 'array', minItems: 2, maxItems: 6, uniqueItems: true, items: { type: 'string', pattern: '^https?://', maxLength: 2000 } },
      maxPages: { type: 'integer', minimum: 1, maximum: 100, default: 15 },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 0 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
    },
  },
  cli: { usage: 'seo-matrix <url> <url> [url...] [--max-pages N] [--no-wait]', positional: ['sites'] },
  async handler(args, ctx) {
    const sites = normalizedSites(args.sites);
    return runSourceJob({
      capability: 'seo_matrix', args: { ...args, sites }, ctx,
      plan: [{ name: 'seo-matrix', route: '/api/matrix', body: { sites, maxPages: args.maxPages } }],
      finish: finishMatrix(sites),
      runningSummary: `已开始 ${sites.length} 个站点的 SEO 对标矩阵。`,
      doneSummary: job => job.status !== 'succeeded' ? `SEO 对标矩阵结束：${job.status}。`
        : job.result?.scoreComparison?.reason === 'insufficient-eligible-audits' ? 'SEO 对标矩阵已生成，但完整审计不足两份，分数不可比。'
        : job.result?.scoreComparison?.comparable === false ? 'SEO 对标矩阵已生成，但评分口径不兼容或未记录，分数不可比。'
        : job.result?.jsonldComparison?.comparable === false ? 'SEO 对标矩阵已生成，但 JSON-LD 测量口径不兼容或样本不足，覆盖率及问题数不可比。'
          : 'SEO 对标矩阵完成。',
      nextActions: job => {
        const slug = job.result?.slug;
        return slug ? [nextAction('heimdall_artifact', { uri: `heimdall://matrix/${encodeURIComponent(slug)}` }, '读取矩阵 JSON')] : [];
      },
    });
  },
};
