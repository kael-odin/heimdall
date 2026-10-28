/**
 * Post-run element localization for browser acceptance.
 *
 * A finished run says *that* a check failed; this module says *where*. It re-renders the
 * pages behind each reliable failure (verdict `bug`) under the runner's read-only browser
 * profile and turns check evidence into element- and source-level findings: the element,
 * the CSS rule / script line / HTML tag responsible, and how it differs from the baseline.
 *
 * It never changes a verdict and writes nothing into the run; callers keep the result as a
 * sidecar (`localization.json`). It sits outside the verifier fingerprint on purpose, so the
 * runner and report modules must not import it.
 *
 * Positions are 1-based line/column in the served resource: the HTML document for inline
 * styles and scripts, otherwise the stylesheet or script itself.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import { resolveAcceptanceUrl } from './urls.mjs';
import { DEFAULT_VIEWPORTS } from './schema.mjs';

export const LOCALIZATION_SCHEMA_VERSION = 1;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Same profile as the runner, so a re-render sees what the run saw.
const BROWSER_PROFILE = Object.freeze({ locale: 'zh-CN', timezoneId: 'Asia/Hong_Kong', colorScheme: 'light', reducedMotion: 'reduce' });
const RUN_BUDGET_MS = 180_000;
const MAX_FINDINGS = 8;
const MAX_SOURCE_CHARS = 2_000_000;
// Authored-looking computed properties. Width/height are layout results, so size changes are read from boxes instead.
const STYLE_PROPS = ['display', 'visibility', 'opacity', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'transform', 'float',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'gap', 'grid-template-columns',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-top-left-radius', 'box-shadow',
  'background-color', 'background-image', 'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
  'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform', 'white-space', 'overflow-x', 'overflow-y',
  'min-width', 'max-width', 'min-height', 'max-height'];
const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-transform', 'white-space', 'visibility']);
const FAMILIES = {
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  'border-width': ['border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width'],
  'border-color': ['border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
};
const CONTROL_FIELDS = ['tag', 'role', 'label', 'type', 'href', 'disabled', 'expanded', 'selected'];
const FIELD_ATTRIBUTE = { href: 'href', expanded: 'aria-expanded', selected: 'aria-selected', type: 'type', role: 'role', label: 'aria-label', disabled: 'disabled' };
const FIELD_NAMES = { tag: '标签', role: 'role', label: '可访问名称', type: 'type', href: '链接', disabled: '禁用状态', expanded: '展开状态', selected: '选中状态' };

const clip = (value, size = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);
const at = (line0, column0) => ({ line: line0 + 1, column: column0 + 1 });
const bounded = (value, fallback, min, max) => Math.min(max, Math.max(min, Number(value) || fallback));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = value => value === null || value === undefined ? '无' : `「${clip(value, 80)}」`;
const inside = (root, path) => { const rel = relative(root, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const safeUrl = value => {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of url.searchParams.keys()) url.searchParams.set(key, '[redacted]');
    return url.href;
  } catch { return value ? '[invalid-url]' : null; }
};
const pathOfUrl = value => { try { return new URL(value).pathname; } catch { return String(value ?? ''); } };
/** Compact `file:line:column` for summaries. */
export const whereText = source => source?.line ? `${source.file ?? pathOfUrl(source.url)}:${source.line}:${source.column}`
  : source?.origin === 'user-agent' ? '浏览器默认样式' : '未知位置';

function linesOf(side, url) {
  if (!side.lines.has(url)) side.lines.set(url, side.sources.get(url)?.split('\n') ?? null);
  return side.lines.get(url);
}
function excerptOf(lines, line0, column0) {
  const line = lines?.[line0];
  if (line === undefined) return null;
  const start = Math.max(0, column0 - 40);
  return `${start > 0 ? '…' : ''}${line.slice(start, column0 + 120).trim()}${column0 + 120 < line.length ? '…' : ''}`;
}
function locationIn(side, url, line0, column0, kind) {
  if (!url || !Number.isInteger(line0)) return null;
  return { kind, url: safeUrl(url), ...at(line0, column0 ?? 0), excerpt: excerptOf(linesOf(side, url), line0, column0 ?? 0) };
}
function positionInText(side, url, index, kind) {
  const text = side.sources.get(url);
  const before = text.slice(0, index);
  const newline = before.lastIndexOf('\n');
  const line0 = before.split('\n').length - 1;
  return { ...locationIn(side, url, line0, index - newline - 1, kind), match: 'text-search' };
}
/** Where the served HTML declares an element (and, optionally, one of its attributes). SPA-rendered nodes have none. */
function locateElementSource(side, element, attribute = null) {
  const url = side.documentUrl;
  const text = side.sources.get(url);
  if (!text || !element?.exists) return null;
  let start = -1;
  const id = element.attributes?.id;
  if (id) for (const needle of [`id="${id}"`, `id='${id}'`, `id=${id}`]) {
    const index = text.indexOf(needle);
    if (index >= 0) { start = text.lastIndexOf('<', index); break; }
  }
  if (start < 0 && element.html) start = text.indexOf(element.html);
  if (start < 0 && attribute && element.attributes?.[attribute] !== undefined) {
    // A bare attribute match is only trusted when it is unique in the document.
    const needle = `${attribute}="${element.attributes[attribute]}"`;
    const index = text.indexOf(needle);
    if (index >= 0 && index === text.lastIndexOf(needle)) start = text.lastIndexOf('<', index);
  }
  if (start < 0) return null;
  let index = start;
  if (attribute) {
    const found = text.slice(start, text.indexOf('>', start)).search(new RegExp(`\\s${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s=>]`));
    if (found >= 0) index = start + found + 1;
  }
  return positionInText(side, url, index, 'document');
}
/** Fresh read-only context with the CDP domains needed to map runtime facts back to source. */
async function openSide(browser, { url, viewport, timeoutMs, settleMs }) {
  const side = { url: safeUrl(url), documentUrl: null, httpStatus: null, navigationError: null, timeoutMs, settleMs,
    sources: new Map(), lines: new Map(), sheets: new Map(), sheetText: new Map(), scripts: new Map(), scriptText: new Map(),
    requests: new Map(), exceptions: [], consoleCalls: [], logEntries: [], blocked: [], pending: [] };
  side.context = await browser.newContext({ ...BROWSER_PROFILE, viewport: { width: viewport.width, height: viewport.height },
    serviceWorkers: 'block', acceptDownloads: false });
  try { await instrument(side, url); }
  catch (error) { await closeSide(side); throw error; }
  return side;
}
async function instrument(side, url) {
  const { context, timeoutMs, settleMs } = side;
  context.setDefaultTimeout(timeoutMs);
  await context.route('**/*', async route => {
    const request = route.request();
    if (READ_METHODS.has(request.method().toUpperCase())) return route.continue().catch(() => {});
    side.blocked.push({ method: request.method(), url: safeUrl(request.url()) });
    await route.abort('blockedbyclient').catch(() => {});
  });
  if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => socket.close());
  const page = side.page = await context.newPage();
  page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
  page.on('popup', popup => popup.close().catch(() => {}));
  const cdp = side.cdp = await context.newCDPSession(page);
  cdp.on('CSS.styleSheetAdded', ({ header }) => side.sheets.set(header.styleSheetId, header));
  cdp.on('Debugger.scriptParsed', event => side.scripts.set(event.scriptId, { url: event.url }));
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => side.exceptions.push(exceptionDetails));
  cdp.on('Runtime.consoleAPICalled', event => { if (['error', 'assert'].includes(event.type)) side.consoleCalls.push(event); });
  cdp.on('Log.entryAdded', ({ entry }) => { if (entry.level === 'error') side.logEntries.push(entry); });
  cdp.on('Network.requestWillBeSent', event => side.requests.set(event.requestId, { url: event.request.url, method: event.request.method,
    type: event.type ?? null, initiator: event.initiator, status: null, failure: null }));
  cdp.on('Network.responseReceived', event => { const request = side.requests.get(event.requestId); if (request) request.status = event.response.status; });
  cdp.on('Network.loadingFailed', event => { const request = side.requests.get(event.requestId); if (request) request.failure = event.errorText; });
  // DOM must be enabled before CSS; Debugger only maps script IDs to URLs and never pauses.
  for (const domain of ['Runtime', 'Log', 'Network', 'DOM', 'CSS', 'Debugger']) await cdp.send(`${domain}.enable`);
  await cdp.send('Debugger.setSkipAllPauses', { skip: true });
  // Keep the served HTML of every main-frame document, including ones a replayed step navigates to.
  page.on('response', response => {
    if (!response.request().isNavigationRequest() || response.frame() !== page.mainFrame()) return;
    side.pending.push(response.text().then(text => { side.sources.set(response.url(), text.slice(0, MAX_SOURCE_CHARS)); side.lines.delete(response.url()); }, () => {}));
  });
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) side.documentUrl = frame.url(); });
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    side.httpStatus = response?.status() ?? null;
    side.documentUrl = response?.url() ?? page.url();
    await page.waitForTimeout(settleMs);
    await settled(side);
  } catch (error) { side.navigationError = clip(error?.message); }
}
// Document bodies normally arrive with the page; a stalled stream must not hold localization up.
const settled = side => Promise.race([Promise.all(side.pending.splice(0)), new Promise(done => setTimeout(done, side.timeoutMs).unref())]);
const closeSide = async side => { await side?.context?.close().catch(() => {}); };

