import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runChecks } from '../src/agent/registry/capabilities/doctor.mjs';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('doctor includes dependency, UI, MCP and client checks in the lightweight CLI', () => {
  const result = spawnSync(process.execPath, [CLI, 'doctor', '--help', '--json'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const env = JSON.parse(result.stdout.trim());
  assert.deepEqual(env.result.checks, [
    'node', 'pnpm', 'dependencies', 'chromium', 'console', 'mcp',
    'engine', 'dataRoot', 'port', 'token', 'disk', 'llm', 'clients',
  ]);
  assert.ok(env.result.fixable.includes('dependencies'));
  assert.ok(env.result.fixable.includes('console'));
  assert.ok(env.result.fixable.includes('mcp'));
});

test('doctor checks report structured status without requiring an engine', async () => {
  const checks = await runChecks(['dependencies', 'console', 'mcp', 'clients']);
  assert.deepEqual(checks.map(check => check.id), ['dependencies', 'console', 'mcp', 'clients']);
  for (const check of checks) {
    assert.match(check.status, /^(ok|warn|fail)$/);
    assert.equal(typeof check.detail, 'string');
    assert.ok(check.detail.length > 0);
  }
});
