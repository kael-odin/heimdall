import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeResponseSchema, validateResponseSchema, ResponseSchemaBudgetError, RESPONSE_SCHEMA_LIMITS } from '../src/acceptance/response-schema.mjs';

const check = (value, schema) => validateResponseSchema(value, normalizeResponseSchema(schema));
const response = {
  type: 'object', required: ['code', 'data'], additionalProperties: false,
  properties: { code: { type: 'integer', const: 200 }, data: { type: ['object', 'null'], properties: { count: { type: 'integer', minimum: 0 } } } },
};

test('response contracts distinguish business success 200 from HTTP-200 business error 400', () => {
  assert.deepEqual(check({ code: 200, data: { count: 0 } }, response), []);
  const failures = check({ code: 400, data: null }, response);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0], { pointer: '/code', keyword: 'const', expected: 200, actual: 400 });
  assert.deepEqual(check({ code: 200, data: null }, response), []);
  assert.deepEqual(check({ code: 200 }, response), [{ pointer: '/data', keyword: 'required', expected: 'data', actual: { missing: true } }]);
  assert.equal(check({ code: 200, data: null, debug: false }, response)[0].keyword, 'additionalProperties');
});

test('null, false and zero retain their types and exact const/enum values without coercion', () => {
  for (const value of [null, false, 0, '', [], {}]) assert.deepEqual(check(value, true), []);
  assert.equal(check(null, false)[0].keyword, 'false');
  assert.deepEqual(check(false, { type: 'boolean', const: false }), []);
  assert.deepEqual(check(0, { type: 'integer', minimum: 0, maximum: 0 }), []);
  assert.deepEqual(check(null, { type: ['number', 'null'], minimum: 1 }), []);
  assert.equal(check(false, { type: ['number', 'null'] })[0].keyword, 'type');
  assert.equal(check('0', { type: 'number' })[0].keyword, 'type');
  assert.deepEqual(check(false, { enum: [null, false, 0] }), []);
  assert.equal(check(true, { enum: [null, false, 0] })[0].keyword, 'enum');
  assert.deepEqual(check({ b: 0, a: false }, { const: { a: false, b: 0 } }), []);
  assert.equal(check([0, false], { const: [false, 0] })[0].keyword, 'const');
});

test('nested arrays emit canonical RFC6901 pointers and preserve own dangerous-looking names', () => {
  const schema = { type: 'object', properties: {
    'a/b~c': { type: 'array', minItems: 1, maxItems: 3, items: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } }, additionalProperties: false } },
  } };
  const failures = check({ 'a/b~c': [{ id: 1 }, { id: 'wrong' }, { extra: 2 }] }, schema);
  assert.ok(failures.some(row => row.pointer === '/a~1b~0c/1/id' && row.keyword === 'type'));
  assert.ok(failures.some(row => row.pointer === '/a~1b~0c/2/id' && row.keyword === 'required'));
  assert.ok(failures.some(row => row.pointer === '/a~1b~0c/2/extra' && row.keyword === 'additionalProperties'));
  const dangerousSchema = JSON.parse('{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"boolean"}},"additionalProperties":false}');
  assert.deepEqual(check(JSON.parse('{"__proto__":false}'), dangerousSchema), []);
  assert.equal(check({ constructor: 0 }, { type: 'object', properties: {}, additionalProperties: false })[0].pointer, '/constructor');
  const inherited = Object.create({ code: 200 });
  assert.equal(check(inherited, { type: 'object', required: ['code'] })[0].keyword, 'required');
  const nonenumerable = Object.defineProperty({}, 'code', { value: 400 });
  assert.equal(check(nonenumerable, { properties: { code: { const: 200 } } })[0].actual, 400);
});

