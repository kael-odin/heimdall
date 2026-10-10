/**
 * llm — Heimdall 的 LLM 客户端（多协议，零依赖）
 *
 * 支持协议（LLM_PROTOCOL）：
 *   chat       OpenAI 兼容 /chat/completions（默认）
 *   responses  OpenAI /responses（Responses API）
 *   anthropic  Anthropic /messages（Claude 兼容中转）
 *
 * 配置（core/.env 或环境变量）：
 *   HEIMDALL_LLM=1
 *   LLM_BASE_URL=https://host/v1
 *   LLM_API_KEY=sk-...
 *   LLM_MODEL=glm-5.3-flash          # 主模型（fixup/语义增强）
 *   LLM_MODEL_FAST=deepseek-flash    # 快速模型（可选，默认=主模型）
 *   LLM_PROTOCOL=chat|responses|anthropic
 *   LLM_TIMEOUT_MS=180000            # 可选
 *   LLM_MAX_RETRIES=3                # 可选（仅网络层错误重试）
 *
 * 导出：llmEnabled / llmInfo / llmChat / llmVision / buildRequest / parseResponse / llmChatWith
 */
import { readFileSync } from 'node:fs';
import { getEnv } from './env.mjs';

// 每次读配置（不缓存）——控制台保存后立即生效，无需重启引擎。
// 代价是每次 LLM 调用多读一个几 KB 的文件，相对于一次网络往返可以忽略。
export function llmConfig() {
  const ENV = getEnv();
  const base = (ENV.LLM_BASE_URL ?? '').replace(/\/+$/, '');
  return {
    protocol: String(ENV.LLM_PROTOCOL ?? 'chat').toLowerCase(),
    base,
    key: ENV.LLM_API_KEY ?? '',
    model: ENV.LLM_MODEL ?? 'glm-5.3-flash',
    fastModel: ENV.LLM_MODEL_FAST || ENV.LLM_MODEL || 'glm-5.3-flash',
    timeout: Number(ENV.LLM_TIMEOUT_MS ?? 180_000),
    retries: Math.max(1, Number(ENV.LLM_MAX_RETRIES ?? 3)),
  };
}

export function llmEnabled() {
  const ENV = getEnv();
  return ENV.HEIMDALL_LLM === '1' && !!ENV.LLM_BASE_URL && !!ENV.LLM_API_KEY;
}

/** 供引擎/控制台展示的安全状态（不含 key） */
export function llmInfo() {
  const c = llmConfig();
  let baseHost = '';
  try { baseHost = new URL(c.base).host; } catch {}
  return { enabled: llmEnabled(), protocol: c.protocol, model: c.model, fastModel: c.fastModel, baseHost, hasKey: !!c.key, timeoutMs: c.timeout };
}

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n'));

function toResponsesContent(content) {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  return (content ?? []).map(p => p.type === 'image_url'
    ? { type: 'input_image', image_url: p.image_url?.url ?? '' }
    : { type: 'input_text', text: p.text ?? '' });
}
function toAnthropicContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return (content ?? []).map(p => {
    if (p.type === 'image_url') {
      const url = p.image_url?.url ?? '';
      const m = /^data:([^;]+);base64,(.*)$/.exec(url);
      return m ? { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } } : { type: 'text', text: '[image omitted]' };
    }
    return { type: 'text', text: p.text ?? '' };
  });
}

/** 构造协议请求（纯函数，便于测试） */
export function buildRequest({ protocol = 'chat', base = '', key = '', model = '', messages = [], json = false, maxTokens = 16384 } = {}) {
  const commonHeaders = { 'Content-Type': 'application/json' };
  if (protocol === 'responses') {
    const input = messages.map(m => ({ role: m.role === 'system' ? 'developer' : m.role, content: toResponsesContent(m.content) }));
    const body = { model, input, max_output_tokens: maxTokens };
    if (json) body.text = { format: { type: 'json_object' } };
    return { url: base + '/responses', headers: { ...commonHeaders, Authorization: 'Bearer ' + key }, body };
  }
  if (protocol === 'anthropic') {
    const system = messages.filter(m => m.role === 'system').map(m => textOf(m.content)).filter(Boolean).join('\n');
    const msgs = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }));
    const body = { model, max_tokens: maxTokens, messages: msgs };
    if (system) body.system = system;
    return { url: base + '/messages', headers: { ...commonHeaders, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body };
  }
  const body = { model, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  return { url: base + '/chat/completions', headers: { ...commonHeaders, Authorization: 'Bearer ' + key }, body };
}

