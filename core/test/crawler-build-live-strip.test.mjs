import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const BUILD = join(CORE, 'src', 'crawler', 'build_live.mjs');

function put(root, relative, value) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function build(data, siteId, page) {
  return spawnSync(process.execPath, [BUILD, siteId, page], {
    cwd: CORE,
    env: { ...process.env, HEIMDALL_DATA_DIR: data, HEIMDALL_SELF_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8', timeout: 20_000,
  });
}

test('live build: 空的 strip 列表 = 不剥任何脚本（不能退化成全剥）', () => {
  // 复现：`(?:` + [].join('|') + `)` 是空组，永远匹配 →
  // `<script[^>]*(?:)[^>]*></script>` 命中每一个外链脚本，整站交互归零。
  const data = mkdtempSync(join(tmpdir(), 'heimdall-live-strip-'));
  const siteId = 'fixture.test';
  const site = join(data, 'workspace', siteId);
  try {
    const page = join(site, 'pages', 'home');
    put(page, 'manifest.json', JSON.stringify({ target: 'https://fixture.test/' }));
    put(data, join('workspace', siteId, 'site.json'), JSON.stringify({ live: { stripScriptPatterns: [], inlineStripPatterns: [] } }));
    put(page, 'dom.html', '<!doctype html><html><head></head><body>'
      + '<script src="/app.js"></script>'
      + '<script src="/chunk.js" defer></script>'
      + '<script>var inlined = 1;</script>'
      + '</body></html>');

    const result = build(data, siteId, 'home');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const html = readFileSync(join(site, 'live', 'index.html'), 'utf8');
    // 根相对 src 会被归一到代理前缀（prefixRootRelative），关键是脚本**还在**
    assert.match(html, /<script src="\/lm\/fixture\.test\/app\.js"><\/script>/);
    assert.match(html, /<script src="\/lm\/fixture\.test\/chunk\.js" defer><\/script>/);
    assert.match(html, /var inlined = 1;/);
    assert.doesNotMatch(html, /<!-- heimdall: widget script stripped -->/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});

test('live build: rel="preload stylesheet" 也算样式表，必须被本地 cssom 顶替', () => {
  // 复现：精确匹配 rel="stylesheet" 漏掉 token 列表形态（vitest.dev 首页就是这条），
  // 它被原样留进镜像、指向原站根路径、本地 404。
  const data = mkdtempSync(join(tmpdir(), 'heimdall-live-rel-'));
  const siteId = 'fixture.test';
  const site = join(data, 'workspace', siteId);
  try {
    const page = join(site, 'pages', 'home');
    put(page, 'manifest.json', JSON.stringify({ target: 'https://fixture.test/' }));
    put(page, 'dom.html', '<!doctype html><html><head>'
      + '<link rel="preload stylesheet" href="/assets/style.css" as="style">'
      + '<link rel="stylesheet" href="/assets/plain.css">'
      + '<link rel="preload" href="/font.woff2" as="font" crossorigin>'
      + '</head><body><p>x</p></body></html>');

    const result = build(data, siteId, 'home');
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const html = readFileSync(join(site, 'live', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /\/assets\/style\.css/);
    assert.doesNotMatch(html, /\/assets\/plain\.css/);
    assert.match(html, /href="\/static\/fixture\.test\/pages\/home\/clone\/styles\/cssom\.css"/);
    assert.match(html, /\/font\.woff2/);
  } finally {
    rmSync(data, { recursive: true, force: true });
  }
});
