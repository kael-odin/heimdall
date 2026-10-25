#!/usr/bin/env node
/**
 * 构建插件用的 MCP 入口（E4-04、E2-01）：把 SDK 与代理服务打成**单文件** plugin/server/heimdall-mcp.mjs，
 * 随版本提交。插件安装后只有插件目录存在，找不到仓库里的 packages/mcp，所以必须是自包含的。
 *
 *   node packages/mcp/scripts/build-plugin.mjs
 *
 * 产物：plugin/server/heimdall-mcp.mjs（ESM，Node ≥ 20.19，无外部依赖）
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const REPO = join(PKG, '..', '..');
const OUT = join(REPO, 'plugin', 'server', 'heimdall-mcp.mjs');

// 提示词与工具清单同源：prompts.mjs 是唯一来源，这里复制成代理旁边的一份，再由 esbuild 内联进单文件
copyFileSync(join(PKG, 'src', 'prompts.mjs'), join(PKG, 'src', 'mcp-prompts.mjs'));
mkdirSync(dirname(OUT), { recursive: true });
await build({
  entryPoints: [join(PKG, 'src', 'proxy-bin.mjs')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: OUT,
  // 入口自己带 shebang，esbuild 会放在第 1 行；banner 里不能再放一个（否则第 2 行的 #! 不是注释，Node 直接语法错误）
  banner: { js: '// 由 packages/mcp/scripts/build-plugin.mjs 生成，勿手改。源码：packages/mcp/src/proxy-server.mjs' },
  legalComments: 'none', minify: false, sourcemap: false,
});
const st = statSync(OUT);
writeFileSync(join(dirname(OUT), 'BUILD.json'), JSON.stringify({ builtAt: new Date().toISOString(), bytes: st.size, entry: 'packages/mcp/src/proxy-bin.mjs' }, null, 2) + '\n');
console.log(`plugin/server/heimdall-mcp.mjs ${(st.size / 1024).toFixed(0)} KB`);
