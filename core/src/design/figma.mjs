/**
 * design/figma — 从 Figma 拉设计基线（设计意图，不是像素真值）
 *
 * 约束（2026-10 核对 developers.figma.com/docs/rest-api/rate-limits 与 /file-endpoints）：
 *   · 一级接口 GET file / file nodes / image：View/Collab 席位「每月至多 20 次」，文档别处写 6 次，实际可能更低。
 *     每次一级调用在发出前记进 <cacheDir>/budget.json，按近 30 天计数；额度不够就在发请求之前拒绝（force 例外）。
 *   · 一次拉取恰好两次一级调用，开始前一次核对两次的额度，免得只花掉一半：
 *     file nodes 不设 depth（选画板与抽文字共用这一次），image 把全部画板合成一次。
 *   · GET /v1/files/:key/meta 是三级（View 席位每分钟至多 10 次），要 file_metadata:read 范围：
 *     只用于预检（链接 404、令牌无效、网络不通时省下一级调用）与版本比对；拿不到（缺范围、三级限流）就跳过，不挡拉取。
 *     预检误判时传 preflight: false 跳过。
 *   · 有缓存时：默认不发任何请求；refresh 无条件重拉；checkVersion 只花一次三级调用，版本或编辑时间变了才重拉。
 *   · GET image 失败不丢 nodes 那次的结果：照样写 design.json（带 incomplete），上一份同 id 的 PNG 标 imageStale 留用。
 *   · 令牌只放进 X-Figma-Token 头、只发给 API 主机，且不跟随重定向；图片预签名地址不带令牌。错误消息一律先抹掉令牌。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJson, writeFileAtomic } from '../fsutil.mjs';

export const DEFAULT_API_BASE = 'https://api.figma.com';
export const DESIGN_SCHEMA = 'heimdall.design/1';
export const BUDGET_SCHEMA = 'heimdall.figma-budget/1';
export const DEFAULT_MONTHLY_BUDGET = 6;

const DAY_MS = 86_400_000;
const WINDOW_MS = 30 * DAY_MS;
const RETRY_MAX_S = 60;
const KEY_RE = /^[A-Za-z0-9]+$/;
const URL_KINDS = new Set(['design', 'file', 'proto']);
const CONTAINER_TYPES = new Set(['CANVAS', 'SECTION', 'GROUP']);
const SCREEN_TYPES = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET']);
const FRAME_TYPES = new Set([...SCREEN_TYPES, 'INSTANCE', 'SECTION', 'GROUP']);
const DOWNLOAD_TRIES = 3;
const SIZE_HINT = { nodes: '：节点太大时 Figma 会超时报错，换成单个画板的链接再试', images: '：渲染太大会超时，调小 scale 或减少画板数' };
const KIND_LABEL = { meta: 'GET file meta', nodes: 'GET file nodes', images: 'GET image', download: '图片下载' };
const NO_TOKEN = '缺 Figma 令牌：在 Figma「Settings → Security → Personal access tokens」创建，勾 file_content:read（建议再勾 file_metadata:read），'
  + '放进环境变量 HEIMDALL_FIGMA_TOKEN 或 FIGMA_TOKEN，别写进任何配置';
const FALLBACK_HINT = '等待期间可先用手动导出的 SVG/PNG 兜底（design/import.mjs）';

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms));

export class FigmaError extends Error {
  constructor(code, message, { status, details } = {}) {
    super(message);
    this.name = 'FigmaError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/** 令牌：显式参数 > HEIMDALL_FIGMA_TOKEN > FIGMA_TOKEN；去掉首尾空白，只在内存里用 */
export function resolveToken({ token, env = process.env } = {}) {
  const raw = token || env.HEIMDALL_FIGMA_TOKEN || env.FIGMA_TOKEN;
  return raw ? String(raw).trim() || null : null;
}

// 不可打印或非 ASCII 的令牌放不进请求头，fetch 的报错会原样带出头的值
const TOKEN_RE = /^[\x21-\x7e]+$/;

const scrub = (text, secret) => (secret ? String(text).split(secret).join('[令牌已移除]') : String(text));

/** 消息、stack 与 details 里的字符串都抹掉令牌；原地改，返回同一个错误 */
function scrubError(error, secret) {
  if (!secret || !error || typeof error !== 'object') return error;
  if (typeof error.message === 'string') error.message = scrub(error.message, secret);
  if (typeof error.stack === 'string') error.stack = scrub(error.stack, secret);
  if (error.details && typeof error.details === 'object') {
    error.details = Object.fromEntries(Object.entries(error.details).map(([k, v]) => [k, typeof v === 'string' ? scrub(v, secret) : v]));
  }
  return error;
}

