/**
 * agent/evidence/image — PNG 裁剪、缩放、拼图、差异叠加（纯函数，无浏览器依赖）
 *
 * 由 Phase 0 S1 原型转正。CHANNEL_T 与 differ/diff.mjs 一致（任一通道差 > 24 视为不同），
 * 只用于对齐与区域分析；门禁的像素分用 verify/compare.mjs 的 pixelmatch 口径（见 fixpacket.mjs）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

export const CHANNEL_T = 24;

export const readPng = (file) => PNG.sync.read(readFileSync(file));
export const decodePng = (buf) => PNG.sync.read(buf);
export const writePng = (file, img) => writeFileSync(file, PNG.sync.write(img));
export const encodePng = (img) => PNG.sync.write(img instanceof PNG ? img : Object.assign(new PNG({ width: img.width, height: img.height }), { data: img.data }));

export function blank(width, height, rgb = [255, 255, 255]) {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
  }
  return img;
}

/** 按行映射裁剪：输出第 i 行取自源图第 rows[i] 行（-1 = 缺行，用 fill 填） */
export function cropRows(img, rows, x, w, fill = [255, 0, 255]) {
  const out = blank(w, rows.length, fill);
  const x0 = Math.max(0, x), x1 = Math.min(img.width, x + w);
  if (x1 <= x0) return out;
  for (let i = 0; i < rows.length; i++) {
    const sy = rows[i];
    if (sy < 0 || sy >= img.height) continue;
    img.data.copy(out.data, (i * w + (x0 - x)) * 4, (sy * img.width + x0) * 4, (sy * img.width + x1) * 4);
  }
  return out;
}

export function crop(img, x, y, w, h, fill) {
  const rows = Array.from({ length: h }, (_, i) => y + i);
  return cropRows(img, rows, x, w, fill);
}

/** 整数倍盒式缩小，让长边 ≤ maxEdge */
export function downscale(img, maxEdge) {
  const long = Math.max(img.width, img.height);
  if (long <= maxEdge) return img;
  const k = Math.ceil(long / maxEdge);
  const w = Math.max(1, Math.floor(img.width / k)), h = Math.max(1, Math.floor(img.height / k));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < k; dy++) {
        const row = (y * k + dy) * img.width;
        for (let dx = 0; dx < k; dx++) {
          const i = (row + x * k + dx) * 4;
          r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2];
        }
      }
      const o = (y * w + x) * 4, n = k * k;
      out.data[o] = r / n; out.data[o + 1] = g / n; out.data[o + 2] = b / n; out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 把若干张图沿一个方向拼起来，中间留 gap 像素的深色分隔 */
export function stack(images, direction = 'vertical', gap = 6, bg = [48, 48, 48]) {
  const vertical = direction === 'vertical';
  const W = vertical ? Math.max(...images.map(i => i.width)) : images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1);
  const H = vertical ? images.reduce((s, i) => s + i.height, 0) + gap * (images.length - 1) : Math.max(...images.map(i => i.height));
  const out = blank(W, H, bg);
  let off = 0;
  for (const im of images) {
    for (let y = 0; y < im.height; y++) {
      const ty = vertical ? off + y : y;
      const tx = vertical ? 0 : off;
      im.data.copy(out.data, (ty * W + tx) * 4, y * im.width * 4, (y + 1) * im.width * 4);
    }
    off += (vertical ? im.height : im.width) + gap;
  }
  return out;
}

/** 差异叠加图：参考图淡化成灰度，差异像素画红（与 pixelmatch 输出观感一致） */
export function diffOverlay(a, b) {
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4, j = (y * b.width + x) * 4, o = (y * w + x) * 4;
      const differs = Math.abs(a.data[i] - b.data[j]) > CHANNEL_T || Math.abs(a.data[i + 1] - b.data[j + 1]) > CHANNEL_T
        || Math.abs(a.data[i + 2] - b.data[j + 2]) > CHANNEL_T;
      if (differs) { out.data[o] = 230; out.data[o + 1] = 20; out.data[o + 2] = 40; }
      else {
        const l = 0.299 * a.data[i] + 0.587 * a.data[i + 1] + 0.114 * a.data[i + 2];
        const v = 255 - (255 - l) * 0.25;
        out.data[o] = v; out.data[o + 1] = v; out.data[o + 2] = v;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

export const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

export const hex = (rgb) => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
