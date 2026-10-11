/**
 * deliver/edit-manifest — 「改站起点」清单
 *
 * 要解决的问题：用户拿这个项目是想**做一个竞品站** —— 把原站的视觉与结构当基线，
 * 换上自己的文案、图片、logo，再接自己的后端。产物其实早就算出来了
 * （asset-map 知道每个资源从哪个 URL 来、落在哪；intel 知道每页的标题与 CTA），
 * 但它们散在几十个 JSON 里，用户要换一张图得自己在 `clone/assets/**` 里翻。
 *
 * 这个模块把同一批数据**按"要改什么"重新组织**成三张表：
 *   · domain —— 原站域名出现在哪些文件的哪些位置（canonical / og:url / 绝对链接），
 *               这是"换成我的域名"要动的地方
 *   · assets —— 每个资源：原始 URL ↔ 本地路径 ↔ 出现在哪几页 ↔ 多大 ↔ 是否已本地化；
 *               并且把"还挂在外面的视觉资产"单独挑出来（那是必须处理的）
 *   · copy   —— 每页的标题 / 描述 / H1 / CTA / 价格（要换文字就先看这里）
 *
 * 设计上**不新增抓取**：只读已有产物。所以它很快，也永远不会与原站不一致。
 *
 * 用法: node src/deliver/edit-manifest.mjs <host> [--out <file>]
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { WORKSPACE } from '../paths.mjs';
import { readJson } from '../fsutil.mjs';
import { emit } from '../emit.mjs';

/** 会带域名的文本类文件（二进制资源里的域名对"换域名"没有意义，跳过） */
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.xml', '.txt', '.webmanifest', '.map']);
/** 单个文件扫描上限：超过就不扫（打包产物可能有几十 MB 的 sourcemap） */
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
/** 资源分类：决定"换这个要不要动设计" */
const KIND_BY_EXT = {
  '.png': '图片', '.jpg': '图片', '.jpeg': '图片', '.gif': '图片', '.webp': '图片', '.avif': '图片', '.svg': '图片', '.ico': '图标', '.bmp': '图片',
  '.woff': '字体', '.woff2': '字体', '.ttf': '字体', '.otf': '字体', '.eot': '字体',
  '.css': '样式', '.js': '脚本', '.mjs': '脚本',
  '.mp4': '视频', '.webm': '视频', '.ogv': '视频', '.mp3': '音频', '.wav': '音频', '.ogg': '音频',
};

const countOccurrences = (text, needle) => {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = text.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
};

/**
 * 构建清单。纯读，不写盘（写盘在 CLI 的 main 里）。
 * @param {string} host
 * @returns {object} manifest
 */
