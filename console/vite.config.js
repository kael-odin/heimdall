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
    proxy: { '/api/': 'http://127.0.0.1:8900' },
  },
});
