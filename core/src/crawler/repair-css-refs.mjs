#!/usr/bin/env node
/**
 * crawler/repair-css-refs — 修复历史 clone 的 CSS 相对路径基准错误
 *
 * 维护工具：只适用于旧版 clone 产物；新产物由 build_clone 写入正确路径。
 * 当前维护格式 v2：只改写 clone 根目录内的真实文件，并保留引用上的 query/hash。
 *
 * 背景：旧版 build_clone 把字体写成 url("styles/refNNN.woff2")，
 * 而 cssom.css 本身就在 styles/ 下 → 解析成 styles/styles/refNNN.woff2 → 字体 404。
 * 本工具按 CSS 文件自身目录重新解析 url()：若原样解析不存在、但按 clone 根解析存在，
 * 则改写为正确相对路径（幂等）。
 *
 * 用法:
 *   node src/crawler/repair-css-refs.mjs <siteId>                默认只预览
 *   node src/crawler/repair-css-refs.mjs <siteId> --apply        自动备份后修复
 *   node src/crawler/repair-css-refs.mjs <siteId> --apply --backup-dir <dir>
 */
import { readdirSync, readFileSync, existsSync, lstatSync, realpathSync, mkdirSync, copyFileSync, constants } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE, DATA_ROOT, isInside } from '../paths.mjs';
import { writeFileAtomic } from '../fsutil.mjs';
import { assertPageName } from '../page-name.mjs';

export const REPAIR_CSS_REFS_VERSION = 2;
const USAGE = 'node src/crawler/repair-css-refs.mjs <siteId> [--apply] [--backup-dir <dir>]';
const SITE_ID_RE = /^(?!\.\.?$)[a-z0-9][a-z0-9.-]*(?:--origin-[0-9a-f]{16})?$/i;

function fail(message, code = 2) {
  console.error(message + `\n用法: ${USAGE}`);
  process.exit(code);
}

