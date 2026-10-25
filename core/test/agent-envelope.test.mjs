/**
 * agent 信封、错误码、ID 与 JSON Schema 校验（E1-01、E1-06、E3-03）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERRORS, CapabilityError, exitCodeOf, fail, fromError, httpStatusOf, ok } from '../src/agent/envelope.mjs';
import { JOB_ID, RUN_ID, SECTION_ID, newJobId, newRunId, sectionIdOf } from '../src/agent/ids.mjs';
import { applyDefaults, validate } from '../src/agent/json-schema.mjs';

test('envelope: every error code maps to an HTTP status, an exit code and an actionable hint', () => {
  for (const [code, e] of Object.entries(ERRORS)) {
    // queued 是状态不是失败（附录 A §1.5）：202；其余都是 4xx / 5xx
    assert.ok(Number.isInteger(e.http) && (code === 'queued' ? e.http === 202 : e.http >= 400), code + ' http');
    assert.ok(Number.isInteger(e.exit) && e.exit >= 0 && e.exit <= 7, code + ' exit');
    assert.ok(e.hint.length > 8, code + ' hint');
  }
});

test('envelope: ok() and fail() always carry summary and nextActions', () => {
  const o = ok({ x: 1 }, { summary: '完成。' });
  assert.equal(o.ok, true); assert.deepEqual(o.nextActions, []); assert.deepEqual(o.evidence, []);
  const f = fail('reference_missing', '还没有镜像', { nextActions: [{ tool: 'heimdall_clone', reason: '先克隆' }] });
  assert.equal(f.ok, false); assert.equal(f.error.code, 'reference_missing'); assert.equal(f.error.hint, ERRORS.reference_missing.hint);
  assert.equal(exitCodeOf(f), 2); assert.equal(httpStatusOf(f), 412);
});

test('envelope: exit codes follow the documented table', () => {
  assert.equal(exitCodeOf(ok({})), 0);
  assert.equal(exitCodeOf(ok({ gateFailed: true })), 1);
  assert.equal(exitCodeOf(ok({ timedOut: true })), 4);
  assert.equal(exitCodeOf(ok({ status: 'queued' })), 4);
  assert.equal(exitCodeOf(fail('unauthorized', 'x')), 5);
  assert.equal(exitCodeOf(fail('internal', 'x')), 7);
  assert.equal(exitCodeOf(null), 7);
});

test('envelope: unknown errors become internal and keep only the first line (no stack trace)', () => {
  const err = new Error('boom: first line\n    at secretFrame (D:/internal/file.mjs:1:1)');
  const e = fromError(err);
  assert.equal(e.error.code, 'internal');
  assert.match(e.error.message, /first line/);
  assert.ok(!e.error.message.includes('secretFrame'), 'stack frames are not passed to the agent');
  assert.ok(e.error.message.length <= 300);
  const c = fromError(new CapabilityError('not_found', '没有站点'));
  assert.equal(c.error.code, 'not_found');
});

test('ids: run / job / section ids match their formats and section ids are stable', () => {
  const run = newRunId(); assert.match(run, RUN_ID);
  const job = newJobId(); assert.match(job, JOB_ID);
  const sec = sectionIdOf('example.org', 'home', 'body > section:nth-of-type(1)', 'hero');
  assert.match(sec, SECTION_ID);
  assert.equal(sec, sectionIdOf('example.org', 'home', 'body > section:nth-of-type(1)', 'hero'));
  assert.notEqual(sec, sectionIdOf('example.org', 'home', 'body > section:nth-of-type(2)', 'hero'));
});

test('json-schema: validates types, enums, ranges, required fields and unknown keys', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['a'],
    properties: { a: { type: 'string', minLength: 2 }, b: { type: 'integer', minimum: 1, maximum: 3 }, c: { type: 'array', items: { type: 'string' } },
      d: { type: 'string', enum: ['x', 'y'] } } };
  assert.deepEqual(validate(schema, { a: 'ok' }), []);
  assert.equal(validate(schema, {}).length, 1);
  assert.match(validate(schema, { a: 'ok', b: 5 })[0].message, /至多 3/);
  assert.match(validate(schema, { a: 'ok', z: 1 })[0].message, /未知参数/);
  assert.match(validate(schema, { a: 'ok', d: 'n' })[0].message, /取值/);
  assert.deepEqual(applyDefaults({ type: 'object', properties: { n: { type: 'integer', default: 3 } } }, {}), { n: 3 });
});
