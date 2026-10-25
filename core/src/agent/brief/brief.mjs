/**
 * agent/brief/brief — 简报 Brief（heimdall.brief/1，E6-01 ~ E6-05、E6-15，PRD 05 §2、附录 C §3–4）
 *
 * 渐进披露三档：
 *   outline   页面大纲 + 令牌 + 字体 + 资产索引 + 缺口（约 2–15 千 token）
 *   sections  再加分段计划（每段三视口外接框、角色、体量）
 *   full      只返回 sectionId 指定的一段：元素清单（三视口外接框 + 计算样式签名 + 各视口差异）、
 *             伪元素、写死的高度、外层装饰、亚像素起点、命中的 CSS 规则（faithful 档）、资产引用
 *
 * 测量（要开 Chromium）结果缓存在 workspace/<siteId>/agent/briefs/<page>/：plan.json、sections/<id>.json，
 * 镜像变了就重测。渲染每次现做：围栏 nonce 每次响应都不同，缓存里只存原始测量。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractTokens, topEntries } from '../../extract/tokens.mjs';
import { pathOfType } from '../../crawler/classify.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';
import { CapabilityError, nextAction } from '../envelope.mjs';
import { createFence } from '../fence.mjs';
import { sectionIdOf } from '../ids.mjs';
import { redactText } from '../redact.mjs';
import { serveStatic } from '../serve.mjs';
import { agentDir, mirrorEntry, pageDir, readManifest, requireMirror } from '../workspace.mjs';
import { launchBrowser, openPage, VIEWPORTS, viewportOf, PROFILE } from '../evidence/capture.mjs';
import { buildOutline } from './outline.mjs';
import { planSections, measureAnchors, sectionDetail, fontFaces, STYLE_PROPS, PSEUDO_PROPS } from './inspect.mjs';

export const BRIEF_VERSION = 7;   // 规划 / 测量算法变了就加一，旧缓存自动作废
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const tokenEstimate = (s) => Math.ceil(Buffer.byteLength(String(s ?? '')) / 3.5);

export const briefDir = (siteId, page) => join(agentDir(siteId), 'briefs', page);

function mirrorStamp(siteId, page) {
  return statSync(join(requireMirror(siteId, page), 'clone', 'index.html')).mtimeMs;
}

// ---------------------------------------------------------------------------
// 测量（Chromium）
// ---------------------------------------------------------------------------

/** 分段计划：1440 下规划，三视口按锚点量外接框。返回并缓存 heimdall.sections/1 */
export async function ensurePlan(siteId, page, { refresh = false, browser } = {}) {
  const pdir = requireMirror(siteId, page);
  const dir = briefDir(siteId, page);
  const file = join(dir, 'plan.json');
  const stamp = mirrorStamp(siteId, page);
  const cached = readJson(file);
  if (!refresh && cached?.version === BRIEF_VERSION && cached.mirrorStamp === stamp) return cached;
  mkdirSync(dir, { recursive: true });
  const srv = await serveStatic(pdir);
  const own = !browser;
  browser ??= await launchBrowser();
  try {
    const at = (w) => `${srv.origin}/${mirrorEntry(siteId, page, w)}`;
    const desk = viewportOf(1440);
    const { ctx, page: p } = await openPage(browser, at(1440), desk);
    const plan = await p.evaluate(planSections, { minH: 48, maxH: 1200, maxDepth: 12 });
    const fonts = await p.evaluate(fontFaces);
    const boxes = { 1440: await p.evaluate(measureAnchors, plan.sections.map(s => s.anchors)) };
    const docSize = { 1440: { w: plan.docW, h: plan.docH } };
    await ctx.close();
    for (const vp of VIEWPORTS.filter(v => v.width !== 1440)) {
      const o = await openPage(browser, at(vp.width), vp);
      boxes[vp.width] = await o.page.evaluate(measureAnchors, plan.sections.map(s => s.anchors));
      docSize[vp.width] = await o.page.evaluate(() => ({ w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
        h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) }));
      await o.ctx.close();
    }
    const usedIds = new Set();
    const sections = plan.sections.map((s, order) => {
      let id = sectionIdOf(siteId, page, s.anchors.join('|'), s.role);
      while (usedIds.has(id)) id = sectionIdOf(siteId, page, s.anchors.join('|') + '#' + order, s.role);
      usedIds.add(id);
      const b = Object.fromEntries(VIEWPORTS.map(v => [v.width, boxes[v.width][order]]));
      return { id, role: s.role, order, overlay: s.overlay, layered: !!s.layered, anchor: { domPath: s.anchors[0], extra: s.anchors.slice(1) }, anchors: s.anchors,
        tag: s.tag, elementCount: s.elementCount, boxes: b };
    });
    // 覆盖检查（E6-03）：流内各段（不含叠放层与 absolute 层）在 1440 下覆盖页面高度的比例与重叠。
    // 段与段之间的空隙由页内检查分类（inspect.mjs planSections 的 gaps）：空隙里没有不属于任何一段的可见内容，
    // 就是父容器的内边距 / 间距（spacing，要复刻但不算漏掉）；有内容的才是 uncovered。覆盖不足 98% 时标 needsReview
    const flow = sections.filter(s => !s.overlay && !s.layered && s.boxes[1440]).map(s => s.boxes[1440]).sort((a, b) => a.y - b.y);
    let covered = 0, overlap = 0, cursor = 0;
    for (const b of flow) {
      const top = Math.max(b.y, cursor), bottom = b.y + b.h;
      if (bottom > top) covered += bottom - top;
      if (cursor > b.y) overlap += Math.min(cursor, bottom) - b.y;
      cursor = Math.max(cursor, bottom);
    }
    const docH = Math.max(1, docSize[1440].h);
    const spacing = (plan.gaps ?? []).filter(g => !g.content).reduce((s, g) => s + g.h, 0);
    const uncovered = (plan.gaps ?? []).filter(g => g.content).map(g => ({ y: Math.round(g.y), h: Math.round(g.h), contentElements: g.content }));
    const heightPct = +(Math.min(docH, covered + spacing) / docH * 100).toFixed(1);
    const result = {
      schema: 'heimdall.sections/1', version: BRIEF_VERSION, siteId, page, mirrorStamp: stamp, generatedAt: new Date().toISOString(),
      viewports: VIEWPORTS.map(v => v.width), docSize, sections, fonts, pageBg: plan.pageBg,
      dependencies: [], sharedCandidates: [],
      coverage: { heightPct, sectionsPct: +(covered / docH * 100).toFixed(1), spacingPx: Math.round(spacing), overlapPct: +(overlap / docH * 100).toFixed(2),
        uncovered, needsReview: heightPct < 98 || overlap / docH > 0.02 },
    };
    writeFileAtomic(file, JSON.stringify(result));
    return result;
  } finally {
    if (own) await browser.close().catch(() => {});
    await srv.close();
  }
}

