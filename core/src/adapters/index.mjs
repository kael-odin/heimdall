/**
 * 栈适配器 —— "apify 成功 ≠ 别的站成功"的架构保证
 *
 * **职责边界**：这里只放**由框架指纹推导**的通用规则（nextjs 的 CSSOM 前缀偏移、
 * Vue scoped 的清理等）。**站点特有的东西一律进 `core/sites/<host>.json`**，
 * 不要让本站长出一堆 `if (host === 'xxx')`。
 *
 * 适配器契约（全部是数据，不是函数）：
 *   name              适配器名
 *   detect(domHtml)   框架探测
 *   cssRefRewrites    [{ from: 正则源串, to: 替换串 }]，作用于绝对 URL
 *                     —— CSSOM 的 cssText 序列化会丢前缀（如 /media/ 实为 /_next/static/media/）
 *   removeSelectors   抓 DOM / 截图前直接删掉的选择器（cookie 弹窗等）
 *
 * 用法: pickAdapter(domHtml, profile) → 命中第一个适配器，否则 generic
 */
import { compileRefRewrites } from '../site-profile.mjs';

const generic = {
  name: 'generic',
  detect: () => true,
  cssRefRewrites: [],
  removeSelectors: [],
};

const nextjs = {
  name: 'nextjs',
  detect: (dom) => /__NEXT_DATA__|\/_next\/static/.test(dom),
  // CSSOM cssText 序列化会把 /_next/static/media 丢前缀成 /media/
  cssRefRewrites: [{ from: '^(https?://[^/]+)/media/', to: '$1/_next/static/media/' }],
  removeSelectors: ['#onetrust-consent-sdk', '#onetrust-banner-sdk'],
};

// Vue3 + Vite + scoped CSS（thordata 路线）：CSSOM 最终态即真身，无需额外前缀修正
const vueVite = {
  name: 'vue-vite',
  detect: (dom) => /data-v-[0-9a-f]{6,8}/.test(dom) && !nextjs.detect(dom),
  cssRefRewrites: [],
  removeSelectors: [],
};

const ADAPTERS = [nextjs, vueVite, generic];
const BY_NAME = new Map(ADAPTERS.map(a => [a.name, a]));

/**
 * @param {string} domHtml
 * @param {{adapter?: string}} [profile] 站点配方；adapter ≠ 'auto' 时强制指定
 */
export function pickAdapter(domHtml, profile) {
  const forced = profile?.adapter;
  if (forced && forced !== 'auto') {
    const named = BY_NAME.get(forced);
    if (named) return named;
  }
  return ADAPTERS.find(a => a.detect(domHtml)) ?? generic;
}

/** 把适配器与配方的重写规则合成候选链生成器 */
export function refRewriteCandidates(adapter, profile) {
  const rewrites = [
    ...(adapter?.cssRefRewrites ?? []),
    ...(profile?.css?.refRewrites ?? []),
  ];
  const compiled = compileRefRewrites(rewrites);
  return (abs) => {
    const out = [];
    for (const { re, to } of compiled) {
      const next = abs.replace(re, to);
      if (next !== abs && !out.includes(next)) out.push(next);
    }
    return out;
  };
}

export { generic, nextjs, vueVite, ADAPTERS };
