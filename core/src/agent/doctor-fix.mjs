/**
 * agent/doctor-fix —— `heimdall doctor --fix` 的安全修复。
 *
 * 修复动作与 `heimdall setup --no-connect --no-open` 共用一条实现：
 * 只补缺的依赖 / Chromium，重建需要的产物，并复用或启动同数据根引擎。
 * Node、数据根、磁盘和客户端配置文件不会被擅自改动。
 */
import { DATA_ROOT } from '../paths.mjs';
import { executeSetup } from './commands/setup.mjs';

export async function applyFixes(checks) {
  const needsFix = checks.filter(check => check.status !== 'ok' && check.fix?.auto);
  if (!needsFix.length) return checks;

  const setup = await executeSetup(
    { noConnect: true, open: false },
    { log: () => {} },
  );
  if (!setup.ok) {
    const reason = setup.error?.message ?? 'setup 修复失败';
    return checks.map(check => check.fix?.auto && check.status !== 'ok'
      ? { ...check, detail: `${check.detail}；自动修复失败：${reason}` }
      : check);
  }

  // 依赖装好后再做一次真实检查，而不是根据安装命令退出码猜“应该好了”。
  const { runChecks } = await import('./registry/capabilities/doctor.mjs');
  const after = await runChecks(checks.map(check => check.id));
  return after.map(check => {
    const before = checks.find(item => item.id === check.id);
    if (before?.status !== 'ok' && check.status === 'ok' && before.fix?.auto) {
      return { ...check, detail: `${check.detail}（doctor --fix 完成）`, fix: undefined };
    }
    return check;
  });
}

export const FIXABLE = Object.freeze(['dependencies', 'chromium', 'console', 'mcp', 'engine']);
export const DATA_ROOT_USED = DATA_ROOT;
