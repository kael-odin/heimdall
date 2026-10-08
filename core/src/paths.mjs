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
