/**
 * qa/probe — 单站探测：没有参照站也能跑
 *
 * 带登录档打开每个页面，收集执行器能确定的事实，再执行声明式检查点：
 *   健康     控制台错误、页面异常、4xx/5xx、失败请求、被拦下的写请求
 *   页面     坏链（同源 HEAD/GET）、坏图（naturalWidth = 0）、水平溢出、登录过期（跳到登录页或出现登录文案）
 *   检查点   steps（click / fill / press / hover / wait，全部是真实输入事件）+ expect（visible / hidden / text / url / count / attribute / clipboard）
 *
 * 防误报的约束（来自人工复核时推翻过的结论）：
 *   · 点击一律走 Playwright 的真实鼠标事件，不用 element.click()：后者不算用户手势，复制按钮会假失败
 *   · 读剪贴板前先授予 clipboard-read/write 权限；文字从浏览器里读，不经过 shell（避免 GBK 乱码假象）
 *   · 断言 contains 是子串，equals 是全等；断言写错会在报告里显示「断言没对上」而不是「功能坏了」
 *   · 默认拦下所有写请求（POST/PUT/PATCH/DELETE）；站点 writes: allow 全放行，
 *     或 writes: { allow: [路径前缀] } 只放行读语义的 POST（如 /api/xxx/getList）
 */
import { chromium } from 'playwright';
import { scrubSecrets } from './workspace.mjs';
import { detectInPage, readVitalsInPage, DETECT_DEFAULTS, QA_CONTROL_SELECTOR } from './detect.mjs';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const BROWSER_PROFILE = Object.freeze({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', reducedMotion: 'reduce' });
const STEP_ACTIONS = new Set(['click', 'fill', 'press', 'hover', 'wait', 'goto', 'select', 'check']);
const EXPECT_KINDS = new Set(['visible', 'hidden', 'text', 'url', 'count', 'attribute', 'clipboard', 'title']);
const LOGGED_OUT = ['请登录', '登录后', '立即登录', '账号登录', 'Sign in', 'Log in'];
const clip = (v, n = 300) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const fail = (message) => { const e = new Error(message); e.code = 'invalid_args'; throw e; };

export function loginProblem({ site, login, path, finalUrl, facts }) {
  if (!login?.name) return null;
  const configured = String(site.loginPath ?? '').split('?')[0].replace(/\/+$/, '');
  const matchesLogin = value => !!configured && configured !== '/' && (value === configured || value.endsWith(configured));
  let requested = '', final = '';
  try { requested = new URL(path, site.url).pathname.replace(/\/+$/, ''); } catch { /* no path evidence */ }
  try { final = new URL(finalUrl).pathname.replace(/\/+$/, ''); } catch { /* no redirect evidence */ }
  if (matchesLogin(requested)) return null;
  if (matchesLogin(final)) return '页面跳转到了登录入口';
  if (facts?.loggedOut?.length) return `页面出现登录提示：${facts.loggedOut.join('、')}`;
  if (facts?.hasPassword && configured) return '页面出现密码输入框';
  return null;
}

export async function loginProblemAtPage(page, { site, login, path }) {
  if (!login?.name) return null;
  const facts = await page.evaluate((messages) => {
    const text = document.body?.innerText ?? '';
    return { loggedOut: messages.filter(message => text.includes(message)), hasPassword: !!document.querySelector('input[type="password"]') };
  }, site.loggedOutText ?? LOGGED_OUT);
  return loginProblem({ site, login, path, finalUrl: page.url(), facts });
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/token|key|secret|sign|auth|session|code|ticket/i.test(key)) url.searchParams.set(key, '[redacted]');
    return url.href;
  } catch { return '[invalid-url]'; }
}

