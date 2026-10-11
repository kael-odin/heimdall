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
import { readFileSync } from 'node:fs';

/** 读 JSON：读不到 / 解析失败一律返回 null（调用方按"没有"处理，不抛） */
export const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** 字节 → "12.3MB" */
export const mb = (n) => (n / 1048576).toFixed(1) + 'MB';