/** 秒 → 「约 2 天」「约 3.5 小时」「约 5 分钟」「12 秒」 */
export function humanWait(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const one = (n) => String(Math.round(n * 10) / 10);
  if (s >= 86_400) return `约 ${one(s / 86_400)} 天`;
  if (s >= 3_600) return `约 ${one(s / 3_600)} 小时`;
  if (s >= 60) return `约 ${Math.round(s / 60)} 分钟`;
  return `${s} 秒`;
}

/* ---------------- 链接 ---------------- */

/** '105-3' / '105%3A3' / '105:3' → API 形式 '105:3'；实例 id 'I1-2;3-4' → 'I1:2;3:4' */
export function normalizeNodeId(raw) {
  let id = String(raw ?? '').trim();
  try { id = decodeURIComponent(id); } catch { /* 已是解码形式 */ }
  id = id.replace(/-/g, ':');
  if (!/^[A-Za-z]?\d+:\d+(?:;[A-Za-z]?\d+:\d+)*$/.test(id)) throw new FigmaError('figma_bad_url', `node-id 格式不对：${String(raw).slice(0, 40)}`);
  return id;
}

/** figma.com/{design|file|proto}/<key>[/branch/<branchKey>]/…?node-id=… → { fileKey, nodeId, branchKey? }；nodeId 缺省为 null */
export function parseFigmaUrl(input) {
  let u;
  try { u = new URL(String(input ?? '').trim()); } catch { throw new FigmaError('figma_bad_url', '不是有效的链接'); }
  const host = u.hostname.toLowerCase();
  if (!/^https?:$/.test(u.protocol) || !(host === 'figma.com' || host.endsWith('.figma.com'))) {
    throw new FigmaError('figma_bad_url', `不是 Figma 链接（主机 ${host || '空'}）`);
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (!URL_KINDS.has(parts[0]) || !KEY_RE.test(parts[1] ?? '')) {
    throw new FigmaError('figma_bad_url', '链接里找不到文件 key：应形如 figma.com/design/<key>/<名称>?node-id=…');
  }
  const out = { fileKey: parts[1], nodeId: null };
  if (parts[2] === 'branch') {
    if (!KEY_RE.test(parts[3] ?? '')) throw new FigmaError('figma_bad_url', '分支链接里找不到分支 key');
    out.branchKey = parts[3];
  }
  const node = u.searchParams.get('node-id');
  if (node) out.nodeId = normalizeNodeId(node);
  return out;
}

/** 节点 id → 可作文件名的形式（Windows 不允许 ':'） */
export const safeNodeId = (id) => String(id).replace(/:/g, '-').replace(/[^\w.-]/g, '_');

/* ---------------- 一级调用账本 ---------------- */

// 单进程使用；两个进程同时拉取可能丢一条记录（rename 保证文件不坏，不保证不丢）
export const budgetFile = (cacheDir) => join(cacheDir, 'budget.json');

/** 读账本；文件不存在 = 空账本，存在却读不懂就拒绝——当成清零会让额度失守 */
export function readBudget(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { calls: [] };
    throw new FigmaError('figma_budget_corrupt', `读不了一级调用账本 ${file}（${error.code ?? error.message}）`);
  }
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || !Array.isArray(data.calls)) {
    throw new FigmaError('figma_budget_corrupt', `一级调用账本 ${file} 已损坏：修好它，或确认近 30 天的调用次数后删掉它（删掉等于计数清零）`);
  }
  return { ...data, calls: data.calls.filter(c => c && Number.isFinite(Date.parse(c.at))) };
}

const expiryOf = (call) => new Date(Date.parse(call.at) + WINDOW_MS).toISOString();

/** 近 30 天的一级调用：已用、上限、剩余、最早一条何时移出窗口；以及 Figma 要求等到的时间（若有） */
export function budgetStatus(file, { monthlyBudget = DEFAULT_MONTHLY_BUDGET, now = Date.now() } = {}) {
  const ledger = readBudget(file);
  const recent = ledger.calls.filter(c => now - Date.parse(c.at) < WINDOW_MS).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const blocked = Date.parse(ledger.blockedUntil) > now;
  return {
    used: recent.length, limit: monthlyBudget, remaining: Math.max(0, monthlyBudget - recent.length),
    oldestExpiresAt: recent.length ? expiryOf(recent[0]) : null,
    expiries: recent.map(expiryOf),
    blockedUntil: blocked ? ledger.blockedUntil : null,
    blockedBy: blocked ? ledger.blockedBy ?? null : null,
  };
}