/** 检查点校验：只接受声明式步骤与断言 */
export function normalizeCheck(raw, index = 0) {
  if (!raw || typeof raw !== 'object') fail(`checks[${index}] 应为对象`);
  const id = String(raw.id ?? `check-${index + 1}`);
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(id)) fail(`检查点 id ${id} 只能用字母、数字、_ . -`);
  const steps = (raw.steps ?? []).slice(0, 20).map((s, i) => {
    if (!STEP_ACTIONS.has(s?.action)) fail(`${id}.steps[${i}].action 只能是 ${[...STEP_ACTIONS].join(' / ')}`);
    if (!['wait', 'goto'].includes(s.action) && typeof s.selector !== 'string') fail(`${id}.steps[${i}] 缺 selector`);
    if (s.action === 'goto' && (typeof s.path !== 'string' || !s.path.startsWith('/'))) fail(`${id}.steps[${i}] goto 要写以 / 开头的 path`);
    if (['fill', 'press', 'select'].includes(s.action) && typeof s.value !== 'string') fail(`${id}.steps[${i}] 缺 value`);
    return { action: s.action, ...(s.selector ? { selector: s.selector } : {}), ...(s.value !== undefined ? { value: String(s.value) } : {}),
      ...(s.path ? { path: s.path } : {}), ...(s.ms ? { ms: Math.min(10_000, Math.max(0, Number(s.ms))) } : {}) };
  });
  const expect = (raw.expect ?? []).slice(0, 20).map((a, i) => {
    if (!EXPECT_KINDS.has(a?.kind)) fail(`${id}.expect[${i}].kind 只能是 ${[...EXPECT_KINDS].join(' / ')}`);
    if (['visible', 'hidden', 'text', 'count', 'attribute'].includes(a.kind) && typeof a.selector !== 'string') fail(`${id}.expect[${i}] 缺 selector`);
    if (a.kind === 'attribute' && typeof a.attribute !== 'string') fail(`${id}.expect[${i}] 缺 attribute`);
    return { kind: a.kind, ...(a.selector ? { selector: a.selector } : {}), ...(a.attribute ? { attribute: a.attribute } : {}),
      ...(a.equals !== undefined ? { equals: a.equals } : {}), ...(a.contains !== undefined ? { contains: String(a.contains) } : {}),
      ...(a.matches ? { matches: String(a.matches) } : {}), ...(a.min !== undefined ? { min: Number(a.min) } : {}), ...(a.max !== undefined ? { max: Number(a.max) } : {}) };
  });
  if (!expect.length) fail(`检查点 ${id} 至少要有一条 expect`);
  const tier = ['wall', 'degrade', 'tolerable'].includes(raw.tier) ? raw.tier : 'degrade';
  return { id, title: clip(raw.title ?? id, 160), path: raw.path ?? '/', steps, expect, tier,
    basis: raw.basis ?? 'failed', ...(raw.loss ? { loss: String(raw.loss) } : {}), ...(raw.prd ? { prd: String(raw.prd) } : {}),
    ...(raw.viewport ? { viewport: raw.viewport } : {}) };
}

function predicate(a, actual) {
  if (a.equals !== undefined) return actual === a.equals || String(actual) === String(a.equals);
  if (a.contains !== undefined) return String(actual ?? '').includes(a.contains);
  if (a.matches) { try { return new RegExp(a.matches).test(String(actual ?? '')); } catch { return false; } }
  if (a.min !== undefined || a.max !== undefined) return Number(actual) >= (a.min ?? -Infinity) && Number(actual) <= (a.max ?? Infinity);
  return actual === true;
}

async function readExpect(page, a, origin) {
  if (a.kind === 'url') { const u = new URL(page.url()); return u.origin === origin ? u.pathname + u.search + u.hash : u.href; }
  if (a.kind === 'title') return page.title();
  if (a.kind === 'clipboard') return page.evaluate(() => navigator.clipboard.readText()).catch(e => `__clipboard_error__ ${e.message}`);
  const loc = page.locator(a.selector);
  if (a.kind === 'count') return loc.count();
  const first = loc.first();
  if (a.kind === 'visible') return first.isVisible().catch(() => false);
  if (a.kind === 'hidden') return !(await first.isVisible().catch(() => false));
  if (!(await loc.count())) return null;
  if (a.kind === 'text') return clip(await first.innerText().catch(() => first.textContent()), 400);
  if (a.kind === 'attribute') return first.getAttribute(a.attribute);
  return null;
}

