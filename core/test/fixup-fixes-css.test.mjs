/**
 * `fixes.css` 的 link 在重建后不能被抹掉
 *
 * 已发生的真实缺陷：fixup 每轮把补丁写进 `clone/styles/fixes.css` 并给
 * `clone/index.html` 注入 link，但 build_clone 是整页重写 —— 重建之后 link 没了，
 * fixes.css 还在，fixup-history.json 也还记着 `kept:true`。界面上"AI 修复已保留"，
 * 产物里没有任何页面加载那条补丁。
 *
 * 修法是把"检测 fixes.css 存在就补 link"做成一个幂等函数 `ensureFixupLink(pageDir)`，
 * 由 build_clone 收尾统一调用。本用例只测那个函数本身（不起浏览器）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureFixupLink } from '../src/differ/fixup.mjs';

const PAGE_HTML = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="styles/cssom.css"></head>'
  + '<body><main>hi</main></body></html>';
const CHOOSER_HTML = '<!doctype html><html><head><meta charset="utf-8">'
  + '<script>location.replace(innerWidth<=600?"index-375.html":innerWidth<=1100?"index-768.html":"index-1440.html");</script>'
  + '</head><body></body></html>';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-fixup-link-'));
  const pageDir = join(root, 'pages', 'home');
  mkdirSync(join(pageDir, 'clone', 'styles'), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(pageDir, 'clone', name), body);
  return { root, pageDir, read: (n) => readFileSync(join(pageDir, 'clone', n), 'utf8') };
}

const count = (text, needle) => text.split(needle).length - 1;

test('ensureFixupLink：没有 fixes.css 时不动任何页面', () => {
  const f = fixture({ 'index.html': PAGE_HTML, 'index-375.html': PAGE_HTML });
  try {
    assert.deepEqual(ensureFixupLink(f.pageDir), { linked: [], missing: true });
    assert.equal(f.read('index.html'), PAGE_HTML);
    assert.equal(f.read('index-375.html'), PAGE_HTML);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ensureFixupLink：补进 index 与各视口页，且幂等', () => {
  const f = fixture({
    'index.html': CHOOSER_HTML,
    'index-375.html': PAGE_HTML,
    'index-768.html': PAGE_HTML,
    'index-1440.html': PAGE_HTML,
    'index-999.html': PAGE_HTML,           // 非已知视口（历史遗留）：不该碰
    'styles/fixes.css': 'main{padding:0}\n',
  });
  try {
    const first = ensureFixupLink(f.pageDir);
    assert.equal(first.missing, false);
    assert.equal(first.linked.length, 4, 'index + 三个视口页');
    for (const name of ['index.html', 'index-375.html', 'index-768.html', 'index-1440.html']) {
      const html = f.read(name);
      assert.equal(count(html, 'styles/fixes.css'), 1, `${name} 恰好一条引用`);
      // link 必须在 </head> 之前，且排在站点样式之后（补丁要能覆盖）
      assert.ok(html.indexOf('styles/fixes.css') < html.indexOf('</head>'), `${name}: link 在 head 内`);
      assert.ok(html.indexOf('styles/cssom.css') < html.indexOf('styles/fixes.css'), `${name}: link 在站点样式之后`);
    }
    assert.equal(f.read('index-999.html'), PAGE_HTML, '未知视口页不动');

    const second = ensureFixupLink(f.pageDir);
    assert.deepEqual(second.linked, [], '第二次调用不再改任何文件');
    assert.equal(count(f.read('index-375.html'), 'styles/fixes.css'), 1, '幂等：不重复注入');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('ensureFixupLink：缺 pageDir 直接报错，不静默改错位置', () => {
  assert.throws(() => ensureFixupLink(''), /pageDir is required/);
  assert.throws(() => ensureFixupLink(), /pageDir is required/);
});
