import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { comparePngBuffers } from '../src/verify/compare.mjs';
import { compareTiledPng, TILE_HEIGHT } from '../src/verify/tiled-compare.mjs';

function image(width, height, color = 255) {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = color;
    png.data[i + 1] = color;
    png.data[i + 2] = color;
    png.data[i + 3] = 255;
  }
  return png;
}

function tiles(png, label, files) {
  const parts = [];
  for (let y = 0; y < png.height; y += TILE_HEIGHT) {
    const height = Math.min(TILE_HEIGHT, png.height - y);
    const part = new PNG({ width: png.width, height });
    png.data.copy(part.data, 0, y * png.width * 4, (y + height) * png.width * 4);
    const file = `${label}-${y}`;
    files.set(file, PNG.sync.write(part));
    parts.push({ y, height, file });
  }
  return { width: png.width, height: png.height, parts };
}

test('tiled comparison matches full-image score across tile and truncation boundaries', () => {
  const source = image(4, TILE_HEIGHT * 2 + 15);
  const clone = image(4, TILE_HEIGHT + 7);
  for (let y = TILE_HEIGHT - 2; y < TILE_HEIGHT + 3; y++) {
    clone.data[(y * clone.width + 1) * 4] = 0;
  }
  const files = new Map();
  const full = comparePngBuffers(PNG.sync.write(source), PNG.sync.write(clone));
  const diffs = [];
  const tiled = compareTiledPng(tiles(source, 'src', files), tiles(clone, 'clone', files), {
    readPart: file => files.get(file),
    writeDiff: (y, png) => { diffs.push({ y, png: PNG.sync.read(png) }); return `diff-${y}`; },
  });
  for (const key of ['score', 'mismatched', 'missingPixels', 'coverageRatio', 'heightDelta']) {
    assert.equal(tiled[key], full[key], key);
  }
  assert.equal(diffs.length, 3);
  assert.deepEqual(tiled.diffParts, ['diff-0', `diff-${TILE_HEIGHT}`, `diff-${TILE_HEIGHT * 2}`]);
  assert.deepEqual([...diffs[2].png.data.subarray(0, 4)], [255, 0, 255, 255]);
});

test('tiled comparison rejects a missing or resized captured tile', () => {
  const files = new Map();
  const source = tiles(image(2, TILE_HEIGHT + 1), 'src', files);
  const clone = tiles(image(2, TILE_HEIGHT + 1), 'clone', files);
  const options = { readPart: file => files.get(file), writeDiff: () => 'diff' };
  const last = source.parts.at(-1);
  const resized = new PNG({ width: 2, height: last.height + 1 });
  files.set(last.file, PNG.sync.write(resized));
  assert.throws(() => compareTiledPng(source, clone, options), /dimensions changed/);
});
