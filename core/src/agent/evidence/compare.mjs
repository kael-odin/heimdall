/**
 * agent/evidence/compare — 快速对比（E6-09、E6-10、E6-13，PRD 05 §3.1、附录 C §6）
 *
 * 把候选（AI 写的页面）对照冻结参考，返回判定 + 修复包 + 趋势。**快速裁判不能宣布 passed**，
 * 最好的结果是 pass-candidate，正式门禁在 Ph2 由验收 Mirror + 评估器给出。
 *
 * 两种范围：
 *   整页    参考整页截图 vs 候选整页截图
 *   分段    给了 sectionIds 时：候选页里带 data-heimdall-section="<id>" 的元素就按它裁两侧，
 *           分段之间互不干扰；候选没标记时退回整页对比，只保留落在这些分段里的区域
 *
 * 落盘：workspace/<siteId>/agent/compare/<runId>/{fixpacket.json, packet.txt, crops/*.png}；
 * 项目目录模式另写一份到 <project>/.heimdall/runs/<runId>/，shell 型代理直接读文件即可。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../../paths.mjs';
import { writeFileAtomic } from '../../fsutil.mjs';
import { CapabilityError, nextAction } from '../envelope.mjs';
import { createFence } from '../fence.mjs';
import { newRunId, sha256, RUN_ID } from '../ids.mjs';
import { agentDir, requireMirror } from '../workspace.mjs';
import { ensurePlan } from '../brief/brief.mjs';
import { crop, readPng } from './image.mjs';
import { analyzeViewport, writeCrop, verdictOf, packetText, GATES } from './fixpacket.mjs';
import { ensureReference, readElements, readMask } from './reference.mjs';
import { PROFILE, launchBrowser, openPage, shoot, sectionBox, viewportOf } from './capture.mjs';

const REGIONS_PER_VIEWPORT = 12;
const CROPS_PER_VIEWPORT = 4;
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; } };
const inter = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

export const compareDir = (siteId) => join(agentDir(siteId), 'compare');

/** 由 runId 找到它所在的站点（runId 全局唯一；站点数很少，直接扫） */
export function locateRun(runId) {
  if (!RUN_ID.test(String(runId))) return null;
  for (const site of existsSync(WORKSPACE) ? readdirSync(WORKSPACE) : []) {
    const dir = join(WORKSPACE, site, 'agent', 'compare', runId);
    try { if (statSync(dir).isDirectory()) return { siteId: site, dir }; } catch {}
  }
  return null;
}

/** 候选的身份：URL（去掉查询与片段）或项目目录。趋势按它找「同一候选的上一次」 */
const candidateKey = (siteId, page, candidate, route) => sha256(`${siteId}|${page}|${candidate.url ? new URL(candidate.url).origin + new URL(candidate.url).pathname : 'dir:' + candidate.dir}|${route ?? ''}`).slice(0, 16);

