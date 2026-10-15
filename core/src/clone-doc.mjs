/**
 * clone-doc — 「这个克隆页真正的文档是哪个文件」
 *
 * 多视口克隆（`multi-snapshot` / `responsive-upgrade`）之后，`clone/` 下有
 * 若干 `index-<width>.html` 真文档，而 `index.html` 是视口选择器。
 *
 * 浏览器会跳到对应视口那份。但任何**直接读文件**的下游都会读到选择器，
 * parse5 于是看到一个空文档：DOM 分 0、数据分 0，总分从 A 级掉到 C 级。
 * 实测 apify.com/store 就这样被测成 41.8%（真值 97.4%），而页面上一切正常 ——
 * 一个只说谎不报错的读数。
 *
 * 所以"克隆文档 = 哪个文件"必须是一处 shared 判断：优先桌面，其次可用的
 * 最宽变体，最后才是普通克隆的 index.html。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isStaticCloneChooserHtml } from './static-html-safety.mjs';

/** 桌面视口那份的固定文件名（与 crawler/build_clone.mjs 的产出约定一致） */
export const DESKTOP_VARIANT = 'index-1440.html';
export const CLONE_VARIANT_WIDTHS = [375, 768, 1440];

const isFile = (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };

export function availableCloneVariantWidths(cloneDir) {
  return CLONE_VARIANT_WIDTHS.filter(width => isFile(join(cloneDir, `index-${width}.html`)));
}

/** 克隆文档的文件路径（不做 IO 判断以外的假设） */
export function cloneDocFile(cloneDir, { variant = DESKTOP_VARIANT } = {}) {
  const entry = join(cloneDir, 'index.html');
  if (isFile(entry) && !isStaticCloneChooserHtml(readFileSync(entry, 'utf8'))) return entry;
  const v = join(cloneDir, variant);
  if (isFile(v)) return v;
  for (const width of [1440, 768, 375]) {
    const fallback = join(cloneDir, `index-${width}.html`);
    if (isFile(fallback)) return fallback;
  }
  return entry;
}

/**
 * 读克隆文档。
 * @returns {{ file: string, html: string, variant: boolean }}
 *   variant = 读的是多视口变体（而不是 index.html 那个选择器）
 */
export function readCloneDoc(cloneDir, opts) {
  const file = cloneDocFile(cloneDir, opts);
  return { file, html: readFileSync(file, 'utf8'), variant: /index-(?:375|768|1440)\.html$/.test(file) };
}

/** Pass the exact local document to shot_clone, which serves it over loopback HTTP. */
export async function resolveCloneUrl(host, name, dir) {
  return { url: pathToFileURL(join(dir, 'clone', 'index.html')).href, via: 'local' };
}
