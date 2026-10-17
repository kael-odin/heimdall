import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const directory = fileURLToPath(new URL('.', import.meta.url));
const sourcePaths = ['core/src/acceptance/catalog-api.mjs', 'core/src/acceptance/browser-binding-view.mjs',
  'console/src/AcceptanceCatalog.vue', 'console/src/AcceptanceBrowserBindings.vue', 'console/src/acceptance-browser-bindings.js',
  'core/test/acceptance-browser-binding-api.test.mjs', 'core/test/acceptance-browser-binding-view.test.mjs',
  'core/test/console-acceptance-browser-bindings.test.mjs', 'core/scripts/smoke-acceptance-browser-bindings-console.mjs',
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
  ['06-baseline-browser', 'pnpm acceptance:baseline:smoke'],
  ['07-managed-prepare', 'pnpm acceptance:managed:prepare:smoke'],
  ['08-execution-ui', 'pnpm acceptance:execution:ui:smoke'],
  ['09-cdp-clone', 'node core/scripts/smoke-console-cdp.mjs core/workspace/_runs/browser-bindings-console-gates-20261017/cdp-clone'],
];
for (const [stage, command] of stages) {
  const stdout = openSync(join(directory, stage + '.stdout.log'), 'wx');
  const stderr = openSync(join(directory, stage + '.stderr.log'), 'wx');
  const startedAt = new Date().toISOString(), started = Date.now();
  const overrides = stage === '09-cdp-clone' ? { HEIMDALL_E2E_CDP_SELF: '1' } : {};
  writeFileSync(join(directory, stage + '.command.json'), JSON.stringify({ stage, command, startedAt,
    cwd: process.cwd(), environmentOverrides: overrides }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ event: 'started', stage, command, startedAt }));
  const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command],
    { cwd: process.cwd(), windowsHide: true, stdio: ['ignore', stdout, stderr], env: { ...process.env, ...overrides } });
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
assert.deepEqual(after, before, 'Frozen implementation changed during final gates.');
