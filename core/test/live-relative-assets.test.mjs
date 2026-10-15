import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveSnapshotPath } from '../src/live/live-path.mjs';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD = join(CORE, 'src', 'crawler', 'build_live.mjs');

function put(root, relative, value) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

test('live build serves mapped deep-page assets locally and resolves remaining relative paths like the source document', () => {
  const data = mkdtempSync(join(tmpdir(), 'heimdall-live-relative-'));
  const siteId = 'hobix.com';
  const site = join(data, 'workspace', siteId);
  const source = 'https://hobix.com/learn/examples/A01/';
  const image = source + 'assets/canal.svg';
  const icon = source + 'assets/icon.svg';
  try {
    const walk = join(site, 'pages', 'walk');
    put(walk, 'manifest.json', JSON.stringify({ target: source + 'walk?view=1' }));
    put(walk, 'dom.html', '<!doctype html><html><head><link rel="icon" href="assets/icon.svg"></head><body>'
      + '<img src="assets/canal.svg" srcset="assets/canal.svg 1x" style="background:url(assets/canal.svg)">'
      + '<a href="next?step=2">Next</a><img src="assets/uncaptured.svg"></body></html>');
    put(walk, 'asset-map.json', JSON.stringify({
      resMap: { [image]: 'assets/image000.svg', [icon]: 'assets/icon.svg' },
      imgMap: { [image]: 'assets/image000.svg' },
    }));
    put(walk, 'clone/assets/image000.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
    put(walk, 'clone/assets/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');

    const directory = join(site, 'pages', 'directory');
    put(directory, 'manifest.json', JSON.stringify({ target: source + 'guide/' }));
    put(directory, 'dom.html', '<html><head></head><body><a href="next">Next</a></body></html>');

    const result = spawnSync(process.execPath, [BUILD, siteId], {
      cwd: CORE,
      env: { ...process.env, HEIMDALL_DATA_DIR: data, HEIMDALL_SELF_URL: 'http://127.0.0.1:1' },
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const html = readFileSync(join(site, 'live', liveSnapshotPath('/learn/examples/A01/walk', '?view=1')), 'utf8');
    const base = /<base href="([^"]+)"/.exec(html)?.[1];
    assert.equal(base, '/lm/hobix.com/learn/examples/A01/');
    assert.match(html, /src="\/static\/hobix\.com\/pages\/walk\/clone\/assets\/image000\.svg"/);
    assert.match(html, /srcset="\/static\/hobix\.com\/pages\/walk\/clone\/assets\/image000\.svg 1x"/);
    assert.match(html, /url\(\/static\/hobix\.com\/pages\/walk\/clone\/assets\/image000\.svg\)/);
    assert.match(html, /href="\/static\/hobix\.com\/pages\/walk\/clone\/assets\/icon\.svg"/);
    assert.match(html, /<a href="next\?step=2">Next<\/a>/);
    assert.equal(new URL('next?step=2', 'https://bundle.test' + base).pathname,
      '/lm/hobix.com/learn/examples/A01/next');
    assert.equal(new URL('assets/uncaptured.svg', 'https://bundle.test' + base).pathname,
      '/lm/hobix.com/learn/examples/A01/assets/uncaptured.svg');

    const directoryHtml = readFileSync(join(site, 'live', 'learn', 'examples', 'A01', 'guide', 'index.html'), 'utf8');
    assert.match(directoryHtml, /<base href="\/lm\/hobix\.com\/learn\/examples\/A01\/guide\/">/);
    assert.match(directoryHtml, /<a href="next">Next<\/a>/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
