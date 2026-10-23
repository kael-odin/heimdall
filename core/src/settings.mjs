/**
 * settings — 运行时可改的配置（当前只有模型服务）
 *
 * 存储：**直接读写 `core/.env`**（就一个真相源，已是 gitignore）。
 *   - 保留原有注释与未知键，只在原位改值；新键追加到末尾
 *   - **Key 永不回显**：接口只给 hasKey + 末 4 位提示
 *   - 进程环境变量优先于 .env（Node 常规约定）；若某键被 shell 里的环境变量遮蔽，
 *     接口会把它列进 `shadowed`，让控制台能明确提示"改了不生效，因为环境变量占着"
 *
 * 生效：`env.mjs` 不再缓存、`llm.mjs` 每次调用重读配置 —— 控制台保存后**立即生效，无需重启**。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORE, envFilePath } from './env.mjs';

// 路径每次现算：HEIMDALL_ENV_FILE 可在进程内变更（单测隔离 / 容器挂载配置）
export const envFile = () => envFilePath();
const envExample = () => join(CORE, '.env.example');

export const PROTOCOLS = ['chat', 'responses', 'anthropic'];

/** 允许控制台写入的键（白名单：其余键一律拒绝，避免把启动期配置改坏） */
export const WRITABLE = new Set([
  'HEIMDALL_LLM', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LLM_MODEL_FAST',
  'LLM_PROTOCOL', 'LLM_TIMEOUT_MS', 'LLM_MAX_RETRIES',
]);

/** 只读展示的引擎配置（改这些要重启，故意不在控制台改） */
export const READONLY_KEYS = [
  'HEIMDALL_HOST', 'HEIMDALL_TOKEN', 'HEIMDALL_CORS_ORIGIN', 'HEIMDALL_ALLOWED_HOSTS',
  'HEIMDALL_DATA_DIR', 'HEIMDALL_CONSOLE_DIR', 'FIXUP_MIN_STATIC', 'FIXUP_MIN_REFINABLE',
];

const SECRET_KEYS = new Set(['LLM_API_KEY', 'HEIMDALL_TOKEN']);

/** 解析 .env 为有序行，保留注释与空行（写回时逐行还原） */
function parseLines(text) {
  return text.split(/\r?\n/).map((raw) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(raw);
    return { raw, key: m ? m[1] : null, value: m ? m[2] : null };
  });
}

/** 读 core/.env（只读文件本身，不含 process.env） */
export function readEnvFile() {
  const file = envFile();
  if (!existsSync(file)) return { exists: false, entries: new Map(), lines: [] };
  const text = readFileSync(file, 'utf8');
  const lines = parseLines(text);
  const entries = new Map();
  for (const l of lines) if (l.key && !entries.has(l.key)) entries.set(l.key, l.value);
  return { exists: true, entries, lines };
}

/** 确保 .env 存在（从 .env.example 复制一份，便于新用户直接在控制台改） */
function ensureEnvFile() {
  const file = envFile();
  if (existsSync(file)) return;
  const ex = envExample();
  if (existsSync(ex)) { copyFileSync(ex, file); return; }
  writeFileSync(file, '# Heimdall 配置（由控制台「设置 → 模型服务」维护）\n');
}

/**
 * 原地写回若干键：已有的键改值，没有的追加。注释/顺序/未知键原样保留。
 * @param {Record<string,string>} patch
 * @returns {{written: string[], appended: string[]}}
 */
export function writeEnvKeys(patch) {
  const keys = Object.keys(patch).filter(k => WRITABLE.has(k));
  const rejected = Object.keys(patch).filter(k => !WRITABLE.has(k));
  if (rejected.length) throw new Error('不可写入的配置键: ' + rejected.join(', '));
  ensureEnvFile();

  const file = envFile();
  const text = readFileSync(file, 'utf8');
  const lines = parseLines(text);
  const done = new Set();
  const out = lines.map((l) => {
    if (!l.key || done.has(l.key) || !(l.key in patch)) return l.raw;
    done.add(l.key);
    return `${l.key}=${patch[l.key]}`;
  });
  const appended = [];
  for (const k of keys) {
    if (done.has(k)) continue;
    out.push(`${k}=${patch[k]}`);
    appended.push(k);
  }
  // 末尾补一个换行，避免下次追加粘在同一行
  let body = out.join('\n');
  if (!body.endsWith('\n')) body += '\n';
  writeFileSync(file, body);
  return { written: [...done], appended };
}

const maskKey = (v) => (v ? (v.length <= 4 ? '****' : '****' + v.slice(-4)) : null);

