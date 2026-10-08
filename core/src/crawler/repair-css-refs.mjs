#!/usr/bin/env node
/**
 * crawler/repair-css-refs — 修复历史 clone 的 CSS 相对路径基准错误
 *
 * 背景：旧版 build_clone 把字体写成 url("styles/refNNN.woff2")，
 * 而 cssom.css 本身就在 styles/ 下 → 解析成 styles/styles/refNNN.woff2 → 字体 404。
 * 本工具按 CSS 文件自身目录重新解析 url()：若原样解析不存在、但按 clone 根解析存在，
 * 则改写为正确相对路径（幂等）。
 *
 * 用法: node src/crawler/repair-css-refs.mjs <host> [--dry-run]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

const argv = process.argv.slice(2);
const host = argv.find(a => !a.startsWith('--'));
const DRY = argv.includes('--dry-run');
if (!host) { console.error('usage: node src/crawler/repair-css-refs.mjs <host> [--dry-run]'); process.exit(2); }

const PAGES = join(WORKSPACE, host, 'pages');
if (!existsSync(PAGES)) { console.error('no pages for host:', host); process.exit(1); }

const stripQ = (u) => String(u).split('#')[0].split('?')[0];
const isExternal = (u) => /^(?:data:|blob:|https?:|\/\/|#)/i.test(u);

function repairFile(file) {
  const dir = dirname(file);
  const cloneRoot = dirname(dir);
  let text = readFileSync(file, 'utf8');
  let fixed = 0;
  const fixUrl = (raw) => {
    if (!raw || isExternal(raw) || raw.startsWith('/')) return null;
    const asIs = resolve(dir, stripQ(raw));
    if (existsSync(asIs)) return null;
    const alt = resolve(cloneRoot, stripQ(raw));
    if (!existsSync(alt)) return null;
    const rel = relative(dir, alt).split('\\').join('/');
    fixed++;
    return rel;
  };
  text = text.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (m, q, raw) => {
    const rel = fixUrl(raw.trim());
    return rel ? `url(${q}${rel}${q})` : m;
  });
  text = text.replace(/@import\s+(["'])([^"']+)\1/gi, (m, q, raw) => {
    const rel = fixUrl(raw.trim());
    return rel ? `@import ${q}${rel}${q}` : m;
  });
  if (fixed && !DRY) writeFileSync(file, text);
  return fixed;
}

let pages = 0, files = 0, fixes = 0;
for (const name of readdirSync(PAGES).sort()) {
  const styleDir = join(PAGES, name, 'clone', 'styles');
  if (!existsSync(styleDir) || !statSync(styleDir).isDirectory()) continue;
  pages++;
  for (const f of readdirSync(styleDir)) {
    if (!/\.css$/i.test(f)) continue;
    files++;
    const n = repairFile(join(styleDir, f));
    if (n) console.log('  fix', name + '/styles/' + f, n);
    fixes += n;
  }
}
console.log(`[repair-css-refs] host=${host} pages=${pages} files=${files} fixes=${fixes}${DRY ? ' (dry-run)' : ''}`);
