import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

// 工作区产物统一经过引擎鉴权；开发服务器不能直接公开 core/workspace。
export default defineConfig(() => ({
  plugins: [vue()],
  publicDir: false,
  resolve: {
    // three ships a monolithic pre-bundled module by default. Point the graph
    // stack at the ESM source entry so unused WebGPU/TSL modules can be shaken
    // out and the remaining renderer code can participate in chunk splitting.
    alias: [{
      find: /^three$/,
      replacement: fileURLToPath(new URL('./node_modules/three/src/Three.js', import.meta.url)),
    }, {
      find: /^three\/webgpu$/,
      replacement: fileURLToPath(new URL('./src/three-webgpu-stub.js', import.meta.url)),
    }],
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three-webgl-core', test: /node_modules[\\/]three[\\/]src[\\/]renderers[\\/]webgl[\\/]/, priority: 45 },
            // WebGLRenderer only depends downward into Three's core modules, so it
            // can be split without cutting the circular math/geometry module graph.
            { name: 'three-webgl', test: /node_modules[\\/]three[\\/]src[\\/]renderers[\\/]WebGLRenderer\.js$/, priority: 40 },
            // Keep Three's circular internal module graph in one chunk. Splitting
            // individual Three modules can leave constructors undefined at runtime.
            { name: 'three', test: /node_modules[\\/]three[\\/]/, priority: 30 },
            { name: 'graph3d', test: /node_modules[\\/](?:3d-force-graph|three-forcegraph|three-render-objects|kapsule|accessor-fn)[\\/]/, priority: 20 },
            { name: 'd3', test: /node_modules[\\/]d3-/, priority: 10 },
          ],
        },
      },
    },
  },
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
