import { join } from 'node:path';
import { WORKSPACE } from '../../../paths.mjs';
import { nextAction } from '../../envelope.mjs';
import { existingWorkspaceJson, runSourceJob, siteForTarget } from './source-job.mjs';

function finishWatch(siteId) {
  return () => {
    const report = existingWorkspaceJson(join(WORKSPACE, siteId, 'watch', 'watch.json'))?.json;
    if (!report) throw new Error('watch finished without watch.json');
    const diff = report.diff ?? {};
    return {
      siteId,
      origin: report.origin,
      generatedAt: report.generatedAt,
      baselineAt: report.baselineAt,
      summary: report.summary,
      changes: {
        added: diff.added?.length ?? 0,
        removed: diff.removed?.length ?? 0,
        changed: diff.changed?.length ?? 0,
        unchanged: diff.unchanged ?? 0,
        bySeverity: diff.bySeverity ?? {},
        hasChanges: !!diff.hasChanges,
      },
      reports: {
        json: `workspace/${siteId}/watch/watch.json`,
        html: `workspace/${siteId}/watch/watch.html`,
        uri: `heimdall://site/${encodeURIComponent(siteId)}/watch`,
      },
    };
  };
}

export default {
  id: 'site_watch',
  title: '监控：站点变更快照',
  description: 'Take a snapshot of an authorized site and compare it with the stored watch baseline. Page scripts may send state-changing or '
    + 'third-party requests, and existing sessions may be used. First run creates '
    + 'the baseline; accept=true explicitly updates it after review. The tool reports added/removed/changed pages, severity counts and local '
    + 'JSON/HTML evidence through a durable job. It is not a pixel-perfect clone and dynamic fields are sampled for stability.',
  effects: ['source-network', 'browser', 'write-local'], scope: 'clone', idempotent: false, cost: 'heavy', longRunning: true,
  input: {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: {
      url: { type: 'string', pattern: '^https?://', maxLength: 2000 },
      maxPages: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      accept: { type: 'boolean', default: false, description: 'Explicitly replace the stored baseline with this reviewed snapshot' },
      waitMs: { type: 'integer', minimum: 0, maximum: 60000, default: 0 },
      idempotencyKey: { type: 'string', minLength: 8, maxLength: 120 },
    },
  },
  cli: { usage: 'site-watch <url> [--max-pages N] [--accept] [--no-wait]', positional: ['url'] },
  async handler(args, ctx) {
    const { origin, siteId } = siteForTarget(args.url);
    return runSourceJob({
      capability: 'site_watch', args, ctx,
      plan: [{ name: 'watch', route: '/api/watch', body: { url: origin, maxPages: args.maxPages, accept: args.accept } }],
      finish: finishWatch(siteId),
      runningSummary: `已开始站点变更监控 ${origin}（最多 ${args.maxPages} 页）。`,
      doneSummary: job => job.status === 'succeeded'
        ? `站点监控完成：${siteId}，${job.result?.changes?.hasChanges ? '发现变化' : '没有阻断性变化'}。`
        : `站点监控结束：${job.status}。`,
      nextActions: job => job.status === 'succeeded'
        ? [nextAction('heimdall_artifact', { uri: `heimdall://site/${encodeURIComponent(siteId)}/watch` }, '读取变更证据')]
        : [],
    });
  },
};
