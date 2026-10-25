/**
 * capability: compare —— 候选对照冻结参考，返回判定与修复包（附录 A §2.5，E6-09 ~ E6-13）
 *
 * fast 模式（Ph1）同步执行，目标十几秒；**不能宣布 passed**，最好是 pass-candidate。
 * formal 模式（验收 Mirror + 评估器）在 Ph2 交付。
 */
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { fastCompare } from '../../evidence/compare.mjs';

const pct = (v) => `${(v * 100).toFixed(1)}%`;

export default {
  id: 'compare',
  title: '对比：候选 vs 参考，给修复包',
  description: 'Measure a candidate page (a URL, or a rebuild workspace directory whose heimdall.config.json names the dev server) against the '
    + 'frozen reference at 375/768/1440 and return a verdict plus a Fix Packet: regions in priority order with cause (missing-content, '
    + 'image-missing, extra-content, shift, spacing, size, font, color, unknown), size, the brief element they overlap (ref like '
    + '"sec-…/e12"), a hint and a crop image (reference / candidate / diff). Call after every edit. mode="fast" can at best return '
    + '"pass-candidate", never "passed". Pass sectionIds to compare one section; mark the section root in your page with '
    + 'data-heimdall-section="<sectionId>" so it is measured in isolation. The dev server must already be running.',
  effects: ['browser', 'write-local'], scope: 'build', idempotent: true, cost: 'medium',
  input: {
    type: 'object', additionalProperties: false, required: ['candidate'],
    properties: {
      siteId: { type: 'string', minLength: 1, maxLength: 253 },
      page: { type: 'string', minLength: 1, maxLength: 200 },
      candidate: {
        type: 'object', additionalProperties: false,
        properties: { url: { type: 'string', pattern: '^https?://', maxLength: 2000 }, dir: { type: 'string', minLength: 1, maxLength: 1000 } },
        description: 'Exactly one of {url} or {dir}',
      },
      route: { type: 'string', maxLength: 500, description: 'Candidate route (dir mode); defaults to the page route in heimdall.config.json' },
      mode: { type: 'string', enum: ['fast', 'formal'], default: 'fast' },
      viewports: { type: 'array', items: { type: 'integer', enum: [375, 768, 1440] }, minItems: 1, maxItems: 3 },
      sectionIds: { type: 'array', items: { type: 'string', pattern: '^sec-[a-z]+-[0-9a-f]{6}$' }, minItems: 1, maxItems: 20 },
      gate: { type: 'object', additionalProperties: false, properties: { level: { type: 'string', enum: ['bronze', 'silver', 'gold'] } } },
      requireGate: { type: 'boolean', default: false, description: 'Treat anything below pass-candidate as a failed gate (CLI exit code 1)' },
      inlineCrops: { type: 'integer', minimum: 0, maximum: 6, default: 2, description: 'Crop images returned inline (MCP image content)' },
      tokenBudget: { type: 'integer', minimum: 2000, maximum: 60000, default: 12000 },
    },
  },
  cli: { usage: 'compare --project . [--section-id ID] [--viewports 375,768,1440] | compare <siteId> <page> --url <candidate>', positional: ['siteId', 'page'] },
  async handler(args, ctx) {
    const c = args.candidate ?? {};
    if (!!c.url === !!c.dir) throw new CapabilityError('invalid_args', 'candidate 恰好给一个：{url} 或 {dir}');
    if (args.mode === 'formal') {
      throw new CapabilityError('invalid_args', '正式门禁（mode="formal"）在 Ph2 交付', { hint: '现在用 mode="fast"；pass-candidate 之后由正式裁判确认（Ph2）' });
    }
    const r = await fastCompare(args, { onProgress: ctx.onProgress });
    const p = r.packet;
    // 按 tokenBudget 收缩内联的区域：先保留每个视口最要紧的几条
    let regions = p.regions;
    const budgetBytes = args.tokenBudget * 3.5;
    while (regions.length > 3 && Buffer.byteLength(JSON.stringify(regions)) > budgetBytes * 0.6) regions = regions.filter((_, i) => i % 2 === 0 || i < 3).slice(0, Math.max(3, Math.floor(regions.length * 0.75)));
    const truncated = regions.length < p.regions.length;
    const perViewport = Object.fromEntries(Object.entries(p.perViewport).map(([vp, v]) => [vp, {
      pixelSimilarity: v.pixelSimilarity, maxBlobPct: v.maxBlobPct, maxBlobPagePct: v.maxBlobPagePct, maxRegionPct: v.maxRegionPct,
      highRegions: v.highRegions, heightDelta: v.heightDelta, size: v.size, regionsTotal: v.regionsTotal, notes: v.notes,
    }]));
    const result = {
      runId: p.runId, mode: 'fast', siteId: p.siteId, page: p.page, verdict: p.verdict, trend: p.trend, perViewport,
      regions, order: p.order.filter(id => regions.some(r2 => r2.id === id)), scope: p.scope,
      fixpacketUri: `heimdall://run/${p.runId}/fixpacket`, packetUri: `heimdall://run/${p.runId}/packet`,
      packetText: r.text, ...(r.projectRunDir ? { runDir: r.projectRunDir.replace(/\\/g, '/') } : {}),
      elapsedMs: p.elapsedMs, truncated,
      ...(args.requireGate && p.verdict.status !== 'pass-candidate' ? { gateFailed: true } : {}),
    };
    const scores = p.viewports.map(w => `${w}：${pct(p.perViewport[w].pixelSimilarity)}`).join('，') + (p.skipped?.length ? `（${p.skipped.map(s => s.viewport).join('、')} 下参考里看不到这一段，未计入）` : '');
    const top = p.order.slice(0, 3).map(id => { const g = p.regions.find(x => x.id === id); return g ? `${g.id}（${g.cause}）` : id; }).join('、');
    const summary = `${scores}。判定 ${p.verdict.status}${p.verdict.reached ? `（已达 ${p.verdict.reached}）` : ''}；趋势 ${p.trend.state}。`
      + (top ? `\n先修：${top}。` : '') + (p.verdict.status === 'pass-candidate' ? '\n快速裁判不能宣布通过，正式门禁在 Ph2。' : '');
    const nextActions = [];
    const firstCrop = p.regions.find(g => g.crops?.uri);
    if (p.verdict.status !== 'pass-candidate') {
      if (firstCrop) nextActions.push(nextAction('heimdall_artifact', { uri: firstCrop.crops.uri }, `看 ${firstCrop.id} 的裁剪对比图`));
      nextActions.push(nextAction('heimdall_compare', { ...args, inlineCrops: undefined, tokenBudget: undefined }, '改完再对比一次'));
    } else {
      const next = p.scope?.sectionIds ? '这一段可以收尾，开始下一段' : '整页已到 pass-candidate，等待正式门禁（Ph2）';
      nextActions.push(nextAction('heimdall_brief', { siteId: p.siteId, page: p.page, detail: 'sections' }, next));
    }
    if (p.trend.state === 'worse') nextActions.unshift(nextAction('cli:git', { args: 'diff HEAD' }, '这次改动让分数变差了：对照修复包检查改动，必要时回到上一次提交'));
    const env = ok(result, {
      summary, nextActions, warnings: [...r.warnings, ...r.fence.warnings()],
      evidence: [r.fixpacketEvidence, ...p.evidence],
      trust: r.fence.trust(['result.regions[*].element.best[*].text', 'result.regions[*].element.container.text']),
      meta: { truncated },
    });
    // 内联裁剪图（MCP image content）：按 order 取前几张
    const inline = [];
    for (const id of p.order) {
      if (inline.length >= args.inlineCrops) break;
      const g = p.regions.find(x => x.id === id);
      if (g?.crops?.composite) {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        inline.push({ mimeType: 'image/png', data: readFileSync(join(r.outDir, g.crops.composite)).toString('base64'), caption: `${g.id} · 参考 / 候选 / 差异` });
      }
    }
    if (inline.length) env._images = inline;
    return env;
  },
};
