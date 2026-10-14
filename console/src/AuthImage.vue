<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { apiHeaders, staticBridgeNeeded, staticUrl } from './api.js';

const props = defineProps({
  src: { type: String, default: '' },
  alt: { type: String, default: '' },
  token: { type: String, default: '' },
});

const element = ref(null);
const visible = ref(false);
const displaySrc = ref('');
let observer;
let controller;
let objectUrl;

function clearRequest() {
  controller?.abort();
  controller = null;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

watch([() => props.src, () => props.token, visible], async () => {
  clearRequest();
  displaySrc.value = '';
  const url = staticUrl(props.src);
  if (!url) return;
  if (!staticBridgeNeeded()) { displaySrc.value = url; return; }
  if (!visible.value) return;
  const request = new AbortController();
  controller = request;
  try {
    const response = await fetch(url, { headers: apiHeaders(), credentials: 'omit', signal: request.signal });
    if (!response.ok) return;
    const blob = await response.blob();
    if (request.signal.aborted) return;
    objectUrl = URL.createObjectURL(blob);
    displaySrc.value = objectUrl;
  } catch { /* 图片加载失败时保留 alt 文本，不显示带鉴权错误的响应 */ }
}, { immediate: true });

onMounted(() => {
  if (!('IntersectionObserver' in window)) { visible.value = true; return; }
  observer = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) {
      visible.value = true;
      observer.disconnect();
    }
  }, { rootMargin: '200px' });
  observer.observe(element.value);
});
onBeforeUnmount(() => { observer?.disconnect(); clearRequest(); });
</script>

<template>
  <img ref="element" :src="displaySrc || undefined" :alt="alt" />
</template>
