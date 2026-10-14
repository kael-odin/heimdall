/**
 * SEO audit CLI 参数解析。
 *
 * 这个命令同时被人工调用、CI 和引擎任务调用。不要用
 * `argv.find(a => !a.startsWith('--'))` 猜目标：`audit --max 2`
 * 会把选项值 2 当成站点并发起错误的联网请求。
 */

export const AUDIT_USAGE = 'node src/seo/audit.mjs <url|host> [--max 25] [--threshold 70] [--baseline <file>] [--update-baseline] [--fail-on-regression] [--tolerance N] [--require-baseline]';

const VALUE_OPTIONS = new Set(['max', 'threshold', 'baseline', 'tolerance']);
const FLAG_OPTIONS = new Set(['update-baseline', 'fail-on-regression', 'require-baseline']);

function optionError(message) {
  throw new Error(`${message}\n用法: ${AUDIT_USAGE}`);
}

function parseNumber(name, raw, { integer = false, min = -Infinity } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)) || n < min) {
    optionError(`--${name} 必须是${integer ? '整数且' : ''}不小于 ${min} 的数字，收到: ${raw}`);
  }
  return n;
}

/** Parse and validate audit arguments without touching the network or filesystem. */
export function parseAuditArgs(argv = []) {
  const args = [...argv];
  const positionals = [];
  const values = new Map();
  const flags = new Set();

  for (let i = 0; i < args.length; i++) {
    const token = String(args[i] ?? '');
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const name = (eq < 0 ? token.slice(2) : token.slice(2, eq)).trim();
    const inline = eq < 0 ? undefined : token.slice(eq + 1);
    if (!VALUE_OPTIONS.has(name) && !FLAG_OPTIONS.has(name)) optionError(`未知选项: ${token}`);

    if (FLAG_OPTIONS.has(name)) {
      if (inline !== undefined) optionError(`布尔选项不接受值: ${token}`);
      flags.add(name);
      continue;
    }

    let value = inline;
    if (value === undefined) {
      const next = args[i + 1];
      if (next === undefined || String(next).startsWith('--')) optionError(`--${name} 缺少值`);
      value = String(next);
      i++;
    }
    if (!value.trim()) optionError(`--${name} 不能是空值`);
    if (values.has(name)) optionError(`--${name} 只能指定一次`);
    values.set(name, value);
  }

  if (positionals.length !== 1 || !positionals[0].trim()) {
    optionError(`必须提供且只能提供一个目标站点（实际 ${positionals.length} 个）`);
  }

  const max = values.has('max') ? parseNumber('max', values.get('max'), { integer: true, min: 1 }) : 25;
  const threshold = values.has('threshold') ? parseNumber('threshold', values.get('threshold'), { min: 0 }) : 0;
  const tolerance = values.has('tolerance') ? parseNumber('tolerance', values.get('tolerance'), { min: 0 }) : 0;

  return {
    target: positionals[0].trim(),
    max: Math.min(max, 200),
    threshold,
    tolerance,
    baseline: values.get('baseline') ?? null,
    updateBaseline: flags.has('update-baseline'),
    failOnRegression: flags.has('fail-on-regression'),
    requireBaseline: flags.has('require-baseline'),
  };
}
