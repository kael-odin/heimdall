/**
 * Baseline exploration: proposes acceptance points from the approved baseline's own behaviour.
 *
 * For each visible control with a unique, stable CSS selector, exploration loads the route in a fresh
 * read-only context, records what the runner can assert (URL, visibility, text and state attributes of
 * elements with stable selectors), performs one click or fill, and records it again. Changes become
 * assertions that were false before the step. Each proposed point is then replayed the way the runner
 * replays points (fresh context, same navigation, settle, step and assertion semantics, same health rules)
 * at every planned viewport, and only assertions that hold everywhere are kept, so the baseline side of a
 * run satisfies them by construction. Short, stable text outside controls, which the structure check does
 * not compare, becomes one content point per route.
 *
 * Exploration visits only the baseline, writes nothing and never touches runner, report or verifier
 * sources; candidates become points only when the user merges them into a plan.
 */
import { chromium } from 'playwright';
import { normalizeAcceptancePlan, resolveAcceptanceUrl, DEFAULT_VIEWPORTS } from './schema.mjs';
import { normalizeAcceptancePath, normalizeAcceptanceUrl } from './urls.mjs';

export const EXPLORATION_SCHEMA_VERSION = 1;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BROWSER_PROFILE = Object.freeze({ locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' });
const MAX_POINTS = 24;
const MAX_INTERACTIONS_PER_ROUTE = 8;
const MAX_CONTENT_ASSERTIONS = 6;
const MAX_ASSERTIONS_PER_POINT = 4;
const MAX_SKIP_EXAMPLES = 40;
const DEFAULT_BUDGET_MS = 150_000;
const STEP_TIMEOUT_MS = 5_000;
const STATE_ATTRIBUTES = ['aria-expanded', 'aria-selected', 'aria-pressed', 'aria-checked', 'aria-current', 'aria-invalid', 'data-state'];
const CONTROL_SELECTOR = 'button, a[href], input:not([type="hidden"]), textarea, select, summary, [role="button"], [role="tab"], [role="link"], [role="menuitem"], [role="switch"], [role="checkbox"]';
const DESTRUCTIVE = /删除|移除|注销|退出|登出|清空|重置|卸载|解绑|取消订阅|\b(delete|remove|log-?out|log out|sign-?out|sign out|destroy|reset|unsubscribe|deactivate|purge)\b/i;
const DYNAMIC_TEXT = /\d{1,2}:\d{2}|\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}|刚刚|\d+\s*(秒|分钟|小时|天)前|\b(ago|today|yesterday|just now)\b/i;
const DOWNLOAD = /\.(pdf|zip|rar|7z|gz|tgz|dmg|exe|msi|apk|ipa|deb|rpm|csv|xlsx?|docx?|pptx?)$/i;
const FILLABLE = new Set(['', 'text', 'search', 'email', 'number', 'tel', 'url']);
const SAMPLE_VALUES = { email: 'qa@example.com', number: '1', tel: '13800000000', url: 'https://example.com', search: '验收' };

export const EXPLORATION_SKIP_REASONS = Object.freeze({
  'not-visible': '当前视口下不可见',
  disabled: '控件处于禁用状态',
  destructive: '名称或地址像删除、退出等破坏性操作',
  'unsupported-control': '没有对应的验收步骤（下拉选择、文件、密码、日期等）',
  'in-page-anchor': '页内锚点或 javascript: 链接',
  'external-scheme': 'mailto、tel、javascript 等非网页链接',
  download: '下载链接',
  'new-tab': '在新窗口打开',
  'outside-entry': '指向基线入口以外的地址',
  'step-failed': '在基线上无法完成这步操作',
  'write-blocked': '操作会发出写请求，只读策略会拦截',
  'left-origin': '操作后跳到其他站点',
  'unhealthy-after-step': '操作后基线出现脚本错误、资源失败或水平溢出',
  'no-observable-change': '操作后没有可断言的变化',
  unstable: '按执行器方式重放时断言不成立',
  'viewport-mismatch': '在计划的其他视口上不成立',
  'already-planned': '与计划里已有的验收点相同',
  limit: '超出验收点数量上限',
  budget: '超出探索时间预算',
});
export const EXPLORATION_ROUTE_STATUS = Object.freeze({
  explored: '已探索',
  'navigation-failed': '基线页面无法打开',
  'baseline-unhealthy': '基线页面本身有脚本错误、资源失败、写请求或水平溢出，在这里生成的验收点只会得到“基线失败”',
  budget: '超出探索时间预算，未探索',
});
export const EXPLORATION_SCOPE = '候选验收点只从已批准的基线推导：在全新的只读上下文里逐个操作基线上带稳定选择器的可见控件，'
  + '把操作前后执行器能观察到的变化（地址、可见性、文本、状态属性）写成断言，只保留操作前不成立、操作后成立的断言，'
  + '再按执行器的方式在计划的每个视口上重放，全部成立才保留。结构检查不比较的短文本另组成每条路由一个内容验收点。'
  + '探索只访问基线，不访问目标，不改变执行器与核验规则；只覆盖单步点击和填写，跳过破坏性名称、写请求、外链、下载与新窗口。'
  + '基线行为就是验收预期，并入计划前请确认这些行为确实是需求。';

const clip = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
const slug = (value, size = 40) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, size).replace(/-+$/, '');
const routeSlug = route => slug(route) || 'root';
const signatureOf = point => JSON.stringify([point.route ?? '/', point.steps ?? [], point.assertions ?? []]);
const safeUrl = value => {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]');
    return url.href;
  } catch { return '[invalid-url]'; }
};
// The runner's healthy(): no console or page errors, no failed reads, no blocked writes, no horizontal overflow.
const unhealthy = (health, overflow) => !!(health.errors.length || health.network.length || health.blocked.length
  || health.leftOrigin.length || overflow);

