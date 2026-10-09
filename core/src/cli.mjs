#!/usr/bin/env node
/**
 * Heimdall CLI — 统一命令入口（所有能力一个入口）
 *
 *   heimdall recon <url> [maxPages]            全站侦察
 *   heimdall forge <url> [pageName]            单页完整克隆
 *   heimdall queue <host> [--max N]            全站批量克隆
 *   heimdall audit <host> [--max N]            SEO 审计
 *   heimdall watch <host> [--max N]            站点变更监控
 *   heimdall verify <host> <page>|--all        多视口保真验证
 *   heimdall tokens <host> [--pages N]         设计 token 提取
 *   heimdall live <host> [--offline]           导出可部署活镜像包
 *   heimdall dedupe <host> [--dry-run]         资产 CAS 去重
 *   heimdall deliver <host>                    打包交付物
 *   heimdall serve [port]                      启动引擎/控制台服务
 *
 * 用法: node src/cli.mjs <command> [...args]   或   pnpm -C core cli <command> ...
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..');

export const COMMANDS = {
  recon:   { script: 'src/crawler/recon.mjs', usage: 'recon <url> [maxPages] [maxDepth]', desc: '全站侦察 → atlas.json + 缩略图' },
  forge:   { script: 'src/pipeline.mjs', usage: 'forge <url> [pageName]', desc: '单页完整克隆流水线（capture→build→diff→fixup→harvest）' },
  queue:   { script: 'src/queue.mjs', usage: 'queue <host> [--max N] [--force] [--missing-har] [--no-dedupe]', desc: '全站批量克隆（持久化队列/断点续跑/末尾去重）' },
  audit:   { script: 'src/seo/audit.mjs', usage: 'audit <host> [--max N] [--threshold N]', desc: 'SEO 审计（40+ 规则，HTML/CSV/JSON）' },
  orphans: { script: 'src/audit/orphans.mjs', usage: 'orphans <host>', desc: '孤儿资产扫描（clone 内无引用，疑似可回收）' },
  'repair-empty': { script: 'src/crawler/repair-empty-assets.mjs', usage: 'repair-empty <host> [--dry-run]', desc: '修复 0 字节资产（追踪信标→透明像素；其它→原始 URL）' },
  repair:  { script: 'src/crawler/repair-css-refs.mjs', usage: 'repair <host> [--dry-run]', desc: '修复历史 clone 的 CSS 相对路径坏链（字体 styles/styles/… 等）' },
  assets:  { script: 'src/audit/assets.mjs', usage: 'assets <host> [--max N]', desc: '资产缺口扫描（视觉缺口 vs 元数据/追踪/设计替代）' },
  watch:   { script: 'src/watch/watch.mjs', usage: 'watch <host> [--max N] [--accept] [--fail-on-change]', desc: '站点变更监控（两次采样去噪 + 变更报告）' },
  verify:  { script: 'src/verify/verify.mjs', usage: 'verify <host> <page>|--all [--max N] [--threshold N]', desc: '多视口（375/768/1440）全页保真验证' },
  tokens:  { script: 'src/extract/extract-tokens.mjs', usage: 'tokens <host> [--pages N] [--page name]', desc: '设计 token 提取（色板/字阶/间距/圆角/阴影）' },
  components: { script: 'src/extract/extract-components.mjs', usage: 'components <host> [--pages N] [--max N]', desc: '组件抽取（header/hero/pricing/faq/footer/cta → 独立预览）' },
  matrix:  { script: 'src/seo/matrix.mjs', usage: 'matrix <site1> <site2> [--max N] [--refresh]', desc: '竞品 SEO 对标矩阵（多站点聚合对比）' },
  mcp:     { script: 'src/mcp/server.mjs', usage: 'mcp', desc: 'MCP stdio 服务器（把 Heimdall 能力暴露给 agent 客户端）' },
  browser: { script: 'src/browser/bookmarklet.mjs', usage: 'browser [--api URL] [--token T]', desc: '生成浏览器书签入口安装页（在任意页面一键送入 Heimdall）' },
  sandbox: { script: 'src/sandbox/serve.mjs', usage: 'sandbox <host> <page> [--port 8090] [--reset]', desc: '沙盒改造台（改 HTML/CSS + 与原版实时对比）' },
  live:    { script: 'src/live/export.mjs', usage: 'live <host> [--offline] [--out <dir>] [--rebuild] [--root mirror] [--heal] [--materialize-har] [--strict]', desc: '导出可部署活镜像包（HAR 回放 + Docker + drop-in 根路径）' },
  dedupe:  { script: 'src/store/dedupe.mjs', usage: 'dedupe <host> [--dry-run] [--dir <path>]', desc: '内容寻址资产去重（硬链接）' },
  deliver: { script: 'src/deliver.mjs', usage: 'deliver <host> [hostDir]', desc: '打包交付物（site + intel + raw + README）' },
  serve:   { script: 'src/engine-server.mjs', usage: 'serve [port]', desc: '启动引擎/控制台（默认 8900）' },
};

export function resolveCommand(argv) {
  const name = argv?.[0];
  if (!name || !COMMANDS[name]) return null;
  return { name, ...COMMANDS[name], args: argv.slice(1) };
}

function help() {
  const rows = Object.entries(COMMANDS).map(([name, c]) => `  ${c.usage.padEnd(58)} ${c.desc}`);
  console.log(`Heimdall CLI\n\n${rows.join('\n')}\n\n示例:\n  heimdall recon apify.com 30\n  heimdall audit apify.com --max 20\n  heimdall live apify.com --offline\n  heimdall serve 8900\n`);
}

// 仅在直接执行时运行（被 import 时只导出命令表，便于单测）
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') { help(); process.exit(argv.length ? 0 : 1); }
  const cmd = resolveCommand(argv);
  if (!cmd) { console.error(`unknown command: ${argv[0]}\n`); help(); process.exit(2); }

  // 子进程 cwd 固定为 core（脚本内部靠相对路径找自己），同时把调用方 cwd 传下去，
  // 让 --out 这类用户路径相对“用户敲命令的目录”解析，而不是 core/。
  const child = spawn(process.execPath, [join(CORE, cmd.script), ...cmd.args], {
    cwd: CORE,
    stdio: 'inherit',
    env: { ...process.env, HEIMDALL_INVOKE_CWD: process.cwd() },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
  child.on('error', (e) => { console.error('[cli] failed to spawn:', e.message); process.exit(1); });
}
