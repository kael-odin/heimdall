/**
 * deliver/replace-domain — 把镜像里写死的原站域名换成用户自己的域名
 *
 * 场景：用户把镜像当竞品站的起点，第一件事就是让 canonical / og:url / 绝对资源链接
 * 指向自己的域名。手工改几十个 HTML 不现实。
 *
 * **安全设计（三条，缺一不可）**：
 *   1. 默认是**预览**，不写任何文件。要看改了哪几处，就只给读数。
 *   2. 真改必须显式 `--apply`，且改之前把每个将被改动的文件**原样备份**到
 *      `workspace/<host>/deliver/_domain-replace-backup-<stamp>/`，附一份还原说明。
 *   3. 只动**渲染相关的文本**（默认 .html/.css；.js 需显式 `--js`）。
 *      **绝不碰 json** —— asset-map / ref-index / manifest 里的域名是"来源记录"，
 *      改了它们会让资源查找表失效，而且这些文件本来也不参与渲染。
 *
 * 用法:
 *   node src/deliver/replace-domain.mjs <host> --from angular.dev --to mysite.com            # 预览
 *   node src/deliver/replace-domain.mjs <host> --from angular.dev --to mysite.com --apply    # 真改
 *   node src/deliver/replace-domain.mjs <host> --from angular.dev --to mysite.com --apply --js
 */
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, extname, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE } from '../paths.mjs';
import { regexEscape } from '../html.mjs';
import { emit } from '../emit.mjs';

const MAX_SCAN_BYTES = 8 * 1024 * 1024;
/** 默认改哪些：只改会参与渲染的文本。json 一律排除（见文件头第 3 条）。 */
export const DEFAULT_EXT = new Set(['.html', '.htm', '.css']);
export const JS_EXT = new Set([...DEFAULT_EXT, '.js', '.mjs']);

/**
 * 主机名边界匹配器：`angular.dev` 会命中 `angular.dev` 与 `cdn.angular.dev`，
 * 但不会命中 `angular.development`（后面还跟着字母）或 `xangular.dev`。
 * 抽出来是为了**可测** —— 这条边界规则弄错一个字符，替换就会误伤别的字符串。
 */
export function domainMatcher(from) {
  const from$ = regexEscape(from);
  return new RegExp(`(?<![a-z0-9-])${from$}(?![a-z0-9-])`, 'gi');
}

/** 扫出会被改动的文件与命中的主机名（含子域）。纯读，不写盘。 */
export function planReplace({ base, from, extSet = DEFAULT_EXT }) {
  const re = domainMatcher(from);
  const pagesDir = join(base, 'pages');
  // 候选主机名先全取出来，再按"等于 from 或以 .from 结尾"过滤。
  // 直接用 `[a-z0-9.-]*from` 那套写法会误收 `xexample.test`（它只是**结尾长得像**，
  // 并不是子域）—— 替换本身不受影响（那边有边界守卫），但预览会报出不存在的主机名。
  const hostRe = /(?<![a-z0-9-])[a-z0-9-]+(?:\.[a-z0-9-]+)+(?![a-z0-9-])/gi;
  const fromLc = String(from).toLowerCase();
  const targets = [];
  const subdomains = new Map();
  if (!existsSync(pagesDir)) return { targets, subdomains, re };

  for (const page of readdirSync(pagesDir)) {
    const root = join(pagesDir, page, 'clone');
    if (!existsSync(root)) continue;
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        let st; try { st = statSync(f); } catch { continue; }
        if (st.isDirectory()) { walk(f); continue; }
        if (!st.isFile() || st.size > MAX_SCAN_BYTES || !extSet.has(extname(name).toLowerCase())) continue;
        let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
        const hits = text.match(re);
        if (!hits) continue;
        targets.push({ file: f, rel: relative(base, f).split('\\').join('/'), count: hits.length });
        for (const m of text.matchAll(hostRe)) {
          const h = m[0].toLowerCase();
          if (h === fromLc || h.endsWith('.' + fromLc)) subdomains.set(h, (subdomains.get(h) ?? 0) + 1);
        }
      }
    };
    walk(root);
  }
  return { targets, subdomains, re };
}

