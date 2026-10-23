/** Select the maintained suite explicitly. Runtime/evidence workspaces may
 * contain frozen source trees and must never become extra test discovery. */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('../test/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => 'test/' + entry.name).sort();
if (!files.length) throw new Error('No maintained core tests found.');
const args = process.argv.slice(2);
// Browser and filesystem suites allocate real engines. Large desktop CPU
// counts must not turn the default into dozens of competing engine workers.
const concurrency = args.some(arg => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='))
  ? [] : ['--test-concurrency=' + Math.max(1, Math.min(4, availableParallelism() - 1))];
const result = spawnSync(process.execPath, ['--test', ...concurrency, ...args, ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
