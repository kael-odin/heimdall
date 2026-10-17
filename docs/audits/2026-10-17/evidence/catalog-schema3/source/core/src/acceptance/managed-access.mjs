/** A request-local quarantine for managed facts until their consumers migrate.
 * Read-only sidecars never confer an execution or recovery capability. */
import { createManagedSpecDispatchReadContext, assertManagedSpecDispatchReadContext } from './managed-dispatch-reader.mjs';
import { hasManagedAcceptanceMarker, ManagedAcceptanceRunError } from './managed-run-schema.mjs';
import { resolve } from 'node:path';

export function createLegacyAcceptanceReadScope(root, managedRead) {
  let context, reserved;
  try {
    root = resolve(root);
    context = managedRead ?? createManagedSpecDispatchReadContext({ root });
    assertManagedSpecDispatchReadContext(context, root);
    reserved = new Set(context.inventory().map(item => item.runId));
  } catch {
    throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', 'DISPATCH_UNAVAILABLE');
  }
  return Object.freeze({
    assertUnmanaged(runId, manifest, report) {
      if (reserved.has(runId) || hasManagedAcceptanceMarker(manifest) || hasManagedAcceptanceMarker(report)) {
        throw new ManagedAcceptanceRunError('MANAGED_EXECUTION_REQUIRED', 'MANAGED_NOT_SUPPORTED');
      }
    },
    assertCurrent() {
      try { assertManagedSpecDispatchReadContext(context, root); }
      catch { throw new ManagedAcceptanceRunError('MANAGED_RUN_INTEGRITY_FAILED', 'DISPATCH_UNAVAILABLE'); }
    },
  });
}

export function rejectManagedAcceptanceFields(value) {
  if (hasManagedAcceptanceMarker(value)) throw new ManagedAcceptanceRunError('INVALID_INPUT', 'RESERVED_INPUT_FIELD');
}
