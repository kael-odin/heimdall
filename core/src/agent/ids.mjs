/**
 * agent/ids — Bifröst 的 ID 规则（PRD 附录 C §0）
 *
 *   runId      run_<UTC 紧凑时间>_<6 位十六进制>，按时间可排序
 *   jobId      job_ + 8 位小写 base36
 *   sectionId  sec-<role>-<sha256(siteId|page|domPath|role) 前 6 位>：同一页 DOM 路径不变时跨重新生成稳定
 *   refId      ref_ + sha256(siteId|page|capturedAt) 前 8 位
 */
import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export function newRunId(at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `run_${stamp}_${randomBytes(3).toString('hex')}`;
}

export function newJobId() {
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += (b % 36).toString(36);
  return 'job_' + out;
}

export const sectionIdOf = (siteId, page, domPath, role) =>
  `sec-${role}-${sha256(`${siteId}|${page}|${domPath}|${role}`).slice(0, 6)}`;

export const refIdOf = (siteId, page, capturedAt) => 'ref_' + sha256(`${siteId}|${page}|${capturedAt}`).slice(0, 8);

export const RUN_ID = /^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/;
export const JOB_ID = /^job_[0-9a-z]{8}$/;
export const SECTION_ID = /^sec-[a-z]+-[0-9a-f]{6}$/;