async function nodeIdOf(side, selector) {
  try {
    const { root } = await side.cdp.send('DOM.getDocument', { depth: 0 });
    const { nodeId } = await side.cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    return nodeId || null;
  } catch { return null; }
}
async function matchedStylesOf(side, selector) {
  const nodeId = await nodeIdOf(side, selector);
  if (!nodeId) return null;
  try { return await side.cdp.send('CSS.getMatchedStylesForNode', { nodeId }); } catch { return null; }
}
async function sheetLines(side, styleSheetId) {
  if (!side.sheetText.has(styleSheetId)) {
    const text = await side.cdp.send('CSS.getStyleSheetText', { styleSheetId }).then(result => result.text, () => null);
    side.sheetText.set(styleSheetId, text?.slice(0, MAX_SOURCE_CHARS).split('\n') ?? null);
  }
  return side.sheetText.get(styleSheetId);
}
async function scriptLines(side, scriptId) {
  if (!scriptId) return null;
  if (!side.scriptText.has(scriptId)) {
    const text = await side.cdp.send('Debugger.getScriptSource', { scriptId }).then(result => result.scriptSource, () => null);
    side.scriptText.set(scriptId, text?.slice(0, MAX_SOURCE_CHARS).split('\n') ?? null);
  }
  return side.scriptText.get(scriptId);
}
/** Script position; inline scripts report document-relative coordinates. */
async function scriptAt(side, { url, scriptId, lineNumber, columnNumber, functionName }) {
  if (!Number.isInteger(lineNumber)) return null;
  url ||= side.scripts.get(scriptId)?.url || null;
  const inline = !!url && url === side.documentUrl;
  const lines = (inline ? linesOf(side, url) : null) ?? await scriptLines(side, scriptId);
  return { kind: inline ? 'inline-script' : 'script', url: safeUrl(url), ...at(lineNumber, columnNumber ?? 0),
    excerpt: excerptOf(lines, lineNumber, columnNumber ?? 0), ...(functionName ? { function: functionName } : {}) };
}
/**
 * Runs in the page, so it must stay self-contained. `selectors` describes named elements;
 * `scan` lists the visible layout keyed by a stable path (id-anchored, else nth-of-type).
 * `pathOf` mirrors the runner's semantic snapshot so check selectors resolve the same way.
 */
function inspectInPage({ selectors = [], scan = false, overflow = false, maskSelectors = [], styleProps = [], limit = 600, entryUrl = null }) {
  const clean = (value, size = 120) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);
  // Baseline and target live under different entry paths; resource URLs are compared relative to their entry.
  let entry = null;
  try { entry = entryUrl ? new URL(entryUrl) : null; } catch { entry = null; }
  const prefix = entry ? entry.pathname.replace(/\/$/, '') : '';
  const entryText = entry ? entry.origin + prefix : null;
  const relativeUrl = value => {
    if (!value) return null;
    try {
      const url = new URL(value, location.href);
      if (!entry) return url.href;
      if (url.origin !== entry.origin) return url.origin + url.pathname;
      return prefix && (url.pathname === prefix || url.pathname.startsWith(prefix + '/')) ? url.pathname.slice(prefix.length) || '/' : url.pathname;
    } catch { return value; }
  };
  const normalized = value => entryText && value.includes(entryText) ? value.replaceAll(entryText, '[entry]') : value;
  const masked = element => maskSelectors.some(selector => { try { return !!element.closest(selector); } catch { return false; } });
  const nth = element => {
    const siblings = [...element.parentElement.children].filter(child => child.tagName === element.tagName);
    return `${element.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(element) + 1})`;
  };
  const pathOf = element => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    for (let current = element; current?.parentElement && parts.length < 6; current = current.parentElement) parts.unshift(nth(current));
    return parts.join(' > ');
  };
  const keys = new Map();
  const keyOf = element => {
    if (element === document.body) return 'body';
    if (keys.has(element)) return keys.get(element);
    const unique = element.id && document.querySelectorAll(`#${CSS.escape(element.id)}`).length === 1;
    const key = unique ? `#${CSS.escape(element.id)}` : element.parentElement && element.parentElement !== document.documentElement
      ? `${keyOf(element.parentElement)} > ${nth(element)}` : element.tagName.toLowerCase();
    keys.set(element, key);
    return key;
  };
  const labelOf = element => element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '')
    + [...element.classList].slice(0, 2).map(name => `.${name}`).join('');
  const boxOf = element => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left + scrollX), y: Math.round(rect.top + scrollY), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const styleOf = element => {
    const css = getComputedStyle(element);
    return Object.fromEntries(styleProps.map(name => [name, normalized(css.getPropertyValue(name))]));
  };
  const ownText = element => clean([...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join(' '), 80);
  const isVisible = element => {
    const rect = element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && css.display !== 'none' && css.visibility !== 'hidden';
  };
  const hiddenCause = element => {
    const cause = (node, property, value) => ({ selector: keyOf(node), label: labelOf(node), self: node === element, property, value,
      hiddenAttribute: node.hasAttribute('hidden') });
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const css = getComputedStyle(node);
      if (css.display === 'none') return cause(node, 'display', 'none');
      if (css.opacity === '0') return cause(node, 'opacity', '0');
    }
    const hidden = node => ['hidden', 'collapse'].includes(getComputedStyle(node).visibility);
    if (hidden(element)) {
      let node = element;
      while (node.parentElement && hidden(node.parentElement)) node = node.parentElement;
      return cause(node, 'visibility', getComputedStyle(node).visibility);
    }
    const rect = element.getBoundingClientRect();
    return cause(element, rect.width ? 'height' : 'width', '0px');
  };
  const describe = selector => {
    let element = null;
    try { element = document.querySelector(selector); } catch { return { selector, exists: false, invalidSelector: true }; }
    if (!element) return { selector, exists: false };
    const visible = isVisible(element);
    const outer = element.outerHTML;
    const ancestors = [];
    for (let node = element.parentElement; node && node !== document.documentElement && ancestors.length < 8; node = node.parentElement) ancestors.push(keyOf(node));
    const previous = element.previousElementSibling;
    return { selector, exists: true, key: keyOf(element), path: pathOf(element), label: labelOf(element), tag: element.tagName.toLowerCase(),
      visible, box: boxOf(element), text: clean(element.innerText ?? element.textContent, 200),
      attributes: Object.fromEntries([...element.attributes].slice(0, 24).map(attribute => [attribute.name, attribute.value.slice(0, 300)])),
      html: outer.slice(0, outer.indexOf('>') + 1).slice(0, 400), style: styleOf(element), hiddenBy: visible ? null : hiddenCause(element),
      ancestors, previous: previous ? { key: keyOf(previous), label: labelOf(previous) } : null };
  };
  const result = { url: location.href, viewport: { width: innerWidth, height: innerHeight }, elements: selectors.map(describe) };
  if (scan) {
    const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'BR', 'WBR']);
    result.layout = [];
    for (const element of [document.body, ...(document.body?.querySelectorAll('*') ?? [])]) {
      if (!element || result.layout.length >= limit) break;
      if (skip.has(element.tagName) || masked(element) || !isVisible(element)) continue;
      result.layout.push({ key: keyOf(element), parent: element === document.body ? null : keyOf(element.parentElement),
        label: labelOf(element), box: boxOf(element), style: styleOf(element), text: ownText(element),
        ...(element.hasAttribute('src') ? { src: relativeUrl(element.currentSrc || element.getAttribute('src')) } : {}) });
    }
    result.layoutCapped = result.layout.length >= limit;
  }
  if (overflow) {
    // Topmost elements past the viewport edge; descendants of an overflowing element only follow it.
    const outside = element => { const rect = element.getBoundingClientRect(); return rect.right > innerWidth + 2 || rect.left < -2; };
    result.overflowing = [...(document.body?.querySelectorAll('*') ?? [])].filter(element => isVisible(element) && !masked(element) && outside(element)
      && !(element.parentElement && element.parentElement !== document.body && outside(element.parentElement)))
      .slice(0, 6).map(element => ({ key: keyOf(element), label: labelOf(element), box: boxOf(element),
        right: Math.round(element.getBoundingClientRect().right), left: Math.round(element.getBoundingClientRect().left) }));
  }
  return result;
}
const inspect = (side, options) => side.page.evaluate(inspectInPage, { styleProps: STYLE_PROPS, ...options });
const SHORTHAND_EXTRAS = { 'line-height': ['font'], top: ['inset'], right: ['inset'], bottom: ['inset'], left: ['inset'],
  'flex-direction': ['flex-flow'], 'flex-wrap': ['flex-flow'], 'row-gap': ['gap'], 'column-gap': ['gap'] };
