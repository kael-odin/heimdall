/**
 * harvest — 结构化情报抽取（规则版 v1，LLM 增强留插槽）
 *
 * 从渲染后 DOM 抽取竞品情报字段，供情报包（Excel/JSON）与 data 维度评分使用：
 *   meta      title/description/og —— 站点自我陈述
 *   headings  h1-h3 文本树          —— 信息架构
 *   prices    价格 token            —— 定价情报
 *   cta       按钮/主链接文本        —— 转化路径
 *   tables    <table> 行列          —— 结构化数据
 *   links     站内链接清单           —— 站点拓扑
 *
 * LLM 插槽：env HEIMDALL_LLM=1 时对低置信字段做增强（W4 后期接 key）。
 *
 * 导出：
 *   extractProfile(html)          → 字段画像（供 data 维度对比）
 *   node src/harvest/harvest.mjs <pageDir>  → intel/<name>.json + intel/intel.csv
 */
import { parse } from 'parse5';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';

const SKIP = new Set(['script', 'style', 'noscript', 'template']);

function walk(node, fn) {
  fn(node);
  for (const c of node.childNodes ?? []) walk(c, fn);
}

function attr(node, name) {
  return node.attrs?.find(a => a.name === name)?.value ?? null;
}

function textOf(node) {
  let t = '';
  walk(node, n => { if (n.nodeName === '#text') t += n.value; });
  return t.replace(/\s+/g, ' ').trim();
}

function textOfVisible(node) {
  let t = '';
  const rec = (n) => {
    if (SKIP.has(n.tagName)) return;   // 子树剪枝：script 内的 RSC payload 不得混入可见文本
    if (n.nodeName === '#text') t += n.value;
    for (const c of n.childNodes ?? []) rec(c);
  };
  rec(node);
  return t.replace(/\s+/g, ' ').trim();
}