/** 单段详情（三视口），缓存于 sections/<sectionId>.json */
export async function ensureSectionDetail(siteId, page, sectionId, { refresh = false, browser, withRules = false } = {}) {
  const plan = await ensurePlan(siteId, page, { browser });
  const section = plan.sections.find(s => s.id === sectionId);
  if (!section) {
    throw new CapabilityError('not_found', `没有分段 ${sectionId}`, {
      nextActions: [nextAction('heimdall_brief', { siteId, page, detail: 'sections' }, '列出分段')],
    });
  }
  const dir = join(briefDir(siteId, page), 'sections');
  const file = join(dir, `${sectionId}${withRules ? '.rules' : ''}.json`);
  const cached = readJson(file);
  if (!refresh && cached?.mirrorStamp === plan.mirrorStamp && cached.version === BRIEF_VERSION) return { plan, section, detail: cached };
  mkdirSync(dir, { recursive: true });
  const pdir = pageDir(siteId, page);
  const srv = await serveStatic(pdir);
  const own = !browser;
  browser ??= await launchBrowser();
  try {
    const per = {};
    for (const vp of VIEWPORTS) {
      const o = await openPage(browser, `${srv.origin}/${mirrorEntry(siteId, page, vp.width)}`, vp);
      per[vp.width] = await o.page.evaluate(sectionDetail, { anchors: section.anchors, props: STYLE_PROPS, pseudoProps: PSEUDO_PROPS,
        withStyle: true, withRules: withRules && vp.width === 1440, maxElements: 600, maxText: 600 });
      await o.ctx.close();
    }
    const detail = { version: BRIEF_VERSION, mirrorStamp: plan.mirrorStamp, sectionId, per, entryOrigin: srv.origin };
    writeFileAtomic(file, JSON.stringify(detail));
    return { plan, section, detail };
  } finally {
    if (own) await browser.close().catch(() => {});
    await srv.close();
  }
}

