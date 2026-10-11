/**
 * fingerprint — 源站页面的内容指纹（增量重克隆的判据）
 *
 * 解决什么：整站重跑时，绝大多数页面其实没变。重跑一页要起浏览器、截两张图、
 * 做像素比对和 AI 校准 —— 成本远高于"问一句源站变了没有"。
 *
 * 指纹取服务端返回的 HTML（普通 Node fetch，**不起浏览器**）：
 *   hash          body 的 sha256（截断 32 位）
 *   etag/lastModified  源站给的校验器（有则优先，未变即字节未变）
 *   bytes         body 字节数（人看的口径）
 *
 * 已知边界（不装作没有）：
 *   纯 CSR 站的服务端 HTML 是个空壳，内容全在 JS 里 —— 空壳不变，
 *   指纹就不会变，于是这类站的改版**检测不到**。指纹记录里带 `shell:true`
 *   标记（正文文本占比过低），增量模式对这类页一律重跑，宁可多跑不误判。
 *
 * 与 capture 的关系：两边都必须用**同一个** Node fetch 口径，才能对得上。
 * capture 走的是浏览器（带 Cookie、执行 JS），不能拿来和这里比。
 */
import { createHash } from 'node:crypto';
import { UA } from './ua.mjs';

export const DEFAULT_UA = UA;

export function hashContent(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/** 判定服务端 HTML 是否只是空壳（去掉标签后的正文太短） */
export function looksLikeShell(html) {
  const text = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length < 500;
}

/**
 * 抓取一个 URL 的内容指纹。**永不抛异常** —— 失败也返回结构化结果，
 * 让调用方区分"变了"和"没问到"。
 * @param {string} url
 * @param {{fetchImpl?:typeof fetch, timeoutMs?:number, ua?:string}} [opts]
 */
export async function sourceFingerprint(url, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const ua = opts.ua ?? DEFAULT_UA;
  const at = new Date().toISOString();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: {
        'user-agent': ua,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const body = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      url,
      hash: hashContent(body),
      etag: res.headers.get('etag') ?? null,
      lastModified: res.headers.get('last-modified') ?? null,
      bytes: Buffer.byteLength(body),
      shell: looksLikeShell(body),
      at,
    };
  } catch (e) {
    return { ok: false, status: 0, url, error: String(e).slice(0, 140), at };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 增量判定：现有指纹 vs 刚抓的指纹。
 * 纯函数 —— 判据的方向性由单测钉住（判反了会静默丢更新，比不做更糟）。
 *
 * @param {object|null} prev 上次记录（pages/<name>/fingerprint.json 的内容）
 * @param {object|null} next 本次抓取结果
 * @returns {{action:'reforge'|'keep', reason:string}}
 *   reforge 的理由：no-fingerprint（从没记过）/ changed / shell（空壳站不可信，一律重跑）
 *   keep    的理由：unchanged / unreachable（源站没问到，保留现有产物）
 */
export function incrementalDecision(prev, next) {
  if (!next?.ok) return { action: 'keep', reason: 'unreachable' };
  if (!prev?.hash) return { action: 'reforge', reason: 'no-fingerprint' };
  // 空壳站：服务端 HTML 不变不代表内容不变，不能据它跳过
  if (prev.shell || next.shell) return { action: 'reforge', reason: 'shell' };
  // 校验器优先：ETag 相同即字节相同（比 hash 更省一次全文比较的直觉，这里只是可读性）
  if (prev.etag && next.etag && prev.etag === next.etag) return { action: 'keep', reason: 'unchanged' };
  if (prev.hash === next.hash) return { action: 'keep', reason: 'unchanged' };
  return { action: 'reforge', reason: 'changed' };
}

/** 给报告/日志用的一句话 */
export function decisionNote(reason) {
  switch (reason) {
    case 'unchanged': return '源站未变，跳过';
    case 'changed': return '源站已变，重跑';
    case 'no-fingerprint': return '无历史指纹，重跑';
    case 'shell': return 'JS 渲染站（服务端 HTML 为空壳），指纹不可信，重跑';
    case 'unreachable': return '源站不可达，保留现有产物';
    default: return reason;
  }
}
