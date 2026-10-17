import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
const out = join(process.cwd(), 'docs/audits/2026-10-17/evidence/browser-bindings-publication-checks');
const startedAt = new Date().toISOString(), command = 'pnpm docs:links';
writeFileSync(join(out, 'docs-command.json'), JSON.stringify({ command, startedAt, cwd: process.cwd() }, null, 2) + '\n', { flag: 'wx' });
const stdout = openSync(join(out, 'docs.stdout.log'), 'wx'), stderr = openSync(join(out, 'docs.stderr.log'), 'wx');
const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, stdio: ['ignore', stdout, stderr] });
closeSync(stdout); closeSync(stderr);
writeFileSync(join(out, 'docs-exitcode.json'), JSON.stringify({ command, startedAt, finishedAt: new Date().toISOString(),
  exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null }, null, 2) + '\n', { flag: 'wx' });
console.log(readFileSync(join(out, 'docs.stdout.log'), 'utf8')); console.log(readFileSync(join(out, 'docs.stderr.log'), 'utf8'));
process.exitCode = result.status ?? 1;
