import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 引擎产物目录：**只给 dev 用**，而且只是方便手工核对（`/<host>/pages/...` 直接可访问）。
// 控制台取 workspace 文件统一走 `/static/`，由引擎显式路由服务（见 src/api.js 顶部）。
//
// build 时必须关掉：vite 会把 publicDir **整个目录拷进 dist**，而这里指的是整个
// workspace（实测 10GB）—— 于是每次 `pnpm build` 都复制一份工作区，
// 本地 dist 一度肿到 18GB、构建从几秒变成几分钟。Dockerfile 早就用
// HEIMDALL_SKIP_WORKSPACE=1 绕开了（生产构建不需要它），本地没有这个变量。
const workspaceDir = fileURLToPath(new URL('../core/workspace', import.meta.url));
const useWorkspaceDir = existsSync(workspaceDir) && process.env.HEIMDALL_SKIP_WORKSPACE !== '1';

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  publicDir: command === 'build' ? false : (useWorkspaceDir ? workspaceDir : false),
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
}));
