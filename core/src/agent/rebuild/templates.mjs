/**
 * agent/rebuild/templates — 技术栈配置（Stack Profile，E7-02，PRD 05 §4.2）
 *
 * 一个配置 = 一套锁版本的脚手架 + 约定 + 命令。Ph1 两个：
 *   html-css                语义 HTML + CSS 变量；零依赖（自带 serve.mjs 做 dev server），最快到 gold
 *   vite-react-ts-tailwind  主推；版本写死（不用 ^），首次安装带 --ignore-scripts
 * 两者共同约定：原件资产在 public/assets/，字体在 public/assets/fonts/ 并由 public/fonts.css 声明，
 * 页面里只引用 /assets/… 与 /fonts.css；分段根元素带 data-heimdall-section="<sectionId>"。
 */

/** vite-react-ts-tailwind 的锁定版本（2026-10-25 取自 npm；升级时整组一起改并重测） */
export const VITE_STACK_VERSIONS = Object.freeze({
  dependencies: { react: '19.3.1', 'react-dom': '19.3.1' },
  devDependencies: {
    vite: '8.3.5', '@vitejs/plugin-react': '6.1.2', tailwindcss: '4.3.3', '@tailwindcss/vite': '4.3.3',
    typescript: '5.9.3', '@types/react': '19.3.0', '@types/react-dom': '19.3.0',
  },
});

export const STACKS = Object.freeze(['html-css', 'vite-react-ts-tailwind']);

const htmlShell = ({ title, lang }) => `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/fonts.css">
`;

/** 零依赖的 dev server：public/ 优先，其次项目根；不提供 .heimdall/（参考图不能被页面引用） */
const SERVE_MJS = (port) => `#!/usr/bin/env node
// 重建工作区的 dev server（html-css 技术栈）。由 heimdall rebuild init 生成。
// 用法：node serve.mjs [--port ${port}]
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\\\/]+$/, '');
const i = process.argv.indexOf('--port');
const PORT = Number(i > -1 ? process.argv[i + 1] : ${port});
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.avif': 'image/avif',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4' };

createServer((req, res) => {
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  if (path.endsWith('/')) path += 'index.html';
  for (const base of [join(ROOT, 'public'), ROOT]) {
    const file = normalize(join(base, path));
    if (!file.startsWith(base + sep) || file.includes(sep + '.heimdall') || file.includes(sep + 'node_modules')) continue;
    if (existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      return createReadStream(file).pipe(res);
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}).listen(PORT, '127.0.0.1', () => console.log(\`dev server @ http://127.0.0.1:\${PORT}/\`));
`;

/**
 * 生成某个技术栈的文件表 { 相对路径: 内容 }。
 * ctx: { siteId, page, port, title, lang, effectiveBg, tokensCss }
 */
export function stackFiles(stack, ctx) {
  const { port, title, lang, effectiveBg, tokensCss } = ctx;
  if (stack === 'html-css') {
    // 每段一个样式文件：分段循环里改一段不会波及其它段（Bench 实测：全局 CSS 会让「按分段改」失效）
    const sections = (ctx.sections ?? []).filter(s => !s.overlay);
    const sectionFiles = Object.fromEntries(sections.map(s => [`sections/${s.id}.css`,
      `/* ${s.id}（${s.role}）的样式。只写这一段用到的规则；全局的重置与容器放 styles.css。 */\n`]));
    const sectionLinks = sections.map(s => `<link rel="stylesheet" href="/sections/${s.id}.css">`).join('\n');
    return {
      'package.json': JSON.stringify({ name: `rebuild-${ctx.siteId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`, private: true, type: 'module',
        scripts: { dev: `node serve.mjs --port ${port}` } }, null, 2) + '\n',
      'serve.mjs': SERVE_MJS(port),
      'index.html': htmlShell({ title, lang }) + `<link rel="stylesheet" href="/tokens.css">\n<link rel="stylesheet" href="/styles.css">\n${sectionLinks ? sectionLinks + '\n' : ''}</head>\n<body>\n<!--\n  按分段计划自上而下重建（.heimdall/sections/${ctx.page}.json）。\n  每个分段的根元素加 data-heimdall-section="<sectionId>"，heimdall compare 才能单独度量它。\n  每段的样式写在 sections/<sectionId>.css，改一段不会波及其它段。\n-->\n</body>\n</html>\n`,
      'styles.css': `/* 全局样式。令牌在 tokens.css；字体在 /fonts.css（原站字体文件，已本地化）。 */\nhtml, body { margin: 0; }\nbody { background: ${effectiveBg}; }\n`,
      'tokens.css': tokensCss,
      ...sectionFiles,
    };
  }
  if (stack === 'vite-react-ts-tailwind') {
    return {
      'package.json': JSON.stringify({
        name: `rebuild-${ctx.siteId.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`, private: true, type: 'module',
        scripts: { dev: `vite --port ${port} --strictPort --host 127.0.0.1`, build: 'vite build', preview: `vite preview --port ${port} --strictPort --host 127.0.0.1`, typecheck: 'tsc --noEmit' },
        dependencies: VITE_STACK_VERSIONS.dependencies, devDependencies: VITE_STACK_VERSIONS.devDependencies,
      }, null, 2) + '\n',
      'vite.config.ts': `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nimport tailwindcss from '@tailwindcss/vite';\n\n// 由 heimdall rebuild init 生成。端口与 heimdall.config.json 的 devServer.url 一致。\nexport default defineConfig({\n  plugins: [react(), tailwindcss()],\n  server: { port: ${port}, strictPort: true, host: '127.0.0.1' },\n  preview: { port: ${port}, strictPort: true, host: '127.0.0.1' },\n});\n`,
      'index.html': htmlShell({ title, lang }) + `</head>\n<body>\n<div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n</body>\n</html>\n`,
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM', 'DOM.Iterable'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx',
        strict: true, noEmit: true, skipLibCheck: true, isolatedModules: true, allowImportingTsExtensions: false, types: [] }, include: ['src'] }, null, 2) + '\n',
      'src/main.tsx': `import { StrictMode } from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App';\nimport './index.css';\n\ncreateRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);\n`,
      'src/App.tsx': `// 按分段计划自上而下拼装页面（.heimdall/sections/${ctx.page}.json）。\n// 每个分段一个组件放在 src/sections/，组件根元素加 data-heimdall-section="<sectionId>"，\n// heimdall compare 才能单独度量它。\nexport default function App() {\n  return (\n    <>\n    </>\n  );\n}\n`,
      'src/index.css': `@import "tailwindcss";\n@import "./tokens.css";\n\nhtml, body { margin: 0; }\nbody { background: ${effectiveBg}; }\n`,
      'src/tokens.css': tokensCss,
      'src/sections/.gitkeep': '',
    };
  }
  throw new Error(`unknown stack: ${stack}`);
}

/** 开发服务器启动命令（写进 heimdall.config.json 与 AGENTS.md） */
export const devCommand = (stack, port) => stack === 'html-css' ? `node serve.mjs --port ${port}` : 'pnpm dev';
