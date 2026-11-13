/**
 * qa/workspace — 测试工作区配置（`.heimdall/qa.json`）与登录档
 *
 * 配置放在**用户自己的测试工作区**，不在 Heimdall 仓库：站点、登录档、团队约定、台账路径都属于项目。
 * 登录档只有声明式的三种，**不执行任意脚本**：
 *   storageState  Playwright storageState 文件（`heimdall qa login` 或 `heimdall login` 产出）
 *   localStorage  在指定 origin 写入键值；值可以引用环境变量或文件（`{ "fromFile": "…", "match": "jwt" }`）
 *   headers       额外请求头（同样可引用环境变量或文件）
 * 凭据只在运行时读进内存，报告、日志、信封里只出现登录档的名字。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const CONFIG_DIR = '.heimdall';
export const CONFIG_FILE = 'qa.json';
export const QA_SCHEMA = 'heimdall.qa/1';
export const QA_SCOPE_LIMITS = Object.freeze({ pages: 40, viewports: 3, checks: 40, steps: 20, expectations: 20 });

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => { const e = new Error(message); e.code = 'invalid_args'; throw e; };

export function isSitePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f\x7f]/.test(value)) return false;
  try { return new URL(value, 'http://heimdall.invalid').origin === 'http://heimdall.invalid'; } catch { return false; }
}

/** 从 start 向上找 `.heimdall/qa.json`，最多 8 层；找不到返回 null */
export function findWorkspace(start = process.env.HEIMDALL_INVOKE_CWD ?? process.cwd()) {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    const file = join(dir, CONFIG_DIR, CONFIG_FILE);
    if (existsSync(file)) return { root: dir, file };
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const httpUrl = (value, label) => {
  let url;
  try { url = new URL(String(value)); } catch { fail(`${label} 不是合法 URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail(`${label} 必须是 http(s)，且不带账号密码`);
  return url;
};

/** 值来源：字面量 / { env } / { fromFile, match?, section? }；返回描述，不在这里读值 */
function valueSource(raw, label) {
  if (typeof raw === 'string') return { literal: raw };
  if (!object(raw)) fail(`${label} 应为字符串或 { env } / { fromFile }`);
  if (raw.env) { if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(raw.env)) fail(`${label}.env 名称不合法`); return { env: raw.env }; }
  if (raw.fromFile) {
    if (raw.match && !['jwt', 'line', 'all'].includes(raw.match)) fail(`${label}.match 只能是 jwt / line / all`);
    return { fromFile: String(raw.fromFile), match: raw.match ?? 'all', ...(raw.section ? { section: String(raw.section) } : {}) };
  }
  fail(`${label} 缺 env 或 fromFile`);
}

function normalizeProfile(name, raw) {
  if (!NAME.test(name)) fail(`登录档名 ${name} 只能用字母、数字、_、-`);
  if (!object(raw)) fail(`登录档 ${name} 应为对象`);
  const kind = raw.kind;
  if (kind === 'storageState') {
    if (typeof raw.file !== 'string' || !raw.file) fail(`登录档 ${name} 缺 file`);
    return { name, kind, file: raw.file, ...(raw.origin ? { origin: httpUrl(raw.origin, `登录档 ${name}.origin`).origin } : {}) };
  }
  if (kind === 'localStorage') {
    const origin = httpUrl(raw.origin, `登录档 ${name}.origin`).origin;
    if (!object(raw.items) || !Object.keys(raw.items).length) fail(`登录档 ${name} 缺 items`);
    const entries = Object.entries(raw.items);
    if (entries.length > 40) fail(`登录档 ${name}.items 最多 40 项`);
    const items = entries.map(([key, v]) => ({ key, source: valueSource(v, `登录档 ${name}.items.${key}`) }));
    return { name, kind, origin, items, ...(raw.jwtClaims ? { jwtClaims: normalizeClaims(name, raw.jwtClaims) } : {}) };
  }
  if (kind === 'headers') {
    if (!object(raw.headers) || !Object.keys(raw.headers).length) fail(`登录档 ${name} 缺 headers`);
    const entries = Object.entries(raw.headers);
    if (entries.length > 20) fail(`登录档 ${name}.headers 最多 20 项`);
    const headers = entries.map(([key, v]) => {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(key)) fail(`登录档 ${name} 的请求头 ${key} 不合法`);
      return { key, source: valueSource(v, `登录档 ${name}.headers.${key}`) };
    });
    return { name, kind, headers, ...(raw.origin ? { origin: httpUrl(raw.origin, `登录档 ${name}.origin`).origin } : {}) };
  }
  fail(`登录档 ${name} 的 kind 只能是 storageState / localStorage / headers`);
}

/**
 * 把 JWT 的载荷字段拼成 localStorage 值，免得在配置里抄一份用户信息。
 * { "_user_info": { "from": "_token", "pick": ["user_id","username"] }, "_permission": { "from": "_token", "claim": "permissions" } }
 */
function normalizeClaims(name, raw) {
  if (!object(raw)) fail(`登录档 ${name}.jwtClaims 应为对象`);
  const entries = Object.entries(raw);
  if (entries.length > 20) fail(`登录档 ${name}.jwtClaims 最多 20 项`);
  return entries.map(([key, v]) => {
    if (!object(v) || typeof v.from !== 'string') fail(`登录档 ${name}.jwtClaims.${key} 缺 from`);
    if (!v.pick && !v.claim) fail(`登录档 ${name}.jwtClaims.${key} 缺 pick 或 claim`);
    const pick = v.pick ? [].concat(v.pick).map(String) : null;
    if (pick && pick.length > 30) fail(`登录档 ${name}.jwtClaims.${key}.pick 最多 30 项`);
    return { key, from: v.from, ...(pick ? { pick } : {}), ...(v.claim ? { claim: String(v.claim) } : {}) };
  });
}

function normalizeWriteRule(name, rule, index) {
  const label = `站点 ${name}.writes.allow[${index}]`;
  if (typeof rule === 'string') fail(`${label} 不再支持路径前缀；请改为明确的 { method: "POST", origin, path }，并逐项确认接口只读`);
  if (!object(rule) || Object.keys(rule).some(key => !['method', 'origin', 'path'].includes(key))) {
    fail(`${label} 应只包含 method、origin 和 path`);
  }
  if (rule.method !== 'POST') fail(`${label}.method 只能是 POST`);
  if (typeof rule.origin !== 'string') fail(`${label}.origin 应为完整来源`);
  const origin = httpUrl(rule.origin, `${label}.origin`);
  if (origin.pathname !== '/' || /[?#]/.test(rule.origin)) fail(`${label}.origin 只能包含协议、主机和端口`);
  const path = rule.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('//') || /[\\?#%\x00-\x20\x7f]/.test(path)
    || new URL(path, 'http://example.invalid').pathname !== path) {
    fail(`${label}.path 应为不含查询、编码或特殊路径段的精确路径`);
  }
  return { method: 'POST', origin: origin.origin, path };
}

function normalizeSite(name, raw, profiles) {
  if (!NAME.test(name)) fail(`站点名 ${name} 只能用字母、数字、_、-`);
  if (!object(raw)) fail(`站点 ${name} 应为对象`);
  const url = httpUrl(raw.url, `站点 ${name}.url`);
  const login = raw.login ?? null;
  if (login !== null && !profiles[login]) fail(`站点 ${name} 引用了不存在的登录档 ${login}`);
  const declaredPages = raw.pages ?? ['/'];
  if (!Array.isArray(declaredPages) || declaredPages.length > QA_SCOPE_LIMITS.pages) fail(`站点 ${name}.pages 应为不超过 ${QA_SCOPE_LIMITS.pages} 项的数组`);
  const pages = declaredPages.map((p) => {
    const path = typeof p === 'string' ? p : p?.path;
    if (!isSitePath(path)) fail(`站点 ${name} 的页面路径应以 / 开头且指向同源路径`);
    return { path, ...(typeof p === 'object' && p.name ? { name: String(p.name).slice(0, 60) } : {}) };
  });
  const writes = raw.writes ?? 'block';
  let writeMode = 'block', writeAllow = [];
  if (typeof writes === 'string') {
    if (!['block', 'allow'].includes(writes)) fail(`站点 ${name}.writes 只能是 block / allow / { allow: [规则] }`);
    writeMode = writes;
  } else if (object(writes)) {
    if (Object.keys(writes).some(key => key !== 'allow')) fail(`站点 ${name}.writes 只能包含 allow`);
    if (!Array.isArray(writes.allow) || !writes.allow.length || writes.allow.length > 40) fail(`站点 ${name}.writes.allow 应为 1 到 40 条规则`);
    writeAllow = writes.allow.map((rule, index) => normalizeWriteRule(name, rule, index));
  } else fail(`站点 ${name}.writes 只能是 block / allow / { allow: [规则] }`);
  const loggedOutText = raw.loggedOutText ? [].concat(raw.loggedOutText).map(String) : null;
  if (loggedOutText && loggedOutText.length > 10) fail(`站点 ${name}.loggedOutText 最多 10 项`);
  return {
    name, label: String(raw.label ?? name).slice(0, 60), url: url.href, origin: url.origin, login, pages, writes: writeMode,
    ...(writeAllow.length ? { writeAllow } : {}),
    ...(raw.loginPath ? { loginPath: String(raw.loginPath) } : {}),
    ...(loggedOutText ? { loggedOutText } : {}),
    environment: String(raw.environment ?? 'unknown').slice(0, 30),
  };
}

/** 读并校验一份工作区配置；返回带绝对路径的规范对象 */
export function loadWorkspace(start) {
  const found = typeof start === 'object' && start?.file ? start : findWorkspace(start);
  if (!found) return null;
  let raw;
  try { raw = JSON.parse(readFileSync(found.file, 'utf8')); } catch (e) { fail(`${found.file} 不是合法 JSON：${e.message}`); }
  if (!object(raw)) fail('qa.json 顶层应为对象');
  if (raw.schema && raw.schema !== QA_SCHEMA) fail(`qa.json 的 schema 应为 ${QA_SCHEMA}`);
  const profiles = {};
  for (const [name, p] of Object.entries(raw.logins ?? {})) profiles[name] = normalizeProfile(name, p);
  const sites = {};
  for (const [name, s] of Object.entries(raw.sites ?? {})) sites[name] = normalizeSite(name, s, profiles);
  if (!Object.keys(sites).length) fail('qa.json 至少声明一个站点（sites）');
  const declaredConventions = raw.conventions ?? [];
  if (!Array.isArray(declaredConventions) || declaredConventions.length > 200) fail('conventions 应为不超过 200 项的数组');
  const conventions = declaredConventions.map((c, i) => {
    if (typeof c === 'string') return { id: `conv-${i + 1}`, text: c };
    if (!object(c) || typeof c.text !== 'string') fail(`conventions[${i}] 应为字符串或 { text }`);
    return { id: String(c.id ?? `conv-${i + 1}`), text: c.text, ...(c.match ? { match: c.match } : {}) };
  });
  const dataDir = resolve(found.root, raw.dataDir ?? join(CONFIG_DIR, 'qa'));
  return {
    schema: QA_SCHEMA, root: found.root, file: found.file,
    project: String(raw.project ?? found.root.split(/[/\\]/).at(-1)).slice(0, 80),
    sites, logins: profiles, conventions, dataDir,
    knowledge: object(raw.knowledge) ? raw.knowledge : {},
    ledger: object(raw.ledger) ? { ...raw.ledger, file: raw.ledger.file ? resolve(found.root, raw.ledger.file) : null } : null,
    defaults: { viewport: { width: 1440, height: 900 }, settleMs: 1500, timeoutMs: 30_000, ...(object(raw.defaults) ? raw.defaults : {}) },
  };
}

/** 工作区内的相对路径解析成绝对路径；绝对路径原样保留 */
export const inWorkspace = (ws, p) => (isAbsolute(p) ? p : resolve(ws.root, p));

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/;

/** 按来源描述取值；只在运行时调用，结果不落盘 */
export function readSecretValue(ws, source, env = process.env) {
  if ('literal' in source) return source.literal;
  if (source.env) {
    const v = env[source.env];
    if (!v) fail(`环境变量 ${source.env} 未设置`);
    return v;
  }
  const file = inWorkspace(ws, source.fromFile);
  if (!existsSync(file)) fail(`凭据文件不存在：${source.fromFile}`);
  let text = readFileSync(file, 'utf8');
  if (source.section) {
    const i = text.indexOf(source.section);
    if (i < 0) fail(`凭据文件 ${source.fromFile} 里没有段落 ${source.section}`);
    text = text.slice(i + source.section.length).split(/\n##\s/)[0];
  }
  if (source.match === 'jwt') {
    const m = text.match(JWT);
    if (!m) fail(`凭据文件 ${source.fromFile} 里没有 JWT`);
    return m[0];
  }
  if (source.match === 'line') return text.split(/\r?\n/).map(s => s.trim()).find(Boolean) ?? '';
  return text.trim();
}

export function jwtPayload(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

/** JWT 过期时间（秒级 exp → ISO）；不是 JWT 返回 null */
export function jwtExpiry(token) {
  const p = jwtPayload(token);
  return p && Number.isFinite(p.exp) ? new Date(p.exp * 1000).toISOString() : null;
}

/**
 * 把登录档解析成浏览器上下文需要的材料：
 *   { contextOptions: { storageState?, extraHTTPHeaders? }, storage: [{ origin, items: [[k,v]] }], expiresAt, secrets: [值…] }
 * secrets 只用于事后在报告里抹掉这些值。
 */
export function resolveLogin(ws, name, env = process.env) {
  if (!name) return { name: null, contextOptions: {}, storage: [], expiresAt: null, secrets: [] };
  const p = ws.logins[name];
  if (!p) fail(`没有登录档 ${name}`);
  if (p.kind === 'storageState') {
    const file = inWorkspace(ws, p.file);
    if (!existsSync(file)) {
      const e = new Error(`登录档 ${name} 的文件还没有：先运行 heimdall qa login ${name}`);
      e.code = 'login_missing';
      throw e;
    }
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const { sessionStorage, ...storageState } = state;
    const cookieExpiry = (state.cookies ?? []).map(c => c.expires).filter(x => Number.isFinite(x) && x > 0);
    const secrets = [...(state.cookies ?? []).map(c => c.value),
      ...(state.origins ?? []).flatMap(origin => (origin.localStorage ?? []).map(item => item.value))]
      .filter(value => typeof value === 'string' && value.length >= 8);
    return {
      name, kind: p.kind, contextOptions: { storageState }, storage: [],
      savedAt: statSync(file).mtime.toISOString(),
      expiresAt: cookieExpiry.length ? new Date(Math.min(...cookieExpiry) * 1000).toISOString() : null,
      secrets,
    };
  }
  if (p.kind === 'headers') {
    const headers = Object.fromEntries(p.headers.map(h => [h.key, readSecretValue(ws, h.source, env)]));
    return { name, kind: p.kind, contextOptions: { extraHTTPHeaders: headers }, storage: [], expiresAt: null, secrets: Object.values(headers), origin: p.origin ?? null };
  }
  const values = Object.fromEntries(p.items.map(i => [i.key, readSecretValue(ws, i.source, env)]));
  for (const c of p.jwtClaims ?? []) {
    const payload = jwtPayload(values[c.from]);
    if (!payload) fail(`登录档 ${name}：${c.from} 不是 JWT，无法取 ${c.key}`);
    values[c.key] = JSON.stringify(c.claim ? payload[c.claim] ?? null : Object.fromEntries(c.pick.map(k => [k, payload[k]])));
  }
  const expiresAt = Object.values(values).map(jwtExpiry).filter(Boolean).sort()[0] ?? null;
  return {
    name, kind: p.kind, contextOptions: {}, storage: [{ origin: p.origin, items: Object.entries(values) }], expiresAt,
    secrets: Object.values(values).filter(v => String(v).length >= 8),
  };
}

/** 登录档的公开描述（给 doctor / 报告）：不含任何值 */
export function describeLogin(ws, name) {
  const p = ws.logins[name];
  if (!p) return null;
  const base = { name, kind: p.kind };
  if (p.kind === 'storageState') {
    const file = inWorkspace(ws, p.file);
    return { ...base, file: p.file, exists: existsSync(file), savedAt: existsSync(file) ? statSync(file).mtime.toISOString() : null };
  }
  if (p.kind === 'localStorage') return { ...base, origin: p.origin, keys: p.items.map(i => i.key).concat((p.jwtClaims ?? []).map(c => c.key)), sources: p.items.map(i => Object.keys(i.source)[0]) };
  return { ...base, headers: p.headers.map(h => h.key) };
}

/** 把字符串里出现的凭据值替换掉（报告、错误信息落盘前调用） */
export function scrubSecrets(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    const secret = String(s ?? '');
    if (secret.length < 8) continue;
    out = out.split(secret).join('[凭据已移除]');
    const bearer = secret.trim().match(/^Bearer[ \t]+(\S+)$/i)?.[1];
    if (bearer?.length >= 8) out = out.split(bearer).join('[凭据已移除]');
  }
  return out;
}

export function scrubValues(value, secrets = []) {
  if (typeof value === 'string') return scrubSecrets(value, secrets);
  if (Array.isArray(value)) return value.map(item => scrubValues(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [scrubSecrets(key, secrets), scrubValues(item, secrets)]));
  return value;
}
