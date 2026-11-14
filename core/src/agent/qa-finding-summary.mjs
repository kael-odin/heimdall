import { redactText } from './redact.mjs';
import { fileable } from '../qa/report.mjs';

export const MAX_QA_FINDINGS = 12;

export function safeSummaryText(value, max = 240) {
  return redactText(String(value ?? ''), { profile: 'strict' }).text
    .replace(/\b(?:token|cookie|authorization|bearer|password|secret)\b\s*[:=]\s*[^\s&,;]+/gi, '[sensitive value removed]')
    .slice(0, max);
}

function safeFinding(value, runId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const text = input => safeSummaryText(input, 360);
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 40) : null,
    ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint.slice(0, 80) } : {}),
    tier: ['wall', 'degrade', 'tolerable'].includes(value.tier) ? value.tier : 'unknown',
    basis: ['failed', 'wrong', 'promise', 'friction', 'cosmetic'].includes(value.basis) ? value.basis : 'unknown',
    kind: typeof value.kind === 'string' ? value.kind.slice(0, 64) : 'unknown',
    path: typeof value.path === 'string' ? safeSummaryText(value.path) : null,
    title: text(value.title),
    ...(typeof value.target === 'string' ? { target: text(value.target).slice(0, 240) } : {}),
    ...(typeof value.detector === 'string' ? { detector: text(value.detector).slice(0, 80) } : {}),
    ...(typeof value.expected === 'string' ? { expected: text(value.expected) } : {}),
    ...(typeof value.observed === 'string' ? { observed: text(value.observed) } : {}),
    ...(typeof value.loss === 'string' ? { loss: text(value.loss) } : {}),
    confidence: typeof value.confidence === 'string' ? value.confidence.slice(0, 40) : 'unknown',
    source: value.source === 'agent' ? 'agent' : 'check',
    triage: typeof value.triage?.status === 'string' ? value.triage.status.slice(0, 32) : 'unknown',
    verification: {
      status: 'pending_human_verdict',
      method: 'heimdall_qa_findings',
      runId,
      findingId: typeof value.id === 'string' ? value.id.slice(0, 40) : null,
    },
  };
}

export function qaFindingDigest(source, runId, { reportedTotal = null, filter = fileable } = {}) {
  if (!Array.isArray(source)) return { status: 'unavailable', items: [], total: reportedTotal, returned: 0, truncated: false };
  const findings = source.filter(filter);
  const items = findings.slice(0, MAX_QA_FINDINGS).map(finding => safeFinding(finding, runId)).filter(Boolean);
  return { status: 'observed', items, total: findings.length, returned: items.length, truncated: findings.length > items.length };
}
