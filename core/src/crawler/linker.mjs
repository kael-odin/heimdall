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
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename, relative, sep } from 'node:path';
import { sanitizeHar, indexHar, matchHar } from '../live/har.mjs';
import { WORKSPACE } from '../paths.mjs';

const host = process.argv[2] ?? 'apify.com';
const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

const pages = existsSync(PAGES) ? readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'clone', 'index.html'))) : [];
if (!pages.length) { console.error('no cloned pages under', PAGES); process.exit(1); }

// ---------- 全站路由表：URL path → 页面目录名（manifest.target 是精确来源） ----------
const pathMap = new Map();       // path → name
const origins = new Map();       // name → origin
for (const name of pages) {
  const m = readJson(join(PAGES, name, 'manifest.json'));
  if (!m?.target) continue;
  const u = new URL(m.target);
  origins.set(name, u.origin);
  const path = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
  pathMap.set(path, name);
  if (path !== '/') pathMap.set(path + '/', name);
}

// ---------- 资产下载（跨页共享缓存） ----------
const dlCache = new Map();       // absUrl → { rel, srcFile }（跨页共享内容，但每页都要落一份）
let dlSeq = 0;
let currentHar = null;           // 当前页的 HAR 索引（原站重部署后仍可回放字体/图片）
let currentCssRefs = [];         // cssom-refs.json 的原始引用顺序（refNNN 与之一一对应）
function loadHarIndex(pageDir) {
  try { return indexHar(sanitizeHar(JSON.parse(readFileSync(join(pageDir, 'network.har'), 'utf8'))).entries); } catch { return null; }
}
const extOfCt = (ct, url = '') => {
  try { const m = /\.(woff2?|ttf|otf|eot|png|jpe?g|webp|avif|svg|gif|ico|mp4|webm|css|js|json)(\?|$)/i.exec(new URL(url, 'https://x.local').pathname); if (m) return m[1].toLowerCase().replace('jpeg', 'jpg'); } catch {}
  const c = String(ct || '');
  return c.includes('woff2') ? 'woff2' : c.includes('font') ? 'woff' : c.includes('svg') ? 'svg' : c.includes('png') ? 'png'
    : c.includes('jpeg') ? 'jpg' : c.includes('webp') ? 'webp' : c.includes('avif') ? 'avif' : c.includes('gif') ? 'gif'
    : c.includes('css') ? 'css' : c.includes('javascript') ? 'js' : c.includes('json') ? 'json' : 'bin';
};
async function fetchAsset(absUrl, dir) {
  const hit = dlCache.get(absUrl);
  if (hit) {
    const dest = join(dir, 'assets', basename(hit.rel));
    if (existsSync(dest)) return hit.rel;
    if (hit.srcFile && existsSync(hit.srcFile)) {
      try { mkdirSync(join(dir, 'assets'), { recursive: true }); writeFileSync(dest, readFileSync(hit.srcFile)); return hit.rel; } catch {}
    }
    dlCache.delete(absUrl);   // 缓存源已失效 → 重新下载
  }
  const harHit = currentHar && matchHar(currentHar, 'GET', absUrl);
  if (harHit?.body) {
    const name = `linked-${String(dlSeq++).padStart(3, '0')}.${extOfCt(harHit.mimeType, absUrl)}`;
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const dest = join(dir, 'assets', name);
    writeFileSync(dest, Buffer.from(harHit.body, 'base64'));
    const rel = `assets/${name}`;
    dlCache.set(absUrl, { rel, srcFile: dest });
    return rel;
  }
  try {
    const res = await fetch(absUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(res.status);
    const name = `linked-${String(dlSeq++).padStart(3, '0')}.${extOfCt(res.headers.get('content-type') ?? '', absUrl)}`;
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const dest = join(dir, 'assets', name);
    writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    const rel = `assets/${name}`;
    dlCache.set(absUrl, { rel, srcFile: dest });
    return rel;
  } catch { return null; }
}

// ---------- 逐页接线 ----------
const report = [];
for (const name of pages) {
  const dir = join(PAGES, name, 'clone');
  const file = join(dir, 'index.html');
  currentHar = loadHarIndex(join(PAGES, name));
  try { currentCssRefs = JSON.parse(readFileSync(join(PAGES, name, 'cssom-refs.json'), 'utf8')).refs ?? []; } catch { currentCssRefs = []; }
  const html0 = readFileSync(file, 'utf8');
  let html = html0;
  const origin = origins.get(name) ?? `https://${host}`;
  const stats = { name, linksRewired: 0, linksToLive: 0, assetsLocalized: 0, assetFailed: 0, missingFixed: 0, missingLocal: [], harRecovered: 0 };

  // 1a) 自愈：历史轮次可能产生重复 target/rel 属性 → 去重；镜像内链接一律不得开新标签
  html = html.replace(/<a\b([^>]*)>/gi, (m0, attrs) => {
    const dup = (attrs.match(/target="_blank"/gi) ?? []).length > 1;
    const isMirror = /\.\.\/[^"]*clone\/index\.html|href="[^"]*\/clone\/index\.html/.test(attrs) && !/https?:\/\//i.test(attrs);
    if (dup) return '<a' + attrs.replace(/\s*target="_blank"/gi, '').replace(/\s*rel="noopener"/gi, '') + ' target="_blank" rel="noopener">';
    if (isMirror && /target="_blank"/i.test(attrs)) return '<a' + attrs.replace(/\s*target="_blank"/gi, '').replace(/\s*rel="noopener"/gi, '') + '>';
    return m0;
  });

  // 1b) <a href> 跨页接线
  html = html.replace(/(<a\b[^>]*?\bhref=")([^"]*)(")/gi, (m0, head, href, tail) => {
    if (!href || /^(#|mailto:|javascript:|tel:|data:)/i.test(href)) return m0;
    // 幂等 + 自愈：历史轮次的绝对化形态必须先于 endsWith 短路检查
    const healed = /^https?:\/\/[^/]+\/([a-z0-9-]+)\/clone\/index\.html$/i.exec(href);
    if (healed) {
      stats.linksRewired++;
      // 重写 href 并清掉历史轮次遗留的 target="_blank"（live-fallback 残留会让镜像导航开新标签）
      return m0
        .replace(/\s*target="_blank"/gi, '')
        .replace(/\s*rel="noopener"/gi, '')
        .replace(/\bhref="[^"]*"/i, `href="../../${healed[1]}/clone/index.html"`);
    }
    if (href.startsWith('../') || href.endsWith('/clone/index.html')) return m0;
    let abs;
    try {
      abs = /^https?:\/\//i.test(href) ? new URL(href) : new URL(href.replace(/&amp;/g, '&'), origin + '/');
    } catch { return m0; }
    if (!abs.href.startsWith(origin)) return m0;                     // 真外链保持原样
    const path = decodeURIComponent(abs.pathname).replace(/\/+$/, '') || '/';
    const hit = pathMap.get(path);
    if (hit === name) { stats.linksRewired++; return head + 'index.html' + tail; }
    if (hit) { stats.linksRewired++; return head + `../../${hit}/clone/index.html` + tail; }
    // 未克隆的同源页 → 指回原站（新标签），点击永远有合理去处
    stats.linksToLive++;
    return head + abs.href + `" target="_blank" rel="noopener` + tail;
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
  for (const u of absUrls) {
    const rel = await fetchAsset(u, dir);
    if (rel) { html = html.split(u).join(rel); stats.assetsLocalized++; }
    else stats.assetFailed++;
  }

  // 2b) 内联 style url() 本地化：图标 background-image 常写在内联样式（capture 只覆盖 src/href/srcset，这是盲区）
  const pageManifest = readJson(join(PAGES, name, 'manifest.json'));
  const pageOrigin = pageManifest?.target ? new URL(pageManifest.target).origin : origin;
  const imgMap = readJson(join(PAGES, name, 'asset-map.json'))?.imgMap ?? {};
  const inlineUrls = new Set();
  for (const m of html.matchAll(/url\(\s*(?:&quot;|'|")?\s*([^)'")&][^)']*)/g)) {
    let u = m[1].trim().replace(/&amp;/g, '&').replace(/&quot;$/, '').trim();
    if (!u || u.startsWith('data:') || u.startsWith('#')) continue;
    inlineUrls.add(u);
  }
  for (const u of inlineUrls) {
    let abs;
    try { abs = /^https?:\/\//i.test(u) ? u : new URL(u, pageOrigin + '/').href; } catch { continue; }
    // 优先 capture 期的本地副本；否则下载
    let local = null;
    const capRel = imgMap[abs];
    if (capRel && existsSync(join(PAGES, name, capRel))) {
      const dest = join(dir, 'assets', capRel.split('/').pop());
      writeFileSync(dest, readFileSync(join(PAGES, name, capRel)));
      local = 'assets/' + capRel.split('/').pop();
    } else {
      const dl = await fetchAsset(abs, dir);
      if (dl) local = dl;
    }
    if (local) { html = html.split(u).join(local); stats.assetsLocalized++; }
    else stats.assetFailed++;
  }

  // 2c) CSS 兜底：本地存在则改写为相对路径；否则 HAR 回放 → 网络下载
  const cssFile = join(dir, 'styles', 'cssom.css');
  if (existsSync(cssFile)) {
    let css = readFileSync(cssFile, 'utf8');
    const refs = [...new Set([...css.matchAll(/url\(\s*(?:'|")?([^'")]+)(?:'|")?\s*\)/g)].map(m => m[1].trim()))]
      .filter(u => u && !/^(data:|#)/i.test(u));
    let changed = false;
    for (const ref of refs) {
      if (existsSync(join(dir, 'styles', ref)) || existsSync(join(dir, 'assets', ref))) continue;
      if (ref.startsWith('/')) {
        const target = join(dir, ref.replace(/^\/+/, ''));
        if (existsSync(target)) {
          css = css.split(ref).join(relative(join(dir, 'styles'), target).split(sep).join('/'));
          changed = true; stats.assetsLocalized++;
          continue;
        }
      }
      // build_clone 把 CSSOM 引用按顺序重命名为 refNNN.*；丢失时用原始引用 + HAR 精确恢复
      const mRef = /(?:^|\/)(?:styles\/)?(ref(\d+))\.([a-z0-9]+)$/i.exec(ref);
      if (mRef && currentHar) {
        const orig = currentCssRefs[Number(mRef[2])];
        if (orig) {
          let absOrig = null;
          try { absOrig = new URL(orig, pageOrigin + '/').href; } catch {}
          const hitOrig = absOrig && matchHar(currentHar, 'GET', absOrig);
          if (hitOrig?.body) {
            const name = mRef[1] + '.' + mRef[3];
            mkdirSync(join(dir, 'styles'), { recursive: true });
            writeFileSync(join(dir, 'styles', name), Buffer.from(hitOrig.body, 'base64'));
            css = css.split(ref).join(name);
            changed = true; stats.assetsLocalized++; stats.harRecovered++;
            continue;
          }
        }
      }
      const absForHar = /^https?:\/\//i.test(ref) ? ref : (ref.startsWith('/') ? pageOrigin + ref : pageOrigin + '/' + ref.replace(/^\.\.?\//, ''));
      const harHit = currentHar && matchHar(currentHar, 'GET', absForHar);
      if (harHit?.body) {
        const sub = /font|woff|ttf|otf/i.test(harHit.mimeType ?? '') || /\.(woff2?|ttf|otf|eot)($|\?)/i.test(ref) ? 'styles' : 'assets';
        const name = 'har-' + String(dlSeq++).padStart(3, '0') + '.' + extOfCt(harHit.mimeType, ref);
        mkdirSync(join(dir, sub), { recursive: true });
        writeFileSync(join(dir, sub, name), Buffer.from(harHit.body, 'base64'));
        css = css.split(ref).join('../' + sub + '/' + name);
        changed = true; stats.assetsLocalized++; stats.harRecovered++;
        continue;
      }
      let capRel = null;
      try { capRel = imgMap[new URL(ref, pageOrigin + '/').href]; } catch {}
      if (capRel && existsSync(join(PAGES, name, capRel))) { css = css.split(ref).join('../' + capRel); changed = true; stats.assetsLocalized++; continue; }
      let abs = null;
      if (/^https?:\/\//i.test(ref)) abs = ref;
      else if (ref.startsWith('/')) abs = pageOrigin + ref;
      else {
        // 相对引用（./x、x）在源站多半位于 /src/ 下（Vite 资源）；按常见目录候选逐个 GET（HAR 优先）
        const cn = ref.split('/').pop();
        let done = false;
        for (const cand of [pageOrigin + '/src/' + cn, pageOrigin + '/assets/' + cn, pageOrigin + '/styles/' + cn, pageOrigin + '/' + cn]) {
          const dl = await fetchAsset(cand, dir);
          if (dl) { css = css.split(ref).join('../' + dl); changed = true; stats.assetsLocalized++; done = true; break; }
        }
        if (!done) stats.assetFailed++;
        continue;
      }

      if (!abs) { stats.assetFailed++; continue; }
      const dl = await fetchAsset(abs, dir);
      if (dl) { css = css.split(ref).join('../' + dl); changed = true; stats.assetsLocalized++; }
      else stats.assetFailed++;
    }
    if (changed) writeFileSync(cssFile, css);
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
      if (existsSync(capSrc)) { writeFileSync(join(dir, 'assets', base), readFileSync(capSrc)); fix = `assets/${base}`; }
      else {
        // 跨页借用：favicon/站点图标是全站共享资产，任意同站页面有就用它的
        for (const other of pages) {
          const cand = join(PAGES, other, 'clone', 'assets', base);
          if (other !== name && existsSync(cand)) { writeFileSync(join(dir, 'assets', base), readFileSync(cand)); fix = `assets/${base}`; break; }
        }
      }
    }
    if (fix) { fixes[v] = fix; stats.missingFixed++; } else stats.missingLocal.push(rel);
  }
  for (const [bad, good] of Object.entries(fixes)) html = html.split(bad).join(good);

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
          if (other !== name && existsSync(cand)) { writeFileSync(join(dir, rel), readFileSync(cand)); cssChanged = true; break; }
        }
      }
    }
    if (cssChanged) { writeFileSync(cssPath, css); stats.cssHealed = true; }
  }

  if (html !== html0) writeFileSync(file, html);
  report.push(stats);
  console.log(`  ${name}: rewired ${stats.linksRewired}, live-fallback ${stats.linksToLive}, assets +${stats.assetsLocalized} (fail ${stats.assetFailed}, har ${stats.harRecovered}), missing ${stats.missingLocal.length}`);
}

writeFileSync(join(BASE, 'linker-report.json'), JSON.stringify({ host, pages: report }, null, 2));
const tot = report.reduce((a, r) => ({ rw: a.rw + r.linksRewired, lv: a.lv + r.linksToLive, as: a.as + r.assetsLocalized, ms: a.ms + r.missingLocal.length }), { rw: 0, lv: 0, as: 0, ms: 0 });
console.log(`linker DONE ${host}: rewired ${tot.rw} / live-fallback ${tot.lv} / assets +${tot.as} / missing ${tot.ms}`);
