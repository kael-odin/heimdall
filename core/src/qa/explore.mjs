/**
 * qa/explore — 有界交互探索：点一下，看它有没有反应
 *
 * 静态检测能看出页面「长什么样」，看不出「点了会怎样」。这个模块对每个页面
 * 有限地点击控件，用点击前后可观察的变化判断三类问题：
 *
 *   点击无反应   地址、标题、正文、可见元素数、页面高度都没有变化（按钮像装饰）
 *   点击触发异常 点击后新增 pageerror / console error
 *   点击跳到 404 点击后地址变化并返回 4xx/5xx
 *
 * 安全默认（这是工具自身的执行安全，不是对站点的合规限制）：
 *   · 只点 button / a[href] / summary / [role=button|tab|menuitem|switch|checkbox]；
 *   · 跳过表单提交、破坏性文案（删除/退出/支付…）、外链、下载、mailto/tel/javascript；
 *   · 所有写请求仍走站点的只读策略（默认拦截），点击不会真的下单/删除；
 *   · 每个页面最多 N 个控件、整轮有预算，超时就停并如实报告未探索数。
 *
 * 探索会改变页面状态，所以**默认关闭**，由 `qa run --explore` 或 qa.json 的
 * defaults.explore = true 显式开启；结果与静态检测一样进入发现、指纹与裁决记忆。
 */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { BROWSER_PROFILE } from './probe.mjs';

export const EXPLORE_VERSION = 1;

export const EXPLORE_DEFAULTS = Object.freeze({
  enabled: false,
  maxPerPage: 6,
  budgetMs: 60_000,
  settleMs: 1200,
  waitAfterClickMs: 60_000,
});

const CONTROL_SELECTOR = 'button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"]';
const DESTRUCTIVE = /删除|移除|注销|退出|登出|清空|重置|卸载|解绑|取消订阅|支付|付款|下单|购买|delete|remove|log-?out|sign-?out|destroy|reset|unsubscribe|deactivate|purge|purchase|checkout|pay\b/i;
const DOWNLOAD = /\.(pdf|zip|rar|7z|gz|tgz|dmg|exe|msi|apk|ipa|deb|csv|xlsx?|docx?|pptx?|mp4|mov)$/i;
const clip = (v, n = 120) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export const SKIP_REASONS = Object.freeze({
  destructive: '名称像删除、退出、支付等破坏性操作',
  'submit-control': '表单提交控件（提交会发出写请求或离开页面）',
  external: '指向站外地址',
  download: '下载链接',
  'non-web-scheme': 'mailto / tel / javascript: 链接',
  disabled: '控件处于禁用状态',
  hidden: '当前视口不可见',
  'no-stable-selector': '没有稳定的选择器',
  duplicate: '与前面的控件重复',
  'step-failed': '点击动作本身失败（控件被遮挡或已消失）',
  'left-origin': '点击后跳到了站外',
  'budget-exhausted': '超出探索时间预算',
});

/** 在页面里扫描可交互控件与当前快照；选择器优先 id / data-testid / aria-label / name。 */
export function exploreScanInPage({ controlSelector, limit }) {
  const clean = (value, n = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch { return false; } };
  const quote = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const selectorOf = (element) => {
    if (element.id) { const selector = `#${CSS.escape(element.id)}`; if (unique(selector)) return selector; }
    const testId = element.getAttribute('data-testid');
    if (testId) { const selector = `[data-testid="${quote(testId)}"]`; if (unique(selector)) return selector; }
    const label = element.getAttribute('aria-label');
    if (label) { const selector = `${element.tagName.toLowerCase()}[aria-label="${quote(label)}"]`; if (unique(selector)) return selector; }
    const name = element.getAttribute('name');
    if (name && ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(element.tagName)) {
      const selector = `${element.tagName.toLowerCase()}[name="${quote(name)}"]`;
      if (unique(selector)) return selector;
    }
    return null;
  };
  const controls = [];
  const seen = new Set();
  for (const element of document.querySelectorAll(controlSelector)) {
    if (controls.length >= limit) break;
    if (!isVisible(element)) continue;
    const selector = selectorOf(element);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    const inForm = !!element.closest('form');
    controls.push({
      selector,
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      label: clean(element.getAttribute('aria-label') || element.getAttribute('title') || element.innerText || element.textContent),
      href: element.getAttribute('href'),
      target: element.getAttribute('target'),
      download: element.hasAttribute('download'),
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      inForm,
      type: (element.getAttribute('type') || '').toLowerCase(),
    });
  }
  const bodyText = document.body?.innerText ?? '';
  return {
    url: location.href,
    title: document.title,
    controls,
    snapshot: {
      url: location.href,
      title: document.title,
      textLength: bodyText.trim().length,
      textHash: (() => {
        let hash = 0;
        const value = bodyText.replace(/\s+/g, ' ').trim().slice(0, 20000);
        for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
        return hash;
      })(),
      visibleElements: [...document.querySelectorAll('body *')].filter(isVisible).length,
      bodyHeight: Math.round(document.body?.getBoundingClientRect().height ?? 0),
      overlays: [...document.querySelectorAll('body *')].filter(element => {
        const style = getComputedStyle(element);
        return isVisible(element) && (style.position === 'fixed' || style.position === 'sticky')
          && element.getBoundingClientRect().height > 0;
      }).length,
      expanded: [...document.querySelectorAll('[aria-expanded]')].map(element => `${element.id || element.tagName}:${element.getAttribute('aria-expanded')}`).join('|'),
    },
  };
}

