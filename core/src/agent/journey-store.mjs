/**
 * Sanitized journey metadata readers. Raw HAR files never pass through here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';
import { CapabilityError } from './envelope.mjs';
import { assertSiteId } from './workspace.mjs';
import { normalizeJourneyMetadata } from './journey-metadata.mjs';

export const JOURNEY_ID = /^journey-[0-9]{10,}-[a-f0-9]{8}$/i;
const MAX_JOURNEY_BYTES = 256 * 1024;
const MAX_STEP_BYTES = 32 * 1024;

export function assertJourneyId(value) {
  if (typeof value !== 'string' || !JOURNEY_ID.test(value)) {
    throw new CapabilityError('invalid_args', 'journeyId 不合法');
  }
  return value;
}

export function journeyRoot(siteId) {
  return join(WORKSPACE, assertSiteId(siteId), 'agent', 'journeys');
}

function readJson(file, maxBytes) {
  try {
    if (statSync(file).size > maxBytes) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch { return null; }
}

function safeString(value, max = 240) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max) : null;
}

function projectJourney(value, siteId, journeyId) {
  if (!value || typeof value !== 'object' || value.schema !== 'heimdall.journey/1') return null;
  const result = {
    schema: value.schema,
    id: journeyId,
    siteId,
    origin: safeString(value.origin, 2048),
    startedAt: safeString(value.startedAt, 64),
    finishedAt: safeString(value.finishedAt, 64),
    ...(typeof value.status === 'string' && ['recorded'].includes(value.status) ? { status: value.status } : {}),
    steps: Number.isSafeInteger(value.steps) && value.steps >= 0 ? value.steps : 0,
    network: value.network && typeof value.network === 'object' ? {
      sanitizedEntries: Number.isSafeInteger(value.network.sanitizedEntries) && value.network.sanitizedEntries >= 0 ? value.network.sanitizedEntries : 0,
      apiEntries: Number.isSafeInteger(value.network.apiEntries) && value.network.apiEntries >= 0 ? value.network.apiEntries : 0,
      excluded: Number.isSafeInteger(value.network.excluded) && value.network.excluded >= 0 ? value.network.excluded : 0,
    } : { sanitizedEntries: 0, apiEntries: 0, excluded: 0 },
    contract: value.contract && typeof value.contract === 'object' ? {
      status: ['observed', 'no_observed_api'].includes(value.contract.status) ? value.contract.status : 'unknown',
      tier: safeString(value.contract.tier, 16),
      endpoints: Number.isSafeInteger(value.contract.endpoints) && value.contract.endpoints >= 0 ? value.contract.endpoints : 0,
      ...(value.contract.path === 'api-contract.json' ? { path: value.contract.path } : {}),
    } : { status: 'unknown', tier: null, endpoints: 0 },
  };
  Object.assign(result, normalizeJourneyMetadata({ actor: value.actor, ruleIds: value.ruleIds, checkpointIds: value.checkpointIds }));
  const name = safeString(value.name, 120);
  if (name) result.name = name;
  return result;
}

function stepFiles(dir) {
  try {
    return readdirSync(join(dir, 'steps')).filter(name => /^\d{4}\.json$/.test(name)).sort();
  } catch { return []; }
}

export function listJourneys(siteId, limit = 100) {
  const root = journeyRoot(siteId);
  if (!existsSync(root)) return [];
  const max = Math.max(1, Math.min(100, Number(limit) || 100));
  return readdirSync(root).filter(name => JOURNEY_ID.test(name)).map(journeyId => {
    const dir = join(root, journeyId);
    return projectJourney(readJson(join(dir, 'journey.json'), MAX_JOURNEY_BYTES), siteId, journeyId);
  }).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, max);
}

export function readJourney(siteId, journeyId, { includeSteps = true, limit = 500 } = {}) {
  assertJourneyId(journeyId);
  const dir = join(journeyRoot(siteId), journeyId);
  const journey = projectJourney(readJson(join(dir, 'journey.json'), MAX_JOURNEY_BYTES), siteId, journeyId);
  if (!journey) return null;
  if (!includeSteps) return { journey, steps: [] };
  const max = Math.max(1, Math.min(500, Number(limit) || 500));
  const steps = stepFiles(dir).slice(0, max).map(name => readJson(join(dir, 'steps', name), MAX_STEP_BYTES)).filter(Boolean);
  return { journey, steps };
}
