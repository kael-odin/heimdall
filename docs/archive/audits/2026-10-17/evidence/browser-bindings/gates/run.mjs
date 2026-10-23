import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const directory = fileURLToPath(new URL('.', import.meta.url));
const sourcePaths = ['core/src/acceptance/catalog.mjs', 'core/src/acceptance/catalog-schema.mjs',
  'core/src/acceptance/browser-candidate-projection.mjs', 'core/src/acceptance/browser-candidate-identity.mjs',
  'core/test/acceptance-browser-source-binding-schema.test.mjs', 'core/test/acceptance-browser-source-binding.test.mjs',
  'core/test/acceptance-catalog-schema-v3.test.mjs', 'core/scripts/smoke-acceptance-browser-bindings.mjs',
  'core/package.json', 'package.json', '.github/workflows/ci.yml'];
const snapshot = () => sourcePaths.map(path => { const bytes = readFileSync(path); return { path, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') }; });
const before = snapshot();
writeFileSync(join(directory, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
const stages = [
  ['01-lint', 'pnpm -C core lint'],
  ['02-console-build', 'pnpm -C console build'],
  ['03-core-test', 'pnpm -C core test'],
  ['04-core-smoke', 'pnpm -C core smoke'],
  ['05-catalog-browser', 'pnpm acceptance:catalog:smoke'],
  ['06-migration-browser', 'pnpm acceptance:catalog:migration:smoke'],
  ['07-baseline-browser', 'pnpm acceptance:baseline:smoke'],
  ['08-managed-prepare', 'pnpm acceptance:managed:prepare:smoke'],
  ['09-execution-ui', 'pnpm acceptance:execution:ui:smoke'],
  ['10-cdp-clone', 'node core/scripts/smoke-console-cdp.mjs core/workspace/_runs/browser-bindings-final-gates-20261017/cdp-clone'],
];
for (const [stage, command] of stages) {
  const stdout = openSync(join(directory, stage + '.stdout.log'), 'wx');
  const stderr = openSync(join(directory, stage + '.stderr.log'), 'wx');
  const startedAt = new Date().toISOString(), started = Date.now();
  const env = { ...process.env, ...(stage === '10-cdp-clone' ? { HEIMDALL_E2E_CDP_SELF: '1' } : {}) };
  writeFileSync(join(directory, stage + '.command.json'), JSON.stringify({ stage, command, startedAt,
    cwd: process.cwd(), environmentOverrides: stage === '10-cdp-clone' ? { HEIMDALL_E2E_CDP_SELF: '1' } : {} }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ event: 'started', stage, command, startedAt }));
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', stdout, stderr], env });
  const result = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: 1, signal: null, error: String(error) }));
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  closeSync(stdout); closeSync(stderr);
  const record = { stage, command, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started, ...result };
  writeFileSync(join(directory, stage + '.exitcode.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ event: 'completed', ...record }));
  if (result.exitCode !== 0) { process.exitCode = result.exitCode ?? 1; break; }
}
const after = snapshot();
writeFileSync(join(directory, 'source-after.json'), JSON.stringify(after, null, 2) + '\n', { flag: 'wx' });
if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Frozen implementation changed during final gates.');