/** 点击前后的可观察差异；空数组 = 没看到任何变化。 */
export function diffSnapshots(before = {}, after = {}) {
  const changes = [];
  if (before.url !== after.url) changes.push('url');
  if (before.title !== after.title) changes.push('title');
  if (before.textHash !== after.textHash || Math.abs((before.textLength ?? 0) - (after.textLength ?? 0)) > 8) changes.push('text');
  if ((before.visibleElements ?? 0) !== (after.visibleElements ?? 0)) changes.push('elements');
  if (Math.abs((before.bodyHeight ?? 0) - (after.bodyHeight ?? 0)) > 8) changes.push('height');
  if (before.overlays !== after.overlays) changes.push('overlay');
  if (before.expanded !== after.expanded) changes.push('state');
  return changes;
}

/** 控件是否跳过，以及原因。导出给测试与文档核对。 */
export function skipReason(control, origin) {
  if (control.disabled) return 'disabled';
  if (DESTRUCTIVE.test(control.label ?? '')) return 'destructive';
  if (control.inForm && (control.type === 'submit' || (control.tag === 'button' && (!control.type || control.type === 'submit')))) return 'submit-control';
  if (control.download) return 'download';
  if (control.href == null) return null;
  const href = String(control.href).trim();
  if (/^(mailto|tel|javascript|data):/i.test(href)) return 'non-web-scheme';
  if (DOWNLOAD.test(href.split('?')[0])) return 'download';
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return 'external';
  } catch { return 'non-web-scheme'; }
  if (control.target === '_blank') return 'external';
  return null;
}

/** 用站点的只读策略开一个上下文：写请求拦截，登录档注入，与 probe 一致。 */
async function openContext(browser, { site, login, viewport, health }) {
  const context = await browser.newContext({ ...BROWSER_PROFILE, viewport, serviceWorkers: 'block', acceptDownloads: false, ...login.contextOptions });
  if (login.storage.length) {
    await context.addInitScript((entries) => {
      for (const { origin, items } of entries) {
        if (location.origin !== origin) continue;
        for (const [k, v] of items) { try { localStorage.setItem(k, v); } catch { /* storage disabled */ } }
      }
    }, login.storage);
  }
  await context.route('**/*', async (route) => {
    const request = route.request();
    if (site.writes !== 'allow' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method().toUpperCase())) {
      let path = null;
      try { path = new URL(request.url()).pathname; } catch { /* 按拦截算 */ }
      const allowed = (site.writeAllow ?? []).some(prefix => path && (path === prefix || path.startsWith(prefix)));
      if (!allowed) {
        health.blocked.push({ method: request.method(), url: request.url() });
        return route.abort('blockedbyclient').catch(() => {});
      }
    }
    return route.continue().catch(() => {});
  });
  return context;
}

function watchPage(page, health) {
  page.on('pageerror', error => health.pageErrors.push(clip(error.message, 200)));
  page.on('console', message => { if (message.type() === 'error') health.console.push(clip(message.text(), 200)); });
  page.on('response', response => { if (response.status() >= 400) health.http.push({ status: response.status(), url: response.url() }); });
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
}

const emptyHealth = () => ({ pageErrors: [], console: [], http: [], blocked: [] });

/**
 * 探索一个站点。返回原始发现（未套裁决）。
 * args: { site, login, pages, viewport, maxPerPage, budgetMs, settleMs, browser, onProgress }
 */
