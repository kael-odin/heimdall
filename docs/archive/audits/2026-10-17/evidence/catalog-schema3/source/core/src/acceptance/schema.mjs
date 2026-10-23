/** Declarative, bounded acceptance inputs. No arbitrary JavaScript is executed. */
import { normalizeAcceptanceUrl as urlOf, normalizeAcceptancePath as routeOf, resolveAcceptanceUrl } from './urls.mjs';
import { normalizeSpecPlan } from './spec-schema.mjs';
export { resolveAcceptanceUrl } from './urls.mjs';
export const ACCEPTANCE_SCHEMA_VERSION = 1;
export const DEFAULT_VIEWPORTS = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const text = (value, label, max = 500) => typeof value === 'string' && value.trim() && value.length <= max
  ? value.trim() : fail(`${label} must be a non-empty string (max ${max})`);
const number = (value, fallback, min, max, label) => {
  const n = value ?? fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail(`${label} must be between ${min} and ${max}`);
  return n;
};
const list = (value, fallback, max, label, min = 0) => {
  const a = value ?? fallback;
  if (!Array.isArray(a) || a.length < min || a.length > max) fail(`${label} must contain ${min}..${max} entries`);
  return a;
};
function assertionOf(raw) {
  if (!object(raw)) fail('assertion must be an object');
  const kind = raw.kind;
  if (!['visible', 'hidden', 'text', 'attribute', 'url'].includes(kind)) fail(`unsupported assertion kind: ${kind}`);
  const out = { kind };
  if (kind !== 'url') out.selector = text(raw.selector, 'assertion selector', 500);
  if (kind === 'attribute') out.attribute = text(raw.attribute, 'attribute', 100);
  if (['text', 'attribute', 'url'].includes(kind)) {
    if ((raw.equals === undefined) === (raw.contains === undefined)) fail(`${kind} requires exactly one of equals or contains`);
    const key = raw.equals !== undefined ? 'equals' : 'contains';
    if (typeof raw[key] !== 'string' || raw[key].length > 2000) fail(`${key} must be a string (max 2000)`);
    out[key] = raw[key];
  }
  return out;
}
function stepOf(raw) {
  if (!object(raw) || !['click', 'fill', 'press'].includes(raw.action)) fail('unsupported step action');
  const out = { action: raw.action, selector: text(raw.selector, 'step selector', 500) };
  if (raw.action !== 'click') {
    if (typeof raw.value !== 'string' || raw.value.length > 2000) fail('step value must be a string (max 2000)');
    out.value = raw.value;
  }
  return out;
}
export function normalizeAcceptancePlan(input) {
  if (!object(input)) fail('acceptance plan must be an object');
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) fail('unsupported acceptance schema version');
  const mode = input.mode ?? 'mirror';
  if (mode === 'spec') return normalizeSpecPlan(input);
  if (!['mirror', 'regression'].includes(mode)) fail('mode must be mirror, regression or spec');
  const baselineUrl = urlOf(input.baselineUrl, 'baselineUrl');
  const targetUrl = urlOf(input.targetUrl, 'targetUrl');
  if (baselineUrl === targetUrl) fail('baselineUrl and targetUrl must identify different entries');
  const routes = list(input.routes, ['/'], 8, 'routes', 1).map(routeOf);
  if (new Set(routes).size !== routes.length) fail('route entries must be unique');
  for (const route of routes) { resolveAcceptanceUrl(baselineUrl, route); resolveAcceptanceUrl(targetUrl, route); }
  const viewports = list(input.viewports, DEFAULT_VIEWPORTS, 3, 'viewports', 1).map(raw => {
    if (!object(raw)) fail('viewport must be an object');
    const name = text(raw.name, 'viewport name', 32);
    if (!/^[a-z0-9-]+$/i.test(name)) fail('viewport name must use letters, numbers and hyphens');
    const width = number(raw.width, undefined, 320, 1920, 'viewport width');
    const height = number(raw.height, undefined, 320, 1440, 'viewport height');
    if (!Number.isInteger(width) || !Number.isInteger(height)) fail('viewport size must use integers');
    return { name, width, height };
  });
  if (new Set(viewports.map(v => v.name)).size !== viewports.length) fail('viewport names must be unique');
  const points = list(input.points, [], 24, 'points').map(raw => {
    if (!object(raw)) fail('point must be an object');
    const id = text(raw.id, 'point id', 80);
    if (!/^[a-z0-9_-]+$/i.test(id)) fail('point id must use letters, numbers, underscores and hyphens');
    const route = routeOf(raw.route ?? '/');
    if (!routes.includes(route)) fail(`point ${id} route must be declared in routes`);
    const severity = raw.severity ?? 'high';
    if (!['critical', 'high', 'medium', 'low'].includes(severity)) fail('invalid severity');
    return { id, title: text(raw.title, 'point title', 200), route, severity,
      steps: list(raw.steps, [], 12, 'steps').map(stepOf),
      assertions: list(raw.assertions, [], 20, 'assertions', 1).map(assertionOf) };
  });
  if (new Set(points.map(p => p.id)).size !== points.length) fail('point IDs must be unique');
  if (input.normalization !== undefined && !object(input.normalization)) fail('normalization must be an object');
  if (input.thresholds !== undefined && !object(input.thresholds)) fail('thresholds must be an object');
  return { schemaVersion: 1, name: text(input.name ?? '项目还原度验收', 'name', 120), mode, baselineUrl, targetUrl,
    routes, viewports, points,
    thresholds: { visual: number(input.thresholds?.visual, 0.97, 0, 1, 'visual threshold') },
    timeoutMs: number(input.timeoutMs, 10000, 1000, 30000, 'timeoutMs'),
    settleMs: number(input.settleMs, 250, 50, 3000, 'settleMs'),
    normalization: { maskSelectors: list(input.normalization?.maskSelectors, [], 20, 'maskSelectors').map(v => text(v, 'mask selector', 500)) } };
}