/** Entry-relative path of a URL, so one assertion holds for the baseline and target entries alike. */
export function relativeTo(entryUrl, value) {
  try {
    const entry = new URL(entryUrl), url = new URL(value);
    if (url.origin !== entry.origin) return null;
    const prefix = entry.pathname.replace(/\/$/, '');
    if (prefix && url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return null;
    return url.pathname.slice(prefix.length) || '/';
  } catch { return null; }
}

/** One fresh read-only context with the runner's profile and network policy; top-level navigations must stay inside the baseline origin. */
async function openPage(browser, { url, viewport, origin, timeoutMs, settleMs }) {
  const health = { errors: [], network: [], blocked: [], leftOrigin: [] };
  const context = await browser.newContext({ ...BROWSER_PROFILE, viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: 'block', acceptDownloads: false });
  const side = { context, health, page: null, navigationError: null };
  try {
    context.setDefaultTimeout(timeoutMs);
    await context.route('**/*', async route => {
      const request = route.request();
      if (!READ_METHODS.has(request.method().toUpperCase())) {
        health.blocked.push({ method: request.method(), url: safeUrl(request.url()) });
        return route.abort('blockedbyclient').catch(() => {});
      }
      let topLevel = false;
      try { topLevel = request.isNavigationRequest() && !request.frame().parentFrame(); } catch { topLevel = false; }
      let sameOrigin = true;
      try { sameOrigin = new URL(request.url()).origin === origin; } catch { sameOrigin = false; }
      if (topLevel && !sameOrigin) {
        health.leftOrigin.push(safeUrl(request.url()));
        return route.abort('blockedbyclient').catch(() => {});
      }
      return route.continue().catch(() => {});
    });
    if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => {
      health.blocked.push({ method: 'WEBSOCKET', url: safeUrl(socket.url()) });
      socket.close();
    });
    const page = side.page = await context.newPage();
    page.on('console', message => { if (message.type() === 'error') health.errors.push(clip(message.text())); });
    page.on('pageerror', error => health.errors.push(clip(error.message)));
    page.on('response', response => { if (response.status() >= 400) health.network.push(`HTTP ${response.status()} ${safeUrl(response.url())}`); });
    page.on('requestfailed', request => {
      if (READ_METHODS.has(request.method().toUpperCase())) health.network.push(`请求失败 ${safeUrl(request.url())}`);
    });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('popup', popup => popup.close().catch(() => {}));
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (!response || response.status() >= 400) side.navigationError = `HTTP ${response?.status() ?? '无响应'}`;
      await page.waitForTimeout(settleMs);
    } catch (error) { side.navigationError = clip(error?.message); }
    return side;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
const closePage = async side => { await side?.context?.close().catch(() => {}); };

/** Filters that need real DOM facts (visibility, form ownership) before a control can be explored. */
function controlFactsInPage({ selector }) {
  const element = document.querySelector(selector);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const css = getComputedStyle(element);
  const form = element.form ?? element.closest('form');
  return {
    visible: rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden',
    disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
    submitter: element.tagName === 'BUTTON' && form ? (element.getAttribute('type') ?? 'submit').toLowerCase() !== 'button' : false,
    contenteditable: element.isContentEditable,
  };
}

/**
 * Reads every proposed assertion on the current page the way the runner does after a step.
 * URL assertions are resolved outside; they return null here.
 */
function readAssertionsInPage({ assertions }) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  };
  return assertions.map(assertion => {
    if (assertion.kind === 'url') return null;
    let element = null;
    try { element = document.querySelector(assertion.selector); } catch { element = null; }
    if (assertion.kind === 'visible') return !!element && isVisible(element);
    if (assertion.kind === 'hidden') return !element || !isVisible(element);
    if (assertion.kind === 'text') return element ? clean(element.textContent).slice(0, 200) : null;
    if (assertion.kind === 'attribute') return element ? element.getAttribute(assertion.attribute) : null;
    return null;
  });
}

