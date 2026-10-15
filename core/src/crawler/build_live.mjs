/**
 * build_live — 快照 → 交互镜像页转换器
 *
 * dom.html（渲染后完整 DOM，含 script 引用）→ live/<path>/index.html 或独立 query 快照
 *   1) <base href="/lm/<host><dir>/">  —— 全部相对资源/请求自动归位到代理
 *   2) 全文绝对 URL 归一：https://<host> → /lm/<host>（属性/RSC payload/内联脚本一把梭）
 *   3) bootstrap patch 注入：JS 运行时硬编码的绝对域 → 代理路径（fetch/XHR 兜底）
 *   4) CSS 用本地校准版（cssom.css，静态镜像同款）替换原版引用 —— 视觉保真双保险
 *
 * 站点差异（stub 策略、挂件黑名单）来自 **站点配方** core/sites/<host>.json，
 * 不再写成 `if (host === 'apify')` 这类分支。
 *
 * 部署位置与 engine /lm/ 融合路由约定一致：/lm/<host>/<path> → live/<path>/index.html
 *
 * 用法: node src/crawler/build_live.mjs <host>          （全部已锻页）
 *       node src/crawler/build_live.mjs <host> <page>   （单页）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { requireArg } from '../args.mjs';
import { loadProfile } from '../site-profile.mjs';
import { WORKSPACE, isInside } from '../paths.mjs';
import { rewriteMappedHtmlRefs } from '../dom-refs.mjs';
import { prefixRootRelative } from '../live/live-html.mjs';
import { liveSnapshotPath } from '../live/live-path.mjs';
import { stripFreeze } from '../freeze.mjs';
import { isSafePageName } from '../page-name.mjs';
import { assertSiteOrigin } from '../site-origin.mjs';
import { rewriteSourceOrigin } from '../live/site-routing.mjs';

const host = requireArg(process.argv[2], 'node src/crawler/build_live.mjs <host> [page]', '站点 host');
const only = process.argv[3];
if (only && !isSafePageName(only)) { console.error('页名无效：必须是单个安全目录名'); process.exit(2); }
const BASE = join(WORKSPACE, host);
const PAGES = join(BASE, 'pages');
const SELF_URL = process.env.HEIMDALL_SELF_URL ?? `http://127.0.0.1:${process.env.HEIMDALL_PORT ?? 8900}`;

const profile = loadProfile(host);
const LIVE = profile.live ?? {};
// 站点级目录（相对 URL 在镜像里必须归位到代理前缀）——通用兜底之后仍可能漏网的一层
const ROOT_DIRS = ['src/', '_next/', '_nuxt/', 'assets/', 'media/', 'img/', 'api/', 'files/', 'dist/'];

/** 挂件脚本剥除规则：站点配方可追加片段；默认值在 site-profile.mjs 的 DEFAULTS.live */
const stripRe = new RegExp('<script[^>]*(?:' + (LIVE.stripScriptPatterns ?? []).join('|') + ')[^>]*></script>', 'gi');
const inlineStripRe = new RegExp('<script[^>]*>[^<]*(?:' + (LIVE.inlineStripPatterns ?? []).join('|') + ')[^<]*</script>', 'gi');

const pages = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'manifest.json')));
const liveDir = join(BASE, 'live');
mkdirSync(liveDir, { recursive: true });

