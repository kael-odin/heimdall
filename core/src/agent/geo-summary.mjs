import { GEO_METHOD_VERSION } from '../seo/method.mjs';
import { redactText } from './redact.mjs';

const GEO_STATUSES = new Set(['complete', 'partial', 'unavailable']);
const GEO_DIMENSION_KEYS = ['answerability', 'extractability', 'entity', 'citation'];
const GEO_DIMENSION_STATUSES = new Set(['complete', 'partial', 'unknown']);

const safeText = (value, max = 240) => redactText(String(value ?? ''), { profile: 'strict' }).text.slice(0, max);
const safeNumber = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function safeGeoActionPlan(actionPlan) {
  if (!Array.isArray(actionPlan)) return [];
  return actionPlan.slice(0, 8).map(item => ({
    rank: Number.isInteger(item?.rank) && item.rank > 0 ? item.rank : null,
    id: safeText(item?.id), dimension: safeText(item?.dimension),
    priority: ['P0', 'P1', 'P2'].includes(item?.priority) ? item.priority : 'P2',
    title: safeText(item?.title), action: safeText(item?.action),
    impact: {
      checkWeight: safeNumber(item?.impact?.checkWeight) ?? 0,
      affectedPages: safeNumber(item?.impact?.affectedPages) ?? 0,
      occurrences: safeNumber(item?.impact?.occurrences) ?? 0,
    },
    estimatedEffort: ['small', 'medium', 'large'].includes(item?.estimatedEffort) ? item.estimatedEffort : 'unknown',
    validation: item?.validation && typeof item.validation === 'object' ? {
      method: safeText(item.validation.method), checkId: safeText(item.validation.checkId), expectedStatus: 'pass',
    } : null,
  }));
}

export function summarizeGeoReport(geo) {
  const source = geo && typeof geo === 'object' && !Array.isArray(geo) ? geo : null;
  const current = source?.methodVersion === GEO_METHOD_VERSION && GEO_STATUSES.has(source.status);
  const actionPlan = Array.isArray(source?.actionPlan) ? source.actionPlan : [];
  const safeActionPlan = safeGeoActionPlan(actionPlan);
  const priorities = {};
  for (const item of actionPlan) {
    const priority = typeof item?.priority === 'string' ? item.priority.slice(0, 16) : 'unknown';
    priorities[priority] = (priorities[priority] ?? 0) + 1;
  }
  const coverage = source?.coverage && typeof source.coverage === 'object' && !Array.isArray(source.coverage)
    ? {
      ...(Number.isSafeInteger(source.coverage.pages) && source.coverage.pages >= 0 ? { pages: source.coverage.pages } : {}),
      ...(Number.isSafeInteger(source.coverage.pagesScored) && source.coverage.pagesScored >= 0 ? { pagesScored: source.coverage.pagesScored } : {}),
      ...(Number.isSafeInteger(source.coverage.pagesUnavailable) && source.coverage.pagesUnavailable >= 0 ? { pagesUnavailable: source.coverage.pagesUnavailable } : {}),
      ...(typeof source.coverage.observedWeight === 'number' && Number.isFinite(source.coverage.observedWeight) && source.coverage.observedWeight >= 0
        ? { observedWeight: source.coverage.observedWeight } : {}),
      ...(typeof source.coverage.totalWeight === 'number' && Number.isFinite(source.coverage.totalWeight) && source.coverage.totalWeight >= 0
        ? { totalWeight: source.coverage.totalWeight } : {}),
      ...(typeof source.coverage.ratio === 'number' && Number.isFinite(source.coverage.ratio) && source.coverage.ratio >= 0
        ? { ratio: source.coverage.ratio } : {}),
    } : null;
  const dimensions = source?.dimensions && typeof source.dimensions === 'object' && !Array.isArray(source.dimensions)
    ? Object.fromEntries(GEO_DIMENSION_KEYS.flatMap(key => {
      const dimension = source.dimensions[key];
      if (!dimension || typeof dimension !== 'object' || Array.isArray(dimension)) return [];
      const status = GEO_DIMENSION_STATUSES.has(dimension.status) ? dimension.status : 'unknown';
      return [[key, {
        label: safeText(dimension.label, 80),
        score: safeNumber(dimension.score),
        weight: safeNumber(dimension.weight),
        pages: Number.isSafeInteger(dimension.pages) && dimension.pages >= 0 ? dimension.pages : null,
        observedWeight: safeNumber(dimension.observedWeight),
        totalWeight: safeNumber(dimension.totalWeight),
        status,
      }]];
    })) : null;
  return {
    methodVersion: Number.isSafeInteger(source?.methodVersion) ? source.methodVersion : null,
    status: current ? source.status : 'unknown',
    score: safeNumber(source?.score),
    confidence: current && typeof source?.confidence === 'string' ? safeText(source.confidence, 40) : null,
    dimensions: dimensions && Object.keys(dimensions).length ? dimensions : null,
    coverage,
    actionItems: actionPlan.length,
    actionPlan: safeActionPlan,
    actionPlanMeta: {
      total: Number.isInteger(source?.actionPlanMeta?.total) && source.actionPlanMeta.total >= 0
        ? source.actionPlanMeta.total : actionPlan.length,
      returned: safeActionPlan.length,
      truncated: source?.actionPlanMeta?.truncated === true || safeActionPlan.length < actionPlan.length,
    },
    priorities,
  };
}