async function performStep(page, s, baseUrl, timeout) {
  if (s.action === 'wait') return page.waitForTimeout(s.ms ?? 500);
  if (s.action === 'goto') return page.goto(new URL(s.path, baseUrl).href, { waitUntil: 'domcontentloaded', timeout });
  const loc = page.locator(s.selector).first();
  if (s.action === 'click') return loc.click({ timeout });
  if (s.action === 'hover') return loc.hover({ timeout });
  if (s.action === 'fill') return loc.fill(s.value, { timeout });
  if (s.action === 'press') return loc.press(s.value, { timeout });
  if (s.action === 'select') return loc.selectOption(s.value, { timeout });
  if (s.action === 'check') return loc.check({ timeout });
}

/** 页面里一次性收集：坏图、溢出、同源链接、登录文案、可见文字（给设计稿对照用） */
function pageFactsInPage({ loggedOutText }) {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; };
  const root = document.documentElement;
  const overflowPx = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0) - innerWidth;
  let culprit = null;
  if (overflowPx > 2) {
    for (const el of document.body.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.right > innerWidth + 2 && r.width > 0 && getComputedStyle(el).position !== 'fixed') {
        culprit = (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
        break;
      }
    }
  }
  const images = [...document.images].filter(img => img.complete && img.naturalWidth === 0 && visible(img) && img.currentSrc)
    .map(img => ({ src: img.currentSrc, alt: (img.alt ?? '').slice(0, 80) })).slice(0, 30);
  const links = [...document.querySelectorAll('a[href]')].filter(visible)
    .map(a => ({ href: a.href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 60) }))
    .filter(l => /^https?:/.test(l.href)).slice(0, 400);
  const bodyText = (document.body?.innerText ?? '').slice(0, 200_000);
  const loggedOut = loggedOutText.filter(t => bodyText.includes(t));
  const hasPassword = !!document.querySelector('input[type="password"]');
  const texts = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,span,a,button,label,td,th,dt,dd')]
    .filter(el => visible(el) && el.children.length <= 2)
    .map(el => (el.innerText ?? '').replace(/\s+/g, ' ').trim()).filter(t => t.length >= 2 && t.length <= 200);
  return { overflowPx, culprit, images, links, loggedOut, hasPassword, texts: [...new Set(texts)].slice(0, 1500), title: document.title };
}

async function openContext(browser, { login, viewport, origin, writes, writeAllow, health }) {
  const context = await browser.newContext({ ...BROWSER_PROFILE, viewport, serviceWorkers: 'block', acceptDownloads: false, ...login.contextOptions });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {});
  if (login.storage.length) {
    await context.addInitScript((entries) => {
      for (const { origin, items } of entries) {
        if (location.origin !== origin) continue;
        for (const [k, v] of items) { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } }
      }
    }, login.storage);
  }
  await context.route('**/*', async (route) => {
    const req = route.request();
    if (writes !== 'allow' && !READ_METHODS.has(req.method().toUpperCase())) {
      // writeAllow：读语义 POST 的路径前缀白名单（如 /api/xxx/getList）；前缀匹配 pathname
      let path = null;
      try { path = new URL(req.url()).pathname; } catch { /* 解析不了就按拦截算 */ }
      if (!path || !(writeAllow ?? []).some(p => path === p || path.startsWith(p))) {
        health.blocked.push({ method: req.method(), url: safeUrl(req.url()) });
        return route.abort('blockedbyclient').catch(() => {});
      }
    }
    return route.continue().catch(() => {});
  });
  return context;
}

function watch(page, health, origin) {
  page.on('console', m => { if (m.type() === 'error') health.console.push(clip(m.text())); });
  page.on('pageerror', e => health.pageErrors.push(clip(e.message)));
  page.on('response', r => {
    if (r.status() >= 400) health.http.push({ status: r.status(), url: safeUrl(r.url()), sameOrigin: r.url().startsWith(origin), type: r.request().resourceType() });
  });
  page.on('requestfailed', req => {
    const why = req.failure()?.errorText ?? '';
    if (READ_METHODS.has(req.method().toUpperCase()) && !/blockedbyclient|ERR_ABORTED/i.test(why)) health.failed.push({ url: safeUrl(req.url()), why: clip(why, 80) });
  });
  page.on('dialog', d => d.dismiss().catch(() => {}));
}

