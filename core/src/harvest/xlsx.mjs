/**
 * xlsx — 跨页情报汇总（真 Excel，exceljs）
 *
 * 汇总 workspace/<host>/pages/ 下所有页面的 intel.json / semantic.json / score.json：
 *   Sheet「概览」   每页还原度三维 + 评级 + 情报计数
 *   Sheet「语义情报」页面类型 / 价值主张 / 套餐 / 产品 / 官方宣称
 *   Sheet「定价与CTA」价格 token 与 CTA 文案全量
 * 输出 workspace/<host>/intel/<host>-intel.xlsx
 *
 * 用法: node src/harvest/xlsx.mjs <host>
 */
import { readFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';
import ExcelJS from 'exceljs';

const host = requireArg(process.argv[2], 'node src/harvest/xlsx.mjs <host>', '站点 host');
const hostDir = (process.argv[4] ?? process.argv[3] ?? host).replace(/^--hostDir\s*/, '');
const BASE = join(WORKSPACE, hostDir);
const PAGES = join(BASE, 'pages');

const pages = existsSync(PAGES) ? readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'intel', 'intel.json'))) : [];
if (!pages.length) { console.error('no intel found under', PAGES); process.exit(1); }

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const wb = new ExcelJS.Workbook();
wb.creator = 'Heimdall';

// ---------- 概览 ----------
const ov = wb.addWorksheet('概览');
ov.columns = [
  { header: '页面', key: 'page', width: 28 }, { header: '还原度', key: 'total', width: 10 },
  { header: '评级', key: 'grade', width: 8 }, { header: '像素', key: 'pixel', width: 10 },
  { header: '结构', key: 'dom', width: 10 }, { header: '数据', key: 'data', width: 10 },
  { header: '可修性', key: 'refinable', width: 10 }, { header: '页面类型', key: 'pageType', width: 12 },
  { header: '标题数', key: 'h', width: 8 }, { header: '价格数', key: 'p', width: 8 },
  { header: 'CTA数', key: 'c', width: 8 }, { header: '链接数', key: 'l', width: 8 },
];
ov.getRow(1).font = { bold: true };
ov.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF05060A' } };
ov.getRow(1).font = { bold: true, color: { argb: 'FF22D3EE' } };

// ---------- 语义情报 ----------
const semSheet = wb.addWorksheet('语义情报');
semSheet.columns = [
  { header: '页面', key: 'page', width: 24 }, { header: '类型', key: 'type', width: 10 },
  { header: '条目', key: 'kind', width: 12 }, { header: '名称', key: 'name', width: 24 },
  { header: '内容', key: 'content', width: 80 },
];
semSheet.getRow(1).font = { bold: true };

// ---------- 定价与CTA ----------
const pxSheet = wb.addWorksheet('定价与CTA');
pxSheet.columns = [
  { header: '页面', key: 'page', width: 24 }, { header: '种类', key: 'kind', width: 10 }, { header: '内容', key: 'value', width: 90 },
];
pxSheet.getRow(1).font = { bold: true };

for (const name of pages) {
  const dir = join(PAGES, name);
  const score = readJson(join(dir, 'score.json'));
  const intel = readJson(join(dir, 'intel', 'intel.json'));
  const semantic = readJson(join(dir, 'intel', 'semantic.json'));
  ov.addRow({
    page: name,
    total: score?.total ?? '-', grade: score?.grade ?? '-',
    pixel: score ? (score.pixel * 100).toFixed(1) + '%' : '-',
    dom: score ? (score.dom?.dom * 100).toFixed(1) + '%' : '-',
    data: score?.data ? (score.data.data * 100).toFixed(1) + '%' : '-',
    refinable: score?.breakdown ? (score.breakdown.refinable * 100).toFixed(0) + '%' : '-',
    pageType: semantic?.pageType ?? '-',
    h: intel?.headings?.length ?? 0, p: intel?.prices?.length ?? 0,
    c: intel?.cta?.length ?? 0, l: intel?.links?.length ?? 0,
  });

  if (semantic) {
    for (const v of semantic.valueProps ?? []) semSheet.addRow({ page: name, type: semantic.pageType, kind: '价值主张', name: '', content: v });
    for (const p of semantic.products ?? []) semSheet.addRow({ page: name, type: semantic.pageType, kind: '产品', name: p.name, content: p.oneLiner });
    for (const p of semantic.plans ?? []) semSheet.addRow({ page: name, type: semantic.pageType, kind: '套餐', name: `${p.name}（${p.price} / ${p.billing}）`, content: (p.features ?? []).join('；') });
    for (const c of semantic.notableClaims ?? []) semSheet.addRow({ page: name, type: semantic.pageType, kind: '官方宣称', name: '', content: c });
  }
  for (const p of intel?.prices ?? []) pxSheet.addRow({ page: name, kind: '价格', value: p });
  for (const c of intel?.cta ?? []) pxSheet.addRow({ page: name, kind: 'CTA', value: c });
}

mkdirSync(join(BASE, 'intel'), { recursive: true });
const OUT = join(BASE, 'intel', `${host}-intel.xlsx`);
await wb.xlsx.writeFile(OUT);
console.log(`xlsx -> ${OUT} (${pages.length} pages)`);