export function extractProfile(html) {
  const doc = parse(html);
  const body = (function find(n, name) {
    if (n.nodeName === name) return n;
    for (const c of n.childNodes ?? []) { const r = find(c, name); if (r) return r; }
    return null;
  })(doc, 'body');

  const meta = {}, headings = [], prices = [], cta = [], tables = [], links = [];
  const priceRe = /(?:[$€£¥]\s?\d[\d,.]*)|(?:\b\d[\d,.]*\s?(?:USD|EUR|CNY|元|美元)\/?\w*)/g;

  walk(doc, n => {
    if (n.tagName === 'meta') {
      const k = attr(n, 'name') ?? attr(n, 'property');
      const v = attr(n, 'content');
      if (k && v && ['title', 'description', 'og:title', 'og:description'].includes(k)) meta[k] = v.slice(0, 200);
    }
    if (n.tagName === 'title') meta.title = textOf(n).slice(0, 200);
  });

  walk(body ?? doc, n => {
    if (SKIP.has(n.tagName)) return;
    if (/^h[1-3]$/.test(n.tagName ?? '')) {
      const t = textOf(n);
      if (t) headings.push({ level: n.tagName, text: t.slice(0, 120) });
    }
    if (n.tagName === 'button' || (n.tagName === 'a' && /btn|button|cta/i.test(attr(n, 'class') ?? ''))) {
      const t = textOf(n);
      if (t && t.length <= 40) cta.push(t);
    }
    if (n.tagName === 'a') {
      const href = attr(n, 'href');
      if (href && !/^(#|mailto:|javascript:)/.test(href)) links.push(href.split('#')[0]);
    }
    if (n.tagName === 'table') {
      const rows = [...(n.childNodes ?? [])].flatMap(tr =>
        tr.nodeName === 'tbody' || tr.nodeName === 'thead'
          ? [...(tr.childNodes ?? [])].filter(r => r.tagName === 'tr').map(r => [...(r.childNodes ?? [])].filter(c => c.tagName?.startsWith('td') || c.tagName?.startsWith('th')).map(c => textOf(c).slice(0, 60)))
          : []);
      if (rows.length) tables.push(rows.slice(0, 20));
    }
  });

  // 价格从全文可见文本扫描（排除 script/style —— 克隆页无脚本，情报只认可见内容）
  const bodyText = textOfVisible(body ?? doc);
  const pm = bodyText.match(priceRe) ?? [];
  prices.push(...[...new Set(pm)].slice(0, 40));

  return { meta, headings: headings.slice(0, 60), prices: [...new Set(prices)].slice(0, 40), cta: [...new Set(cta)].slice(0, 30), tables, links: [...new Set(links)].slice(0, 100) };
}

/**
 * data 维度：src 字段画像 vs clone 画像的覆盖率（L1 搬运下应≈1）
 *
 * **必须在 linker 之前测**（pipeline 的 stage 顺序已经保证）。linker 会把站内
 * `<a href>` 改写成档案内的相对路径 —— 那是它的职责，也正是这个维度只能测未接线版本的原因：
 * 它问的是"原站的数据字段有没有搬过来"，不是"接线之后路径长什么样"。
 * 手工重跑 `differ/diff.mjs` 时若不先重建 clone，links 一项会掉到 ~15%，
 * 那是个没有意义的读数（实测 vercel.com/home 就这么被骗过一次）。
 */
export function dataScore(srcHtml, cloneHtml) {
  const a = extractProfile(srcHtml), b = extractProfile(cloneHtml);
  const cover = (xs, ys) => {
    if (!xs.length) return null;
    const ysSet = new Set(ys.map(y => JSON.stringify(y)));
    const hit = xs.filter(x => ysSet.has(JSON.stringify(x))).length;
    return hit / xs.length;
  };
  const dims = {
    meta: cover(Object.entries(a.meta), Object.entries(b.meta)),
    headings: cover(a.headings, b.headings),
    prices: cover(a.prices, b.prices),
    cta: cover(a.cta, b.cta),
    links: cover(a.links, b.links),
    tables: cover(a.tables, b.tables),
  };
  const present = Object.values(dims).filter(v => v !== null);
  const data = present.length ? present.reduce((s, v) => s + v, 0) / present.length : 1;
  return { data: +data.toFixed(4), dims: Object.fromEntries(Object.entries(dims).map(([k, v]) => [k, v === null ? 'n/a' : +(v * 100).toFixed(1) + '%'])) };
}

// LLM 语义增强：规则抽取拿到"字面"，LLM 抽出"含义"（页面类型/价值主张/产品与套餐结构）
async function semanticEnhance(profile, dir) {
  try {
    const { llmEnabled, llmChat } = await import('../llm.mjs');
    if (!llmEnabled()) return null;
    const visibleText = [
      ...Object.entries(profile.meta).map(([k, v]) => `${k}: ${v}`),
      ...profile.headings.map(h => h.text),
      '价格: ' + profile.prices.join(' | '),
      'CTA: ' + profile.cta.join(' | '),
    ].join('\n').slice(0, 6000);
    const out = await llmChat([
      { role: 'system', content: '你是竞品情报分析师。从网页可见文本抽取结构化语义情报，只依据原文，不要编造。' },
      { role: 'user', content: `网页文本：\n${visibleText}\n\n输出 JSON：{"pageType":"营销页|定价页|文档|列表页|登录页|其他","valueProps":["价值主张"],"products":[{"name":"产品名","oneLiner":"一句话"}],"plans":[{"name":"套餐名","price":"价格或未标注","billing":"月付|年付|一次性|未标注","features":["权益"]}],"notableClaims":["值得注意的官方宣称"]}` },
    ], { json: true, timeout: 120_000, fast: true });
    return out;
  } catch (e) { console.error('[harvest] semantic enhance failed:', String(e).slice(0, 120)); return null; }
}

// CLI: node src/harvest/harvest.mjs <pageDir> [htmlFile=dom.html]
if (process.argv[1]?.endsWith('harvest.mjs')) {
  const DIR = requireArg(process.argv[2], 'node src/harvest/harvest.mjs <pageDir>', '页面目录');
  const src = readFileSync(join(DIR, 'dom.html'), 'utf8');
  const profile = extractProfile(src);
  mkdirSync(join(DIR, 'intel'), { recursive: true });
  writeFileSync(join(DIR, 'intel', 'intel.json'), JSON.stringify(profile, null, 2));
  // 语义增强（LLM 可用时）
  const semantic = await semanticEnhance(profile, DIR);
  if (semantic) writeFileSync(join(DIR, 'intel', 'semantic.json'), JSON.stringify(semantic, null, 2));
  console.log(semantic ? `semantic: pageType=${semantic.pageType} plans=${semantic.plans?.length ?? 0} products=${semantic.products?.length ?? 0}` : 'semantic: (llm off/failed)');
  // CSV（Excel 直开）
  const rows = [
    ['type', 'value'],
    ...Object.entries(profile.meta).map(([k, v]) => ['meta:' + k, v]),
    ...profile.headings.map(h => ['heading:' + h.level, h.text]),
    ...profile.prices.map(p => ['price', p]),
    ...profile.cta.map(c => ['cta', c]),
  ];
  writeFileSync(join(DIR, 'intel', 'intel.csv'), rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n'));
  console.log(`intel: headings=${profile.headings.length} prices=${profile.prices.length} cta=${profile.cta.length} tables=${profile.tables.length} links=${profile.links.length}`);
}