function parseArgs(argv = process.argv.slice(2)) {
  const positional = argv.filter(arg => !arg.startsWith('--'));
  const host = positional[0];
  if (!host) fail('缺少站点 ID');
  if (!SITE_ID_RE.test(host) || basename(host) !== host || host.includes(sep)) fail(`站点 ID 不安全：${host}`);
  const dryRun = !argv.includes('--apply');
  const backupIndex = argv.findIndex(arg => arg === '--backup-dir');
  const backupEq = argv.find(arg => arg.startsWith('--backup-dir='));
  let backupDir = null;
  if (backupIndex > -1) {
    const value = argv[backupIndex + 1];
    if (!value || value.startsWith('--')) fail('--backup-dir 缺少目录');
    backupDir = resolve(process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), value);
  } else if (backupEq) {
    const value = backupEq.slice('--backup-dir='.length);
    if (!value) fail('--backup-dir 缺少目录');
    backupDir = resolve(process.env.HEIMDALL_INVOKE_CWD ?? process.cwd(), value);
  } else if (!dryRun) {
    backupDir = join(DATA_ROOT, '_maintenance', `repair-css-refs-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  }
  if (!dryRun && isWorkspaceBackupPath(backupDir)) fail('备份目录不能在 workspace 内');
  return { host, dryRun, backupDir };
}

function physicalPath(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

function isWorkspaceBackupPath(path) {
  const workspace = physicalPath(WORKSPACE);
  const candidate = physicalPath(path);
  return !relative(workspace, candidate) || isInside(workspace, candidate);
}

const splitSuffix = (raw) => {
  const match = String(raw).match(/^([^?#]*)([?#].*)?$/);
  return { path: match?.[1] ?? String(raw), suffix: match?.[2] ?? '' };
};
const isExternal = (u) => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(u);

function isRegularFileInside(root, file) {
  if (!isInside(root, file)) return false;
  try {
    const rootStat = lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    const lstat = lstatSync(file);
    return lstat.isFile() && !lstat.isSymbolicLink()
      && isInside(realpathSync(root), realpathSync(file));
  } catch { return false; }
}

function makeBackup(file, base, backupDir) {
  const rel = relative(base, file);
  if (!rel || rel.startsWith('..') || resolve(base, rel) !== resolve(file)) throw new Error('backup path escaped site');
  const dest = join(backupDir, rel);
  if (isWorkspaceBackupPath(dirname(dest))) throw new Error('backup path entered workspace');
  mkdirSync(dirname(dest), { recursive: true });
  if (isWorkspaceBackupPath(dirname(dest))) throw new Error('backup path entered workspace');
  copyFileSync(file, dest, constants.COPYFILE_EXCL);
  return dest;
}

/** Repair one CSS file; exported for focused tests and offline maintenance tooling. */
export function repairCssFile(file, { dryRun = false, backupDir = null, base = dirname(dirname(file)) } = {}) {
  const dir = dirname(file);
  const cloneRoot = dirname(dir);
  if (!isRegularFileInside(cloneRoot, file)) return { fixed: 0, changed: false };
  let text = readFileSync(file, 'utf8');
  let fixed = 0;
  const fixUrl = (raw) => {
    if (!raw || isExternal(raw) || raw.startsWith('/')) return null;
    const { path: rawPath, suffix } = splitSuffix(raw.trim());
    if (!rawPath || rawPath.startsWith('/')) return null;
    const asIs = resolve(dir, rawPath);
    if (isRegularFileInside(cloneRoot, asIs)) return null;
    const alt = resolve(cloneRoot, rawPath);
    if (!isRegularFileInside(cloneRoot, alt)) return null;
    const rel = relative(dir, alt).split('\\').join('/');
    fixed++;
    return rel + suffix;
  };
  text = text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, raw) => {
    const rel = fixUrl(raw.trim());
    return rel ? `url(${q}${rel}${q})` : m;
  });
  text = text.replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, raw) => {
    const rel = fixUrl(raw.trim());
    return rel ? `@import ${q}${rel}${q}` : m;
  });
  if (!fixed || dryRun) return { fixed, changed: !!fixed };
  let backup;
  if (backupDir) backup = makeBackup(file, base, backupDir);
  writeFileAtomic(file, text);
  return { fixed, changed: true, backup };
}

export function planCssRefRepair({ workspace = WORKSPACE, host } = {}) {
  if (!host || !SITE_ID_RE.test(host) || basename(host) !== host) throw new Error(`站点 ID 不安全：${host ?? ''}`);
  const base = resolve(workspace, host);
  if (!isInside(workspace, base)) throw new Error(`站点目录越界：${host}`);
  const pagesDir = join(base, 'pages');
  for (const directory of [base, pagesDir]) {
    if (!existsSync(directory)) continue;
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`站点路径不是普通目录：${directory}`);
  }
  const files = [];
  const skipped = [];
  for (const entry of existsSync(pagesDir) ? readdirSync(pagesDir, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let name;
    try { name = assertPageName(entry.name); } catch { skipped.push({ name: entry.name, reason: 'unsafe-page-name' }); continue; }
    const cloneDir = join(pagesDir, name, 'clone');
    const styleDir = join(cloneDir, 'styles');
    if (!existsSync(styleDir)) continue;
    let cloneStat, styleStat;
    try { cloneStat = lstatSync(cloneDir); styleStat = lstatSync(styleDir); }
    catch { skipped.push({ name, reason: 'unreadable-style-dir' }); continue; }
    if (!cloneStat.isDirectory() || cloneStat.isSymbolicLink() || !styleStat.isDirectory() || styleStat.isSymbolicLink()) {
      skipped.push({ name, reason: 'unsafe-style-dir' }); continue;
    }
    for (const file of readdirSync(styleDir, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink() || !/\.css$/i.test(file.name)) continue;
      files.push({ page: name, file: join(styleDir, file.name), base });
    }
  }
  return { base, pagesDir, files, skipped };
}

async function main(argv = process.argv.slice(2)) {
  const { host, dryRun, backupDir } = parseArgs(argv);
  let plan;
  try { plan = planCssRefRepair({ workspace: WORKSPACE, host }); }
  catch (error) { fail(error.message, 1); }
  const pages = new Set();
  let files = 0, fixes = 0, errors = 0;
  for (const item of plan.files) {
    try {
      const result = repairCssFile(item.file, { dryRun, backupDir, base: plan.base });
      files++;
      if (result.fixed) {
        pages.add(item.page);
        fixes += result.fixed;
        console.log(`  ${dryRun ? 'would-fix' : 'fix'} ${item.page}/styles/${basename(item.file)} ${result.fixed}`);
      }
    } catch (error) {
      errors++;
      console.error(`  error ${item.page}/styles/${basename(item.file)}: ${String(error.message ?? error)}`);
    }
  }
  for (const item of plan.skipped) console.log(`  - skip ${item.name}: ${item.reason}`);
  if (backupDir && !dryRun && fixes) console.log(`  backups: ${backupDir}`);
  console.log(`[repair-css-refs v${REPAIR_CSS_REFS_VERSION}] host=${host} pages=${pages.size} files=${files} fixes=${fixes}${dryRun ? ' (dry-run)' : ''}${errors ? ` errors=${errors}` : ''}`);
  return errors ? 1 : 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === resolve(fileURLToPath(import.meta.url))) process.exitCode = await main();
