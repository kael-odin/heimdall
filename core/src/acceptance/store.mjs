import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DATA_ROOT } from '../paths.mjs';
import { normalizeAcceptancePlan } from './schema.mjs';
import { summarizeAcceptanceReport, acceptanceMarkdown } from './report.mjs';

export const ACCEPTANCE_ROOT = join(DATA_ROOT, 'acceptance');
const RUN_ID = /^ac-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const inside = (root, path) => { const rel = relative(root, path); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
const atomic = (path, data) => {
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
};
export function acceptanceRunDir(runId, root = ACCEPTANCE_ROOT) {
  if (!RUN_ID.test(String(runId))) throw new Error('invalid acceptance run ID');
  const path = resolve(root, runId);
  if (existsSync(path) && !inside(realpathSync(root), realpathSync(path))) throw new Error('acceptance path escapes data root');
  return path;
}
export function createAcceptanceRun(input, { root = ACCEPTANCE_ROOT, taskId = null } = {}) {
  const plan = normalizeAcceptancePlan(input);
  mkdirSync(root, { recursive: true });
  const runId = 'ac-' + randomUUID();
  const dir = acceptanceRunDir(runId, root);
  mkdirSync(dir);
  const manifest = { schemaVersion: 1, runId, taskId, name: plan.name, mode: plan.mode,
    baselineUrl: plan.baselineUrl, targetUrl: plan.targetUrl, status: 'running', gate: 'blocked',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), plan, summary: null, progress: null };
  atomic(join(dir, 'manifest.json'), manifest);
  return manifest;
}
export function readAcceptanceRun(runId, { root = ACCEPTANCE_ROOT } = {}) {
  const dir = acceptanceRunDir(runId, root);
  if (!existsSync(join(dir, 'manifest.json'))) return null;
  return JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
}
export function updateAcceptanceRun(runId, patch, { root = ACCEPTANCE_ROOT } = {}) {
  const current = readAcceptanceRun(runId, { root });
  if (!current) throw new Error('acceptance run not found');
  if (patch.progress && current.status !== 'running') throw new Error('acceptance run is no longer running');
  if (patch.status && current.status !== 'running' && patch.status !== current.status) throw new Error('terminal acceptance status cannot be overwritten');
  const manifest = { ...current, ...patch, runId, plan: current.plan, updatedAt: new Date().toISOString() };
  atomic(join(acceptanceRunDir(runId, root), 'manifest.json'), manifest);
  return manifest;
}
export function listAcceptanceRuns({ root = ACCEPTANCE_ROOT, limit = 100 } = {}) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => RUN_ID.test(name)).map(runId => {
    try {
      const manifest = readAcceptanceRun(runId, { root });
      if (!manifest) return null;
      const { plan: _plan, ...summary } = manifest;
      return summary;
    } catch { return { runId, name: '验收记录损坏', status: 'failed', gate: 'blocked', error: 'manifest unreadable' }; }
  }).filter(Boolean).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).slice(0, limit);
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
  const verifierFingerprint = hash(['schema.mjs', 'runner.mjs', 'report.mjs'].map(file => readFileSync(new URL('./' + file, import.meta.url), 'utf8')).join('\n')
    + readFileSync(new URL('../verify/compare.mjs', import.meta.url), 'utf8'));
  const report = summarizeAcceptanceReport({ ...raw, checks, runId, planFingerprint: hash(JSON.stringify(current.plan)), verifierFingerprint, evidenceManifest });
  atomic(join(dir, 'report.json'), report);
  atomic(join(dir, 'report.md'), acceptanceMarkdown(report));
  updateAcceptanceRun(runId, { status: 'completed', gate: report.gate, summary: report.summary,
    endedAt: report.endedAt ?? new Date().toISOString(), progress: { kind: 'acceptance-complete' }, error: null }, { root });
  return report;
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
