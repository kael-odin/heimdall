import { openSync, writeFileSync, closeSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Publish complete bytes under an immutable name without replacing an existing file. */
export function writeExclusiveCatalogFileSync(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    created = true;
    writeFileSync(descriptor, bytes);
    closeSync(descriptor); descriptor = undefined;
    // The link publishes the completed file in one step and fails if file exists.
    linkSync(temporary, file);
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Keep the publication error. */ } }
    if (created) { try { unlinkSync(temporary); } catch { /* A harmless orphan still blocks empty initialization. */ } }
  }
}
