import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD = join(CORE, 'src', 'crawler', 'build_clone.mjs');

// 最小 PNG 头（够 magic 判定用；这里只断言"拷没拷"，不渲染）
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8, 0)]);

function fixture(data, site, page) {
  const dir = join(data, 'workspace', site, 'pages', page);
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target: `https://${site}/` }));
  writeFileSync(join(dir, 'asset-map.json'), JSON.stringify({ resMap: {}, imgMap: {} }));
  writeFileSync(join(dir, 'cssom-refs.json'), JSON.stringify({ origin: `https://${site}`, refs: [], refMap: {}, sheets: [] }));
  writeFileSync(join(dir, 'cssom.css'), 'body{color:#111}\n');
  writeFileSync(join(dir, 'dom.html'), '<!doctype html><html><head></head><body>'
    + '<video data-heimdall-poster="0" preload="metadata"></video>'
    + '<canvas data-heimdall-canvas="0" width="10" height="10"></canvas>'
    + '</body></html>');
  writeFileSync(join(dir, 'assets', 'video-0.png'), PNG);
  writeFileSync(join(dir, 'assets', 'canvas-0.png'), PNG);
  return dir;
}

test('build_clone: capture 落的 video-N.png 海报也要拷进克隆（否则 poster 404 变纯黑）', () => {
  const data = mkdtempSync(join(tmpdir(), 'heimdall-clone-video-'));
  try {
    const dir = fixture(data, 'fixture.test', 'home');
    const r = spawnSync(process.execPath, [BUILD, dir], {
      cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: data }, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    const html = readFileSync(join(dir, 'clone', 'index.html'), 'utf8');
    assert.match(html, /poster="assets\/video-0\.png"/);
    assert.ok(existsSync(join(dir, 'clone', 'assets', 'video-0.png')), 'poster 文件必须在克隆里');
    assert.ok(existsSync(join(dir, 'clone', 'assets', 'canvas-0.png')), '画布光栅图不受影响');
    const gaps = JSON.parse(readFileSync(join(dir, 'clone-gaps.json'), 'utf8'));
    assert.equal(gaps.videoPostersCopied, 1);
  } finally { rmSync(data, { recursive: true, force: true }); }
});
