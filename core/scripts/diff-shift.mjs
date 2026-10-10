/**
 * 判定"整体偏移"假设：把镜像图上下/左右平移若干像素再比对，
 * 如果某个偏移让差异大幅下降，说明差异来自位移而不是内容。
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [srcP, cloneP] = process.argv.slice(2);
const a = PNG.sync.read(readFileSync(srcP));
const b = PNG.sync.read(readFileSync(cloneP));
const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);

function diffAt(dx, dy) {
  const shifted = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x + dx, sy = y + dy;
      const di = (y * W + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) { shifted.data[di + 3] = 0; continue; }
      const si = (sy * W + sx) * 4;
      shifted.data[di] = b.data[si]; shifted.data[di + 1] = b.data[si + 1];
      shifted.data[di + 2] = b.data[si + 2]; shifted.data[di + 3] = 255;
    }
  }
  const out = new PNG({ width: W, height: H });
  return pixelmatch(a.data, shifted.data, out.data, W, H, { threshold: 0.1 });
}

const base = diffAt(0, 0);
console.log(`基准差异 ${base} (${(base / (W * H) * 100).toFixed(2)}%)`);
console.log('\n平移后：');
const rows = [];
for (const dy of [-3, -2, -1, 0, 1, 2, 3]) {
  const n = diffAt(0, dy);
  rows.push({ dy, n, pct: n / (W * H) * 100 });
}
for (const r of rows) {
  const delta = r.n - base;
  const mark = r.n < base * 0.7 ? '  ← 显著改善' : '';
  console.log(`  垂直 ${String(r.dy).padStart(3)}px  ${String(r.n).padStart(6)}  ${r.pct.toFixed(2).padStart(5)}%  (${delta >= 0 ? '+' : ''}${delta})${mark}`);
}
const best = rows.reduce((p, q) => (q.n < p.n ? q : p));
if (best.n < base * 0.7) console.log(`\n结论：垂直偏移 ${best.dy}px 时差异显著下降 → 差异主要来自**整体位移**。`);
else console.log('\n结论：平移无法解释差异 → 是内容/渲染差异，不是整体位移。');
