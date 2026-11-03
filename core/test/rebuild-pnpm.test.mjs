import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRegistry, pnpmInvocation, runPnpm } from '../src/agent/rebuild/pnpm.mjs';

test('rebuild registry validation accepts ordinary registries and rejects shell metacharacters', () => {
  assert.equal(normalizeRegistry(undefined), null);
  assert.equal(normalizeRegistry('https://registry.npmjs.org/'), 'https://registry.npmjs.org');
  assert.equal(normalizeRegistry('http://127.0.0.1:4873'), 'http://127.0.0.1:4873');
  for (const value of [
    'https://registry.npmjs.org&calc.exe',
    'https://registry.npmjs.org|calc.exe',
    'https://registry.npmjs.org/%PATH%',
    'https://user:secret@registry.npmjs.org',
    'file:///tmp/registry',
    'registry.npmjs.org',
  ]) assert.throws(() => normalizeRegistry(value), /registry/, value);
});

test('Windows pnpm invocation quotes every argument and never enables a shell', () => {
  const invocation = pnpmInvocation(['install', '--ignore-scripts', '--registry', 'https://registry.npmjs.org'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(invocation.args[3], 'pnpm.cmd install --ignore-scripts --registry https://registry.npmjs.org');
  assert.throws(() => pnpmInvocation(['install', 'x&calc'], { platform: 'win32', env: process.env }), /unsupported/);
});

test('runPnpm executes the real package manager without shell interpolation', () => {
  const result = runPnpm(['--version'], { timeoutMs: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
  assert.match(String(result.stdout).trim(), /^\d+\.\d+\.\d+/);
});
