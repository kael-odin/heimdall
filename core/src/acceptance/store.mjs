import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_ROOT } from '../paths.mjs';
import { normalizeAcceptancePlan } from './schema.mjs';
import { summarizeAcceptanceReport, acceptanceMarkdown } from './report.mjs';
import { writeAtomicFileSync } from './atomic-file.mjs';
import { createLegacyAcceptanceReadScope, rejectManagedAcceptanceFields } from './managed-access.mjs';
import { assertUnmanagedAcceptanceInput } from './managed-run-schema.mjs';

export const ACCEPTANCE_ROOT = join(DATA_ROOT, 'acceptance');
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_NAME = /^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const ACCEPTANCE_SNAPSHOT_LIMITS = Object.freeze({ jsonBytes: 8 * 1024 * 1024, evidenceFiles: 1024,
  evidenceFileBytes: 64 * 1024 * 1024, evidenceBytes: 256 * 1024 * 1024, checks: 1024 });
const inside = (root, path) => { const rel = relative(root, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const atomic = (path, data) => writeAtomicFileSync(path, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
export function acceptanceRunDir(runId, root = ACCEPTANCE_ROOT) {
  if (!RUN_ID.test(String(runId))) throw new Error('invalid acceptance run ID');
  const path = resolve(root, runId);
  if (existsSync(path) && !inside(realpathSync(root), realpathSync(path))) throw new Error('acceptance path escapes data root');
  return path;
}
export function createAcceptanceRun(input, { root = ACCEPTANCE_ROOT, taskId = null } = {}) {
  assertUnmanagedAcceptanceInput(input);
  const plan = normalizeAcceptancePlan(input);
  mkdirSync(root, { recursive: true });
  const runId = 'ac-' + randomUUID();
  const scope = createLegacyAcceptanceReadScope(root);
  scope.assertUnmanaged(runId); scope.assertCurrent();
  const dir = acceptanceRunDir(runId, root);
  mkdirSync(dir);
  const manifest = { schemaVersion: 1, runId, taskId, name: plan.name, mode: plan.mode,
    baselineUrl: plan.baselineUrl, targetUrl: plan.targetUrl, status: 'running', gate: 'blocked',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plan, summary: null, progress: null };
  atomic(join(dir, 'manifest.json'), manifest);
  return manifest;
}
function optionalReportHead(dir) {
  const path = join(dir, 'report.json');
  let descriptor;
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  try {
    let before;
    try { before = lstatSync(path, { bigint: true }); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(ACCEPTANCE_SNAPSHOT_LIMITS.jsonBytes)) throw Error();
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !same(before, opened)) throw Error();
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) throw Error(); offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, bytes.length) !== 0
      || !same(opened, fstatSync(descriptor, { bigint: true })) || !same(opened, lstatSync(path, { bigint: true }))) throw Error();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('acceptance report unreadable'); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function readAcceptanceRunInScope(runId, root, scope) {
  const dir = acceptanceRunDir(runId, root);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  scope.assertUnmanaged(runId);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  scope.assertUnmanaged(runId, manifest);
  scope.assertUnmanaged(runId, manifest, optionalReportHead(dir));
  return manifest;
}
export function readAcceptanceRun(runId, { root = ACCEPTANCE_ROOT, managedRead } = {}) {
  const dir = acceptanceRunDir(runId, root);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  const scope = createLegacyAcceptanceReadScope(root, managedRead);
  const manifest = readAcceptanceRunInScope(runId, root, scope);
  scope.assertCurrent();
  return manifest;
}
export function updateAcceptanceRun(runId, patch, { root = ACCEPTANCE_ROOT } = {}) {
  rejectManagedAcceptanceFields(patch);
  const current = readAcceptanceRun(runId, { root });
  if (!current) throw new Error('acceptance run not found');
  if (patch.progress && current.status !== 'running') throw new Error('acceptance run is no longer running');
  if (patch.status && current.status !== 'running' && patch.status !== current.status) throw new Error('terminal acceptance status cannot be overwritten');
  if (current.status !== 'running') for (const key of Object.keys(patch)) {
    if (key !== 'triageAvailable' && JSON.stringify(patch[key]) !== JSON.stringify(current[key])) {
      throw new Error('terminal acceptance facts are immutable');
    }
  }
  const manifest = { ...current, ...patch, runId, schemaVersion: current.schemaVersion, taskId: current.taskId,
    name: current.name, mode: current.mode, baselineUrl: current.baselineUrl, targetUrl: current.targetUrl,
    createdAt: current.createdAt, plan: current.plan, updatedAt: new Date().toISOString() };
  atomic(join(acceptanceRunDir(runId, root), 'manifest.json'), manifest);
  return manifest;
}
export function listAcceptanceRuns({ root = ACCEPTANCE_ROOT, limit = 100, managedRead } = {}) {
  if (!existsSync(root)) return [];
  const scope = createLegacyAcceptanceReadScope(root, managedRead);
  const runs = readdirSync(root).filter(name => RUN_ID.test(name)).map(runId => {
    try {
      const manifest = readAcceptanceRunInScope(runId, root, scope);
      if (!manifest) return null;
      const { plan: _plan, ...summary } = manifest;
      return summary;
    } catch (error) {
      if (error?.code === 'MANAGED_EXECUTION_REQUIRED') return { runId, name: '托管验收记录尚未开放', status: 'failed', gate: 'blocked',
        code: error.code, error: error.message };
      return { runId, name: '验收记录损坏', status: 'failed', gate: 'blocked', error: 'manifest unreadable' };
    }
  }).filter(Boolean).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).slice(0, limit);
  scope.assertCurrent();
  return runs;
}
export function recoverAcceptanceRuns({ root = ACCEPTANCE_ROOT } = {}) {
  let recovered = 0;
  for (const run of listAcceptanceRuns({ root, limit: Infinity })) {
    if (run.status !== 'running') continue;
    updateAcceptanceRun(run.runId, { status: 'interrupted', gate: 'blocked', error: '引擎已重启；此任务未完成，请重新运行。', endedAt: new Date().toISOString() }, { root });
    recovered++;
  }
  return recovered;
}
export function finishAcceptanceRun(runId, raw, { root = ACCEPTANCE_ROOT } = {}) {
  rejectManagedAcceptanceFields(raw);
  const current = readAcceptanceRun(runId, { root });
  if (!current) throw new Error('acceptance run not found');
  if (current.status !== 'running') throw new Error('cannot finish an interrupted or terminal acceptance run');
  const dir = acceptanceRunDir(runId, root);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const evidenceManifest = [];
  const unavailable = [];
  const references = new Set((raw.checks ?? []).flatMap(c => Object.values(c.evidence ?? {}).filter(v => typeof v === 'string')));
  for (const file of references) {
    const path = join(dir, file);
    if (!/^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(file) || !existsSync(path)
        || !inside(realpathSync(dir), realpathSync(path)) || !statSync(path).isFile()) { unavailable.push(file); continue; }
    const bytes = readFileSync(path);
    evidenceManifest.push({ file, bytes: bytes.length, sha256: hash(bytes) });
  }
  const checks = [...(raw.checks ?? [])];
  if (unavailable.length) checks.push({ id: 'evidence-integrity', title: '证据完整性', dimension: 'health',
    status: 'blocked', verdict: 'environment', severity: 'high', expected: 'All referenced evidence files exist inside this run.', actual: { unavailable }, reproduction: ['重新运行验收并检查证据目录。'], evidence: {} });
  const verifierFingerprint = hash(['schema.mjs', 'urls.mjs', 'runner.mjs', 'report.mjs', 'spec-schema.mjs', 'spec-runner.mjs', 'response-schema.mjs', 'openapi.mjs', 'identity.mjs'].map(file => readFileSync(new URL('./' + file, import.meta.url), 'utf8')).join('\n')
    + readFileSync(new URL('../verify/compare.mjs', import.meta.url), 'utf8'));
  const report = summarizeAcceptanceReport({ ...raw, checks, runId, planFingerprint: hash(JSON.stringify(current.plan)), verifierFingerprint, evidenceManifest });
  atomic(join(dir, 'report.json'), report);
  atomic(join(dir, 'report.md'), acceptanceMarkdown(report));
  updateAcceptanceRun(runId, { status: 'completed', gate: report.gate, summary: report.summary,
    endedAt: report.endedAt ?? new Date().toISOString(), progress: { kind: 'acceptance-complete' }, error: null,
    reportSha256: digest(readFileSync(join(dir, 'report.json'))) }, { root });
  return report;
}

