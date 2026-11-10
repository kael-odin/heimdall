import test from 'node:test';
import assert from 'node:assert/strict';
import { isCloneRenderingAsset } from '../src/live/clone-asset-cors.mjs';

test('clone asset CORS policy covers rendering assets inside clone directories only', () => {
  for (const [path, mime] of [
    ['fixture.test/pages/home/clone/styles/site.css', 'text/css; charset=utf-8'],
    ['fixture.test/pages/home/clone/styles/font.woff2', 'font/woff2'],
    ['fixture.test/pages/home/clone/assets/mask.svg', 'image/svg+xml'],
    ['fixture.test/pages/home/clone/assets/image.png', 'image/png'],
  ]) assert.equal(isCloneRenderingAsset(path, mime), true, path);

  for (const [path, mime] of [
    ['fixture.test/pages/home/clone/index.html', 'text/html; charset=utf-8'],
    ['fixture.test/pages/home/clone/app.js', 'text/javascript; charset=utf-8'],
    ['fixture.test/pages/home/clone/data.json', 'application/json'],
    ['fixture.test/pages/home/shot.png', 'image/png'],
    ['fixture.test/pages/home/compare.html', 'text/html; charset=utf-8'],
  ]) assert.equal(isCloneRenderingAsset(path, mime), false, path);
});
