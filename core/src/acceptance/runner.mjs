import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { comparePngBuffers } from '../verify/compare.mjs';
import { resolveAcceptanceUrl } from './schema.mjs';
import { buildAcceptanceIdentity } from './identity.mjs';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_ROUTES = 8;
const MAX_VIEWPORTS = 3;
const MAX_POINTS = 24;
const MAX_OBSERVATIONS = 100;
const CAPTURE_BUDGET = Object.freeze({ maxPixels: 12_000_000, maxHeight: 12_000 });
const BROWSER_PROFILE = Object.freeze({ locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' });
const PLAYWRIGHT_VERSION = (() => {
  try { return createRequire(import.meta.url)('playwright/package.json').version; }
  catch { return null; }
})();
const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
const messageOf = error => String(error?.message ?? error).slice(0, 800);
const safeName = value => String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 70);
const identical = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const jsonData = value => JSON.parse(JSON.stringify(value));
const clip = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
const safeUrl = value => {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]');
    return url.href;
  } catch { return '[invalid-url]'; }
};

export const resolveAcceptanceRoute = resolveAcceptanceUrl;

function keyForObservation(item, entryUrl) {
  let path = item.url;
  let message = item.message ?? '';
  try {
    const entry = new URL(entryUrl);
    const prefix = entry.pathname.replace(/\/$/, '');
    if (item.url) {
      const observed = new URL(item.url);
      path = observed.pathname;
      if (observed.origin === entry.origin && prefix && (path === prefix || path.startsWith(prefix + '/'))) path = path.slice(prefix.length) || '/';
    }
    message = message.replaceAll(entry.origin + (prefix || ''), '[entry]');
  } catch {}
  return `${item.kind}|${item.status ?? ''}|${item.method ?? ''}|${path ?? ''}|${message}`;
}

function semanticSnapshot({ entryUrl, maskSelectors }) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  };
  const masked = element => maskSelectors.some(selector => element.closest(selector));
  const pathOf = element => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current?.parentElement && parts.length < 6) {
      const siblings = [...current.parentElement.children].filter(child => child.tagName === current.tagName);
      parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return parts.join(' > ');
  };
  const hrefOf = element => {
    if (!element.hasAttribute('href')) return null;
    try {
      const href = new URL(element.getAttribute('href'), location.href);
      const entry = new URL(entryUrl);
      let prefix = entry.pathname.replace(/\/$/, '');
      if (href.origin !== entry.origin) return `${href.origin}${href.pathname}`;
      return prefix && (href.pathname === prefix || href.pathname.startsWith(prefix + '/'))
        ? href.pathname.slice(prefix.length) || '/' : href.pathname;
    } catch { return element.getAttribute('href'); }
  };
  const headings = [...document.querySelectorAll('h1, [role="heading"][aria-level="1"]')]
    .filter(element => isVisible(element) && !masked(element)).slice(0, 20).map(element => clean(element.textContent));
  const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"]')]
    .filter(element => isVisible(element) && !masked(element)).slice(0, 80).map(element => ({
      path: pathOf(element), tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
      label: clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.getAttribute('placeholder') || element.getAttribute('name')),
      type: element.getAttribute('type'), href: hrefOf(element), disabled: element.matches(':disabled'),
      expanded: element.getAttribute('aria-expanded'), selected: element.getAttribute('aria-selected'),
    }));
  const root = document.documentElement;
  const documentSize = {
    width: Math.ceil(Math.max(innerWidth, root.scrollWidth, root.offsetWidth, document.body?.scrollWidth ?? 0, document.body?.offsetWidth ?? 0)),
    height: Math.ceil(Math.max(innerHeight, root.scrollHeight, root.offsetHeight, document.body?.scrollHeight ?? 0, document.body?.offsetHeight ?? 0)),
  };
  // Sample the union of mask rectangles so overlapping selectors do not count
  // the same screen area twice. This is coverage evidence, not a visual score.
  const gridSize = 40;
  const maskCells = new Uint8Array(gridSize * gridSize);
  let maskRectangles = 0;
  let maskSamplingCapped = false;
  for (const selector of maskSelectors) {
    for (const element of document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue;
      if (++maskRectangles > 5000) { maskSamplingCapped = true; break; }
      const left = Math.max(0, rect.left), top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
      for (let y = Math.max(0, Math.floor(top / innerHeight * gridSize)); y < Math.min(gridSize, Math.ceil(bottom / innerHeight * gridSize)); y++) {
        const centerY = (y + 0.5) / gridSize * innerHeight;
        if (centerY < top || centerY >= bottom) continue;
        for (let x = Math.max(0, Math.floor(left / innerWidth * gridSize)); x < Math.min(gridSize, Math.ceil(right / innerWidth * gridSize)); x++) {
          const centerX = (x + 0.5) / gridSize * innerWidth;
          if (centerX >= left && centerX < right) maskCells[y * gridSize + x] = 1;
        }
      }
    }
    if (maskSamplingCapped) break;
  }
  const maskedRatio = maskCells.reduce((sum, value) => sum + value, 0) / maskCells.length;
  const effectiveAreaPx = Math.round(innerWidth * innerHeight * (1 - maskedRatio));
  const overflow = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) > innerWidth + 2;
  const overflowingElements = overflow ? [...document.querySelectorAll('body *')].filter(element => {
    if (!isVisible(element) || masked(element)) return false;
    const rect = element.getBoundingClientRect();
    return rect.right > innerWidth + 2 || rect.left < -2;
  }).slice(0, 12).map(element => ({ selector: pathOf(element), right: Math.round(element.getBoundingClientRect().right) })) : [];
  return { title: clean(document.title), headings, controls, overflow, overflowingElements, maskedRatio, effectiveAreaPx, maskSamplingCapped, documentSize, bodyTextLength: (document.body?.innerText ?? '').trim().length, url: location.href };
}

