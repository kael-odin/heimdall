import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = process.cwd();
const out = join(root, 'core/workspace/_runs/browser-bindings-console-publication-20261017/docs-links');
mkdirSync(out);
const command = { command: 'pnpm docs:links', cwd: root, startedAt: new Date().toISOString() };
writeFileSync(join(out, 'command.json'), JSON.stringify(command, null, 2) + '\n', { flag: 'wx' });
const stdout = createWriteStream(join(out, 'stdout.log'), { flags: 'wx' });
const stderr = createWriteStream(join(out, 'stderr.log'), { flags: 'wx' });
const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'pnpm docs:links'], { cwd: root, windowsHide: true });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode, signal) => resolve({ exitCode, signal, finishedAt: new Date().toISOString() }));
});
await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
writeFileSync(join(out, 'exitcode.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
for (const name of ['stdout.log', 'stderr.log']) {
  const bytes = readFileSync(join(out, name));
  console.log(JSON.stringify({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  if (name === 'stdout.log') console.log(bytes.toString('utf8'));
}
console.log(JSON.stringify(result)); process.exitCode = result.exitCode ?? 1;