/** 当前模型服务状态（**不含 Key**）；`shadowed` = 被 shell 环境变量压住的键 */
export function llmSettings() {
  const { exists, entries } = readEnvFile();
  const pick = (k) => (process.env[k] !== undefined ? process.env[k] : entries.get(k));
  const shadowed = [...WRITABLE].filter(k => process.env[k] !== undefined && entries.get(k) !== undefined && process.env[k] !== entries.get(k));

  const baseUrl = pick('LLM_BASE_URL') ?? '';
  const apiKey = pick('LLM_API_KEY') ?? '';
  const model = pick('LLM_MODEL') ?? '';
  let baseHost = '';
  try { baseHost = new URL(baseUrl).host; } catch { /* 未配置或格式错 */ }

  return {
    envFile: envFile(),
    envExists: exists,
    enabled: pick('HEIMDALL_LLM') === '1',
    baseUrl,
    baseHost,
    hasKey: !!apiKey,
    keyHint: maskKey(apiKey),
    model,
    fastModel: pick('LLM_MODEL_FAST') ?? '',
    protocol: (pick('LLM_PROTOCOL') ?? 'chat').toLowerCase(),
    timeoutMs: Number(pick('LLM_TIMEOUT_MS') ?? 180_000),
    retries: Number(pick('LLM_MAX_RETRIES') ?? 3),
    ready: pick('HEIMDALL_LLM') === '1' && !!baseUrl && !!apiKey && !!model,
    writable: [...WRITABLE],
    readonly: READONLY_KEYS.map(k => ({ key: k, value: SECRET_KEYS.has(k) ? maskKey(entries.get(k)) : (entries.get(k) ?? null) })),
    shadowed,
  };
}

/** 控制台可提交的字段（camelCase）。未知字段直接拒绝，避免"改了没反应"的哑失败 */
const ALLOWED_FIELDS = new Set(['enabled', 'baseUrl', 'apiKey', 'model', 'fastModel', 'protocol', 'timeoutMs', 'retries']);

/**
 * 写进 .env 的值不能含换行：`LLM_MODEL=x
HEIMDALL_TOKEN=...` 会在文件里开出**新的一行**，
 * 下一次 getEnv() 读出来的就是白名单之外的键 —— 等于让调用方往配置里注入任意变量。
 * 顺便挡掉 NUL。所有要落盘的字符串字段都过这里。
 */
const safeValue = (label, raw, { trim = true } = {}) => {
  const v = String(raw ?? '');
  // 换行/回车/NUL 会让 .env 里开出一行新键（= 注入任意配置），一律拒绝
  if ([13, 10, 0].some(code => v.includes(String.fromCharCode(code)))) throw new Error(`${label} 不能包含换行或空字符`);
  return trim ? v.trim() : v;
};

/** 校验 + 规范化来自控制台的补丁；抛错即拒绝 */
export function normalizePatch(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求体必须是 JSON 对象');
  const unknown = Object.keys(body).filter(k => !ALLOWED_FIELDS.has(k));
  if (unknown.length) {
    throw new Error(`不支持的字段: ${unknown.join(', ')}（可用字段：${[...ALLOWED_FIELDS].join(' / ')}）`);
  }

  const patch = {};
  if ('enabled' in body) patch.HEIMDALL_LLM = body.enabled ? '1' : '0';

  if ('baseUrl' in body) {
    const v = safeValue('Base URL', body.baseUrl).replace(/\/+$/, '');
    if (v) {
      let u;
      try { u = new URL(v); } catch { throw new Error('Base URL 不是合法地址（需形如 https://host/v1）'); }
      if (!/^https?:$/.test(u.protocol)) throw new Error('Base URL 必须是 http/https');
    }
    patch.LLM_BASE_URL = v;
  }
  // 省略 apiKey = 保持不变（控制台不回显 Key，因此不会把已存的 Key 覆盖成空）
  if ('apiKey' in body && body.apiKey !== null && body.apiKey !== undefined) {
    patch.LLM_API_KEY = safeValue('API Key', body.apiKey);
  }
  if ('model' in body) {
    const v = safeValue('主模型', body.model);
    if (!v) throw new Error('主模型不能为空');
    patch.LLM_MODEL = v;
  }
  if ('fastModel' in body) patch.LLM_MODEL_FAST = safeValue('快速模型', body.fastModel);
  if ('protocol' in body) {
    const v = safeValue('协议', body.protocol).toLowerCase();
    if (!PROTOCOLS.includes(v)) throw new Error(`协议必须是 ${PROTOCOLS.join(' | ')}`);
    patch.LLM_PROTOCOL = v;
  }
  if ('timeoutMs' in body) {
    const n = Number(body.timeoutMs);
    if (!Number.isFinite(n) || n < 1000 || n > 900_000) throw new Error('超时需在 1000–900000 ms 之间');
    patch.LLM_TIMEOUT_MS = String(Math.round(n));
  }
  if ('retries' in body) {
    const n = Number(body.retries);
    if (!Number.isFinite(n) || n < 1 || n > 10) throw new Error('重试次数需在 1–10 之间');
    patch.LLM_MAX_RETRIES = String(Math.round(n));
  }
  if (!Object.keys(patch).length) throw new Error('没有需要修改的字段');
  return patch;
}
