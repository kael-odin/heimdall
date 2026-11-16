/**
 * heimdall journey —— 人在可见浏览器里录制一条获授权旅程。
 *
 * 原始 HAR 只保存在秘密路径；给 AI 的输出是脱敏步骤和观察型契约。
 */
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WORKSPACE } from '../../paths.mjs';
import { writeAtomicFileSync } from '../../acceptance/atomic-file.mjs';
import { sanitizeHar } from '../../live/har.mjs';
import { buildObservedApiContract } from '../../live/contract.mjs';
import { assertSiteOrigin, readSiteOrigin, siteIdForOrigin } from '../../site-origin.mjs';
import { parseArgs } from '../parse-args.mjs';
import { normalizeJourneyMetadata } from '../journey-metadata.mjs';

const MAX_STEPS = 500;
const SAFE_STEP_TEXT = /^[^\u0000-\u001f\u007f]{0,160}$/;

function cleanText(value, limit = 160) {
  const text = String(value ?? '').trim().slice(0, limit);
  return SAFE_STEP_TEXT.test(text) ? text : '';
}

function publicPath(value, origin) {
  try {
    const url = new URL(value);
    return url.origin === origin ? url.pathname || '/' : null;
  } catch { return null; }
}

export function normalizeJourneyEvent(event, origin) {
  if (!event || !['click', 'input', 'change', 'navigate'].includes(event.type)) return null;
  const path = publicPath(event.url, origin);
  if (event.type !== 'navigate' && !path) return null;
  const target = event.target && typeof event.target === 'object' ? {
    tag: cleanText(event.target.tag, 32).toLowerCase(),
    role: cleanText(event.target.role, 64),
    type: cleanText(event.target.type, 32).toLowerCase(),
    name: cleanText(event.target.name, 80),
  } : undefined;
  return {
    type: event.type,
    ...(path ? { path } : { external: true }),
    ...(target && Object.values(target).some(Boolean) ? { target } : {}),
    ...(event.type === 'input' || event.type === 'change' ? { valuePresent: true } : {}),
  };
}

export function buildJourneyArtifacts({ har, siteId, origin, journeyId, name, startedAt, finishedAt, steps = [], actor, ruleIds, checkpointIds }) {
  const sanitized = sanitizeHar(har, { includeApiBodies: true, contractOnly: true });
  const contract = buildObservedApiContract(sanitized.entries, {
    siteId, origin, journeys: [journeyId], pages: 0, generatedAt: finishedAt,
  });
  const safeSteps = steps.map(step => normalizeJourneyEvent(step, origin)).filter(Boolean).slice(0, MAX_STEPS);
  const metadata = normalizeJourneyMetadata({ actor, ruleIds, checkpointIds });
  const journey = {
    schema: 'heimdall.journey/1', id: journeyId, siteId, origin,
    ...(name ? { name: cleanText(name, 120) } : {}), startedAt, finishedAt,
    status: 'recorded', ...metadata,
    steps: safeSteps.length, network: {
      sanitizedEntries: sanitized.entries.length,
      apiEntries: contract.sources.apiEntries,
      excluded: contract.sources.excluded,
    },
    contract: {
      status: contract.summary.status, tier: contract.tier, endpoints: contract.summary.endpoints,
      ...(contract.summary.status === 'observed' ? { path: 'api-contract.json' } : {}),
    },
  };
  return { journey, contract, steps: safeSteps };
}

function targetOf(value, siteFlag) {
  const raw = String(value ?? siteFlag ?? '').trim();
  if (!raw) throw new Error('用法：heimdall journey start <url|siteId> [--site siteId]');
  if (/^https?:\/\//i.test(raw)) {
    const url = new URL(raw);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('旅程地址不能包含账号密码，且只能使用 http(s)');
    return { url, siteId: siteFlag ? String(siteFlag) : siteIdForOrigin(WORKSPACE, url.href) };
  }
  const siteId = siteFlag ? String(siteFlag) : raw;
  if (!/^(?!\.\.?$)[a-z0-9.-]+$/i.test(siteId)) throw new Error('siteId 只能包含字母、数字、点和短横线');
  const siteDir = join(WORKSPACE, siteId);
  const origin = readSiteOrigin(siteDir);
  if (!origin) throw new Error(`站点 ${siteId} 没有唯一来源；请使用完整 URL 启动旅程`);
  return { url: new URL(origin + '/'), siteId };
}

function waitForFinish(input, output) {
  return new Promise(resolve => {
    const rl = createInterface({ input, output });
    const done = line => { rl.close(); resolve(String(line ?? '').trim().toLowerCase()); };
    rl.once('line', done);
    rl.once('SIGINT', () => done('cancel'));
  });
}

function initScript() {
  return () => {
    const send = value => { try { window.__heimdallJourneyEvent(value); } catch {} };
    const target = element => ({
      tag: element?.tagName ?? '', role: element?.getAttribute?.('role') ?? '',
      type: element?.getAttribute?.('type') ?? '', name: element?.getAttribute?.('aria-label') ?? element?.getAttribute?.('name') ?? '',
    });
    document.addEventListener('click', event => {
      const element = event.target?.closest?.('a,button,input,select,textarea,[role="button"]');
      if (element) send({ type: 'click', url: location.href, target: target(element) });
    }, true);
    for (const type of ['input', 'change']) document.addEventListener(type, event => {
      if (event.target) send({ type, url: location.href, target: target(event.target) });
    }, true);
  };
}

