/**
 * 栈适配器 —— "apify 成功 ≠ 别的站成功"的架构保证
 *
 * 侦察/造物各环节的站点特化逻辑全部收敛到这里：
 *   detect(domHtml)            框架探测
 *   cssRefCandidates(absUrl)   CSSOM 引用 URL 修正候选链（序列化丢前缀等）
 *   pageCleanup(page)          页面级清理（cookie banner 残留等），截图/抓 DOM 前调用
 *
 * 用法: pickAdapter(domHtml) 返回第一个命中的适配器，否则 generic。
 */

const generic = {
  name: 'generic',
  detect: () => true,
  cssRefCandidates: (abs) => [abs],
  pageCleanup: async () => {},
};

const nextjs = {
  name: 'nextjs',
  detect: (dom) => /__NEXT_DATA__|\/_next\/static/.test(dom),
  // CSSOM cssText 序列化会把 /_next/static/media 丢前缀成 /media/
  cssRefCandidates: (abs) => [
    abs,
    abs.replace(/^(https?:\/\/[^/]+)\/media\//, '$1/_next/static/media/'),
  ],
  pageCleanup: async (page) => {
    await page.evaluate(() => {
      document.getElementById('onetrust-consent-sdk')?.remove();
      document.getElementById('onetrust-banner-sdk')?.remove();
    });
  },
};

// thordata 路线（Vue3+Vite+scoped CSS）——W5 接入，先占位探测
const vueVite = {
  name: 'vue-vite',
  detect: (dom) => /data-v-[0-9a-f]{6,8}/.test(dom) && !nextjs.detect(dom),
  cssRefCandidates: (abs) => [abs],
  pageCleanup: async () => {},
};

const ADAPTERS = [nextjs, vueVite, generic];

export function pickAdapter(domHtml) {
  return ADAPTERS.find(a => a.detect(domHtml)) ?? generic;
}

export { generic, nextjs, vueVite };