/** 引擎可达性：chunk 预检必须走真实反代，否则会把"引擎没开"误判成"脚本全 404"而剥光脚本 */
async function engineReachable() {
  try {
    const r = await fetch(`${SELF_URL}/api/status`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}
const engineUp = await engineReachable();
if (!engineUp) console.warn(`  [warn] 引擎不可达（${SELF_URL}）→ 跳过 chunk 预检，不剥任何脚本`);

let built = 0;
for (const name of pages) {
  if (only && name !== only) continue;
  const dir = join(PAGES, name);
  const domPath = join(dir, 'dom.html');
  if (!existsSync(domPath)) continue;
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!manifest?.target) continue;
  const target = new URL(manifest.target);
  // The route key is the workspace site id, while target.origin remains the
  // upstream identity. This keeps same-host, different-port fixtures isolated.
  assertSiteOrigin(BASE, target, { pageName: name });
  const siteId = host;
  const lmPrefix = `/lm/${siteId}`;
  // A page without a trailing slash is a document, so relative refs resolve
  // from its parent directory. A trailing slash already denotes a directory.
  const baseHref = `${lmPrefix}${new URL('.', target).pathname}`;

  let html = readFileSync(domPath, 'utf8');

  // Captured resources have stable names in the static clone. Use those exact
  // files in the live page too, including relative refs on deep routes.
  const assetMapPath = join(dir, 'asset-map.json');
  if (existsSync(assetMapPath)) {
    const assetMap = JSON.parse(readFileSync(assetMapPath, 'utf8'));
    const cloneDir = join(dir, 'clone');
    const local = {};
    for (const [source, rel] of Object.entries({ ...(assetMap.resMap ?? {}), ...(assetMap.imgMap ?? {}) })) {
      if (typeof rel !== 'string' || !rel || rel.includes('\\')) continue;
      const file = resolve(cloneDir, rel);
      try {
        if (!isInside(cloneDir, file) || !statSync(file).isFile()
          || !isInside(realpathSync(cloneDir), realpathSync(file))) continue;
      } catch { continue; }
      local[source] = `/static/${encodeURIComponent(siteId)}/pages/${encodeURIComponent(name)}/clone/`
        + rel.split('/').map(encodeURIComponent).join('/');
    }
    html = rewriteMappedHtmlRefs(html, local, target.href);
  }

  // 1) 绝对 URL 归一到代理（www 与裸域都归一）
  html = rewriteSourceOrigin(html, target.origin, lmPrefix);

  // 1.4) 剥掉截图冻结样式 —— **这里是"能看动效"的产物，冻住就自相矛盾了**。
  //      新产物在 capture 阶段已经不写它了（见 freeze.mjs）；这一步是给**已产出的**旧产物兜底，
  //      让 `live <host> --rebuild` 就能把历史上被冻住的那批镜像修好，不必重爬整站。
  html = stripFreeze(html);

  // 1.5) 剥挂件脚本 —— **必须在 bootstrap 注入之前**：bootstrap 自身含 mixpanel/CookieConsent 等
  //      关键词，后剥会把 bootstrap 一起删掉。挂件在镜像环境不可达或必炸，由 bootstrap stub 兜住全局调用。
  html = html.replace(stripRe, '<!-- heimdall: widget script stripped -->');
  html = html.replace(inlineStripRe, '<!-- heimdall: widget inline stripped -->');

  // 2) <base> 注入（相对资源/请求归位）+ bootstrap（JS 运行时硬编码绝对域兜底）
  const bootstrap = `<script>(function(){
    var H='${lmPrefix}', O='${target.origin}';
    function px(u){ try{
      if(typeof u!=='string') return u;
      if((H && u.indexOf(H)===0)||u.indexOf('/lm/')===0) return u;
      if(u.indexOf(O)===0 && new URL(u).origin===O) return H+u.slice(O.length);
      if(u.charAt(0)==='/' && u.charAt(1)!=='/' && u.indexOf('/static/')!==0) return H+u;   // 根相对：base 管不了根路径（/ 开头直接打源根）；//cdn… 是协议相对，原样保留
    }catch(e){} return u; }
    var of=window.fetch;
    window.fetch=function(input,init){ try{
      if(typeof input==='string') input=px(input);
      else if(input&&input.url) input=new Request(px(input.url),input);
    }catch(e){} return of.call(window,input,init); };
    var oo=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(){ try{ arguments[1]=px(String(arguments[1])); }catch(e){} return oo.apply(this,arguments); };
    // 第三方挂件魔法 stub：无限递归 Proxy——任何属性/调用/构造都返回自身
    var MAGIC = new Proxy(function(){}, {
      get: function(t, k){ if (k === Symbol.toPrimitive) return function(){ return ''; }; if (k === 'then' || k === 'nodeType') return undefined; return MAGIC; },
      set: function(){ return true; },
      apply: function(){ return MAGIC; },
      construct: function(){ return MAGIC; },
      has: function(){ return true; },
      ownKeys: function(){ return []; },
      getOwnPropertyDescriptor: function(){ return undefined; }
    });
    // magic 与部分 chunk 会互相纠缠而挂死（站点配方 live.stubStrategy=conservative 时改用保守 stub：
    // 挂件经代理真跑，而不是被 stub 成空对象）
    var CONSERVATIVE = ${LIVE.stubStrategy === 'conservative'};
    window.mixpanel = window.mixpanel || (CONSERVATIVE ? { init:function(){}, track:function(){}, push:function(){}, people:{ set:function(){} }, register:function(){}, time_event:function(){} } : MAGIC);
    window.qp = CONSERVATIVE ? function(){} : (window.qp || MAGIC);
    window.CookieConsent = window.CookieConsent || (CONSERVATIVE ? { run:function(){}, accept:function(){}, reject:function(){}, valid:function(){ return true; }, CookieV2TrackingTechnologies:[], updatePageElementsList:function(){}, _env:{}, consent:{ hasResponse:true, granted:true }, dialog:{}, response:{ categories:[] } } : MAGIC);
    window.Cookiebot = window.Cookiebot || { consent:{ hasResponse:true, granted:true, declinedCategories:'', declinedAll:false }, dialog:{}, regDomain:'', host:'', scriptSrc:'', id:'', push:function(){} };
    window.$crisp = window.$crisp || [];
    window.CRISP_WEBSITE_ID = window.CRISP_WEBSITE_ID || '';
    window.ttq = CONSERVATIVE ? (window.ttq || { _ttq_create:function(){}, _env:{}, track:function(){}, page:function(){}, load:function(){}, identify:function(){}, methods:[], push:function(a){ if (typeof a === 'function') try { a(); } catch(e){} else this.methods.push(a); } }) : (window.ttq || MAGIC);
    window.clarity = window.clarity || MAGIC;
    window.gtag = window.gtag || function(){ (window.dataLayer = window.dataLayer || []).push(arguments); };
    window.dataLayer = window.dataLayer || [];
    window.fbq = window.fbq || function(){};
    window.OneTrust = window.OneTrust || { };
  })();</script>`;
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">${bootstrap}`);

  // 2b/c/e) 根相对引用 → 代理前缀。规则与其中的坑都在 live-html.mjs（有单测：
  //   协议相对 URL `//cdn…` 不能当成根相对，否则会被改成一个永远 404 的本机路径）
  html = prefixRootRelative(html, lmPrefix, ROOT_DIRS);

  // 3) 原版 CSS 引用替换为本地校准版（cssom.css，静态镜像同款——视觉保真双保险）
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, '');
  html = html.replace('</head>', '<link rel="stylesheet" href="/static/' + siteId + '/pages/' + name + '/clone/styles/cssom.css"></head>');

  // 4) chunk 预检剔除：快照里的 script 若原站已 404（部署时效），剥除避免 4xx 噪声。
  //    引擎不可达时**整段跳过** —— 否则会把"探不通"误判成"全死"，把脚本剥光。
  if (engineUp) {
    try {
      const scriptUrls = [...new Set([...html.matchAll(/<script[^>]*src="(\/lm\/[^"]+)"/gi)].map(m => m[1]))];
      const check = async (u) => {
        try {
          // /px/ 是纯反代：走 /lm/ 融合路由会命中旧 live 文件而永远 200
          const r = await fetch(SELF_URL + u.replace('/lm/', '/px/'), { signal: AbortSignal.timeout(10_000) });
          return r.ok;
        } catch { return true; }   // 探不通 ≠ 已死：保持脚本，宁可留噪声也不要剥掉能跑的 chunk
      };
      const results = await Promise.all(scriptUrls.map(u => check(u).then(ok => [u, ok])));
      let removed = 0;
      for (const [u, ok] of results) {
        if (ok) continue;
        const fname = u.split('/').pop().split('?')[0];   // ?dpl= 在标签里是字面量，用无查询文件名定位
        const before = html;
        html = html.replace(new RegExp('<script[^>]*src="[^"]*' + fname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*"[^>]*>[\\s\\S]*?</script>', 'i'), '<!-- heimdall: dead chunk (origin 404) -->');
        if (html !== before) removed++;
      }
      if (removed) console.log(`  dead chunks removed: ${removed}`);
    } catch (e) { console.warn('  chunk precheck failed:', String(e).slice(0, 80)); }
  }

  const rel = liveSnapshotPath(target.pathname, target.search);
  const out = join(liveDir, rel);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  built++;
  console.log(`  live/${rel}`);
}
console.log(`build_live DONE ${host}: ${built} pages -> ${liveDir}`);
