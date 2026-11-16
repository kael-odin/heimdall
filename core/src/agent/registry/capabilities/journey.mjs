/** capability: journey -- list/read sanitized authorized journey evidence, or request a human-led capture. */
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { listJourneys, readJourney } from '../../journey-store.mjs';
import { start as startJourney } from '../../commands/journey.mjs';
import { JOURNEY_ACTORS } from '../../journey-metadata.mjs';

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
    return `${url.origin}${url.pathname || '/'}`;
  } catch { return null; }
}

function cliTarget(args) {
  if (args.siteId) return `--site ${args.siteId}`;
  const url = safeUrl(args.url);
  return url ? url : '<url|siteId>';
}

function cliMetadata(args) {
  return [
    args.actor ? ` --actor ${String(args.actor)}` : '',
    Array.isArray(args.ruleIds) && args.ruleIds.length ? ` --rule-id ${args.ruleIds.join(',')}` : '',
    Array.isArray(args.checkpointIds) && args.checkpointIds.length ? ` --checkpoint-id ${args.checkpointIds.join(',')}` : '',
  ].join('');
}

export default {
  id: 'journey',
  title: '旅程：读取证据或请求人工录制',
  description: 'List or read sanitized authorized journey metadata and steps, or prepare a human-led visible-browser capture. Raw HAR, '
    + 'cookies, authorization headers, request bodies and response values never leave the secret journey path. MCP and HTTP callers receive '
    + 'waiting_input because they have no visible human browser channel; run the returned CLI action after explicit authorization.',
  effects: ['read', 'browser', 'source-network', 'write-local'], scope: 'clone', idempotent: false, cost: 'medium',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'read', 'start'], default: 'list' },
      siteId: { type: 'string', minLength: 1, maxLength: 253 },
      journeyId: { type: 'string', pattern: '^journey-[0-9]{10,}-[a-f0-9]{8}$' },
      url: { type: 'string', pattern: '^https?://', maxLength: 2000 },
      name: { type: 'string', maxLength: 120 },
      actor: { type: 'string', enum: JOURNEY_ACTORS },
      ruleIds: { type: 'array', maxItems: 16, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
      checkpointIds: { type: 'array', maxItems: 16, items: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' } },
      includeSteps: { type: 'boolean', default: true },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      maxSteps: { type: 'integer', minimum: 1, maximum: 500, default: 500 },
      allowInsecureHttp: { type: 'boolean', default: false },
    },
  },
  cli: { usage: 'journey <list|read|start> [siteId|journeyId|url]', positional: ['action', 'siteId', 'journeyId'] },
  async handler(args, ctx) {
    if (args.action === 'list') {
      if (!args.siteId) throw new CapabilityError('invalid_args', 'list 需要 siteId');
      const journeys = listJourneys(args.siteId, args.limit);
      return ok({ siteId: args.siteId, journeys }, { summary: `${args.siteId} 有 ${journeys.length} 条脱敏旅程。` });
    }
    if (args.action === 'read') {
      if (!args.siteId || !args.journeyId) throw new CapabilityError('invalid_args', 'read 需要 siteId 和 journeyId');
      const result = readJourney(args.siteId, args.journeyId, { includeSteps: args.includeSteps, limit: args.limit });
      if (!result) throw new CapabilityError('not_found', `没有旅程 ${args.journeyId}`);
      return ok({ siteId: args.siteId, ...result }, { summary: `已读取旅程 ${args.journeyId} 的脱敏证据。` });
    }
    if (!args.url && !args.siteId) throw new CapabilityError('invalid_args', 'start 需要 url 或 siteId');
    if (!ctx.interactive) {
      const command = `heimdall journey start ${cliTarget(args)}${cliMetadata(args)}${args.allowInsecureHttp ? ' --allow-insecure-http' : ''}`;
      return ok({ status: 'waiting_input', siteId: args.siteId ?? null, target: safeUrl(args.url) ?? null,
        requiresHumanApproval: true, command }, {
        summary: '旅程需要人在可见浏览器中操作；当前入口没有人工输入通道。',
        nextActions: [nextAction('cli:shell', { command }, '获得授权后在本机终端启动可见浏览器录制；完成操作后回车结束。')],
      });
    }
    const result = await startJourney(args.url ?? args.siteId, {
      site: args.siteId, name: args.name, actor: args.actor, 'rule-id': args.ruleIds, 'checkpoint-id': args.checkpointIds,
      'allow-insecure-http': args.allowInsecureHttp, 'max-steps': args.maxSteps,
    }, ctx.journeyIO);
    return ok(result, { summary: `旅程 ${result.status === 'succeeded' ? '已保存' : '已取消'}。` });
  },
};
