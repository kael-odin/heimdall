import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 引擎产物目录（local dev 时直接作为静态资源；CI/无产物或显式跳过时禁用 publicDir）
const workspaceDir = fileURLToPath(new URL('../core/workspace', import.meta.url));
const publicDir = process.env.HEIMDALL_SKIP_WORKSPACE === '1' || !existsSync(workspaceDir) ? false : workspaceDir;

export default defineConfig({
  plugins: [vue()],
  publicDir,
  server: {
    port: 5173,
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
});
