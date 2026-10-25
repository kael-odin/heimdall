/**
 * agent/doctor-fix —— doctor 的安全修复（E11-01：`heimdall doctor --fix`）
 *
 * 只做两类不会改变用户环境语义的事：
 *   · Chromium 没装：`pnpm exec playwright install chromium`（装到 Playwright 的缓存目录）
 *   · 引擎没在跑：后台起一台（空闲自退，见 engine-client 的 detached 模式）
 * 其余检查（Node、pnpm、数据根、磁盘）只给命令，不动手。修复后重跑检查，如实写进 detail。
 */
import { spawnSync } from 'node:child_process';
import { CORE_ROOT, DATA_ROOT } from '../paths.mjs';
import { connectEngine } from './engine-client.mjs';

export async function applyFixes(checks) {
  const out = [];
  for (const c of checks) {
    if (c.status === 'ok') { out.push(c); continue; }
    if (c.id === 'chromium' && c.fix?.auto) {
      const r = process.platform === 'win32'
        ? spawnSync('pnpm exec playwright install chromium', { cwd: CORE_ROOT, encoding: 'utf8', shell: true, windowsHide: true, timeout: 600_000 })
        : spawnSync('pnpm', ['exec', 'playwright', 'install', 'chromium'], { cwd: CORE_ROOT, encoding: 'utf8', timeout: 600_000 });
      if (r.status === 0) out.push({ ...c, status: 'ok', detail: 'Chromium 已安装（doctor --fix 完成）', fix: undefined });
      else out.push({ ...c, detail: `${c.detail}；自动安装失败：${String(r.stderr || r.stdout || '').split('\n').slice(-3).join(' ').slice(0, 200)}` });
      continue;
    }
    if (c.id === 'engine' && c.fix?.auto) {
      try {
        const e = await connectEngine({ start: true, detached: true, idleExitMs: 30 * 60_000 });
        out.push({ ...c, status: 'ok', detail: `引擎已启动：${e.base}（空闲 30 分钟后自退）`, fix: undefined });
      } catch (error) {
        out.push({ ...c, detail: `${c.detail}；自动启动失败：${String(error.message ?? error).slice(0, 200)}` });
      }
      continue;
    }
    out.push(c);
  }
  return out;
}

export const FIXABLE = Object.freeze(['chromium', 'engine']);
export const DATA_ROOT_USED = DATA_ROOT;