/** 发请求之前核对：Figma 要求的等待未过，或近 30 天额度不够 needed 次，就抛错 */
export function assertBudget(file, { needed = 1, monthlyBudget = DEFAULT_MONTHLY_BUDGET, now = Date.now() } = {}) {
  const s = budgetStatus(file, { monthlyBudget, now });
  if (s.blockedUntil) {
    const by = s.blockedBy ?? {};
    throw new FigmaError('figma_rate_limited', [
      `Figma 上次限流要求等到 ${s.blockedUntil}（还要${humanWait((Date.parse(s.blockedUntil) - now) / 1000)}），期间再调只会继续 429`,
      ...(by.rateLimitType ? [`限流类型 ${by.rateLimitType}`] : []),
      ...(by.upgradeLink ? [`升级入口 ${by.upgradeLink}`] : []),
      `确需调用请传 force: true；${FALLBACK_HINT}`,
    ].join('；') + '。', { status: 429, details: { local: true, ...by, blockedUntil: s.blockedUntil } });
  }
  if (s.used + needed <= s.limit) return s;
  const parts = [`Figma 一级接口本地额度不够：近 30 天已调用 ${s.used} 次，上限 ${s.limit} 次（monthlyBudget），这次需要 ${needed} 次`];
  if (s.oldestExpiresAt) parts.push(`最早一次在 ${s.oldestExpiresAt} 移出 30 天窗口（${humanWait((Date.parse(s.oldestExpiresAt) - now) / 1000)}后）`);
  const enough = s.expiries[s.used + needed - s.limit - 1];
  if (needed > s.limit) parts.push(`上限小于这次需要的次数，只能调大 monthlyBudget 或传 force`);
  else if (enough && enough !== s.oldestExpiresAt) parts.push(`凑够 ${needed} 次要等到 ${enough}`);
  parts.push(`确需调用请传 force: true（View/Collab 席位的实际额度可能比上限更低）；${FALLBACK_HINT}`);
  throw new FigmaError('figma_budget_exhausted', parts.join('；') + '。', {
    details: { used: s.used, limit: s.limit, needed, oldestExpiresAt: s.oldestExpiresAt },
  });
}

function writeBudget(file, ledger, now) {
  const calls = ledger.calls.filter(c => now - Date.parse(c.at) < WINDOW_MS);
  const blocked = Date.parse(ledger.blockedUntil) > now ? { blockedUntil: ledger.blockedUntil, blockedBy: ledger.blockedBy } : {};
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ schema: BUDGET_SCHEMA, windowDays: 30, calls, ...blocked }, null, 2) + '\n');
}

function recordCall(file, entry, now) {
  const ledger = readBudget(file);
  writeBudget(file, { ...ledger, calls: [...ledger.calls, entry] }, now);
}

function recordBlock(file, untilMs, blockedBy, now) {
  const ledger = readBudget(file);
  if (Date.parse(ledger.blockedUntil) >= untilMs) return;
  writeBudget(file, { ...ledger, blockedUntil: new Date(untilMs).toISOString(), blockedBy }, now);
}

/* ---------------- 客户端 ---------------- */

