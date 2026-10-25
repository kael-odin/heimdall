/**
 * agent/evidence/reference — 参考包 ReferencePack（heimdall.reference/1，PRD 附录 C §5）
 *
 * 页面的冻结参考：快速与正式两个裁判都以它为基线，而不是会漂移的活站。
 * 存于 workspace/<siteId>/agent/ref/<page>/：ref.json + <视口>.png（+ <视口>.mask.png，有动态区域时）。
 *
 * 拍摄走 serveStatic（不加 CSP sandbox，Web 字体才能加载，见 agent/serve.mjs）与 capture.mjs 的统一流程。
 * 每个视口拍两次：两次不一致的像素就是动态区域（轮播、计时器、动图），记成遮罩、不计入像素分（E6-12）。
 * 镜像（clone/index.html）比参考新、或拍摄流程版本变了，就重拍。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PNG } from 'pngjs';
import { WORKSPACE } from '../../paths.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';
import { sha256, refIdOf } from '../ids.mjs';
import { serveStatic } from '../serve.mjs';
import { agentDir, mirrorEntry, readManifest, requireMirror } from '../workspace.mjs';
import { CHANNEL_T, readPng, writePng } from './image.mjs';
import { PROFILE, launchBrowser, openPage, shoot, viewportOf } from './capture.mjs';
import { sectionDetail } from '../brief/inspect.mjs';

const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };

export const referenceDir = (siteId, page) => join(agentDir(siteId), 'ref', page);

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
  if (!meta || meta.profile?.version !== PROFILE.version) return null;
  const stamp = statSync(join(pdir, 'clone', 'index.html')).mtimeMs;
  if (meta.mirrorStamp !== stamp) return null;
  if (!viewports.every(w => meta.viewports?.[w] && existsSync(join(dir, `${w}.png`)))) return null;
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
  const manifestStat = (() => { try { return statSync(join(pdir, 'manifest.json')); } catch { return null; } })();
  const capturedAt = new Date(manifestStat?.mtimeMs ?? stamp).toISOString();
  const previous = readJson(join(dir, 'ref.json'));
  const meta = {
    schema: 'heimdall.reference/1',
    refId: refIdOf(siteId, page, capturedAt),
    siteId, page, capturedAt, generatedAt: new Date().toISOString(),
    source: { mirrorPath: relative(WORKSPACE, pdir).replace(/\\/g, '/'), viewportEntries: {}, originalUrl: readManifest(siteId, page)?.target ?? null },
    scoreVersion: 2,
    profile: PROFILE,
    mirrorStamp: stamp,
    viewports: { ...(previous?.mirrorStamp === stamp ? previous.viewports : {}) },
    masks: [],
    maskCoveragePct: {},
  };
  const srv = await serveStatic(pdir);
  const own = !browser;
  browser ??= await launchBrowser();
  try {
    for (const width of viewports) {
      const vp = viewportOf(width);
      if (!vp) continue;
      const entry = mirrorEntry(siteId, page, width);
      const url = `${srv.origin}/${entry}`;
      const first = await openPage(browser, url, vp);
      const img = await shoot(first.page);
      if (sections?.length) {
        const index = [];
        for (const s of sections) {
          const d = await first.page.evaluate(sectionDetail, { anchors: s.anchors, props: [], pseudoProps: [], withStyle: false, maxElements: 600 });
          for (const it of d?.items ?? []) {
            if (!it.visible || !it.box) continue;
            index.push({ ref: `${s.id}/e${it.i}`, sectionId: s.id, sel: it.tag, ...(it.text ? { text: it.text } : {}), textual: !!it.textual, img: !!it.img,
              ...(it.src ? { src: it.src } : {}), box: { x: Math.round(it.box.x), y: Math.round(it.box.y), w: Math.round(it.box.w), h: Math.round(it.box.h) } });
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
      };
      meta.source.viewportEntries[width] = entry;
      meta.maskCoveragePct[width] = maskPct;
    }
  } finally {
    if (own) await browser.close().catch(() => {});
    await srv.close();
  }
  writeFileAtomic(join(dir, 'ref.json'), JSON.stringify(meta, null, 2));
  return { meta, dir, reused: false };
}