export function buildEditManifest(host) {
  const base = join(WORKSPACE, host);
  const pagesDir = join(base, 'pages');
  const pageNames = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter(n => existsSync(join(pagesDir, n, 'clone', 'index.html'))).sort()
    : [];

  // origin 从任一页 manifest.target 推（与 /api/sites 同一套判据）
  let origin = '';
  for (const n of pageNames) {
    const t = readJson(join(pagesDir, n, 'manifest.json'))?.target;
    if (t) { try { origin = new URL(t).origin; break; } catch { /* 继续找 */ } }
  }
  const hostname = origin ? new URL(origin).hostname : host;

  // ---------- 1. 资源表 ----------
  const byUrl = new Map();   // 原始 URL -> { url, local, ext, kind, size, pages:Set }
  const addAsset = (url, local, page, size) => {
    if (!url) return;
    const cur = byUrl.get(url) ?? { url, local: local || '', ext: extname(new URL(url, origin).pathname).toLowerCase(), pages: new Set(), size: 0 };
    if (local && !cur.local) cur.local = local;
    cur.pages.add(page);
    if (size) cur.size = size;
    byUrl.set(url, cur);
  };
  for (const page of pageNames) {
    const m = readJson(join(pagesDir, page, 'asset-map.json'));
    if (!m) continue;
    // imgMap/resMap/cssMap 的值是 clone 内的相对路径；键是原始 URL
    for (const key of ['imgMap', 'resMap', 'cssMap']) {
      for (const [url, local] of Object.entries(m[key] ?? {})) addAsset(url, String(local), page);
    }
    for (const r of m.resources ?? []) if (r?.url) addAsset(r.url, '', page);
  }
  const assets = [...byUrl.values()].map(a => {
    const ext = a.ext;
    let size = 0;
    if (a.local) {
      const f = join(pagesDir, [...a.pages][0], 'clone', a.local);
      try { if (existsSync(f)) size = statSync(f).size; } catch { /* 文件可能被去重成硬链接外的形态 */ }
    }
    return { url: a.url, local: a.local, ext, kind: KIND_BY_EXT[ext] ?? '其它', size, pages: [...a.pages].sort(), pageCount: a.pages.size };
  }).sort((x, y) => y.pageCount - x.pageCount || y.size - x.size);

  // ---------- 2. 仍是外链的视觉资产（必须处理的那一批） ----------
  const gapReport = readJson(join(base, 'audit', 'asset-gaps.json'));
  const remote = [];
  for (const p of gapReport?.pages ?? []) {
    for (const g of p.gaps ?? []) {
      if (g.category !== 'visual') continue;   // 元数据/追踪类不影响外观
      remote.push({ url: g.url, page: p.page, kind: g.kind, status: g.status, where: g.where ?? '' });
    }
  }

  // ---------- 3. 文案表 ----------
  const copy = [];
  for (const page of pageNames) {
    const intel = readJson(join(pagesDir, page, 'intel', 'intel.json'));
    if (!intel) continue;
    const h1 = (intel.headings ?? []).filter(h => h.level === 'h1').map(h => h.text).filter(Boolean);
    const item = {
      page,
      title: intel.meta?.title ?? '',
      description: intel.meta?.description ?? '',
      h1,
      headings: (intel.headings ?? []).length,
      cta: (intel.cta ?? []).filter(Boolean).slice(0, 12),
      prices: (intel.prices ?? []).filter(Boolean).slice(0, 12),
    };
    if (item.title || item.h1.length || item.cta.length || item.prices.length) copy.push(item);
  }

  // ---------- 4. 域名分布（换域名要动的地方） ----------
  const domainFiles = [];
  let domainTotal = 0;
  const scanDir = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      let st; try { st = statSync(f); } catch { continue; }
      if (st.isDirectory()) { scanDir(f); continue; }
      if (!st.isFile() || st.size > MAX_SCAN_BYTES || !TEXT_EXT.has(extname(name).toLowerCase())) continue;
      let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
      const n = countOccurrences(text, hostname);
      if (n > 0) {
        domainFiles.push({ path: relative(join(pagesDir, '..'), f).split('\\').join('/'), count: n });
        domainTotal += n;
      }
    }
  };
  for (const page of pageNames) scanDir(join(pagesDir, page, 'clone'));
  domainFiles.sort((a, b) => b.count - a.count);

  return {
    host,
    origin: origin || ('https://' + host),
    hostname,
    generatedAt: new Date().toISOString(),
    counts: {
      pages: pageNames.length,
      assets: assets.length,
      remoteVisual: remote.length,
      copyPages: copy.length,
      domainFiles: domainFiles.length,
      domainTotal,
    },
    domain: { hostname, total: domainTotal, files: domainFiles },
    assets,
    remote,
    copy,
  };
}

const esc = (s) => String(s ?? '').replace(/[|\n\r]/g, ' ').trim();
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : n >= 1024 ? Math.round(n / 1024) + 'KB' : n + 'B');

