/**
 * differ — 还原度评分（多帧采样 + 可修性分类）
 *
 * 像素维度不再只对单帧：原站多帧采样（capture 产出 frame-*.png），
 *   1) 评分取「与克隆差异最小的帧」—— 打字机/轮播等 JS 动效噪声被吸收；
 *   2) 帧间差集 = 动态区域掩码；最好帧的差异像素落在掩码内 = 动态噪声差异，
 *      其余 = 可修静态差异。可修性 refinable = 静态差异占比。
 *
 * score.json 增加 breakdown: { frames, bestFrame, dynamicPx, staticPx, dynamicShare, refinable }
 * —— fixup 的门控依据（有足够"可修静态差异"才值得 AI 校准）。
 *
 * total = 0.5*pixel + 0.3*dom + 0.2*data（data 缺失时按 pixel+dom 归一化）
 * grade: A ≥95 / B ≥85 / C <85
 *
 * 用法: node src/differ/diff.mjs <pageDir>
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { analyzeDiffShape, shapeNote } from './shape.mjs';
import { domSimilarity } from './domdiff.mjs';
import { dataScore } from '../harvest/harvest.mjs';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';
import { readCloneDoc } from '../clone-doc.mjs';
import { cloneInputSha256 } from '../verify/resume-cache.mjs';

const DIR = requireArg(process.argv[2], 'node src/differ/diff.mjs <pageDir>', '页面目录');
const CHANNEL_T = 24;   // 任一通道差 > 24 视为不同（约 pixelmatch threshold 0.1）

const clone = PNG.sync.read(readFileSync(join(DIR, 'shot-clone.png')));

// ---------- 帧收集 ----------
const frames = [];
for (let i = 1; i <= 8; i++) {
  const p = join(DIR, `frame-${i}.png`);
  if (existsSync(p)) frames.push(PNG.sync.read(readFileSync(p)));
}
if (!frames.length) frames.push(PNG.sync.read(readFileSync(join(DIR, 'shot-src.png'))));   // 旧产物兼容
const W = clone.width, H = clone.height, total = W * H;
for (const [index, frame] of frames.entries()) {
  if (frame.width !== W || frame.height !== H) {
    console.error(`size mismatch: frame ${index + 1} ${frame.width}x${frame.height} vs clone ${W}x${H}`);
    process.exit(2);
  }
}

// ---------- 像素比较（返回差异像素的 buffer 偏移索引） ----------
function diffIndices(a, b) {
  const out = [];
  const da = a.data, db = b.data;
  for (let i = 0; i < da.length; i += 4) {
    if (Math.abs(da[i] - db[i]) > CHANNEL_T ||
        Math.abs(da[i + 1] - db[i + 1]) > CHANNEL_T ||
        Math.abs(da[i + 2] - db[i + 2]) > CHANNEL_T) out.push(i);
  }
  return out;
}

// ---------- 动态区域掩码：帧间差集并集 ----------
const dynamic = new Set();
if (frames.length >= 2) {
  for (let i = 0; i < frames.length; i++)
    for (let j = i + 1; j < frames.length; j++)
      for (const idx of diffIndices(frames[i], frames[j])) dynamic.add(idx);
}

// ---------- 最优帧评分 + 动/静拆分 ----------
let best = null, bestIndices = null, bestFrame = 0;
for (let i = 0; i < frames.length; i++) {
  const idx = diffIndices(frames[i], clone);
  if (best === null || idx.length < best) { best = idx.length; bestIndices = idx; bestFrame = i + 1; }
}
let dynamicPx = 0;
for (const idx of bestIndices) if (dynamic.has(idx)) dynamicPx++;
const staticPx = bestIndices.length - dynamicPx;

const pixel = 1 - best / total;
const refinable = best ? staticPx / best : 1;

// ---------- diff 热图（视觉用，最好帧 vs 克隆） ----------
const diff = new PNG({ width: W, height: H });
pixelmatch(frames[bestFrame - 1].data, clone.data, diff.data, W, H, { threshold: 0.1 });

// 差异的**形态**：同样 96% 的相似度，可能是"一处图片没抓到"（集中），
// 也可能是"全页文字抗锯齿略不同"（弥散）—— 含义完全不同，用户得能分辨。
const shape = analyzeDiffShape(diff.data, W, H);

// ---------- 结构 / 数据维度 ----------
// 克隆文档不一定是 clone/index.html：多视口页那里只是 372 字节的视口选择器，
// 直接读它 = 拿一个空文档去比，DOM/数据两维全归零（详见 src/clone-doc.mjs）
const srcHtml = readFileSync(join(DIR, 'dom.html'), 'utf8');
const cloneDoc = readCloneDoc(join(DIR, 'clone'));
if (cloneDoc.variant) console.log('  clone doc: ' + basename(cloneDoc.file) + '（多视口克隆，index.html 是选择器）');
const dom = domSimilarity(srcHtml, cloneDoc.html);
let data;
let dataReason = null;
try {
  data = dataScore(srcHtml, cloneDoc.html);
  if (!data) dataReason = 'no-source-fields';
} catch { data = null; dataReason = 'harvest-failed'; }

const total100 = data ? 0.5 * pixel + 0.3 * dom.dom + 0.2 * data.data : (0.5 * pixel + 0.3 * dom.dom) / 0.8;
const grade = total100 >= 0.95 ? 'A' : total100 >= 0.85 ? 'B' : 'C';

const score = {
  page: DIR.split(/[\\/]/).pop(),
  scoreFormulaVersion: 2,
  inputSha256: cloneInputSha256(DIR),
  viewport: `${W}x${H}`,
  pixel: +pixel.toFixed(4),
  dom,
  data,
  dataReason,
  weights: { pixel: 0.5, dom: 0.3, data: 0.2 },
  dataNote: data ? 'full 3-dim formula' : `${dataReason}; normalized over pixel+dom`,
  total: +(total100 * 100).toFixed(1),
  grade,
  mismatched: best,
  breakdown: {
    frames: frames.length,
    bestFrame,
    dynamicPx,
    staticPx,
    dynamicShare: best ? +(dynamicPx / best).toFixed(3) : 0,
    refinable: +refinable.toFixed(3),
  },
  // 差异形态：concentrated（去查那几块）/ mixed / diffuse（多为渲染差异）
  diffShape: { ...shape, note: shapeNote(shape.shape) },
  method: 'multi-frame best-match + parse5 structural + field coverage',
};
writeFileSync(join(DIR, 'score.json'), JSON.stringify(score, null, 2));
writeFileSync(join(DIR, 'diff.png'), PNG.sync.write(diff));
console.log(`pixel ${(pixel * 100).toFixed(2)}% (best of ${frames.length} frames, dynamic ${(dynamicPx / (best || 1) * 100).toFixed(0)}%) | dom ${(dom.dom * 100).toFixed(2)}% | data ${data ? (data.data * 100).toFixed(2) + '%' : 'n/a'}`);
console.log(`refinable ${(refinable * 100).toFixed(0)}% (static ${staticPx}px / dynamic ${dynamicPx}px) | TOTAL ${(total100 * 100).toFixed(1)}%  grade ${grade}`);
if (shape.shape !== 'identical') {
  console.log(`diff shape ${shape.shape}: ${shape.blobs} 块, 最大 ${shape.largest}px, 前5占 ${(shape.top5Share * 100).toFixed(0)}% — ${shapeNote(shape.shape)}`);
}