// ---------------------------------------------------------------------------
// 静态部分（不需要浏览器）
// ---------------------------------------------------------------------------

function pageTokens(siteId, page) {
  const file = join(pageDir(siteId, page), 'cssom.css');
  if (!existsSync(file)) return null;
  const t = extractTokens(readFileSync(file, 'utf8'));
  return {
    variables: Object.entries(t.variables).sort((a, b) => b[1].count - a[1].count).slice(0, 30).map(([name, v]) => ({ name, value: v.value, count: v.count })),
    colors: topEntries(t.colors, 16), fontFamilies: topEntries(t.fontFamilies, 6), fontSizes: topEntries(t.fontSizes, 12),
    fontWeights: topEntries(t.fontWeights, 6), lineHeights: topEntries(t.lineHeights, 8), spacings: topEntries(t.spacings, 16),
    radii: topEntries(t.radii, 8), shadows: topEntries(t.shadows, 6), breakpoints: topEntries(t.breakpoints, 10),
  };
}

function pageGaps(siteId, page) {
  const g = readJson(join(pageDir(siteId, page), 'gaps.json'));
  if (!g) return [];
  const out = [];
  for (const f of g.failed ?? []) out.push({ kind: 'asset', detail: String(f?.url ?? f).slice(0, 200), severity: 'medium' });
  for (const f of g.notCaptured ?? []) out.push({ kind: 'asset', detail: String(f?.url ?? f).slice(0, 200), severity: 'low' });
  for (const f of g.cssSheetsUnreadable ?? []) out.push({ kind: 'css-ref', detail: String(f?.url ?? f).slice(0, 200), severity: 'medium' });
  for (const n of g.notes ?? []) out.push({ kind: 'render', detail: String(n).slice(0, 200), severity: 'low' });
  return out.slice(0, 40);
}

