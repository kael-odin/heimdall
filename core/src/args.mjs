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

/**
 * CLI 参数读取 —— **唯一实现**。
 *
 * 此前 `argOf` / `getNum` / `has` 在 12 个脚本里各写了一遍，而且已经**分叉**：
 * 有的版本会把下一个参数当成值（`--api --token x` 得到值 `--token`），有的不会；
 * 有的支持 `--name=value`，有的不支持。同一个 "读一个 CLI 参数" 有五六种行为，
 * 迟早会在某个脚本里读出一个没人预料的值。这里取**最保守也最完整**的一版。
 *
 * 默认读 process.argv.slice(2)；传 argv 便于测试。
 */
export function makeArgs(argv = process.argv.slice(2)) {
  /** 取字符串参数：支持 `--name value` 与 `--name=value`；下一个参数以 `--` 开头时视为没给值 */
  const argOf = (name, def) => {
    const i = argv.indexOf('--' + name);
    if (i > -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
    const eq = argv.find(a => a.startsWith('--' + name + '='));
    return eq ? eq.slice(name.length + 3) : def;
  };
  const has = (name) => argv.includes('--' + name);
  /** 取数字参数；没给或给的不是数就用默认值 */
  const num = (name, def) => {
    const raw = argOf(name, undefined);
    if (raw === undefined) return def;
    const n = Number(raw);
    return Number.isFinite(n) ? n : def;
  };
  /** 非 `--` 开头的裸参数 */
  const positional = () => argv.filter(a => !a.startsWith('--'));
  return { argv, argOf, has, num, positional };
}
