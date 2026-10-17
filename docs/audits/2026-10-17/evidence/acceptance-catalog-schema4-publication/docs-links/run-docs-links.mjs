import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const root = process.cwd();
const out = join(root, 'core/workspace/_runs/d1-final-docs-links-' + randomUUID());
mkdirSync(out);
const startedAt = new Date().toISOString();
writeFileSync(join(out, 'command.json'), JSON.stringify({ command: 'pnpm docs:links', cwd: root, startedAt }, null, 2) + '\n', { flag: 'wx' });
const stdout = createWriteStream(join(out, 'stdout.log'), { flags: 'wx' });
const stderr = createWriteStream(join(out, 'stderr.log'), { flags: 'wx' });
const child = spawn('powershell.exe', ['-NoProfile', '-Command', 'pnpm docs:links'], { cwd: root, windowsHide: true });
child.stdout.pipe(stdout); child.stderr.pipe(stderr);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (exitCode, signal) => resolve({ exitCode, signal, finishedAt: new Date().toISOString() }));
});
await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))]);
writeFileSync(join(out, 'exitcode.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
const files = ['command.json', 'stdout.log', 'stderr.log', 'exitcode.json'].map(name => {
  const bytes = readFileSync(join(out, name));
  return { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
});
writeFileSync(join(out, 'files.json'), JSON.stringify(files, null, 2) + '\n', { flag: 'wx' });
console.log(readFileSync(join(out, 'stdout.log'), 'utf8'));
console.error(readFileSync(join(out, 'stderr.log'), 'utf8'));
console.log(JSON.stringify({ out, ...result }));
process.exitCode = result.exitCode ?? 1;
