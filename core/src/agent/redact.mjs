/**
 * agent/redact — 工具与资源输出的脱敏器（E12-02、E12-03，PRD 08 §2.5）
 *
 * 两档：
 *   secrets（默认，用于网页内容、简报、修复包）：只拿掉凭据类——令牌、密钥、私钥块、
 *     Authorization / Cookie、JWT、有效的银行卡号、HEIMDALL_TOKEN 的值。网页里公开的邮箱、电话
 *     是页面内容的一部分，重建时要原样还原，不在这一档里抹掉。
 *   strict（用于日志、HAR 摘要、错误详情）：再加邮箱与手机号。
 *
 * 规则与 live/har.mjs 的 PRIVATE_TEXT 同源（Bearer、JWT、key=value 类），补齐了
 * 审查里列的缺口：云厂商密钥样式、私钥块、银行卡号（Luhn 校验，避免把普通长数字当卡号）、
 * 本机令牌值。
 */
const RULES = [
  { key: 'privateKey', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, to: '[私钥已移除]' },
  { key: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, to: 'Bearer [已移除]' },
  { key: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, to: '[JWT 已移除]' },
  { key: 'cloudKey', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, to: '[密钥已移除]' },
  { key: 'keyValue', re: /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|passwd)\b(\s*[:=]\s*)("?)[^\s"';,&]{4,}/gi,
    to: (m, k, sep, q) => `${k}${sep}${q}[已移除]` },
];
const STRICT_RULES = [
  { key: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, to: '[邮箱已移除]' },
  { key: 'phone', re: /(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g, to: '[手机号已移除]' },
];

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/** 返回 { text, counts }；counts 只在有替换时带键 */
export function redactText(value, { profile = 'secrets', counts = {} } = {}) {
  let s = String(value ?? '');
  const rules = profile === 'strict' ? [...RULES, ...STRICT_RULES] : RULES;
  for (const { key, re, to } of rules) {
    s = s.replace(re, (...args) => { counts[key] = (counts[key] ?? 0) + 1; return typeof to === 'function' ? to(...args) : to; });
  }
  s = s.replace(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19 || !luhn(digits)) return m;
    counts.card = (counts.card ?? 0) + 1;
    return '[卡号已移除]';
  });
  const token = process.env.HEIMDALL_TOKEN;
  if (token && token.length >= 8 && s.includes(token)) {
    counts.localToken = (counts.localToken ?? 0) + 1;
    s = s.split(token).join('[令牌已移除]');
  }
  return { text: s, counts };
}

/** 深度遍历对象里的字符串；不改原对象 */
export function redactDeep(value, opts = {}) {
  const counts = opts.counts ?? {};
  const walk = (v) => {
    if (typeof v === 'string') return redactText(v, { ...opts, counts }).text;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return { value: walk(value), counts };
}