/** Runner-equivalent predicate: equals is exact, contains is a substring, a boolean assertion needs true. */
function assertionPasses(assertion, actual) {
  return assertion.equals !== undefined ? actual === assertion.equals
    : assertion.contains !== undefined ? String(actual ?? '').includes(assertion.contains) : actual === true;
}

/**
 * Scans one page: every element that can carry a durable selector, its visibility, text and state
 * attributes, plus the interactive controls eligible for exploration and the horizontal-overflow flag.
 */
function scanInPage({ controlSelector, stateAttributes, limit = 200 }) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  };
  const unique = selector => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  const quote = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // Prefer selectors that survive DOM reshuffling and are readable in a plan: id, test id, label, name.
  const stableSelector = element => {
    if (element.id) { const selector = `#${CSS.escape(element.id)}`; if (unique(selector)) return selector; }
    const testId = element.getAttribute('data-testid');
    if (testId) { const selector = `[data-testid="${quote(testId)}"]`; if (unique(selector)) return selector; }
    const label = element.getAttribute('aria-label');
    if (label) { const selector = `${element.tagName.toLowerCase()}[aria-label="${quote(label)}"]`; if (unique(selector)) return selector; }
    const name = element.getAttribute('name');
    if (name && ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
      const selector = `${element.tagName.toLowerCase()}[name="${quote(name)}"]`;
      if (unique(selector)) return selector;
    }
    return null;
  };
  const stateOf = element => ({
    visible: isVisible(element),
    text: clean(element.innerText ?? element.textContent),
    attributes: Object.fromEntries(stateAttributes.map(attribute => [attribute, element.getAttribute(attribute)])
      .filter(([, value]) => value !== null)),
  });
  const all = new Map();
  for (const element of document.querySelectorAll('[id], [data-testid], [aria-label]')) {
    if (all.size >= limit) break;
    if (['HTML', 'HEAD', 'BODY'].includes(element.tagName)) continue;
    const selector = stableSelector(element);
    if (selector && !all.has(selector)) all.set(selector, { selector, tag: element.tagName.toLowerCase(), ...stateOf(element) });
  }
  for (const element of document.querySelectorAll(controlSelector)) {
    if (all.size >= limit + 60) break;
    const selector = stableSelector(element);
    if (!selector || all.has(selector)) continue;
    all.set(selector, { selector, tag: element.tagName.toLowerCase(), ...stateOf(element) });
  }
  const controls = [...document.querySelectorAll(controlSelector)].map(element => ({
    selector: stableSelector(element), tag: element.tagName.toLowerCase(), role: element.getAttribute('role'),
    type: (element.getAttribute('type') ?? '').toLowerCase(), href: element.getAttribute('href'),
    target: element.getAttribute('target'), download: element.hasAttribute('download'),
    label: clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText
      || element.getAttribute('placeholder') || element.getAttribute('name')),
  })).filter(control => control.selector);
  const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'DT', 'DD', 'LABEL', 'FIGCAPTION', 'BLOCKQUOTE', 'SUMMARY']);
  const texts = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, label, figcaption, blockquote')]
    .filter(element => TEXT_TAGS.has(element.tagName) && isVisible(element)
      && !element.closest('button, a, summary, [role="button"], [role="tab"], input, select, textarea'))
    .map(element => ({ selector: stableSelector(element), text: clean(element.innerText ?? element.textContent) }))
    .filter(item => item.selector && item.text.length >= 2 && item.text.length <= 80);
  const root = document.documentElement;
  return {
    url: location.href,
    overflow: Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) > innerWidth + 2,
    elements: [...all.values()],
    controls,
    texts,
  };
}

