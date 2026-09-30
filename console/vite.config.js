import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  // 引擎产物直接作静态资源：atlas.json / thumbs / clone 页均可从 /<host>/... 访问
  publicDir: '../core/workspace',
  server: {
    port: 5173,
    host: '127.0.0.1',
    // key 必须带尾斜杠：'/api' 前缀会误劫持 /apify.com/... 等以 /api 开头的静态资源路径
    proxy: { '/api/': 'http://127.0.0.1:8900' },
  },
});
