/**
 * args — CLI 参数校验（拒绝"猜默认站点"）
 *
 * 背景（2026-10-09）：此前 14 个脚本把默认值写死成 apify.com / thordata.com，
 * 用户漏填参数时会**静默地作用在错误的站点上**。现在缺参数一律给用法并退出，
 * 绝不猜。默认值仅在显式声明为"确实合理"时才保留（如引擎端口 8900）。
 */

/** 缺参数 → 打印用法退出（stderr + 退出码 1，让调用方能区分"用户错误"） */
export function requireArg(value, usage, what = '参数') {
  const v = typeof value === 'string' ? value.trim() : value;
  if (v === undefined || v === null || v === '') {
    console.error(`缺少${what}\n用法: ${usage}`);
    process.exit(1);
  }
  return v;
}

/** 归一化站点入参：允许传 host 或完整 URL，统一得到 host（去 www）与 origin */
export function parseTarget(input, usage) {
  const raw = requireArg(input, usage, '目标站点');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let u;
  try { u = new URL(withScheme); }
  catch { console.error(`无法解析目标: ${raw}\n用法: ${usage}`); process.exit(1); }
  return { origin: u.origin, host: u.hostname.replace(/^www\./, '') };
}
