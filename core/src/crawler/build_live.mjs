/**
 * build_live — 快照 → 活镜像页转换器
 *
 * dom.html（渲染后完整 DOM，含 script 引用）→ live/<path>/index.html
 *   1) <base href="/lm/<host><dir>/">  —— 全部相对资源/请求自动归位到代理
 *   2) 全文绝对 URL 归一：https://<host> → /lm/<host>（属性/RSC payload/内联脚本一把梭）
 *   3) bootstrap patch 注入：JS 运行时硬编码的绝对域 → 代理路径（fetch/XHR 兜底）
 *   4) CSS 用本地校准版（cssom.css，死镜像同款）替换原版引用 —— 视觉保真双保险
 *
 * 部署位置与 engine /lm/ 融合路由约定一致：/lm/<host>/<path> → live/<path>/index.html
 *
 * 用法: node src/crawler/build_live.mjs <host>          （全部已锻页）
 *       node src/crawler/build_live.mjs <host> <page>   （单页）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const host = process.argv[2] ?? 'thordata.com';
const only = process.argv[3];
const BASE = join('workspace', host);
const PAGES = join(BASE, 'pages');

const pages = readdirSync(PAGES).filter(n => existsSync(join(PAGES, n, 'manifest.json')));
const liveDir = join(BASE, 'live');
mkdirSync(liveDir, { recursive: true });

let built = 0;
for (const name of pages) {
  if (only && name !== only) continue;
  const dir = join(PAGES, name);
  const domPath = join(dir, 'dom.html');
  if (!existsSync(domPath)) continue;
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  if (!manifest?.target) continue;
  const target = new URL(manifest.target);
  const lmPrefix = `/lm/${target.host}`;
  const dirOnOrigin = target.pathname.replace(/\/$/, '');   // 原站目录（/pricing）
  const baseHref = `/lm/${target.host}${dirOnOrigin === '/' || !dirOnOrigin ? '/' : dirOnOrigin + '/'}`;

  let html = readFileSync(domPath, 'utf8');

  // 1) 绝对 URL 归一到代理（www 与裸域都归一）
  for (const h of [target.origin, `https://${host}`, `http://${host}`]) {
    html = html.split(h + '/').join(lmPrefix + '/');
    html = html.split(h).join(lmPrefix);
  }

  // 1.5) 剥第三方挂件脚本——必须在 bootstrap 注入之前（2d 正则会把含 mixpanel 关键词的 bootstrap 当挂件删掉）
  html = html.replace(/<script[^>]*(?:consent\.cookiebot|cookiebot\.com|crisp\.chat)[^>]*><\/script>/gi, '');
  html = html.replace(/<script[^>]*>[^<]*(?:CookieConsent|\$crisp|mixpanel)[^<]*<\/script>/gi, '');
  html = html.replace(/<script[^>]*src="[^"]*mixpanel[^>]*><\/script>/gi, '');

  // 2) <base> 注入（相对资源/请求归位）+ bootstrap（JS 运行时硬编码绝对域兜底）
  const bootstrap = `<script>(function(){
    var H='${lmPrefix}', O='${target.origin}';
    function px(u){ try{
      if(typeof u!=='string') return u;
      if(u.indexOf(H)===0||u.indexOf('/lm/')===0) return u;
      if(u.indexOf(O)===0) return H+u.slice(O.length);
      if(u.charAt(0)==='/' && u.indexOf('/static/')!==0) return H+u;   // 根相对：base 管不了根路径（/ 开头直接打源根）
    }catch(e){} return u; }
    var of=window.fetch;
    window.fetch=function(input,init){ try{
      if(typeof input==='string') input=px(input);
      else if(input&&input.url) input=new Request(px(input.url),input);
    }catch(e){} return of.call(window,input,init); };
    var oo=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(){ try{ arguments[1]=px(String(arguments[1])); }catch(e){} return oo.apply(this,arguments); };
    // 第三方挂件魔法 stub：无限递归 Proxy——任何属性/调用/构造都返回自身（分析类挂件在镜像里本就应无操作）
    var MAGIC = new Proxy(function(){}, {
      get: function(t, k){ if (k === Symbol.toPrimitive) return function(){ return ''; }; if (k === 'then' || k === 'nodeType') return undefined; return MAGIC; },
      set: function(){ return true; },
      apply: function(){ return MAGIC; },
      construct: function(){ return MAGIC; },
      has: function(){ return true; },
      ownKeys: function(){ return []; },
      getOwnPropertyDescriptor: function(){ return undefined; }
    });
    var CONSERVATIVE = H.indexOf('/lm/apify') === 0;   // apify：chunk 对无限递归 stub 挂死 → 用保守版/不 stub（挂件经代理真跑）
    window.mixpanel = window.mixpanel || (CONSERVATIVE ? { init:function(){}, track:function(){}, push:function(){}, people:{ set:function(){} }, register:function(){}, time_event:function(){} } : MAGIC);
    window.qp = CONSERVATIVE ? function(){} : (window.qp || MAGIC);
    window.CookieConsent = window.CookieConsent || (CONSERVATIVE ? undefined : MAGIC);
    window.$crisp = window.$crisp || [];
    window.CRISP_WEBSITE_ID = window.CRISP_WEBSITE_ID || '';
    window.ttq = CONSERVATIVE ? (window.ttq || { _ttq_create:function(){}, track:function(){}, page:function(){}, load:function(){}, identify:function(){}, methods:[], push:function(a){ this.methods.push(a); } }) : (window.ttq || MAGIC);
    window.clarity = window.clarity || MAGIC;
    window.gtag = window.gtag || function(){ (window.dataLayer = window.dataLayer || []).push(arguments); };
    window.dataLayer = window.dataLayer || [];
    window.fbq = window.fbq || function(){};
    window.OneTrust = window.OneTrust || { };
  })();</script>`;
  console.error('[bl] bootstrap len =', bootstrap.length, '| has mixpanel:', bootstrap.includes('window.mixpanel'));
  html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseHref}">${bootstrap}`);
  console.error('[bl after-inject] has-mixpanel:', html.includes('window.mixpanel'));

  // 2b) 根相对引用重写（<base> 管不了 / 开头路径——那是直接打当前源根）
  html = html.replace(/((?:src|href|srcset|action)\s*=\s*["'])\/(?!lm\/|static\/)/gi, `$1/lm/${target.host}/`);
  html = html.replace(/url\(\s*(?:&quot;|['"])?\/(?!lm\/|static\/)/gi, `url("/lm/${target.host}/`);

  // 2c) JS 字符串里的动态 import / 硬编码路径（import() 是语言级，不走 fetch patch）
  html = html.replace(/(import\s*\(\s*["'])\/(?!lm\/|static\/)/gi, `$1/lm/${target.host}/`);
  // 2c-2') importmap JSON 与 JS 字符串里的已知目录（零正则，字符串定位）
  for (const d of ['src/', '_next/', '_nuxt/', 'assets/', 'media/', 'img/', 'api/', 'files/', 'dist/']) {
    html = html.split('"/' + d).join('"/lm/' + target.host + '/' + d);
    html = html.split("'/" + d).join("'/lm/" + target.host + '/' + d);
  }
  // 2e) 收尾：剩余一切根相对引用（icons/ 等任意目录）→ 代理前缀
  html = html.replace(/(\b(?:src|href|srcset|action)\s*=\s*["']?)\/(?!lm\/|static\/)/gi, `$1/lm/${target.host}/`);
  html = html.replace(/url\(\s*(?:&quot;|['"])?\/(?!lm\/|static\/)/gi, `url("/lm/${target.host}/`);



  // 3) 原版 CSS 引用替换为本地校准版（cssom.css，死镜像同款——视觉保真双保险）
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, '');
  html = html.replace('</head>', '<link rel="stylesheet" href="/static/' + host + '/pages/' + name + '/clone/styles/cssom.css"></head>');
  // 内联 style 标签里可能引用原站字体 url —— 全文兜底（字体走代理，版本永远匹配）
  html = html.split(lmPrefix + '/_next/').join(lmPrefix + '/_next/');   // no-op 保持形态直观

  const rel = dirOnOrigin === '' || dirOnOrigin === '/' ? 'index.html' : dirOnOrigin.replace(/^\//, '') + '/index.html';
  const out = join(liveDir, rel);
  mkdirSync(out.slice(0, out.lastIndexOf('/')), { recursive: true });
  writeFileSync(out, html);
  console.error('[bl out]', out, '| exists:', existsSync(out), '| size:', existsSync(out) ? readFileSync(out).length : -1);
  const reread = readFileSync(out, 'utf8');
  console.error('[bl reread] len:', reread.length, 'has-mixpanel:', reread.includes('window.mixpanel'), 'has-base:', reread.includes('<base'));
  console.error('[bl after-write] file has-mixpanel:', readFileSync(out, 'utf8').includes('window.mixpanel'));
  built++;
  console.log(`  live/${rel}`);
}
console.log(`build_live DONE ${host}: ${built} pages -> ${liveDir}`);
