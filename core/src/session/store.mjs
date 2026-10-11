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
 * 存的是 Playwright 的原样格式（cookies + localStorage），不解析、不改写 ——
 * 这份文件等同于"这站点的登录凭据"，所以：
 *   · 只在本地 workspace 里，不进交付包，也不进 git（见 .gitignore）
 *   · 会在控制台显示保存时间与 cookie 数，便于判断有没有过期
 *
 * **能力边界（诚实说明）**：storageState 不含 sessionStorage、IndexedDB、
 * Service Worker 缓存。纯靠 sessionStorage 维持登录的站点复现不了；
 * 用 HTTP Basic / Bearer 头的站点也不在覆盖范围内。这些先记在文档里，不装懂。
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
  return s ? { storageState: s } : {};
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
