import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FLOWS = 100;
const MAX_ACTIONS = 11;
const MAX_ASSERTIONS = 5;
const SESSION_NAME = /^[a-z0-9_-]{1,64}$/i;

function localPath(value, origin) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')
    || value.includes('\\') || value.length > 2048) return null;
  try {
    const url = new URL(value, origin);
    return url.origin === origin ? url.pathname + url.search : null;
  } catch { return null; }
}

function validSelector(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function validAction(action, origin) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  if (action.type === 'navigate') return !!localPath(action.url, origin);
  if (action.type === 'useSession') return validSessionName(action.sessionName);
  if (action.type === 'click') return validSelector(action.selector);
  if (action.type === 'fill') return validSelector(action.selector)
    && typeof action.value === 'string' && action.value.length <= 10_000;
  if (action.type === 'scroll') return Number.isInteger(action.y) && Math.abs(action.y) <= 10_000;
  return false;
}

function validAssertion(assertion, origin) {
  if (!assertion || typeof assertion !== 'object' || Array.isArray(assertion)) return false;
  if (assertion.type === 'visible' || assertion.type === 'hidden') return validSelector(assertion.selector);
  if (assertion.type === 'text-includes') return validSelector(assertion.selector)
    && typeof assertion.value === 'string' && assertion.value.length > 0 && assertion.value.length <= 200;
  if (assertion.type === 'url') return !!localPath(assertion.path, origin);
  return false;
}

function validSessionName(value) {
  return value == null || (typeof value === 'string' && SESSION_NAME.test(value));
}

/** The plan stays in workspace; only redacted probe results enter the bundle. */
export function readOperationPlan(baseDir, origin, pageRoutes) {
  let source;
  try { source = readFileSync(join(baseDir, 'operation-plan.json'), 'utf8'); }
  catch (error) {
    return error?.code === 'ENOENT'
      ? { status: 'missing', flows: [] }
      : { status: 'invalid', issue: 'unreadable-plan', flows: [] };
  }
  let plan;
  try { plan = JSON.parse(source); }
  catch { return { status: 'invalid', issue: 'invalid-json', flows: [] }; }
  if (plan?.version !== 1 || !Array.isArray(plan.flows) || plan.flows.length > MAX_FLOWS) {
    return { status: 'invalid', issue: 'invalid-flows', flows: [] };
  }
  const routes = new Set(pageRoutes);
  for (const flow of plan.flows) {
    const path = localPath(flow?.path, origin);
    if (!path || !routes.has(path)) return { status: 'invalid', issue: 'unbundled-route', flows: [] };
    if (!Array.isArray(flow.actions) || flow.actions.length > MAX_ACTIONS
      || !flow.actions.every(action => validAction(action, origin))) {
      return { status: 'invalid', issue: 'invalid-actions', flows: [] };
    }
    if (!Array.isArray(flow.expect) || flow.expect.length < 1 || flow.expect.length > MAX_ASSERTIONS
      || !flow.expect.every(assertion => validAssertion(assertion, origin))) {
      return { status: 'invalid', issue: 'invalid-assertions', flows: [] };
    }
    if (!validSessionName(flow.sessionName)) {
      return { status: 'invalid', issue: 'invalid-session-name', flows: [] };
    }
  }
  return { status: 'ok', flows: plan.flows };
}