/** 人类可读版（进交付包，用户直接照着改） */
export function renderEditManifestMd(m) {
  const L = [];
  L.push(`# 改站起点 · ${m.hostname}`);
  L.push('');
  L.push(`> 从这份清单开始改成你自己的站。所有数据来自已抓取的产物，不包含任何新的抓取。`);
  L.push(`> 生成时间：${m.generatedAt}`);
  L.push('');
  L.push(`共 ${m.counts.pages} 页 · ${m.counts.assets} 个资源 · ${m.counts.remoteVisual} 个仍是外链的视觉资产 · ${m.counts.copyPages} 页有文案 · 域名出现在 ${m.counts.domainFiles} 个文件里（${m.counts.domainTotal} 处）`);
  L.push('');

  L.push(`## 1. 换成你的域名`);
  L.push('');
  if (!m.domain.total) L.push('（没找到原站域名出现的位置 —— 站点本身就没写死域名。）');
  else {
    L.push(`原站域名 \`${m.domain.hostname}\` 出现在 ${m.domain.files.length} 个文件里。`);
    L.push(`多数是 canonical / og:url / 绝对资源链接。**换域名前先跑一遍预览**，确认每处都该换。`);
    L.push('');
    L.push('| 文件 | 出现次数 |');
    L.push('| --- | --- |');
    for (const f of m.domain.files.slice(0, 40)) L.push(`| \`${esc(f.path)}\` | ${f.count} |`);
    if (m.domain.files.length > 40) L.push(`| …另有 ${m.domain.files.length - 40} 个文件 | |`);
  }
  L.push('');

  L.push(`## 2. 换成你的图片 / 图标 / 字体`);
  L.push('');
  L.push(`按"被多少页用到"排序 —— 排在前面的就是最该先换的品牌资产。`);
  L.push('');
  L.push('| 原始地址 | 本地路径 | 类型 | 大小 | 用在几页 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const a of m.assets.slice(0, 60)) {
    L.push(`| \`${esc(a.url)}\` | \`${esc(a.local || '（未本地化）')}\` | ${a.kind} | ${a.size ? kb(a.size) : '—'} | ${a.pageCount} |`);
  }
  if (m.assets.length > 60) L.push(`| …另有 ${m.assets.length - 60} 个 | | | | |`);
  L.push('');

  if (m.remote.length) {
    L.push(`## 3. 仍是外链的视觉资产（**必须处理**）`);
    L.push('');
    L.push('这些是页面上看得见、但还没落到本地的资源。离线打开会 404，上线后视图会随原站变化。');
    L.push('');
    L.push('| 页面 | 资源 | 类型 | 状态 |');
    L.push('| --- | --- | --- | --- |');
    for (const r of m.remote.slice(0, 60)) L.push(`| ${esc(r.page)} | \`${esc(r.url)}\` | ${esc(r.kind)} | ${esc(r.status)} |`);
    if (m.remote.length > 60) L.push(`| …另有 ${m.remote.length - 60} 条 | | | |`);
    L.push('');
  }

  L.push(`## ${m.remote.length ? 4 : 3}. 换成你的文案`);
  L.push('');
  L.push('| 页面 | 标题 | H1 | CTA | 价格 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const c of m.copy.slice(0, 60)) {
    L.push(`| ${esc(c.page)} | ${esc(c.title)} | ${esc(c.h1.join(' / '))} | ${esc(c.cta.slice(0, 3).join(' / '))} | ${esc(c.prices.slice(0, 3).join(' / '))} |`);
  }
  if (m.copy.length > 60) L.push(`| …另有 ${m.copy.length - 60} 页 | | | | |`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('**边界**：这份清单帮你换内容，不改变"这是他人站点的视觉与结构"这个事实。');
  L.push('拿去商用之前请自行确认授权 —— 见仓库根目录的 RISKS.md。');
  L.push('');
  return L.join('\n');
}

// ---------- CLI ----------
const isMain = !!process.argv[1] && process.argv[1].endsWith('edit-manifest.mjs');
if (isMain) {
  const host = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!host) { console.error('用法: node src/deliver/edit-manifest.mjs <host> [--out <dir>]'); process.exit(2); }
  const outIdx = process.argv.indexOf('--out');
  const outDir = outIdx > -1 ? process.argv[outIdx + 1] : join(WORKSPACE, host, 'deliver');
  const m = buildEditManifest(host);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'edit-manifest.json'), JSON.stringify(m, null, 2));
  writeFileSync(join(outDir, 'edit-manifest.md'), renderEditManifestMd(m));
  console.log(`[edit-manifest] ${m.hostname}: ${m.counts.pages} 页 · ${m.counts.assets} 资源 · ${m.counts.remoteVisual} 外链视觉 · 域名 ${m.counts.domainTotal} 处`);
  console.log('[edit-manifest] ->', join(outDir, 'edit-manifest.md'));
  emit({ kind: 'edit-manifest', host, ...m.counts });
}