function parseRetryAfter(value, now) {
  if (value == null || value === '') return null;
  if (/^\s*\d+\s*$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : null;
}

// 先抹令牌再截断：反过来会把截成半截的令牌留在消息里
function errText(body, secret) {
  let text;
  try { const j = JSON.parse(body); text = String(j?.err ?? j?.message ?? ''); } catch { text = String(body ?? ''); }
  return scrub(text, secret).slice(0, 200);
}

/** err 须已抹过令牌；原文放进 details.figmaErr 供调用方分辨原因 */
function httpError(status, err, kind) {
  const tail = err ? `（Figma：${err}）` : '';
  const opts = { status, details: { kind, ...(err ? { figmaErr: err } : {}) } };
  if (status === 401 || status === 403) {
    const scope = kind === 'meta' ? 'file_metadata:read' : 'file_content:read';
    return new FigmaError('figma_forbidden', `Figma 拒绝访问（HTTP ${status}，${KIND_LABEL[kind]}）：令牌无效或已过期、令牌缺少 ${scope} 范围，或这个账号没被分享该文件${tail}`, opts);
  }
  if (status === 404) {
    return new FigmaError('figma_not_found', `Figma 找不到文件（HTTP 404，${KIND_LABEL[kind]}）：检查链接是否完整、文件是否已删除；分支链接要用分支 key；账号要能打开这个文件${tail}`, opts);
  }
  if (status >= 300 && status < 400) {
    return new FigmaError('figma_http', `Figma 接口返回重定向（HTTP ${status}）：为免令牌被带去别的主机，不跟随；检查 apiBase / HEIMDALL_FIGMA_API`, opts);
  }
  if (status === 400) return new FigmaError('figma_bad_request', `Figma 拒绝了请求（HTTP 400，${KIND_LABEL[kind]}）${SIZE_HINT[kind] ?? ''}${tail}`, opts);
  if (status >= 500) return new FigmaError('figma_server_error', `Figma 服务端出错（HTTP ${status}，${KIND_LABEL[kind]}）${SIZE_HINT[kind] ?? ''}${tail}`, opts);
  return new FigmaError('figma_http', `Figma 返回 HTTP ${status}（${KIND_LABEL[kind]}）${tail}`, opts);
}

function rateLimitError(res, wait, kind, nowMs) {
  const details = {
    kind, retryAfterSeconds: wait,
    rateLimitType: res.headers.get('x-figma-rate-limit-type'),
    planTier: res.headers.get('x-figma-plan-tier'),
    upgradeLink: res.headers.get('x-figma-upgrade-link'),
  };
  const parts = [wait === null
    ? `Figma 限流（HTTP 429，${KIND_LABEL[kind]}）：响应没给 Retry-After，等待时间未知`
    : `Figma 限流（HTTP 429，${KIND_LABEL[kind]}）：需等待${humanWait(wait)}（${new Date(nowMs + wait * 1000).toISOString()} 之后再试）`];
  if (details.rateLimitType) parts.push(`限流类型 ${details.rateLimitType}${details.rateLimitType === 'low' ? '（View/Collab 席位的低额度）' : ''}`);
  if (details.planTier) parts.push(`文件所在套餐 ${details.planTier}`);
  if (details.upgradeLink) parts.push(`升级入口 ${details.upgradeLink}`);
  if (kind !== 'meta') parts.push(FALLBACK_HINT);
  return new FigmaError('figma_rate_limited', parts.join('；') + '。', { status: 429, details });
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])).toString();

