/**
 * CLI 单测：命令表与解析
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, resolveCommand } from '../src/cli.mjs';

test('cli: command table covers the full workflow', () => {
  for (const name of ['recon', 'forge', 'queue', 'audit', 'watch', 'verify', 'tokens', 'live', 'dedupe', 'deliver', 'serve']) {
    assert.ok(COMMANDS[name]?.script, 'missing command: ' + name);
  }
});

test('cli: resolveCommand maps args and rejects unknown commands', () => {
  const c = resolveCommand(['audit', 'apify.com', '--max', '20']);
  assert.equal(c.name, 'audit');
  assert.equal(c.script, 'src/seo/audit.mjs');
  assert.deepEqual(c.args, ['apify.com', '--max', '20']);
  assert.equal(resolveCommand([]), null);
  assert.equal(resolveCommand(['nope']), null);
});

test('cli: all-discovered queue mode is visible and forwarded', () => {
  assert.match(COMMANDS.queue.usage, /--all-discovered/);
  assert.deepEqual(resolveCommand(['queue', 'x.test', '--all-discovered']).args, ['x.test', '--all-discovered']);
});