async function checkLinks(context, links, origin, { limit = 60, timeout = 8000 } = {}) {
  const seen = new Map();
  for (const l of links) {
    let u;
    try { u = new URL(l.href); } catch { continue; }
    if (u.origin !== origin) continue;
    u.hash = '';
    if (!seen.has(u.href)) seen.set(u.href, l.text);
    if (seen.size >= limit) break;
  }
  const broken = [];
  for (const [href, text] of seen) {
    let res = await context.request.head(href, { timeout, maxRedirects: 5 }).catch(() => null);
    if (!res || res.status() === 405 || res.status() === 501) res = await context.request.get(href, { timeout, maxRedirects: 5 }).catch(() => null);
    if (!res) broken.push({ href: safeUrl(href), text, status: 0 });
    else if (res.status() >= 400) broken.push({ href: safeUrl(href), text, status: res.status() });
  }
  return { checked: seen.size, broken };
}
const emptyHealth = () => ({ console: [], pageErrors: [], http: [], failed: [], blocked: [] });

/**
 * 跑一遍无参照物检测：先读 Web Vitals，再把检测器注入页面执行。
 * 任何一步失败都只返回空数组——检测是增强，不能把一次探测拖垮。
 */
async function runDetectors(page, { viewport, loginName, options }) {
  try { await page.evaluate(readVitalsInPage); } catch { /* 老页面/被 CSP 拦截时不读 */ }
  const named = [];
  let useBrowserNames = true;
  try {
    for (const role of ['button', 'link', 'tab', 'menuitem']) {
      const matches = page.getByRole(role, { name: /\S/ }).and(page.locator(QA_CONTROL_SELECTOR));
      named.push(...await matches.elementHandles());
    }
  } catch { useBrowserNames = false; }
  const detectOptions = {
    viewportWidth: viewport.width,
    mobile: viewport.width < 600,
    maskSelectors: options.maskSelectors ?? [],
    thresholds: options.thresholds ?? {},
    loginProfile: loginName ?? null,
    maxPerDetector: options.maxPerDetector ?? DETECT_DEFAULTS.maxPerDetector,
    controlSelector: QA_CONTROL_SELECTOR,
  };
  try {
    let raw;
    try { raw = await page.evaluate(detectInPage, { ...detectOptions, namedControls: useBrowserNames ? named : null }); }
    catch { raw = await page.evaluate(detectInPage, detectOptions); }
    if (!Array.isArray(raw)) throw new Error('invalid detector result');
    return { detections: raw, error: null };
  } catch { return { detections: [], error: 'detector-failed' }; }
  finally { await Promise.all(named.map(handle => handle.dispose().catch(() => {}))); }
}

/** 检测器的原始结果 → 统一发现形状（path / 证据 / 视口在调用方补齐） */
function findingFromDetection(detected, { path, pageUrl, viewport, screenshot }) {
  return {
    kind: detected.kind, path, title: detected.title, target: detected.target, match: detected.title,
    basis: detected.basis, tier: detected.tier,
    ...(detected.loss ? { loss: detected.loss } : {}),
    observed: detected.observed,
    ...(detected.repro ? { repro: detected.repro } : {}),
    viewport: detected.viewport ?? `${viewport.width}x${viewport.height}`,
    confidence: 'observed',
    detector: detected.detector,
    evidence: { url: safeUrl(pageUrl), viewport: `${viewport.width}x${viewport.height}`, detector: detected.detector,
      ...(detected.evidence?.count ? { count: detected.evidence.count } : {}), ...(screenshot ? { screenshot } : {}) },
  };
}

