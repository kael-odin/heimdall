/**
 * agent/evidence/reference — 参考包 ReferencePack（heimdall.reference/1，PRD 附录 C §5）
 *
 * 页面的冻结参考：快速与正式两个裁判都以它为基线，而不是会漂移的活站。
 * 存于 workspace/<siteId>/agent/ref/<page>/：ref.json + <视口>.png（+ <视口>.mask.png，有动态区域时）。
 *
 * 拍摄走 serveStatic（不加 CSP sandbox，Web 字体才能加载，见 agent/serve.mjs）与 capture.mjs 的统一流程。
 * 每个视口拍两次：两次不一致的像素就是动态区域（轮播、计时器、动图），记成遮罩、不计入像素分（E6-12）。
 * 镜像内容、资产或拍摄条件变化，或截图证据损坏时重拍。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { WORKSPACE } from '../../paths.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';
import { sha256, refIdOf } from '../ids.mjs';
import { CapabilityError } from '../envelope.mjs';
import { serveStatic } from '../serve.mjs';
import { agentDir, mirrorEntry, mirrorIdentity, readManifest, requireMirror } from '../workspace.mjs';
import { CHANNEL_T, readPng, writePng } from './image.mjs';
import { PROFILE, launchBrowser, openPage, shoot, viewportOf } from './capture.mjs';
import { sectionDetail } from '../brief/inspect.mjs';
import { INDEX_STYLE_PROPS, compactStyle } from './element-style.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export const referenceDir = (siteId, page) => join(agentDir(siteId), 'ref', page);

function referenceId(meta) {
  return refIdOf(meta.siteId, meta.page, JSON.stringify([meta.capturedAt, meta.mirrorIdentity, meta.profile,
    Object.entries(meta.viewports ?? {}).sort(([a], [b]) => Number(a) - Number(b))
      .map(([width, viewport]) => [width, viewport.screenshot?.sha256, viewport.artifacts?.['mask.png'] ?? null]) ]));
}

function diffMask(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { mask: null, px: -1 };
  const mask = new Uint8Array(a.width * a.height);
  let px = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (Math.abs(a.data[p] - b.data[p]) > CHANNEL_T || Math.abs(a.data[p + 1] - b.data[p + 1]) > CHANNEL_T || Math.abs(a.data[p + 2] - b.data[p + 2]) > CHANNEL_T) {
      mask[i] = 1; px++;
    }
  }
  return { mask: px ? mask : null, px };
}

/** 动态遮罩存成黑白 PNG（白 = 动态），供 compare 读取 */
function writeMask(file, mask, width, height) {
  const img = new PNG({ width, height });
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) { const v = mask[i] ? 255 : 0; img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v; img.data[p + 3] = 255; }
  writePng(file, img);
}

export function readElements(siteId, page, width) {
  try { return JSON.parse(readFileSync(join(referenceDir(siteId, page), `${width}.elements.json`), 'utf8')); } catch { return []; }
}

export function readMask(siteId, page, width) {
  const file = join(referenceDir(siteId, page), `${width}.mask.png`);
  if (!existsSync(file)) return null;
  const img = readPng(file);
  const mask = new Uint8Array(img.width * img.height);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) mask[i] = img.data[p] > 127 ? 1 : 0;
  return mask;
}

/** 已有且新鲜的参考包；否则 null */
export function loadReference(siteId, page, viewports = [375, 768, 1440]) {
  const pdir = requireMirror(siteId, page);
  const dir = referenceDir(siteId, page);
  const meta = readJson(join(dir, 'ref.json'));
  if (!meta || meta.siteId !== siteId || meta.page !== page || JSON.stringify(meta.profile) !== JSON.stringify(PROFILE)) return null;
  const stamp = statSync(join(pdir, 'clone', 'index.html')).mtimeMs;
  if (meta.mirrorStamp !== stamp || meta.mirrorIdentity !== mirrorIdentity(siteId, page)) return null;
  try {
    if (meta.refId !== referenceId(meta)) return null;
    if (!viewports.every(w => {
      const viewport = meta.viewports?.[w];
      if (!viewport || sha256(readFileSync(join(dir, `${w}.png`))) !== viewport.screenshot?.sha256) return false;
      return ['mask.png', 'elements.json'].every(name => {
        const file = join(dir, `${w}.${name}`), expected = viewport.artifacts?.[name];
        return expected ? sha256(readFileSync(file)) === expected : !existsSync(file);
      });
    })) return null;
  } catch { return null; }
  return { meta, dir };
}

/**
 * 取得参考包：新鲜就复用，否则拍摄。browser 可由调用方传入以复用同一个 Chromium。
 * sections（分段计划里的 [{id, anchors}]）给出时，同一次打开里顺带量元素索引：
 * 每个元素 { ref: 'sec-…/e12', sectionId, sel, text, textual, img, box }，编号与简报 detail=full 的 e0… 一致，
 * 修复包据此说出「这是简报里的哪个元素」。存于 <视口>.elements.json。
 * 返回 { meta, dir, reused }
 */
