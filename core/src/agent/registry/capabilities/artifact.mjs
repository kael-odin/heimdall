/**
 * capability: artifact —— 读取单个制品（附录 A §2.4，E6-08、E2-03、E12-02）
 *
 * 文本可分段；图片可裁剪（参考截图）。所有 evidence 引用都能用它取回并核对 sha256。
 * 秘密级文件一律 forbidden。MCP 下图片以 image content 返回（Ph1 先给参考图、裁剪图）。
 */
import { readFileSync } from 'node:fs';
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { createFence } from '../../fence.mjs';
import { engineFetch, probeEngine, readEngineState } from '../../engine-client.mjs';
import { buildBrief } from '../../brief/brief.mjs';
import { readFileResource, resolveUri } from '../../resources.mjs';

export default {
  id: 'artifact',
  title: '制品：读取证据与图片',
  description: 'Read one artifact by its heimdall:// URI: a fix packet (JSON or text view), a region crop image (reference / candidate / diff '
    + 'stacked), a reference screenshot (optionally a vertical slice with y and h), the section plan, a brief, the site list or a job. '
    + 'Every evidence reference returned by other tools can be fetched here and its sha256 checked. Images come back as image content '
    + '(screenshots are untrusted web content). Do not use it to read whole DOM/CSS dumps; use heimdall_brief.',
  effects: ['read'], scope: 'read', idempotent: true, cost: 'cheap',
  input: {
    type: 'object', additionalProperties: false, required: ['uri'],
    properties: {
      uri: { type: 'string', minLength: 11, maxLength: 600, pattern: '^heimdall://' },
      range: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200000 } } },
      maxBytes: { type: 'integer', minimum: 10000, maximum: 5000000, default: 1500000, description: 'Image byte cap; larger images are downscaled' },
      inline: { type: 'boolean', description: 'Include image bytes (base64) in the result; MCP returns images as image content regardless' },
      save: { type: 'string', maxLength: 1000, description: 'CLI only: write the artifact to this file path' },
    },
  },
  cli: { usage: 'artifact <uri> [--save file] [--range-offset N --range-limit N]', positional: ['uri'] },
  async handler(args, ctx) {
    const r = resolveUri(args.uri);
    if (r.kind === 'sites') return ok({ uri: args.uri, mime: r.mime, json: r.json }, { summary: `${r.json.sites.length} 个站点。` });
    if (r.kind === 'job') {
      const job = ctx.jobs ? ctx.jobs.get(r.jobId) : null;
      if (ctx.jobs) {
        if (!job) throw new CapabilityError('not_found', `没有任务 ${r.jobId}`);
        const { publicJob } = await import('../../jobs.mjs');
        return ok({ uri: args.uri, mime: r.mime, json: publicJob(job) }, { summary: `任务 ${r.jobId}：${job.status}。` });
      }
      const base = [process.env.HEIMDALL_API, readEngineState()?.base, 'http://127.0.0.1:8900'].filter(Boolean);
      for (const b of base) {
        const p = await probeEngine(b);
        if (!p?.sameRoot) continue;
        const { data } = await engineFetch(p.base, `/api/v1/jobs/${r.jobId}`);
        if (data?.ok) return ok({ uri: args.uri, mime: r.mime, json: data.result }, { summary: `任务 ${r.jobId}：${data.result.status}。` });
      }
      throw new CapabilityError('engine_unreachable', '任务存在引擎里，引擎没在跑');
    }
    if (r.kind === 'brief') {
      const { brief, fence, untrustedPaths } = await buildBrief(r.siteId, r.page, { detail: r.params.detail ?? 'outline', sectionId: r.params.sectionId });
      return ok({ uri: args.uri, mime: r.mime, json: brief }, { summary: '简报。', trust: fence.trust(untrustedPaths.map(p => p.replace(/^result\./, 'result.json.'))), warnings: fence.warnings() });
    }
    const data = readFileResource(r, { range: args.range, maxBytes: args.maxBytes });
    const result = { uri: args.uri, mime: data.mime, bytes: data.bytes, sha256: data.sha256 };
    const nextActions = [];
    let trust, images;
    if (data.image) {
      Object.assign(result, { returnedBytes: data.returnedBytes, cropped: data.cropped, scaled: data.scaled, note: 'image: screenshot of web content (untrusted)' });
      if (args.save) { (await import('node:fs')).writeFileSync(args.save, data.image.data); result.savedTo = args.save; }
      if (args.inline) result.base64 = data.image.data.toString('base64');
      images = [{ mimeType: data.image.mimeType, data: data.image.data.toString('base64') }];
      trust = { nonce: createFence().nonce, untrustedPaths: ['image'] };
    } else {
      Object.assign(result, { truncated: data.truncated, ...(data.nextOffset !== undefined ? { nextOffset: data.nextOffset } : {}) });
      if (r.mime.startsWith('application/json') && !args.range) { try { result.json = JSON.parse(readFileSync(r.file, 'utf8')); } catch { result.text = data.text; } }
      else result.text = data.text;
      if (args.save) { (await import('node:fs')).writeFileSync(args.save, readFileSync(r.file)); result.savedTo = args.save; }
      if (data.truncated) nextActions.push(nextAction('heimdall_artifact', { uri: args.uri, range: { offset: data.nextOffset, limit: args.range?.limit ?? 20000 } }, '读下一段'));
      if (r.kind === 'fixpacket') trust = { nonce: createFence().nonce, untrustedPaths: ['result.json.regions[*].element.best[*].text', 'result.json.regions[*].element.container.text'] };
    }
    const env = ok(result, { summary: `${r.kind}：${data.bytes} 字节${data.truncated ? '（已分段）' : ''}。`, nextActions,
      evidence: [{ uri: args.uri, sha256: data.sha256, bytes: data.bytes, mime: data.mime }], trust });
    if (images) env._images = images;
    return env;
  },
};