function attachPage(page, record) {
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) record({ type: 'navigate', url: page.url() });
  });
}

export async function start(value, flags = {}, io = {}) {
  const target = targetOf(value, flags.site);
  if (target.url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.url.hostname)
    && flags['allow-insecure-http'] !== true) throw new Error('远程旅程入口使用未加密 HTTP；确认风险后加 --allow-insecure-http');
  const siteDir = join(WORKSPACE, target.siteId);
  assertSiteOrigin(siteDir, target.url.origin, { claim: true });
  const journeyId = `journey-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const journeyDir = join(siteDir, 'agent', 'journeys', journeyId);
  const stepsDir = join(journeyDir, 'steps');
  const rawHar = join(journeyDir, 'network.journey.har');
  const maxSteps = Math.min(MAX_STEPS, Math.max(1, Number(flags['max-steps'] ?? MAX_STEPS)));
  if (!Number.isInteger(maxSteps)) throw new Error('--max-steps 必须是整数');
  const metadata = normalizeJourneyMetadata({ actor: flags.actor, ruleIds: flags['rule-id'], checkpointIds: flags['checkpoint-id'] }, { strict: true });
  if (existsSync(journeyDir)) throw new Error('旅程目录已存在，请重新启动以避免覆盖');
  mkdirSync(stepsDir, { recursive: true });
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const chromium = io.chromium ?? (await import('playwright')).chromium;
  const startedAt = new Date().toISOString();
  const events = [];
  const record = event => { if (events.length < maxSteps) events.push({ ...event, at: new Date().toISOString() }); };
  const browser = await chromium.launch({ headless: false });
  let context;
  try {
    context = await browser.newContext({ viewport: null, recordHar: { path: rawHar, content: 'embed' } });
    await context.exposeBinding('__heimdallJourneyEvent', async ({ page }, event) => record({ ...event, url: page?.url?.() ?? event?.url }));
    await context.addInitScript(initScript());
    const attach = page => attachPage(page, record);
    context.on('page', attach);
    const page = await context.newPage();
    attach(page);
    await page.goto(target.url.href, { waitUntil: 'domcontentloaded' });
    record({ type: 'navigate', url: page.url() });
    stdout.write(`已打开 ${target.url.origin}。请只在获授权范围内操作，完成后回到终端按回车；输入 cancel 取消。\n`);
    const answer = await waitForFinish(io.stdin ?? process.stdin, stdout);
    if (answer === 'cancel' || answer === 'q') {
      rmSync(journeyDir, { recursive: true, force: true });
      stderr.write('已取消，未生成旅程契约。\n');
      return { status: 'cancelled', siteId: target.siteId, journeyId, exitCode: 2 };
    }
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  let har;
  try { har = JSON.parse(readFileSync(rawHar, 'utf8')); }
  catch { throw new Error('旅程结束但无法读取原始 HAR；未生成契约'); }
  const finishedAt = new Date().toISOString();
  const artifacts = buildJourneyArtifacts({ har, siteId: target.siteId, origin: target.url.origin, journeyId,
    name: flags.name, startedAt, finishedAt, steps: events, ...metadata });
  writeAtomicFileSync(join(journeyDir, 'journey.json'), JSON.stringify(artifacts.journey, null, 2) + '\n');
  artifacts.steps.forEach((step, index) => writeAtomicFileSync(join(stepsDir, `${String(index + 1).padStart(4, '0')}.json`), JSON.stringify(step, null, 2) + '\n'));
  let contractPath = null;
  if (artifacts.contract.summary.status === 'observed') {
    contractPath = join(siteDir, 'api-contract.json');
    writeAtomicFileSync(contractPath, JSON.stringify(artifacts.contract, null, 2) + '\n');
  }
  stdout.write(`旅程已保存：${journeyDir}\n`);
  stdout.write(`观察型契约：${artifacts.contract.summary.status}${contractPath ? `，${contractPath}` : ''}\n`);
  return {
    status: 'succeeded', siteId: target.siteId, journeyId,
    path: `workspace/${target.siteId}/agent/journeys/${journeyId}`,
    contractStatus: artifacts.contract.summary.status,
    ...(contractPath ? { contractPath: `workspace/${target.siteId}/api-contract.json` } : {}),
    exitCode: 0,
  };
}

export async function run(argv) {
  const [sub, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  if (sub !== 'start') {
    process.stdout.write('用法：heimdall journey start <url|siteId> [--site S] [--name NAME] [--actor anonymous|owner|non_owner|invalid_credentials] [--rule-id ID[,ID]] [--checkpoint-id ID[,ID]] [--allow-insecure-http]\n');
    return sub ? 2 : 0;
  }
  try { return (await start(positional[0] ?? flags.url ?? flags.site, flags)).exitCode ?? 0; }
  catch (error) { process.stderr.write(`${error.message}\n`); return 3; }
}