test('array and numeric bounds, Unicode string lengths and typed additional properties are enforced', () => {
  assert.equal(check([], { type: 'array', minItems: 1 })[0].keyword, 'minItems');
  assert.equal(check([1, 2], { maxItems: 1 })[0].keyword, 'maxItems');
  assert.equal(check([0], { items: false })[0].pointer, '/0');
  assert.deepEqual(check({ first: 0, second: 1 }, { additionalProperties: { type: 'integer', minimum: 0 } }), []);
  assert.equal(check({ value: -1 }, { additionalProperties: { minimum: 0 } })[0].pointer, '/value');
  assert.deepEqual(check('😀', { type: 'string', minLength: 1, maxLength: 1 }), []);
  assert.deepEqual(check('😀', { minLength: 2 })[0], { pointer: '', keyword: 'minLength', expected: 2, actual: 1 });
  assert.equal(check('😀a', { maxLength: 1 })[0].keyword, 'maxLength');
  assert.equal(check(0, { exclusiveMinimum: 0 })[0].keyword, 'exclusiveMinimum');
  assert.equal(check(1, { exclusiveMaximum: 1 })[0].keyword, 'exclusiveMaximum');
  assert.deepEqual(check(0.5, { minimum: 0, maximum: 1 }), []);
});

test('combinators count branch matches rather than accepting the first plausible schema', () => {
  const all = { allOf: [{ type: 'object', required: ['code'] }, { properties: { code: { enum: [200] } } }] };
  assert.deepEqual(check({ code: 200 }, all), []);
  assert.equal(check({ code: 400 }, all)[0].pointer, '/code');
  assert.deepEqual(check(null, { anyOf: [{ type: 'integer' }, { type: 'null' }] }), []);
  assert.equal(check(false, { anyOf: [{ type: 'integer' }, { type: 'null' }] })[0].keyword, 'anyOf');
  assert.deepEqual(check(1.5, { oneOf: [{ type: 'integer' }, { type: 'number' }] }), []);
  assert.deepEqual(check(1, { oneOf: [{ type: 'integer' }, { type: 'number' }] })[0], {
    pointer: '', keyword: 'oneOf', expected: 'exactly one matching branch', actual: { matchedBranches: 2 },
  });
  assert.equal(check('no', { oneOf: [{ type: 'integer' }, { type: 'boolean' }] })[0].actual.matchedBranches, 0);
  assert.deepEqual(check(200, { not: { const: 400 } }), []);
  assert.equal(check(400, { not: { const: 400 } })[0].keyword, 'not');
  assert.deepEqual(check('anything', { not: false }), []);
  assert.equal(check('anything', { not: true })[0].keyword, 'not');
});

test('annotations do not suppress validation, insert defaults, remove fields or coerce responses', () => {
  const schema = normalizeResponseSchema({ title: 'Envelope', description: 'Response contract', examples: [{ code: 200 }], example: null, default: false,
    type: 'object', required: ['secret', 'code'], properties: { secret: { type: 'string', writeOnly: true }, code: { type: 'integer', const: 200, readOnly: true, default: 200 } } });
  const value = { secret: false };
  const failures = validateResponseSchema(value, schema);
  assert.ok(failures.some(row => row.pointer === '/secret' && row.keyword === 'type'));
  assert.ok(failures.some(row => row.pointer === '/code' && row.keyword === 'required'));
  assert.deepEqual(value, { secret: false });
  assert.deepEqual(schema.examples, [{ code: 200 }]);
  assert.equal(schema.default, false);
});

