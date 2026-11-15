import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const OUTCOME_EVIDENCE_SCHEMA = 'heimdall.seo-geo-outcome-evidence/1';

const MAX_BYTES = 512 * 1024;
const SOURCES = {
  search: new Set(['search-console', 'search-api', 'manual-search']),
  modelCitation: new Set(['model-probe', 'manual-model']),
};

function originOf(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) ? url.origin : null;
  } catch { return null; }
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function timestamp(value) {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unknown(reason, evidence = []) {
  return { status: 'unknown', basis: 'unknown', evidence, reason };
}

function normalizePart(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${kind} 实验摘要缺失。`);
  if (value.status === 'unavailable') return { status: 'unavailable' };
  if (value.status !== 'observed') throw new Error(`${kind} 实验状态未被认可。`);
  const samples = count(value.samples);
  const hits = count(value.hits);
  if (!samples || hits === null || hits > samples) throw new Error(`${kind} 实验的 samples/hits 无效。`);
  const source = SOURCES[kind].has(value.source) ? value.source : null;
  if (!source) throw new Error(`${kind} 实验来源未被认可。`);
  const result = { status: 'observed', source, samples, hits, hitRate: Math.round(hits / samples * 1000) / 1000 };
  if (kind === 'search') {
    const averagePosition = number(value.averagePosition);
    const indexedPages = count(value.indexedPages);
    if (averagePosition !== null && averagePosition > 0) result.averagePosition = averagePosition;
    if (indexedPages !== null) result.indexedPages = indexedPages;
  } else {
    const sourceMentions = count(value.sourceMentions);
    if (sourceMentions !== null) result.sourceMentions = sourceMentions;
  }
  return result;
}

function summarizePart(value, kind, evidencePath, generatedAt) {
  try {
    const result = normalizePart(value, kind);
    if (result.status === 'unavailable') {
      return { status: 'unavailable', basis: 'observed', evidence: [evidencePath], reason: `${kind} 实验明确不可用。`, generatedAt };
    }
    return { ...result, basis: 'observed', evidence: [evidencePath], generatedAt };
  } catch (error) {
    return unknown(error.message, [evidencePath]);
  }
}

function resourcePath(siteId) {
  return `workspace/${siteId}/seo/outcome-evidence.json`;
}

function resourceUri(siteId) {
  return `heimdall://site/${encodeURIComponent(siteId)}/seo/outcomes`;
}

export function normalizeOutcomeEvidence(source, expectedOrigin) {
  if (!source || typeof source !== 'object' || source.schema !== OUTCOME_EVIDENCE_SCHEMA) throw new Error('实验摘要 schema 不被认可。');
  if (expectedOrigin === null) throw new Error('站点来源包含多个 origin，拒绝绑定实验摘要。');
  const sourceOrigin = originOf(source.origin);
  if (!sourceOrigin || (expectedOrigin && sourceOrigin !== expectedOrigin)) throw new Error('实验摘要来源与当前站点不一致。');
  const generatedAt = timestamp(source.generatedAt);
  if (!generatedAt) throw new Error('实验摘要缺少有效 generatedAt。');
  return {
    schema: OUTCOME_EVIDENCE_SCHEMA, origin: sourceOrigin, generatedAt,
    search: normalizePart(source.search, 'search'),
    modelCitation: normalizePart(source.modelCitation, 'modelCitation'),
  };
}

export function summarizeOutcomeEvidence(root, siteId, expectedOrigin) {
  const path = resourcePath(siteId);
  const uri = resourceUri(siteId);
  const file = join(root, 'seo', 'outcome-evidence.json');
  const missing = {
    schema: OUTCOME_EVIDENCE_SCHEMA, sourceStatus: 'missing', path: null, uri: null,
    search: unknown('没有脱敏的真实搜索/收录实验摘要。'),
    modelCitation: unknown('没有脱敏的真实模型引用实验摘要。'),
  };
  const located = { ...missing, path, uri };
  if (!existsSync(file)) return missing;
  let source;
  try {
    if (statSync(file).size > MAX_BYTES) return { ...located, sourceStatus: 'invalid', search: unknown('实验摘要超过安全大小上限。', [path]), modelCitation: unknown('实验摘要超过安全大小上限。', [path]) };
    source = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { ...located, sourceStatus: 'invalid', search: unknown('实验摘要无法读取或解析。', [path]), modelCitation: unknown('实验摘要无法读取或解析。', [path]) };
  }
  if (!source || typeof source !== 'object' || source.schema !== OUTCOME_EVIDENCE_SCHEMA) {
    return { ...located, sourceStatus: 'invalid', search: unknown('实验摘要 schema 不被认可。', [path]), modelCitation: unknown('实验摘要 schema 不被认可。', [path]) };
  }
  if (expectedOrigin === null) {
    return { ...located, sourceStatus: 'origin_ambiguous', search: unknown('站点来源包含多个 origin，拒绝绑定实验摘要。', [path]), modelCitation: unknown('站点来源包含多个 origin，拒绝绑定实验摘要。', [path]) };
  }
  const sourceOrigin = originOf(source.origin);
  if (!sourceOrigin || (expectedOrigin && sourceOrigin !== expectedOrigin)) {
    return { ...located, sourceStatus: 'origin_mismatch', search: unknown('实验摘要来源与当前站点不一致。', [path]), modelCitation: unknown('实验摘要来源与当前站点不一致。', [path]) };
  }
  const generatedAt = timestamp(source.generatedAt);
  if (!generatedAt) {
    return { ...located, sourceStatus: 'invalid', search: unknown('实验摘要缺少有效 generatedAt。', [path]), modelCitation: unknown('实验摘要缺少有效 generatedAt。', [path]) };
  }
  return {
    schema: OUTCOME_EVIDENCE_SCHEMA, sourceStatus: 'observed', path, uri, generatedAt,
    search: summarizePart(source.search, 'search', path, generatedAt),
    modelCitation: summarizePart(source.modelCitation, 'modelCitation', path, generatedAt),
  };
}
