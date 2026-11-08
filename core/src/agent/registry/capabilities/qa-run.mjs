/**
 * capability: qa_run —— 对一个站点跑一次只读测试，返回该提单的问题
 */
import { ok, nextAction, CapabilityError } from '../../envelope.mjs';
import { runQa, relPath } from '../../../qa/run.mjs';
import { fileable } from '../../../qa/report.mjs';
import { WORKSPACE_ARG, wsOrError } from './qa-status.mjs';

const STEP = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: ['click', 'fill', 'press', 'hover', 'wait', 'goto', 'select', 'check'] },
    selector: { type: 'string', maxLength: 500 }, value: { type: 'string', maxLength: 2000 },
    path: { type: 'string', maxLength: 500 }, ms: { type: 'integer', minimum: 0, maximum: 10000 },
  },
};
const EXPECT = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['visible', 'hidden', 'text', 'url', 'count', 'attribute', 'clipboard', 'title'] },
    selector: { type: 'string', maxLength: 500 }, attribute: { type: 'string', maxLength: 100 },
    equals: { type: ['string', 'number', 'boolean'] }, contains: { type: 'string', maxLength: 2000 }, matches: { type: 'string', maxLength: 500 },
    min: { type: 'number' }, max: { type: 'number' },
  },
};
export const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['title', 'expect'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$' }, title: { type: 'string', minLength: 2, maxLength: 160 },
    path: { type: 'string', pattern: '^/', maxLength: 500 }, steps: { type: 'array', items: STEP, maxItems: 20 },
    expect: { type: 'array', items: EXPECT, minItems: 1, maxItems: 20 },
    tier: { type: 'string', enum: ['wall', 'degrade', 'tolerable'] }, basis: { type: 'string', enum: ['failed', 'wrong', 'promise', 'friction', 'cosmetic'] },
    loss: { type: 'string', maxLength: 300 }, prd: { type: 'string', maxLength: 300, description: 'Where this expectation comes from, e.g. "PRD 优惠券 §3.2: 无效券码提示「券码无效」"' },
    viewport: { type: 'object', additionalProperties: false, properties: { width: { type: 'integer', minimum: 320, maximum: 1920 }, height: { type: 'integer', minimum: 320, maximum: 2000 } } },
  },
};

