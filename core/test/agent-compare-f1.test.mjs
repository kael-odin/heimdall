/**
 * 快速对比 + 修复包，端到端跑在夹具 F1 上（E6-09、E6-10、E14-03、E14-13）
 *
 * 用 F1 的公开文件在临时数据根里搭一个「镜像」（路径改成相对路径，与真实镜像一致），
 * 候选是夹具服务本身：不注入时应当 pass-candidate；注入缺陷时，缺陷所在元素必须落在修复包前 3 个区域里。
 * 需要本机 Chromium；只测 1440 一个视口以控制时长（三视口在 smoke 里跑）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const F1 = fileURLToPath(new URL('./fixtures/bench/f1/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'heimdall-f1-'));
process.env.HEIMDALL_DATA_DIR = root;   // 必须在加载 paths.mjs 之前

let fixture, fastCompare, launchBrowser, openPage, viewportOf, CASES, browser;
const SITE = 'f1.test', PAGE = 'home';

before(async () => {
  ({ startFixture: globalThis.__start, CASES } = await import('./fixtures/bench/f1/server.mjs'));
  fixture = await globalThis.__start();
  // 搭镜像：public/ 拷进 clone/，生成的位图从夹具取回落盘，绝对路径改成相对路径
  const clone = join(root, 'workspace', SITE, 'pages', PAGE, 'clone');
  mkdirSync(join(clone, 'img'), { recursive: true });
  cpSync(join(F1, 'public'), clone, { recursive: true });
  for (const name of ['hero-art.png', 'avatar.png']) {
    const buf = Buffer.from(await (await fetch(`${fixture.origin}/img/${name}`)).arrayBuffer());
    writeFileSync(join(clone, 'img', name), buf);
  }
  const html = readFileSync(join(clone, 'index.html'), 'utf8').replace(/(href|src)="\//g, '$1="./');
  writeFileSync(join(clone, 'index.html'), html);
  writeFileSync(join(clone, 'styles.css'), readFileSync(join(clone, 'styles.css'), 'utf8').replace(/url\("\/fonts\//g, 'url("fonts/'));
  const pdir = join(root, 'workspace', SITE, 'pages', PAGE);
  writeFileSync(join(pdir, 'manifest.json'), JSON.stringify({ target: fixture.url }));
  writeFileSync(join(pdir, 'dom.html'), html);
  ({ fastCompare } = await import('../src/agent/evidence/compare.mjs'));
  ({ launchBrowser, openPage, viewportOf } = await import('../src/agent/evidence/capture.mjs'));
  browser = await launchBrowser();
});

after(async () => {
  await browser?.close().catch(() => {});
  await fixture?.close();
  rmSync(root, { recursive: true, force: true });
});

/** 注入元素在参考页（不注入）里的整页外接框 */
async function truthBox(selector) {
  const { page, ctx } = await openPage(browser, fixture.url, viewportOf(1440));
  const box = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    if (!els.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const el of els) { const r = el.getBoundingClientRect(); x0 = Math.min(x0, r.left + scrollX); y0 = Math.min(y0, r.top + scrollY); x1 = Math.max(x1, r.right + scrollX); y1 = Math.max(y1, r.bottom + scrollY); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }, selector);
  await ctx.close();
  return box;
}

const overlaps = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0;
};

test('compare F1: the unmodified page is a pass-candidate at gold', { timeout: 180_000 }, async () => {
  const r = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: fixture.url }, viewports: [1440] }, { browser });
  assert.equal(r.packet.verdict.status, 'pass-candidate');
  assert.equal(r.packet.verdict.reached, 'gold');
  assert.ok(r.packet.perViewport[1440].pixelSimilarity >= 0.999);
  assert.equal(r.packet.schema, 'heimdall.fixpacket/1');
  assert.ok(r.fixpacketEvidence.sha256.length === 64);
  assert.equal(r.packet.anticheat.status, 'clean', 'an honest page raises no anti-cheat finding');
  const { composeGate } = await import('../src/agent/gate/report.mjs');
  const g = composeGate(r.packet, { level: 'gold' });
  assert.equal(g.status, 'passed', JSON.stringify(g.dimensions.map(d => [d.id, d.status, d.detail])));
  assert.equal(g.reached, 'gold');
});

