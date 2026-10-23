/** Auditable JSON Schema subset. Unsupported keywords are rejected, never ignored. */
export const RESPONSE_SCHEMA_LIMITS = Object.freeze({
  schemaDepth: 16, schemaNodes: 256, properties: 128, required: 128,
  branches: 12, enumValues: 64, literalDepth: 16, literalNodes: 2_000,
  schemaStringLength: 20_000, literalCharacters: 64_000, instanceDepth: 64, instanceNodes: 20_000,
  objectProperties: 5_000, arrayItems: 10_000, instanceStringLength: 1_000_000,
  instancePropertyNameLength: 5_000, validationSteps: 100_000, failures: 30,
});
const TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const ANNOTATIONS = new Set(['title', 'description', 'example', 'examples', 'default', 'readOnly', 'writeOnly']);
const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
  'allOf', 'anyOf', 'oneOf', 'not', ...ANNOTATIONS]);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const pointerAt = (pointer, key) => `${pointer}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const plainObject = value => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

export class ResponseSchemaBudgetError extends Error {
  constructor(limit, pointer = '') {
    super(`Response schema budget exceeded: ${limit} at ${pointer || '(root)'}`);
    this.name = 'ResponseSchemaBudgetError';
    this.code = 'RESPONSE_SCHEMA_BUDGET_EXCEEDED';
    this.limit = limit;
    this.pointer = pointer;
  }
}

const schemaError = (pointer, message) => { throw new TypeError(`Invalid response schema at ${pointer || '(root)'}: ${message}`); };
function ownValue(container, key, pointer, fail = schemaError) {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (!descriptor || !hasOwn(descriptor, 'value')) fail(pointer, 'accessor properties are unsupported');
  return descriptor.value;
}
function denseValues(array, pointer, max, min = 0) {
  if (!Array.isArray(array) || array.length < min || array.length > max) schemaError(pointer, `array must contain ${min}..${max} entries`);
  const keys = Reflect.ownKeys(array).filter(key => key !== 'length');
  if (keys.length !== array.length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= array.length)) schemaError(pointer, 'arrays require own canonical indices without holes or named properties');
  return Array.from({ length: array.length }, (_, index) => ownValue(array, String(index), pointerAt(pointer, index)));
}

/** No refs, regex, format, coercion, default insertion or property removal. */
export function normalizeResponseSchema(schema) {
  let nodes = 0, literalNodes = 0, literalCharacters = 0;
  const ancestors = new WeakSet();
  const literalAncestors = new WeakSet();
  const literal = (value, pointer, depth = 0) => {
    if (++literalNodes > RESPONSE_SCHEMA_LIMITS.literalNodes) throw new ResponseSchemaBudgetError('literalNodes', pointer);
    if (depth > RESPONSE_SCHEMA_LIMITS.literalDepth) throw new ResponseSchemaBudgetError('literalDepth', pointer);
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= RESPONSE_SCHEMA_LIMITS.schemaStringLength) {
      literalCharacters += value.length;
      if (literalCharacters > RESPONSE_SCHEMA_LIMITS.literalCharacters) throw new ResponseSchemaBudgetError('literalCharacters', pointer);
      return value;
    }
    if (typeof value !== 'object' || value === null) schemaError(pointer, 'value must be bounded JSON data');
    if (literalAncestors.has(value)) schemaError(pointer, 'cyclic JSON data is unsupported');
    literalAncestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > RESPONSE_SCHEMA_LIMITS.literalNodes) throw new ResponseSchemaBudgetError('literalNodes', pointer);
        return denseValues(value, pointer, RESPONSE_SCHEMA_LIMITS.literalNodes).map((child, index) => literal(child, pointerAt(pointer, index), depth + 1));
      }
      if (!plainObject(value)) schemaError(pointer, 'JSON objects must have a plain or null prototype');
      const keys = Reflect.ownKeys(value);
      if (keys.length > RESPONSE_SCHEMA_LIMITS.literalNodes) throw new ResponseSchemaBudgetError('literalNodes', pointer);
      return Object.fromEntries(keys.map(key => {
        if (typeof key !== 'string' || key.length > RESPONSE_SCHEMA_LIMITS.schemaStringLength) schemaError(pointer, 'literal property names must be bounded strings');
        literalCharacters += key.length;
        if (literalCharacters > RESPONSE_SCHEMA_LIMITS.literalCharacters) throw new ResponseSchemaBudgetError('literalCharacters', pointer);
        return [key, literal(ownValue(value, key, pointerAt(pointer, key)), pointerAt(pointer, key), depth + 1)];
      }));
    } finally { literalAncestors.delete(value); }
  };
  const visit = (value, pointer = '', depth = 0) => {
    if (++nodes > RESPONSE_SCHEMA_LIMITS.schemaNodes) throw new ResponseSchemaBudgetError('schemaNodes', pointer);
    if (depth > RESPONSE_SCHEMA_LIMITS.schemaDepth) throw new ResponseSchemaBudgetError('schemaDepth', pointer);
    if (typeof value === 'boolean') return value;
    if (!plainObject(value)) schemaError(pointer, 'schema must be a boolean or a plain object');
    if (ancestors.has(value)) schemaError(pointer, 'cyclic schemas are unsupported');
    ancestors.add(value);
    try {
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key === 'string' && key.length > 500) schemaError(pointer, 'keyword names must be bounded strings');
        if (typeof key !== 'string' || !KEYWORDS.has(key)) {
          schemaError(pointerAt(pointer, String(key)), key === 'format'
            ? 'format validation is unsupported; it is not silently treated as an annotation'
            : `unsupported keyword ${String(key)}; refs, regex and unknown validation keywords are rejected`);
        }
      }
      const entries = keys.map(key => {
        const current = pointerAt(pointer, key);
        const raw = ownValue(value, key, current);
        if (key === 'type') {
          const types = Array.isArray(raw) ? denseValues(raw, current, TYPES.size, 1) : [raw];
          if (!types.length || types.length > TYPES.size || types.some(type => !TYPES.has(type)) || new Set(types).size !== types.length) schemaError(current, 'type must name a supported JSON type or a unique nonempty type union');
          return [key, Array.isArray(raw) ? [...types] : raw];
        }
        if (key === 'properties') {
          if (!plainObject(raw)) schemaError(current, 'properties must be an object');
          const propertyKeys = Reflect.ownKeys(raw);
          if (propertyKeys.length > RESPONSE_SCHEMA_LIMITS.properties) throw new ResponseSchemaBudgetError('properties', current);
          return [key, Object.fromEntries(propertyKeys.map(name => {
            if (typeof name !== 'string' || name.length > 500) schemaError(current, 'property names must be strings of at most 500 UTF-16 units');
            const childPointer = pointerAt(current, name);
            return [name, visit(ownValue(raw, name, childPointer), childPointer, depth + 1)];
          }))];
        }
        if (key === 'required') {
          const names = denseValues(raw, current, RESPONSE_SCHEMA_LIMITS.required);
          if (names.some(name => typeof name !== 'string' || name.length > 500) || new Set(names).size !== names.length) schemaError(current, 'required must contain unique bounded property names');
          return [key, names];
        }
        if (['items', 'additionalProperties', 'not'].includes(key)) return [key, visit(raw, current, depth + 1)];
        if (['allOf', 'anyOf', 'oneOf'].includes(key)) {
          return [key, denseValues(raw, current, RESPONSE_SCHEMA_LIMITS.branches, 1).map((child, index) => visit(child, pointerAt(current, index), depth + 1))];
        }
        if (['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key)) {
          if (!Number.isSafeInteger(raw) || raw < 0) schemaError(current, 'bound must be a nonnegative safe integer');
          return [key, raw];
        }
        if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'].includes(key)) {
          if (typeof raw !== 'number' || !Number.isFinite(raw)) schemaError(current, 'numeric bound must be finite; exclusive bounds use numeric semantics');
          return [key, raw];
        }
        if (key === 'enum') {
          return [key, literal(denseValues(raw, current, RESPONSE_SCHEMA_LIMITS.enumValues, 1), current)];
        }
        if (['title', 'description'].includes(key) && typeof raw !== 'string') schemaError(current, 'annotation must be a string');
        if (['readOnly', 'writeOnly'].includes(key) && typeof raw !== 'boolean') schemaError(current, 'annotation must be boolean');
        if (key === 'examples' && !Array.isArray(raw)) schemaError(current, 'examples annotation must be an array');
        return [key, literal(raw, current)];
      });
      return Object.fromEntries(entries);
    } finally { ancestors.delete(value); }
  };
  return visit(schema);
}

function actualSummary(value) {
  if (typeof value === 'string') return value.length <= 256 ? value : value.slice(0, 256) + '…';
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (object(value)) {
    const keys = Object.getOwnPropertyNames(value);
    if (keys.length <= 8 && keys.every(key => value[key] === null || ['number', 'boolean'].includes(typeof value[key]) || typeof value[key] === 'string' && value[key].length <= 256)) return value;
    return { type: 'object', properties: keys.slice(0, 20) };
  }
  return value;
}
const matchesType = (value, type) => {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return object(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
};

/** Returns at most 30 failures. Exhausted work budgets throw; they never return []. */
export function validateResponseSchema(value, normalizedSchema) {
  // Re-check after JSON persistence or caller mutation; unsupported constraints cannot disappear.
  const schema = normalizeResponseSchema(normalizedSchema);
  let instanceNodes = 0, validationSteps = 0;
  const ancestors = new WeakSet();
  const instanceError = (pointer, message) => { throw new TypeError(`Response is not JSON-compatible at ${pointer || '(root)'}: ${message}`); };
  const preflight = (current, pointer = '', depth = 0) => {
    if (++instanceNodes > RESPONSE_SCHEMA_LIMITS.instanceNodes) throw new ResponseSchemaBudgetError('instanceNodes', pointer);
    if (depth > RESPONSE_SCHEMA_LIMITS.instanceDepth) throw new ResponseSchemaBudgetError('instanceDepth', pointer);
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current === 'string') {
      if (current.length > RESPONSE_SCHEMA_LIMITS.instanceStringLength) throw new ResponseSchemaBudgetError('instanceStringLength', pointer);
      return;
    }
    if (typeof current !== 'object' || current === null) instanceError(pointer, 'only null, booleans, finite numbers, strings, objects and arrays are supported');
    if (ancestors.has(current)) instanceError(pointer, 'cyclic values are unsupported');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (current.length > RESPONSE_SCHEMA_LIMITS.arrayItems) throw new ResponseSchemaBudgetError('arrayItems', pointer);
        const keys = Reflect.ownKeys(current).filter(key => key !== 'length');
        if (keys.length !== current.length || keys.some(key => typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length)) instanceError(pointer, 'arrays require own canonical indices without holes or named properties');
        for (let index = 0; index < current.length; index++) preflight(ownValue(current, String(index), pointerAt(pointer, index), instanceError), pointerAt(pointer, index), depth + 1);
      } else {
        const keys = Reflect.ownKeys(current);
        if (keys.length > RESPONSE_SCHEMA_LIMITS.objectProperties) throw new ResponseSchemaBudgetError('objectProperties', pointer);
        for (const key of keys) {
          if (typeof key !== 'string') instanceError(pointer, 'symbol keys are unsupported');
          if (key.length > RESPONSE_SCHEMA_LIMITS.instancePropertyNameLength) throw new ResponseSchemaBudgetError('instancePropertyNameLength', pointer);
          preflight(ownValue(current, key, pointerAt(pointer, key), instanceError), pointerAt(pointer, key), depth + 1);
        }
      }
    } finally { ancestors.delete(current); }
  };
  preflight(value);
  const spend = pointer => { if (++validationSteps > RESPONSE_SCHEMA_LIMITS.validationSteps) throw new ResponseSchemaBudgetError('validationSteps', pointer); };
  const equal = (a, b, pointer) => {
    spend(pointer);
    if (a === b) return true;
    if (a === null || b === null || typeof a !== typeof b || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keysA = Array.isArray(a) ? Object.keys(a) : Object.getOwnPropertyNames(a);
    const keysB = Array.isArray(b) ? Object.keys(b) : Object.getOwnPropertyNames(b);
    return keysA.length === keysB.length && keysA.every(key => hasOwn(b, key) && equal(a[key], b[key], pointerAt(pointer, key)));
  };
  const failure = (rows, pointer, keyword, expected, actual) => {
    if (rows.length < RESPONSE_SCHEMA_LIMITS.failures) rows.push({ pointer, keyword, expected, actual: actualSummary(actual) });
    return false;
  };
  const evaluate = (current, rule, pointer, rows) => {
    spend(pointer);
    if (rule === true) return true;
    if (rule === false) return failure(rows, pointer, 'false', false, current);
    if (hasOwn(rule, 'type')) {
      const types = Array.isArray(rule.type) ? rule.type : [rule.type];
      if (!types.some(type => matchesType(current, type))) return failure(rows, pointer, 'type', rule.type, current);
    }
    let valid = true;
    const fail = (keyword, expected, actual, at = pointer) => { valid = false; failure(rows, at, keyword, expected, actual); };
    if (hasOwn(rule, 'const') && !equal(current, rule.const, pointer)) fail('const', rule.const, current);
    if (rule.enum && !rule.enum.some(candidate => equal(current, candidate, pointer))) fail('enum', rule.enum, current);
    if (typeof current === 'number') {
      for (const [keyword, test] of [['minimum', (a, b) => a >= b], ['maximum', (a, b) => a <= b], ['exclusiveMinimum', (a, b) => a > b], ['exclusiveMaximum', (a, b) => a < b]]) {
        if (hasOwn(rule, keyword) && !test(current, rule[keyword])) fail(keyword, rule[keyword], current);
      }
    }
    if (typeof current === 'string' && (hasOwn(rule, 'minLength') || hasOwn(rule, 'maxLength'))) {
      let length = 0;
      for (const _character of current) { spend(pointer); length++; }
      if (hasOwn(rule, 'minLength') && length < rule.minLength) fail('minLength', rule.minLength, length);
      if (hasOwn(rule, 'maxLength') && length > rule.maxLength) fail('maxLength', rule.maxLength, length);
    }
    if (Array.isArray(current)) {
      if (hasOwn(rule, 'minItems') && current.length < rule.minItems) fail('minItems', rule.minItems, current.length);
      if (hasOwn(rule, 'maxItems') && current.length > rule.maxItems) fail('maxItems', rule.maxItems, current.length);
      if (hasOwn(rule, 'items')) for (let index = 0; index < current.length; index++) {
        if (rows.length >= RESPONSE_SCHEMA_LIMITS.failures) return false;
        if (!evaluate(current[index], rule.items, pointerAt(pointer, index), rows)) valid = false;
      }
    } else if (object(current)) {
      for (const key of rule.required ?? []) {
        spend(pointer);
        if (!hasOwn(current, key)) fail('required', key, { missing: true }, pointerAt(pointer, key));
        if (rows.length >= RESPONSE_SCHEMA_LIMITS.failures) return false;
      }
      for (const key of Object.getOwnPropertyNames(current)) {
        spend(pointer);
        if (rows.length >= RESPONSE_SCHEMA_LIMITS.failures) return false;
        if (hasOwn(rule.properties ?? {}, key)) {
          if (!evaluate(current[key], rule.properties[key], pointerAt(pointer, key), rows)) valid = false;
        } else if (rule.additionalProperties === false) fail('additionalProperties', false, current[key], pointerAt(pointer, key));
        else if (hasOwn(rule, 'additionalProperties') && rule.additionalProperties !== true) {
          if (!evaluate(current[key], rule.additionalProperties, pointerAt(pointer, key), rows)) valid = false;
        }
      }
    }
    if (rows.length >= RESPONSE_SCHEMA_LIMITS.failures) return false;
    if (rule.allOf) for (const child of rule.allOf) {
      if (!evaluate(current, child, pointer, rows)) valid = false;
      if (rows.length >= RESPONSE_SCHEMA_LIMITS.failures) return false;
    }
    if (rule.anyOf && !rule.anyOf.some(child => evaluate(current, child, pointer, []))) fail('anyOf', 'at least one matching branch', current);
    if (rule.oneOf) {
      const matched = rule.oneOf.filter(child => evaluate(current, child, pointer, [])).length;
      if (matched !== 1) fail('oneOf', 'exactly one matching branch', { matchedBranches: matched });
    }
    if (hasOwn(rule, 'not') && evaluate(current, rule.not, pointer, [])) fail('not', 'sub-schema must not match', current);
    return valid;
  };
  const failures = [];
  evaluate(value, schema, '', failures);
  return failures;
}
