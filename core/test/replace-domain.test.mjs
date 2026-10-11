/**
 * 域名替换
 *
 * 这条是**会写用户产物**的操作，所以测的重点全在"别改错"：
 *   · 主机名边界：`xexample.test` / `example.testfoo` 不能被误伤
 *   · 只动渲染文本：json 里的域名是来源记录，改了会让资源查找表失效
 *   · 预览绝不写盘；真改之前逐文件备份，且能从备份逐字节还原
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { domainMatcher, planReplace, runReplace } from '../src/deliver/replace-domain.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'heimdall-rd-'));

test('主机名边界：命中自身与子域，不命中"包含它但更长"的字符串', () => {
  // 每次新建 matcher：带 g 标志的正则 .test() 会推进 lastIndex，复用会得到交替结果
  const hit = (s) => domainMatcher('example.test').test(s);
  assert.equal(hit('https://example.test/a'), true);
  assert.equal(hit('https://cdn.example.test/a'), true, '子域应命中（子域部分原样保留）');
  assert.equal(hit('example.test'), true);
  assert.equal(hit('https://xexample.test/a'), false, '左边连着别的字母不算');
  assert.equal(hit('https://example.testfoo/a'), false, '后面还接着字母不算');
  assert.equal(hit('https://example-test/a'), false);
});

function fixtureWith(base) {
  mkdirSync(join(base, 'pages', 'home', 'clone'), { recursive: true });
  writeFileSync(join(base, 'pages', 'home', 'clone', 'index.html'),
    '<link rel="canonical" href="https://example.test/"><img src="https://cdn.example.test/logo.png"><p>xexample.test 不该动</p>');
  writeFileSync(join(base, 'pages', 'home', 'clone', 'ref-index.json'),
    JSON.stringify({ 'https://example.test/a': 'assets/a.png' }));
  writeFileSync(join(base, 'pages', 'home', 'clone', 'app.js'),
    'fetch("https://example.test/api")');
}

test('预览：只报读数，不写任何文件；命中数与子域都对', () => {
  const base = tmp();
  fixtureWith(base);
  const before = readFileSync(join(base, 'pages', 'home', 'clone', 'index.html'), 'utf8');
  const s = runReplace({ host: 'h', from: 'example.test', to: 'mysite.com', apply: false, base });
  assert.equal(s.mode, 'preview');
  assert.equal(s.changed, 0);
  assert.equal(s.occurrences, 2, 'canonical + cdn 子域（xexample.test 因边界不命中）');
  assert.deepEqual(s.subdomains.map(x => x.name).sort(), ['cdn.example.test', 'example.test']);
  assert.equal(readFileSync(join(base, 'pages', 'home', 'clone', 'index.html'), 'utf8'), before, '预览不得改动文件');
  rmSync(base, { recursive: true, force: true });
});

test('真改：默认只动 html/css，json 与 js 原样；且能给出备份', () => {
  const base = tmp();
  fixtureWith(base);
  const jsonBefore = readFileSync(join(base, 'pages', 'home', 'clone', 'ref-index.json'), 'utf8');
  const jsBefore = readFileSync(join(base, 'pages', 'home', 'clone', 'app.js'), 'utf8');
  const s = runReplace({ host: 'h', from: 'example.test', to: 'mysite.com', apply: true, base });
  assert.equal(s.mode, 'apply');
  assert.equal(s.changed, 1, '只有 index.html 在默认范围内');
  const html = readFileSync(join(base, 'pages', 'home', 'clone', 'index.html'), 'utf8');
  assert.match(html, /mysite\.com/);
  assert.match(html, /cdn\.mysite\.com/, '子域应保留子域部分');
  assert.match(html, /xexample\.test 不该动/, '边界外的字符串必须原样');
  assert.equal(readFileSync(join(base, 'pages', 'home', 'clone', 'ref-index.json'), 'utf8'), jsonBefore, 'json 是来源记录，绝不能改');
  assert.equal(readFileSync(join(base, 'pages', 'home', 'clone', 'app.js'), 'utf8'), jsBefore, 'js 不在默认范围内');
  assert.ok(s.backup, '应给出备份路径');
  rmSync(base, { recursive: true, force: true });
});

test('备份是逐字节可还原的（这是"敢改"的前提）', () => {
  const base = tmp();
  fixtureWith(base);
  const src = join(base, 'pages', 'home', 'clone', 'index.html');
  const original = readFileSync(src, 'utf8');
  const s = runReplace({ host: 'h', from: 'example.test', to: 'mysite.com', apply: true, base });
  const bak = join(base, s.backup, 'pages', 'home', 'clone', 'index.html');
  assert.ok(existsSync(bak), '备份文件应存在');
  assert.equal(readFileSync(bak, 'utf8'), original, '备份内容必须与原始逐字节一致');
  rmSync(base, { recursive: true, force: true });
});

test('--js 打开后 js 也进范围，但 json 依然不动', () => {
  const base = tmp();
  fixtureWith(base);
  const s = runReplace({ host: 'h', from: 'example.test', to: 'mysite.com', apply: true, js: true, base });
  assert.equal(s.changed, 2, 'html + js');
  assert.match(readFileSync(join(base, 'pages', 'home', 'clone', 'app.js'), 'utf8'), /mysite\.com/);
  assert.match(readFileSync(join(base, 'pages', 'home', 'clone', 'ref-index.json'), 'utf8'), /example\.test/, 'json 仍不动');
  rmSync(base, { recursive: true, force: true });
});

test('planReplace：没有 pages 目录时返回空计划，不抛', () => {
  const base = tmp();
  const p = planReplace({ base, from: 'example.test' });
  assert.equal(p.targets.length, 0);
  assert.equal(p.subdomains.size, 0);
  assert.deepEqual(readdirSync(base), []);
  rmSync(base, { recursive: true, force: true });
});
