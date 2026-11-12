/**
 * 站内 URL 归一化 —— **唯一实现**
 *
 * 为什么必须有：`https://ant.design/` 与 `https://ant.design` 是**同一个页面**，
 * 却是两个不同的字符串。不归一，侦察出来的星图里就会出现两条一模一样的路径、
 * 页面清单里同名两行；而产物目录名是按"去尾斜杠的 path"算的
 * （`pageNameOf` / `pathOf`），于是克隆其中一条会让另一条也显示"已克隆"。
 * 实测 ant.design：侦察 32 个节点里有 4 组这样的重复。
 *
 * 原本只有侦察的**种子 URL** 做了 `.replace(/\/$/,'')`，站内链接与 sitemap 没做 ——
 * 意图是对的，应用得不一致。所以这里做成一个模块，侦察与 SEO 采集共用一份实现，
 * 免得下次又在某一处漏掉（同类问题在这个仓库里已经出现过好几次）。
 *
 * 规则：去 hash；尾斜杠去掉（**根路径除外**）；其余原样（查询参数保留 ——
 * `?page=2` 是另一个页面，不能合并）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function canonUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    if (x.pathname.length > 1 && x.pathname.endsWith('/')) x.pathname = x.pathname.replace(/\/+$/, '');
    return x.href;
  } catch { return null; }
}

/** Keep resource identities distinct; redirects or equivalent content need separate evidence. */
export function httpResourceUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol) || x.username || x.password) return null;
    x.hash = '';
    return x.href;
  } catch { return null; }
}

/**
 * 用户手写的地址 → 可解析的 URL 字符串（补协议）。
 *
 * 为什么需要：CLI 的帮助文本写的就是 `heimdall recon apify.com 30` —— 不带协议。
 * 而 recon 内部第一件事是 `new URL(TARGET).origin`，于是**照着自己的文档敲命令会崩**：
 *   TypeError: Invalid URL  input: 'apify.com'
 * 引擎那条路径没暴露这个问题，是因为请求体先过 `new URL(url).href`，不合法就直接
 * 返回 400，用户看到的是"invalid url"。只有 CLI 这条路会真的抛栈。
 *
 * 规则：已有协议的原样保留（`http://localhost:3000` 不能被改成 https）；
 * `//host/...` 补 `https:`；其余一律当主机名，补 `https://`。
 * 返回 null 表示补完仍解析不了 —— 由调用方决定报错文案。
 */
export function asUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : s.startsWith('//') ? 'https:' + s : 'https://' + s;
  try { return new URL(candidate).href; } catch { return null; }
}

/** 归一化并判等（用于"这两条是不是同一页"这类判断） */
export function sameCanonUrl(a, b) {
  const x = canonUrl(a), y = canonUrl(b);
  return !!x && x === y;
}

/** URL.origin 比较，避免 example.com.evil.test 通过字符串前缀判断。 */
export function isSameOriginUrl(url, origin) {
  try { return new URL(url).origin === new URL(origin).origin; } catch { return false; }
}

/**
 * 星图节点的稳定 id —— **url 的纯函数**，与访问顺序无关。
 *
 * 为什么不能用自增序号：侦察是 3 路并发的，`n${i++}` 会把"谁先加载完"写进 id。
 * 同一个没变的站点侦察两次 → id↔url 对不上、缩略图与边全变、任何按 id 的 diff 都报"变了"。
 * 短哈希保证同一 url 永远同一个 id（跨次、跨机一致），可复现性这才成立。
 */
export function stableNodeId(url) {
  return 'n' + createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
}

/**
 * URL → 页面目录名。**这是唯一实现** —— 它此前散着四份（engine 两份、queue、pipeline），
 * 而 pipeline 那份干脆把"没给页名"的默认值写成了常量 `'page'`：
 *
 *     heimdall forge https://vercel.com/customers     → 产物落进 pages/page/
 *
 * 页名不对还只是小事，**两个不同的 URL 会先后写进同一个目录、互相覆盖**（实测踩到：
 * 重新锻造 customers 时，它把自己放进了 page/，与上一次同样用法的锻造产物撞在一起）。
 *
 * 简单路径保留旧目录名；会折叠信息的路径加稳定摘要。历史目录由
 * createPageNameResolver 按 manifest.target 识别，不靠猜测旧名字。
 *
 * @param {string|URL} input
 * @param {string} [fallback='home']
 */
export function pageNameOfUrl(input, fallback = 'home') {
  try {
    const x = input instanceof URL ? input : new URL(String(input));
    const canonical = canonUrl(x.href);
    if (x.pathname === '/') return x.search ? hashedPageName(canonical, 'home') : fallback;
    const simple = /^\/([a-z0-9_-]+)\/?$/.exec(x.pathname);
    if (simple && !x.search && simple[1] !== 'home' && simple[1].length <= 60
      && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(simple[1])) return simple[1];
    return hashedPageName(canonical);
  } catch { return fallback; }
}

function hashedPageName(canonical, hint = '') {
  const x = new URL(canonical);
  const slug = (hint || x.pathname.replace(/^\//, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'home').slice(0, 26);
  return slug + '--' + createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** 兼容历史 pages/<name>：仅 manifest.target 与当前 URL 相同时复用旧目录。 */
export function createPageNameResolver(siteDir) {
  const byUrl = new Map();
  const byName = new Map();
  const pagesDir = join(siteDir, 'pages');
  if (existsSync(pagesDir)) {
    for (const name of readdirSync(pagesDir).sort()) {
      let target = null;
      try { target = canonUrl(JSON.parse(readFileSync(join(pagesDir, name, 'manifest.json'), 'utf8')).target); } catch {}
      byName.set(name.toLowerCase(), target);
      if (target && !byUrl.has(target)) byUrl.set(target, name);
    }
  }
  return (input) => {
    const canonical = canonUrl(input instanceof URL ? input.href : input);
    if (!canonical) return 'home';
    if (byUrl.has(canonical)) return byUrl.get(canonical);
    let name = pageNameOfUrl(canonical);
    if (byName.has(name.toLowerCase()) && byName.get(name.toLowerCase()) !== canonical) {
      name = hashedPageName(canonical);
    }
    if (byName.has(name.toLowerCase()) && byName.get(name.toLowerCase()) !== canonical) {
      throw new Error('page name collision: ' + canonical);
    }
    byUrl.set(canonical, name);
    byName.set(name.toLowerCase(), canonical);
    return name;
  };
}

export function resolvePageNameOfUrl(input, siteDir) {
  return createPageNameResolver(siteDir)(input);
}
