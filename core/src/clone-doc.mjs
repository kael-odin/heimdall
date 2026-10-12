/**
 * clone-doc — 「这个克隆页真正的文档是哪个文件」
 *
 * 多视口克隆（`multi-snapshot` / `responsive-upgrade`）之后，`clone/` 下是
 * `index-375.html` / `index-768.html` / `index-1440.html` 三份真文档，
 * 而 `index.html` 只是一段 **372 字节的选择器**（一行 `location.replace`）。
 *
 * 浏览器打开没问题 —— 它会跳到对应视口那份。但任何**直接读文件**的下游都会读到那
 * 372 字节，parse5 于是看到一个空文档：DOM 分 0、数据分 0，总分从 A 级掉到 C 级。
 * 实测 apify.com/store 就这样被测成 41.8%（真值 97.4%），而页面上一切正常 ——
 * 一个只说谎不报错的读数。
 *
 * 所以"克隆文档 = 哪个文件"必须是一处shared 判断，不能各脚本各写一份 `index.html`。
 * 规则：**有 index-1440.html 就用它**（build_clone 只会把变体和选择器一起写出来，
 * 所以它的存在就等价于"桌面文档在这里"）；否则就是 index.html。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 桌面视口那份的固定文件名（与 crawler/build_clone.mjs 的产出约定一致） */
export const DESKTOP_VARIANT = 'index-1440.html';

const isFile = (p) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };

/** 克隆文档的文件路径（不做 IO 判断以外的假设） */
export function cloneDocFile(cloneDir, { variant = DESKTOP_VARIANT } = {}) {
  const v = join(cloneDir, variant);
  return isFile(v) ? v : join(cloneDir, 'index.html');
}

/**
 * 读克隆文档。
 * @returns {{ file: string, html: string, variant: boolean }}
 *   variant = 读的是多视口变体（而不是 index.html 那个选择器）
 */
export function readCloneDoc(cloneDir, opts) {
  const file = cloneDocFile(cloneDir, opts);
  return { file, html: readFileSync(file, 'utf8'), variant: file.endsWith(DESKTOP_VARIANT) };
}

/**
 * 克隆页的**可访问 URL**：引擎在线就走 `/static`（http），否则回退 `file://`。
 *
 * 为什么必须有这个判断而不能一律 file://：本地资产里若还留着 `crossorigin`
 * （构建已摘干净，但历史产物可能没有），file:// 下会以 CORS 模式取本地文件而全部失败，
 * 截图里是一排裂图。两条路的口径**只在构建正确时才相同**（见 dom-refs.mjs）。
 * 引擎在的时候没有理由不走近路。
 *
 * 这个判断以前只写在 pipeline.mjs 里，多视口升级那边要重算分数时又得抄一遍 ——
 * 抄出来的那份迟早会漂移成"两条路口径不一样但没人发现"。
 *
 * @returns {Promise<{url: string, via: 'engine'|'file'}>}
 */
export async function resolveCloneUrl(host, name, dir) {
  const self = process.env.HEIMDALL_SELF_URL ?? `http://127.0.0.1:${process.env.HEIMDALL_PORT ?? 8900}`;
  try {
    const r = await fetch(`${self}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return { url: `${self}/static/${host}/pages/${name}/clone/index.html`, via: 'engine' };
  } catch { /* 引擎没起：这不是错误，forge 本来就该能独立跑 */ }
  return { url: pathToFileURL(join(dir, 'clone', 'index.html')).href, via: 'file' };
}