export default {
  id: 'qa_run',
  title: '测试：对一个站点跑只读检查',
  description: 'Run a read-only test of one site from the test workspace, using its login profile. Every page is opened at each viewport and '
    + 'checked for: page not opening, login expired, console errors and page exceptions, 4xx/5xx responses and failed requests, broken same-origin '
    + 'links, broken images, horizontal overflow, and blocked write requests. It also runs reference-free detectors (alt text, control names, form '
    + 'labels, duplicate ids, heading order, clipped text, stretched images, tap targets, placeholder text, unreplaced templates, mojibake, invalid '
    + 'dates, mixed content, unsafe _blank links, leaked keys, LCP/CLS, oversized images, blank pages) and compares screenshots with the registered '
    + 'baseline. Optional checks add declarative steps (click/fill/press/hover/select/check/wait/goto, real input events) and expectations '
    + '(visible/hidden/text/url/count/attribute/clipboard/title); cite the PRD in "prd". explore=true clicks up to exploreMax controls per page to '
    + 'find dead buttons, click-triggered errors and 404s; off by default because it changes page state. Findings are fingerprinted and matched '
    + 'against past verdicts; returns what is worth filing plus paths to report.md and bugs.md.',
  effects: ['browser', 'source-network', 'write-local'], scope: 'clone', idempotent: false, cost: 'heavy',
  input: {
    type: 'object', additionalProperties: false,
    properties: {
      workspace: WORKSPACE_ARG,
      site: { type: 'string', maxLength: 64, description: 'Site name from qa.json; defaults to the first site' },
      pages: { type: 'array', items: { type: 'string', pattern: '^/', maxLength: 500 }, maxItems: 40, description: 'Paths to test; defaults to the site pages in qa.json' },
      viewports: { type: 'array', items: { type: 'integer', minimum: 320, maximum: 1920 }, maxItems: 3, description: 'Widths, e.g. [1440, 390]' },
      checks: { type: 'array', items: CHECK_SCHEMA, maxItems: 40 },
      checksFile: { type: 'string', maxLength: 500, description: 'Workspace-relative JSON file with { checks: [...] }' },
      login: { type: 'string', maxLength: 64, description: 'Override the site login profile' },
      explore: { type: 'boolean', default: false, description: 'Click up to exploreMax controls per page to find dead buttons, click-triggered errors and 404s. Off by default because it changes page state.' },
      exploreMax: { type: 'integer', minimum: 0, maximum: 20, description: 'Controls to click per page when explore=true (default 6)' },
      exploreBudgetMs: { type: 'integer', minimum: 1_000, maximum: 300_000, description: 'Total exploration budget in ms (default 60000)' },
      baseline: { type: 'boolean', default: true, description: 'Compare screenshots with the registered baseline when one exists for this site' },
      detect: { type: 'boolean', default: true, description: 'Run the reference-free detectors (alt text, labels, clipped text, mixed content, LCP/CLS, …)' },
      linkCheck: { type: 'boolean', default: true },
      collectTexts: { type: 'boolean', default: false, description: 'Save visible texts to texts.json (used for design-text comparison)' },
      label: { type: 'string', maxLength: 120 },
    },
  },
  cli: { usage: 'qa run [site] [--pages /a,/b] [--viewports 1440,390] [--checks file.json] [--no-links]', positional: ['site'] },
  async handler(args, ctx) {
    const ws = wsOrError(args, ctx);
    let r;
    try { r = await runQa(ws, args, { onProgress: ctx.onProgress }); }
    catch (e) {
      if (e.code === 'login_missing') throw new CapabilityError('invalid_args', e.message, { hint: `人工登录一次：heimdall qa login ${args.login ?? ws.sites[args.site ?? Object.keys(ws.sites)[0]]?.login}` });
      if (e.code === 'invalid_args' || e.code === 'not_found') throw new CapabilityError(e.code, e.message);
      if (/Executable doesn't exist|browserType\.launch/i.test(e.message)) throw new CapabilityError('chromium_missing', 'Chromium 没装');
      throw e;
    }
    const s = r.run.summary;
    const file = r.findings.filter(fileable).map(f => ({ id: f.id, fingerprint: f.fingerprint, tier: f.tier, basis: f.basis, kind: f.kind, path: f.path,
      title: f.title, observed: f.observed, ...(f.loss ? { loss: f.loss } : {}), ...(f.evidence?.screenshot ? { screenshot: f.evidence.screenshot } : {}), triage: f.triage.status }));
    const env = r.findings.filter(f => f.kind === 'login-expired').map(f => f.title);
    const detection = r.run.coverage.detection;
    const navigation = { pages: r.run.coverage.pages.length, failedPages: r.run.coverage.pages.filter(p => p.navError)
      .map(p => ({ path: p.path, viewport: p.viewport, error: p.navError })) };
    const detectionByKind = r.findings.filter(f => f.detector).reduce((acc, f) => { acc[f.kind] = (acc[f.kind] ?? 0) + 1; return acc; }, {});
    const result = { runId: r.run.runId, site: r.run.site, summary: s, fileable: file,
      environment: env, checks: r.run.coverage.checks, navigation,
      detection: { ...detection, byKind: detectionByKind }, explore: r.run.coverage.explore, baseline: r.run.coverage.baseline,
      report: relPath(ws, r.files.report), bugs: relPath(ws, r.files.bugs), runDir: relPath(ws, r.dir) };
    const summary = `${r.run.site}：建议提单 ${s.fileable} 条，按以往裁决过滤 ${s.suppressed} 条，可容忍 ${s.tolerable} 条`
      + (detection?.enabled ? `，无参照物检测 ${detection.findings} 条` : '')
      + (detection?.failedPages?.length ? `，${detection.failedPages.length} 个页面视口的检测器执行失败` : '')
      + (navigation.failedPages.length ? `，${navigation.failedPages.length} 个页面视口未能打开` : '')
      + (r.run.coverage.explore?.enabled ? `，交互探索点开 ${r.run.coverage.explore.pages.reduce((n, p) => n + p.clicked, 0)} 个控件` : '')
      + (s.checkNeedsFix ? `，${s.checkNeedsFix} 个检查点没对上` : '') + (env.length ? `；登录态有问题：${env[0]}` : '') + `。报告：${result.report}`;
    const nextActions = [];
    if (env.length) nextActions.push(nextAction('cli:shell', { command: `heimdall qa login ${r.run.login?.name ?? ''}`.trim() }, '先重新登录，再重跑'));
    if (navigation.failedPages.length) nextActions.push(nextAction('heimdall_qa_run', { workspace: ws.root, site: r.run.site }, '排查无法打开的页面后重跑'));
    if (detection?.failedPages?.length) nextActions.push(nextAction('heimdall_qa_run', { workspace: ws.root, site: r.run.site }, '检测器未完成，排查后重跑'));
    if (file.length) nextActions.push(nextAction('heimdall_qa_findings', { action: 'show', runId: r.run.runId, id: file[0].id }, '逐条复核建议提单的问题'));
    nextActions.push(nextAction('heimdall_qa_findings', { action: 'submit', runId: r.run.runId }, '把你自己测出的问题提交进这次运行（会校验证据并查重）'));
    return ok(result, { summary, nextActions, evidence: [{ kind: 'file', path: result.report }, { kind: 'file', path: result.bugs }] });
  },
};