/** Whether an authored shorthand such as `border-color` or `background` sets the given longhand. */
function covers(shorthand, property) {
  if (shorthand === property || (SHORTHAND_EXTRAS[property] ?? []).includes(shorthand)) return true;
  const parts = shorthand.split('-');
  let index = 0;
  for (const part of property.split('-')) if (part === parts[index]) index++;
  return index === parts.length && parts[0] === property.split('-')[0];
}
const usable = entry => entry && !entry.disabled && entry.parsedOk !== false && entry.value !== undefined;
/** The authored text behind a (possibly expanded) declaration; longhands expanded from a shorthand carry no range. */
function authoredEntry(style, property, entry) {
  if (entry?.range) return entry;
  const candidates = (style?.cssProperties ?? []).filter(item => item.range && usable(item) && covers(item.name, property));
  const exact = candidates.filter(item => item.name === property);
  if (exact.length) return exact.at(-1);
  const value = String(entry?.value ?? '').toLowerCase();
  const byValue = candidates.filter(item => value && String(item.value).toLowerCase().includes(value));
  if (byValue.length) return byValue.at(-1);
  return candidates.sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}
/** Cascade winner for one property: matched rules arrive in ascending priority, inline style beats rules, !important beats both. */
function winningDeclaration(matched, property) {
  const pick = (layers) => {
    let normal = null, important = null;
    for (const layer of layers) {
      const entry = (layer.style?.cssProperties ?? []).filter(item => item.name === property && usable(item)).at(-1);
      if (!entry) continue;
      if (entry.important) important = { ...layer, entry }; else normal = { ...layer, entry };
    }
    return important ?? normal;
  };
  const layersOf = (rules, inlineStyle, attributesStyle) => [
    ...(attributesStyle ? [{ style: attributesStyle, origin: 'attributes' }] : []),
    ...(rules ?? []).map(item => ({ style: item.rule.style, rule: item.rule, origin: item.rule.origin })),
    ...(inlineStyle ? [{ style: inlineStyle, origin: 'inline' }] : [])];
  const own = pick(layersOf(matched?.matchedCSSRules, matched?.inlineStyle, matched?.attributesStyle));
  if (own || !INHERITED.has(property)) return own;
  for (const [depth, entry] of (matched?.inherited ?? []).entries()) {
    const found = pick(layersOf(entry.matchedCSSRules, entry.inlineStyle));
    if (found) return { ...found, inheritedDepth: depth + 1 };
  }
  return null;
}
/** Owner `<style>` attributes name the source file for bundler-injected CSS (Vite dev: `data-vite-dev-id`). */
async function sheetOwner(side, header) {
  if (!header?.ownerNode) return null;
  try {
    const { node } = await side.cdp.send('DOM.describeNode', { backendNodeId: header.ownerNode });
    const attributes = Object.fromEntries((node.attributes ?? []).reduce((pairs, value, index, list) => index % 2 ? pairs : [...pairs, [value, list[index + 1]]], []));
    return attributes['data-vite-dev-id'] ?? attributes['data-source'] ?? null;
  } catch { return null; }
}
async function declarationSource(side, winner, property, element) {
  if (!winner) return null;
  const { rule, style, entry, origin } = winner;
  const authored = authoredEntry(style, property, entry);
  const base = { origin: origin === 'regular' ? 'author' : origin, property, value: entry.value, important: !!entry.important,
    selector: rule?.selectorList?.text ?? (origin === 'inline' ? 'style 属性' : null),
    media: (rule?.media ?? []).map(item => item.text).filter(Boolean),
    declaration: clip(authored?.text ?? `${entry.name}: ${entry.value}`, 200), ...(winner.inheritedDepth ? { inheritedDepth: winner.inheritedDepth } : {}) };
  if (origin === 'user-agent') return { ...base, kind: 'user-agent' };
  if (origin === 'inline') return { ...base, kind: 'inline-attribute', ...(locateElementSource(side, element, 'style') ?? {}) };
  const header = rule?.styleSheetId ? side.sheets.get(rule.styleSheetId) : null;
  const range = authored?.range ?? style?.range;
  if (!header || !range) return { ...base, kind: 'stylesheet' };
  const lines = await sheetLines(side, header.styleSheetId);
  const excerpt = excerptOf(lines, range.startLine, range.startColumn);
  const owner = await sheetOwner(side, header);
  const inline = header.isInline && header.sourceURL === side.documentUrl;
  if (inline && !owner) {
    const line0 = header.startLine + range.startLine;
    const column0 = range.startLine === 0 ? header.startColumn + range.startColumn : range.startColumn;
    // A script-inserted <style> also reports the document URL; trust document coordinates only when the text agrees.
    const documentLine = linesOf(side, side.documentUrl)?.[line0];
    const declared = (authored?.text ?? '').slice(0, 24);
    if (documentLine !== undefined && (!declared || documentLine.includes(declared)))
      return { ...base, kind: 'inline-style', url: safeUrl(header.sourceURL), ...at(line0, column0), excerpt };
  }
  return { ...base, kind: owner ? 'injected-style' : inline ? 'dynamic-style' : 'stylesheet', url: safeUrl(header.sourceURL),
    ...(owner ? { file: owner } : {}), ...at(range.startLine, range.startColumn), positionBasis: inline || owner ? 'style-block' : 'file', excerpt };
}
async function declarationsFor(side, selector, properties, element) {
  const matched = await matchedStylesOf(side, selector);
  if (!matched) return {};
  const result = {};
  for (const property of properties) result[property] = await declarationSource(side, winningDeclaration(matched, property), property, element);
  return result;
}
/** Changed-pixel regions of a diff image (pixelmatch red, size-mismatch magenta), in page pixels. */
export function diffRegions(buffer, { cell = 16, gap = 2, max = 12 } = {}) {
  let png;
  try { png = PNG.sync.read(buffer); } catch { return []; }
  const { width, height, data } = png;
  const cols = Math.ceil(width / cell), rows = Math.ceil(height / cell);
  const counts = new Uint32Array(cols * rows);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (data[i] === 255 && data[i + 1] === 0 && (data[i + 2] === 0 || data[i + 2] === 255)) counts[Math.floor(y / cell) * cols + Math.floor(x / cell)]++;
  }
  const seen = new Uint8Array(counts.length);
  const regions = [];
  for (let start = 0; start < counts.length; start++) {
    if (!counts[start] || seen[start]) continue;
    let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, pixels = 0;
    const queue = [start]; seen[start] = 1;
    while (queue.length) {
      const index = queue.pop(), cx = index % cols, cy = Math.floor(index / cols);
      pixels += counts[index];
      minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
      for (let dy = -gap; dy <= gap; dy++) for (let dx = -gap; dx <= gap; dx++) {
        const nx = cx + dx, ny = cy + dy, next = ny * cols + nx;
        if (nx >= 0 && ny >= 0 && nx < cols && ny < rows && counts[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
      }
    }
    regions.push({ x: minX * cell, y: minY * cell, width: Math.min(width, (maxX + 1) * cell) - minX * cell,
      height: Math.min(height, (maxY + 1) * cell) - minY * cell, pixels });
  }
  return regions.sort((a, b) => b.pixels - a.pixels).slice(0, max);
}
const overlapArea = (box, region) => !box ? 0 : Math.max(0, Math.min(box.x + box.width, region.x + region.width) - Math.max(box.x, region.x))
  * Math.max(0, Math.min(box.y + box.height, region.y + region.height) - Math.max(box.y, region.y));

/** Merge four-sided longhands that changed identically into one entry (`border-color`, `padding`, ...). */
function compressFamilies(changes) {
  const result = [...changes];
  for (const [family, members] of Object.entries(FAMILIES)) {
    const found = members.map(name => result.find(change => change.property === name));
    if (found.some(change => !change) || found.some(change => change.baseline !== found[0].baseline || change.target !== found[0].target)) continue;
    const index = result.indexOf(found[0]);
    for (const change of found) result.splice(result.indexOf(change), 1);
    result.splice(index, 0, { ...found[0], property: family, longhand: members[0] });
  }
  return result;
}
const elementName = element => element?.label ?? element?.selector ?? '元素';
const causeText = cause => `${cause.self ? '元素自身' : `祖先 ${cause.label}`}的 ${cause.property} 为 ${cause.value}`;

/**
 * Why an element present in the baseline is absent from the target: deleted from the DOM (with the
 * insertion point the baseline implies) or still present but hidden (with the declaration that hides it).
 */
async function absenceFinding(baseline, target, selector, baselineElement, targetElement) {
  if (targetElement?.exists && targetElement.visible) return null;
  if (!targetElement?.exists) {
    const anchor = baselineElement?.previous ?? (baselineElement?.ancestors?.[0] ? { key: baselineElement.ancestors[0] } : null);
    const [anchorElement] = anchor ? (await inspect(target, { selectors: [anchor.key] })).elements : [];
    const insertion = anchorElement?.exists ? { position: baselineElement.previous ? 'after' : 'inside', selector: anchor.key,
      element: anchorElement.label, source: locateElementSource(target, anchorElement) } : null;
    return { kind: 'missing', selector, element: elementName(baselineElement), box: { baseline: baselineElement?.box ?? null, target: null },
      source: insertion?.source ?? null, baselineSource: locateElementSource(baseline, baselineElement), insertion,
      detail: `目标页面不存在 ${selector}${insertion ? `；基线中它位于 ${insertion.element}${insertion.position === 'after' ? ' 之后' : ' 内部'}` : ''}` };
  }
  const cause = targetElement.hiddenBy;
  const [causeElement] = cause.self ? [targetElement] : (await inspect(target, { selectors: [cause.selector] })).elements;
  const declared = ['display', 'visibility', 'opacity'].includes(cause.property)
    ? (await declarationsFor(target, cause.selector, [cause.property], causeElement))[cause.property] : null;
  const [baselineCause] = cause.self ? [baselineElement] : (await inspect(baseline, { selectors: [cause.selector] })).elements;
  const baselineDeclared = baselineCause?.exists ? (await declarationsFor(baseline, cause.selector, [cause.property], baselineCause))[cause.property] : null;
  const attributeSource = cause.hiddenAttribute ? locateElementSource(target, causeElement, 'hidden') : null;
  const authored = declared && declared.origin !== 'user-agent';
  return { kind: 'hidden', selector, element: elementName(targetElement), box: { baseline: baselineElement?.box ?? null, target: targetElement.box },
    cause: { ...cause, declaration: declared }, source: authored ? declared : attributeSource ?? declared, baselineSource: baselineDeclared,
    detail: `${selector} 在目标页面不可见：${causeText(cause)}${declared?.selector ? `，来自规则 ${declared.media.length ? `@media ${declared.media.join(', ')} ` : ''}${declared.selector}` : ''}` };
}
const union = (a, b) => !a ? b : !b ? a : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y),
  width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) };
