/** Select the maintained suite explicitly. Runtime/evidence workspaces may
 * contain frozen source trees and must never become extra test discovery. */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';

export function normalizeTestCoreArgs(argv) {
  const normalized = [...argv];
  if (normalized[0] === '--') normalized.shift();
  return normalized;
}

function main() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  let files = readdirSync(new URL('../test/', import.meta.url), { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => 'test/' + entry.name).sort();
  if (!files.length) throw new Error('No maintained core tests found.');
  const args = normalizeTestCoreArgs(process.argv.slice(2));
  const fast = args.includes('--fast');
  const listFast = args.includes('--list-fast');
  const browserish = /(from|require\()\s*['"]playwright|chromium\.launch|engine-server\.mjs|spawn\([^)]*engine/;
  const slowName = /^(console-e2e|live-deployment|engine-boundary|browser-)/;
  if (fast || listFast) {
    files = files.filter(file => {
      if (slowName.test(file.replace('test/', ''))) return false;
      return !browserish.test(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    });
  }
  if (listFast) {
    console.log(files.join('\n'));
    process.exitCode = 0;
    return;
  }
  const passed = args.filter(arg => arg !== '--fast');
  const parallelism = availableParallelism();
  const concurrency = passed.some(arg => arg === '--test-concurrency' || arg.startsWith('--test-concurrency='))
    ? [] : ['--test-concurrency=' + Math.max(1, Math.min(4, parallelism === 2 ? 2 : parallelism - 1))];
  const result = spawnSync(process.execPath, ['--test', ...concurrency, ...passed, ...files], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
