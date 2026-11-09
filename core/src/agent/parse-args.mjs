/**
 * CLI 参数解析的零依赖实现。
 *
 * setup / connect 必须能在 node_modules 尚未安装时运行，因此这里不能依赖
 * 能力注册表或任何第三方包。
 */
const BOOL_FLAGS = new Set([
  'json', 'wait', 'no-wait', 'quiet', 'yes', 'refresh', 'force', 'fix', 'remove', 'dry-run', 'help',
  'all-discovered', 'recon-only', 'legacy', 'inline', 'no-revert', 'no-mirror', 'pattern', 'no-links',
  'texts', 'explore', 'no-baseline', 'no-detect', 'accept', 'github', 'no-github', 'off', 'no-open',
  'no-connect', 'force-install', 'allow-insecure-http',
]);

/** 解析 argv：--flag value / --flag=value / 布尔标志；其余是位置参数。 */
export function parseArgs(argv) {
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (inline !== undefined) flags[k] = inline;
      else if (BOOL_FLAGS.has(k) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) flags[k] = true;
      else flags[k] = argv[++i];
    } else positional.push(a);
  }
  return { flags, positional };
}
