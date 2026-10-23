/** Versioned identities for checks and their independently comparable context. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { normalizeAcceptancePath } from './urls.mjs';

const VERSION = 1;
const BASE_ENVIRONMENT = ['platform', 'arch', 'nodeVersion'];
const BROWSER_ENVIRONMENT = ['browser', 'browserVersion', 'playwrightVersion', 'locale', 'timezoneId', 'colorScheme', 'reducedMotion'];
const fail = message => { throw new TypeError(message); };
const plain = value => value !== null && typeof value === 'object' && !types.isProxy(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Strict JSON data only: no coercion, toJSON hooks, omitted values or getters. */
export function canonicalAcceptanceJson(value) {
  const ancestors = new WeakSet();
  const encode = entry => {
    if (entry === null) return 'null';
    if (typeof entry === 'string' || typeof entry === 'boolean') return JSON.stringify(entry);
    if (typeof entry === 'number') return Number.isFinite(entry) ? JSON.stringify(entry) : fail('Acceptance identity requires finite JSON numbers');
    if (typeof entry !== 'object') fail('Acceptance identity requires JSON data');
    if (types.isProxy(entry)) fail('Acceptance identity does not accept proxies');
    const array = Array.isArray(entry);
    const prototype = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype && prototype !== null : !plain(entry)) fail('Acceptance identity requires plain JSON objects or arrays');
    if (ancestors.has(entry)) fail('Acceptance identity cannot contain a cycle');
    ancestors.add(entry);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      const keys = Reflect.ownKeys(descriptors);
      for (const key of keys) {
        if (typeof key !== 'string') fail('Acceptance identity cannot contain symbol keys');
        if (!Object.hasOwn(descriptors[key], 'value')) fail('Acceptance identity cannot contain accessors');
        if (!(array && key === 'length') && !descriptors[key].enumerable) fail('Acceptance identity cannot contain non-enumerable data');
      }
      if (array) {
        const length = descriptors.length.value;
        if (keys.length !== length + 1 || keys.some(key => key !== 'length'
          && (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) fail('Acceptance identity requires dense arrays without named properties');
        return '[' + Array.from({ length }, (_, index) => encode(descriptors[index].value)).join(',') + ']';
      }
      return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + encode(descriptors[key].value)).join(',') + '}';
    } finally { ancestors.delete(entry); }
  };
  return encode(value);
}

export function hashAcceptanceValue(value) {
  return createHash('sha256').update(canonicalAcceptanceJson(value)).digest('hex');
}

function own(value, key, label = key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(`${label} cannot be an accessor`);
  return descriptor.value;
}
function identifier(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,80}$/i.test(value)) fail(`${label} must use 1..80 letters, numbers, underscores or hyphens`);
  return value;
}
function environmentOf(environment, kind) {
  if (!plain(environment)) return null;
  const projected = {};
  for (const key of [...BASE_ENVIRONMENT, ...(kind === 'browser' ? BROWSER_ENVIRONMENT : [])]) {
    const value = own(environment, key, `environment.${key}`);
    if (typeof value !== 'string' || !value.trim()) return null;
    projected[key] = value;
  }
  if (kind === 'browser' && projected.browser !== 'chromium') return null;
  if (kind === 'spec') {
    const runner = own(environment, 'runner', 'environment.runner');
    if (runner !== undefined && runner !== 'node-fetch') return null;
    projected.runner = 'node-fetch';
  }
  return projected;
}

/** Missing execution identity is legacy/uncomparable; it must never imply a fix. */
export function buildAcceptanceIdentity(input) {
  if (!plain(input)) fail('Acceptance identity input must be a plain object');
  const kind = own(input, 'kind');
  if (!['browser', 'spec'].includes(kind)) fail('Acceptance identity kind must be browser or spec');
  const facet = identifier(own(input, 'facet'), 'facet');
  const route = normalizeAcceptancePath(own(input, 'route'));
  const pointId = own(input, 'pointId');
  const contractId = own(input, 'contractId');
  const method = own(input, 'method');
  const rawViewport = own(input, 'viewport');
  const subject = { version: VERSION, kind, facet, route };
  const optional = {};
  let viewport;
  if (kind === 'spec') {
    if (pointId !== undefined) fail('Spec identity cannot contain pointId');
    if (rawViewport !== 'api') fail('Spec identity viewport must be api');
    optional.contractId = subject.contractId = identifier(contractId, 'contractId');
    if (!['GET', 'HEAD'].includes(method)) fail('Spec identity method must be GET or HEAD');
    optional.method = subject.method = method;
    viewport = 'api';
  } else {
    if (contractId !== undefined || method !== undefined) fail('Browser identity cannot contain contractId or method');
    if (facet === 'behavior' && pointId === undefined) fail('Browser behavior identity requires pointId');
    if (pointId !== undefined) optional.pointId = subject.pointId = identifier(pointId, 'pointId');
    if (!plain(rawViewport)) fail('Browser identity viewport must contain positive integer width and height');
    const width = own(rawViewport, 'width', 'viewport.width');
    const height = own(rawViewport, 'height', 'viewport.height');
    if (![width, height].every(size => Number.isSafeInteger(size) && size > 0)) fail('Browser identity viewport must contain positive integer width and height');
    viewport = { width, height };
  }
  // Validate definitions even when the environment is absent, so malformed input
  // does not silently become a legacy identity.
  const ruleKey = hashAcceptanceValue(own(input, 'rule'));
  const oracleKey = hashAcceptanceValue(own(input, 'oracle'));
  const environment = environmentOf(own(input, 'environment'), kind);
  if (!environment) return null;
  const caseKey = hashAcceptanceValue(subject);
  return { version: VERSION, kind, facet, caseKey, contextKey: hashAcceptanceValue({ caseKey, viewport }),
    ruleKey, oracleKey, environmentKey: hashAcceptanceValue(environment), viewport, ...optional };
}
