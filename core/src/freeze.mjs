/**
 * freeze —— 截图用的"冻结点"样式，**唯一实现**
 *
 * 它只做一件事：让**截图**可复现。动画在飞、光标在闪、轮播在转的时候，
 * 原站与镜像各截各的，比出来的分数反映的是"截到哪一帧"，不是"像不像"。
 * 所以两侧截图前注入同一份冻结样式，比完就结束 —— 它**不属于产物**。
 *
 * 这条边界以前没人写下来，于是它出现在了不该出现的地方：
 * 冻结样式是在 `page.addStyleTag()` 之后抓 dom.html 的，而交互镜像正是从 dom.html 生成的，
 * 于是**每一页交互镜像都带着 `animation-duration:0s !important`** ——
 * 一整批"能跑起来看动效"的产物，被我们自己的截图工具冻住了（实测 apify 61/61 页）。
 * 现在：唯一来源 + 标记注释 + `stripFreeze()` 兜底（老产物重建时也能洗掉）。
 *
 * 六个副本的差异也一并收拢：轮播归位（swiper）与同意弹层隐藏（consent）是**可选叠加项**，
 * 需要哪几项由调用方显式点名，不再靠复制粘贴时顺手带不带。
 */

/** 标记注释：新注入的冻结样式都带它，`stripFreeze()` 优先按它精确剥离 */
export const FREEZE_MARK = '/* heimdall:freeze */';

/** 冻结本体：动画/过渡时长归零、光标不闪 */
export const FREEZE_BASE = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;'
  + 'transition-duration:0s!important;transition-delay:0s!important;caret-color:transparent!important}';

/** 轮播归位：Swiper 把当前页写在行内 transform 上，两侧都拉回初始位才比得了 */
export const SWIPER_RESET = '.swiper-wrapper{transform:none!important;transition:none!important}';

/** 同意弹层：随访问状态出现/消失，会造成评分抖动，两侧统一隐藏 */
export const CONSENT_HIDE = '[class*="cookie" i],[id*="cookie" i],[class*="consent" i],[id*="consent" i],'
  + '[class*="gdpr" i],[id*="gdpr" i]{display:none!important}';

/**
 * 拼一份冻结样式。
 * @param {{swiper?: boolean, consent?: boolean}} [opts]
 */
export function freezeCss({ swiper = false, consent = false } = {}) {
  return FREEZE_MARK + FREEZE_BASE + (swiper ? SWIPER_RESET : '') + (consent ? CONSENT_HIDE : '');
}

/**
 * 从 HTML 里剥掉冻结样式块 —— 给**已经产出的**产物兜底。
 *
 * 两条判据：带 `FREEZE_MARK` 的（新产物）；或同时含 `animation-duration:0s` 与
 * `caret-color:transparent` 的（旧产物没标记）。第二条刻意收紧到要同时命中两个特征，
 * 免得把站点自己写的 `prefers-reduced-motion` 规则当成我们的冻结剥掉。
 */
export function stripFreeze(html) {
  const src = String(html ?? '');
  if (!src.includes('caret-color:transparent') && !src.includes('caret-color: transparent')) return src;
  return src.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (block) => {
    if (block.includes(FREEZE_MARK)) return '';
    const compact = block.replace(/\s+/g, '');
    const isFreeze = /animation-duration:0s!important/.test(compact) && /caret-color:transparent!important/.test(compact);
    return isFreeze ? '' : block;
  });
}