/** 把一页的事实翻译成发现（检查器产出：observed 级证据，tier 保守） */
function findingsForPage({ site, pageUrl, path, health, facts, links, loginInfo, viewport, navError, screenshot, loginIssue }) {
  const out = [];
  const ev = (extra = {}) => ({ url: safeUrl(pageUrl), viewport: `${viewport.width}x${viewport.height}`, ...(screenshot ? { screenshot } : {}), ...extra });
  if (navError) out.push({ kind: 'navigation', path, title: `页面打不开：${navError}`, target: path, basis: 'failed', tier: 'wall', loss: '访客打开这个地址看不到页面', observed: navError, evidence: ev() });
  const login = loginInfo?.name ? { profile: loginInfo.name } : null;
  if (login && loginIssue) {
    out.push({ kind: 'login-expired', path, title: '登录档没生效或已过期，页面要求重新登录', target: login.profile, basis: 'failed', tier: 'wall',
      observed: loginIssue, evidence: ev({ login: login.profile, expiresAt: loginInfo.expiresAt }),
      note: '这是测试环境问题，不是产品问题：重新登录后再跑' });
    return out;
  }
  for (const msg of health.pageErrors.slice(0, 5)) out.push({ kind: 'console', path, title: `页面脚本异常：${clip(msg, 90)}`, target: 'pageerror', match: msg, basis: 'failed', tier: 'tolerable', observed: msg, evidence: ev() });
  // 浏览器给每个 4xx/5xx 自动打一条 "Failed to load resource"，网络记录已经覆盖，再报一次就是重复
  const consoleMsgs = [...new Set(health.console)].filter(msg => !(health.http.length && /^Failed to load resource: the server responded with a status of \d{3}/.test(msg)));
  for (const msg of consoleMsgs.slice(0, 5)) out.push({ kind: 'console', path, title: `控制台报错：${clip(msg, 90)}`, target: 'console', match: msg, basis: 'friction', tier: 'tolerable', observed: msg, evidence: ev() });
  const brokenImages = new Set((facts?.images ?? []).map(img => img.src.split('?')[0]));
  const seenHttp = new Set();
  for (const r of health.http) {
    const key = `${r.status} ${r.url.split('?')[0]}`;
    if (seenHttp.has(key) || (r.type === 'image' && brokenImages.has(r.url.split('?')[0]))) continue;
    seenHttp.add(key);
    if (seenHttp.size > 8) break;
    const isDoc = r.type === 'document';
    out.push({ kind: 'network', path, title: `${r.type === 'xhr' || r.type === 'fetch' ? '接口' : '资源'}返回 ${r.status}：${r.url.split('?')[0].slice(-80)}`,
      target: r.url.split('?')[0], basis: r.status >= 500 ? 'failed' : 'wrong', tier: isDoc ? 'wall' : 'tolerable', observed: key, evidence: ev({ status: r.status, type: r.type }) });
  }
  for (const f of health.failed.slice(0, 5)) out.push({ kind: 'network', path, title: `请求失败：${f.url.split('?')[0].slice(-80)}`, target: f.url.split('?')[0], basis: 'failed', tier: 'tolerable', observed: f.why, evidence: ev() });
  for (const b of links?.broken ?? []) out.push({ kind: 'broken-link', path, title: `链接打不开（${b.status || '无响应'}）：「${b.text || b.href.slice(-40)}」`,
    target: b.href.split('?')[0], basis: 'failed', tier: 'degrade', loss: `访客点「${b.text || '这个链接'}」到达错误页`, observed: `${b.status} ${b.href}`, evidence: ev() });
  for (const img of facts?.images ?? []) out.push({ kind: 'broken-image', path, title: `图片没加载出来：${img.alt || img.src.split('/').pop().slice(0, 60)}`, target: img.src.split('?')[0], basis: 'cosmetic', tier: 'tolerable', observed: img.src, evidence: ev() });
  if (facts && facts.overflowPx > 2) out.push({ kind: 'overflow', path, title: `横向溢出 ${Math.round(facts.overflowPx)}px（${viewport.width} 宽）`, target: facts.culprit ?? 'body',
    basis: viewport.width < 500 ? 'friction' : 'cosmetic', tier: 'tolerable', observed: `最先越界的元素：${facts.culprit ?? '未定位'}`, viewport: `${viewport.width}x${viewport.height}`, evidence: ev() });
  for (const b of health.blocked.slice(0, 3)) out.push({ kind: 'blocked-write', path, title: `打开页面就发了写请求，已拦下：${b.method} ${b.url.split('?')[0].slice(-60)}`, target: b.url.split('?')[0], basis: 'friction', tier: 'tolerable', observed: `${b.method} ${b.url}`, evidence: ev(), note: '只读探测拦下所有写请求；如果这是正常埋点，用裁决记一条「设计如此」' });
  return out;
}

