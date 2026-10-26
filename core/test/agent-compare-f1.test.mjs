/**
 * 快速对比 + 修复包，端到端跑在夹具 F1 上（E6-09、E6-10、E14-03、E14-13）
 *
 * 用 F1 的公开文件在临时数据根里搭一个「镜像」（路径改成相对路径，与真实镜像一致），
 * 候选是夹具服务本身：不注入时应当 pass-candidate；注入缺陷时，缺陷所在元素必须落在修复包前 3 个区域里。
 * 需要本机 Chromium；只测 1440 一个视口以控制时长（三视口在 smoke 里跑）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});

for (const id of ['f1-shift-hero-art', 'f1-color-cta-band', 'f1-missing-content-stats', 'f1-image-missing-avatar', 'f1-spacing-features-padding']) {
  test(`compare F1: injected ${id} is found in the top 3 regions`, { timeout: 180_000 }, async () => {
    const c = CASES.find(x => x.id === id);
    const truth = await truthBox(c.selector);
    assert.ok(truth, 'selector exists in the reference');
    const r = await fastCompare({ siteId: SITE, page: PAGE, candidate: { url: `${fixture.url}?inject=${id}` }, viewports: [1440] }, { browser });
    const top = r.packet.order.slice(0, 3).map(rid => r.packet.regions.find(g => g.id === rid));
    assert.notEqual(r.packet.verdict.status, 'pass-candidate', 'a defect must not pass');
    assert.ok(top.some(g => overlaps(g.bbox, truth)), `top-3 ${JSON.stringify(top.map(g => [g.id, g.cause, g.bbox]))} vs truth ${JSON.stringify(truth)}`);
    for (const g of r.packet.regions) {
      assert.ok(g.hint && !/<<<|>>>/.test(g.hint), 'hints are Heimdall text, never fenced web content');
    }
  });
}

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