export async function ensureReference(siteId, page, { viewports = [375, 768, 1440], refresh = false, browser, stabilityCheck = true, sections = null } = {}) {
  if (!refresh) {
    const hit = loadReference(siteId, page, viewports);
    if (hit && (!sections || viewports.every(w => existsSync(join(hit.dir, `${w}.elements.json`))))) return { ...hit, reused: true };
  }
  const pdir = requireMirror(siteId, page);
  const dir = referenceDir(siteId, page);
  mkdirSync(dir, { recursive: true });
  const stamp = statSync(join(pdir, 'clone', 'index.html')).mtimeMs;
  const identity = mirrorIdentity(siteId, page);
  const manifestStat = (() => { try { return statSync(join(pdir, 'manifest.json')); } catch { return null; } })();
  const capturedAt = new Date(manifestStat?.mtimeMs ?? stamp).toISOString();
  const previous = readJson(join(dir, 'ref.json'));
  const same = previous?.mirrorStamp === stamp && previous.mirrorIdentity === identity && JSON.stringify(previous.profile) === JSON.stringify(PROFILE);
  const meta = {
    schema: 'heimdall.reference/1',
    siteId, page, capturedAt, generatedAt: new Date().toISOString(),
    source: { mirrorPath: relative(WORKSPACE, pdir).replace(/\\/g, '/'), viewportEntries: same ? { ...previous.source?.viewportEntries } : {}, originalUrl: readManifest(siteId, page)?.target ?? null },
    scoreVersion: 2,
    profile: PROFILE,
    mirrorStamp: stamp,
    mirrorIdentity: identity,
    viewports: { ...(same ? previous.viewports : {}) },
    masks: same ? (previous.masks ?? []).filter(mask => !viewports.includes(mask.viewport)) : [],
    maskCoveragePct: same ? { ...previous.maskCoveragePct } : {},
  };
  const srv = await serveStatic(pdir);
  const own = !browser;
  browser ??= await launchBrowser();
  try {
    for (const width of viewports) {
      const vp = viewportOf(width);
      if (!vp) continue;
      rmSync(join(dir, `${width}.mask.png`), { force: true });
      rmSync(join(dir, `${width}.elements.json`), { force: true });
      const entry = mirrorEntry(siteId, page, width);
      const url = `${srv.origin}/${entry}`;
      const first = await openPage(browser, url, vp);
      const img = await shoot(first.page);
      if (sections?.length) {
        const index = [];
        for (const s of sections) {
          const d = await first.page.evaluate(sectionDetail, { anchors: s.anchors, props: INDEX_STYLE_PROPS, pseudoProps: [], withStyle: true, maxElements: 600 });
          for (const it of d?.items ?? []) {
            if (!it.visible || !it.box) continue;
            index.push({ ref: `${s.id}/e${it.i}`, sectionId: s.id, sel: it.tag, ...(it.text ? { text: it.text } : {}),
              ...(it.cls ? { cls: it.cls } : {}), ...(it.id ? { id: it.id } : {}), depth: it.depth,
              textual: !!it.textual, img: !!it.img,
              ...(it.src ? { src: it.src } : {}), box: { x: Math.round(it.box.x), y: Math.round(it.box.y), w: Math.round(it.box.w), h: Math.round(it.box.h) },
              ...(compactStyle(it.style) ? { style: compactStyle(it.style) } : {}) });
          }
        }
        writeFileAtomic(join(dir, `${width}.elements.json`), JSON.stringify(index));
      }
      await first.ctx.close();
      let maskPct = 0;
      if (stabilityCheck) {
        const second = await openPage(browser, url, vp);
        const again = await shoot(second.page);
        await second.ctx.close();
        const { mask, px } = diffMask(img, again);
        if (px < 0) meta.masks.push({ viewport: width, kind: 'unstable-height', source: 'repeat-capture', areaPct: 100 });
        else if (mask) {
          writeMask(join(dir, `${width}.mask.png`), mask, img.width, img.height);
          maskPct = +(px / (img.width * img.height) * 100).toFixed(3);
          meta.masks.push({ viewport: width, kind: 'dynamic', source: 'repeat-capture', areaPct: maskPct });
        }
      }
      const file = join(dir, `${width}.png`);
      writePng(file, img);
      const bytes = readFileSync(file);
      meta.viewports[width] = {
        fullPageSize: { w: img.width, h: img.height }, settled: first.settled,
        screenshot: { uri: `heimdall://site/${siteId}/page/${page}/ref/${width}.png`, sha256: sha256(bytes), bytes: bytes.length, mime: 'image/png' },
        artifacts: Object.fromEntries(['mask.png', 'elements.json'].filter(name => existsSync(join(dir, `${width}.${name}`)))
          .map(name => [name, sha256(readFileSync(join(dir, `${width}.${name}`)))])),
      };
      meta.source.viewportEntries[width] = entry;
      meta.maskCoveragePct[width] = maskPct;
    }
  } finally {
    if (own) await browser.close().catch(() => {});
    await srv.close();
  }
  if (mirrorIdentity(siteId, page) !== identity) throw new CapabilityError('invalid_args', '镜像在参考拍摄期间发生变化，请重试');
  meta.refId = referenceId(meta);
  writeFileAtomic(join(dir, 'ref.json'), JSON.stringify(meta, null, 2));
  return { meta, dir, reused: false };
}