async function runCheck(context, site, check, { timeout, settleMs, screenshotDir, shoot, login }) {
  const health = emptyHealth();
  const page = await context.newPage();
  watch(page, health, site.origin);
  const startUrl = new URL(check.path, site.url).href;
  const results = [];
  let error = null;
  let loginIssue = null;
  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout });
    await page.waitForTimeout(settleMs);
    loginIssue = await loginProblemAtPage(page, { site, login, path: check.path });
    if (!loginIssue) {
      for (const s of check.steps) {
        await performStep(page, s, site.url, Math.min(timeout, 10_000));
        await page.waitForTimeout(Math.min(settleMs, 800));
        loginIssue = await loginProblemAtPage(page, { site, login, path: check.path });
        if (loginIssue) break;
      }
      if (!loginIssue) {
        for (const a of check.expect) {
          const actual = await readExpect(page, a, site.origin);
          results.push({ ...a, actual: typeof actual === 'string' ? clip(actual, 300) : actual, pass: predicate(a, actual) });
        }
      }
    }
  } catch (e) { error = clip(e.message, 300); }
  const failed = error || loginIssue || results.some(r => !r.pass);
  const shot = failed && shoot ? await shoot(page, `check-${check.id}`) : null;
  await page.close().catch(() => {});
  return { id: check.id, title: check.title, path: check.path, pass: !failed, error, results, screenshot: shot, health,
    ...(loginIssue ? { blockedReason: 'login-expired', loginIssue } : {}) };
}

/**
 * 探测一个站点。返回 { pages: [...], checks: [...], findings: [原始发现] }。
 * 原始发现还没套裁决；run.mjs 负责指纹、裁决和报告。
 */