test('unknown constraints, refs, regex and formats are rejected throughout the schema tree', () => {
  for (const [key, value] of [['$ref', 'https://example.test/schema'], ['$ref', '#/$defs/Code'], ['pattern', '^ok$'], ['format', 'email'], ['multipleOf', 2], ['unevaluatedProperties', false], ['nullable', true], ['discriminator', { propertyName: 'kind' }]]) {
    assert.throws(() => normalizeResponseSchema({ type: 'object', properties: { data: { [key]: value } } }), /unsupported keyword|format validation is unsupported/);
  }
  for (const schema of [{ type: [] }, { type: ['null', 'null'] }, { type: 'date' }, { exclusiveMinimum: true }, { minimum: Infinity }, { minLength: -1 }, { allOf: [] }, { items: [{ type: 'string' }] }, { required: ['same', 'same'] }, { readOnly: 'yes' }]) {
    assert.throws(() => normalizeResponseSchema(schema), TypeError);
  }
  assert.throws(() => normalizeResponseSchema({ allOf: new Array(1) }), /canonical indices/);
  assert.throws(() => normalizeResponseSchema({ required: new Array(1) }), /canonical indices/);
  const mutated = normalizeResponseSchema({ type: 'number' });
  mutated.pattern = '.';
  assert.throws(() => validateResponseSchema(1, mutated), /unsupported keyword pattern/);
});

test('schema depth, size and literal budgets fail explicitly rather than dropping constraints', () => {
  let deep = true;
  for (let index = 0; index < RESPONSE_SCHEMA_LIMITS.schemaDepth + 2; index++) deep = { items: deep };
  assert.throws(() => normalizeResponseSchema(deep), error => error instanceof ResponseSchemaBudgetError && error.code === 'RESPONSE_SCHEMA_BUDGET_EXCEEDED' && error.limit === 'schemaDepth');
  assert.throws(() => normalizeResponseSchema({ properties: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [String(index), true])) }), error => error.limit === 'properties');
  assert.throws(() => normalizeResponseSchema({ const: new Array(RESPONSE_SCHEMA_LIMITS.literalNodes + 1).fill(0) }), error => error instanceof ResponseSchemaBudgetError);
  assert.throws(() => normalizeResponseSchema({ enum: new Array(4).fill('x'.repeat(20_000)) }), error => error.limit === 'literalCharacters');
  const cyclic = {}; cyclic.items = cyclic;
  assert.throws(() => normalizeResponseSchema(cyclic), /cyclic schemas/);
});

test('validation failures are capped and instance/traversal exhaustion cannot return false success', () => {
  const failures = check(new Array(100).fill(false), { type: 'array', items: { type: 'string' } });
  assert.equal(failures.length, 30);
  assert.equal(failures[29].pointer, '/29');
  assert.throws(() => check(new Array(RESPONSE_SCHEMA_LIMITS.arrayItems + 1).fill(0), true), error => error instanceof ResponseSchemaBudgetError && error.limit === 'arrayItems');
  assert.throws(() => check({ a: new Array(10_000).fill(0), b: new Array(10_000).fill(0) }, true), error => error.limit === 'instanceNodes');
  assert.throws(() => check({ ['x'.repeat(5_001)]: true }, true), error => error.limit === 'instancePropertyNameLength');
  assert.throws(() => check(new Array(10_000).fill(0), { oneOf: Array.from({ length: 12 }, () => ({ type: 'array', items: { type: 'integer' } })) }), error => error instanceof ResponseSchemaBudgetError && error.limit === 'validationSteps');
  let deep = null;
  for (let index = 0; index < 66; index++) deep = [deep];
  assert.throws(() => check(deep, true), error => error.limit === 'instanceDepth');
});

test('non-JSON responses, sparse arrays, named indices and getters cannot silently satisfy contracts', () => {
  for (const value of [undefined, NaN, Infinity, 1n, () => 0]) assert.throws(() => check(value, true), /not JSON-compatible/);
  assert.throws(() => check(new Array(1), true), /canonical indices/);
  const named = [0]; named['01'] = 1;
  assert.throws(() => check(named, true), /canonical indices/);
  let getterCalls = 0;
  const withGetter = Object.defineProperty({}, 'code', { get() { getterCalls++; return 200; }, enumerable: true });
  assert.throws(() => check(withGetter, { properties: { code: { const: 200 } } }), /accessor/);
  assert.equal(getterCalls, 0);
  const cycle = []; cycle.push(cycle);
  assert.throws(() => check(cycle, true), /cyclic values/);
});
