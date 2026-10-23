import { join } from 'node:path';
import { DATA_ROOT } from '../paths.mjs';

// Shared without importing the legacy store, so owner-bound consumers can
// depend on owner validation without a store -> owner -> store cycle.
export const ACCEPTANCE_ROOT = join(DATA_ROOT, 'acceptance');
export const ACCEPTANCE_SNAPSHOT_LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, evidenceFiles: 1024,
  evidenceFileBytes: 64 * 1024 * 1024, evidenceBytes: 256 * 1024 * 1024, checks: 1024 });