const changeText = change => `${change.property}: ${clip(change.baseline, 60)} → ${clip(change.target, 60)}`;

/**
 * Visual check: pair the visible layout of both pages by structural key and keep root causes only.
 * An inherited property that changed exactly like the parent's, or a box that moved with its parent,
 * is a consequence; a resize is a consequence of a changed descendant or a restyled ancestor.
 */
async function localizeVisual(baseline, target, check, run) {
  const options = { scan: true, maskSelectors: run.maskSelectors };
  const [before, after] = await Promise.all([inspect(baseline, { ...options, entryUrl: run.baselineEntry }), inspect(target, { ...options, entryUrl: run.targetEntry })]);
  const regions = run.regionsFor(check);
  const baseMap = new Map(before.layout.map(item => [item.key, item]));
  const targetMap = new Map(after.layout.map(item => [item.key, item]));
  const parentOf = key => targetMap.get(key)?.parent ?? baseMap.get(key)?.parent ?? null;
  const ancestorsOf = key => { const list = []; for (let next = parentOf(key); next && list.length < 64; next = parentOf(next)) list.push(next); return list; };
  const pairs = new Map();
  for (const item of after.layout) {
    const previous = baseMap.get(item.key);
    if (!previous) continue;
    const dx = item.box.x - previous.box.x, dy = item.box.y - previous.box.y;
    const dw = item.box.width - previous.box.width, dh = item.box.height - previous.box.height;
    pairs.set(item.key, { key: item.key, label: item.label, before: previous, after: item,
      raw: STYLE_PROPS.filter(name => previous.style[name] !== item.style[name]).map(property => ({ property, baseline: previous.style[property], target: item.style[property] })),
      moved: dx || dy ? { dx, dy } : null, resized: dw || dh ? { dw, dh } : null,
      text: previous.text !== item.text ? { baseline: previous.text, target: item.text } : null,
      src: previous.src !== item.src ? { baseline: previous.src ?? null, target: item.src ?? null } : null });
  }
  for (const pair of pairs.values()) {
    const parent = pairs.get(pair.after.parent);
    pair.changes = pair.raw.filter(change => {
      if (INHERITED.has(change.property) && parent?.raw.some(item => item.property === change.property && item.baseline === change.baseline && item.target === change.target)) return false;
      const edge = /^border-(top|right|bottom|left)-color$/.exec(change.property)?.[1];
      return !(edge && pair.before.style[`border-${edge}-width`] === '0px' && pair.after.style[`border-${edge}-width`] === '0px');
    });
  }
  const topmost = (items, otherSide) => items.filter(item => !otherSide.has(item.key) && !(item.parent && !otherSide.has(item.parent)
    && (baseMap.has(item.parent) !== targetMap.has(item.parent)))).map(item => item.key);
  const removed = topmost(before.layout, targetMap), added = topmost(after.layout, baseMap);
  const styled = [...pairs.values()].filter(pair => pair.changes.length || pair.text || pair.src);
  const styledKeys = new Set(styled.map(pair => pair.key));
  const changed = new Set([...styledKeys, ...removed, ...added]);
  const changedAncestors = new Set([...changed].flatMap(ancestorsOf));
  const resizedOnly = [...pairs.values()].filter(pair => pair.resized && !changed.has(pair.key));
  const resizedAncestors = new Set(resizedOnly.flatMap(pair => ancestorsOf(pair.key)));
  const resized = resizedOnly.filter(pair => !changedAncestors.has(pair.key) && !resizedAncestors.has(pair.key)
    && !ancestorsOf(pair.key).some(key => styledKeys.has(key)));
  const candidates = [
    ...styled.map(pair => ({ type: 'style', key: pair.key, pair, box: union(pair.before.box, pair.after.box), rank: 0 })),
    ...removed.map(key => ({ type: 'removed', key, box: baseMap.get(key).box, rank: 1 })),
    ...added.map(key => ({ type: 'added', key, box: targetMap.get(key).box, rank: 1 })),
    ...resized.map(pair => ({ type: 'resized', key: pair.key, pair, box: union(pair.before.box, pair.after.box), rank: 2 }))];
  // A pure move is only a root when nothing else changed, and only for the topmost element that moved.
  if (!candidates.length) for (const pair of pairs.values()) {
    const parent = pairs.get(pair.after.parent);
    if (pair.moved && !(parent?.moved && parent.moved.dx === pair.moved.dx && parent.moved.dy === pair.moved.dy))
      candidates.push({ type: 'moved', key: pair.key, pair, box: union(pair.before.box, pair.after.box), rank: 3 });
  }
  for (const candidate of candidates) candidate.overlap = regions.reduce((sum, region) => sum + overlapArea(candidate.box, region), 0);
  const inside = candidates.filter(candidate => candidate.overlap > 0);
  const chosen = (regions.length && inside.length ? inside : candidates).sort((a, b) => a.rank - b.rank || b.overlap - a.overlap).slice(0, MAX_FINDINGS);
  const keys = chosen.map(candidate => candidate.key);
  const [targetFound, baselineFound] = await Promise.all([inspect(target, { selectors: keys }), inspect(baseline, { selectors: keys })]);
  const findings = [];
  for (const [index, candidate] of chosen.entries()) {
    const targetElement = targetFound.elements[index], baselineElement = baselineFound.elements[index];
    const extra = { overlap: candidate.overlap, inDiffRegion: candidate.overlap > 0 };
    if (candidate.type === 'removed') {
      const finding = await absenceFinding(baseline, target, candidate.key, baselineElement, targetElement);
      if (finding) findings.push({ ...finding, ...extra });
      continue;
    }
    const pair = candidate.pair;
    if (candidate.type === 'added') {
      findings.push({ kind: 'added', selector: candidate.key, element: elementName(targetElement), box: { baseline: null, target: candidate.box },
        source: locateElementSource(target, targetElement), detail: `目标页面多出可见元素 ${elementName(targetElement)}`, ...extra });
      continue;
    }
    if (candidate.type !== 'style') {
      const delta = candidate.type === 'resized' ? pair.resized : pair.moved;
      findings.push({ kind: candidate.type, selector: candidate.key, element: pair.label, box: { baseline: pair.before.box, target: pair.after.box }, delta,
        source: locateElementSource(target, targetElement),
        detail: `${pair.label} ${candidate.type === 'resized' ? `尺寸变化 ${delta.dw}×${delta.dh}px` : `位置偏移 (${delta.dx}, ${delta.dy})px`}，未找到对应的样式差异`, ...extra });
      continue;
    }
    const changes = compressFamilies(pair.changes);
    const properties = changes.map(change => change.longhand ?? change.property);
    const [targetDeclared, baselineDeclared] = await Promise.all([declarationsFor(target, candidate.key, properties, targetElement),
      declarationsFor(baseline, candidate.key, properties, baselineElement)]);
    const located = changes.map(change => ({ ...change, source: targetDeclared[change.longhand ?? change.property] ?? null,
      baselineSource: baselineDeclared[change.longhand ?? change.property] ?? null }));
    const primary = located.find(change => change.source?.line && change.source.origin !== 'user-agent');
    findings.push({ kind: 'style', selector: candidate.key, element: pair.label, box: { baseline: pair.before.box, target: pair.after.box },
      changes: located, ...(pair.text ? { text: pair.text } : {}), ...(pair.src ? { src: pair.src } : {}),
      source: primary?.source ?? (pair.text || pair.src ? locateElementSource(target, targetElement) : null),
      baselineSource: primary?.baselineSource ?? null,
      detail: `${pair.label}：${[...located.slice(0, 3).map(changeText), ...(pair.text ? [`文本 ${show(pair.text.baseline)} → ${show(pair.text.target)}`] : [])].join('；')}`, ...extra });
  }
  return { regions, findings, compared: pairs.size, layoutCapped: !!(before.layoutCapped || after.layoutCapped) };
}
/** Structure check: which recorded controls were removed, added or changed, and where the target declares them. */
async function localizeStructure(baseline, target, check) {
  const expected = check.expected ?? {}, actual = check.actual ?? {};
  const before = new Map((expected.controls ?? []).map(control => [control.path, control]));
  const after = new Map((actual.controls ?? []).map(control => [control.path, control]));
  const removed = [...before.keys()].filter(path => !after.has(path));
  const added = [...after.keys()].filter(path => !before.has(path));
  const changed = [...before.keys()].filter(path => after.has(path) && !same(before.get(path), after.get(path)));
  const selectors = [...new Set([...removed, ...added, ...changed])].slice(0, MAX_FINDINGS * 2);
  const [targetFound, baselineFound] = await Promise.all([inspect(target, { selectors }), inspect(baseline, { selectors })]);
  const pick = (found, selector) => found.elements[selectors.indexOf(selector)];
  const findings = [];
  for (const selector of removed.filter(item => selectors.includes(item))) {
    const finding = await absenceFinding(baseline, target, selector, pick(baselineFound, selector), pick(targetFound, selector));
    if (finding) findings.push({ ...finding, control: before.get(selector) });
  }
  for (const selector of added.filter(item => selectors.includes(item))) {
    const element = pick(targetFound, selector);
    if (element?.exists && element.visible) findings.push({ kind: 'added', selector, element: elementName(element), box: { baseline: null, target: element.box },
      control: after.get(selector), source: locateElementSource(target, element), detail: `目标页面多出控件 ${selector}（${clip(after.get(selector)?.label, 40) || element.tag}）` });
  }
  for (const selector of changed.filter(item => selectors.includes(item))) {
    const targetElement = pick(targetFound, selector), baselineElement = pick(baselineFound, selector);
    const fields = CONTROL_FIELDS.filter(field => !same(before.get(selector)[field], after.get(selector)[field])).map(field => ({
      field, name: FIELD_NAMES[field], baseline: before.get(selector)[field], target: after.get(selector)[field],
      source: locateElementSource(target, targetElement, FIELD_ATTRIBUTE[field]), baselineSource: locateElementSource(baseline, baselineElement, FIELD_ATTRIBUTE[field]) }));
    findings.push({ kind: 'attribute', selector, element: elementName(targetElement), box: { baseline: baselineElement?.box ?? null, target: targetElement?.box ?? null },
      fields, source: fields.find(field => field.source)?.source ?? locateElementSource(target, targetElement),
      baselineSource: fields.find(field => field.baselineSource)?.baselineSource ?? null,
      detail: `${selector} 的${fields.map(field => `${field.name} ${show(field.baseline)} → ${show(field.target)}`).join('；')}` });
  }
  const texts = [];
  if (expected.title !== actual.title) texts.push({ selector: 'title', baseline: expected.title, target: actual.title, needle: '<title' });
  for (let index = 0; index < Math.max(expected.headings?.length ?? 0, actual.headings?.length ?? 0) && texts.length < 4; index++) {
    const from = expected.headings?.[index] ?? null, to = actual.headings?.[index] ?? null;
    if (from !== to) texts.push({ selector: `h1 #${index + 1}`, baseline: from, target: to, needle: to });
  }
  for (const text of texts) {
    const document = target.sources.get(target.documentUrl) ?? '';
    const position = text.needle ? document.indexOf(text.needle) : -1;
    findings.push({ kind: 'text', selector: text.selector, element: text.selector, text: { baseline: text.baseline, target: text.target },
      source: position >= 0 ? positionInText(target, target.documentUrl, position, 'document') : null,
      detail: `${text.selector === 'title' ? '页面标题' : `一级标题 ${text.selector.slice(4)}`} ${show(text.baseline)} → ${show(text.target)}` });
  }
  return { findings };
}

