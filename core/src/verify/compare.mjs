/**
 * verify/compare — 多视口截图的纯比较逻辑（可单测，无浏览器依赖）
 */
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';

const cropTo = (img, width, height) => {
  if (img.width === width && img.height === height) return img.data;
  const out = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    img.data.copy(out, y * width * 4, (y * img.width) * 4, (y * img.width + width) * 4);
  }
  return out;
};

/** 比较两张 PNG buffer；任意一侧缺失的区域计为完整差异。 */
export function comparePngBuffers(bufA, bufB, { threshold = 0.1 } = {}) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const overlapWidth = Math.min(a.width, b.width);
  const overlapHeight = Math.min(a.height, b.height);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const diff = new PNG({ width, height });
  const overlapDiff = new PNG({ width: overlapWidth, height: overlapHeight });
  const changed = overlapWidth && overlapHeight
    ? pixelmatch(cropTo(a, overlapWidth, overlapHeight), cropTo(b, overlapWidth, overlapHeight), overlapDiff.data, overlapWidth, overlapHeight, { threshold })
    : 0;
  for (let y = 0; y < height; y++) {
    if (y < overlapHeight) overlapDiff.data.copy(diff.data, y * width * 4, y * overlapWidth * 4, (y + 1) * overlapWidth * 4);
    for (let x = y < overlapHeight ? overlapWidth : 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const onlyOne = (x < a.width && y < a.height) !== (x < b.width && y < b.height);
      if (onlyOne) { diff.data[i] = 255; diff.data[i + 1] = 0; diff.data[i + 2] = 255; diff.data[i + 3] = 255; }
    }
  }
  const overlapPixels = overlapWidth * overlapHeight;
  const unionPixels = a.width * a.height + b.width * b.height - overlapPixels;
  const missingPixels = unionPixels - overlapPixels;
  const mismatched = changed + missingPixels;
  const coverageRatio = unionPixels ? overlapPixels / unionPixels : 0;
  const score = unionPixels ? Math.max(0, 1 - mismatched / unionPixels) : 0;
  return {
    score: +score.toFixed(4),
    mismatched,
    missingPixels,
    coverageRatio: +coverageRatio.toFixed(4),
    width,
    height,
    heightDelta: Math.abs(a.height - b.height),
    sourceSize: { width: a.width, height: a.height },
    cloneSize: { width: b.width, height: b.height },
    diffPng: PNG.sync.write(diff),
  };
}

/** 综合分：移动 0.25 / 平板 0.25 / 桌面 0.5（按名称推断，缺失视口自动归一） */
export function overallScore(viewports) {
  const weightOf = (name) => (/375|mobile/i.test(name) ? 0.25 : /768|tablet/i.test(name) ? 0.25 : 0.5);
  let sum = 0, w = 0;
  for (const v of viewports) {
    if (typeof v.score !== 'number') continue;
    const ww = weightOf(v.name ?? '');
    sum += v.score * ww;
    w += ww;
  }
  return w ? +(sum / w).toFixed(4) : null;
}

/** 最差视口：交付告警口径（综合分可能被桌面权重掩盖移动端塌陷） */
export function worstViewport(viewports) {
  let worst = null;
  for (const v of viewports ?? []) {
    if (typeof v?.score !== 'number') continue;
    if (!worst || v.score < worst.score) worst = {
      name: v.name ?? '', score: v.score, grade: gradeOf(v.score),
      captureMode: v.captureMode ?? null,
      sampledCoverageRatio: v.sampledCoverageRatio ?? null,
      coverageRatio: v.coverageRatio ?? null, sourceSize: v.sourceSize ?? null,
      cloneSize: v.cloneSize ?? null, heightDelta: v.heightDelta ?? null,
      missingPixels: v.missingPixels ?? null,
    };
  }
  return worst;
}

export const gradeOf = (score) => score >= 0.95 ? 'A' : score >= 0.85 ? 'B' : score >= 0.7 ? 'C' : 'D';
