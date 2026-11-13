import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloneInputSha256 } from './verify/resume-cache.mjs';

const SHA256 = /^[a-f0-9]{64}$/;

/** Read a single-page score only when it still describes the current clone tree. */
export function readCurrentScore(pageDir, currentInputSha256 = null) {
  const file = join(pageDir, 'score.json');
  if (!existsSync(file)) return { status: 'missing', score: null };
  let score;
  try { score = JSON.parse(readFileSync(file, 'utf8')); }
  catch { return { status: 'invalid', score: null };
  }
  if (score?.scoreFormulaVersion !== 2 || !SHA256.test(score.inputSha256 ?? '')) {
    return { status: 'legacy', score: null };
  }
  const current = SHA256.test(currentInputSha256 ?? '') ? currentInputSha256 : cloneInputSha256(pageDir);
  if (!current || current !== score.inputSha256) return { status: 'stale', score: null };
  if (!Number.isFinite(score.total) || !Number.isFinite(score.pixel)) return { status: 'invalid', score: null };
  return { status: 'verified', score };
}
