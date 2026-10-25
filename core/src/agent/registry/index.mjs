/**
 * agent/registry — 能力注册表（E1-01 ~ E1-03，PRD 03 §2、附录 A §1）
 *
 * 一个能力只在这里定义一次：名称、说明、副作用等级、作用域、输入 schema、处理函数。
 * MCP 工具清单、CLI 子命令与 `--help --json`、HTTP v1 的 /capabilities 与 /tools/{name} 都由它派生，
 * 所以四个入口永远一致（E1-02、E1-03、E5-01）。
 *
 * 顺序就是 tools/list 的顺序（确定性，PRD 02 T6）。
 */
import { CapabilityError } from '../envelope.mjs';
import overview from './capabilities/overview.mjs';
import site from './capabilities/site.mjs';
import brief from './capabilities/brief.mjs';
import artifact from './capabilities/artifact.mjs';
import compare from './capabilities/compare.mjs';
import jobs from './capabilities/jobs.mjs';
import clone from './capabilities/clone.mjs';
import doctor from './capabilities/doctor.mjs';

export const EFFECTS = Object.freeze(['read', 'write-local', 'browser', 'source-network', 'destructive']);
export const SCOPES = Object.freeze(['read', 'clone', 'build', 'admin']);
export const COSTS = Object.freeze(['cheap', 'medium', 'heavy']);
const REQUIRED = ['id', 'title', 'description', 'effects', 'scope', 'idempotent', 'cost', 'input', 'handler'];

/** 校验一份能力定义（E1-01）；不合规就抛错，进不了注册表 */
export function defineCapability(def) {
  for (const key of REQUIRED) if (def[key] === undefined) throw new Error(`capability ${def.id ?? '?'}: missing ${key}`);
  if (!/^[a-z][a-z0-9_]{1,30}$/.test(def.id)) throw new Error(`capability id invalid: ${def.id}`);
  if (!Array.isArray(def.effects) || !def.effects.length || def.effects.some(e => !EFFECTS.includes(e))) throw new Error(`capability ${def.id}: bad effects`);
  if (!SCOPES.includes(def.scope)) throw new Error(`capability ${def.id}: bad scope`);
  if (!COSTS.includes(def.cost)) throw new Error(`capability ${def.id}: bad cost`);
  if (def.input?.type !== 'object') throw new Error(`capability ${def.id}: input must be an object schema`);
  if (typeof def.handler !== 'function') throw new Error(`capability ${def.id}: handler must be a function`);
  if (def.description.length > 1200) throw new Error(`capability ${def.id}: description too long`);
  return Object.freeze({ legacy: [], artifacts: [], longRunning: false, cli: {}, ...def });
}

export const CAPABILITIES = Object.freeze([overview, site, brief, artifact, compare, jobs, clone, doctor].map(defineCapability));

// 重复 id 或工具名直接拒绝（E1-01 的验收）
{
  const seen = new Set();
  for (const c of CAPABILITIES) {
    for (const name of [c.id, `heimdall_${c.id}`]) {
      if (seen.has(name)) throw new Error(`duplicate capability name: ${name}`);
      seen.add(name);
    }
  }
}

export const toolName = (cap) => `heimdall_${cap.id}`;

export function getCapability(name) {
  const id = String(name ?? '').replace(/^heimdall_/, '').replace(/-/g, '_');
  return CAPABILITIES.find(c => c.id === id) ?? null;
}

/** effects → MCP 注解（附录 A §1.3）：readOnlyHint 仅在 effects 恰为 read 时为 true */
export function annotationsOf(cap) {
  const fx = new Set(cap.effects);
  return {
    title: cap.title,
    readOnlyHint: fx.size === 1 && fx.has('read'),
    destructiveHint: fx.has('destructive'),
    idempotentHint: !!cap.idempotent,
    openWorldHint: fx.has('source-network'),
  };
}

/** 能力清单（HTTP /api/v1/capabilities、overview、CLI --help --json 共用） */
export function describeCapabilities() {
  return CAPABILITIES.map(c => ({
    id: c.id, tool: toolName(c), title: c.title, description: c.description, effects: c.effects, scope: c.scope, cost: c.cost,
    idempotent: !!c.idempotent, longRunning: c.longRunning, annotations: annotationsOf(c), input: c.input, cli: c.cli,
  }));
}

export function assertScope(cap, granted = 'admin') {
  if (SCOPES.indexOf(granted) < SCOPES.indexOf(cap.scope)) {
    throw new CapabilityError('forbidden', `${toolName(cap)} 需要 ${cap.scope} 作用域`);
  }
}
