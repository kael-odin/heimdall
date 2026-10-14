import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const DIFF = fileURLToPath(new URL('../src/differ/diff.mjs', import.meta.url));

function runDiff(srcHtml, cloneHtml, { frames = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-diff-data-'));
  try {
    mkdirSync(join(dir, 'clone'));
    const image = new PNG({ width: 4, height: 4 });
    image.data.fill(255);
    const png = PNG.sync.write(image);
    writeFileSync(join(dir, 'shot-src.png'), png);
    writeFileSync(join(dir, 'shot-clone.png'), png);
    for (const [index, pixels] of frames.entries()) {
      const frame = new PNG({ width: 4, height: 4 });
      frame.data.fill(255);
      for (const pixel of pixels) frame.data[pixel * 4] = 0;
      writeFileSync(join(dir, `frame-${index + 1}.png`), PNG.sync.write(frame));
    }
    writeFileSync(join(dir, 'dom.html'), srcHtml);
    writeFileSync(join(dir, 'clone', 'index.html'), cloneHtml);
    const result = spawnSync(process.execPath, [DIFF, dir], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(readFileSync(join(dir, 'score.json'), 'utf8'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('diff records unmeasured data and normalizes the remaining weights', () => {
  const score = runDiff('<html><body><div></div></body></html>', '<html><body><section></section></body></html>');
  assert.equal(score.scoreFormulaVersion, 2);
  assert.equal(score.data, null);
  assert.equal(score.dataReason, 'no-source-fields');
  assert.equal(score.total, +(((0.5 * score.pixel + 0.3 * score.dom.dom) / 0.8) * 100).toFixed(1));
});

test('diff keeps measured zero coverage in the full formula', () => {
  const score = runDiff('<html><head><title>Source</title></head><body></body></html>', '<html><body></body></html>');
  assert.equal(score.data.data, 0);
  assert.equal(score.dataReason, null);
  assert.equal(score.total, +((0.5 * score.pixel + 0.3 * score.dom.dom) * 100).toFixed(1));
});

test('diff retains an exact first frame when later frames differ', () => {
  const html = '<html><head><title>Source</title></head><body></body></html>';
  const score = runDiff(html, html, { frames: [[], [0]] });
  assert.equal(score.breakdown.bestFrame, 1);
  assert.equal(score.mismatched, 0);
  assert.equal(score.pixel, 1);
});