for (const id of ['f1-shift-hero-art', 'f1-color-cta-band', 'f1-missing-content-stats', 'f1-image-missing-avatar', 'f1-spacing-features-padding']) {
  test(`compare F1: injected ${id} is found in the top 3 regions`, { timeout: 180_000 }, async () => {
    const c = CASES.find(x => x.id === id);
    const truth = await truthBox(c.selector);
    assert.ok(truth, 'selector exists in the reference');
    const r = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: `${fixture.url}?inject=${id}` }, viewports: [1440] }, { browser });
    assert.equal(r.packet.trend.previousRunId, undefined, 'a distinct candidate URL starts its own trend');
    const top = r.packet.order.slice(0, 3).map(rid => r.packet.regions.find(g => g.id === rid));
    assert.notEqual(r.packet.verdict.status, 'pass-candidate', 'a defect must not pass');
    assert.ok(top.some(g => overlaps(g.bbox, truth)), `top-3 ${JSON.stringify(top.map(g => [g.id, g.cause, g.bbox]))} vs truth ${JSON.stringify(truth)}`);
    for (const g of r.packet.regions) {
      assert.ok(g.hint && !/<<<|>>>/.test(g.hint), 'hints are Heimdall text, never fenced web content');
    }
  });
}

test('compare F1: the fix packet carries the candidate value and a signed diff', { timeout: 240_000 }, async () => {
  const checks = [
    { id: 'f1-font-hero-title-size', prop: 'fontSize', ref: '52px', cand: '46px', delta: -6 },
    { id: 'f1-color-primary-button', prop: 'backgroundColor', ref: /rgb\(47,\s*91,\s*234\)/, cand: /rgb\(230,\s*57,\s*70\)/ },
    { id: 'f1-spacing-hero-actions-gap', prop: 'gap', ref: '16px', cand: '40px', delta: 24 },
  ];
  for (const check of checks) {
    const r = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: `${fixture.url}?inject=${check.id}` }, viewports: [1440] }, { browser });
    const elements = r.packet.regions.flatMap(g => [
      ...(g.element?.best ?? []).map(e => ({ region: g.id, e })),
      ...(g.element?.container ? [{ region: g.id, e: g.element.container }] : []),
      ...(g.element?.diffs ?? []).map(e => ({ region: g.id, e })),
    ]);
    const hit = elements.find(({ e }) => (e.styleDiff ?? []).some(d => d.prop === check.prop));
    assert.ok(hit, `${check.id}: no styleDiff for ${check.prop}; regions=${JSON.stringify(elements.map(({ region, e }) => ({ region, ref: e.ref, cand: e.cand?.style, diff: e.styleDiff })))}`);
    const diff = hit.e.styleDiff.find(d => d.prop === check.prop);
    if (check.ref instanceof RegExp) {
      assert.match(diff.ref, check.ref, `${check.id}: reference value`);
      assert.match(diff.cand, check.cand, `${check.id}: candidate value`);
    } else {
      assert.equal(diff.ref, check.ref, `${check.id}: reference value`);
      assert.equal(diff.cand, check.cand, `${check.id}: candidate value`);
    }
    if (check.delta !== undefined) assert.equal(diff.delta, check.delta, `${check.id}: signed delta`);
    assert.match(r.text, /样式差/, `${check.id}: packet.txt prints the diff`);
  }
});

