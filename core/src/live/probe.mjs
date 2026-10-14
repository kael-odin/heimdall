import { spawn } from 'node:child_process';
import { join } from 'node:path';

function startOfflineServer(bundleDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(bundleDir, 'serve.mjs'), '--port', '0', '--host', '127.0.0.1', '--offline', '--root', 'mirror'], {
      cwd: bundleDir, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', part => { stderr = (stderr + part).slice(-2000); });
    const timer = setTimeout(() => fail(new Error('offline server startup timed out')), 10_000);
    function fail(error) {
      clearTimeout(timer);
      child.kill();
      reject(error);
    }
    child.once('error', fail);
    child.once('exit', code => fail(new Error(`offline server exited (${code}): ${stderr}`)));
    child.once('message', message => {
      if (message?.kind !== 'heimdall-live-ready') return;
      clearTimeout(timer);
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      resolve({ child, base: `http://127.0.0.1:${message.port}` });
    });
  });
}

/** Request every statically discovered local route from the actual offline server. */
export async function probeOfflineBundle(bundleDir, paths) {
  const { child, base } = await startOfflineServer(bundleDir);
  let next = 0;
  let failed = 0;
  const failures = [];
  try {
    const workers = Array.from({ length: Math.min(8, paths.length) }, async () => {
      while (next < paths.length) {
        const path = paths[next++];
        try {
          const response = await fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
          if (!response.ok) {
            failed++;
            if (failures.length < 100) failures.push({ path: path.split('?')[0], status: response.status });
          }
          await response.body?.cancel();
        } catch (error) {
          failed++;
          if (failures.length < 100) failures.push({ path: path.split('?')[0], error: String(error?.message ?? error) });
        }
      }
    });
    await Promise.all(workers);
    return { checked: paths.length, failed, failures };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  }
}
