import { PNG } from 'pngjs';
import { comparePngBuffers } from './compare.mjs';

export const TILE_HEIGHT = 4096;

function validateTiledScreenshot(value) {
  if (!Number.isInteger(value?.width) || !Number.isInteger(value?.height)
      || value.width < 1 || value.height < 1 || !Array.isArray(value.parts)) {
    throw new Error('invalid tiled screenshot dimensions');
  }
}

function missingTilePng(png) {
  const diff = new PNG({ width: png.width, height: png.height });
  for (let i = 0; i < diff.data.length; i += 4) {
    diff.data[i] = 255;
    diff.data[i + 2] = 255;
    diff.data[i + 3] = 255;
  }
  return PNG.sync.write(diff);
}

function rangesOf(parts) {
  const ranges = parts.map(part => ({ start: part.y, end: part.y + part.height }))
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function uncoveredRanges(ranges, height) {
  const uncovered = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) uncovered.push({ start: cursor, end: range.start, height: range.start - cursor });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < height) uncovered.push({ start: cursor, end: height, height: height - cursor });
  return uncovered;
}

export function compareTiledPng(source, clone, { readPart, writeDiff }) {
  validateTiledScreenshot(source);
  validateTiledScreenshot(clone);
  const overlapWidth = Math.min(source.width, clone.width);
  const overlapHeight = Math.min(source.height, clone.height);
  const overlapPixels = overlapWidth * overlapHeight;
  const unionPixels = source.width * source.height + clone.width * clone.height - overlapPixels;
  const missingPixels = unionPixels - overlapPixels;
  const parts = [];
  let mismatched = 0;
  for (let y = 0; y < Math.max(source.height, clone.height); y += TILE_HEIGHT) {
    const src = source.parts.find(part => part.y === y);
    const dst = clone.parts.find(part => part.y === y);
    if (!src && !dst) throw new Error(`missing both screenshot tiles at ${y}`);
    let diffPng;
    if (src && dst) {
      const result = comparePngBuffers(readPart(src.file), readPart(dst.file));
      if (result.sourceSize.width !== source.width || result.cloneSize.width !== clone.width
          || result.sourceSize.height !== src.height || result.cloneSize.height !== dst.height) {
        throw new Error(`screenshot tile dimensions changed at ${y}`);
      }
      mismatched += result.mismatched;
      diffPng = result.diffPng;
    } else {
      const present = src ?? dst;
      const png = PNG.sync.read(readPart(present.file));
      const expectedWidth = src ? source.width : clone.width;
      if (png.width !== expectedWidth || png.height !== present.height) {
        throw new Error(`screenshot tile dimensions changed at ${y}`);
      }
      mismatched += png.width * png.height;
      const diff = new PNG({ width: png.width, height: png.height });
      for (let i = 0; i < diff.data.length; i += 4) {
        diff.data[i] = 255;
        diff.data[i + 2] = 255;
        diff.data[i + 3] = 255;
      }
      diffPng = PNG.sync.write(diff);
    }
    parts.push(writeDiff(y, diffPng));
  }
  return {
    score: +Math.max(0, 1 - mismatched / unionPixels).toFixed(4),
    mismatched,
    missingPixels,
    coverageRatio: +(overlapPixels / unionPixels).toFixed(4),
    width: Math.max(source.width, clone.width),
    height: Math.max(source.height, clone.height),
    heightDelta: Math.abs(source.height - clone.height),
    sourceSize: { width: source.width, height: source.height },
    cloneSize: { width: clone.width, height: clone.height },
    diffParts: parts,
  };
}

/**
 * Compare only the captured tiles of an over-sized page.
 * The score is local to the sampled pixels; sampledCoverageRatio exposes how much of the page they cover.
 */
export function compareSampledTiledPng(source, clone, { readPart, writeDiff }) {
  validateTiledScreenshot(source);
  validateTiledScreenshot(clone);
  const overlapWidth = Math.min(source.width, clone.width);
  const fullHeight = Math.max(source.height, clone.height);
  const fullUnionPixels = source.width * source.height + clone.width * clone.height
    - overlapWidth * Math.min(source.height, clone.height);
  const byY = new Map([...source.parts, ...clone.parts].map(part => [part.y, part]));
  const parts = [];
  let sampledPixels = 0;
  let mismatched = 0;
  let missingPixels = 0;
  for (const y of [...byY.keys()].sort((a, b) => a - b)) {
    const src = source.parts.find(part => part.y === y);
    const dst = clone.parts.find(part => part.y === y);
    if (!src && !dst) throw new Error(`missing both screenshot tiles at ${y}`);
    let diffPng;
    if (src && dst) {
      const result = comparePngBuffers(readPart(src.file), readPart(dst.file));
      if (result.sourceSize.width !== source.width || result.cloneSize.width !== clone.width
          || result.sourceSize.height !== src.height || result.cloneSize.height !== dst.height) {
        throw new Error(`screenshot tile dimensions changed at ${y}`);
      }
      sampledPixels += result.sourceSize.width * result.sourceSize.height
        + result.cloneSize.width * result.cloneSize.height
        - Math.min(result.sourceSize.width, result.cloneSize.width)
          * Math.min(result.sourceSize.height, result.cloneSize.height);
      mismatched += result.mismatched;
      missingPixels += result.missingPixels;
      diffPng = result.diffPng;
    } else {
      const present = src ?? dst;
      const png = PNG.sync.read(readPart(present.file));
      const expectedWidth = src ? source.width : clone.width;
      if (png.width !== expectedWidth || png.height !== present.height) {
        throw new Error(`screenshot tile dimensions changed at ${y}`);
      }
      sampledPixels += png.width * png.height;
      mismatched += png.width * png.height;
      missingPixels += png.width * png.height;
      diffPng = missingTilePng(png);
    }
    parts.push(writeDiff(y, diffPng, parts.length));
  }
  if (!sampledPixels) throw new Error('no sampled screenshot tiles');
  const ranges = rangesOf([...source.parts, ...clone.parts]);
  return {
    score: +Math.max(0, 1 - mismatched / sampledPixels).toFixed(4),
    mismatched,
    missingPixels,
    sampledPixels,
    sampledCoverageRatio: +(sampledPixels / fullUnionPixels).toFixed(4),
    coverageRatio: +(overlapWidth * Math.min(source.height, clone.height) / fullUnionPixels).toFixed(4),
    width: Math.max(source.width, clone.width),
    height: fullHeight,
    heightDelta: Math.abs(source.height - clone.height),
    sourceSize: { width: source.width, height: source.height },
    cloneSize: { width: clone.width, height: clone.height },
    sampledRegions: ranges.map(range => ({ ...range, height: range.end - range.start })),
    uncoveredRanges: uncoveredRanges(ranges, fullHeight),
    diffParts: parts,
  };
}
