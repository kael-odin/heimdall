/**
 * differ — 还原度评分（三维公式，data 维度 W4 harvest 接入）
 *
 *   pixel  pixelmatch 首屏对比            权重 0.5
 *   dom    DOM 结构相似度（domdiff）        权重 0.3
 *   data   结构化抽取覆盖度（W4 接入）       权重 0.2 —— 接入前按其余两维归一化
 *
 * total = 0.5*pixel + 0.3*dom (+ 0.2*data)，接入前 total = (0.5*pixel+0.3*dom)/0.8
 * grade: A ≥95 / B ≥85 / C <85
 *
 * 用法: node src/differ/diff.mjs <pageDir>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { domSimilarity } from './domdiff.mjs';
import { dataScore } from '../harvest/harvest.mjs';

const DIR = process.argv[2] ?? join('workspace', 'apify.com', 'pages', 'home');
const a = PNG.sync.read(readFileSync(join(DIR, 'shot-src.png')));
const b = PNG.sync.read(readFileSync(join(DIR, 'shot-clone.png')));

if (a.width !== b.width || a.height !== b.height) {
  console.error(`size mismatch: src ${a.width}x${a.height} vs clone ${b.width}x${b.height}`);
  process.exit(2);
}
const diff = new PNG({ width: a.width, height: a.height });
const mismatched = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
const totalPx = a.width * a.height;
const pixel = 1 - mismatched / totalPx;

const dom = domSimilarity(
  readFileSync(join(DIR, 'dom.html'), 'utf8'),
  readFileSync(join(DIR, 'clone', 'index.html'), 'utf8'),
);

// data 维度：src vs clone 结构化字段覆盖率（L1 搬运下应≈1）
let data;
try {
  data = dataScore(readFileSync(join(DIR, 'dom.html'), 'utf8'), readFileSync(join(DIR, 'clone', 'index.html'), 'utf8'));
} catch { data = null; }

const total = data ? 0.5 * pixel + 0.3 * dom.dom + 0.2 * data.data : (0.5 * pixel + 0.3 * dom.dom) / 0.8;
const grade = total >= 0.95 ? 'A' : total >= 0.85 ? 'B' : 'C';

const score = {
  page: DIR.split(/[\\/]/).pop(),
  viewport: `${a.width}x${a.height}`,
  pixel: +pixel.toFixed(4),
  dom,
  data,
  weights: { pixel: 0.5, dom: 0.3, data: 0.2 },
  dataNote: data ? 'full 3-dim formula' : 'harvest failed; normalized over pixel+dom',
  total: +(total * 100).toFixed(1),
  grade,
  mismatched,
  method: 'pixelmatch 0.1 + parse5 structural',
};
writeFileSync(join(DIR, 'score.json'), JSON.stringify(score, null, 2));
writeFileSync(join(DIR, 'diff.png'), PNG.sync.write(diff));
console.log(`pixel ${(pixel * 100).toFixed(2)}% | dom ${(dom.dom * 100).toFixed(2)}% (node ${dom.nodeRatio} tag ${dom.tagCos} cls ${dom.classJac}) | data ${data ? (data.data * 100).toFixed(2) + '%' : 'n/a'}`);
console.log(`TOTAL ${(total * 100).toFixed(1)}%  grade ${grade}`);
