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
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { domSimilarity } from './domdiff.mjs';
import { dataScore } from '../harvest/harvest.mjs';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';

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
if (frames[0].width !== W || frames[0].height !== H) {
  console.error(`size mismatch: frame ${frames[0].width}x${frames[0].height} vs clone ${W}x${H}`);
  process.exit(2);
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
  if (!best || idx.length < best) { best = idx.length; bestIndices = idx; bestFrame = i + 1; }
}
let dynamicPx = 0;
for (const idx of bestIndices) if (dynamic.has(idx)) dynamicPx++;
const staticPx = bestIndices.length - dynamicPx;

const pixel = 1 - best / total;
const refinable = best ? staticPx / best : 1;

// ---------- diff 热图（视觉用，最好帧 vs 克隆） ----------
const diff = new PNG({ width: W, height: H });
pixelmatch(frames[bestFrame - 1].data, clone.data, diff.data, W, H, { threshold: 0.1 });

// ---------- 结构 / 数据维度 ----------
const dom = domSimilarity(
  readFileSync(join(DIR, 'dom.html'), 'utf8'),
  readFileSync(join(DIR, 'clone', 'index.html'), 'utf8'),
);
let data;
try {
  data = dataScore(readFileSync(join(DIR, 'dom.html'), 'utf8'), readFileSync(join(DIR, 'clone', 'index.html'), 'utf8'));
} catch { data = null; }

const total100 = data ? 0.5 * pixel + 0.3 * dom.dom + 0.2 * data.data : (0.5 * pixel + 0.3 * dom.dom) / 0.8;
const grade = total100 >= 0.95 ? 'A' : total100 >= 0.85 ? 'B' : 'C';

const score = {
  page: DIR.split(/[\\/]/).pop(),
  viewport: `${W}x${H}`,
  pixel: +pixel.toFixed(4),
  dom,
  data,
  weights: { pixel: 0.5, dom: 0.3, data: 0.2 },
  dataNote: data ? 'full 3-dim formula' : 'harvest failed; normalized over pixel+dom',
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
  method: 'multi-frame best-match + parse5 structural + field coverage',
};
writeFileSync(join(DIR, 'score.json'), JSON.stringify(score, null, 2));
writeFileSync(join(DIR, 'diff.png'), PNG.sync.write(diff));
console.log(`pixel ${(pixel * 100).toFixed(2)}% (best of ${frames.length} frames, dynamic ${(dynamicPx / (best || 1) * 100).toFixed(0)}%) | dom ${(dom.dom * 100).toFixed(2)}% | data ${data ? (data.data * 100).toFixed(2) + '%' : 'n/a'}`);
console.log(`refinable ${(refinable * 100).toFixed(0)}% (static ${staticPx}px / dynamic ${dynamicPx}px) | TOTAL ${(total100 * 100).toFixed(1)}%  grade ${grade}`);