// 令牌随请求头明文发出：只许 https，本机回环地址（测试桩）例外
function assertSafeBase(base) {
  let u;
  try { u = new URL(base); } catch { throw new FigmaError('figma_bad_input', 'apiBase / HEIMDALL_FIGMA_API 不是有效的地址'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    throw new FigmaError('figma_bad_input', `apiBase 必须是 https（本机回环地址除外），否则令牌会明文传输：${u.origin}`);
  }
}

/**
 * Figma REST 客户端。nodes / images 是一级调用：每次发出（含重试）前核对额度（force 跳过）并记账。
 * 429 且 Retry-After ≤ 60 秒：等完重试一次；更长直接抛 figma_rate_limited，并记下要等到何时。
 */
export function createFigmaClient({
  token, env = process.env, apiBase, fetch: fetchImpl = globalThis.fetch, timeoutMs = 120_000, downloadTimeoutMs = 120_000,
  budgetPath = null, monthlyBudget = DEFAULT_MONTHLY_BUDGET, force = false, sleep = defaultSleep, now = Date.now,
} = {}) {
  const secret = resolveToken({ token, env });
  if (secret && !TOKEN_RE.test(secret)) throw new FigmaError('figma_bad_token', 'Figma 令牌含空白、非 ASCII 或不可打印字符：重新复制令牌');
  const base = String(apiBase || env.HEIMDALL_FIGMA_API || DEFAULT_API_BASE).replace(/\/+$/, '').replace(/\/v1$/, '');
  assertSafeBase(base);
  const clean = (error) => scrubError(error, secret);
  const requireToken = () => { if (!secret) throw new FigmaError('figma_no_token', NO_TOKEN); };
  const checkBudget = () => { if (budgetPath && !force) assertBudget(budgetPath, { needed: 1, monthlyBudget, now: now() }); };

  async function send(url, kind, headers, ms, redirect) {
    try { return await fetchImpl(url, { headers, redirect, signal: AbortSignal.timeout(ms) }); } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new FigmaError('figma_timeout', `${KIND_LABEL[kind]} 超时（${Math.round(ms / 1000)} 秒）`);
      const where = kind === 'download' ? '图片地址' : `Figma 接口 ${base}`;
      throw clean(new FigmaError('figma_network', `连不上${where}：${String(error?.cause?.code ?? error?.message ?? error).slice(0, 160)}`));
    }
  }

  async function request(path, kind, key, tier1) {
    requireToken();
    for (let attempt = 0; ; attempt++) {
      if (tier1) checkBudget();
      if (tier1 && budgetPath) recordCall(budgetPath, { at: new Date(now()).toISOString(), kind, key, ...(attempt ? { retry: true } : {}) }, now());
      const res = await send(base + path, kind, { 'X-Figma-Token': secret, accept: 'application/json' }, timeoutMs, 'manual');
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get('retry-after'), now());
        await res.arrayBuffer().catch(() => null);
        if (attempt === 0 && wait !== null && wait <= RETRY_MAX_S) { await sleep(wait * 1000); continue; }
        const error = clean(rateLimitError(res, wait, kind, now()));
        if (tier1 && budgetPath && wait > RETRY_MAX_S) recordBlock(budgetPath, now() + wait * 1000, error.details, now());
        throw error;
      }
      const body = await res.text().catch(() => '');
      if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) throw httpError(res.status || 302, '', kind);
      if (!res.ok) throw clean(httpError(res.status, errText(body, secret), kind));
      try { return JSON.parse(body); } catch { throw new FigmaError('figma_bad_response', `${KIND_LABEL[kind]} 返回的不是 JSON`); }
    }
  }

  // 预签名地址：不是 API 调用，不带令牌、不记账；网络错误与 5xx 重试
  async function download(url) {
    let host;
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw new Error(); host = u.host; } catch {
      throw new FigmaError('figma_bad_response', 'GET image 返回了无效的图片地址');
    }
    let last;
    for (let i = 0; i < DOWNLOAD_TRIES; i++) {
      if (i) await sleep(500 * 2 ** (i - 1));
      try {
        const res = await send(url, 'download', {}, downloadTimeoutMs, 'follow');
        if (res.ok) return Buffer.from(await res.arrayBuffer());
        await res.arrayBuffer().catch(() => null);
        last = new FigmaError('figma_download_failed', `图片下载失败（HTTP ${res.status}，${host}）${res.status === 403 ? '：地址可能已过期' : ''}`, { status: res.status });
        if (res.status < 500 && res.status !== 429) break;
      } catch (error) {
        last = error instanceof FigmaError ? error : new FigmaError('figma_download_failed', `图片下载中断（${host}）：${String(error?.message ?? error).slice(0, 120)}`);
      }
    }
    throw last;
  }

  const enc = encodeURIComponent;
  return {
    apiBase: base,
    hasToken: Boolean(secret),
    /** 三级：{ file: { name, version, last_touched_at, … } } */
    meta: (key) => request(`/v1/files/${enc(key)}/meta`, 'meta', key, false),
    /** 一级：{ name, lastModified, version?, nodes: { [id]: { document, … } | null } } */
    nodes: (key, ids, { depth } = {}) => request(`/v1/files/${enc(key)}/nodes?${qs({ ids: ids.join(','), depth })}`, 'nodes', key, true),
    /** 一级：{ err, images: { [id]: url | null } }；地址 30 天后失效 */
    images: (key, ids, { scale = 1, format = 'png' } = {}) => request(`/v1/images/${enc(key)}?${qs({ ids: ids.join(','), format, scale })}`, 'images', key, true),
    download,
    budget: () => (budgetPath ? budgetStatus(budgetPath, { monthlyBudget, now: now() }) : null),
  };
}

/* ---------------- 选画板与抽取（纯函数，可对 raw-nodes.json 重跑） ---------------- */

// 隐藏或整体透明的节点连同子树都不算
const visible = (n) => Boolean(n) && n.visible !== false && n.opacity !== 0;

/**
 * CANVAS / SECTION / GROUP 一律拆；FRAME 只有像「画板集合」时才拆：≥2 个可见子节点且全是 FRAME/COMPONENT 类、
 * 自身不是自动布局、子节点没有全部撑满宽度。由区块拼成的屏幕（自动布局、上下叠放）按一张图处理。
 */
function looksLikeBoard(node, kids) {
  if (CONTAINER_TYPES.has(node?.type)) return true;
  if (node?.type !== 'FRAME' || (node.layoutMode && node.layoutMode !== 'NONE')) return false;
  if (kids.length < 2 || !kids.every(c => SCREEN_TYPES.has(c.type))) return false;
  const width = node.absoluteBoundingBox?.width;
  return !(width > 0 && kids.every(c => (c.absoluteBoundingBox?.width ?? 0) >= width * 0.9));
}