const STEP_EVENTS = { click: ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup'],
  fill: ['input', 'change', 'beforeinput', 'keydown', 'keyup'], press: ['keydown', 'keyup', 'keypress'] };
/** Handlers that a step can trigger: on the element, its ancestors (delegation), document and window. */
async function listenersFor(side, element, types) {
  const owners = [];
  for (const key of element?.exists ? [element.key, ...element.ancestors] : []) {
    const nodeId = await nodeIdOf(side, key);
    const object = nodeId ? await side.cdp.send('DOM.resolveNode', { nodeId, objectGroup: 'heimdall-localize' }).then(result => result.object, () => null) : null;
    if (object?.objectId) owners.push({ on: key, objectId: object.objectId });
  }
  for (const expression of ['document', 'window']) {
    const object = await side.cdp.send('Runtime.evaluate', { expression, objectGroup: 'heimdall-localize' }).then(result => result.result, () => null);
    if (object?.objectId) owners.push({ on: expression, objectId: object.objectId });
  }
  const handlers = [];
  for (const { on, objectId } of owners) {
    const { listeners = [] } = await side.cdp.send('DOMDebugger.getEventListeners', { objectId }).catch(() => ({}));
    for (const listener of listeners) if (types.includes(listener.type) && handlers.length < 6)
      handlers.push({ type: listener.type, on, source: await scriptAt(side, listener), handler: clip(listener.handler?.description, 400) });
  }
  return handlers;
}
/** Same assertion semantics as the runner; missing elements answer at once instead of waiting out a timeout. */
async function readAssertion(page, assertion, timeoutMs) {
  const head = { kind: assertion.kind, selector: assertion.selector ?? null, attribute: assertion.attribute ?? null,
    expected: assertion.equals !== undefined ? assertion.equals : assertion.contains !== undefined ? { contains: assertion.contains } : true };
  try {
    const locator = assertion.selector ? page.locator(assertion.selector).first() : null;
    if (locator && ['text', 'attribute'].includes(assertion.kind) && !await locator.count()) return { ...head, actual: null, passed: false, missing: true };
    let actual;
    if (assertion.kind === 'url') actual = page.url();
    else if (assertion.kind === 'visible') actual = await locator.isVisible();
    else if (assertion.kind === 'hidden') actual = !await locator.isVisible();
    else if (assertion.kind === 'text') actual = clip(await locator.textContent({ timeout: timeoutMs }));
    else if (assertion.kind === 'attribute') actual = await locator.getAttribute(assertion.attribute, { timeout: timeoutMs });
    else return { ...head, actual: null, passed: false, error: `unsupported assertion ${assertion.kind}` };
    const passed = assertion.equals !== undefined ? actual === assertion.equals
      : assertion.contains !== undefined ? String(actual ?? '').includes(String(assertion.contains)) : actual === true;
    return { ...head, actual, passed };
  } catch (error) { return { ...head, actual: null, passed: false, error: clip(error?.message, 160) }; }
}
async function performStep(page, step, timeout) {
  const locator = page.locator(step.selector).first();
  if (step.action === 'click') await locator.click({ timeout });
  else if (step.action === 'fill') await locator.fill(String(step.value ?? ''), { timeout });
  else if (step.action === 'press') await locator.press(String(step.value ?? ''), { timeout });
  else throw new Error(`Unsupported step action: ${step.action}`);
}
/** Assertions as recorded in the check, for runs whose plan is no longer available. */
const assertionsFromCheck = check => (check.expected?.assertions ?? []).map(item => ({ kind: item.kind, selector: item.selector, attribute: item.attribute,
  ...(item.expected && typeof item.expected === 'object' && 'contains' in item.expected ? { contains: item.expected.contains }
    : item.expected !== true && item.expected !== undefined ? { equals: item.expected } : {}) }));
