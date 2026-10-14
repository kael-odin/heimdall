import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const CORE = fileURLToPath(new URL('..', import.meta.url));
const DELIVER = fileURLToPath(new URL('../src/deliver.mjs', import.meta.url));
const HOST = 'fixture.test';

function put(root, rel, content) {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [DELIVER, HOST, ...args], {
    cwd: CORE, env: { ...process.env, HEIMDALL_DATA_DIR: root }, encoding: 'utf8', timeout: 30_000,
  });
}

function output(root) {
  const names = readdirSync(join(root, 'deliverable'));
  return join(root, 'deliverable', names.find(name => name.startsWith(`${HOST}-20`)));
}

test('static deliver sanitizes only its candidate clone and retains the previous bundle', { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-static-deliver-'));
  const site = join(root, 'workspace', HOST);
  const clone = join(site, 'pages', 'home', 'clone');
  let browser;
  const legacyChooser = '<!doctype html><script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html")</script>';
  const oldPage = '<!doctype html><html><body><h1>Captured</h1><img src="missing.png" onerror="window.__unsafe=true"><script>window.__unsafe=true</script></body></html>';
  try {
    put(clone, 'index.html', legacyChooser);
    put(clone, 'index-375.html', oldPage);
    put(site, 'pages/about/clone/index.html', oldPage);
    put(site, 'pages/home/manifest.json', JSON.stringify({ target: `https://${HOST}/` }));
    put(site, 'pages/about/manifest.json', JSON.stringify({ target: `https://${HOST}/about` }));
    put(site, 'pages/home/score.json', JSON.stringify({ total: 92, grade: 'B', pixel: 0.92, dom: { dom: 0.9 }, data: { data: 0.9 } }));
    const deliverable = join(root, 'deliverable');
    mkdirSync(deliverable);
    const prior = join(deliverable, `${HOST}-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`);
    put(prior, 'keep.txt', 'last good bundle');

    const first = run(root);
    assert.equal(first.status, 0, first.stderr + first.stdout);
    const out = output(root);
    const chooser = readFileSync(join(out, 'site/pages/home/clone/index.html'), 'utf8');
    const cleaned = readFileSync(join(out, 'site/pages/home/clone/index-375.html'), 'utf8');
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    assert.match(readme, /自有或获授权站点/);
    assert.match(readme, /历史辅助口径/);
    assert.match(readme, /v2 多视口验证/);
    const entry = readme.match(/启动后打开 \`\/([^\`]+)\`/);
    assert.ok(entry, 'README links to a concrete bundle entry');
    assert.ok(existsSync(join(out, 'site', entry[1])), 'README entry exists in the bundle');
    assert.match(readme, /没有站点汇总页/);
    assert.match(readme, /\| \`home\` \| 92 \| B \| - \|/, 'missing motion breakdown is not reported as zero');
    assert.doesNotMatch(readme, /抄视觉|抄结构|读竞品|可以直接照搬结构|全部生效 CSS|最终计算态/);
    assert.doesNotMatch(readme, /同一条命令跑两次结果一致|旧的可以删/);
    assert.match(chooser, /location\.replace\(innerWidth<=600\?/);
    assert.doesNotMatch(chooser, /index-768\.html|index-1440\.html/);
    assert.match(cleaned, /<h1>Captured<\/h1>/);
    assert.doesNotMatch(cleaned, /<script\b|\sonerror\s*=/i);
    assert.doesNotMatch(readFileSync(join(out, 'site/pages/about/clone/index.html'), 'utf8'),
      /<script\b|\sonerror\s*=/i, 'single-width historical HTML is sanitized');
    assert.equal(readFileSync(join(clone, 'index-375.html'), 'utf8'), oldPage, 'workspace source remains unchanged');
    browser = await chromium.launch();
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(pathToFileURL(join(out, 'site/pages/home/clone/index.html')).href);
    await mobile.waitForURL('**/index-375.html');
    assert.equal(await mobile.locator('h1').textContent(), 'Captured');
    assert.equal(await mobile.evaluate(() => window.__unsafe === true), false);
    const backup = readdirSync(deliverable).find(name => name.startsWith(`.backup-${HOST}-`));
    assert.equal(readFileSync(join(deliverable, backup, 'keep.txt'), 'utf8'), 'last good bundle');

    rmSync(join(clone, 'index-375.html'));
    const second = run(root);
    assert.notEqual(second.status, 0, 'missing chooser variants must fail candidate validation');
    assert.equal(readFileSync(join(out, 'site/pages/home/clone/index.html'), 'utf8'), chooser,
      'failed rebuild must leave the promoted bundle unchanged');
    assert.ok(readdirSync(deliverable).some(name => name.startsWith(`.candidate-${HOST}-`)),
      'failed candidate remains available for inspection');
    assert.ok(existsSync(join(deliverable, backup, 'keep.txt')));
  } finally {
    await browser?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
