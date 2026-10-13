/**
 * fsutil — 两个被复制了十几遍的小工具，收成一份。
 *
 * `readJson`：此前在 5 个脚本里各写了一遍（site-profile / xlsx / deliver /
 *   linker / index-page），字面完全相同。"读不到就当没有"这个约定必须一致 ——
 *   有一处忘了 try/catch，整个脚本就会因为一个可选产物缺失而崩。
 *
 * `mb`：此前 5 处，且已经**开始分叉**（`n/1048576` 与 `n/1024/1024` —— 数学上
 *   相同，但"同一个读数有两种写法"本身就是下一个不一致的种子）。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

/** 读 JSON：读不到 / 解析失败一律返回 null（调用方按"没有"处理，不抛） */
export const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** 字节 → "12.3MB" */
export const mb = (n) => (n / 1048576).toFixed(1) + 'MB';

/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 为什么不直接 `writeFileSync`：**rename 换的是目录项，会切断硬链接**。
 * 而 dedupe 会把内容相同的文件硬链接到一起 —— 包括捕获输入与构建产物之间
 * （实测 linear.app：`pages/home/cssom.css` 与 `clone/styles/cssom.css` 成了同一个 inode）。
 * 那种情况下 `writeFileSync` 等于**写到自己的输入上**：源文件被构建后的内容覆盖，
 * 下一次重建读到的就是被污染的输入，报出一串莫须有的缺口
 * （`https://linear.app/ref001.woff2` soft-404），而且全程没有任何提示。
 *
 * 凡是"某个步骤会重复改写"的文件（clone 里的 CSS / HTML / 清单），都该走这里。
 */
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