export async function probeSite({ site, login, pages, checks = [], viewports, settleMs = 1500, timeoutMs = 30_000, linkCheck = true, linkLimit = 60, collectTexts = false, detect = true, detectOptions = {}, shoot, browser: given, headless = true, onProgress = () => {} }) {
  const browser = given ?? await chromium.launch({ headless });
  const loggedOutText = site.loggedOutText ?? LOGGED_OUT;
  const out = { pages: [], checks: [], findings: [], texts: {} };
  try {
    for (const viewport of viewports) {
      for (const p of pages) {
        const health = emptyHealth();
        const context = await openContext(browser, { login, viewport, origin: site.origin, writes: site.writes, writeAllow: site.writeAllow, health });
        const page = await context.newPage();
        watch(page, health, site.origin);
        const pageUrl = new URL(p.path, site.url).href;
        let navError = null, facts = null, links = null, detected = [], loginIssue = null, detectorError = null;
        onProgress({ message: `打开 ${p.path}（${viewport.width}px）` });
        try {
          const res = await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
          if (!res) navError = '无响应';
          else if (res.status() >= 400) navError = `HTTP ${res.status()}`;
          await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 10_000) }).catch(() => {});
          await page.waitForTimeout(settleMs);
          facts = await page.evaluate(pageFactsInPage, { loggedOutText });
          facts.images = facts.images.map(img => ({ ...img, src: safeUrl(img.src) }));
          loginIssue = loginProblem({ site, login, path: p.path, finalUrl: page.url(), facts });
          if (linkCheck && !loginIssue && viewport === viewports[0]) links = await checkLinks(context, facts.links, site.origin, { limit: linkLimit });
          if (detect && !navError && !loginIssue) {
            const result = await runDetectors(page, { viewport, loginName: login?.name, options: detectOptions });
            detected = result.detections;
            detectorError = result.error;
          }
        } catch (e) { navError = navError ?? clip(e.message, 200); }
        const screenshot = shoot ? await shoot(page, `page-${p.path}-${viewport.width}`) : null;
        const finalUrl = page.url();
        await context.close().catch(() => {});
        out.pages.push({ path: p.path, name: p.name ?? null, url: safeUrl(pageUrl), finalUrl: safeUrl(finalUrl), viewport, navError, title: facts?.title ?? null,
          ...(loginIssue ? { unavailableReason: 'login-expired' } : {}), ...(detectorError ? { detectorError } : {}),
          counts: { console: health.console.length, pageErrors: health.pageErrors.length, http: health.http.length, failed: health.failed.length, blocked: health.blocked.length,
            brokenImages: facts?.images?.length ?? 0, brokenLinks: links?.broken?.length ?? 0, linksChecked: links?.checked ?? 0,
            detected: detected.length, detectors: [...new Set(detected.map(d => d.detector))] },
          overflowPx: facts?.overflowPx ?? null, screenshot });
        if (collectTexts && facts && !loginIssue && viewport === viewports[0]) out.texts[p.path] = facts.texts;
        out.findings.push(...findingsForPage({ site, pageUrl, path: p.path, health, facts, links, loginInfo: login, viewport, navError, screenshot, loginIssue }));
        out.findings.push(...detected.map(d => findingFromDetection(d, { path: p.path, pageUrl, viewport, screenshot })));
      }
    }
    for (const check of checks) {
      const viewport = check.viewport ?? viewports[0];
      const health = emptyHealth();
      const context = await openContext(browser, { login, viewport, origin: site.origin, writes: site.writes, writeAllow: site.writeAllow, health });
      onProgress({ message: `检查点 ${check.id}` });
      const r = await runCheck(context, site, check, { timeout: timeoutMs, settleMs, shoot, login });
      await context.close().catch(() => {});
      out.checks.push(r);
      if (r.blockedReason === 'login-expired') {
        out.findings.push(...findingsForPage({ site, pageUrl: new URL(check.path, site.url).href, path: check.path, health, facts: null,
          links: null, loginInfo: login, viewport, navError: null, screenshot: r.screenshot, loginIssue: r.loginIssue }));
      } else if (!r.pass) {
        const failedExpect = r.results.filter(x => !x.pass);
        out.findings.push({ kind: 'assertion', path: check.path, title: check.title, target: check.id, match: check.id,
          basis: check.basis, tier: check.tier, ...(check.loss ? { loss: check.loss } : {}), ...(check.prd ? { prd: check.prd } : {}),
          expected: failedExpect.map(x => `${x.kind}${x.selector ? ' ' + x.selector : ''} ${x.equals !== undefined ? '= ' + x.equals : x.contains !== undefined ? '含 ' + x.contains : x.matches ? '~ ' + x.matches : ''}`).join('；') || null,
          observed: r.error ? `执行出错：${r.error}` : failedExpect.map(x => `${x.kind} 实际：${JSON.stringify(x.actual)}`).join('；'),
          repro: [`打开 ${check.path}`, ...check.steps.map(s => `${s.action} ${s.selector ?? s.path ?? ''}${s.value ? ' ' + s.value : ''}`)],
          confidence: r.error ? 'check-error' : 'observed',
          evidence: { url: safeUrl(new URL(check.path, site.url).href), viewport: `${viewport.width}x${viewport.height}`, ...(r.screenshot ? { screenshot: r.screenshot } : {}) } });
      }
    }
  } finally {
    if (!given) await browser.close().catch(() => {});
  }
  if (login?.secrets?.length) {
    const scrub = (v) => scrubSecrets(v, login.secrets);
    out.findings = out.findings.map(f => JSON.parse(scrub(JSON.stringify(f))));
  }
  return out;
}