const expectedText = expected => expected && typeof expected === 'object' && 'contains' in expected ? `包含 ${expected.contains}` : expected === true ? '成立' : expected;
const assertionLabel = result => `${result.kind}${result.selector ? ` ${result.selector}` : ''}${result.attribute ? ` [${result.attribute}]` : ''}`;
const stateOf = (element, assertion) => !element?.exists ? 'missing'
  : assertion.kind === 'attribute' ? element.attributes?.[assertion.attribute] ?? null : assertion.kind === 'text' ? element.text : element.visible;

async function assertionFinding({ assertion, result, baselineResult, trace, baseline, target, pre, post }) {
  const head = { assertion: { kind: result.kind, selector: result.selector, attribute: result.attribute, expected: result.expected, actual: result.actual, baseline: baselineResult.actual } };
  const said = `断言 ${assertionLabel(result)} 期望${show(expectedText(result.expected))}，目标为${show(result.actual)}`;
  if (result.kind === 'url') {
    const entry = [...trace].reverse().find(item => item.step.action === 'click') ?? trace.at(-1);
    const from = entry?.baseline?.element?.attributes?.href, to = entry?.target?.element?.attributes?.href;
    if (entry && from !== to) return { ...head, kind: 'attribute', selector: entry.step.selector, element: elementName(entry.target?.element),
      fields: [{ field: 'href', name: '链接', baseline: from ?? null, target: to ?? null, source: entry.target?.hrefSource ?? null, baselineSource: entry.baseline?.hrefSource ?? null }],
      source: entry.target?.hrefSource ?? entry.target?.source ?? null, baselineSource: entry.baseline?.hrefSource ?? null,
      detail: `${said}；${entry.step.selector} 的 href 为${show(to)}，基线为${show(from)}` };
  }
  const selector = result.selector;
  const before = { baseline: pre.baseline(selector), target: pre.target(selector) };
  // With steps, an identical starting state means the divergence comes from what the interaction ran.
  if (trace.length && (result.kind === 'url' || same(stateOf(before.baseline, assertion), stateOf(before.target, assertion)))) {
    const handlers = { target: trace.flatMap(entry => entry.target?.handlers ?? []), baseline: trace.flatMap(entry => entry.baseline?.handlers ?? []) };
    const source = handlers.target.find(handler => handler.source?.line)?.source ?? null;
    return { ...head, kind: 'handler', selector: selector ?? trace.at(-1).step.selector, element: elementName(post.target(selector) ?? trace.at(-1).target?.element), handlers, source,
      baselineSource: handlers.baseline.find(handler => handler.source?.line)?.source ?? null,
      detail: `${said}；操作前两侧状态一致，差异由「${trace.map(entry => `${entry.step.action} ${entry.step.selector}`).join(' → ')}」触发的事件处理逻辑产生` };
  }
  const targetElement = post.target(selector), baselineElement = post.baseline(selector);
  if (!targetElement?.exists || (result.kind === 'visible' && !targetElement.visible)) {
    const absence = await absenceFinding(baseline, target, selector, baselineElement, targetElement);
    if (absence) return { ...head, ...absence, detail: `${said}；${absence.detail}` };
  }
  const attribute = result.kind === 'attribute' ? assertion.attribute : null;
  const source = locateElementSource(target, targetElement, attribute);
  return { ...head, kind: attribute ? 'attribute' : result.kind === 'text' ? 'text' : 'state', selector, element: elementName(targetElement),
    box: { baseline: baselineElement?.box ?? null, target: targetElement?.box ?? null },
    ...(attribute ? { fields: [{ field: attribute, name: attribute, baseline: baselineElement?.attributes?.[attribute] ?? null, target: targetElement?.attributes?.[attribute] ?? null,
      source, baselineSource: locateElementSource(baseline, baselineElement, attribute) }] } : {}),
    ...(result.kind === 'text' ? { text: { baseline: baselineElement?.text ?? null, target: targetElement?.text ?? null } } : {}),
    source, baselineSource: locateElementSource(baseline, baselineElement, attribute), detail: `${said}；元素在页面加载后即与基线不同` };
}
/** The differing middle of two similar texts once their common prefix and suffix are removed. */
export function textDelta(a = '', b = '') {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { baseline: a.slice(start, a.length - end), target: b.slice(start, b.length - end) };
}
function handlerDelta(handlers) {
  for (const target of handlers.target) {
    const baseline = handlers.baseline.find(item => item.type === target.type && item.on === target.on);
    if (!baseline?.handler || !target.handler || baseline.handler === target.handler) continue;
    const delta = textDelta(baseline.handler, target.handler);
    if (delta.baseline.length + delta.target.length <= 240) return { type: target.type, on: target.on, ...delta };
  }
  return null;
}

/** Behavior check: replay the declared steps on both sides, recording what each step touched, then explain each divergent assertion. */
async function localizeBehavior(baseline, target, check, run) {
  const point = run.pointFor(check);
  const steps = (point?.steps ?? []).slice(0, 12);
  const assertions = (point?.assertions?.length ? point.assertions : assertionsFromCheck(check)).slice(0, 20);
  const selectors = [...new Set([...assertions.map(item => item.selector), ...steps.map(step => step.selector)].filter(Boolean))];
  const snapshot = async side => { const found = await inspect(side, { selectors }); return selector => found.elements[selectors.indexOf(selector)] ?? null; };
  const pre = { baseline: await snapshot(baseline), target: await snapshot(target) };
  const trace = [];
  let stepError = null;
  for (const step of steps) {
    const entry = { step };
    for (const [name, side] of [['baseline', baseline], ['target', target]]) {
      const [element] = (await inspect(side, { selectors: [step.selector] })).elements;
      const record = entry[name] = { element, source: locateElementSource(side, element),
        hrefSource: element?.attributes?.href !== undefined ? locateElementSource(side, element, 'href') : null,
        handlers: element?.exists ? await listenersFor(side, element, STEP_EVENTS[step.action] ?? []) : [] };
      try {
        if (!element?.exists || !element.visible) throw new Error(element?.exists ? 'element is not visible' : 'element not found');
        await performStep(side.page, step, side.timeoutMs);
      } catch (error) { record.error = clip(error?.message, 200); }
    }
    trace.push(entry);
    if (entry.target.error) { stepError = entry; break; }
  }
  if (steps.length) await Promise.all([baseline, target].map(async side => { await side.page.waitForTimeout(side.settleMs); await settled(side); }));
  const results = { baseline: [], target: [] };
  for (const assertion of assertions) {
    results.baseline.push(await readAssertion(baseline.page, assertion, baseline.timeoutMs));
    results.target.push(await readAssertion(target.page, assertion, target.timeoutMs));
  }
  const post = { baseline: await snapshot(baseline), target: await snapshot(target) };
  const findings = [];
  if (stepError) {
    const { step, target: record, baseline: baselineRecord } = stepError;
    const absence = await absenceFinding(baseline, target, step.selector, baselineRecord?.element, record.element);
    findings.push(absence ? { ...absence, step, detail: `步骤「${step.action} ${step.selector}」无法执行；${absence.detail}` }
      : { kind: 'step', selector: step.selector, element: elementName(record.element), step, error: record.error, source: record.source,
        detail: `步骤「${step.action} ${step.selector}」在目标页面执行失败：${record.error}` });
  } else for (const [index, assertion] of assertions.entries()) {
    const result = results.target[index], baselineResult = results.baseline[index];
    if (result.passed || !baselineResult.passed) continue;
    const finding = await assertionFinding({ assertion, result, baselineResult, trace, baseline, target, pre, post });
    if (finding.kind === 'handler') {
      finding.delta = handlerDelta(finding.handlers);
      if (finding.delta) finding.detail += finding.delta.baseline && !finding.delta.target ? `；目标处理函数缺少 ${clip(finding.delta.baseline, 160)}`
        : `；处理函数差异：基线 ${show(finding.delta.baseline)}，目标 ${show(finding.delta.target)}`;
    }
    findings.push(finding);
    if (findings.length >= MAX_FINDINGS) break;
  }
  const failed = results.target.filter(item => !item.passed).length;
  return { findings, replay: { steps: steps.length, stepError: stepError ? { step: stepError.step, error: stepError.target.error } : null,
    assertions: assertions.length, targetFailed: failed, baselineFailed: results.baseline.filter(item => !item.passed).length, reproduced: failed > 0 || !!stepError } };
}
/** Where a request came from: the script frame that issued it, or the markup/stylesheet position that referenced it. */
async function initiatorSource(side, request) {
  const initiator = request?.initiator;
  const frame = initiator?.stack?.callFrames?.[0];
  if (frame) return scriptAt(side, frame);
  if (!initiator?.url || !Number.isInteger(initiator.lineNumber)) return null;
  const isDocument = initiator.url === side.documentUrl || side.sources.has(initiator.url);
  let column0 = initiator.columnNumber ?? 0;
  // Parser positions point past the referencing tag; move back to the reference itself when it is on the line.
  const name = pathOfUrl(request.url).split('/').filter(Boolean).at(-1);
  const line = linesOf(side, initiator.url)?.[initiator.lineNumber];
  const found = name && line ? line.lastIndexOf(name, column0) : -1;
  if (found >= 0) column0 = Math.max(0, line.lastIndexOf('<', found));
  return locationIn(side, initiator.url, initiator.lineNumber, column0, isDocument ? 'document' : 'resource');
}
const initiatorText = (request, source) => !request?.initiator ? '未知来源'
  : request.initiator.stack?.callFrames?.length ? `脚本 ${whereText(source)}`
    : request.initiator.type === 'parser' ? `页面标记 ${whereText(source)}` : request.initiator.type === 'other' ? '浏览器导航' : request.initiator.type;
