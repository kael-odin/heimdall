/**
 * recon — 全站侦察：sitemap + BFS → atlas.json（星图数据源）
 *
 * 输出 workspace/<host>/recon/:
 *   atlas.json   { origin, nodes:[{id,url,path,title,type,depth}], edges:[{from,to}], meta }
 *   thumbs/<id>.png  每页 320x200 缩略图（星图节点 hover 用）
 *
 * 用法: node src/crawler/recon.mjs <url> [maxPages=40] [maxDepth=2]
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireArg } from '../args.mjs';
import { loadProfile } from '../site-profile.mjs';
import { classifyPath, compileExtraRules } from './classify.mjs';
import { WORKSPACE } from '../paths.mjs';
import { sessionContext } from '../session/store.mjs';

const TARGET = requireArg(process.argv[2], 'node src/crawler/recon.mjs <url> [maxPages] [maxDepth]', '目标 URL');
const MAX_PAGES = Number(process.argv[3] ?? 40);
const MAX_DEPTH = Number(process.argv[4] ?? 2);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function hostOf(u) { return new URL(u).hostname; }
function stripWww(h) { return h.replace(/^www\./, ''); }
function pathOf(u) { try { return new URL(u).pathname.replace(/\/$/, '') || '/'; } catch { return '/'; } }

// 事件输出：@@EVENT@@ 前缀行，engine-server 解析转发 SSE（人类日志走 console.error）
const emit = (obj) => process.stdout.write('@@EVENT@@' + JSON.stringify(obj) + '\n');
const log = (...a) => console.error(...a);

// ---------- 0. origin 校准（跟随 301/重定向，链接过滤必须用落地 origin） ----------
log('[0/4] calibrate origin');
const browser0 = await chromium.launch();
const p0 = await browser0.newPage({ userAgent: UA });
let ORIGIN = new URL(TARGET).origin, LANDING = TARGET;
try {
  await p0.goto(TARGET, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  LANDING = p0.url();
  ORIGIN = new URL(LANDING).origin;
} catch {}
await browser0.close();
const HOST_DIR = stripWww(hostOf(ORIGIN));
log(`  target ${TARGET} -> origin ${ORIGIN} (dir ${HOST_DIR})`);
emit({ kind: 'calibrated', origin: ORIGIN, host: HOST_DIR });

const OUT = join(WORKSPACE, HOST_DIR, 'recon');
const THUMBS = join(OUT, 'thumbs');
mkdirSync(THUMBS, { recursive: true });

// 站点配方：classify.extraRules 可追加/覆盖分类规则（站点特有的路径约定）
const profile = loadProfile(HOST_DIR);
const EXTRA_RULES = compileExtraRules(profile.classify?.extraRules);

/** 页面结构特征（一次 evaluate，供分类兜底；失败不阻塞） */
const readFeatures = (page) => page.evaluate(() => {
  const text = (document.body?.innerText ?? '').slice(0, 6000);
  return {
    passwordField: !!document.querySelector('input[type=password]'),
    priceHits: (text.match(/(?:[$¥€£₩]|￥)\s?\d|\d+\s?(?:元|美元|円)\b|\d+\s?\/\s?(?:mo|mo\.|month|yr|year)\b/gi) ?? []).length,
    tableCount: document.querySelectorAll('table').length,
    form: document.querySelectorAll('form').length,
    codeBlocks: document.querySelectorAll('pre code, pre > code, .highlight, [class*="code-block" i], [class*="hljs" i]').length,
    faq: !!document.querySelector('details, [class*="faq" i], [id*="faq" i], [class*="accordion" i]'),
    jobPosting: /apply now|投递简历|立即申请|申请职位|job description/i.test(text) || !!document.querySelector('[class*="job-" i],[id*="job-" i]'),
    headings: document.querySelectorAll('h1,h2,h3').length,
    article: document.querySelectorAll('article, [class*="article" i], [class*="post-" i]').length > 0,
  };
}).catch(() => null);

// ---------- 1. sitemap 先行 ----------
log('[1/4] sitemap');
const sitemapUrls = [];
try {
  for (const smUrl of [ORIGIN + '/sitemap.xml', ORIGIN + '/sitemap_index.xml']) {
    const res = await fetch(smUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) continue;
    const text = await res.text();
    const locs = [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
    // sitemap index → 递归一层
    if (/sitemapindex/i.test(text)) {
      for (const child of locs.slice(0, 5)) {
        try {
          const r2 = await fetch(child, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
          const t2 = await r2.text();
          for (const m of t2.matchAll(/<loc>([^<]+)<\/loc>/g)) sitemapUrls.push(m[1].trim());
        } catch {}
      }
    } else sitemapUrls.push(...locs);
    if (sitemapUrls.length) break;
  }
} catch {}
const sitemapSame = [...new Set(sitemapUrls.filter(u => u.startsWith(ORIGIN)))].slice(0, 500);
log(`  sitemap urls (same-origin): ${sitemapSame.length}`);
emit({ kind: 'sitemap', count: sitemapSame.length });

// ---------- 2. BFS ----------
log('[2/4] BFS crawl');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, userAgent: UA, ...sessionContext(HOST_DIR) });
const nodes = new Map();   // url -> node
const failures = [];       // 失败页清单（诚实记录，不静默丢弃）
const edges = [];          // {from,to} (url)
// 双队列：BFS 发现优先（保证结构层页面入图），sitemap 仅作补充
const bfsQueue = [{ url: LANDING.replace(/\/$/, ''), depth: 0 }];
const smQueue = [];
const bfsSeen = new Set([LANDING.replace(/\/$/, '')]);   // 仅 BFS 自身去重，sitemap 不得预占
for (const u of sitemapSame) smQueue.push({ url: u, depth: 99 });

