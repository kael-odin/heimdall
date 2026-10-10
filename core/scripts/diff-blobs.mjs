/**
 * 找出差异的连通区域，输出边界框与面积 —— 比肉眼看缩略图可靠。
 * 用法: node scripts/diff-blobs.mjs <srcPng> <clonePng> [topN]
 */
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const [srcP, cloneP, topN = '6'] = process.argv.slice(2);
const a = PNG.sync.read(readFileSync(srcP));
const b = PNG.sync.read(readFileSync(cloneP));
const W = Math.min(a.width, b.width), H = Math.min(a.height, b.height);
const diff = new PNG({ width: W, height: H });
const n = pixelmatch(a.data, b.data, diff.data, W, H, { threshold: 0.1 });

// 差异掩码（pixelmatch 画成红色）
const mask = new Uint8Array(W * H);
for (let i = 0; i < W * H; i++) {
  const p = i * 4;
  if (diff.data[p] > 200 && diff.data[p + 1] < 120) mask[i] = 1;
}

// 连通块（4 邻域，迭代式 flood fill 避免递归爆栈）
const seen = new Uint8Array(W * H);
const blobs = [];
for (let start = 0; start < W * H; start++) {
  if (!mask[start] || seen[start]) continue;
  const stack = [start];
  seen[start] = 1;
  let minX = W, maxX = -1, minY = H, maxY = -1, count = 0;
  while (stack.length) {
    const i = stack.pop();
    const x = i % W, y = (i / W) | 0;
    count++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (mask[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
    }
  }
  blobs.push({ minX, maxX, minY, maxY, count, w: maxX - minX + 1, h: maxY - minY + 1 });
}

blobs.sort((p, q) => q.count - p.count);
console.log(`差异像素 ${n}（${(n / (W * H) * 100).toFixed(2)}%）· 连通块 ${blobs.length} 个`);
console.log(`\n最大的 ${topN} 块：`);
for (const bl of blobs.slice(0, Number(topN))) {
  const fill = (bl.count / (bl.w * bl.h) * 100).toFixed(0);
  console.log(`  面积 ${String(bl.count).padStart(6)}px  位置 x ${bl.minX}–${bl.maxX}  y ${bl.minY}–${bl.maxY}  (${bl.w}×${bl.h}, 填充率 ${fill}%)`);
}
const area = blobs.slice(0, 5).reduce((s, bl) => s + bl.count, 0);
console.log(`\n前 5 块占总差异的 ${(area / Math.max(1, n) * 100).toFixed(0)}%`);
