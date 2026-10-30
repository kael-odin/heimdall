/** Select the maintained suite explicitly. Runtime/evidence workspaces may
 * contain frozen source trees and must never become extra test discovery. */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));
let files = readdirSync(new URL('../test/', import.meta.url), { withFileTypes: true })
  .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map(entry => 'test/' + entry.name).sort();
if (!files.length) throw new Error('No maintained core tests found.');
const args = process.argv.slice(2);
const fast = args.includes('--fast');
const onlyAcceptance = args.includes('--acceptance');
const listFast = args.includes('--list-fast');
const browserish = /(from|require\()\s*['"]playwright|chromium\.launch|engine-server\.mjs|spawn\([^)]*engine/;
const slowName = /^(console-e2e|live-deployment|engine-boundary|acceptance-browser|acceptance-console|browser-)/;
if (onlyAcceptance) {
  files = files.filter(file => file.startsWith('test/acceptance-'));
} else if (fast || listFast) {
  // Fast tier = unit/store/flow tests only. Acceptance suites allocate real
  // engines and hashed evidence stores, so they get their own command.
  files = files.filter(file => {
    if (file.startsWith('test/acceptance-')) return false;
    if (slowName.test(file.replace('test/', ''))) return false;
    return !browserish.test(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
  });
}
if (listFast) {
  console.log(files.join('\n'));
  process.exit(0);
}
const passed = args.filter(arg => arg !== '--fast' && arg !== '--acceptance');
// Browser and filesystem suites allocate real engines. Large desktop CPU
// counts must not turn the default into dozens of competing engine workers.
// Two-core CI runners need both workers so the full suite leaves time for
// the serial browser smokes within the existing job deadline.
const parallelism = availableParallelism();
const concurrency = passed.some(arg => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='))
  ? [] : ['--test-concurrency=' + Math.max(1, Math.min(4, parallelism === 2 ? 2 : parallelism - 1))];
const result = spawnSync(process.execPath, ['--test', ...concurrency, ...passed, ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
