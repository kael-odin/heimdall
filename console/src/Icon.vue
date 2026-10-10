<script setup>
/**
 * Icon — 控制台图标（自绘 SVG，统一 24 网格 / 1.6 描边 / 圆头圆角）
 *
 * 为什么不用 Unicode 字符（☰ ☾ ☀ ✕）：不同平台字形差异大、基线不可控、描边粗细无法统一，
 * 而且屏幕阅读器会把符号当正文念出来。自绘 SVG 才能做到一套一致的笔画与重量。
 *
 * 用法：<Icon name="menu" />，尺寸继承 font-size（1em），颜色继承 currentColor。
 */
const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  sun: 'M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4',
  moon: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z',
  external: 'M14 5h5v5M19 5l-7 7M18 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  chevron: 'M9 6l6 6-6 6',
  bolt: 'M13 3 6 13h5l-1 8 7-10h-5l1-8Z',
  refresh: 'M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5',
  swap: 'M8 7h9l-3-3M16 17H7l3 3',
};
defineProps({
  name: { type: String, required: true },
  /** 仅图标按钮必须给可访问名；与可见文字同用时应设 decorative */
  label: { type: String, default: '' },
  decorative: { type: Boolean, default: false },
});
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    :aria-hidden="decorative || !label ? 'true' : undefined"
    :role="label && !decorative ? 'img' : undefined"
    :aria-label="label && !decorative ? label : undefined"
    focusable="false"
  >
    <circle v-if="name === 'sun'" cx="12" cy="12" r="3.6" />
    <path :d="PATHS[name] ?? PATHS.menu" />
  </svg>
</template>

<style scoped>
/* inline-block 以便与文字并排（按钮文案前的小图标）；在 flex 容器里由 gap 负责间距 */
.icon { width: 1em; height: 1em; display: inline-block; vertical-align: -.14em; flex: none; }
</style>