async function checkAssertion(page, assertion) {
  const locator = assertion.selector ? page.locator(assertion.selector).first() : null;
  let actual;
  if (assertion.kind === 'url') actual = page.url();
  else if (assertion.kind === 'visible') actual = await locator.isVisible();
  else if (assertion.kind === 'hidden') actual = !await locator.isVisible();
  else if (assertion.kind === 'text') actual = clip(await locator.textContent());
  else if (assertion.kind === 'attribute') actual = await locator.getAttribute(assertion.attribute);
  else throw new Error(`Unsupported assertion kind: ${assertion.kind}`);
  const expected = assertion.equals !== undefined ? assertion.equals : assertion.contains !== undefined ? { contains: assertion.contains } : true;
  const passed = assertion.equals !== undefined ? actual === assertion.equals
    : assertion.contains !== undefined ? String(actual ?? '').includes(String(assertion.contains)) : actual === true;
  return { kind: assertion.kind, selector: assertion.selector, attribute: assertion.attribute, expected, actual, passed };
}

async function observe(browser, url, entryUrl, viewport, prefix, settings, point) {
  const result = { url: safeUrl(url), navigationError: null, httpStatus: null, errors: [], network: [], blockedRequests: [], assertions: [], stepError: null, snapshot: null, screenshot: null, repeatedScreenshot: null, stability: null, captureScope: null, captureLimited: false, documentSize: null };
  let context;
  const append = (list, item) => { if (list.length < MAX_OBSERVATIONS) list.push(item); };
  try {
    if (Date.now() >= settings.deadline) throw new Error('Acceptance run exceeded its 5 minute execution limit.');
    context = await browser.newContext({ ...BROWSER_PROFILE, viewport: { width: viewport.width, height: viewport.height }, serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(settings.timeoutMs);
    await context.route('**/*', async route => {
      const request = route.request();
      if (READ_METHODS.has(request.method().toUpperCase())) return route.continue().catch(() => {});
      append(result.blockedRequests, { kind: 'write-blocked', method: request.method(), url: safeUrl(request.url()), resourceType: request.resourceType() });
      await route.abort('blockedbyclient').catch(() => {});
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
      append(result.blockedRequests, { kind: 'websocket-blocked', method: 'WEBSOCKET', url: safeUrl(socket.url()) });
      socket.close();
    });
    const page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') append(result.errors, { kind: 'console', message: clip(message.text()) }); });
    page.on('pageerror', error => append(result.errors, { kind: 'pageerror', message: clip(error.message) }));
    page.on('response', response => { if (response.status() >= 400) append(result.network, { kind: 'http', status: response.status(), method: response.request().method(), url: safeUrl(response.url()) }); });
    page.on('requestfailed', request => {
      if (READ_METHODS.has(request.method().toUpperCase())) append(result.network, { kind: 'requestfailed', method: request.method(), url: safeUrl(request.url()), message: clip(request.failure()?.errorText) });
    });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('popup', popup => popup.close().catch(() => {}));
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: settings.timeoutMs });
      result.httpStatus = response?.status() ?? null;
      await page.waitForTimeout(settings.settleMs);
    } catch (error) { result.navigationError = messageOf(error); }
    if (!result.navigationError) {
      if (point) {
        for (const step of point.steps ?? []) {
          try {
            const timeout = Math.min(settings.timeoutMs, settings.deadline - Date.now());
            if (timeout <= 0) throw new Error('Acceptance execution time budget exhausted.');
            const locator = page.locator(step.selector).first();
            if (step.action === 'click') await locator.click({ timeout });
            else if (step.action === 'fill') await locator.fill(String(step.value ?? ''), { timeout });
            else if (step.action === 'press') await locator.press(String(step.value ?? ''), { timeout });
            else throw new Error(`Unsupported step action: ${step.action}`);
          } catch (error) { result.stepError = messageOf(error); break; }
        }
        await page.waitForTimeout(settings.settleMs);
        for (const assertion of point.assertions ?? []) {
          try {
            const timeout = Math.min(settings.timeoutMs, settings.deadline - Date.now());
            if (timeout <= 0) throw new Error('Acceptance execution time budget exhausted.');
            page.setDefaultTimeout(timeout);
            result.assertions.push(await checkAssertion(page, assertion));
          }
          catch (error) { result.assertions.push({ kind: assertion.kind, selector: assertion.selector, passed: false, error: messageOf(error) }); }
        }
      }
      result.snapshot = await page.evaluate(semanticSnapshot, { entryUrl, maskSelectors: settings.maskSelectors });
      result.snapshot.url = safeUrl(result.snapshot.url);
      result.documentSize = result.snapshot.documentSize;
      result.captureLimited = result.documentSize.height > CAPTURE_BUDGET.maxHeight
        || result.documentSize.width * result.documentSize.height > CAPTURE_BUDGET.maxPixels;
      result.captureScope = result.captureLimited ? 'viewport-only' : 'full-page';
      result.snapshot.captureScope = result.captureScope;
      result.snapshot.captureLimited = result.captureLimited;
      const mask = settings.maskSelectors.map(selector => page.locator(selector));
      const shotOptions = { animations: 'disabled', caret: 'hide', fullPage: !result.captureLimited, mask, timeout: Math.min(settings.timeoutMs, 10_000) };
      result.screenshot = `${prefix}.png`;
      const first = await page.screenshot({ ...shotOptions, path: join(settings.outputDir, result.screenshot) });
      await page.waitForTimeout(Math.max(80, settings.settleMs));
      result.repeatedScreenshot = `${prefix}-repeat.png`;
      const repeated = await page.screenshot({ ...shotOptions, path: join(settings.outputDir, result.repeatedScreenshot) });
      result.stability = comparePngBuffers(first, repeated).score;
      result.image = first;
    }
  } catch (error) {
    result.captureError = messageOf(error);
  } finally {
    if (context) await context.close().catch(() => {});
  }
  result.details = `${prefix}.json`;
  const { image, ...serializable } = result;
  await writeFile(join(settings.outputDir, result.details), JSON.stringify(serializable, null, 2));
  return result;
}

