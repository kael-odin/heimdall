/**
 * agent/registry/invoke — 调用一个能力：校验入参 → 执行 → 统一信封 → 脱敏 → meta（E1-06、E1-07）
 *
 * CLI、MCP、HTTP v1 都只调这一个函数，参数对错、错误码、输出形状在三处一致。
 */
import { randomBytes } from 'node:crypto';
import { fail, fromError, nextAction } from '../envelope.mjs';
import { applyDefaults, validate } from '../json-schema.mjs';
import { redactDeep } from '../redact.mjs';
import { CAPABILITIES, assertScope, getCapability, toolName } from './index.mjs';

/**
 * @param {string} name 能力 id 或工具名（heimdall_x）
 * @param {object} rawArgs
 * @param {object} ctx { client:'cli'|'mcp'|'http', scope?, jobs?, engineBase?, onProgress?, cwd? }
 */
export async function invoke(name, rawArgs = {}, ctx = {}) {
  const t0 = Date.now();
  const requestId = 'req_' + randomBytes(6).toString('hex');
  const cap = getCapability(name);
  let env;
  if (!cap) {
    env = fail('not_found', `没有能力 ${String(name).slice(0, 60)}`, {
      hint: `可用：${CAPABILITIES.map(toolName).join('、')}`,
      nextActions: [nextAction('heimdall_overview', null, '查看能做什么')],
    });
  } else {
    const args = applyDefaults(cap.input, rawArgs ?? {});
    const errors = validate(cap.input, args);
    if (errors.length) {
      env = fail('invalid_args', `${toolName(cap)} 的参数不对：${errors.slice(0, 3).map(e => `${e.path} ${e.message}`).join('；')}`, { details: { errors: errors.slice(0, 20) } });
    } else {
      try {
        assertScope(cap, ctx.scope ?? 'admin');
        env = await cap.handler(args, ctx);
      } catch (error) {
        env = fromError(error);
      }
    }
  }
  // 凭据类脱敏：网页内容与产物里混进来的令牌、密钥、JWT、本机 HEIMDALL_TOKEN（E12-02、E12-03）
  const trust = env.trust;
  const images = env._images;
  delete env._images;
  const { value, counts } = redactDeep({ ...env, trust: undefined });
  env = value;
  if (trust) env.trust = trust;
  if (Object.keys(counts).length) env.redactions = { ...(env.redactions ?? {}), ...counts };
  const tokenEstimate = Math.ceil(Buffer.byteLength(JSON.stringify(env)) / 3.5);
  env.meta = { ...(env.meta ?? {}), requestId, durationMs: Date.now() - t0, tokenEstimate, capability: cap?.id ?? null };
  if (images?.length) Object.defineProperty(env, '_images', { value: images, enumerable: false });
  return env;
}
