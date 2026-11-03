import { spawnSync } from 'node:child_process';

const SAFE_WINDOWS_ARG = /^[A-Za-z0-9_./:=?@+,-]+$/;

export function normalizeRegistry(value) {
  if (value === undefined || value === null || value === '') return null;
  const raw = String(value);
  if (!SAFE_WINDOWS_ARG.test(raw)) throw new Error('registry contains unsupported shell characters');
  let url;
  try { url = new URL(raw); }
  catch { throw new Error('registry must be an HTTP(S) URL'); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('registry must be a credential-free HTTP(S) URL');
  return raw.replace(/\/+$/, '');
}

export function pnpmInvocation(args, { platform = process.platform, env = process.env } = {}) {
  const values = args.map(String);
  if (values.some(value => !value || /[\0\r\n]/.test(value))) throw new Error('pnpm arguments contain invalid control characters');
  if (platform !== 'win32') return { command: 'pnpm', args: values, shell: false };
  if (values.some(value => !SAFE_WINDOWS_ARG.test(value))) throw new Error('pnpm arguments contain unsupported Windows shell characters');
  // Every argument is restricted to a shell-inert token, so no cmd quoting is needed.
  // Quoting --version here changes the bytes pnpm receives on Windows.
  const command = ['pnpm.cmd', ...values].join(' ');
  return { command: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command], shell: false };
}

export function runPnpm(args, {
  cwd,
  timeoutMs = 600_000,
  platform = process.platform,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const invocation = pnpmInvocation(args, { platform, env });
  return spawn(invocation.command, invocation.args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    shell: invocation.shell,
  });
}