const scan = (page, options) => page.evaluate(scanInPage, options);
const readAssertions = (page, assertions) => page.evaluate(readAssertionsInPage, { assertions });
const controlFacts = (page, selector) => page.evaluate(controlFactsInPage, { selector });
const SCAN_OPTIONS = Object.freeze({ controlSelector: CONTROL_SELECTOR, stateAttributes: STATE_ATTRIBUTES });

/** Reads every assertion on one page; URL assertions are resolved against the entry. */
async function readAll(page, entryUrl, assertions) {
  const pageValues = assertions.filter(assertion => assertion.kind !== 'url').length ? await readAssertions(page, assertions) : [];
  let index = 0;
  return assertions.map(assertion => assertion.kind === 'url' ? relativeTo(entryUrl, page.url()) : pageValues[index++]);
}

/** Performs one exploration step the way the runner does, with its own short timeout. */
async function performStep(page, step) {
  const locator = page.locator(step.selector).first();
  if (step.action === 'click') await locator.click({ timeout: STEP_TIMEOUT_MS });
  else if (step.action === 'fill') await locator.fill(step.value, { timeout: STEP_TIMEOUT_MS });
  else if (step.action === 'press') await locator.press(step.value, { timeout: STEP_TIMEOUT_MS });
  else throw new Error(`unsupported step ${step.action}`);
}

