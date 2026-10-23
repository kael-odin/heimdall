import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const start = Date.now();
const result = spawnSync(process.execPath, ['--test', 'core/test/acceptance-catalog-migration.test.mjs',
  'core/test/acceptance-catalog-schema3-migration.test.mjs'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
writeFileSync(join(directory, 'stdout.log'), result.stdout ?? '', { flag: 'wx' });
writeFileSync(join(directory, 'stderr.log'), result.stderr ?? '', { flag: 'wx' });
const summary = { code: result.status, signal: result.signal, error: result.error?.message ?? null,
  elapsedMs: Date.now() - start, startedAt: new Date(start).toISOString(), endedAt: new Date().toISOString() };
writeFileSync(join(directory, 'exitcode.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
console.log(result.stdout.slice(-16000));
if (result.stderr) console.error(result.stderr);
process.exitCode = result.status ?? 1;
