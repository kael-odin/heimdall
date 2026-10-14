/**
 * session/store — 站点登录态（Playwright storageState）的落盘与取用
 *
 * 为什么要有它：需要登录的站点，身份只存在于**浏览器里**（cookie / localStorage）。
 * 我们不可能自动化 2FA、短信码、SSO、人机验证，也不该去猜 —— 所以路线是
 * **人工登录一次，机器复用**：`heimdall login <host>`（或控制台的「登录并保存会话」）
 * 开一个可见的浏览器，人登进去，我们把 `storageState` 存到
 * `workspace/<host>/session.json`，之后侦察 / 克隆 / SEO 审计 / 多视口验证
 * 全部带着它去请求。
 *
 * cookies / localStorage / IndexedDB 保持 Playwright 的 storageState 格式；
 * sessionStorage 是可选的扩展字段，只在创建源站 context 后恢复。
 * 这份文件等同于"这站点的登录凭据"，所以：
 *   · 只在本地 workspace 里，不进交付包，也不进 git（见 .gitignore）
 *   · 会在控制台显示保存时间与 cookie 数，便于判断有没有过期
 *
 * **能力边界**：sessionStorage 按 origin 复用，但同一 origin 不同标签页的状态
 * 无法完整表示；Service Worker 缓存和浏览器内存状态不会保存。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE } from '../paths.mjs';

/** 站点目录名统一口径：去协议、去 www、去路径、小写（与引擎其余部分一致） */
export const hostKey = (host) => String(host ?? '')
  .replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();

export const sessionPath = (host) => join(WORKSPACE, hostKey(host), 'session.json');

/**
 * 存一份登录态。**原子写**（临时文件 + rename）：这个文件会被
 * login 进程每 2 秒覆盖一次，中途被 Ctrl-C 也不该留下半截 JSON。
 */
export function saveSession(host, state) {
  const file = sessionPath(host);
  mkdirSync(join(WORKSPACE, hostKey(host)), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);   // 同目录 rename：读的人要么看到旧的、要么看到新的，不会看到半截
  return sessionInfo(host);
}

/** 读登录态；没有 / 坏了 / 空壳一律返回 undefined，调用方不必 try */
export function loadSession(host) {
  try {
    const s = JSON.parse(readFileSync(sessionPath(host), 'utf8'));
    if (!s || (!Array.isArray(s.cookies) && !Array.isArray(s.origins))) return undefined;
    return s;
  } catch { return undefined; }
}

/**
 * 直接展开给 `browser.newContext({...})`：
 *   await browser.newContext({ viewport, ...sessionContext(host) })
 * 没有会话时返回 `{}`，调用点不需要写 if。
 */
export function sessionContext(host) {
  const s = loadSession(host);
  if (!s) return {};
  const { sessionStorage, ...storageState } = s;
  return { storageState };
}

let warnedIndexedDbFallback = false;

/** 登录窗口定期保存原生状态，并补上顶层标签页的 sessionStorage。 */
export async function captureSessionState(ctx, previous = {}) {
  let state;
  try { state = await ctx.storageState({ indexedDB: true }); }
  catch (error) {
    state = await ctx.storageState();
    if (!warnedIndexedDbFallback) {
      console.warn('[login] IndexedDB 快照不可用；已仅保存 cookie 与 localStorage:', String(error).slice(0, 120));
      warnedIndexedDbFallback = true;
    }
  }

  const origins = new Map((previous.sessionStorage ?? [])
    .filter(item => item && typeof item.origin === 'string' && Array.isArray(item.entries))
    .map(item => [item.origin, item.entries]));
  for (const page of ctx.pages()) {
    try {
      const item = await page.evaluate(() => ({
        origin: location.origin,
        entries: Array.from({ length: sessionStorage.length }, (_, index) => {
          const name = sessionStorage.key(index);
          return { name, value: sessionStorage.getItem(name) };
        }).filter(entry => entry.name != null && entry.value != null),
      }));
      if (/^https?:\/\//.test(item.origin)) origins.set(item.origin, item.entries);
    } catch { /* 页面正关闭或不允许访问存储，沿用最近一次快照 */ }
  }
  if (origins.size) state.sessionStorage = [...origins].map(([origin, entries]) => ({ origin, entries }));
  return state;
}

/** 必须在 context.newPage() 前调用；仅在保存时的完全相同 origin 注入。 */
export async function restoreSessionStorage(ctx, host) {
  const entries = loadSession(host)?.sessionStorage;
  if (!Array.isArray(entries) || !entries.length) return false;
  const byOrigin = Object.fromEntries(entries
    .filter(item => {
      try {
        const url = new URL(item.origin);
        return ['http:', 'https:'].includes(url.protocol) && url.origin === item.origin && Array.isArray(item.entries);
      }
      catch { return false; }
    })
    .map(item => [item.origin, item.entries.filter(entry => typeof entry?.name === 'string' && typeof entry?.value === 'string')]));
  if (!Object.keys(byOrigin).length) return false;
  await ctx.addInitScript((saved) => {
    try {
      for (const { name, value } of saved[location.origin] ?? []) sessionStorage.setItem(name, value);
    } catch { /* 禁用存储的 origin 不能阻断页面加载 */ }
  }, byOrigin);
  return true;
}

/** 给界面看的元信息：有没有、什么时候存的、几个 cookie、覆盖哪些域名 */
export function sessionInfo(host) {
  const file = sessionPath(host);
  if (!existsSync(file)) return { exists: false, host: hostKey(host), path: file };
  let st; try { st = statSync(file); } catch { return { exists: false, host: hostKey(host), path: file }; }
  const s = loadSession(host);
  const cookies = s?.cookies?.length ?? 0;
  const origins = (s?.origins ?? []).map(o => o.origin).filter(Boolean);
  const savedAt = st.mtime.toISOString();
  return {
    exists: true,
    host: hostKey(host),
    path: file,
    savedAt,
    ageHours: +((Date.now() - st.mtimeMs) / 3_600_000).toFixed(1),
    cookies,
    origins,
    sessionStorageOrigins: s?.sessionStorage?.length ?? 0,
    /** 本域名下的 cookie 数 —— 只有当原站域名下有 cookie 才算"真的登进去了"。
     *  判据是**主机名以 cookie 域结尾**（cookie 常以 `.example.com` 下发，
     *  子域 shop.example.com 也吃得到），反过来比会把子域站点判成 0。 */
    sameSite: (s?.cookies ?? []).filter((c) => {
      const d = String(c.domain ?? '').replace(/^\./, '').toLowerCase();
      return d && (hostKey(host) === d || hostKey(host).endsWith('.' + d));
    }).length,
  };
}

export function clearSession(host) {
  const file = sessionPath(host);
  if (existsSync(file)) rmSync(file, { force: true });
  return sessionInfo(host);
}
