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

/** 比较两张 PNG buffer：取共同区域（宽高取小），返回 score/mismatched/heightDelta/diffPng */
export function comparePngBuffers(bufA, bufB, { threshold = 0.1 } = {}) {
  const a = PNG.sync.read(bufA);
  const b = PNG.sync.read(bufB);
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const diff = new PNG({ width, height });
  const mismatched = width && height
    ? pixelmatch(cropTo(a, width, height), cropTo(b, width, height), diff.data, width, height, { threshold })
    : 0;
  const score = width && height ? Math.max(0, 1 - mismatched / (width * height)) : 0;
  return {
    score: +score.toFixed(4),
    mismatched,
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

export const gradeOf = (score) => score >= 0.95 ? 'A' : score >= 0.85 ? 'B' : score >= 0.7 ? 'C' : 'D';