function pageTypeOf(siteId, page) {
  const target = readManifest(siteId, page)?.target;
  try { return target ? pathOfType(new URL(target).pathname) ?? 'generic' : 'generic'; } catch { return 'generic'; }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const DEFAULTS = { position: 'static', top: 'auto', left: 'auto', right: 'auto', bottom: 'auto', zIndex: 'auto', flexDirection: 'row', flexWrap: 'nowrap',
  justifyContent: 'normal', alignItems: 'normal', gap: 'normal', gridTemplateColumns: 'none', gridTemplateRows: 'none', maxWidth: 'none', minHeight: '0px',
  fontStyle: 'normal', letterSpacing: 'normal', textAlign: 'start', textTransform: 'none', textDecorationLine: 'none', whiteSpace: 'normal',
  backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', backgroundSize: 'auto', backgroundPosition: '0% 0%', backgroundRepeat: 'repeat',
  borderRadius: '0px', boxShadow: 'none', opacity: '1', overflow: 'visible', objectFit: 'fill', objectPosition: '50% 50%', transform: 'none', boxSizing: 'content-box' };
const isDefault = (p, v) => DEFAULTS[p] === v || (/^(padding|margin)/.test(p) && v === '0px') || (/^border(Top|Right|Bottom|Left)$/.test(p) && /^0px none/.test(v));
const short = (v) => String(v).replace(/rgba?\((\d+), (\d+), (\d+)(?:, 1)?\)/g, (_, r, g, b) => '#' + [r, g, b].map(n => (+n).toString(16).padStart(2, '0')).join(''));
const fmtBox = (b) => b ? `${b.x},${b.y},${b.w},${b.h}` : 'hidden';

/** 资产在镜像里的相对路径（供重建工作区复制原件）；只认镜像目录内的本地文件 */
function assetPathOf(url, entryOrigin) {
  try {
    const u = new URL(url, entryOrigin);
    if (entryOrigin && u.origin !== new URL(entryOrigin).origin) return null;
    const p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
    return p.startsWith('clone/') ? p : null;
  } catch { return null; }
}

/** 渲染单段详情为文本（围栏内）与结构化部分 */
function renderSection(section, detail, fence, { fidelity }) {
  const main = detail.per[1440] ?? Object.values(detail.per).find(Boolean);
  if (!main) throw new CapabilityError('render_not_settled', `分段 ${section.id} 在镜像里找不到了`, { hint: '加 --refresh 重新测量' });
  const props = STYLE_PROPS;
  const sigs = new Map();
  const sigOf = (style) => {
    const s = props.filter(p => !isDefault(p, style[p])).map(p => `${p}: ${short(style[p])}`).join('; ');
    if (!sigs.has(s)) sigs.set(s, `S${sigs.size + 1}`);
    return sigs.get(s);
  };
  const lines = [];
  const assets = new Map();
  for (const it of main.items) {
    const n = it.i;
    const ind = '  '.repeat(Math.min(it.depth, 10));
    const name = it.tag + (it.id ? '#' + fence.inline(it.id, 40) : '') + (it.cls ? '.' + fence.inline(it.cls, 80) : '');
    const boxes = VIEWPORTS.map(v => `${v.width}:${fmtBox(detail.per[v.width]?.items?.[n]?.box)}`).join(' ');
    const extra = [];
    if (it.text) extra.push(`"${fence.inline(it.text, 600)}"${it.textTruncated ? `（原文 ${it.textTruncated} 字，已截断）` : ''}`);
    if (it.src) { const p = assetPathOf(it.src, detail.entryOrigin); if (p) { assets.set(p, { kind: 'image', usedBy: section.id }); extra.push(`img=${p}`); } }
    for (const b of it.bg ?? []) { const p = assetPathOf(b, detail.entryOrigin); if (p) { assets.set(p, { kind: 'image', usedBy: section.id }); extra.push(`bg=${p}`); } }
    if (it.natural?.w) extra.push(`natural=${it.natural.w}×${it.natural.h}`);
    if (it.svg) extra.push(`[inline svg ${it.svg.length}B]`);
    const attrs = Object.entries(it.attrs ?? {}).map(([k, v]) => `${k}=${fence.inline(v, 120)}`);
    if (attrs.length) extra.push(attrs.join(' '));
    if (it.heightMode) extra.push(`height=fixed(natural ${it.heightMode.natural})`);
    for (const which of ['before', 'after']) {
      const ps = it[which];
      if (!ps) continue;
      const ds = Object.entries(ps).filter(([k, v]) => k === 'content' || (v && !isDefault(k, v) && v !== 'auto' && v !== 'none' && v !== '0px')).map(([k, v]) => `${k}: ${short(v)}`);
      extra.push(`::${which}{${fence.inline(ds.join('; '), 400)}}`);
    }
    const diffs = [768, 375].map(w => {
      const o = detail.per[w]?.items?.[n];
      if (!o?.style || !it.style) return '';
      const d = props.filter(p => o.style[p] !== it.style[p]).map(p => `${p}: ${short(o.style[p])}`);
      return d.length ? ` @${w}{${d.join('; ')}}` : '';
    }).join('');
    lines.push(`e${n} ${ind}${name} ${it.style ? sigOf(it.style) : ''} [${boxes}]${extra.length ? ' ' + extra.join(' ') : ''}${diffs}`);
  }
  const sigLines = [...sigs.entries()].map(([s, id]) => `${id}: ${s || '(全为默认值)'}`);
  const facts = [];
  facts.push(`分段外接框：${VIEWPORTS.map(v => `${v.width}: ${fmtBox(detail.per[v.width]?.rootBox)}`).join('；')}（整页坐标，小数保留两位）`);
  facts.push(`起点亚像素偏移（1440）：x ${main.offset.x}、y ${main.offset.y}。外接框取整会藏住它；复刻时用同样的小数宽度或外边距`);
  facts.push(`分段背后的有效底色：${short(main.effectiveBg)}；分段自身外边距（1440）：${main.rootMargin}`);
  if (main.outer.length) {
    facts.push('外层画进来的装饰（祖先元素，按层级）：');
    for (const o of main.outer) {
      const parts = [`L${o.level} ${o.tag} [${fmtBox(o.box)}]`];
      if (o.borders) parts.push('borders ' + Object.entries(o.borders).map(([k, v]) => `${k}: ${short(v)}`).join('; '));
      if (o.boxShadow) parts.push('shadow ' + short(o.boxShadow));
      if (o.backgroundColor) parts.push('bg ' + short(o.backgroundColor));
      if (o.backgroundImage) parts.push('bg-image ' + o.backgroundImage);
      for (const w of ['before', 'after']) if (o[w]) parts.push(`::${w}{${Object.entries(o[w]).filter(([, v]) => v && v !== 'none' && v !== 'auto').map(([k, v]) => `${k}: ${short(v)}`).join('; ')}}`);
      facts.push('  ' + fence.inline(parts.join(' · '), 600));
    }
  }
  if (main.siblings.length) {
    facts.push('与分段重叠的绝对定位兄弟元素：');
    for (const s of main.siblings) facts.push('  ' + fence.inline(`${s.tag} ${s.position} [${fmtBox(s.box)}] bg ${short(s.backgroundColor)} ${s.backgroundImage !== 'none' ? s.backgroundImage : ''} z ${s.zIndex}`, 400));
  }
  const fixed = main.items.filter(i => i.heightMode).length;
  if (fixed) facts.push(`有 ${fixed} 个元素的高度被 CSS 定住（标了 height=fixed），其余由内容撑开`);
  const text = [
    ...facts,
    '',
    `## 元素（DOM 顺序 e0…；[视口:x,y,w,h] 为整页坐标；Sn = 1440 下的计算样式签名；@768 / @375 只列与 1440 不同的计算样式）`,
    ...lines,
    main.truncated ? `… 元素超过 ${main.items.length} 个，其余省略（共 ${main.total} 个）` : '',
    '',
    '## 样式签名（1440，省略默认值）',
    ...sigLines,
  ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  let rulesText = null;
  if (fidelity === 'faithful' && main.rules?.length) {
    rulesText = main.rules.map(r => `${r.media ? `@media ${r.media} { ` : ''}${r.selector} { ${r.declarations} }${r.media ? ' }' : ''}`).join('\n');
  }
  return { text, rulesText, assets, elementCount: main.items.length, truncated: main.truncated };
}

/**
 * 生成简报。opts: { detail, sectionId, fidelity, tokenBudget, refresh, browser }
 * 返回 { brief, fence } —— 由能力层把 fence.trust / warnings / redactions 放进信封
 */
export async function buildBrief(siteId, page, { detail = 'outline', sectionId, fidelity = 'balanced', tokenBudget, refresh = false, browser } = {}) {
  requireMirror(siteId, page);
  const fence = createFence();
  const manifest = readManifest(siteId, page);
  const own = !browser && detail !== 'outline';
  if (own) browser = await launchBrowser();
  try {
    const plan = detail === 'outline' && !refresh && readJson(join(briefDir(siteId, page), 'plan.json'))?.mirrorStamp === mirrorStamp(siteId, page)
      ? readJson(join(briefDir(siteId, page), 'plan.json'))
      : detail === 'outline' ? null : await ensurePlan(siteId, page, { refresh, browser });
    const brief = {
      schema: 'heimdall.brief/1', siteId, page,
      target: manifest?.target ? fence.inline(redactText(manifest.target).text, 300) : null,
      capturedAt: (() => { try { return new Date(statSync(join(pageDir(siteId, page), 'manifest.json')).mtimeMs).toISOString(); } catch { return null; } })(),
      generatedAt: new Date().toISOString(),
      viewports: VIEWPORTS.map(v => v.width), pageType: pageTypeOf(siteId, page), fidelity, detail, untrusted: true,
      captureProfile: PROFILE,
    };
    const paths = ['result.target'];
    const budget = tokenBudget ?? (detail === 'full' ? 25000 : 15000);
    if (detail === 'outline' || detail === 'sections') {
      const outline = buildOutline(readFileSync(join(pageDir(siteId, page), 'dom.html'), 'utf8'));
      let text = outline.text;
      let truncated = false;
      const maxBytes = Math.floor(budget * 3.5 * (detail === 'outline' ? 0.7 : 0.5));
      if (Buffer.byteLength(text) > maxBytes) { text = Buffer.from(text).subarray(0, maxBytes).toString('utf8').replace(/�+$/, '') + '\n… 大纲已按 tokenBudget 截断'; truncated = true; }
      brief.outline = fence.block('dom-outline', text);
      brief.outlineStats = { nodes: outline.nodes, hiddenSkipped: outline.hiddenSkipped, comments: outline.comments, bytes: outline.bytes, truncated };
      paths.push('result.outline');
      const tokens = pageTokens(siteId, page);
      if (tokens) {
        for (const key of Object.keys(tokens)) for (const t of tokens[key]) {
          if ('value' in t) t.value = fence.inline(t.value, 160);
          if ('name' in t) t.name = fence.inline(t.name, 80);
        }
        brief.tokens = tokens;
        paths.push('result.tokens');
      }
      brief.gaps = pageGaps(siteId, page).map(g => ({ ...g, detail: fence.inline(redactText(g.detail).text, 200) }));
      paths.push('result.gaps[*].detail');
      if (plan) {
        brief.fonts = summarizeFonts(plan.fonts, fence);
        paths.push('result.fonts[*].family');
      }
    }
    if (detail === 'sections') {
      brief.sections = plan.sections.map(s => ({ id: s.id, role: s.role, order: s.order, overlay: s.overlay, layered: s.layered, tag: s.tag,
        boxes: s.boxes, elementCount: s.elementCount, tokenEstimate: Math.ceil(s.elementCount * 55) }));
      brief.coverage = plan.coverage;
      brief.docSize = plan.docSize;
    }
    if (detail === 'full') {
      if (!sectionId) throw new CapabilityError('invalid_args', 'detail=full 需要 sectionId', { nextActions: [nextAction('heimdall_brief', { siteId, page, detail: 'sections' }, '先列出分段')] });
      const { section, detail: d } = await ensureSectionDetail(siteId, page, sectionId, { refresh, browser, withRules: fidelity === 'faithful' });
      const r = renderSection(section, d, fence, { fidelity });
      let body = r.text;
      let truncated = false;
      const maxBytes = Math.floor(budget * 3.5);
      if (Buffer.byteLength(body) > maxBytes) { body = Buffer.from(body).subarray(0, maxBytes).toString('utf8').replace(/�+$/, '') + '\n… 已按 tokenBudget 截断；拆成更小的分段，或调大 tokenBudget'; truncated = true; }
      brief.slice = {
        sectionId, role: section.role, boxes: section.boxes, anchor: { domPath: section.anchor.domPath },
        text: fence.block('section-detail', body),
        ...(r.rulesText ? { cssRules: fence.block('css', r.rulesText) } : {}),
        assets: [...r.assets.entries()].map(([path, a]) => ({ path, kind: a.kind })),
        elementCount: r.elementCount, truncated: truncated || r.truncated,
      };
      paths.push('result.slice.text', 'result.slice.cssRules', 'result.slice.assets[*].path');
    }
    const returned = tokenEstimate(JSON.stringify(brief));
    brief.budget = { requested: budget, returned, truncated: !!(brief.outlineStats?.truncated || brief.slice?.truncated) };
    return { brief, fence, untrustedPaths: paths };
  } finally {
    if (own) await browser.close().catch(() => {});
  }
}

function summarizeFonts(fonts, fence) {
  if (!fonts?.faces) return [];
  const map = new Map();
  for (const f of fonts.faces) {
    const key = f.family;
    const e = map.get(key) ?? { family: fence.inline(f.family, 80), weights: new Set(), styles: new Set(), files: 0 };
    e.weights.add(String(f.weight)); e.styles.add(String(f.style)); e.files += f.urls.length;
    map.set(key, e);
  }
  const loaded = new Set((fonts.loaded ?? []).map(s => s.split('|')[0]));
  return [...map.entries()].map(([family, e]) => ({ family: e.family, weights: [...e.weights], styles: [...e.styles], files: e.files, loaded: loaded.has(family) })).slice(0, 20);
}
