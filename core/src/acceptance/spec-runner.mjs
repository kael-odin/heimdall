/** Bounded HTTP evidence; no browser, cookies, write requests or redirect following. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizeSpecPlan, pointerTokens, SPEC_LIMITS } from './spec-schema.mjs';
import { resolveAcceptanceUrl } from './urls.mjs';
import { validateResponseSchema, RESPONSE_SCHEMA_LIMITS } from './response-schema.mjs';
import { buildAcceptanceIdentity } from './identity.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const messageOf = error => String(error?.message ?? error).slice(0, 600);
const mimeOf = value => String(value ?? '').split(';', 1)[0].trim().toLowerCase();
const jsonMime = value => /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/i.test(value);
function safeUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, '[redacted]');
  return url.href;
}
function pointerValue(value, pointer) {
  for (const token of pointerTokens(pointer)) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, token)
        || (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(token))) return { exists: false };
    value = value[token];
  }
  return { exists: true, value };
}
function typeMatches(value, type) {
  return type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value) : typeof value === type;
}
function checkJson(value, assertions) {
  return assertions.map(assertion => {
    const actual = pointerValue(value, assertion.pointer);
    const passed = actual.exists && (assertion.kind === 'required' || (assertion.kind === 'equals' ? isDeepStrictEqual(actual.value, assertion.value)
      : assertion.kind === 'type' ? typeMatches(actual.value, assertion.type) : assertion.values.some(item => isDeepStrictEqual(item, actual.value))));
    return { ...assertion, passed, actual: actual.exists ? actual.value : '[missing]', exists: actual.exists };
  });
}
function valueSummary(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  const bytes = JSON.stringify(value);
  return { type: Array.isArray(value) ? 'array' : typeof value,
    ...(typeof value === 'string' || Array.isArray(value) ? { length: value.length } : { properties: Object.keys(value ?? {}).length }),
    sha256: digest(bytes ?? 'undefined'), detail: 'See authenticated response evidence.' };
}
function reportActual(observed) {
  const { body: _body, bodyPreview: _preview, ...actual } = observed;
  if (actual.assertions) actual.assertions = actual.assertions.map(assertion => ({ ...assertion, actual: assertion.exists ? valueSummary(assertion.actual) : '[missing]' }));
  if (actual.schemaFailures) actual.schemaFailures = actual.schemaFailures.map(failure => ({ ...failure, actual: valueSummary(failure.actual) }));
  if (actual.mismatches) actual.mismatches = actual.mismatches.map(mismatch => ['json-assertion', 'json-schema'].includes(mismatch.kind)
    ? { ...mismatch, actual: mismatch.exists === false ? '[missing]' : valueSummary(mismatch.actual) } : mismatch);
  return actual;
}
async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw Object.assign(new Error(`Response exceeds ${maxBytes} byte body budget`), { code: 'RESPONSE_BODY_BUDGET' });
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw Object.assign(new Error(`Response exceeds ${maxBytes} byte body budget`), { code: 'RESPONSE_BODY_BUDGET' });
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}
export async function runSpecAcceptance(input, { runId = randomUUID(), outputDir, onEvent } = {}) {
  const plan = normalizeSpecPlan(input);
  outputDir ??= await mkdtemp(join(tmpdir(), 'heimdall-spec-'));
  await mkdir(outputDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const deadline = Date.now() + SPEC_LIMITS.runMs;
  const checks = [];
  const planned = plan.spec.checks.length + plan.spec.omissions.length;
  const coverage = { planned, completed: 0, capped: false };
  const sourceFingerprint = digest(JSON.stringify(plan.spec.source));
  const contractFingerprint = digest(JSON.stringify(plan.spec));
  const environment = { runner: 'node-fetch', platform: process.platform, arch: process.arch, nodeVersion: process.version,
    maxResponseBytes: plan.maxResponseBytes, timeoutMs: plan.timeoutMs };
  const sourceIdentity = { id: plan.spec.source.id, revision: plan.spec.source.revision, type: plan.spec.source.type,
    sha256: plan.spec.source.sha256 ?? null };
  const event = async value => { if (onEvent) await onEvent({ ...value, runId }); };
  const add = async check => {
    checks.push(check); coverage.completed = checks.length;
    await event({ kind: 'acceptance-check', message: check.title, completed: checks.length, total: planned, route: check.route, viewport: 'api' });
  };
  const writeEvidence = async (name, value) => {
    await writeFile(join(outputDir, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    return name;
  };
  const sourceEvidence = plan.spec.document
    ? await writeEvidence('requirement-source.json', { source: plan.spec.source, document: plan.spec.document }) : null;
  const oracle = { kind: 'approved-spec', source: plan.spec.source.id, revision: plan.spec.source.revision, sourceFingerprint, documentSha256: plan.spec.source.sha256 ?? null, contractFingerprint };
  const heartbeat = setInterval(() => event({ kind: 'acceptance-heartbeat', message: 'Read-only API acceptance is running.', completed: checks.length, total: planned }).catch(() => {}), 30000);
  heartbeat.unref();
  let requests = 0;
  try {
    await event({ kind: 'acceptance-started', message: 'Starting approved read-only API contract acceptance.', completed: 0, total: planned });
    for (const [index, contract] of plan.spec.checks.entries()) {
      const prefix = `spec-${index + 1}-${contract.id}`;
      const url = resolveAcceptanceUrl(plan.targetUrl, contract.path);
      const contractDefinition = { method: contract.method, path: contract.path, expect: contract.expect };
      const identity = buildAcceptanceIdentity({ kind: 'spec', facet: 'contract', route: contract.path, contractId: contract.id,
        method: contract.method, viewport: 'api', environment,
        rule: { ...contractDefinition, timeoutMs: plan.timeoutMs, maxResponseBytes: plan.maxResponseBytes,
          runMs: SPEC_LIMITS.runMs, responseSchemaLimits: RESPONSE_SCHEMA_LIMITS, redirect: 'manual', credentials: 'omit', allowedMethods: ['GET', 'HEAD'] },
        oracle: { kind: 'spec', source: sourceIdentity, contract: contractDefinition },
      });
      const common = { id: prefix, title: contract.title, route: contract.path, viewport: 'api', dimension: 'behavior', severity: contract.severity,
        identity, oracle, evidenceLevel: 'http-reproduced', expected: contract.expect,
        reproduction: [`Use requirement ${plan.spec.source.id} at revision ${plan.spec.source.revision}.`, `${contract.method} ${safeUrl(url)} without cookies or credentials; redirects are not followed.`, 'Compare HTTP status, declared MIME and explicit JSON assertions/schema.'] };
      const evidence = { ...(sourceEvidence ? { source: sourceEvidence } : {}), contract: await writeEvidence(`${prefix}-contract.json`, { source: plan.spec.source, approved: plan.spec.approved, contract, contractFingerprint }) };
      if (!plan.spec.approved || Date.now() >= deadline) {
        if (Date.now() >= deadline) coverage.capped = true;
        await add({ ...common, oracle: { ...oracle, kind: plan.spec.approved ? 'approved-spec' : 'draft-spec' }, status: 'blocked', verdict: plan.spec.approved ? 'environment' : 'needs_review', evaluationLimited: true, actual: { requested: false, reason: plan.spec.approved ? 'Run execution budget exhausted.' : 'Requirement candidate has not been explicitly approved.' }, evidence });
        continue;
      }
      const requestEvidence = { method: contract.method, url: safeUrl(url), redirect: 'manual', credentials: 'omit', headers: { Accept: contract.expect.contentType ?? 'application/json, */*;q=0.5' } };
      evidence.request = await writeEvidence(`${prefix}-request.json`, requestEvidence);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('API request timeout')), Math.min(plan.timeoutMs, Math.max(1, deadline - Date.now())));
      let response;
      const observed = { requested: true };
      let status = 'passed', verdict = 'match';
      try {
        requests++;
        response = await fetch(url, { method: contract.method, redirect: 'manual', credentials: 'omit', headers: requestEvidence.headers, signal: controller.signal });
        observed.httpStatus = response.status;
        observed.contentType = mimeOf(response.headers.get('content-type'));
        observed.redirectNotFollowed = response.status >= 300 && response.status < 400;
        observed.hasLocation = response.headers.has('location');
        const mismatches = [];
        if (response.status !== contract.expect.status) mismatches.push({ kind: 'http-status', expected: contract.expect.status, actual: response.status });
        if (contract.expect.contentType && observed.contentType !== contract.expect.contentType) mismatches.push({ kind: 'content-type', expected: contract.expect.contentType, actual: observed.contentType });
        observed.mismatches = mismatches;
        if (mismatches.length) {
          // A known violated predicate already proves the conjunction false.
          // Do not read a huge error page to establish that HTTP 500 != 200.
          observed.bodyRead = 'not-needed-after-header-mismatch';
          await response.body?.cancel();
        } else if (contract.method !== 'HEAD') {
          const bytes = await readBoundedBody(response, plan.maxResponseBytes);
          observed.bytes = bytes.length;
          observed.bodySha256 = digest(bytes);
          const needsJson = !!contract.expect.json?.length || Object.hasOwn(contract.expect, 'schema') || jsonMime(contract.expect.contentType);
          if (needsJson) {
            let parsed;
            try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
            catch { observed.parseError = 'Response is not valid UTF-8 JSON.'; mismatches.push({ kind: 'json-syntax', expected: 'Valid UTF-8 JSON', actual: 'invalid' }); }
            if (!observed.parseError) {
              observed.body = parsed;
              observed.assertions = checkJson(parsed, contract.expect.json ?? []);
              mismatches.push(...observed.assertions.filter(assertion => !assertion.passed).map(assertion => ({ kind: 'json-assertion', ...assertion })));
              if (Object.hasOwn(contract.expect, 'schema')) {
                observed.schemaFailures = validateResponseSchema(parsed, contract.expect.schema);
                mismatches.push(...observed.schemaFailures.map(failure => ({ kind: 'json-schema', ...failure })));
              }
            } else observed.bodyPreview = bytes.toString('utf8').slice(0, 1000);
          } else observed.bodyRead = 'bounded-hash-only-no-body-assertions';
        } else observed.bodyRead = 'HEAD-has-no-body';
        if (observed.mismatches.length) { status = 'failed'; verdict = 'bug'; }
      } catch (error) {
        // A separately observed false predicate remains a proven contract defect
        // even if a later schema or transport budget cannot be fully evaluated.
        status = observed.mismatches?.length ? 'failed' : 'blocked';
        verdict = observed.mismatches?.length ? 'bug' : 'environment';
        observed.error = messageOf(error);
        observed.errorCode = error?.code ?? (controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'REQUEST_FAILED');
        observed.evaluationLimited = true;
      } finally { clearTimeout(timer); await response?.body?.cancel().catch(() => {}); }
      evidence.response = await writeEvidence(`${prefix}-response.json`, observed);
      // Full bounded JSON stays in local authenticated evidence, not the report/AI payload.
      const actual = reportActual(observed);
      await add({ ...common, status, verdict, evaluationLimited: observed.evaluationLimited === true, actual, evidence });
    }
    for (const [index, omission] of plan.spec.omissions.entries()) {
      const evidence = { ...(sourceEvidence ? { source: sourceEvidence } : {}), contract: await writeEvidence(`spec-omission-${index + 1}.json`, { source: plan.spec.source, omission, approved: plan.spec.approved }) };
      await add({ id: `spec-omission-${index + 1}`, title: `未覆盖契约：${omission.method} ${omission.path}`, route: omission.path, viewport: 'api', dimension: 'health', severity: 'medium',
        status: 'blocked', verdict: 'needs_review', oracle, evidenceLevel: 'source-confirmed', expected: 'Every declared operation has an executable, approved contract.', actual: { requested: false, reason: omission.reason }, reproduction: ['Resolve the declared unsupported requirement before approving a full API scope.'], evidence });
    }
  } finally { clearInterval(heartbeat); }
  await event({ kind: 'acceptance-completed', message: `API contract acceptance completed with ${checks.length} results.`, completed: checks.length, total: planned });
  return { schemaVersion: 1, runId, name: plan.name, mode: 'spec', targetUrl: plan.targetUrl, startedAt, endedAt: new Date().toISOString(), status: 'completed', checks, coverage,
    specSource: plan.spec.source, sourceFingerprint, contractFingerprint, specApproval: { approved: plan.spec.approved, recordedAt: startedAt },
    safety: { readOnly: true, allowedMethods: ['GET', 'HEAD'], redirects: 'not-followed', credentials: 'none', requests },
    environment,
    scope: '仅验收明确批准的 GET/HEAD 及声明的 HTTP、MIME、JSON 字段/响应 schema；不使用会话、不跟随重定向。候选、未覆盖契约、超时、超响应/验证预算均不能通过；无视觉、数据库、写操作、认证或任意业务状态机保证。来源指纹用于追溯，不代表系统已经证明原需求正确。' };
}
