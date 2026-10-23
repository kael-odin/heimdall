/**
 * linker — 站点级接线（L2 路由层收口）
 *
 * 前提：多页已锻造。对每页 clone/index.html：
 *   1) 跨页跳转接线：同源 <a href> 指向已克隆页 → 改写为镜像站内相对路径
 *      （点击在镜像档案内导航）；未克隆的同源页 → 指回原站绝对 URL（新标签）
 *   2) 漏网资产本地化：img/source 上仍是绝对 http(s) 的引用 → 抓取落盘改写
 *   3) 坏链审计：本地相对引用在磁盘上不存在的，记入报告
 *
 * 产出 workspace/<host>/linker-report.json；每次 forge 后由 pipeline 自动执行。
 *
 * 用法: node src/crawler/linker.mjs <host>
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { sanitizeHar, indexHar, matchHar } from '../live/har.mjs';
import { extFrom, isNonAssetRef, isSoftHtml } from '../asset-ext.mjs';
import { scanCssRefs, rewriteCssRefs } from '../css-refs.mjs';
import { recordLearned } from '../site-profile.mjs';
import { requireArg } from '../args.mjs';
import { WORKSPACE } from '../paths.mjs';
import { readJson, writeFileAtomic } from '../fsutil.mjs';
import { replaceRefTable } from '../dom-refs.mjs';
import { UA } from '../ua.mjs';
import { canonUrl } from '../url-canon.mjs';

const host = requireArg(process.argv[2], 'node src/crawler/linker.mjs <host>', '站点 host');
const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const FONT_EXT_SET = new Set(['woff2', 'woff', 'ttf', 'otf', 'eot']);

const pages = existsSync(PAGES) ? readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html'))) : [];
if (!pages.length) { console.error('no cloned pages under', PAGES); process.exit(1); }

// ---------- 全站路由表：完整 URL（含 query）→ 页面目录名 ----------
const pathMap = new Map();
const origins = new Map();       // name → origin
const targets = new Map();
for (const name of pages) {
  const m = readJson(join(PAGES, name, 'manifest.json'));
  if (!m?.target) continue;
  const u = new URL(m.target);
  origins.set(name, u.origin);
  targets.set(name, m.target);
  pathMap.set(canonUrl(m.target), name);
}

// ---------- 资产下载（跨页共享缓存） ----------
const dlCache = new Map();       // absUrl → { rel, srcFile }（跨页共享内容，但每页都要落一份）
let currentHar = null;           // 当前页的 HAR 索引（原站重部署后仍可回放字体/图片）
let currentRefIndex = {};        // clone/ref-index.json：{ cssFile: { rawRef: { rel, candidates } } }
function loadHarIndex(pageDir) {
  try { return indexHar(sanitizeHar(JSON.parse(readFileSync(join(pageDir, 'network.har'), 'utf8'))).entries); } catch { return null; }
}

/**
 * refNNN.* → 它原本对应的原站 URL。
 * 走 ref-index.json 的**反向查**（按文件名匹配），不再依赖 cssom-refs.json 的数组顺序 ——
 * 扫描口径一变，序号就会整体位移，按序号查会取到另一个资产。
 */
function originalForRef(refName, pageOrigin) {
  const want = String(refName).split('/').pop();
  for (const table of Object.values(currentRefIndex ?? {})) {
    for (const [raw, v] of Object.entries(table ?? {})) {
      if ((v?.rel ?? '').split('/').pop() !== want) continue;
      if (v?.candidates?.length) return v.candidates[0];
      try { return new URL(raw, pageOrigin + '/').href; } catch { return null; }
    }
  }
  return null;
}
const extOfCt = (ct, url = '', body = null) => extFrom(url, ct, body);

/**
 * 按**整个属性值**替换 src/href/srcset 里的引用，绝不按子串。
 *
 * 旧实现 `html.split(bad).join(good)`：`/a.png` 的修复会把 `/x/a.png` 也改掉
 * （`/xassets/a.png`），把一条本来有效的引用改成坏链 —— 修一个坏链、造一个坏链。
 * 子串匹配在整个 HTML 上更是无边界：属性值、正文文本、内联脚本字符串都会中招。
 */