/** Re-read current bytes before comparison; historical hashes alone are not proof. */
export function readAcceptanceSnapshot(runId, { root = ACCEPTANCE_ROOT, limits = ACCEPTANCE_SNAPSHOT_LIMITS, managedRead } = {}) {
  limits = { ...ACCEPTANCE_SNAPSHOT_LIMITS, ...limits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('invalid acceptance snapshot limits');
  const dir = acceptanceRunDir(runId, root);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  const errors = [];
  let scope;
  const managedBlocked = error => ({ manifest: { runId }, report: null, integrity: { valid: false, evidenceVerified: false,
    errors: [{ code: error.code, message: error.message }], verifiedFiles: 0, verifiedBytes: 0, reportSha256: null } });
  try { scope = createLegacyAcceptanceReadScope(root, managedRead); scope.assertUnmanaged(runId); }
  catch (error) { return managedBlocked(error); }
  const fail = (code, message, file) => {
    if (errors.length < 40) errors.push({ code, message, ...(file ? { file } : {}) });
  };
  const read = (name, maxBytes) => {
    try {
      const file = join(dir, name);
      if (!existsSync(file) || !inside(realpathSync(dir), realpathSync(file)) || !statSync(file).isFile()) {
        fail('FILE_UNAVAILABLE', '运行文件缺失或超出本次目录。', name); return null;
      }
      if (statSync(file).size > maxBytes) { fail('INTEGRITY_BUDGET', '文件超过完整性验证预算。', name); return null; }
      const bytes = readFileSync(file);
      if (bytes.length > maxBytes) { fail('INTEGRITY_BUDGET', '文件超过完整性验证预算。', name); return null; }
      return bytes;
    } catch { fail('FILE_UNREADABLE', '运行文件不可读取。', name); return null; }
  };
  const parse = (bytes, name) => {
    if (!bytes) return null;
    try { const value = JSON.parse(bytes.toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { fail('INVALID_JSON', '运行记录不是有效 JSON 对象。', name); return null; }
  };
  const manifest = parse(read('manifest.json', limits.jsonBytes), 'manifest.json');
  const reportBytes = read('report.json', limits.jsonBytes);
  const report = parse(reportBytes, 'report.json');
  try { scope.assertUnmanaged(runId, manifest, report); scope.assertCurrent(); }
  catch (error) { return managedBlocked(error); }
  let evidenceVerified = false, verifiedFiles = 0, verifiedBytes = 0;
  if (manifest && report) {
    if (manifest.runId !== runId || report.runId !== runId || manifest.mode !== report.mode) fail('RUN_IDENTITY_MISMATCH', '运行身份与报告不一致。');
    if (manifest.status !== 'completed' || report.status !== 'completed') fail('RUN_NOT_COMPLETE', '运行未完整结束，不能形成可靠复验。');
    if (!SHA256.test(manifest.reportSha256 ?? '')) fail('REPORT_DIGEST_UNAVAILABLE', '旧运行未记录报告字节指纹，请重新运行以获得可验证快照。');
    else if (digest(reportBytes) !== manifest.reportSha256) fail('REPORT_DIGEST_MISMATCH', '报告字节已变化。');
    if (!manifest.plan || digest(JSON.stringify(manifest.plan)) !== report.planFingerprint) fail('PLAN_DIGEST_MISMATCH', '报告与保存的验收计划不一致。');
    if (report.targetUrl !== manifest.targetUrl || report.baselineUrl !== manifest.baselineUrl) fail('RUN_TARGET_MISMATCH', '运行入口与报告不一致。');
    const checks = report.checks;
    if (!Array.isArray(checks) || checks.length > limits.checks || checks.some(check => !check || typeof check !== 'object')) {
      fail('INVALID_CHECKS', '检查清单无效或超过验证预算。');
    } else {
      const summary = summarizeAcceptanceReport(report);
      if (JSON.stringify(summary.summary) !== JSON.stringify(report.summary) || summary.gate !== report.gate
        || manifest.gate !== report.gate || JSON.stringify(manifest.summary) !== JSON.stringify(report.summary)) {
        fail('SUMMARY_MISMATCH', '保存的门禁或统计与当前检查不一致。');
      }
      if (!Array.isArray(report.evidenceManifest) || report.evidenceManifest.length > limits.evidenceFiles) {
        fail('INVALID_EVIDENCE_MANIFEST', '证据索引无效或超过验证预算。');
      } else {
        const indexed = new Map();
        for (const entry of report.evidenceManifest) {
          if (!entry || !EVIDENCE_NAME.test(entry.file) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
            || !SHA256.test(entry.sha256 ?? '') || indexed.has(entry.file)) {
            fail('INVALID_EVIDENCE_MANIFEST', '证据索引存在无效或重复条目。'); continue;
          }
          indexed.set(entry.file, entry);
        }
        const references = new Set();
        for (const check of checks) for (const file of Object.values(check.evidence ?? {})) {
          if (typeof file !== 'string' || !EVIDENCE_NAME.test(file)) { fail('INVALID_EVIDENCE_REFERENCE', '检查包含无效证据引用。'); continue; }
          references.add(file);
        }
        if (references.size > limits.evidenceFiles) fail('INTEGRITY_BUDGET', '证据数量超过完整性验证预算。');
        else for (const name of references) {
          const entry = indexed.get(name);
          if (!entry) { fail('EVIDENCE_NOT_INDEXED', '检查引用的证据未登记。', name); continue; }
          if (entry.bytes > limits.evidenceFileBytes || verifiedBytes + entry.bytes > limits.evidenceBytes) {
            fail('INTEGRITY_BUDGET', '证据字节总量超过完整性验证预算。'); break;
          }
          const bytes = read(name, Math.min(limits.evidenceFileBytes, limits.evidenceBytes - verifiedBytes));
          if (!bytes) continue;
          verifiedBytes += bytes.length;
          if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail('EVIDENCE_DIGEST_MISMATCH', '证据字节与完成时的索引不一致。', name);
          else verifiedFiles++;
        }
        evidenceVerified = references.size === verifiedFiles && errors.length === 0;
      }
    }
  }
  try { scope.assertCurrent(); } catch (error) { return managedBlocked(error); }
  return { manifest: manifest ?? { runId }, report,
    integrity: { valid: errors.length === 0, evidenceVerified, errors, verifiedFiles, verifiedBytes,
      reportSha256: reportBytes ? digest(reportBytes) : null } };
}
export function saveAcceptanceTriage(runId, triage, { root = ACCEPTANCE_ROOT } = {}) {
  const manifest = readAcceptanceRun(runId, { root });
  if (manifest?.status !== 'completed') throw new Error('acceptance report is not complete');
  atomic(join(acceptanceRunDir(runId, root), 'triage.json'), triage);
  updateAcceptanceRun(runId, { triageAvailable: true }, { root });
  return triage;
}
export function readAcceptanceTriage(runId, { root = ACCEPTANCE_ROOT } = {}) {
  const manifest = readAcceptanceRun(runId, { root });
  if (!manifest?.triageAvailable) return null;
  const file = join(acceptanceRunDir(runId, root), 'triage.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}
/** Only referenced PNG/JSON evidence can be downloaded. Never expose plan/temp files. */
export function acceptanceArtifact(runId, artifact, { root = ACCEPTANCE_ROOT } = {}) {
  const manifest = readAcceptanceRun(runId, { root });
  if (!manifest || manifest.status !== 'completed') return null;
  const dir = acceptanceRunDir(runId, root);
  let allowed = ['report.json', 'report.md'];
  if (!allowed.includes(artifact)) {
    if (!/^[a-z0-9][a-z0-9_.-]*\.(?:png|json)$/i.test(artifact)) throw new Error('invalid acceptance evidence name');
    const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
    allowed = report.checks.flatMap(c => Object.values(c.evidence ?? {}).filter(v => typeof v === 'string'));
    if (!allowed.includes(artifact)) return null;
  }
  const file = join(dir, artifact);
  if (!existsSync(file) || !inside(realpathSync(dir), realpathSync(file)) || !statSync(file).isFile()) return null;
  return file;
}