const navigated = side => !side.navigationError && !side.captureError && side.httpStatus !== null && side.httpStatus < 400
  && !!side.snapshot && !!side.image && !!side.screenshot && !!side.repeatedScreenshot && Number.isFinite(side.stability);
const healthy = side => navigated(side) && !side.errors.length && !side.network.length && !side.blockedRequests.length && !side.snapshot.overflow;

/** Execute independent, read-only browser acceptance against an approved runtime. */
export async function runAcceptance(plan, { runId = randomUUID(), outputDir, onEvent } = {}) {
  if (plan?.mode === 'spec') {
    const { runSpecAcceptance } = await import('./spec-runner.mjs');
    return runSpecAcceptance(plan, { runId, outputDir, onEvent });
  }
  const startedAt = new Date().toISOString();
  outputDir = outputDir || await mkdtemp(join(tmpdir(), 'heimdall-acceptance-'));
  await mkdir(outputDir, { recursive: true });
  const settings = { outputDir, deadline: Date.now() + 300_000, timeoutMs: bounded(plan.timeoutMs, 10_000, 500, 30_000), settleMs: plan.settleMs === 0 ? 0 : bounded(plan.settleMs, 250, 0, 2_000), maskSelectors: plan.normalization?.maskSelectors ?? [] };
  const checks = [];
  const safety = { networkPolicy: 'read-only', isolatedContexts: true, blockedRequests: 0 };
  const environment = { platform: process.platform, arch: process.arch, nodeVersion: process.version,
    browser: 'chromium', browserVersion: null, playwrightVersion: PLAYWRIGHT_VERSION, ...BROWSER_PROFILE };
  const routes = [...new Set([...(plan.routes ?? ['/']), ...(plan.points ?? []).map(point => point.route ?? '/')])];
  const viewports = plan.viewports ?? [{ name: 'desktop', width: 1440, height: 900 }];
  const points = plan.points ?? [];
  const capped = routes.length > MAX_ROUTES || viewports.length > MAX_VIEWPORTS || points.length > MAX_POINTS || points.some(point => (point.steps?.length ?? 0) > 12 || (point.assertions?.length ?? 0) > 20);
  const coverage = { planned: 6 * routes.length * viewports.length + points.length * viewports.length, completed: 0, capped };
  const event = async value => { if (onEvent) await onEvent({ runId, at: new Date().toISOString(), ...value }); };
  const base = (route, viewport) => ({ route, viewport: viewport.name, oracle: { kind: 'approved-runtime', source: plan.baselineUrl }, evidenceLevel: 'browser-reproduced' });
  const identityFor = (route, viewport, facet, expected, baseline, point) => buildAcceptanceIdentity({
    kind: 'browser', facet, route, viewport: { width: viewport.width, height: viewport.height },
    ...(point ? { pointId: point.id } : {}), environment,
    rule: {
      facet, route, timeoutMs: settings.timeoutMs, settleMs: settings.settleMs, runMs: 300_000,
      network: { allowedMethods: [...READ_METHODS], webSockets: 'blocked', isolatedContexts: true, serviceWorkers: 'block', acceptDownloads: false, maxObservations: MAX_OBSERVATIONS },
      capture: { ...CAPTURE_BUDGET, scope: 'bounded-full-page', animations: 'disabled', caret: 'hide',
        repeatWaitMs: Math.max(80, settings.settleMs), timeoutMs: Math.min(settings.timeoutMs, 10_000) },
      maskSelectors: [...new Set(settings.maskSelectors)].sort(),
      ...(['visual', 'structure'].includes(facet) ? { stabilityMinimum: 0.9995, maximumMaskedRatio: 0.8 } : {}),
      ...(facet === 'visual' ? { minimumScore: plan.thresholds?.visual ?? 0.97 } : {}),
      ...(point ? { steps: jsonData(point.steps ?? []), assertions: jsonData(point.assertions ?? []) } : {}),
    },
    oracle: facet === 'visual'
      ? { kind: 'runtime', source: plan.baselineUrl, baselineScreenshotSha256: baseline.image ? createHash('sha256').update(baseline.image).digest('hex') : null }
      : { kind: 'runtime', source: plan.baselineUrl, expected: jsonData(expected) },
  });
  const add = async check => {
    checks.push(check);
    coverage.completed = checks.length;
    coverage.planned = Math.max(coverage.planned, coverage.completed);
    await event({ kind: 'acceptance-check', message: check.title, completed: coverage.completed, total: coverage.planned, route: check.route, viewport: check.viewport });
  };
  const evidenceOf = (baseline, target) => ({ baselineScreenshot: baseline.screenshot, targetScreenshot: target.screenshot, baselineDetails: baseline.details, targetDetails: target.details, baselineRepeat: baseline.repeatedScreenshot, targetRepeat: target.repeatedScreenshot });
  const pair = async (browser, route, viewport, prefix, point) => {
    const baseline = await observe(browser, resolveAcceptanceRoute(plan.baselineUrl, route), plan.baselineUrl, viewport, `${prefix}-baseline`, settings, point);
    const target = await observe(browser, resolveAcceptanceRoute(plan.targetUrl, route), plan.targetUrl, viewport, `${prefix}-target`, settings, point);
    safety.blockedRequests += baseline.blockedRequests.length + target.blockedRequests.length;
    return { baseline, target };
  };
  let browser;
  let heartbeat;
  try {
    await event({ kind: 'acceptance-started', message: 'Starting isolated read-only browser acceptance.', completed: coverage.completed, total: coverage.planned });
    heartbeat = setInterval(() => event({ kind: 'acceptance-heartbeat', message: 'Browser acceptance is running.', completed: coverage.completed, total: coverage.planned }).catch(() => {}), 30_000);
    heartbeat.unref();
    if (capped) throw new Error('Acceptance plan exceeds runner execution limits (8 routes, 3 viewports, 24 points, 12 steps and 20 assertions per point).');
    browser = await chromium.launch({ headless: true, timeout: settings.timeoutMs });
    environment.browserVersion = browser.version();
    for (const [routeIndex, route] of routes.slice(0, MAX_ROUTES).entries()) {
      for (const [viewportIndex, viewport] of viewports.slice(0, MAX_VIEWPORTS).entries()) {
        if (Date.now() >= settings.deadline) throw new Error('Acceptance run exceeded its 5 minute execution limit.');
        const prefix = `route-${routeIndex + 1}-${viewportIndex + 1}-${safeName(viewport.name)}`;
        const { baseline, target } = await pair(browser, route, viewport, prefix);
        const common = base(route, viewport);
        const evidence = evidenceOf(baseline, target);
        const reproduction = [`Open ${resolveAcceptanceRoute(plan.baselineUrl, route)} at ${viewport.width}×${viewport.height}.`, `Open ${resolveAcceptanceRoute(plan.targetUrl, route)} in a fresh browser context at the same viewport.`];
        const make = (suffix, title, dimension, expected, actual, status = 'passed', verdict = 'match', severity = 'medium') => ({ ...common,
          id: `${prefix}-${suffix}`, identity: identityFor(route, viewport, suffix, expected, baseline),
          title, dimension, expected, actual, status, verdict, severity, evaluationLimited: !['passed', 'failed'].includes(status), reproduction, evidence });
        if (!navigated(baseline)) {
          await add(make('navigation', '基线页面可访问', 'health', 'Approved runtime loads successfully.', { baseline: baseline.navigationError || baseline.captureError || baseline.httpStatus, target: target.navigationError || target.captureError || target.httpStatus }, 'blocked', 'baseline_failed', 'high'));
        } else if (!navigated(target)) {
          const environment = !!(target.navigationError || target.captureError);
          await add(make('navigation', '目标页面可访问', 'health', `HTTP ${baseline.httpStatus}`, target.navigationError || target.captureError || `HTTP ${target.httpStatus}`, environment ? 'blocked' : 'failed', environment ? 'environment' : 'bug', 'high'));
        } else await add(make('navigation', '页面导航与 HTTP 状态', 'health', baseline.httpStatus, target.httpStatus));
        for (const [facet, title, getItems] of [
          ['console', '浏览器脚本与控制台错误', side => side.errors],
          ['network', '资源与只读网络请求', side => side.network],
          ['overflow', '视口水平溢出', side => side.snapshot?.overflow ? [{ kind: 'overflow' }] : []],
        ]) {
          const baselineItems = getItems(baseline), targetItems = getItems(target);
          const existing = new Set(baselineItems.map(item => keyForObservation(item, plan.baselineUrl)));
          const added = targetItems.filter(item => !existing.has(keyForObservation(item, plan.targetUrl)));
          // A rejected POST/WebSocket can itself cause console errors and failed reads.
          // Those side effects have no independent defect oracle in a read-only run.
          const policyAffected = ['console', 'network'].includes(facet) && (baseline.blockedRequests.length > 0 || target.blockedRequests.length > 0);
          const status = policyAffected || !navigated(baseline) || !navigated(target) ? 'blocked' : added.length ? 'failed' : baselineItems.length ? 'needs_review' : 'passed';
          const verdict = policyAffected ? 'environment' : !navigated(baseline) ? 'baseline_failed' : !navigated(target) ? 'environment' : added.length ? 'bug' : baselineItems.length ? 'baseline_failed' : 'match';
          await add(make(facet, title, 'health', baselineItems, { observed: targetItems, added, policyAffected }, status, verdict, facet === 'console' ? 'high' : 'medium'));
        }
        if (baseline.blockedRequests.length || target.blockedRequests.length) {
          coverage.planned++;
          await add(make('readonly', '只读执行安全边界', 'health', 'GET, HEAD and OPTIONS only.', { baseline: baseline.blockedRequests, target: target.blockedRequests }, 'blocked', 'environment', 'medium'));
        }
        const structureOf = side => side.snapshot ? { title: side.snapshot.title, headings: side.snapshot.headings, controls: side.snapshot.controls } : null;
        const structureBaseline = structureOf(baseline), structureTarget = structureOf(target);
        const structureReady = healthy(baseline) && healthy(target) && baseline.snapshot.bodyTextLength > 0;
        const stable = baseline.stability >= 0.9995 && target.stability >= 0.9995;
        const structureMatch = identical(structureBaseline, structureTarget);
        const maskCoverage = {
          baseline: { maskedRatio: baseline.snapshot?.maskedRatio ?? null, effectiveAreaPx: baseline.snapshot?.effectiveAreaPx ?? null, samplingCapped: baseline.snapshot?.maskSamplingCapped ?? false },
          target: { maskedRatio: target.snapshot?.maskedRatio ?? null, effectiveAreaPx: target.snapshot?.effectiveAreaPx ?? null, samplingCapped: target.snapshot?.maskSamplingCapped ?? false },
        };
        const maskLimited = baseline.snapshot?.maskedRatio > 0.8 || target.snapshot?.maskedRatio > 0.8 || baseline.snapshot?.maskSamplingCapped || target.snapshot?.maskSamplingCapped;
        await add(make('structure', '标题、主标题与关键控件语义', 'structure', structureBaseline, { ...structureTarget, maskCoverage },
          !structureReady ? 'blocked' : maskLimited ? 'needs_review' : structureMatch ? 'passed' : !stable ? 'needs_review' : 'failed',
          !healthy(baseline) || !baseline.snapshot?.bodyTextLength ? 'baseline_failed' : !healthy(target) ? 'environment' : maskLimited ? 'needs_review' : structureMatch ? 'match' : !stable ? 'needs_review' : 'bug', 'high'));
        const visual = baseline.image && target.image ? comparePngBuffers(baseline.image, target.image) : null;
        const visualReady = healthy(baseline) && healthy(target);
        const captureLimited = baseline.captureLimited || target.captureLimited;
        const capture = {
          baseline: { captureScope: baseline.captureScope, captureLimited: baseline.captureLimited, documentSize: baseline.documentSize },
          target: { captureScope: target.captureScope, captureLimited: target.captureLimited, documentSize: target.documentSize },
        };
        let visualStatus = 'passed', visualVerdict = 'match';
        if (!visualReady || !visual) { visualStatus = 'blocked'; visualVerdict = !healthy(baseline) ? 'baseline_failed' : 'environment'; }
        else if (maskLimited || captureLimited || !stable) { visualStatus = 'needs_review'; visualVerdict = 'needs_review'; }
        else if (visual.score < (plan.thresholds?.visual ?? 0.97)) { visualStatus = 'failed'; visualVerdict = 'bug'; }
        const visualCheck = make('visual', '页面视觉还原度', 'visual', { minimumScore: plan.thresholds?.visual ?? 0.97, stabilityMinimum: 0.9995, maximumMaskedRatio: 0.8, captureBudget: CAPTURE_BUDGET }, { score: visual?.score ?? null, baselineStability: baseline.stability, targetStability: target.stability, maskCoverage, capture, eligible: visualReady && !maskLimited && !captureLimited }, visualStatus, visualVerdict);
        if (visual) {
          visualCheck.score = visual.score;
          visualCheck.evidence = { ...evidence, diff: `${prefix}-diff.png` };
          await writeFile(join(outputDir, visualCheck.evidence.diff), visual.diffPng);
        }
        await add(visualCheck);
        for (const [pointIndex, originalPoint] of points.slice(0, MAX_POINTS).entries()) {
          if ((originalPoint.route ?? '/') !== route) continue;
          if (Date.now() >= settings.deadline) throw new Error('Acceptance run exceeded its 5 minute execution limit.');
          const point = { ...originalPoint, steps: (originalPoint.steps ?? []).slice(0, 12), assertions: (originalPoint.assertions ?? []).slice(0, 20) };
          const pointPrefix = `${prefix}-point-${pointIndex + 1}`;
          const sides = await pair(browser, route, viewport, pointPrefix, point);
          const baselinePassed = healthy(sides.baseline) && !sides.baseline.stepError && sides.baseline.assertions.every(assertion => assertion.passed) && point.assertions.length > 0;
          const targetPassed = healthy(sides.target) && !sides.target.stepError && sides.target.assertions.every(assertion => assertion.passed);
          const writeBlocked = sides.baseline.blockedRequests.length || sides.target.blockedRequests.length;
          const environment = !!(sides.target.navigationError || sides.target.captureError);
          const expected = { stepsComplete: !sides.baseline.stepError, assertions: sides.baseline.assertions, httpStatus: sides.baseline.httpStatus };
          await add({ ...common, id: `${pointPrefix}-${safeName(point.id)}`, title: point.title || point.id, dimension: 'behavior', severity: point.severity || 'high',
            identity: identityFor(route, viewport, 'behavior', expected, sides.baseline, point),
            status: writeBlocked ? 'blocked' : !baselinePassed ? 'blocked' : environment ? 'blocked' : targetPassed ? 'passed' : 'failed',
            verdict: writeBlocked ? 'environment' : !baselinePassed ? 'baseline_failed' : environment ? 'environment' : targetPassed ? 'match' : 'bug',
            evaluationLimited: !!(writeBlocked || !baselinePassed || environment || Date.now() >= settings.deadline), expected,
            actual: { stepsComplete: !sides.target.stepError, stepError: sides.target.stepError, assertions: sides.target.assertions, httpStatus: sides.target.httpStatus, navigationError: sides.target.navigationError, errors: sides.target.errors, network: sides.target.network, overflow: sides.target.snapshot?.overflow, blockedRequests: sides.target.blockedRequests },
            reproduction: [...reproduction, ...point.steps.map(step => `${step.action} ${step.selector}${step.value !== undefined ? ` (${String(step.value).slice(0, 120)})` : ''}`)], evidence: evidenceOf(sides.baseline, sides.target),
          });
        }
        await event({ kind: 'acceptance-progress', message: `Checked ${route} at ${viewport.name}.`, completed: coverage.completed, total: coverage.planned, route, viewport: viewport.name });
      }
    }
    if (capped) await add({ ...base('/', viewports[0] ?? { name: 'unknown' }), id: 'execution-limit', title: '执行覆盖达到安全上限', dimension: 'health', status: 'blocked', verdict: 'environment', severity: 'high', expected: 'All planned routes, viewports, steps and assertions execute.', actual: { maxRoutes: MAX_ROUTES, maxViewports: MAX_VIEWPORTS, maxPoints: MAX_POINTS, maxSteps: 12, maxAssertions: 20 }, reproduction: [], evidence: {} });
  } catch (error) {
    await add({ ...base('/', viewports[0] ?? { name: 'unknown' }), id: 'runner-environment', title: '浏览器验收执行环境', dimension: 'health', status: 'blocked', verdict: 'environment', severity: 'high', expected: 'Browser acceptance completes.', actual: messageOf(error), reproduction: [], evidence: {} });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (browser) await browser.close().catch(() => {});
  }
  const report = { schemaVersion: 1, runId, name: plan.name, mode: plan.mode, baselineUrl: plan.baselineUrl, targetUrl: plan.targetUrl, startedAt, endedAt: new Date().toISOString(), status: 'completed', checks, coverage, safety, environment,
    scope: '仅验收已声明路由、视口、操作和有界观察窗口；未声明业务与接口契约为未测。单侧文档高度不超过12,000像素且面积不超过12,000,000像素时截图覆盖全页，两次稳定性截图采用相同范围。超过预算仅保留首屏证据，视觉检查标为待复核，不作为完整页面通过依据。' };
  await event({ kind: 'acceptance-completed', message: `Browser acceptance completed with ${checks.length} checks.`, completed: coverage.completed, total: coverage.planned });
  return report;
}
