import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { parseSvgDesign, importDesignExports, decodeXml, hexColor } from '../src/design/import.mjs';
import { DESIGN_SCHEMA } from '../src/design/figma.mjs';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'design-export', 'pricing.svg');

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'heimdall-design-import-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function pngBytes(width, height) {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

test('parseSvgDesign：文字、tspan 拼接、实体、字体、颜色与画板尺寸', () => {
  const r = parseSvgDesign(readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual([r.width, r.height], [375, 812]);
  assert.deepEqual(r.texts.map(x => x.characters), ['欢迎使用 Xspark', 'Terms & Conditions — read…\n第二行', '¥99/月']);

  const [title, terms, price] = r.texts;
  assert.deepEqual(
    [title.fontFamily, title.fontSize, title.fontWeight, title.color, title.box, title.baseline],
    ['PingFang SC', 24, 600, '#1a334d', null, { x: 16, y: 64.5 }],
  );
  assert.deepEqual([terms.fontFamily, terms.fontSize, terms.fontWeight, terms.lineHeightPx, terms.color], ['Inter', 14, 700, 20, '#333333'], '内联 style 里的字体');
  assert.deepEqual([price.fontWeight, price.color], [700, '#ff5a00']);

  assert.deepEqual(r.colors.map(c => c.hex), ['#ffffff', '#f5f7fa', '#1a334d', '#333333', '#ff5a00']);
  assert.ok(!r.colors.some(c => c.hex === '#123456'), 'defs / clipPath 里的颜色不算');
  assert.ok(!r.colors.some(c => c.hex === '#e5e5e5'), '只看 fill，不看 stroke');
  assert.deepEqual(r.fonts, [
    { family: 'PingFang SC', size: 24, weight: 600, count: 1 },
    { family: 'Inter', size: 14, weight: 700, count: 1 },
    { family: 'PingFang SC', size: 32, weight: 700, count: 1 },
  ]);
  assert.deepEqual(r.warnings, []);
});

test('parseSvgDesign：没有 width/height（或是百分比）时用 viewBox；文字转成路径时给出警告', () => {
  const vb = parseSvgDesign('<svg viewBox="0 0 1440 900" xmlns="http://www.w3.org/2000/svg"><text style="font-size:16px;fill:rgb(255, 0, 0)">Hi</text></svg>');
  assert.deepEqual([vb.width, vb.height], [1440, 900]);
  assert.deepEqual([vb.texts[0].fontSize, vb.texts[0].color], [16, '#ff0000']);
  const pct = parseSvgDesign('<svg width="100%" height="100%" viewBox="0,0,320,640"></svg>');
  assert.deepEqual([pct.width, pct.height], [320, 640]);

  const outlined = parseSvgDesign('<svg width="10" height="10"><path d="M0 0h10" fill="#000"/></svg>');
  assert.equal(outlined.texts.length, 0);
  assert.match(outlined.warnings[0], /Outline text/);
});

test('decodeXml / hexColor', () => {
  assert.equal(decodeXml('&lt;a&gt; &amp;amp; &#20013;&#x6587; &quot;&apos;'), '<a> &amp; 中文 "\'');
  assert.equal(decodeXml('&unknown; &#xZZ;'), '&unknown; &#xZZ;');
  assert.equal(hexColor('#ABC'), '#aabbcc');
  assert.equal(hexColor('#11223344'), '#112233');
  assert.equal(hexColor('rgba(10, 20, 30, 0.5)'), '#0a141e');
  assert.equal(hexColor('none'), null);
  assert.equal(hexColor('url(#paint0_linear)'), null);
});

test('importDesignExports：SVG 与同名 @2x PNG 合成一个画板，单独的 PNG 读尺寸并复制', t => {
  const dir = tempDir(t), outDir = join(tempDir(t), 'out');
  copyFileSync(FIXTURE, join(dir, 'pricing.svg'));
  writeFileSync(join(dir, 'pricing@2x.png'), pngBytes(8, 6));
  writeFileSync(join(dir, '首页.png'), pngBytes(5, 3));
  writeFileSync(join(dir, 'broken.png'), 'not a png');
  writeFileSync(join(dir, 'notes.txt'), 'ignored');

  const { design } = importDesignExports({ dir, outDir });
  assert.equal(design.schema, DESIGN_SCHEMA);
  assert.equal(design.source.via, 'svg');
  assert.equal(design.frames.length, 2);
  const byName = Object.fromEntries(design.frames.map(f => [f.name, f]));

  const pricing = byName.pricing, home = byName['首页'];
  assert.equal(pricing.via, 'svg');
  assert.deepEqual([pricing.width, pricing.height, pricing.svg, pricing.image], [375, 812, 'frames/pricing.svg', 'frames/pricing.png']);
  assert.deepEqual([pricing.imageWidth, pricing.imageHeight, pricing.imageScale], [8, 6, 2]);
  assert.equal(pricing.texts.length, 3);
  assert.deepEqual([home.via, home.width, home.height, home.texts, home.image], ['png', 5, 3, [], 'frames/首页.png']);
  assert.ok(existsSync(join(outDir, 'frames', '首页.png')));
  assert.ok(existsSync(join(outDir, 'frames', 'pricing.svg')));
  assert.ok(existsSync(join(outDir, 'frames', 'pricing.png')));
  assert.deepEqual(design.warnings, ['broken.png 不是有效的 PNG，已跳过']);
  assert.deepEqual(JSON.parse(readFileSync(join(outDir, 'design.json'), 'utf8')), design);
});

test('importDesignExports：只有 PNG 时 via 为 png，@2x 换算回设计稿尺寸；空目录与不存在的目录报错', t => {
  const dir = tempDir(t), outDir = join(tempDir(t), 'out');
  writeFileSync(join(dir, 'home@2x.png'), pngBytes(750, 4));
  const { design } = importDesignExports({ dir, outDir });
  assert.equal(design.source.via, 'png');
  const [home] = design.frames;
  assert.deepEqual([home.name, home.width, home.height, home.imageWidth], ['home', 375, 2, 750]);

  assert.throws(() => importDesignExports({ dir: tempDir(t), outDir }), (error) => error.code === 'design_import_failed' && /Outline text/.test(error.message));
  assert.throws(() => importDesignExports({ dir: join(dir, 'missing'), outDir }), { code: 'design_import_failed' });
  assert.throws(() => importDesignExports({}), { code: 'design_import_failed' });
});