/**
 * 要拆时，可见的画板类直接子节点即画板（零散的文字、箭头不算）；没有就用节点本身。
 * split 可强制 'self' | 'children'。保持文档顺序，截到 maxFrames。
 */
export function selectFrames(node, { maxFrames = 12, split = 'auto' } = {}) {
  const kids = (node?.children ?? []).filter(visible);
  const useChildren = split === 'children' || (split === 'auto' && looksLikeBoard(node, kids));
  const candidates = useChildren ? kids.filter(c => FRAME_TYPES.has(c.type)) : [];
  if (!candidates.length) {
    if (node?.type === 'CANVAS') throw new FigmaError('figma_no_frames', `页面「${node.name ?? node.id}」下没有可见的画板`);
    return { frames: [node], split: 'self', available: 1 };
  }
  return { frames: candidates.slice(0, Math.max(1, maxFrames)), split: 'children', available: candidates.length };
}

const toHex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round((Number(v) || 0) * 255))).toString(16).padStart(2, '0')).join('');
const solidHex = (fill) => (fill?.type === 'SOLID' && fill.visible !== false && fill.opacity !== 0 && fill.color && fill.color.a !== 0 ? toHex(fill.color) : null);
const bump = (map, key, seed) => { const e = map.get(key) ?? { ...seed, count: 0 }; e.count++; map.set(key, e); };
const ranked = (map) => [...map.values()].sort((a, b) => b.count - a.count);
const round2 = (v) => Math.round(v * 100) / 100;

function relBox(box, origin) {
  if (!box) return null;
  return { x: round2(box.x - origin.x), y: round2(box.y - origin.y), w: round2(box.width), h: round2(box.height) };
}

