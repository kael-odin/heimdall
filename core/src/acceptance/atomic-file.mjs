import { openSync, closeSync, writeFileSync, renameSync, unlinkSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { dirname } from 'node:path';

const WINDOWS_BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DELAYS_MS = [10, 20, 40, 80, 120, 160, 200];
const sleepWord = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = milliseconds => Atomics.wait(sleepWord, 0, 0, milliseconds);
const nativeIo = { open: openSync, close: closeSync, write: writeFileSync, fsync: fsyncSync, rename: renameSync, unlink: unlinkSync };

/**
 * Replace a file with one same-directory rename. Windows read handles can briefly
 * deny replacement; retry only those sharing/permission failures, never unlink
 * the destination. Dependency overrides make timing and failure paths testable.
 */
export function writeAtomicFileSync(path, data, {
  platform = process.platform, maxRetryMs = 750, io: overrides = {},
  sleep = sleepSync, now = () => performance.now(), onRetry,
} = {}) {
  if (!Number.isFinite(maxRetryMs) || maxRetryMs < 0 || maxRetryMs > 1_000) throw new RangeError('Atomic file retry budget must be between 0 and 1000 ms');
  const io = { ...nativeIo, ...overrides };
  const temporary = `${path}.${randomUUID()}.tmp`;
  let descriptor, ownedTemporary = false, attempts = 0, waitedMs = 0;
  let stage = 'create temporary file';
  try {
    descriptor = io.open(temporary, 'wx', 0o600);
    ownedTemporary = true;
    stage = 'write temporary file';
    io.write(descriptor, data);
    stage = 'flush temporary file';
    io.fsync(descriptor);
    stage = 'close temporary file';
    io.close(descriptor);
    descriptor = undefined;
    stage = 'replace destination';
    const started = now();
    for (;;) {
      attempts++;
      try {
        io.rename(temporary, path);
        ownedTemporary = false;
        if (platform !== 'win32') {
          stage = 'flush parent directory';
          let directory;
          try {
            directory = io.open(dirname(path), 'r');
            io.fsync(directory);
          } finally {
            if (directory !== undefined) io.close(directory);
          }
        }
        return { attempts, retries: attempts - 1, waitedMs };
      } catch (error) {
        const remaining = maxRetryMs - Math.max(waitedMs, now() - started);
        if (platform !== 'win32' || !WINDOWS_BUSY.has(error?.code) || remaining <= 0) throw error;
        const delayMs = Math.min(DELAYS_MS[Math.min(attempts - 1, DELAYS_MS.length - 1)], remaining);
        if (onRetry) onRetry({ attempt: attempts, code: error.code, delayMs, waitedMs, path, temporary });
        sleep(delayMs);
        waitedMs += delayMs;
      }
    }
  } catch (cause) {
    if (descriptor !== undefined) {
      try { io.close(descriptor); } catch { /* Preserve the original failure. */ }
    }
    let cleanupError;
    if (ownedTemporary) {
      try { io.unlink(temporary); }
      catch (error) { if (error?.code !== 'ENOENT') cleanupError = error; }
    }
    const code = cause?.code ?? 'ATOMIC_FILE_FAILED';
    const error = new Error(`Atomic file ${stage} failed (${code}) after ${attempts} rename attempt(s), ${Math.round(waitedMs)} ms retry wait: ${String(cause?.message ?? cause)}`, { cause });
    error.name = 'AtomicFileError';
    error.code = code;
    error.path = path;
    error.attempts = attempts;
    error.waitedMs = waitedMs;
    error.retryExhausted = stage === 'replace destination' && platform === 'win32' && WINDOWS_BUSY.has(code);
    if (cleanupError) error.cleanupError = { code: cleanupError.code, message: String(cleanupError.message) };
    throw error;
  }
}