/** 解析协议响应为文本（纯函数） */
export function parseResponse({ protocol = 'chat', data = {} } = {}) {
  if (protocol === 'responses') {
    if (typeof data.output_text === 'string' && data.output_text) return data.output_text;
    const chunks = [];
    for (const item of data.output ?? []) for (const c of item.content ?? []) if (typeof c.text === 'string') chunks.push(c.text);
    return chunks.join('\n');
  }
  if (protocol === 'anthropic') return (data.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  return data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';
}

function parseJsonLoose(content) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const raw = fence ? fence[1] : content;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  try { return JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw); }
  catch { throw new Error('LLM JSON parse failed: ' + String(content).slice(0, 200)); }
}

async function rawChat(config, messages, { json = false, maxTokens = 16384, timeout, retries } = {}) {
  const t = timeout ?? config.timeout ?? 180_000;
  const tries = retries ?? config.retries ?? 3;
  let body = buildRequest({ protocol: config.protocol, base: config.base, key: config.key, model: config.model, messages, json, maxTokens });
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      r = await fetch(body.url, { method: 'POST', headers: body.headers, body: JSON.stringify(body.body), signal: AbortSignal.timeout(t) });
      break;
    } catch (e) {
      if (attempt >= tries) {
        // 把裸的 "fetch failed" 翻译成人能读的原因 —— 控制台的「测试连接」直接展示这条
        const detail = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? String(e);
        throw new Error(`无法连接模型服务 ${body.url}（${detail}）；请检查 Base URL 是否可达、协议是否为 ${config.protocol}`);
      }
      const wait = [2000, 5000, 10000][Math.min(attempt - 1, 2)];
      console.error(`[llm] network error (attempt ${attempt}), retry in ${wait}ms:`, String(e.cause ?? e).slice(0, 120));
      await new Promise(res => setTimeout(res, wait));
    }
  }
  if (!r.ok && json && [400, 404, 415, 422].includes(r.status)) {
    // 部分中转不支持 response_format：去掉 JSON 约束重试一次（仍按 JSON 文本解析）
    body = buildRequest({ protocol: config.protocol, base: config.base, key: config.key, model: config.model, messages, json: false, maxTokens });
    r = await fetch(body.url, { method: 'POST', headers: body.headers, body: JSON.stringify(body.body), signal: AbortSignal.timeout(t) });
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const hint = r.status === 401 ? '（Key 无效或未授权）'
      : r.status === 403 ? '（无权限或被 WAF 拦截）'
        : r.status === 404 ? '（端点不存在——Base URL 是否漏了 /v1 或协议选错？）'
          : r.status === 429 ? '（触发限流）'
            : r.status >= 500 ? '（服务端错误）' : '';
    throw new Error(`模型服务返回 ${r.status}${hint}：${String(text).replace(/\s+/g, ' ').slice(0, 200)}`);
  }
  let data = await r.json();
  let text = parseResponse({ protocol: config.protocol, data });
  // 推理模型 reasoning 可能吃掉输出：content 为空时去掉 json 约束重试一次
  if (!text && json) {
    body = buildRequest({ protocol: config.protocol, base: config.base, key: config.key, model: config.model, messages, json: false, maxTokens });
    const r2 = await fetch(body.url, { method: 'POST', headers: body.headers, body: JSON.stringify(body.body), signal: AbortSignal.timeout(t) });
    if (r2.ok) text = parseResponse({ protocol: config.protocol, data: await r2.json() });
  }
  return text;
}

/** 使用显式配置调用（测试/多实例用），不做 env 读取 */
export async function llmChatWith(config, messages, opts = {}) {
  const text = await rawChat(config, messages, opts);
  return opts.json ? parseJsonLoose(text) : text;
}

export async function llmChat(messages, { json = false, maxTokens = 16384, timeout, fast = false } = {}) {
  const c = llmConfig();
  return llmChatWith({ ...c, model: fast ? c.fastModel : c.model }, messages, { json, maxTokens, timeout });
}

/** 图文混合：imagePaths 为本地 png/jpg，自动 base64；模型不支持视觉时自动降级为纯文本 */
export async function llmVision(prompt, imagePaths, { json = false, timeout, fast = false } = {}) {
  const parts = [{ type: 'text', text: prompt }];
  for (const p of imagePaths) {
    const b64 = readFileSync(p).toString('base64');
    const mime = p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  }
  try {
    return await llmChat([{ role: 'user', content: parts }], { json, timeout, fast });
  } catch (e) {
    console.error('[llm] vision call failed, falling back to text-only:', String(e).slice(0, 160));
    return llmChat([{ role: 'user', content: prompt + '\n（图片不可用：请仅依据文字与差异清单给出克制、精确的补丁）' }], { json, timeout, fast });
  }
}