test('candidate trends isolate complete URLs, legacy mixed records and viewport groups', { timeout: 180_000 }, async () => {
  const { ensureReference } = await import('../src/agent/evidence/reference.mjs');
  const { sha256 } = await import('../src/agent/ids.mjs');
  const ref = await ensureReference(SITE, PAGE, { viewports: [375, 1440], browser });
  const dir = join(root, 'workspace', SITE, 'agent', 'compare');
  mkdirSync(dir, { recursive: true });
  const url = new URL(fixture.url), legacyId = 'run_20260101T000000Z_123456';
  appendFileSync(join(dir, 'index.jsonl'), JSON.stringify({ runId: legacyId, mode: 'fast', referenceId: ref.meta.refId,
    candidateKey: sha256(`${SITE}|${PAGE}|${url.origin + url.pathname}|`).slice(0, 16), pixel: { 1440: 0 } }) + '\n');
  const compare = async (suffix, width = 1440) => (await fastCompare({ siteId: SITE, page: PAGE,
    candidate: { url: fixture.url + suffix }, viewports: [width] }, { browser })).packet;
  assert.notEqual((await compare('')).trend.previousRunId, legacyId, 'legacy records may contain other query or hash routes');
  const previous = new Map();
  for (const suffix of ['?candidate=a', '?candidate=b', '?candidate=a#one', '?candidate=a#two', '?candidate=a#one', '?candidate=a']) {
    const packet = await compare(suffix);
    assert.equal(packet.trend.previousRunId, previous.get(suffix), suffix);
    assert.equal(packet.verdict.status, 'pass-candidate');
    previous.set(suffix, packet.runId);
  }
  const desktop = await compare('?candidate=viewports');
  const mobile = await compare('?candidate=viewports', 375);
  assert.equal(mobile.trend.previousRunId, undefined, 'the first mobile run cannot compare with desktop pixels');
  assert.equal((await compare('?candidate=viewports')).trend.previousRunId, desktop.runId);
  assert.equal((await compare('?candidate=viewports', 375)).trend.previousRunId, mobile.runId);
});

test('compare F1: section mode attaches candidate style evidence', { timeout: 240_000 }, async () => {
  const { ensurePlan } = await import('../src/agent/brief/brief.mjs');
  const { startBaselineServer } = await import('../src/agent/gate/baseline.mjs');
  const plan = await ensurePlan(SITE, PAGE, { browser });
  const hero = plan.sections.find(s => s.role === 'hero' && s.boxes[1440]) ?? plan.sections.find(s => s.boxes[1440]);
  assert.ok(hero, 'the fixture plan has a measurable hero section');

  // 候选页 = 原页 + 分段标记 + 一个字号缺陷；走 sectionIds 的单段路径。
  const { page, ctx } = await openPage(browser, fixture.url, viewportOf(1440));
  for (const s of plan.sections) {
    const anchor = s.anchors?.[0];
    if (!anchor) continue;
    await page.evaluate(({ anchor, id }) => {
      const el = document.querySelector(anchor);
      if (el) el.setAttribute('data-heimdall-section', id);
    }, { anchor, id: s.id });
  }
  let html = await page.content();
  await ctx.close();
  html = html.replace('</head>', '<style>.hero h1{font-size:46px}</style></head>');
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-f1-section-'));
  cpSync(join(F1, 'public'), dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), html);
  const server = await startBaselineServer(dir);
  try {
    const r = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: server.origin + '/' }, sectionIds: [hero.id], viewports: [1440] }, { browser });
    const all = r.packet.regions.flatMap(g => [
      ...(g.element?.best ?? []),
      ...(g.element?.container ? [g.element.container] : []),
      ...(g.element?.diffs ?? []),
    ]);
    const hit = all.find(e => (e.styleDiff ?? []).some(d => d.prop === 'fontSize' && d.cand === '46px'));
    assert.ok(hit, JSON.stringify(all.map(e => ({ ref: e.ref, cand: e.cand?.style?.fontSize, diff: e.styleDiff }))));
    assert.equal(hit.cand?.sectionId, hero.id, 'candidate evidence is attributed to the marked section');
    assert.match(r.text, /样式差/);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare F1: pasting the reference screenshot is caught even though the pixels match', { timeout: 180_000 }, async () => {
  const { ensureReference } = await import('../src/agent/evidence/reference.mjs');
  const { startBaselineServer } = await import('../src/agent/gate/baseline.mjs');
  const ref = await ensureReference(SITE, PAGE, { viewports: [1440], browser });
  const cheatDir = mkdtempSync(join(tmpdir(), 'heimdall-cheat-'));
  writeFileSync(join(cheatDir, 'ref.png'), readFileSync(join(ref.dir, '1440.png')));
  writeFileSync(join(cheatDir, 'index.html'), '<!doctype html><html><body style="margin:0"><img src="/ref.png" style="display:block;width:100%"></body></html>');
  const server = await startBaselineServer(cheatDir);
  try {
    const r = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: `${server.origin}/` }, viewports: [1440] }, { browser });
    assert.ok(r.packet.perViewport[1440].pixelSimilarity >= 0.99, `the pixels ARE the reference (${r.packet.perViewport[1440].pixelSimilarity})`);
    assert.equal(r.packet.anticheat.status, 'suspect');
    assert.ok(r.packet.anticheat.findings.some(f => f.code === 'reference_screenshot_reused'), JSON.stringify(r.packet.anticheat.findings));
    assert.equal(r.packet.verdict.status, 'fail', 'high pixels do not survive an anti-cheat hit');
    assert.equal(r.packet.verdict.anticheat, true);
    assert.match(r.text, /反作弊/);
  } finally {
    await server.close();
    rmSync(cheatDir, { recursive: true, force: true });
  }
});

