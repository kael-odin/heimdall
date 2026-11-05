/**
 * 安装状态与安全动作的共享实现。
 *
 * setup 和 doctor 都从这里判断“已就绪 / 需要安装”，避免两份逻辑对同一台机器
 * 给出不同结论。这里不静态导入 playwright 等第三方依赖，因为首次运行时
 * node_modules 可能还不存在。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { CORE_ROOT } from '../paths.mjs';

export const REPO_ROOT = resolve(CORE_ROOT, '..');
export const CONSOLE_ROOT = join(REPO_ROOT, 'console');
export const CONSOLE_DIST = join(CONSOLE_ROOT, 'dist');
export const MCP_ROOT = join(REPO_ROOT, 'packages', 'mcp');
export const MCP_SERVER = join(MCP_ROOT, 'bin', 'heimdall-mcp.mjs');
export const MCP_PLUGIN = join(REPO_ROOT, 'plugin', 'server', 'heimdall-mcp.mjs');

export const DEPENDENCY_ROOTS = Object.freeze([
  Object.freeze({ id: 'core', root: CORE_ROOT }),
  Object.freeze({ id: 'console', root: CONSOLE_ROOT }),
  Object.freeze({ id: 'mcp', root: MCP_ROOT }),
]);

export function nodeVersionSupported(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function packageNames(packageFile, read = readFileSync) {
  const pkg = JSON.parse(read(packageFile, 'utf8'));
  return [...new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])].sort();
}

function packagePath(root, name) {
  return join(root, 'node_modules', ...name.split('/'));
}

/** 直接依赖缺失检查；不把 node_modules 目录本身当成“已安装”。 */
export function inspectDependencies({
  roots = DEPENDENCY_ROOTS,
  exists = existsSync,
  read = readFileSync,
} = {}) {
  return roots.map(({ id, root }) => {
    let names;
    try { names = packageNames(join(root, 'package.json'), read); }
    catch (error) { return { id, root, ready: false, missing: ['package.json'], error: String(error.message ?? error) }; }
    const missing = names.filter(name => !exists(packagePath(root, name)));
    return { id, root, ready: missing.length === 0, missing, checked: names.length };
  });
}

export function dependencySummary(states) {
  const broken = states.filter(s => !s.ready);
  return broken.length
    ? broken.map(s => `${s.id} 缺 ${s.missing.length ? s.missing.slice(0, 4).join('、') : '依赖'}`).join('；')
    : `core / console / MCP 的 ${states.reduce((n, s) => n + s.checked, 0)} 个直接依赖都可解析`;
}

function newestMtime(paths, stat = statSync) {
  let newest = 0;
  const visit = path => {
    let info;
    try { info = stat(path); } catch { return; }
    if (info.isFile()) { newest = Math.max(newest, info.mtimeMs); return; }
    if (!info.isDirectory()) return;
    let names = [];
    try { names = readdirSync(path); } catch { return; }
    for (const name of names) visit(join(path, name));
  };
  for (const path of paths) visit(path);
  return newest;
}

/** 控制台产物是否存在且不比输入旧。 */
export function inspectConsole({
  root = CONSOLE_ROOT,
  dist = CONSOLE_DIST,
  exists = existsSync,
  stat = statSync,
} = {}) {
  const index = join(dist, 'index.html');
  const assets = join(dist, 'assets');
  if (!exists(index) || !exists(assets)) return { ready: false, reason: 'missing', index, dist };
  let builtAt = 0;
  try { builtAt = stat(index).mtimeMs; } catch { return { ready: false, reason: 'unreadable', index, dist }; }
  const newestSource = newestMtime([
    join(root, 'src'),
    join(root, 'index.html'),
    join(root, 'vite.config.js'),
    join(root, 'package.json'),
    join(root, 'pnpm-lock.yaml'),
  ], stat);
  return { ready: newestSource <= builtAt + 1000, reason: newestSource > builtAt + 1000 ? 'stale' : 'ready', index, dist, builtAt, newestSource };
}

/** MCP 源入口与插件单文件是否都在。 */
export function inspectMcp({
  server = MCP_SERVER,
  artifact = MCP_PLUGIN,
  exists = existsSync,
} = {}) {
  const missing = [];
  if (!exists(server)) missing.push(server);
  if (!exists(artifact)) missing.push(artifact);
  return { ready: missing.length === 0, missing, server, artifact };
}

/** 动态导入 playwright；依赖没装时返回可读错误而不是让整个 CLI 起不来。 */
export async function inspectChromium({
  loader = () => import('playwright'),
  exists = existsSync,
} = {}) {
  try {
    const { chromium } = await loader();
    const executable = chromium.executablePath();
    return { ready: !!executable && exists(executable), executable, reason: executable && exists(executable) ? 'ready' : 'missing' };
  } catch (error) {
    return { ready: false, executable: null, reason: 'dependency_missing', error: String(error?.message ?? error).slice(0, 240) };
  }
}

export function openExternal(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  let parsed;
  try { parsed = new URL(String(url)); }
  catch { throw new Error('openExternal requires an HTTP(S) URL'); }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('openExternal requires an HTTP(S) URL');
  const [command, args] = platform === 'win32'
    ? ['explorer.exe', [parsed.href]]
    : platform === 'darwin'
      ? ['open', [parsed.href]]
      : ['xdg-open', [parsed.href]];
  const child = spawnProcess(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on?.('error', () => {});
  child.unref?.();
  return { command, args };
}

export function processTail(result, limit = 320) {
  const text = String(result?.stderr || result?.stdout || result?.error?.message || '').replace(/\s+/g, ' ').trim();
  return text.slice(-limit);
}