function walk(node, visit) {
  if (!visible(node)) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** 一个画板的文字、颜色、字体；box 相对画板的 absoluteBoundingBox；跳过不可见的子树 */
export function extractFrame(frame) {
  const bounds = frame?.absoluteBoundingBox ?? null;
  const origin = bounds ?? { x: 0, y: 0 };
  const texts = [], colors = new Map(), fonts = new Map();
  walk(frame, (node) => {
    for (const fill of node.fills ?? []) { const hex = solidHex(fill); if (hex) bump(colors, hex, { hex }); }
    if (node.type !== 'TEXT') return;
    const s = node.style ?? {};
    texts.push({
      id: node.id, name: node.name ?? '', characters: node.characters ?? '',
      fontFamily: s.fontFamily ?? null, fontSize: s.fontSize ?? null, fontWeight: s.fontWeight ?? null, lineHeightPx: s.lineHeightPx ?? null,
      color: (node.fills ?? []).map(solidHex).find(Boolean) ?? null,
      box: relBox(node.absoluteBoundingBox, origin),
    });
    if (s.fontFamily) bump(fonts, `${s.fontFamily}|${s.fontSize}|${s.fontWeight}`, { family: s.fontFamily, size: s.fontSize ?? null, weight: s.fontWeight ?? null });
  });
  return {
    id: frame.id, name: frame.name ?? '', type: frame.type,
    width: bounds ? round2(bounds.width) : null, height: bounds ? round2(bounds.height) : null,
    texts, colors: ranked(colors), fonts: ranked(fonts),
  };
}

/* ---------------- 拉取 ---------------- */

function resolveTarget({ url, fileKey, nodeId, branchKey }) {
  const target = url ? parseFigmaUrl(url) : { fileKey, nodeId: null, ...(branchKey ? { branchKey } : {}) };
  if (nodeId) target.nodeId = normalizeNodeId(nodeId);
  if (!KEY_RE.test(String(target.fileKey ?? ''))) throw new FigmaError('figma_bad_input', '缺 url，或 fileKey 不是有效的文件 key');
  if (target.branchKey !== undefined && !KEY_RE.test(String(target.branchKey))) throw new FigmaError('figma_bad_input', 'branchKey 不是有效的分支 key');
  if (!target.nodeId) throw new FigmaError('figma_bad_input', '缺 node-id：在 Figma 里选中页面或画板后「复制链接」，链接里会带 ?node-id=');
  return target;
}

function validateOptions({ cacheDir, scale, maxFrames, split, monthlyBudget }) {
  if (!cacheDir) throw new FigmaError('figma_bad_input', '缺 cacheDir');
  if (!(typeof scale === 'number' && scale >= 0.01 && scale <= 4)) throw new FigmaError('figma_bad_input', 'scale 要在 0.01–4 之间');
  if (!(Number.isInteger(maxFrames) && maxFrames >= 1)) throw new FigmaError('figma_bad_input', 'maxFrames 要是正整数');
  if (!['auto', 'self', 'children'].includes(split)) throw new FigmaError('figma_bad_input', "split 只能是 'auto' | 'self' | 'children'");
  if (!(Number.isInteger(monthlyBudget) && monthlyBudget >= 0)) throw new FigmaError('figma_bad_input', 'monthlyBudget 要是非负整数');
}

function readCachedDesign(dir) {
  const design = readJson(join(dir, 'design.json'));
  return design?.schema === DESIGN_SCHEMA && Array.isArray(design.frames) ? design : null;
}

function pngSize(buf) {
  if (buf.length < 24 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// 令牌本身无效时 nodes 也必然 403，提前停下省一次一级调用；只缺 file_metadata:read 范围时照常继续
const INVALID_TOKEN_RE = /invalid token|token (?:is )?(?:expired|revoked)/i;

/** meta 预检：链接 404、令牌无效、网络不通时直接抛；缺范围、三级限流等拿不到就跳过 */
async function preflight(client, key) {
  try { return (await client.meta(key))?.file ?? null; } catch (error) {
    if (['figma_not_found', 'figma_no_token', 'figma_network', 'figma_timeout'].includes(error.code)) throw error;
    if (error.code === 'figma_forbidden' && INVALID_TOKEN_RE.test(error.details?.figmaErr ?? '')) throw error;
    return null;
  }
}

/** true / false；两边都没有可比的版本与时间时为 null */
function versionChanged(was, meta) {
  if (meta?.version && was.version) return meta.version !== was.version;
  const a = Date.parse(meta?.last_touched_at), b = Date.parse(was.lastModified);
  return Number.isFinite(a) && Number.isFinite(b) ? a > b : null;
}

async function checkCachedVersion(client, key, cached) {
  const was = cached.source ?? {};
  let meta;
  try { meta = (await client.meta(key))?.file ?? null; } catch (error) {
    return { versionCheck: { checked: false, changed: false, code: error.code, message: error.message } };
  }
  const changed = versionChanged(was, meta);
  return {
    meta,
    versionCheck: {
      checked: true, changed: changed === true, comparable: changed !== null,
      cachedVersion: was.version ?? null, currentVersion: meta?.version ?? null,
      cachedLastModified: was.lastModified ?? null, lastTouchedAt: meta?.last_touched_at ?? null,
    },
  };
}

/** GET image 一次批量 + 逐张下载；失败不抛，记进每个画板的 imageError，免得丢掉 nodes 已花的那次调用 */
async function renderFrames(client, key, frames, { dir, scale }) {
  const out = new Map();
  let rendered;
  try {
    rendered = await client.images(key, frames.map(f => f.id), { scale, format: 'png' });
    if (rendered?.err) throw new FigmaError('figma_render_failed', `GET image 失败：${String(rendered.err).slice(0, 200)}`);
  } catch (error) {
    for (const f of frames) out.set(f.id, { imageError: error.message, imageErrorCode: error.code ?? 'figma_render_failed' });
    return { out, error };
  }
  for (const f of frames) {
    const src = rendered?.images?.[f.id];
    if (!src) { out.set(f.id, { imageError: 'Figma 没渲染出这个节点（隐藏、透明度 0、尺寸为 0 或已删除）', imageErrorCode: 'figma_render_empty' }); continue; }
    try {
      const buf = await client.download(src);
      const size = pngSize(buf);
      if (!size) throw new FigmaError('figma_bad_response', '下载到的不是 PNG');
      const file = `frames/${safeNodeId(f.id)}.png`;
      writeFileAtomic(join(dir, file), buf);
      out.set(f.id, { image: file, imageWidth: size.width, imageHeight: size.height });
    } catch (error) { out.set(f.id, { imageError: error.message, imageErrorCode: error.code ?? 'figma_download_failed' }); }
  }
  return { out };
}

// 新图没拿到时留用上一份同 id 的 PNG：每张都是一级调用换来的，删了就要再花额度
function withStaleImage(dir, frame) {
  if (frame.image) return frame;
  const previous = `frames/${safeNodeId(frame.id)}.png`;
  if (!existsSync(join(dir, previous))) return frame;
  const size = pngSize(readFileSync(join(dir, previous)));
  return size ? { ...frame, image: previous, imageStale: true, imageWidth: size.width, imageHeight: size.height } : frame;
}

async function fetchDesign(client, target, { dir, scale, maxFrames, split, meta }) {
  const key = target.branchKey ?? target.fileKey;
  const raw = await client.nodes(key, [target.nodeId]);
  const fetchedAt = new Date().toISOString();
  const root = raw?.nodes?.[target.nodeId]?.document;
  if (!root) throw new FigmaError('figma_node_not_found', `文件里没有节点 ${target.nodeId}：可能已删除，或链接来自别的分支`);
  mkdirSync(join(dir, 'frames'), { recursive: true });
  writeFileAtomic(join(dir, 'raw-nodes.json'), JSON.stringify(raw));
  const pick = selectFrames(root, { maxFrames, split });
  const { out, error } = await renderFrames(client, key, pick.frames, { dir, scale });
  const frames = pick.frames.map(node => withStaleImage(dir, { ...extractFrame(node), image: null, ...out.get(node.id) }));
  const keep = new Set(frames.map(f => f.image).filter(Boolean).map(f => f.slice('frames/'.length)));
  for (const name of readdirSync(join(dir, 'frames'))) if (!keep.has(name)) rmSync(join(dir, 'frames', name), { force: true });
  return {
    schema: DESIGN_SCHEMA,
    source: {
      via: 'api', fileKey: target.fileKey, ...(target.branchKey ? { branchKey: target.branchKey } : {}), nodeId: target.nodeId,
      name: raw.name ?? meta?.name ?? null, version: raw.version ?? meta?.version ?? null,
      lastModified: raw.lastModified ?? meta?.last_touched_at ?? null, fetchedAt, scale,
    },
    root: { id: root.id, name: root.name ?? '', type: root.type, split: pick.split, available: pick.available, truncated: pick.available > frames.length },
    frames,
    ...(error ? { incomplete: { code: error.code ?? 'figma_render_failed', message: `文字已保存，画板图没拿到（要 refresh 再花两次一级调用）：${error.message}` } } : {}),
  };
}

/** 一次拉取要两次一级调用，开始前一并核对；版本已变却没额度时，把这一点写进消息 */
function assertPullBudget(budgetPath, { monthlyBudget, now, versionCheck }) {
  try { assertBudget(budgetPath, { needed: 2, monthlyBudget, now }); } catch (error) {
    if (versionCheck?.changed) {
      error.message = `设计稿已更新（版本 ${versionCheck.cachedVersion ?? '未知'} → ${versionCheck.currentVersion ?? '未知'}），缓存已过期；${error.message}`;
      error.details = { ...error.details, versionCheck };
    }
    throw error;
  }
}

/**
 * 拉一个节点的设计基线，写到 <cacheDir>/<fileKey；分支用 branchKey>/<nodeIdSafe>/。
 * 返回 { design, dir, cached, versionCheck? }。只写缓存目录之内的文件。
 */
export async function pullDesign(opts = {}) {
  const {
    cacheDir, scale = 1, maxFrames = 12, refresh = false, force = false, checkVersion = false, preflight: precheck = true,
    split = 'auto', monthlyBudget = DEFAULT_MONTHLY_BUDGET, now = Date.now,
  } = opts;
  const secret = resolveToken(opts);
  try {
    validateOptions({ cacheDir, scale, maxFrames, split, monthlyBudget });
    const target = resolveTarget(opts);
    const key = target.branchKey ?? target.fileKey;
    const dir = join(cacheDir, key, safeNodeId(target.nodeId));
    const budgetPath = budgetFile(cacheDir);
    const cached = readCachedDesign(dir);
    if (cached && !refresh && !checkVersion) return { design: cached, dir, cached: true };
    const client = createFigmaClient({ ...opts, budgetPath, monthlyBudget, force });
    let meta, versionCheck;
    if (cached && !refresh) {
      ({ meta, versionCheck } = await checkCachedVersion(client, key, cached));
      if (!versionCheck.changed) return { design: cached, dir, cached: true, versionCheck };
    }
    if (!client.hasToken) throw new FigmaError('figma_no_token', NO_TOKEN);
    if (!force) assertPullBudget(budgetPath, { monthlyBudget, now: now(), versionCheck });
    if (meta === undefined && precheck) meta = await preflight(client, key);
    const design = await fetchDesign(client, target, { dir, scale, maxFrames, split, meta });
    writeFileAtomic(join(dir, 'design.json'), JSON.stringify(design, null, 2) + '\n');
    return { design, dir, cached: false, ...(versionCheck ? { versionCheck } : {}) };
  } catch (error) {
    throw scrubError(error, secret);
  }
}