export async function exploreSite({ site, login, pages, viewport, maxPerPage = EXPLORE_DEFAULTS.maxPerPage,
  budgetMs = EXPLORE_DEFAULTS.budgetMs, settleMs = EXPLORE_DEFAULTS.settleMs, browser: given, onProgress = () => {} }) {
  const browser = given ?? await chromium.launch({ headless: true });
  const deadline = Date.now() + budgetMs;
  const findings = [];
  const pagesOut = [];
  try {
    for (const target of pages) {
      const pageUrl = new URL(target.path, site.url).href;
      const health = emptyHealth();
      const context = await openContext(browser, { site, login, viewport, health });
      const page = await context.newPage();
      watchPage(page, health);
      const explored = { path: target.path, controls: 0, clicked: 0, skipped: {}, findings: 0, budgetExhausted: false };
      onProgress({ message: `探索 ${target.path}（${viewport.width}px）` });
      try {
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        await page.waitForTimeout(settleMs);
        const scanned = await page.evaluate(exploreScanInPage, { controlSelector: CONTROL_SELECTOR, limit: maxPerPage * 3 });
        explored.controls = scanned.controls.length;
        for (const control of scanned.controls.slice(0, maxPerPage)) {
          if (Date.now() >= deadline) { explored.budgetExhausted = true; break; }
          const reason = skipReason(control, site.origin);
          if (reason) { explored.skipped[reason] = (explored.skipped[reason] ?? 0) + 1; continue; }
          const before = scanned.snapshot;
          const beforeErrors = health.pageErrors.length;
          const beforeHttp = health.http.length;
          let stepError = null;
          try {
            await page.locator(control.selector).first().click({ timeout: 5_000 });
          } catch (error) { stepError = clip(error?.message, 200); }
          if (stepError) {
            explored.skipped['step-failed'] = (explored.skipped['step-failed'] ?? 0) + 1;
          } else {
            await page.waitForTimeout(settleMs);
            const after = await page.evaluate(exploreScanInPage, { controlSelector: CONTROL_SELECTOR, limit: 1 }).then(result => result.snapshot).catch(() => null);
            const changes = after ? diffSnapshots(before, after) : [];
            const newErrors = health.pageErrors.slice(beforeErrors);
            const newHttp = health.http.slice(beforeHttp);
            const new404 = newHttp.find(entry => entry.status >= 400);
            const finalUrl = page.url();
            let leftOrigin = false;
            try { leftOrigin = new URL(finalUrl).origin !== site.origin; } catch { leftOrigin = false; }
            if (leftOrigin) {
              explored.skipped['left-origin'] = (explored.skipped['left-origin'] ?? 0) + 1;
            } else if (newErrors.length) {
              findings.push({
                kind: 'interaction', path: target.path, target: control.selector, match: control.selector,
                title: `点击「${control.label || control.selector}」触发脚本异常`,
                basis: 'failed', tier: 'degrade',
                observed: `点击后出现 ${newErrors.length} 个页面异常：${newErrors[0]}`,
                loss: `访客点「${control.label || '这个控件'}」时页面报错，功能可能没有完成`,
                repro: [`打开 ${target.path}`, `点击 ${control.selector}（${control.label || '无文字'}）`],
                viewport: `${viewport.width}x${viewport.height}`,
                evidence: { url: pageUrl, viewport: `${viewport.width}x${viewport.height}`, steps: [`click ${control.selector}`], errors: newErrors.slice(0, 3) },
              });
            } else if (new404) {
              findings.push({
                kind: 'interaction', path: target.path, target: control.selector, match: control.selector,
                title: `点击「${control.label || control.selector}」后请求返回 ${new404.status}`,
                basis: 'failed', tier: 'degrade',
                observed: `点击后新增 ${newHttp.filter(entry => entry.status >= 400).length} 个失败请求，第一个是 ${new404.url} → ${new404.status}`,
                loss: `访客点「${control.label || '这个控件'}」看到的是错误页或空数据`,
                repro: [`打开 ${target.path}`, `点击 ${control.selector}`, `请求 ${new404.url}`],
                viewport: `${viewport.width}x${viewport.height}`,
                evidence: { url: pageUrl, viewport: `${viewport.width}x${viewport.height}`, steps: [`click ${control.selector}`], status: new404.status, failedUrl: new404.url },
              });
            } else if (!changes.length) {
              findings.push({
                kind: 'interaction', path: target.path, target: control.selector, match: control.selector,
                title: `点击「${control.label || control.selector}」没有反应`,
                basis: 'wrong', tier: 'degrade',
                observed: `点击后地址、标题、正文、可见元素数、页面高度、弹层与展开状态都没有变化（等待 ${settleMs}ms）`,
                loss: `访客点「${control.label || '这个控件'}」以为能操作，页面没有任何反馈`,
                repro: [`打开 ${target.path}`, `点击 ${control.selector}`, `等待 ${settleMs}ms，观察页面是否变化`],
                viewport: `${viewport.width}x${viewport.height}`,
                evidence: { url: pageUrl, viewport: `${viewport.width}x${viewport.height}`, steps: [`click ${control.selector}`], before, after },
              });
            }
            explored.clicked++;
            // 回到原页面，保持每次点击都是独立的一次用户操作
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
            await page.waitForTimeout(Math.min(settleMs, 600));
          }
        }
      } catch (error) {
        explored.error = clip(error?.message, 200);
      } finally {
        explored.findings = findings.filter(f => f.path === target.path).length;
        pagesOut.push(explored);
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }
  } finally {
    if (!given) await browser.close().catch(() => {});
  }
  return { findings, pages: pagesOut, scope: '只探索声明页面里的有限控件；未点击的控件、需要输入后才会变化的状态、写操作之后的流程都不在本次结论内。' };
}
