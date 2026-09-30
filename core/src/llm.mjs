/**
 * llm — Heimdall 的 LLM 客户端（OpenAI 兼容 /chat/completions）
 *
 * 配置来自 core/.env：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / HEIMDALL_LLM
 * llmEnabled()  是否开启 AI 增强（.env 缺失/HEIMDALL_LLM!=1 → false，流水线自动降级为纯确定性）
 * llmChat(messages, {json})  返回 content 文本；json:true 时解析并容错提取 JSON
 * llmVision(prompt, imagePaths)  图文混合（本地 png/jpg → base64）
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const env = {};
  const p = join(HERE, '..', '.env');
  if (!existsSync(p)) return env;
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}
const ENV = loadEnv();
const BASE = process.env.LLM_BASE_URL ?? ENV.LLM_BASE_URL ?? '';
const KEY = process.env.LLM_API_KEY ?? ENV.LLM_API_KEY ?? '';
const MODEL = process.env.LLM_MODEL ?? ENV.LLM_MODEL ?? 'glm-5.3-flash';
const MODEL_FAST = process.env.LLM_MODEL_FAST ?? ENV.LLM_MODEL_FAST ?? MODEL;

export const llmEnabled = () =>
  (process.env.HEIMDALL_LLM ?? ENV.HEIMDALL_LLM) === '1' && !!BASE && !!KEY;

export async function llmChat(messages, { json = false, maxTokens = 16384, timeout = 180_000, fast = false } = {}) {
  const body = { model: fast ? MODEL_FAST : MODEL, messages, max_tokens: maxTokens };
  if (json) body.response_format = { type: 'json_object' };
  // 中转链路偶发断连：网络层失败重试 3 次（2s/5s/10s 退避），HTTP 错误不重试
  let r;
  for (let attempt = 1; ; attempt++) {
    try {
      r = await fetch(BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),   // 中转站偶发半死连接会永久悬挂，必须带超时
      });
      break;
    } catch (e) {
      if (attempt >= 3) throw e;
      const wait = [2000, 5000, 10000][attempt - 1];
      console.error(`[llm] network error (attempt ${attempt}), retry in ${wait}ms:`, String(e.cause ?? e).slice(0, 120));
      await new Promise(res => setTimeout(res, wait));
    }
  }
  if (!r.ok) throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  let content = j.choices?.[0]?.message?.content ?? '';
  // 推理模型 reasoning 可能吃掉输出：content 为空时去掉 response_format 重试一次
  if (!content && json) {
    delete body.response_format;
    const r2 = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify(body),
    });
    if (r2.ok) content = (await r2.json()).choices?.[0]?.message?.content ?? '';
  }
  if (!json) return content;
  // 容错提取 JSON（模型可能包 markdown fence）
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
  const raw = fence ? fence[1] : content;
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  try { return JSON.parse(start >= 0 ? raw.slice(start, end + 1) : raw); }
  catch { throw new Error('LLM JSON parse failed: ' + content.slice(0, 200)); }
}

/** 图文混合：imagePaths 为本地 png/jpg，自动 base64 */
export async function llmVision(prompt, imagePaths, { json = false, timeout = 180_000, fast = false } = {}) {
  const parts = [{ type: 'text', text: prompt }];
  for (const p of imagePaths) {
    const b64 = readFileSync(p).toString('base64');
    const mime = p.endsWith('.jpg') || p.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    parts.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } });
  }
  return llmChat([{ role: 'user', content: parts }], { json, timeout, fast });
}