/** Decides whether one control can be explored and which step it becomes, from its static attributes. */
function stepFor(control, facts, { entryUrl, pageUrl }) {
  if (!facts?.visible) return { skip: 'not-visible' };
  if (facts.disabled) return { skip: 'disabled' };
  const labelAndHref = `${control.label} ${control.href ?? ''}`;
  if (DESTRUCTIVE.test(labelAndHref)) return { skip: 'destructive' };
  if (['button', 'a', 'summary'].includes(control.tag) || ['button', 'tab', 'link', 'menuitem', 'switch', 'checkbox'].includes(control.role)) {
    if (facts.submitter) return { skip: 'form-write' };
    if (control.tag === 'a') {
      if (control.download) return { skip: 'download' };
      if (control.target && control.target !== '_self') return { skip: 'new-tab' };
      const href = String(control.href ?? '').trim();
      if (href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) return { skip: 'in-page-anchor' };
      if (/^(mailto|tel|sms|data):/i.test(href)) return { skip: 'external-scheme' };
      if (DOWNLOAD.test(href.split(/[?#]/)[0])) return { skip: 'download' };
      // Resolve against the current page, the way a browser would, then require it to stay under the entry.
      let absolute;
      try { absolute = new URL(href.split('#')[0] || pageUrl, pageUrl).href; } catch { return { skip: 'outside-entry' }; }
      if (!relativeTo(entryUrl, absolute)) return { skip: 'outside-entry' };
    }
    return { step: { action: 'click', selector: control.selector } };
  }
  if (['input', 'textarea'].includes(control.tag)) {
    if (facts.contenteditable) return { skip: 'unsupported-control' };
    if (control.tag === 'input' && !FILLABLE.has(control.type)) return { skip: 'unsupported-control' };
    if (facts.submitter) return { skip: 'form-write' };
    const value = SAMPLE_VALUES[control.type] ?? '验收样例';
    return { step: { action: 'fill', selector: control.selector, value } };
  }
  return { skip: 'unsupported-control' };
}

/** Assertions the runner can evaluate that were false before the step and true after it. */
function assertionsFromChange(before, after, beforePath, afterPath) {
  const assertions = [];
  if (afterPath && beforePath !== afterPath) assertions.push({ kind: 'url', contains: afterPath });
  const previous = new Map(before.elements.map(element => [element.selector, element]));
  for (const element of after.elements) {
    const prior = previous.get(element.selector);
    if (element.visible && !prior?.visible) assertions.push({ kind: 'visible', selector: element.selector });
    if (!element.visible && prior?.visible) assertions.push({ kind: 'hidden', selector: element.selector });
    for (const [attribute, value] of Object.entries(element.attributes)) {
      if (prior?.attributes?.[attribute] !== value) assertions.push({ kind: 'attribute', selector: element.selector, attribute, equals: value });
    }
  }
  // Changed or new short text outside the previously visible snapshot; long or time-like text is not a stable oracle.
  const priorTexts = new Map(before.texts.map(text => [text.selector, text.text]));
  const textElement = after.texts.find(text => priorTexts.get(text.selector) !== text.text
    && !DYNAMIC_TEXT.test(text.text) && !DYNAMIC_TEXT.test(priorTexts.get(text.selector) ?? ''));
  if (textElement) assertions.push({ kind: 'text', selector: textElement.selector, equals: textElement.text });
  return assertions.slice(0, MAX_ASSERTIONS_PER_POINT);
}

/** Replays a candidate on one viewport with a fresh context; returns which assertions hold there. */
async function replayOn(browser, { entryUrl, baselineEntry, viewport, step, assertions, timeoutMs, settleMs }) {
  const origin = new URL(entryUrl).origin;
  const side = await openPage(browser, { url: entryUrl, viewport, origin, timeoutMs, settleMs });
  try {
    if (side.navigationError) return { ok: false, reason: 'step-failed' };
    if (unhealthy(side.health, false)) return { ok: false, reason: 'unhealthy-after-step' };
    if (step) {
      try { await performStep(side.page, step); } catch { return { ok: false, reason: 'step-failed' }; }
      await side.page.waitForTimeout(settleMs);
    }
    const after = await scan(side.page, SCAN_OPTIONS);
    if (unhealthy(side.health, after.overflow)) return { ok: false, reason: side.health.blocked.length ? 'write-blocked' : side.health.leftOrigin.length ? 'left-origin' : 'unhealthy-after-step' };
    if (step && (!after.url || !relativeTo(baselineEntry, after.url))) return { ok: false, reason: 'left-origin' };
    const actuals = await readAll(side.page, baselineEntry, assertions);
    return { ok: true, actuals };
  } finally { await closePage(side); }
}

/** Interaction candidate: discover the change on the first viewport, then confirm each assertion on every viewport. */
async function proposeInteraction(browser, { entryUrl, baselineEntry, control, viewport, viewports, timeoutMs, settleMs }) {
  const origin = new URL(entryUrl).origin;
  const side = await openPage(browser, { url: entryUrl, viewport, origin, timeoutMs, settleMs });
  let step, beforePath, afterPath, before, after;
  try {
    if (side.navigationError) return { skip: 'step-failed' };
    const facts = await controlFacts(side.page, control.selector);
    const decision = stepFor(control, facts, { entryUrl: baselineEntry, pageUrl: side.page.url() });
    if (decision.skip) return decision;
    step = decision.step;
    if (unhealthy(side.health, false)) return { skip: 'unhealthy-after-step' };
    before = await scan(side.page, SCAN_OPTIONS);
    if (before.overflow) return { skip: 'unhealthy-after-step' };
    beforePath = relativeTo(baselineEntry, before.url);
    try { await performStep(side.page, step); } catch { return { skip: 'step-failed' }; }
    await side.page.waitForTimeout(settleMs);
    after = await scan(side.page, SCAN_OPTIONS);
    if (side.health.blocked.length) return { skip: 'write-blocked' };
    if (side.health.leftOrigin.length) return { skip: 'left-origin' };
    if (unhealthy(side.health, after.overflow)) return { skip: 'unhealthy-after-step' };
    afterPath = relativeTo(baselineEntry, after.url);
    if (!afterPath) return { skip: 'left-origin' };
  } finally { await closePage(side); }
  const proposed = assertionsFromChange(before, after, beforePath, afterPath);
  if (!proposed.length) return { skip: 'no-observable-change' };
  const held = proposed.map(() => true);
  for (const [index, vp] of viewports.entries()) {
    const replay = await replayOn(browser, { entryUrl, baselineEntry, viewport: vp, step, assertions: proposed, timeoutMs, settleMs });
    if (!replay.ok) return { skip: index === 0 ? 'unstable' : (replay.reason === 'step-failed' ? 'viewport-mismatch' : replay.reason) };
    replay.actuals.forEach((actual, assertionIndex) => { if (!assertionPasses(proposed[assertionIndex], actual)) held[assertionIndex] = false; });
  }
  const assertions = proposed.filter((_assertion, index) => held[index]).slice(0, MAX_ASSERTIONS_PER_POINT);
  if (!assertions.length) return { skip: 'viewport-mismatch' };
  return { step, assertions, observed: { beforePath, afterPath,
    attributes: assertions.filter(assertion => assertion.kind === 'attribute').map(assertion => `${assertion.selector} ${assertion.attribute}=${assertion.equals}`) } };
}

/** Content candidate: short, stable text the structure check does not compare, confirmed on every viewport. */
async function proposeContent(browser, { entryUrl, baselineEntry, viewports, texts, timeoutMs, settleMs }) {
  const proposed = [];
  for (const text of texts) {
    if (DYNAMIC_TEXT.test(text.text) || text.tag === 'h1') continue;
    const assertions = [{ kind: 'visible', selector: text.selector }];
    if (text.text.length >= 2 && text.text.length <= 60) assertions.push({ kind: 'text', selector: text.selector, equals: text.text });
    proposed.push({ selector: text.selector, text: text.text, assertions });
  }
  if (!proposed.length) return [];
  const held = proposed.map(() => true);
  for (const vp of viewports) {
    const side = await openPage(browser, { url: entryUrl, viewport: vp, origin: new URL(entryUrl).origin, timeoutMs, settleMs });
    try {
      if (side.navigationError) { proposed.forEach((_item, index) => { held[index] = false; }); break; }
      const actuals = await readAll(side.page, baselineEntry, proposed.flatMap(item => item.assertions));
      let cursor = 0;
      proposed.forEach((item, index) => {
        const slice = actuals.slice(cursor, cursor + item.assertions.length);
        cursor += item.assertions.length;
        item.assertions.forEach((assertion, assertionIndex) => { if (!assertionPasses(assertion, slice[assertionIndex])) held[index] = false; });
      });
    } finally { await closePage(side); }
  }
  return proposed.filter((_item, index) => held[index]).slice(0, MAX_CONTENT_ASSERTIONS);
}


const boundedInt = (value, fallback, min, max) => Number.isInteger(value) && value >= min && value <= max ? value : fallback;

function normalizeViewports(value) {
  if (!Array.isArray(value) || !value.length) return null;
  if (value.length > 3) throw new TypeError('viewports must contain 1..3 entries');
  return value.map(raw => {
    if (!raw || typeof raw !== 'object') throw new TypeError('viewport must be an object');
    const { name, width, height } = raw;
    if (typeof name !== 'string' || !/^[a-z0-9-]+$/i.test(name)) throw new TypeError('viewport name must use letters, numbers and hyphens');
    if (!Number.isInteger(width) || width < 320 || width > 1920) throw new TypeError('viewport width must be an integer from 320 to 1920');
    if (!Number.isInteger(height) || height < 320 || height > 1440) throw new TypeError('viewport height must be an integer from 320 to 1440');
    return { name, width, height };
  });
}

/**
 * Explores the approved baseline and proposes acceptance points for the declared routes.
 * Returns the same shape a plan author merges by hand; nothing is written and no target is visited.
 */
export async function exploreAcceptanceBaseline(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('exploration input must be an object');
  const baselineUrl = normalizeAcceptanceUrl(input.baselineUrl, 'baselineUrl');
  const routes = [...new Set((Array.isArray(input.routes) && input.routes.length ? input.routes : ['/'])
    .slice(0, 8).map(route => normalizeAcceptancePath(route)))];
  const plan = input.plan === undefined || input.plan === null ? null : normalizeAcceptancePlan(input.plan);
  const viewports = normalizeViewports(input.viewports)
    ?? normalizeViewports(plan?.viewports) ?? DEFAULT_VIEWPORTS.map(viewport => ({ ...viewport }));
  if (!viewports.length) throw new TypeError('viewports must contain 1..3 entries');
  const timeoutMs = boundedInt(input.timeoutMs, plan?.timeoutMs ?? 10_000, 1_000, 30_000);
  const settleMs = boundedInt(input.settleMs, plan?.settleMs ?? 250, 50, 3_000);
  const budgetMs = boundedInt(input.budgetMs, DEFAULT_BUDGET_MS, 15_000, 300_000);
  const maxPoints = boundedInt(input.maxPoints, MAX_POINTS, 1, MAX_POINTS);
  const deadline = Date.now() + budgetMs;
  const origin = new URL(baselineUrl).origin;
  const planSignatures = new Set((plan?.points ?? []).map(signatureOf));
  const usedIds = new Set((plan?.points ?? []).map(point => point.id));
  const usedSignatures = new Set(planSignatures);
  const ids = pointId => {
    let id = pointId.slice(0, 80);
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${pointId.slice(0, 76)}-${suffix}`;
    usedIds.add(id);
    return id;
  };
  const routesResult = [];
  const points = [];
  let browser;
  const warnings = [];
  try {
    browser = await chromium.launch({ headless: true });
    for (const route of routes) {
      const entryUrl = resolveAcceptanceUrl(baselineUrl, route);
      const entry = { route, status: null, candidates: [], skipped: {}, examples: [] };
      routesResult.push(entry);
      if (Date.now() >= deadline) { entry.status = 'budget'; continue; }
      const side = await openPage(browser, { url: entryUrl, viewport: viewports[0], origin, timeoutMs, settleMs });
      let pageScan;
      try {
        if (side.navigationError) { entry.status = 'navigation-failed'; entry.navigationError = side.navigationError; continue; }
        pageScan = await scan(side.page, SCAN_OPTIONS);
        if (unhealthy(side.health, pageScan.overflow)) {
          entry.status = 'baseline-unhealthy';
          entry.healthIssues = { errors: side.health.errors.slice(0, 4), network: side.health.network.slice(0, 4),
            blocked: side.health.blocked.slice(0, 4), leftOrigin: side.health.leftOrigin.slice(0, 4), overflow: pageScan.overflow };
          continue;
        }
      } finally { await closePage(side); }
      entry.status = 'explored';
      const skip = (reason, control) => {
        entry.skipped[reason] = (entry.skipped[reason] ?? 0) + 1;
        if (entry.examples.length < MAX_SKIP_EXAMPLES) entry.examples.push({ control: control ?? null, reason });
      };
      const controls = [...new Map(pageScan.controls.map(control => [control.selector, control])).values()];
      let interactions = 0;
      for (const control of controls) {
        if (points.length >= maxPoints) { skip('limit', control.selector); continue; }
        if (interactions >= MAX_INTERACTIONS_PER_ROUTE) { skip('limit', control.selector); continue; }
        if (Date.now() >= deadline) { skip('budget', control.selector); continue; }
        const outcome = await proposeInteraction(browser, { entryUrl, baselineEntry: baselineUrl, control, viewport: viewports[0], viewports, timeoutMs, settleMs });
        if (outcome.skip) { skip(outcome.skip, control.selector); continue; }
        const point = { id: ids(`${routeSlug(route)}-${slug(control.label) || slug(control.selector) || 'control'}`), title: (outcome.step.action === 'click' ? '点击' : '填写')
          + `「${control.label || control.selector}」`, route, severity: 'high', steps: [outcome.step], assertions: outcome.assertions };
        if (usedSignatures.has(signatureOf(point))) { skip('already-planned', control.selector); continue; }
        usedSignatures.add(signatureOf(point));
        points.push(point);
        interactions++;
        entry.candidates.push({ point, control: control.selector, observed: outcome.observed });
      }
      if (Date.now() < deadline && points.length < maxPoints) {
        const content = await proposeContent(browser, { entryUrl, baselineEntry: baselineUrl, viewports, texts: pageScan.texts, timeoutMs, settleMs });
        for (const item of content) {
          if (points.length >= maxPoints) { skip('limit', item.selector); break; }
          const point = { id: ids(`${routeSlug(route)}-${slug(item.selector) || `text-${points.length}`}`), title: `页面文案「${item.text.slice(0, 30)}」`,
            route, severity: 'medium', assertions: item.assertions };
          if (usedSignatures.has(signatureOf(point))) { skip('already-planned', item.selector); continue; }
          usedSignatures.add(signatureOf(point));
          points.push(point);
          entry.candidates.push({ point, control: item.selector, observed: { text: item.text } });
        }
      } else if (Date.now() >= deadline) skip('budget');
    }
    if (plan) {
      // A plan may declare routes this exploration was not asked to visit; the runner requires every point route to be declared.
      const declared = new Set(plan.routes);
      for (const point of points) if (!declared.has(point.route)) warnings.push(`验收点 ${point.id} 的路由 ${point.route} 不在计划路由中`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
  const skipped = {};
  for (const entry of routesResult) for (const [reason, count] of Object.entries(entry.skipped)) skipped[reason] = (skipped[reason] ?? 0) + count;
  const interactions = points.filter(point => point.steps?.length).length;
  return {
    schemaVersion: EXPLORATION_SCHEMA_VERSION, kind: 'acceptance-exploration', generatedAt: new Date().toISOString(),
    baselineUrl, routes, viewports, plan: plan ? { name: plan.name, points: plan.points?.length ?? 0, routes: plan.routes } : null,
    scope: EXPLORATION_SCOPE,
    summary: { candidates: points.length, interactions, content: points.length - interactions,
      routesExplored: routesResult.filter(entry => entry.status === 'explored').length,
      routesFailed: routesResult.filter(entry => entry.status !== 'explored').length, skipped, durationMs: budgetMs - (deadline - Date.now()) },
    points, routes: routesResult, warnings,
  };
}