let idSeq = 0;
const addNode = (url, depth, title, seoLite, features) => {
  if (nodes.has(url)) return;
  const path = pathOf(url);
  nodes.set(url, {
    id: `n${String(idSeq++).padStart(3, '0')}`, url, path,
    title: title || path,
    type: classifyPath(path, features, EXTRA_RULES),
    depth, seoLite,
  });
};

async function visit({ url, depth }) {
  if (nodes.has(url)) return;   // sitemap 重复页/重复访问兜底
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await page.waitForTimeout(400);
    const title = await page.title().catch(() => '');
    // SEO 轻量画像（无额外请求，纯 DOM 查询）
    const seoLite = await page.evaluate(() => ({
      title: document.title.slice(0, 200),
      description: document.querySelector('meta[name="description"]')?.content?.slice(0, 200) ?? '',
      h1Count: document.querySelectorAll('h1').length,
      imgCount: document.querySelectorAll('img').length,
      imgNoAlt: document.querySelectorAll('img:not([alt])').length,
      ogTitle: document.querySelector('meta[property="og:title"]')?.content?.slice(0, 120) ?? '',
      canonical: !!document.querySelector('link[rel="canonical"]'),
      lang: document.documentElement.lang || '',
    })).catch(() => null);
    const features = await readFeatures(page);
    addNode(url, depth, title, seoLite, features);
    const node = nodes.get(url);
    emit({ kind: 'page', ...node });
    // 缩略图（供星图 hover）
    await page.screenshot({ path: join(THUMBS, `${node.id}.png`), clip: { x: 0, y: 0, width: 640, height: 400 } }).catch(() => {});

    if (depth >= MAX_DEPTH || nodes.size >= MAX_PAGES) return;
    const links = await page.evaluate((o) =>
      [...document.querySelectorAll('a[href]')]
        .map(a => { try { return new URL(a.getAttribute('href'), location.href).href.split('#')[0]; } catch { return null; } })
        .filter(u => u && u.startsWith(o) && !/\.(pdf|zip|png|jpe?g|svg|mp4|xml|json)$/i.test(u)), ORIGIN);
    for (const to of [...new Set(links)]) {
      edges.push({ from: url, to });
      if (!bfsSeen.has(to)) { bfsSeen.add(to); bfsQueue.push({ url: to, depth: depth + 1 }); }
    }
    emit({ kind: 'edges', from: url, tos: [...new Set(links)].slice(0, 40) });
  } catch (e) {
    log('[visit-fail]', url.slice(0, 60), String(e).slice(0, 100));
    failures.push({ url, reason: String(e).slice(0, 200) });
  } finally {
    await page.close();
  }
}

let active = 0;
await new Promise((resolve) => {
  const pump = setInterval(() => {
    // 退出：额度用尽且无在途任务；双队列取空亦退出
    if (active === 0 && (nodes.size >= MAX_PAGES || (bfsQueue.length === 0 && smQueue.length === 0))) {
      clearInterval(pump); resolve(); return;
    }
    while (active < 3 && nodes.size < MAX_PAGES) {
      const job = bfsQueue.length ? bfsQueue.shift() : smQueue.shift();
      if (!job) break;
      active++;
      visit(job).catch(() => {}).finally(() => { active--; });
    }
  }, 200);
});
await browser.close();

// ---------- 3. edges 清洗（只保留两端都在星图内的） ----------
log('[3/4] edges');
const inGraph = (u) => nodes.has(u);
const cleanEdges = [];
const edgeSeen = new Set();
for (const e of edges) {
  if (!inGraph(e.from) || !inGraph(e.to) || e.from === e.to) continue;
  const key = e.from + '|' + e.to;
  if (edgeSeen.has(key)) continue;
  edgeSeen.add(key);
  cleanEdges.push({ from: nodes.get(e.from).id, to: nodes.get(e.to).id });
}

// ---------- 4. atlas.json ----------
log('[4/4] atlas.json');
const atlas = {
  origin: ORIGIN,
  status: nodes.size ? 'ok' : 'failed',
  failures,
  generatedAt: new Date().toISOString(),
  meta: { pages: nodes.size, edges: cleanEdges.length, sitemapUrls: sitemapSame.length, maxPages: MAX_PAGES, maxDepth: MAX_DEPTH },
  nodes: [...nodes.values()],
  edges: cleanEdges,
};
writeFileSync(join(OUT, 'atlas.json'), JSON.stringify(atlas, null, 2));
const byType = {};
for (const n of atlas.nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
log(`\nDONE ${atlas.meta.pages} pages / ${atlas.meta.edges} edges -> ${OUT}`);
log('  by type:', JSON.stringify(byType));
emit({ kind: 'done', pages: atlas.meta.pages, edges: atlas.meta.edges, host: HOST_DIR, byType });


