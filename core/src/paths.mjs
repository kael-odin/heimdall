import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * paths — 统一数据目录解析（所有产物路径的唯一来源）
 *
 * HEIMDALL_DATA_DIR 未设置时默认 core/（保持历史行为）；
 * 设置后 workspace/ 与 deliverable/ 都迁到该目录，便于：
 *   - 把 1.4GB 产物移出仓库
 *   - smoke/E2E 测试使用临时目录，不污染真实产物
 */
export const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_ROOT = resolve(process.env.HEIMDALL_DATA_DIR ?? CORE_ROOT);
export const WORKSPACE = join(DATA_ROOT, 'workspace');
export const DELIVERABLE = join(DATA_ROOT, 'deliverable');

/**
 * 产物目录名用的日期戳（YYYY-MM-DD，**本地时区**）。
 *
 * 不要用 `new Date().toISOString().slice(0,10)` —— 那是 UTC。
 * 在 UTC+8，每天 0:00–8:00 生成的包会带上**前一天**的日期：
 * 10-11 凌晨跑出来的包叫 `xxx-2026-10-10`，看起来像昨天做的，
 * 而交付包保留策略是按名字里的日期排序的 —— 日期错了排序就会错。
 *
 * 这些日期是给人看的、也是给保留策略排序用的，就该用本地日历。
 */
export function localDateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
