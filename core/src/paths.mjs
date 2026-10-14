import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
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

/**
 * 是否在某个根目录之内。**必须用 `relative` 判，不能用字符串前缀** ——
 * `'D:\\data' + '\\..\\..\\Windows'` 也是以 `'D:\\data'` 开头的，
 * 于是"前缀检查"会被 `..` 绕过成任意路径（`/api/reveal` 曾经就是这么写的）。
 */
export function isInside(root, file) {
  const rel = relative(resolve(root), resolve(file));
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * 静态服务**永不外发**的文件名。
 *
 *   · `session.json` —— 登录凭据（Playwright storageState，等同账号）
 *   · `network.har`  —— 未脱敏的原始抓包，带 cookie 与 authorization 头
 *     （交付包里的 HAR 是清洗过的，工作区里这份不是）
 *   · `operation-plan.json` —— 本地交互脚本，可包含输入值和内部选择器
 *   · 上述文件的备份/编辑器临时副本，可能保留同样内容
 *
 * `/static/**` 与 workspace 兜底都是"把目录原样发出去"的通道，
 * 只凭"在 workspace 内"这一条拦不住它们。
 */
export function isSecretFile(file) {
  return /(^|[/\\])\.?(session\.json|network\.har|operation-plan\.json)(?:$|[.~])/i.test(String(file));
}
