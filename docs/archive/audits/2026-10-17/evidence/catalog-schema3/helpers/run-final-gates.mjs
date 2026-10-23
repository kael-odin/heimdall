import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const runner = fileURLToPath(new URL('./run-stage.mjs', import.meta.url));
const stages = [
  ['03-final-lint', 'pnpm -C core lint'],
  ['04-console-build', 'pnpm -C console build'],
  ['05-core-test', 'pnpm -C core test'],
  ['06-core-smoke', 'pnpm -C core smoke'],
  ['07-catalog-browser', 'pnpm acceptance:catalog:smoke'],
  ['08-baseline-browser', 'pnpm acceptance:baseline:smoke'],
  ['09-managed-prepare', 'pnpm acceptance:managed:prepare:smoke'],
  ['10-execution-ui', 'pnpm acceptance:execution:ui:smoke'],
  ['11-cdp-clone', 'node core/scripts/smoke-console-cdp.mjs core/workspace/_runs/schema3-gates-20261017/cdp-clone'],
];
for (const [stage, command] of stages) {
  const child = spawn(process.execPath, [runner, stage, command], { cwd: process.cwd(), windowsHide: true, stdio: 'inherit',
    env: { ...process.env, ...(stage === '11-cdp-clone' ? { HEIMDALL_E2E_CDP_SELF: '1' } : {}) } });
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: 1, error: String(error) }));
    child.once('exit', exitCode => resolve({ exitCode }));
  });
  if (result.exitCode !== 0) { process.exitCode = result.exitCode ?? 1; break; }
}
