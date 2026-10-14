import { PNG } from 'pngjs';
import { comparePngBuffers } from './compare.mjs';

export const TILE_HEIGHT = 4096;

export function compareTiledPng(source, clone, { readPart, writeDiff }) {
  if (!Number.isInteger(source.width) || !Number.isInteger(clone.width)
      || !Number.isInteger(source.height) || !Number.isInteger(clone.height)
      || source.width < 1 || clone.width < 1 || source.height < 1 || clone.height < 1) {
    throw new Error('invalid tiled screenshot dimensions');
  }
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
