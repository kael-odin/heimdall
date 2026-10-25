/**
 * agent/json-schema — 注册表入参校验用的 JSON Schema 子集（E1-01）
 *
 * 核心包不引入依赖（PRD 02 P3、E2-01），所以这里只实现能力定义用得到的子集：
 * type（含数组）、enum、const、properties、required、additionalProperties:false、items、
 * minimum / maximum、minLength / maxLength、pattern、minItems / maxItems、default。
 * CLI、MCP、HTTP 三个外壳都走同一个 validate()，同一份参数在三处的对错一致。
 */
const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
const matchesType = (v, t) => t === 'number' ? typeof v === 'number' && Number.isFinite(v) : t === 'integer' ? Number.isInteger(v) : typeOf(v) === t || (t === 'number' && typeOf(v) === 'integer');

/** 返回错误数组：[{ path, message }]；空数组 = 通过 */
export function validate(schema, value, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(t => matchesType(value, t))) {
      errors.push({ path, message: `应为 ${types.join(' | ')}，实际是 ${typeOf(value)}` });
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push({ path, message: `应为 ${JSON.stringify(schema.const)}` });
  if (schema.enum && !schema.enum.includes(value)) errors.push({ path, message: `取值应为 ${schema.enum.map(v => JSON.stringify(v)).join(' / ')}` });
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push({ path, message: `长度至少 ${schema.minLength}` });
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push({ path, message: `长度至多 ${schema.maxLength}` });
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push({ path, message: '格式不符' });
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `至少 ${schema.minimum}` });
    if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `至多 ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push({ path, message: `至少 ${schema.minItems} 项` });
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push({ path, message: `至多 ${schema.maxItems} 项` });
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    for (const key of schema.required ?? []) if (value[key] === undefined) errors.push({ path: `${path}.${key}`, message: '必填' });
    const props = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) validate(props[key], v, `${path}.${key}`, errors);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: '未知参数' });
    }
  }
  return errors;
}

/** 按 schema 的 default 补齐缺省值（只补顶层与对象属性，不改原对象） */
export function applyDefaults(schema, value) {
  if (!schema || typeOf(value ?? {}) !== 'object' || schema.type !== 'object') return value;
  const out = { ...(value ?? {}) };
  for (const [key, prop] of Object.entries(schema.properties ?? {})) {
    if (out[key] === undefined && prop.default !== undefined) out[key] = structuredClone(prop.default);
  }
  return out;
}
