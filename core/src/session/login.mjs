#!/usr/bin/env node
/**
 * session/login — 人工登录一次，把登录态存下来给后续所有抓取复用
 *
 * 用法: node src/session/login.mjs <host|url> [--timeout 15]   （--timeout 单位：分钟）
 *
 * 为什么是"人工"：短信码、TOTP、扫码、SSO 跳转、人机验证 —— 这些我们既自动化不了，
 * 也不该去绕。所以这里的全部智能就是**开一个真浏览器，让你自己登**。
 * 登录完成后关掉那个标签页（或直接关掉整个浏览器窗口）即可。
 *
 * 为什么会话每 2 秒就存一次：存的是"当前这一刻的 storageState"。直接关掉整个窗口时
 * 进程会一起结束，来不及在退出前存；周期保存让"最后存下的那份"永远是可用的，
 * 也不怕中途 Ctrl-C。
 */
import { chromium } from 'playwright';
import { saveSession, sessionPath } from './store.mjs';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };
const raw = argv.find(a => !a.startsWith('--'));
if (!raw) { console.error('usage: node src/session/login.mjs <host|url> [--timeout 15]'); process.exit(2); }

const host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/.*$/, '').toLowerCase();
const url = /^https?:\/\//i.test(raw) ? raw : 'https://' + host + '/';
const timeoutMs = Math.max(1, Number(argOf('timeout', 15))) * 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

console.log(`[login] 打开浏览器：${url}`);
console.log('[login] 请在窗口里完成登录（含验证码/2FA/扫码均可），完成后**关掉那个标签页**即可。');

const browser = await chromium.launch({ headless: false });
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });

// 保活页：用户关掉登录页时 context 还在，我们才有机会把状态读出来
await ctx.newPage();
const page = await ctx.newPage();

let last = null;
const snapshot = async () => {
  try { last = saveSession(host, await ctx.storageState()); } catch { /* context 已关就跳过 */ }
  return last;
};

const timer = setInterval(snapshot, 2000);
let closedByUser = false;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
} catch (e) {
  console.warn('[login] 首屏加载不完整（可以照常在窗口里操作）:', String(e).slice(0, 120));
}
try {
  await page.waitForEvent('close', { timeout: timeoutMs });
  closedByUser = true;
} catch {
  console.warn(`[login] 等待超过 ${Math.round(timeoutMs / 60_000)} 分钟，按"就此为止"处理`);
}
clearInterval(timer);
await snapshot();

try { await browser.close(); } catch { /* 用户已经关掉了 */ }

if (!last?.exists) { console.error('[login] 没有存下任何登录态（浏览器可能根本没打开）'); process.exit(1); }
console.log(`[login] 已保存：${last.cookies} 个 cookie（本站域名下 ${last.sameSite} 个）· ${last.origins.length} 个 origin`);
console.log(`[login] 文件：${sessionPath(host)}`);
console.log(closedByUser
  ? '[login] 之后直接跑侦察/克隆/审计，会自动带上这份登录态。'
  : '[login] 到时间了，先把当前状态存下来了；要刷新就再跑一次。');
process.exit(0);
