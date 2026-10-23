import { spawn } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('.', import.meta.url));
const [stage, command] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(stage ?? '') || !command) throw new Error('Stage and exact command required.');
const stdoutPath = join(directory, stage + '.stdout.log'), stderrPath = join(directory, stage + '.stderr.log');
const stdout = openSync(stdoutPath, 'wx'), stderr = openSync(stderrPath, 'wx');
const startedAt = new Date().toISOString(), started = Date.now();
console.log(JSON.stringify({ event: 'started', stage, command, startedAt }));
const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', stdout, stderr], env: process.env,
});
const result = await new Promise(resolve => {
  child.once('error', error => resolve({ exitCode: 1, signal: null, error: String(error) }));
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
});
closeSync(stdout); closeSync(stderr);
const record = { stage, command, startedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - started,
  stdoutPath, stderrPath, ...result };
writeFileSync(join(directory, stage + '.exitcode.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ event: 'completed', ...record }));
process.exitCode = result.exitCode ?? 1;