test('mirror asset changes invalidate plans, details, reference images and trend baselines', { timeout: 180_000 }, async () => {
  const { ensurePlan, ensureSectionDetail } = await import('../src/agent/brief/brief.mjs');
  const { ensureReference, loadReference } = await import('../src/agent/evidence/reference.mjs');
  const clone = join(root, 'workspace', SITE, 'pages', PAGE, 'clone');
  const css = join(clone, 'styles.css'), original = readFileSync(css), stamp = statSync(css);
  const entryStamp = statSync(join(clone, 'index.html')).mtimeMs;
  const plan = await ensurePlan(SITE, PAGE, { browser });
  const hero = plan.sections.find(s => s.role === 'hero') ?? plan.sections[0];
  const detail = await ensureSectionDetail(SITE, PAGE, hero.id, { browser });
  const reference = await ensureReference(SITE, PAGE, { viewports: [375, 1440], browser });
  const first = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: fixture.url }, viewports: [1440] }, { browser });
  try {
    assert.ok(loadReference(SITE, PAGE, [1440]));
    writeFileSync(css, Buffer.concat([original, Buffer.from('\n.hero h1{font-size:60px!important}') ]));
    utimesSync(css, stamp.atime, stamp.mtime);
    assert.equal(statSync(join(clone, 'index.html')).mtimeMs, entryStamp);
    assert.equal(loadReference(SITE, PAGE, [1440]), null, 'a changed stylesheet must invalidate the frozen reference');
    const updatedPlan = await ensurePlan(SITE, PAGE, { browser });
    assert.notEqual(updatedPlan.mirrorIdentity, plan.mirrorIdentity);
    const updated = await ensureSectionDetail(SITE, PAGE, hero.id, { browser });
    assert.notEqual(updated.detail.mirrorIdentity, detail.detail.mirrorIdentity);
    assert.ok(updated.detail.per[1440].items.some(item => item.tag === 'h1' && item.style?.fontSize === '60px'));
    const second = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: fixture.url }, viewports: [1440] }, { browser });
    assert.notEqual(second.packet.reference.refId, first.packet.reference.refId);
    assert.notEqual(second.packet.verdict.status, 'pass-candidate');
    assert.equal(second.packet.trend.previousRunId, undefined, 'changed references cannot share score trends');
    assert.equal(loadReference(SITE, PAGE, [375]), null, 'the previous viewport must not survive a changed mirror');
    const mask = join(reference.dir, '1440.mask.png');
    cpSync(join(reference.dir, '1440.png'), mask);
    assert.equal(loadReference(SITE, PAGE, [1440]), null, 'an unrecorded mask cannot be used with a cached screenshot');
    const refreshed = await ensureReference(SITE, PAGE, { viewports: [1440], refresh: true, stabilityCheck: false, browser });
    assert.equal(existsSync(mask), false, 'an old dynamic mask cannot survive a fresh unmasked capture');
    assert.equal(refreshed.meta.refId, second.packet.reference.refId, 'unchanged image evidence keeps the reference identity');
    const refFile = join(reference.dir, 'ref.json');
    writeFileSync(refFile, JSON.stringify({ ...refreshed.meta, refId: reference.meta.refId }));
    assert.equal(loadReference(SITE, PAGE, [1440]), null, 'a stale reference ID cannot describe different image evidence');
    writeFileSync(refFile, JSON.stringify(refreshed.meta));
    writeFileSync(join(reference.dir, '1440.png'), 'damaged evidence');
    assert.equal(loadReference(SITE, PAGE, [1440]), null, 'reference evidence must match its recorded hash');
  } finally { writeFileSync(css, original); utimesSync(css, stamp.atime, stamp.mtime); }
});