async function resourceFinding(side, request, item) {
  const source = await initiatorSource(side, request);
  const url = safeUrl(request?.url) ?? item.url;
  const status = request?.status ?? item.status ?? null, failure = request?.failure ?? item.message ?? null;
  return { kind: 'resource', selector: null, element: null, source,
    request: { url, method: request?.method ?? item.method ?? 'GET', status, failure: status ? null : failure, type: request?.type ?? null, initiator: request?.initiator?.type ?? null },
    detail: `请求 ${pathOfUrl(url)} ${status ? `返回 HTTP ${status}` : `失败（${clip(failure, 80)}）`}，发起方：${initiatorText(request, source)}` };
}

const HEALTH_FACET = /-(navigation|console|network|overflow|readonly)$/;
/** Health check: tie each new console error, failed request or overflow to the code or markup that produced it. */
async function localizeHealth(baseline, target, check) {
  const facet = HEALTH_FACET.exec(check.id)?.[1] ?? null;
  const findings = [];
  if (facet === 'navigation') {
    findings.push({ kind: 'navigation', selector: null, element: null, source: null,
      response: { url: target.url, status: target.httpStatus, baselineStatus: baseline.httpStatus, error: target.navigationError },
      detail: target.navigationError ? `目标页面无法打开：${target.navigationError}` : `目标页面返回 HTTP ${target.httpStatus}，基线为 HTTP ${baseline.httpStatus}；问题在服务端路由或部署` });
    return { facet, findings };
  }
  if (facet === 'overflow') {
    const { overflowing = [] } = await inspect(target, { overflow: true });
    const width = target.page.viewportSize()?.width ?? 0;
    for (const item of overflowing.slice(0, 4)) {
      const declared = await declarationsFor(target, item.key, ['width', 'min-width', 'margin-left', 'left', 'transform', 'white-space'], null);
      const source = Object.values(declared).find(entry => entry?.line && entry.origin !== 'user-agent') ?? null;
      const past = item.right > width + 2 ? `右侧超出 ${item.right - width}px` : `左侧超出 ${-item.left}px`;
      findings.push({ kind: 'overflow', selector: item.key, element: item.label, box: { baseline: null, target: item.box }, declarations: declared, source,
        detail: `${item.label} ${past}（视口 ${width}px）${source ? `，相关声明 ${source.declaration}` : ''}` });
    }
    return { facet, findings };
  }
  const used = new Set();
  const take = (list, test) => { const found = list.find(item => !used.has(item) && test(item)); if (found) used.add(found); return found ?? null; };
  const requests = [...target.requests.values()];
  for (const item of (check.actual?.added ?? []).slice(0, MAX_FINDINGS)) {
    if (item.kind === 'pageerror') {
      const exception = take(target.exceptions, details => [details.exception?.description, details.text].some(text => clip(text, 2000).includes(clip(item.message))));
      const frames = exception?.stackTrace?.callFrames ?? [];
      const source = exception ? await scriptAt(target, frames[0] ?? exception) : null;
      const stack = [];
      for (const frame of frames.slice(0, 4)) stack.push(await scriptAt(target, frame));
      findings.push({ kind: 'script-error', selector: null, element: null, message: item.message, source, stack: stack.filter(Boolean),
        detail: `目标页面脚本抛出异常「${clip(item.message, 120)}」${source ? `，位于 ${whereText(source)}` : '，重新渲染时未复现'}` });
    } else if (item.kind === 'console') {
      const call = take(target.consoleCalls, event => {
        const text = clip((event.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '));
        return text === clip(item.message) || (!!text && clip(item.message).startsWith(text.slice(0, 80)));
      });
      if (call) {
        const source = await scriptAt(target, call.stackTrace?.callFrames?.[0] ?? {});
        findings.push({ kind: 'console-error', selector: null, element: null, message: item.message, source,
          detail: `目标页面输出 console.error「${clip(item.message, 120)}」${source ? `，调用位置 ${whereText(source)}` : ''}` });
        continue;
      }
      const entry = take(target.logEntries, log => clip(log.text) === clip(item.message) || clip(item.message).includes(clip(log.text)));
      const request = entry?.networkRequestId ? target.requests.get(entry.networkRequestId) : null;
      if (request) { used.add(request); findings.push({ ...(await resourceFinding(target, request, item)), message: item.message }); continue; }
      const frame = entry?.stackTrace?.callFrames?.[0];
      const source = frame ? await scriptAt(target, frame) : entry?.url ? locationIn(target, entry.url, entry.lineNumber, 0, 'resource') : null;
      findings.push({ kind: 'console-error', selector: null, element: null, message: item.message, source,
        detail: `目标页面控制台错误「${clip(item.message, 120)}」${source ? `，位于 ${whereText(source)}` : entry ? '' : '，重新渲染时未复现'}` });
    } else if (item.kind === 'http' || item.kind === 'requestfailed') {
      // A 404 script is reported twice (the status, then the aborted load); both are one broken reference.
      const earlier = findings.find(finding => finding.kind === 'resource' && finding.request.url === item.url);
      if (earlier) { earlier.request.failure ??= item.message ?? null; continue; }
      const matches = candidate => safeUrl(candidate.url) === item.url;
      const request = take(requests, candidate => matches(candidate) && (item.kind === 'http' ? candidate.status === item.status : !!candidate.failure))
        ?? take(requests, matches);
      findings.push(await resourceFinding(target, request, item));
    }
  }
  return { facet, findings };
}
const LOCALIZERS = { visual: localizeVisual, structure: localizeStructure, behavior: localizeBehavior, health: localizeHealth };
const LOCALIZATION_SCOPE = '定位靠只读重新渲染基线与目标页面完成，不改变检查结论。源码位置指浏览器实际收到的 HTML、样式表与脚本；经构建工具转换的代码需借助 source map 回到工程文件。页面含时间、随机数或登录态内容时，重新渲染结果可能与运行时不同。';
const safeName = value => String(value).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 70);
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
function evidenceFile(runDir, name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(name)) return null;
  const file = resolve(runDir, name);
  return inside(runDir, file) && existsSync(file) ? file : null;
}
/** A finished run's plan: the benchmark's plan.json, or the plan kept in a legacy manifest. */
function planOf(runDir) {
  for (const [name, pick] of [['plan.json', value => value], ['manifest.json', value => value?.plan]]) {
    const file = join(runDir, name);
    if (!existsSync(file)) continue;
    try { const plan = pick(readJson(file)); if (plan && typeof plan === 'object') return plan; } catch { /* Fall back to the report alone. */ }
  }
  return null;
}
function pointFinder(plan) {
  return check => {
    const match = /-point-(\d+)-/.exec(check.id ?? '');
    const point = match ? plan?.points?.[Number(match[1]) - 1] : null;
    if (point && check.id.endsWith(`-${safeName(point.id)}`)) return point;
    // Without the plan, rebuild the steps from the recorded reproduction lines.
    const steps = (check.reproduction ?? []).map(line => /^(click|fill|press) (.+?)(?: \((.*)\))?$/.exec(line)).filter(Boolean)
      .map(([, action, selector, value]) => ({ action, selector, ...(value !== undefined ? { value } : {}) }));
    return { steps, assertions: assertionsFromCheck(check) };
  };
}
function viewportFor(plan, check) {
  const declared = plan?.viewports?.find(item => item.name === check.viewport) ?? DEFAULT_VIEWPORTS.find(item => item.name === check.viewport);
  return declared ? { name: declared.name, width: declared.width, height: declared.height } : { name: check.viewport ?? 'desktop', width: 1440, height: 900 };
}
async function openPair(browser, settings, urls) {
  const sides = await Promise.allSettled([openSide(browser, { ...settings, url: urls.baseline }), openSide(browser, { ...settings, url: urls.target })]);
  if (sides.every(side => side.status === 'fulfilled')) return { baseline: sides[0].value, target: sides[1].value };
  await Promise.all(sides.filter(side => side.status === 'fulfilled').map(side => closeSide(side.value)));
  throw sides.find(side => side.status === 'rejected').reason;
}
const checkHead = check => ({ checkId: check.id, title: check.title ?? check.id, dimension: check.dimension, route: check.route ?? '/', viewport: check.viewport ?? null, severity: check.severity ?? null });
const pageOf = side => ({ url: side.url, documentUrl: safeUrl(side.documentUrl), httpStatus: side.httpStatus, navigationError: side.navigationError, blockedRequests: side.blocked.length });
const levelOf = findings => findings.some(finding => finding.source?.line && finding.source.origin !== 'user-agent') ? 'source' : findings.length ? 'element' : 'none';
function finish(check, outcome, pair, started) {
  const findings = outcome.findings ?? [];
  return { ...checkHead(check), status: 'completed', level: levelOf(findings), ...(outcome.facet ? { facet: outcome.facet } : {}), findings,
    ...(outcome.regions ? { diffRegions: outcome.regions, comparedElements: outcome.compared, layoutCapped: outcome.layoutCapped } : {}),
    ...(outcome.replay ? { replay: outcome.replay } : {}), ...(outcome.note ? { note: outcome.note } : {}),
    pages: { baseline: pageOf(pair.baseline), target: pageOf(pair.target) }, durationMs: Date.now() - started };
}
const failure = (check, error, started = Date.now()) => ({ ...checkHead(check), status: 'error', level: 'none', findings: [], error: clip(error?.message ?? error), durationMs: Date.now() - started });
function totalsOf(checks) {
  const completed = checks.filter(check => check.status === 'completed');
  return { failed: checks.length, source: completed.filter(check => check.level === 'source').length, element: completed.filter(check => check.level === 'element').length,
    none: completed.filter(check => check.level === 'none').length, errors: checks.length - completed.length };
}
const summaryOf = totals => `${totals.failed} 个可靠失败中，${totals.source} 个定位到源码位置，${totals.element} 个定位到元素或请求`
  + `${totals.none ? `，${totals.none} 个重新渲染未复现` : ''}${totals.errors ? `，${totals.errors} 个定位未完成` : ''}。`;

