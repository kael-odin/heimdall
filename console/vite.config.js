import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 工作区产物统一经过引擎鉴权；开发服务器不能直接公开 core/workspace。
export default defineConfig(() => ({
  plugins: [vue()],
  publicDir: false,
  server: {
    port: 5173,
    // 端口被占时 vite 默认悄悄换 5174；引擎的 CORS 白名单默认只认 5173，
    // 换了端口所有请求都会被拒，表现是"页面能开但全是空的"。宁可直接报错。
    strictPort: true,
    host: '127.0.0.1',
    // key 必须带尾斜杠：'/api' 前缀会误劫持 /apify.com/... 等以 /api 开头的静态资源路径
    //
    // /static/ 也转给引擎：控制台取 workspace 文件统一走这个前缀
    // （引擎侧是显式路由，dev 侧没有对应的 publicDir 映射，所以要单独代理）。
    // 见 src/api.js 顶部注释。
    proxy: {
      '/api/': 'http://127.0.0.1:8900',
      '/static/': 'http://127.0.0.1:8900',
    },
  },
}));
