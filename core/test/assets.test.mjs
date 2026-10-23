import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanPage } from '../src/audit/assets.mjs';

const makePage = (dir, css) => {
  mkdirSync(join(dir, 'clone', 'styles'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ target: 'https://x.test/pricing' }));
  writeFileSync(join(dir, 'dom.html'), '<html><head></head><body><img src="https://x.test/hero.png"></body></html>');
  writeFileSync(join(dir, 'clone', 'index.html'), '<html><head><link rel="stylesheet" href="styles/cssom.css"></head><body><img src="assets/hero.png"></body></html>');
  writeFileSync(join(dir, 'clone', 'styles', 'cssom.css'), css);
  writeFileSync(join(dir, 'clone', 'styles', 'ref000.woff2'), 'FONT');
  mkdirSync(join(dir, 'clone', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'clone', 'assets', 'hero.png'), 'PNG');
};

test('assets: healthy clone CSS (same-dir font url) has no visual gaps', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-assets-'));
  try {
    makePage(dir, '@font-face { font-family: Inter; src: url("ref000.woff2") format("woff2"); }');
    const r = scanPage(dir, { origin: 'https://x.test' });
    assert.equal(r.visualGaps, 0, JSON.stringify(r.gaps));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assets: legacy styles/styles/refNNN.woff2 path is a clone-broken visual gap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-assets-'));
  try {
    makePage(dir, '@font-face { font-family: Inter; src: url("styles/ref000.woff2") format("woff2"); }');
    const r = scanPage(dir, { origin: 'https://x.test' });
    assert.ok(r.visualGaps >= 1, 'broken font ref must be a visual gap: ' + JSON.stringify(r.gaps.slice(0, 3)));
    assert.ok(r.gaps.some(g => g.status === 'clone-broken'), 'gap status must be clone-broken');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assets: data-URI 内嵌的 mask url(%23f) 不算克隆缺口（否则孤儿回滚会误判）', () => {
  // 复现：自写 url() 正则把 data URI 里的 `mask='url(%23f)'` 抽成 `%23f`，
  // 解析成 https://x.test/%23f、落成 clone-broken 视觉缺口；而回收孤儿回滚判据读的正是 visualGaps。
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-assets-'));
  try {
    makePage(dir, '.i { background-image: url("data:image/svg+xml,%3Csvg%3E%3Cg mask=\'url(%23f)\'/%3E%3C/svg%3E"); }');
    const r = scanPage(dir, { origin: 'https://x.test' });
    assert.equal(r.visualGaps, 0, JSON.stringify(r.gaps.slice(0, 3)));
    assert.ok(!r.gaps.some(g => g.url.endsWith('/%23f')), '内嵌 mask 引用不得被扫成外部引用');
    assert.ok(!r.gaps.some(g => g.kind === 'css-url'), 'CSS 里除了 data URI 没有别的引用：' + JSON.stringify(r.gaps.slice(0, 3)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('assets: 被注释掉的 url() 不算缺口', () => {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-assets-'));
  try {
    makePage(dir, '/* .old { background: url(/legacy/gone.png) } */\nbody { color: red; }');
    const r = scanPage(dir, { origin: 'https://x.test' });
    assert.ok(!r.gaps.some(g => g.url.includes('/legacy/gone.png')), JSON.stringify(r.gaps.slice(0, 3)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