/**
 * Localize every reliable failure (`verdict: bug`) of a finished browser acceptance run.
 * Reads `report.json` and, when present, the plan (`plan.json` or the manifest); writes nothing.
 */
export async function localizeAcceptanceRun(runDir, { report, plan, checkIds = null, budgetMs = RUN_BUDGET_MS, onProgress } = {}) {
  const started = Date.now();
  runDir = resolve(runDir);
  report ??= readJson(join(runDir, 'report.json'));
  plan ??= planOf(runDir);
  const head = { schemaVersion: LOCALIZATION_SCHEMA_VERSION, kind: 'acceptance-localization', runId: report.runId ?? null, generatedAt: new Date().toISOString(), scope: LOCALIZATION_SCOPE };
  if (['spec', 'browser-fixed'].includes(report.mode)) return { ...head, status: 'unsupported', mode: report.mode, totals: totalsOf([]), checks: [],
    summary: report.mode === 'spec' ? 'Spec（接口契约）模式没有页面元素，不做元素定位。' : '固定基线模式的基线来自已捕获证据，无法重新渲染，暂不支持元素定位。' };
  const failed = (report.checks ?? []).filter(check => check.verdict === 'bug' && check.status === 'failed' && (!checkIds || checkIds.includes(check.id)));
  if (!failed.length) return { ...head, status: 'no_failures', totals: totalsOf([]), checks: [], totalChecks: report.checks?.length ?? 0,
    summary: '本次运行没有可靠失败的检查项，无需元素定位。' };
  const baselineEntry = plan?.baselineUrl ?? report.baselineUrl, targetEntry = plan?.targetUrl ?? report.targetUrl;
  const timeoutMs = bounded(plan?.timeoutMs, 10_000, 500, 30_000);
  const settleMs = plan?.settleMs === 0 ? 0 : bounded(plan?.settleMs, 250, 0, 2_000);
  const run = { maskSelectors: plan?.normalization?.maskSelectors ?? [], baselineEntry, targetEntry, pointFor: pointFinder(plan),
    regionsFor: check => { const file = evidenceFile(runDir, check.evidence?.diff); return file ? diffRegions(readFileSync(file)) : []; } };
  // Read-only checks of one route and viewport share a page pair; behavior replays mutate pages, so each gets its own.
  const groups = new Map();
  for (const check of failed) {
    const key = check.dimension === 'behavior' ? `behavior|${check.id}` : `${check.route}|${check.viewport}`;
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  const results = new Map();
  const deadline = started + budgetMs;
  const browser = await chromium.launch({ headless: true, timeout: timeoutMs });
  try {
    for (const checks of groups.values()) {
      if (Date.now() >= deadline) { for (const check of checks) results.set(check.id, { ...failure(check, '定位时间预算已用完'), status: 'skipped' }); continue; }
      const [first] = checks;
      let pair = null;
      try {
        pair = await openPair(browser, { viewport: viewportFor(plan, first), timeoutMs, settleMs },
          { baseline: resolveAcceptanceUrl(baselineEntry, first.route ?? '/'), target: resolveAcceptanceUrl(targetEntry, first.route ?? '/') });
        for (const check of checks) {
          const checkStarted = Date.now();
          try {
            const unreachable = (pair.baseline.navigationError || pair.target.navigationError) && check.dimension !== 'health';
            const outcome = unreachable ? { findings: [], note: `页面重新打开失败：${pair.target.navigationError ?? pair.baseline.navigationError}` }
              : await LOCALIZERS[check.dimension]?.(pair.baseline, pair.target, check, run) ?? { findings: [], note: `不支持的检查维度 ${check.dimension}` };
            results.set(check.id, finish(check, outcome, pair, checkStarted));
          } catch (error) { results.set(check.id, failure(check, error, checkStarted)); }
          await onProgress?.({ completed: results.size, total: failed.length, checkId: check.id });
        }
      } catch (error) {
        for (const check of checks) if (!results.has(check.id)) results.set(check.id, failure(check, error));
      } finally { await closeSide(pair?.baseline); await closeSide(pair?.target); }
    }
  } finally { await browser.close().catch(() => {}); }
  const checks = failed.map(check => results.get(check.id));
  const totals = totalsOf(checks);
  return { ...head, status: 'completed', durationMs: Date.now() - started, totals, summary: summaryOf(totals), checks };
}
const code = value => `\`${String(value ?? '').replaceAll('`', "'")}\``;
/** Human-readable localization next to report.md. */
export function localizationMarkdown(localization) {
  const lines = ['# 元素定位', '', localization.summary ?? '', ''];
  for (const check of localization.checks ?? []) {
    lines.push(`## ${check.title}`, '', `检查 ${code(check.checkId)} · ${check.dimension} · ${check.route} · ${check.viewport ?? '-'}`, '');
    if (check.error) lines.push(`定位未完成：${check.error}`, '');
    if (check.note) lines.push(check.note, '');
    for (const finding of check.findings ?? []) {
      lines.push(`- ${finding.detail}`);
      if (finding.source) lines.push(`  - 目标：${code(whereText(finding.source))}${finding.source.excerpt ? ` ${code(finding.source.excerpt)}` : ''}`);
      if (finding.baselineSource?.line) lines.push(`  - 基线：${code(whereText(finding.baselineSource))}${finding.baselineSource.excerpt ? ` ${code(finding.baselineSource.excerpt)}` : ''}`);
    }
    if (check.status === 'completed' && !check.findings?.length && !check.note) lines.push('- 重新渲染未复现该失败，没有可定位的差异。');
    lines.push('');
  }
  lines.push(`> ${localization.scope ?? LOCALIZATION_SCOPE}`, '');
  return lines.join('\n');
}
