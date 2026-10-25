#!/usr/bin/env node
/**
 * heimdall —— 命令行入口（仓库内的薄包装）
 *
 * 真正的实现在 core/src/cli.mjs；这里只负责从仓库根找到它并原样转发（参数、退出码、stdio）。
 * 发布到 npm 或 `pnpm link --global` 之后，用户可以直接敲 `heimdall <命令>`；技能里的
 * `Bash(heimdall *)` 白名单因此可以覆盖全部代理命令（E3-09 的薄版；完整安装体验在 Ph2 的 setup）。
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'core', 'src', 'cli.mjs');
const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: { ...process.env, HEIMDALL_INVOKE_CWD: process.cwd() },
});
child.on('exit', (code) => process.exit(code ?? 1));
child.on('error', (e) => { process.stderr.write(`[heimdall] ${e.message}\n`); process.exit(1); });