function replaceAttrValue(html, bad, good) {
  if (!bad) return html;
  return html.replace(/\b(src|href)="([^"]*)"/gi, (tag, name, value) => (
    value === bad ? `${name}="${good}"` : tag
  ));
}

/**
 * 下载资产的文件名：URL 的 hash，而不是进程内的自增序号。
 *
 * `dlSeq` 每个进程从 0 开始，重跑 linker 时 `linked-000.png` 会被另一个 URL 的同名文件
 * 覆盖 —— 而旧轮的 HTML 里**还在引用** linked-000.png（跨页共享缓存也已失效，缓存键是 absUrl
 * 不是文件名）。换成 hash 后，同一 URL 永远是同一个名字，重跑是幂等的。
 */
function linkedName(absUrl, ext, prefix = 'linked') {
  return `${prefix}-${createHash('sha1').update(String(absUrl)).digest('hex').slice(0, 12)}.${ext}`;
}

async function fetchAsset(absUrl, dir) {
  const hit = dlCache.get(absUrl);
  if (hit) {
    const dest = join(dir, 'assets', basename(hit.rel));
    if (existsSync(dest)) return hit.rel;
    if (hit.srcFile && existsSync(hit.srcFile)) {
      try { mkdirSync(join(dir, 'assets'), { recursive: true }); writeFileAtomic(dest, readFileSync(hit.srcFile)); return hit.rel; } catch {}
    }
    dlCache.delete(absUrl);   // 缓存源已失效 → 重新下载
  }
  const harHit = currentHar && matchHar(currentHar, 'GET', absUrl);
  if (harHit?.body) {
    const body = Buffer.from(harHit.body, 'base64');
    if (body.length && !isSoftHtml(harHit.mimeType, absUrl)) {
      const name = linkedName(absUrl, extFrom(absUrl, harHit.mimeType, body));
      mkdirSync(join(dir, 'assets'), { recursive: true });
      const dest = join(dir, 'assets', name);
      writeFileAtomic(dest, body);
      const rel = `assets/${name}`;
      dlCache.set(absUrl, { rel, srcFile: dest });
      return rel;
    }
  }
  try {
    const res = await fetch(absUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(res.status);
    const ct = res.headers.get('content-type') ?? '';
    // 软 404 / SPA 兜底：要图片却回 HTML —— 落盘会变成"看着有、其实全错"的假资产
    if (isSoftHtml(ct, absUrl)) throw new Error('soft-404 (text/html)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('empty body');
    const name = linkedName(absUrl, extFrom(absUrl, ct, buf));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const dest = join(dir, 'assets', name);
    writeFileAtomic(dest, buf);
    const rel = `assets/${name}`;
    dlCache.set(absUrl, { rel, srcFile: dest });
    return rel;
  } catch { return null; }
}

// ---------- 逐页接线 ----------
const report = [];
for (const name of pages) {
  const dir = join(PAGES, name, 'clone');
  currentHar = loadHarIndex(join(PAGES, name));
  try { currentRefIndex = readJson(join(PAGES, name, 'clone', 'ref-index.json')) ?? {}; } catch { currentRefIndex = {}; }
  const origin = origins.get(name) ?? `https://${host}`;
  const htmlFiles = readdirSync(dir).filter(file => /^index(?:-\d+)?\.html$/.test(file));
  const stats = { name, htmlFiles, linksRewired: 0, linksToLive: 0, assetsLocalized: 0, assetFailed: 0, assetFailures: [], missingFixed: 0, missingLocal: [], harRecovered: 0 };
  for (const htmlName of htmlFiles) await processCloneHtml(htmlName);
  report.push(stats);
  console.log(`  ${name}: rewired ${stats.linksRewired}, live-fallback ${stats.linksToLive}, assets +${stats.assetsLocalized} (fail ${stats.assetFailed}, har ${stats.harRecovered}), missing ${stats.missingLocal.length}`);

  async function processCloneHtml(htmlName) {
  const file = join(dir, htmlName);
  const html0 = readFileSync(file, 'utf8');
  let html = html0;
  /**
   * 记一笔"这个资源没本地化成功"。**连 URL 一起记** —— 只报一个数字的话，
   * `fail 187` 这种读数没法行动（哪个资源？是不是同一类？原站早就 404 了还是我们抓不到？）。
   * 上限 25 条：足够看出模式，又不会把 report 撑爆。
   */
  const failAsset = (u, why = '') => {
    stats.assetFailed++;
    if (stats.assetFailures.length < 25) stats.assetFailures.push({ url: String(u ?? '').slice(0, 220), why });
  };

  // 1a) 自愈：历史轮次可能产生重复 target/rel 属性 → 去重；镜像内链接一律不得开新标签
  html = html.replace(/<a\b([^>]*)>/gi, (m0, attrs) => {
    const dup = (attrs.match(/target="_blank"/gi) ?? []).length > 1;
    const isMirror = /\.\.\/[^"]*clone\/index\.html|href="[^"]*\/clone\/index\.html/.test(attrs) && !/https?:\/\//i.test(attrs);
    if (isMirror && /target="_blank"/i.test(attrs)) return '<a' + attrs.replace(/\s*target="_blank"/gi, '').replace(/\s*rel="noopener"/gi, '') + '>';
    if (dup) return '<a' + attrs.replace(/\s*target="_blank"/gi, '').replace(/\s*rel="noopener"/gi, '') + ' target="_blank" rel="noopener">';
    return m0;
  });

  // 1b) <a href> 跨页接线
  html = html.replace(/<a\b[^>]*>/gi, tag => {
    const hrefAttr = /\bhref="([^"]*)"/i.exec(tag);
    if (!hrefAttr) return tag;
    const href = hrefAttr[1];
    if (!href || /^(#|mailto:|javascript:|tel:|data:)/i.test(href)) return tag;
    const withHref = value => tag.replace(hrefAttr[0], `href="${value}"`);
    // 幂等 + 自愈：历史轮次的绝对化形态必须先于 endsWith 短路检查
    const healed = /^https?:\/\/[^/]+\/([a-z0-9-]+)\/clone\/index\.html$/i.exec(href);
    if (healed && new URL(href).origin === origin && pages.includes(healed[1])) {
      stats.linksRewired++;
      // 重写 href 并清掉历史轮次遗留的 target="_blank"（live-fallback 残留会让镜像导航开新标签）
      return withHref(`../../${healed[1]}/clone/index.html`)
        .replace(/\s*target="_blank"/gi, '')
        .replace(/\s*rel="noopener"/gi, '');
    }
    if ((href.startsWith('../../') && /\/clone\/index\.html(?:[?#]|$)/.test(href)) || /^index\.html(?:[?#]|$)/.test(href)) return tag;
    let abs;
    try {
      abs = new URL(href.replace(/&amp;/g, '&'), targets.get(name) ?? origin + '/');
    } catch { return tag; }
    if (abs.origin !== origin) return tag;
    const hit = pathMap.get(canonUrl(abs.href));
    if (hit) {
      stats.linksRewired++;
      return withHref(hit === name ? `index.html${abs.hash}` : `../../${hit}/clone/index.html${abs.hash}`)
        .replace(/\s*target="_blank"/gi, '')
        .replace(/\s*rel="noopener"/gi, '');
    }
    // 未克隆的同源页 → 指回原站（新标签），点击永远有合理去处
    stats.linksToLive++;
    let liveTag = withHref(abs.href);
    if (/\btarget="[^"]*"/i.test(liveTag)) liveTag = liveTag.replace(/\btarget="[^"]*"/i, 'target="_blank"');
    else liveTag = liveTag.replace(/>$/, ' target="_blank">');
    const relAttr = /\brel="([^"]*)"/i.exec(liveTag);
    if (relAttr) {
      const tokens = relAttr[1].split(/\s+/).filter(Boolean);
      if (!tokens.some(token => token.toLowerCase() === 'noopener')) tokens.push('noopener');
      liveTag = liveTag.replace(relAttr[0], `rel="${tokens.join(' ')}"`);
    } else liveTag = liveTag.replace(/>$/, ' rel="noopener">');
    return liveTag;
  });

  // 2) img/source 绝对资产本地化
  const absUrls = new Set();
  for (const m of html.matchAll(/<(?:img|source)\b[^>]*?\b(src|srcset)="([^"]*)"/gi)) {
    const val = m[2].replace(/&amp;/g, '&');
    if (m[1].toLowerCase() === 'srcset') {
      for (const part of val.split(',')) {
        const u = part.trim().split(/\s+/)[0];
        if (/^https?:\/\//i.test(u)) absUrls.add(u);
      }
    } else if (/^https?:\/\//i.test(val)) absUrls.add(val);
  }
  mkdirSync(join(dir, 'assets'), { recursive: true });
  // 先把这一页所有绝对地址抓下来，再**整表一次**替换。
  // 逐条 `html.split(u).join(rel)` 会被前缀与"重扫产物"两条坑到（见 dom-refs.replaceRefTable）。
  const localAssetMap = {};
  for (const u of absUrls) {
    const rel = await fetchAsset(u, dir);
    if (rel) { localAssetMap[u] = rel; stats.assetsLocalized++; }
    else failAsset(u, "img/source 绝对地址");
  }
  html = replaceRefTable(html, localAssetMap);

  // 2b) 内联 style url() 本地化：图标 background-image 常写在内联样式（capture 只覆盖 src/href/srcset，这是盲区）
  const pageManifest = readJson(join(PAGES, name, 'manifest.json'));
  const pageOrigin = pageManifest?.target ? new URL(pageManifest.target).origin : origin;
  const imgMap = readJson(join(PAGES, name, 'asset-map.json'))?.imgMap ?? {};
  const inlineResolved = new Map();
  for (const t of scanCssRefs(html)) {
    const raw = t.raw;
    // 实体解码 + 去引号：序列化后的 HTML 里，CSS 的那层引号是 `&quot;`、内联 SVG 是 `&lt;`。
    // 不去掉的话 `url(&quot;https://cdn/x.png&quot;)` 会被拼成 `https://站点/"https://cdn/x.png`
    // 这种必然 404 的地址（详见 asset-ext.mjs 里 isNonAssetRef 的注释）。
    const u = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .trim().replace(/^["']+|["']+$/g, '').trim();
    if (isNonAssetRef(u) || inlineResolved.has(raw)) continue;
    let abs;
    try { abs = /^https?:\/\//i.test(u) ? u : new URL(u, pageOrigin + '/').href; } catch { continue; }
    // 优先 capture 期的本地副本；否则下载
    let local = null;
    const capRel = imgMap[abs];
    if (capRel && existsSync(join(PAGES, name, capRel))) {
      const dest = join(dir, 'assets', capRel.split('/').pop());
      writeFileAtomic(dest, readFileSync(join(PAGES, name, capRel)));
      local = 'assets/' + capRel.split('/').pop();
    } else {
      const dl = await fetchAsset(abs, dir);
      if (dl) local = dl;
    }
    if (local) { inlineResolved.set(raw, local); stats.assetsLocalized++; }
    else failAsset(abs, "inline style url()");
  }
  // 单遍重建：只替换顶层 url() 的 URL 片段，data URI 内嵌的 url(...) 原样保留
  if (inlineResolved.size) html = rewriteCssRefs(html, inlineResolved);

  // 2c) CSS 兜底：本地存在则改写为相对路径；否则 HAR 回放 → 网络下载
  const cssFile = join(dir, 'styles', 'cssom.css');
  if (existsSync(cssFile)) {
    let css = readFileSync(cssFile, 'utf8');
    // 用扫描器取引用（正确跳过 data URI 内嵌 url()），全部解析完再单遍重建
    const refs = [...new Set(scanCssRefs(css).map(t => t.raw.trim()))].filter(u => u && !isNonAssetRef(u));
    const resolved = new Map();
    for (const ref of refs) {
      if (existsSync(join(dir, 'styles', ref)) || existsSync(join(dir, 'assets', ref))) continue;
      if (ref.startsWith('/')) {
        const target = join(dir, ref.replace(/^\/+/, ''));
        if (existsSync(target)) {
          resolved.set(ref, relative(join(dir, 'styles'), target).split(sep).join('/'));
          stats.assetsLocalized++;
          continue;
        }
      }
      // build_clone 把 CSSOM 引用重命名为 refNNN.*；丢失时用 ref-index 反查原始 URL + HAR 精确恢复
      const mRef = /(?:^|\/)(?:styles\/)?(ref\d+)\.([a-z0-9]+)$/i.exec(ref);
      if (mRef && currentHar) {
        const orig = originalForRef(ref, pageOrigin);
        if (orig) {
          const hitOrig = matchHar(currentHar, 'GET', orig);
          if (hitOrig?.body) {
            const name = mRef[1] + '.' + mRef[2];
            const sub = FONT_EXT_SET.has(mRef[2].toLowerCase()) ? 'styles' : 'assets';
            mkdirSync(join(dir, sub), { recursive: true });
            writeFileAtomic(join(dir, sub, name), Buffer.from(hitOrig.body, 'base64'));
            resolved.set(ref, sub === 'styles' ? name : '../assets/' + name);
            stats.assetsLocalized++; stats.harRecovered++;
            continue;
          }
        }
      }
      const absForHar = /^https?:\/\//i.test(ref) ? ref : (ref.startsWith('/') ? pageOrigin + ref : pageOrigin + '/' + ref.replace(/^\.\.?\//, ''));
      const harHit = currentHar && matchHar(currentHar, 'GET', absForHar);
      if (harHit?.body) {
        const sub = /font|woff|ttf|otf/i.test(harHit.mimeType ?? '') || /\.(woff2?|ttf|otf|eot)($|\?)/i.test(ref) ? 'styles' : 'assets';
        const name = linkedName(absForHar, extOfCt(harHit.mimeType, ref, Buffer.from(harHit.body, 'base64')), 'har');
        mkdirSync(join(dir, sub), { recursive: true });
        writeFileAtomic(join(dir, sub, name), Buffer.from(harHit.body, 'base64'));
        resolved.set(ref, '../' + sub + '/' + name);
        stats.assetsLocalized++; stats.harRecovered++;
        continue;
      }
      let capRel = null;
      try { capRel = imgMap[new URL(ref, pageOrigin + '/').href]; } catch {}
      if (capRel && existsSync(join(PAGES, name, capRel))) { resolved.set(ref, '../' + capRel); stats.assetsLocalized++; continue; }
      let abs = null;
      if (/^https?:\/\//i.test(ref)) abs = ref;
      else if (ref.startsWith('/')) abs = pageOrigin + ref;
      else {
        // 相对引用（./x、x）在源站多半位于 /src/ 下（Vite 资源）；按常见目录候选逐个 GET（HAR 优先）
        const cn = ref.split('/').pop();
        let done = false;
        for (const cand of [pageOrigin + '/src/' + cn, pageOrigin + '/assets/' + cn, pageOrigin + '/styles/' + cn, pageOrigin + '/' + cn]) {
          const dl = await fetchAsset(cand, dir);
          if (dl) { resolved.set(ref, '../' + dl); stats.assetsLocalized++; done = true; break; }
        }
        if (!done) failAsset(ref, "CSS 相对引用候选不中");
        continue;
      }

      if (!abs) { failAsset(ref, "CSS 引用无法解析"); continue; }
      const dl = await fetchAsset(abs, dir);
      if (dl) { resolved.set(ref, '../' + dl); stats.assetsLocalized++; }
      else failAsset(abs, "CSS url()");
    }
    if (resolved.size) writeFileAtomic(cssFile, rewriteCssRefs(css, resolved));
  }

  // 3) 本地坏链：basename 在捕获资产里存在的 → 直接修正引用（favicon/图标类根相对引用是 capture 重写盲区）
  const fixes = {};
  const seen = new Set();
  for (const m of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
    const attr = m[1], v = m[2].replace(/&amp;/g, '&');
    if (!v || /^(https?:|#|data:|mailto:|javascript:|tel:)/i.test(v)) continue;
    const rel = v.split('?')[0].split('#')[0];
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!/\.(html?|css|png|jpe?g|webp|avif|svg|gif|ico|woff2?|ttf|mp4|webm|json)$/i.test(rel)) continue;
    if (existsSync(join(dir, rel))) continue;
    const base = rel.split('/').pop();
    let fix = null;
    if (existsSync(join(dir, 'assets', base))) fix = `assets/${base}`;
    else {
      const capSrc = join(PAGES, name, 'assets', base);
      if (existsSync(capSrc)) { writeFileAtomic(join(dir, 'assets', base), readFileSync(capSrc)); fix = `assets/${base}`; }
      else {
        // 跨页借用：favicon/站点图标是全站共享资产，任意同站页面有就用它的
        for (const other of pages) {
          const cand = join(PAGES, other, 'clone', 'assets', base);
          if (other !== name && existsSync(cand)) { writeFileAtomic(join(dir, 'assets', base), readFileSync(cand)); fix = `assets/${base}`; break; }
        }
      }
    }
    if (fix) { fixes[v] = fix; stats.missingFixed++; } else stats.missingLocal.push(rel);
  }
  for (const [bad, good] of Object.entries(fixes)) html = replaceAttrValue(html, bad, good);

  // 4) CSS 资产收口：双前缀归一 + 缺失 ref 跨页借用
  const cssPath = join(dir, 'styles', 'cssom.css');
  if (existsSync(cssPath)) {
    let css = readFileSync(cssPath, 'utf8');
    let cssChanged = false;
    if (css.includes('styles/styles/')) { css = css.split('styles/styles/').join(''); cssChanged = true; }
    if (css.includes('..../assets/')) { css = css.split('..../assets/').join('../assets/'); cssChanged = true; }   // build 重写半途的四个点残留
    // 无正则实现：'../assets/' 是固定字面量（正则字面量在本文件的三层转义下不可维护）
    if (css.includes('../assets/')) {
      for (const part of css.split('../assets/').slice(1)) {
        const rel = 'assets/' + part.split(')')[0].split("'")[0].split('"')[0].trim();
        if (!/\.(png|jpe?g|webp|avif|svg|gif|woff2?|ttf|ico)$/i.test(rel)) continue;
        if (existsSync(join(dir, rel))) continue;
        for (const other of pages) {
          const cand = join(PAGES, other, 'clone', rel);
          if (other !== name && existsSync(cand)) { writeFileAtomic(join(dir, rel), readFileSync(cand)); cssChanged = true; break; }
        }
      }
    }
    if (cssChanged) { writeFileAtomic(cssPath, css); stats.cssHealed = true; }
  }

  if (html !== html0) writeFileAtomic(file, html);
  }
}

// ---------- 站点配方：汇总各页实跑观察到的参数 → workspace/<host>/site.json ----------
// 只写"观察事实"，不写策略：策略字段（stubStrategy / excludeTypes / refRewrites）由人决定，
// 自动写策略会导致一次跑歪就把人工修正盖掉。
{
  const observed = pages.map(n => readJson(join(PAGES, n, 'profile-observed.json'))).filter(Boolean);
  if (observed.length) {
    const last = observed[observed.length - 1];
    const sum = (k) => observed.reduce((a, o) => a + (o.resources?.[k] ?? 0), 0);
    recordLearned(host, {
      learned: {
        adapterDetected: [...new Set(observed.map(o => o.adapter))],
        adapterForced: observed.some(o => o.adapterForced),
        pagesObserved: observed.length,
        resources: { total: sum('total'), ok: sum('ok'), fail: sum('fail') },
        cssRefs: observed.reduce((a, o) => a + (o.cssRefs?.total ?? 0), 0),
        removeSelectors: [...new Set(observed.flatMap(o => o.removeSelectors ?? []))],
        waitUntil: last.waitUntil,
        settleMs: last.settleMs,
        scrollSweep: last.scrollSweep,
      },
    });
  }
}

writeFileSync(join(BASE, 'linker-report.json'), JSON.stringify({ host, pages: report }, null, 2));
const tot = report.reduce((a, r) => ({ rw: a.rw + r.linksRewired, lv: a.lv + r.linksToLive, as: a.as + r.assetsLocalized, ms: a.ms + r.missingLocal.length }), { rw: 0, lv: 0, as: 0, ms: 0 });
console.log(`linker DONE ${host}: rewired ${tot.rw} / live-fallback ${tot.lv} / assets +${tot.as} / missing ${tot.ms}`);
