/**
 * agent/llm — 模型档位与网关配置（PRD 05 §6、10 §4 R17）
 *
 * Heimdall 自己不写代码，重建由外部代理做；这里只解决「用哪个模型、从哪个网关、Key 放哪」。
 * 约定：
 *   · **Key 只从环境变量读**（HEIMDALL_LLM_API_KEY），任何配置、报告、账本都不写它。
 *   · 端点与模型名走 `.env`（仓库根，已 gitignore）；缺省回落到 DeepSeek 的默认值。
 *   · 三个档位 frontier / standard / economy 可以由 HEIMDALL_LLM_MODEL_<CLASS> 单独覆盖。
 *   · 结果表一律以运行记录里每条消息的 model 字段为准：网关可能改写别名（R17），不要按档位名猜模型。
 */

import { fileURLToPath } from 'node:url';

export const DEFAULT_BASE_URL = 'https://pucn.lifesecretary.com:9000/v1';
export const DEFAULT_MODEL = 'deepseek-v4.1-flash-1017';
export const CLASSES = Object.freeze(['frontier', 'standard', 'economy']);

// 仓库根的 .env 自动加载一次（存在才加载，不覆盖已有环境变量）。Key 只在那里。
loadDotEnv(fileURLToPath(new URL('../../../.env', import.meta.url)));

/** 从环境解析出可写进配置的模型信息（不含 Key） */
export function llmConfig(env = process.env) {
  const baseUrl = String(env.HEIMDALL_LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const modelOf = (cls) => env[`HEIMDALL_LLM_MODEL_${cls.toUpperCase()}`] ?? env.HEIMDALL_LLM_MODEL ?? DEFAULT_MODEL;
  return {
    provider: 'openai-compatible',
    baseUrl,
    apiKeyEnv: 'HEIMDALL_LLM_API_KEY',
    models: Object.fromEntries(CLASSES.map(c => [c, modelOf(c)])),
  };
}

/** 某个档位实际用的模型；配置里的 llm 块优先，其次环境，最后默认 */
export function modelFor(classOrConfig, env = process.env) {
  if (classOrConfig && typeof classOrConfig === 'object') {
    const { modelClass, llm } = classOrConfig;
    const fromConfig = llm?.models?.[modelClass] ?? llm?.model;
    return fromConfig ?? llmConfig(env).models[modelClass ?? 'standard'] ?? DEFAULT_MODEL;
  }
  return llmConfig(env).models[classOrConfig ?? 'standard'] ?? DEFAULT_MODEL;
}

/**
 * 读仓库根的 .env（不覆盖已有环境变量）。返回读到的键名，供 doctor 报告；
 * 文件不存在不是错误——直接用环境变量或默认值。
 */
export function loadDotEnv(file) {
  if (!file) return [];
  try {
    if (typeof process.loadEnvFile === 'function') {
      const before = new Set(Object.keys(process.env));
      process.loadEnvFile(file);
      return Object.keys(process.env).filter(k => !before.has(k));
    }
  } catch { /* 文件不存在或格式不支持：忽略 */ }
  return [];
}

/** 给报告用：有没有 Key，不返回 Key 本身 */
export function llmStatus(env = process.env) {
  const cfg = llmConfig(env);
  return { provider: cfg.provider, baseUrl: cfg.baseUrl, models: cfg.models, apiKey: env.HEIMDALL_LLM_API_KEY ? 'set' : 'missing' };
}

/**
 * 一次补全（OpenAI 兼容 /chat/completions）。Bench 的模型臂用它驱动循环。
 * 返回 { text, model, usage }；HTTP 失败抛带状态码的错误。**不重试**：评测要把失败如实记下来。
 */
export async function complete({ system, user, model, maxTokens = 8000, temperature, timeoutMs = 180_000, env = process.env } = {}) {
  const cfg = llmConfig(env);
  const key = env.HEIMDALL_LLM_API_KEY;
  if (!key) throw new Error('缺 HEIMDALL_LLM_API_KEY（放在仓库根的 .env，别写进任何配置）');
  const body = {
    model: model ?? cfg.models.standard,
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
    max_tokens: maxTokens,
    ...(temperature === undefined ? {} : { temperature }),
  };
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`模型网关返回 HTTP ${res.status}：${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`模型网关返回的不是 JSON：${text.slice(0, 200)}`); }
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('模型返回里没有 choices[0].message.content');
  return { text: content, model: json.model ?? body.model, usage: json.usage ?? null, finishReason: json.choices?.[0]?.finish_reason ?? null };
}
