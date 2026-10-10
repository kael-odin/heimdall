/**
 * 定位差异区域：读原站/镜像截图，算出差异像素分布在页面的哪些纵向带。
 * 用法: node scripts/diff-regions.mjs <srcPng> <clonePng> [bandCount]
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [srcP, cloneP, bandArg] = process.argv.slice(2);
const BANDS = Number(bandArg ?? 12);

const a = PNG.sync.read(readFileSync(srcP));
const b = PNG.sync.read(readFileSync(cloneP));
const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);
console.log(`图幅 src=${a.width}x${a.height} clone=${b.width}x${b.height} → 比较 ${W}x${H}`);

const diff = new PNG({ width: W, height: H });
const n = pixelmatch(a.data, b.data, diff.data, W, H, { threshold: 0.1 });
console.log(`差异像素 ${n} / ${W * H} = ${(n / (W * H) * 100).toFixed(2)}%`);

// 逐行统计差异像素，找出热点纵向带
const rows = new Array(H).fill(0);
for (let y = 0; y < H; y++) {
  let c = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    // pixelmatch 把差异画成红色
    if (diff.data[i] > 200 && diff.data[i + 1] < 100) c++;
  }
  rows[y] = c;
}

const bandH = Math.ceil(H / BANDS);
console.log('\n纵向分布（每带差异像素 / 占比）：');
const bandInfo = [];
for (let i = 0; i < BANDS; i++) {
  const from = i * bandH, to = Math.min(H, from + bandH);
  let sum = 0;
  for (let y = from; y < to; y++) sum += rows[y];
  const pct = (sum / ((to - from) * W) * 100);
  bandInfo.push({ band: i, from, to, px: sum, pct });
}
const maxPct = Math.max(...bandInfo.map(b => b.pct));
for (const b of bandInfo) {
  const bar = '█'.repeat(Math.round(b.pct / Math.max(0.01, maxPct) * 30));
  console.log(`  y ${String(b.from).padStart(4)}–${String(b.to).padEnd(4)} ${String(b.px).padStart(6)}px ${b.pct.toFixed(2).padStart(6)}% ${bar}`);
}

// 差异最集中的连续区间
const hot = bandInfo.filter(b => b.pct > 0.5).sort((x, y) => y.pct - x.pct);
console.log('\n最热的三带：');
for (const b of hot.slice(0, 3)) console.log(`  y ${b.from}–${b.to}: ${b.pct.toFixed(2)}% 的像素不同`);