function readIndex(siteId) {
  const file = join(compareDir(siteId), 'index.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** 趋势（E6-13）：与同一候选的历史比较 */
export function trendOf(history, current, { sameEps = 0.001, stagnantEps = 0.002 } = {}) {
  const prev = history[history.length - 1];
  if (!prev) return { state: 'same', note: '第一次对比' };
  const vps = Object.keys(current);
  const deltaPixel = Object.fromEntries(vps.map(vp => [vp, prev.pixel?.[vp] === undefined ? null : +(current[vp] - prev.pixel[vp]).toFixed(5)]));
  const mean = (o) => { const v = Object.values(o).filter(x => typeof x === 'number'); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
  const d = mean(deltaPixel);
  let state = d > sameEps ? 'better' : d < -sameEps ? 'worse' : 'same';
  // 振荡：最近 4 次的平均分升降交替；停滞：最近 3 次每次变化都 < 0.2 个百分点且没到顶
  const seq = [...history.slice(-3).map(h => mean(h.pixel ?? {})), mean(current)];
  const diffs = seq.slice(1).map((v, i) => v - seq[i]);
  if (diffs.length >= 3 && diffs.every((x, i) => i === 0 || Math.sign(x) !== Math.sign(diffs[i - 1])) && diffs.every(x => Math.abs(x) > sameEps)) state = 'oscillating';
  else if (diffs.length >= 3 && diffs.every(x => Math.abs(x) < stagnantEps) && mean(current) < 0.995) state = 'stagnant';
  return { state, previousRunId: prev.runId, deltaPixel };
}

/** 读重建工作区配置（dir 模式） */
export function readProjectConfig(dir) {
  const file = join(dir, 'heimdall.config.json');
  const cfg = readJson(file);
  if (!cfg) throw new CapabilityError('invalid_args', `${dir} 下没有可读的 heimdall.config.json`, { hint: '在重建工作区里运行，或先 `heimdall rebuild init`' });
  return cfg;
}

/**
 * 反作弊（E7-18 的 Ph1 形态）：候选的源码不得引用 .heimdall/（参考截图、简报）。
 * 以参考截图充当内容会让像素分虚高，而交付物毫无价值。扫描项目根与 src/ 下的源码文件（不进 node_modules）。
 */
export function referencesToHeimdall(dir) {
  const hits = [];
  const exts = /\.(?:html?|css|scss|jsx?|tsx?|vue|svelte|mjs)$/i;
  const visit = (d, depth) => {
    if (depth > 6 || hits.length >= 5) return;
    for (const name of readdirSync(d)) {
      if (name === 'node_modules' || name === '.heimdall' || name === '.git' || name === 'dist' || name === 'public') continue;
      const p = join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) visit(p, depth + 1);
      // 只认「被当作路径使用」的引用：引号、反引号或 url( 之后紧跟（./ ../ /）.heimdall/；注释里提到这个目录不算
      else if (exts.test(name) && st.size < 2_000_000 && /["'`(]\s*(?:\.{0,2}\/)?\.heimdall[\\/]/.test(readFileSync(p, 'utf8'))) hits.push(p.slice(dir.length + 1).replace(/\\/g, '/'));
    }
  };
  visit(dir, 0);
  return hits;
}

async function reachable(url) {
  try { const r = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(5000) }); return r.status < 500; } catch { return false; }
}

/**
 * 快速对比。
 * @param {object} args { siteId, page, candidate:{url}|{dir}, route?, viewports?, sectionIds?, gate?, baselineRunId? }
 * @returns {Promise<{ result, evidence, fence, packetFile, summary, nextActions, warnings }>}
 */
export async function fastCompare(args, { browser: sharedBrowser, onProgress } = {}) {
  const t0 = Date.now();
  let { siteId, page, candidate, route, viewports, sectionIds, gate } = args;
  let projectDir = null, config = null;
  const warnings = [];
  if (candidate?.dir) {
    projectDir = candidate.dir;
    config = readProjectConfig(projectDir);
    siteId ??= config.siteId;
    const pageCfg = (config.pages ?? []).find(p => p.name === page) ?? config.pages?.[0];
    page ??= pageCfg?.name;
    route ??= pageCfg?.route ?? '/';
    viewports ??= config.viewports;
    if (gate?.level && gate.level !== config.gate?.level) warnings.push({ code: 'gate_param_ignored', message: '项目模式以 heimdall.config.json 的门禁为准，忽略了参数里的 gate' });
    gate = config.gate ?? { level: 'silver' };
    if (!config.devServer?.url) throw new CapabilityError('invalid_args', 'heimdall.config.json 缺 devServer.url');
    const cheats = referencesToHeimdall(projectDir);
    if (cheats.length) {
      throw new CapabilityError('gate_failed', `候选源码引用了 .heimdall/（参考截图只能看、不能当内容）：${cheats.slice(0, 3).join('、')}`, {
        hint: '删掉对 .heimdall/ 的引用，用 public/assets/ 里的原件资产重建这些内容',
      });
    }
  }
  if (!siteId || !page) throw new CapabilityError('invalid_args', '需要 siteId 与 page（或在重建工作区里用 --project）');
  requireMirror(siteId, page);
  viewports = (viewports ?? [375, 768, 1440]).map(Number).filter(w => viewportOf(w));
  if (!viewports.length) throw new CapabilityError('invalid_args', 'viewports 只能取 375 / 768 / 1440');
  const level = gate?.level && GATES[gate.level] ? gate.level : 'silver';
  const candUrl = candidate?.url ?? new URL((route ?? '/').replace(/^\/?/, ''), config.devServer.url.replace(/\/?$/, '/')).href;
  if (!await reachable(candUrl)) {
    throw new CapabilityError('candidate_unreachable', `候选打不开：${new URL(candUrl).origin}`, {
      hint: config?.devServer?.command ? `在项目目录运行 \`${config.devServer.command}\`，确认 ${config.devServer.url} 能打开后重试` : undefined,
    });
  }
  const runId = newRunId();
  const outDir = join(compareDir(siteId), runId);
  mkdirSync(join(outDir, 'crops'), { recursive: true });
  const browser = sharedBrowser ?? await launchBrowser();
  const fence = createFence();
  try {
    onProgress?.({ stage: 'reference', pct: 5 });
    const plan = await ensurePlan(siteId, page, { browser });
    const ref = await ensureReference(siteId, page, { viewports, browser, sections: plan.sections.map(s => ({ id: s.id, anchors: s.anchors })) });
    const wanted = sectionIds?.length ? plan.sections.filter(s => sectionIds.includes(s.id)) : null;
    if (sectionIds?.length && wanted.length !== sectionIds.length) {
      throw new CapabilityError('not_found', '有分段 ID 不在分段计划里', { nextActions: [nextAction('heimdall_brief', { siteId, page, detail: 'sections' }, '列出分段')] });
    }
    const perViewport = {}, regions = [], evidence = [], skipped = [];
    let sectionMode = null;
    for (const [vi, width] of viewports.entries()) {
      onProgress?.({ stage: 'capture', pct: 10 + Math.round(vi / viewports.length * 70), message: `视口 ${width}` });
      const vp = viewportOf(width);
      let refImg = readPng(join(ref.dir, `${width}.png`));
      let dyn = readMask(siteId, page, width);
      let elements = readElements(siteId, page, width);
      const opened = await openPage(browser, candUrl, vp);
      let candImg = await shoot(opened.page, { contentCrop: !!wanted });
      let offset = { x: 0, y: 0 }, candOffsetY = 0;
      if (wanted?.length === 1) {
        const s = wanted[0];
        const rb = s.boxes[width];
        const cb = await sectionBox(opened.page, s.id);
        if (!rb) {
          // 参考里这一段在这个视口不可见（响应式隐藏）：这个视口不计入判定
          await opened.ctx.close();
          skipped.push({ viewport: width, reason: 'section-hidden-in-reference' });
          continue;
        }
        if (!cb) {
          // 候选页里还没有这一段（或根元素没加标记）：明确报出来，而不是拿整页去比
          await opened.ctx.close();
          sectionMode = 'marked';
          const area = Math.round(rb.w * rb.h);
          perViewport[width] = { pixelSimilarity: 0, pixelChannel: 0, maxBlobPct: +(area / (vp.width * vp.height) * 100).toFixed(3), maxBlobPagePct: 100,
            maxRegionPct: +(area / (vp.width * vp.height) * 100).toFixed(3), highRegions: 1, maskCoveragePct: 0, diffShape: 'concentrated',
            size: { ref: { w: Math.round(rb.w), h: Math.round(rb.h) }, cand: { w: 0, h: 0 } }, heightDelta: -Math.round(rb.h), regionsTotal: 1, regionsReturned: 1,
            notes: [`候选页里没有找到 data-heimdall-section="${s.id}" 的元素：先写这一段，并给它的根元素加上这个属性。`] };
          regions.push({ id: `r${width}-01`, viewport: width, sectionId: s.id, kind: 'missing-section', bbox: { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.w), h: Math.round(rb.h) },
            areaPct: perViewport[width].maxRegionPct, density: 1, severity: 'high', cause: 'missing-content', causeConfidence: 1,
            hint: `候选页里找不到这一段：先写它，根元素加 data-heimdall-section="${s.id}"。`, completeness: 'region' });
          evidence.push(ref.meta.viewports[width]?.screenshot);
          continue;
        }
        // 两侧都裁到分段：参考按分段计划的外接框，候选按 data-heimdall-section 标记
        sectionMode = 'marked';
        const ry = Math.max(0, Math.floor(rb.y)), rh = Math.min(refImg.height - ry, Math.ceil(rb.h));
        refImg = crop(refImg, 0, ry, refImg.width, rh);
        candOffsetY = Math.max(0, cb.y);
        candImg = crop(candImg, 0, candOffsetY, candImg.width, Math.min(candImg.height - candOffsetY, cb.h));
        if (dyn) { const m = new Uint8Array(refImg.width * refImg.height); for (let y = 0; y < rh; y++) m.set(dyn.subarray((ry + y) * refImg.width, (ry + y + 1) * refImg.width), y * refImg.width); dyn = m; }
        offset = { x: 0, y: ry };
        elements = elements.filter(e => e.sectionId === s.id).map(e => ({ ...e, box: { ...e.box, y: e.box.y - ry } }));
      } else if (wanted) sectionMode = 'filtered';
      await opened.ctx.close();
      const a = analyzeViewport({ ref: refImg, cand: candImg, viewport: width, viewportHeight: vp.height, elements, dyn });
      let vpRegions = a.regions;
      // 区域 → 分段（按与参考侧分段外接框的重叠归属）
      for (const r of vpRegions) {
        const pb = { x: r.x + offset.x, y: r.y + offset.y, w: Math.max(1, r.w), h: Math.max(1, r.h) };
        let best = null, bestArea = 0;
        for (const s of plan.sections) {
          const b = s.boxes[width];
          if (!b) continue;
          const area = inter(pb, b);
          if (area > bestArea) { bestArea = area; best = s; }
        }
        if (best) r.sectionId = best.id;
      }
      if (sectionMode === 'filtered') vpRegions = vpRegions.filter(r => wanted.some(s => s.id === r.sectionId));
      const kept = vpRegions.slice(0, REGIONS_PER_VIEWPORT);
      for (const r of kept.slice(0, CROPS_PER_VIEWPORT)) {
        const name = `${r.id}.png`;
        const info = writeCrop(join(outDir, 'crops', name), r, refImg, candImg, a.align);
        r.crops = { composite: `crops/${name}`, uri: `heimdall://run/${runId}/crop/${r.id}/composite.png`, width: info.width, height: info.height };
      }
      const m = a.metrics;
      perViewport[width] = {
        pixelSimilarity: m.pixelSimilarity, pixelChannel: m.pixelChannel, maxBlobPct: m.maxBlobPct, maxBlobPagePct: m.maxBlobPagePct,
        maxRegionPct: sectionMode === 'filtered' ? Math.max(0, ...vpRegions.filter(r => !r.scattered && !r.subpixel).map(r => r.areaPct)) : m.maxRegionPct,
        highRegions: (sectionMode === 'filtered' ? vpRegions : a.regions).filter(r => r.severity === 'high').length,
        maskCoveragePct: ref.meta.maskCoveragePct?.[width] ?? 0, diffShape: m.diffShape, size: m.size, heightDelta: m.heightDelta,
        regionsTotal: vpRegions.length, regionsReturned: kept.length, notes: m.notes,
        alignment: { equalRowsShare: a.alignment.share, bands: a.alignment.bands.slice(0, 12) },
      };
      for (const r of kept) {
        regions.push({
          id: r.id, viewport: width, sectionId: r.sectionId, kind: r.kind,
          bbox: { x: r.x + offset.x, y: r.y + offset.y, w: r.w, h: r.h },
          ...(r.cand ? { candBbox: { x: r.cand.x, y: r.cand.y + candOffsetY, w: r.cand.w, h: r.cand.h } } : {}),
          areaPct: r.areaPct, density: r.density, ...(r.scattered ? { scattered: true } : {}), ...(r.subpixel ? { subpixel: true } : {}),
          severity: r.severity, cause: r.cause, causeConfidence: r.causeConfidence,
          ...(r.heightDelta ? { heightDelta: r.heightDelta } : {}), ...(r.consequenceOf ? { consequenceOf: r.consequenceOf } : {}),
          ...(r.shift ? { shift: r.shift } : {}), ...(r.colors ? { colors: r.colors } : {}), ...(r.inkSize ? { inkSize: r.inkSize } : {}),
          element: r.element ? {
            best: (r.element.best ?? []).map(e => ({ ...e, ...(e.text ? { text: fence.inline(e.text, 60, 'element.text') } : {}),
              box: { ...e.box, y: e.box.y + offset.y } })),
            container: r.element.container ? { ...r.element.container, ...(r.element.container.text ? { text: fence.inline(r.element.container.text, 60, 'element.text') } : {}) } : null,
          } : undefined,
          crops: r.crops, hint: r.hint, completeness: 'region',
        });
      }
      evidence.push(ref.meta.viewports[width]?.screenshot);
    }
    if (!Object.keys(perViewport).length) {
      throw new CapabilityError('invalid_args', '所选分段在这些视口的参考里都不可见，没有可比的内容', { details: { skipped } });
    }
    const verdict = verdictOf(perViewport, level);
    const key = candidateKey(siteId, page, candidate ?? { dir: projectDir }, route);
    const history = readIndex(siteId).filter(h => h.candidateKey === key && h.mode === 'fast' && JSON.stringify(h.sectionIds ?? null) === JSON.stringify(sectionIds ?? null));
    const pixelNow = Object.fromEntries(Object.entries(perViewport).map(([k, v]) => [k, v.pixelSimilarity]));
    const trend = trendOf(history, pixelNow);
    // 排序：先按视口内的权重顺序，再在视口间交错，保证前几条覆盖每个视口最要紧的问题
    const byVp = viewports.filter(w => perViewport[w]).map(w => regions.filter(r => r.viewport === w));
    const order = [];
    for (let i = 0; i < REGIONS_PER_VIEWPORT; i++) for (const list of byVp) if (list[i]) order.push(list[i].id);
    const packet = {
      schema: 'heimdall.fixpacket/1', runId, siteId, page, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - t0, mode: 'fast',
      candidate: candidate?.url ? { kind: 'url', ref: candidate.url, route: route ?? '/' } : { kind: 'dir', ref: projectDir, url: candUrl, route },
      reference: { refId: ref.meta.refId, capturedAt: ref.meta.capturedAt, profile: PROFILE },
      scope: wanted ? { sectionIds: wanted.map(s => s.id), mode: sectionMode } : { page: true },
      viewports: viewports.filter(w => perViewport[w]), ...(skipped.length ? { skipped } : {}), perViewport, regions, order, trend, verdict,
      evidence: evidence.filter(Boolean),
    };
    writeFileAtomic(join(outDir, 'fixpacket.json'), JSON.stringify(packet, null, 1));
    const text = packetText(packet);
    writeFileSync(join(outDir, 'packet.txt'), text);
    appendFileSync(join(compareDir(siteId), 'index.jsonl'), JSON.stringify({ runId, at: packet.generatedAt, mode: 'fast', candidateKey: key, page,
      sectionIds: sectionIds ?? null, pixel: pixelNow, verdict: verdict.status, reached: verdict.reached }) + '\n');
    let projectRunDir = null;
    if (projectDir) {
      projectRunDir = join(projectDir, '.heimdall', 'runs', runId);
      mkdirSync(join(projectRunDir, 'crops'), { recursive: true });
      writeFileSync(join(projectRunDir, 'fixpacket.json'), JSON.stringify(packet, null, 1));
      writeFileSync(join(projectRunDir, 'packet.txt'), text);
      for (const r of regions) if (r.crops?.composite) writeFileSync(join(projectRunDir, r.crops.composite), readFileSync(join(outDir, r.crops.composite)));
      // 飞行记录器的最小形态（E7-14 在 Ph2 补全）：每次对比一行，rebuild status 据此算进度
      appendFileSync(join(projectDir, '.heimdall', 'ledger.jsonl'), JSON.stringify({ schema: 'heimdall.ledger/1', type: 'iter', runId, at: packet.generatedAt, page,
        sectionIds: sectionIds ?? null, pixel: pixelNow, verdict: verdict.status, reached: verdict.reached, trend: trend.state, elapsedMs: packet.elapsedMs }) + '\n');
    }
    const fixBytes = readFileSync(join(outDir, 'fixpacket.json'));
    return { packet, text, outDir, projectRunDir, fence, warnings,
      fixpacketEvidence: { uri: `heimdall://run/${runId}/fixpacket`, sha256: sha256(fixBytes), bytes: fixBytes.length, mime: 'application/json' } };
  } finally {
    if (!sharedBrowser) await browser.close().catch(() => {});
  }
}
