export const JOURNEY_ACTORS = Object.freeze(['anonymous', 'owner', 'non_owner', 'invalid_credentials']);

const REFERENCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const MAX_REFERENCES = 16;

export function normalizeJourneyActor(value) {
  return typeof value === 'string' && JOURNEY_ACTORS.includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() : null;
}

export function normalizeJourneyReferences(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(values.map(item => typeof item === 'string' ? item.trim() : '').filter(item => REFERENCE_ID.test(item)))].slice(0, MAX_REFERENCES);
}

export function normalizeJourneyMetadata({ actor, ruleIds, checkpointIds } = {}, { strict = false } = {}) {
  const normalizedActor = actor === undefined || actor === null || actor === '' ? null : normalizeJourneyActor(actor);
  const rawRuleIds = Array.isArray(ruleIds) ? ruleIds : typeof ruleIds === 'string' ? ruleIds.split(',') : [];
  const rawCheckpointIds = Array.isArray(checkpointIds) ? checkpointIds : typeof checkpointIds === 'string' ? checkpointIds.split(',') : [];
  const normalizedRuleIds = normalizeJourneyReferences(ruleIds);
  const normalizedCheckpointIds = normalizeJourneyReferences(checkpointIds);
  if (strict && actor !== undefined && actor !== null && actor !== '' && !normalizedActor) {
    throw new Error(`--actor 只能是 ${JOURNEY_ACTORS.join('|')}`);
  }
  if (strict && rawRuleIds.length > MAX_REFERENCES) {
    throw new Error('旅程规则引用最多 16 个');
  }
  if (strict && rawRuleIds.some(item => typeof item !== 'string' || (item.trim() && !REFERENCE_ID.test(item.trim())))) {
    throw new Error('--rule-id 只能包含字母、数字、点、下划线和短横线');
  }
  if (strict && rawCheckpointIds.length > MAX_REFERENCES) {
    throw new Error('旅程检查点引用最多 16 个');
  }
  if (strict && rawCheckpointIds.some(item => typeof item !== 'string' || (item.trim() && !REFERENCE_ID.test(item.trim())))) {
    throw new Error('--checkpoint-id 只能包含字母、数字、点、下划线和短横线');
  }
  return {
    ...(normalizedActor ? { actor: normalizedActor } : {}),
    ...(normalizedRuleIds.length ? { ruleIds: normalizedRuleIds } : {}),
    ...(normalizedCheckpointIds.length ? { checkpointIds: normalizedCheckpointIds } : {}),
  };
}
