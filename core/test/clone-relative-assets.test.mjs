import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD = join(CORE, 'src', 'crawler', 'build_clone.mjs');

function put(root, relative, value) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

test('build_clone maps deep-page relative assets and copies every referenced capture resource', () => {
  const data = mkdtempSync(join(tmpdir(), 'heimdall-clone-relative-'));
  const page = join(data, 'workspace', 'hobix.com', 'pages', 'walk');
  const origin = 'https://hobix.com';
  const canal = origin + '/learn/examples/A01/assets/canal.svg';
  const sprite = origin + '/learn/examples/A01/assets/sprite.svg';
  try {
    put(page, 'manifest.json', JSON.stringify({ target: origin + '/learn/examples/A01/walk' }));
    put(page, 'dom.html', '<!doctype html><html><head><title>Walk</title></head><body>'
      + '<img src="assets/canal.svg" srcset="assets/canal.svg 1x" style="background:url(assets/canal.svg)">'
      + '<svg><use href="assets/sprite.svg#route"></use></svg></body></html>');
    put(page, 'cssom.css', 'body{color:#123456}');
    put(page, 'cssom-refs.json', JSON.stringify({ origin, refs: [], refMap: {}, sheets: [] }));
    put(page, 'asset-map.json', JSON.stringify({
      imgMap: { [canal]: 'assets/image000.svg' },
      resMap: { [canal]: 'assets/image000.svg', [sprite]: 'assets/sprite001.svg' },
      css: [], imgs: [canal], resources: [], favicon: [],
    }));
    put(page, 'assets/image000.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>');
    put(page, 'assets/sprite001.svg', '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="route"/></svg>');
    const result = spawnSync(process.execPath, [BUILD, page], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: data }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const html = readFileSync(join(page, 'clone', 'index.html'), 'utf8');
    assert.match(html, /<img[^>]*src="assets\/image000\.svg"/);
    assert.match(html, /srcset="assets\/image000\.svg 1x"/);
    assert.match(html, /url\(assets\/image000\.svg\)/);
    assert.match(html, /href="assets\/sprite001\.svg#route"/);
    assert.ok(existsSync(join(page, 'clone', 'assets', 'image000.svg')));
    assert.ok(existsSync(join(page, 'clone', 'assets', 'sprite001.svg')));
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