/** 按计划执行替换；apply=false 时只汇总不写盘。返回 summary。 */
export function runReplace({ host, from, to, apply = false, js = false, base = join(WORKSPACE, host) }) {
  const extSet = js ? JS_EXT : DEFAULT_EXT;
  const { targets, subdomains, re } = planReplace({ base, from, extSet });
  const total = targets.reduce((n, t) => n + t.count, 0);
  const summary = {
    host, from, to, apply: !!apply,
    files: targets.length,
    occurrences: total,
    subdomains: [...subdomains.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    targets: [...targets].sort((a, b) => b.count - a.count).map(t => ({ path: t.rel, count: t.count })),
    changed: 0,
    mode: apply ? 'apply' : 'preview',
  };
  if (!apply || !total) return summary;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(base, 'deliver', `_domain-replace-backup-${stamp}`);
  for (const t of targets) {
    const text = readFileSync(t.file, 'utf8');
    const next = text.replace(re, to);
    if (next === text) continue;
    const bak = join(backupDir, t.rel);
    mkdirSync(dirname(bak), { recursive: true });
    try { copyFileSync(t.file, bak); } catch { continue; }   // 备份失败就不动这个文件
    writeFileSync(t.file, next);
    summary.changed++;
  }
  if (summary.changed) {
    writeFileSync(join(backupDir, 'README.txt'),
      `这些是 replace-domain 在 ${stamp} 执行前的原始文件。\n`
      + `替换：${from} → ${to}\n`
      + `还原：按相同相对路径把这些文件复制回 workspace/${host}/pages/**/clone/ 覆盖即可。\n`);
    summary.backup = relative(base, backupDir).split('\\').join('/');   // 相对**站点根**，调用方给什么 base 就相对什么（别用模块级 WORKSPACE）
  }
  return summary;
}

// ---------- CLI ----------
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const host = argv.find(a => !a.startsWith('--'));
  const argOf = (name) => { const i = argv.indexOf('--' + name); return i > -1 ? argv[i + 1] : null; };
  const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const FROM = norm(argOf('from'));
  const TO = norm(argOf('to'));
  const APPLY = argv.includes('--apply');
  const WITH_JS = argv.includes('--js');

  if (!host || !FROM || !TO) {
    console.error('用法: node src/deliver/replace-domain.mjs <host> --from <旧域名> --to <新域名> [--apply] [--js]');
    process.exit(2);
  }
  if (!/^[a-z0-9.-]+$/.test(FROM) || !/^[a-z0-9.-]+$/.test(TO)) { console.error('域名格式不对'); process.exit(2); }
  if (FROM === TO) { console.error('旧域名与新域名相同，无需替换'); process.exit(2); }
  if (!existsSync(join(WORKSPACE, host, 'pages'))) { console.error('没有这个站点的产物:', host); process.exit(1); }

  const s = runReplace({ host, from: FROM, to: TO, apply: APPLY, js: WITH_JS });
  if (!s.occurrences) {
    console.log(`没有找到 ${FROM}（扫描范围：.html .htm .css${WITH_JS ? ' .js .mjs' : ''}）`);
  } else if (!APPLY) {
    console.log(`[预览] ${FROM} → ${TO}：命中 ${s.files} 个文件 / ${s.occurrences} 处`);
    for (const x of s.subdomains) console.log(`  主机名 ${x.name} × ${x.count}`);
    for (const t of s.targets.slice(0, 20)) console.log(`  ${String(t.count).padStart(4)}  ${t.path}`);
    if (s.targets.length > 20) console.log(`  …另有 ${s.targets.length - 20} 个文件`);
    console.log('（预览不会写任何文件；确认无误后加 --apply）');
  } else {
    console.log(`[已替换] ${FROM} → ${TO}：改动 ${s.changed} 个文件${s.backup ? `（备份 → workspace/${host}/${s.backup}）` : ''}`);
  }
  emit({ kind: 'replace-domain', ...s });
}
