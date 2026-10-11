/**
 * 改站起点清单
 *
 * 这条来自产品判断：用户拿这个项目是想**做竞品站**——换域名、换图、换文案。
 * 数据本来就在（asset-map 知道资源从哪来、intel 知道每页文案），但散在几十个
 * JSON 里没人愿意翻。这个模块把它们按"要改什么"重排，所以测的重点是**归类对不对**：
 * 视觉资产有没有被单独挑出来、域名统计有没有只数渲染文件、json 有没有被误算进去。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// paths.mjs 在导入时读 HEIMDALL_DATA_DIR，所以必须先设环境再动态导入
const DATA = mkdtempSync(join(tmpdir(), 'heimdall-em-'));
process.env.HEIMDALL_DATA_DIR = DATA;

const { buildEditManifest, renderEditManifestMd } = await import('../src/deliver/edit-manifest.mjs');

function fixture() {
  const ws = join(DATA, 'workspace', 'example.test');
  const mk = (p) => mkdirSync(join(ws, p), { recursive: true });
  const w = (p, s) => { mkdirSync(join(ws, p, '..'), { recursive: true }); writeFileSync(join(ws, p), s); };

  for (const page of ['home', 'docs']) {
    mk(`pages/${page}/clone/assets`);
    w(`pages/${page}/clone/index.html`, `<!doctype html><link rel="canonical" href="https://example.test/${page}"><img src="https://cdn.example.test/logo.png"><a href="https://example.test/x">x</a>`);
    w(`pages/${page}/clone/assets/image000.png`, 'PNGDATA');
    w(`pages/${page}/manifest.json`, JSON.stringify({ target: `https://example.test/${page === 'home' ? '' : page}` }));
  }
  w('pages/home/asset-map.json', JSON.stringify({
    imgMap: { 'https://cdn.example.test/logo.png': 'assets/image000.png' },
    resMap: { 'https://cdn.example.test/logo.png': 'assets/image000.png' },
    resources: [{ url: 'https://cdn.example.test/logo.png', kinds: ['image'] }],
  }));
  w('pages/home/intel/intel.json', JSON.stringify({
    meta: { title: '首页标题', description: '描述' },
    headings: [{ level: 'h1', text: '大标题' }, { level: 'h2', text: '副标题' }],
    cta: ['开始使用'], prices: ['¥99'],
  }));
  w('audit/asset-gaps.json', JSON.stringify({
    pages: [{ page: 'home', gaps: [
      { url: 'https://third.example.test/x.png', kind: 'img', category: 'visual', status: 'remote-third-party', where: 'img' },
      { url: 'https://example.test/track.gif', kind: 'img', category: 'tracking', status: 'remote-origin', where: 'img' },
    ] }],
  }));
  return ws;
}

fixture();
const m = buildEditManifest('example.test');

test('页面与资源：只数"已克隆"的页，资源按原始 URL 去重并能定位到本地路径', () => {
  assert.equal(m.counts.pages, 2, '两页都有 clone/index.html');
  assert.equal(m.counts.assets, 1, '同一个 URL 在两页出现只算一个资源');
  const a = m.assets[0];
  assert.equal(a.url, 'https://cdn.example.test/logo.png');
  assert.equal(a.local, 'assets/image000.png');
  assert.equal(a.kind, '图片');
  assert.equal(a.pageCount, 1, '只有 home 的 asset-map 提到了它');
  assert.deepEqual(a.pages, ['home']);
});

test('视觉缺口只收 category=visual —— 追踪像素不该混进"要换的图"里', () => {
  assert.equal(m.counts.remoteVisual, 1);
  assert.equal(m.remote[0].url, 'https://third.example.test/x.png');
  assert.ok(!m.remote.some(r => r.url.includes('track.gif')), 'tracking 类不得出现在视觉缺口里');
});

test('域名统计：只数会参与渲染的文本，json 里的"来源记录"不算', () => {
  assert.ok(m.counts.domainTotal >= 4, `html 里至少 4 处（2 页各 canonical + 正文链接）实际 ${m.counts.domainTotal}`);
  const paths = m.domain.files.map(f => f.path);
  assert.ok(paths.every(p => p.endsWith('.html')), '只应统计 html/css：' + paths.join(','));
  assert.ok(!paths.some(p => p.endsWith('.json')), 'json 不该进域名统计（那是来源记录，不是渲染内容）');
});

test('文案表：标题/H1/CTA/价格都归到页上', () => {
  assert.equal(m.counts.copyPages, 1);
  const c = m.copy[0];
  assert.equal(c.page, 'home');
  assert.equal(c.title, '首页标题');
  assert.deepEqual(c.h1, ['大标题']);
  assert.deepEqual(c.cta, ['开始使用']);
  assert.deepEqual(c.prices, ['¥99']);
});

test('Markdown 版：三张表都在，且写明边界', () => {
  const md = renderEditManifestMd(m);
  assert.match(md, /换成你的域名/);
  assert.match(md, /换成你的图片/);
  assert.match(md, /换成你的文案/);
  assert.match(md, /仍未本地化|本地路径/, '资源表要有本地路径列');
  assert.match(md, /RISKS\.md/, '必须写明商用边界');
});

test.after(() => { try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 上有句柄时忽略 */ } });
