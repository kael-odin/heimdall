/**
 * qa/findings — 发现的规范形状、指纹、证据门槛
 *
 * 一条发现要能被**记住**：下次同一个问题再出现，指纹一样，人做过的裁决就自动套上。
 * 所以指纹只取稳定的部分（站点、页面路径、检查种类、定位、规范化后的关键文字），
 * 不取会变的部分（时间、数字、哈希、查询参数）。
 *
 * 证据门槛照搬人工分诊的规则：
 *   basis   failed（点了失败/流程走不通）> wrong（结果错了）> promise（与承诺/PRD 不符）
 *           > friction（能用但费劲）> cosmetic（措辞/视觉小瑕疵）
 *   tier    wall（挡住用户）> degrade（打折）> tolerable（可容忍）
 *   cosmetic 最高只能 tolerable；没写 loss（谁损失了什么）的不能高于 tolerable；
 *   loss 里出现「可能」「疑似」「或许」= 推测，退回。
 */
import { createHash } from 'node:crypto';

export const KINDS = Object.freeze(['console', 'network', 'broken-link', 'broken-image', 'overflow', 'login-expired',
  'assertion', 'text', 'design-text', 'agent', 'blocked-write', 'navigation',
  // 无参照物检测（qa/detect）与探索/回归（qa/explore、qa/baseline）
  'a11y', 'layout', 'content', 'security', 'perf', 'blank', 'interaction', 'regression']);
export const BASIS = Object.freeze(['failed', 'wrong', 'promise', 'friction', 'cosmetic']);
export const TIERS = Object.freeze(['wall', 'degrade', 'tolerable']);
export const VERDICTS = Object.freeze(['bug', 'false-positive', 'convention', 'deferred', 'by-design', 'wont-fix', 'env']);

/** 这些裁决意味着「不进提单清单」 */
export const SUPPRESSING = new Set(['false-positive', 'convention', 'deferred', 'by-design', 'wont-fix', 'env']);

export const VERDICT_LABEL = Object.freeze({
  bug: '真问题', 'false-positive': '误报', convention: '团队约定', deferred: '暂缓',
  'by-design': '设计如此', 'wont-fix': '不修', env: '环境问题',
});

const SPECULATIVE = /可能|疑似|或许|也许|大概|应该会|估计|恐怕|maybe|might|possibly|probably/i;

/** 指纹用的文字：去数字、去十六进制串、去 URL 查询、压空白、限长 */
export function stableText(value, max = 120) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return u; } })
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\d+(?:[.,:]\d+)*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, max);
}

/** 页面路径规范化：去查询与哈希、去末尾斜杠、数字段与长 id 段归一 */
export function stablePath(value) {
  let path = String(value ?? '/');
  try { path = new URL(path, 'http://x').pathname; } catch { /* keep */ }
  path = path.replace(/\/+$/, '') || '/';
  return path.split('/').map(seg => /^\d+$/.test(seg) ? ':n' : /^[0-9a-f-]{16,}$/i.test(seg) ? ':id' : seg).join('/') || '/';
}

export function fingerprintOf({ site, path, kind, target, text }) {
  const key = [site ?? '', stablePath(path), kind ?? '', stableText(target, 200), stableText(text)].join('|');
  return 'fp_' + createHash('sha256').update(key).digest('hex').slice(0, 12);
}

/**
 * 校验并补全一条发现。检查器产出的和 agent 提交的都走这里。
 * 返回 { finding, problems }：problems 非空时调用方应退回（agent 提交）或降级（检查器）。
 */
export function normalizeFinding(raw, { site, runId, source = 'check' } = {}) {
  const problems = [];
  const kind = KINDS.includes(raw.kind) ? raw.kind : 'agent';
  const basis = BASIS.includes(raw.basis) ? raw.basis : (raw.basis ? (problems.push(`basis 只能是 ${BASIS.join('/')}`), null) : null);
  let tier = TIERS.includes(raw.tier) ? raw.tier : 'tolerable';
  const loss = typeof raw.loss === 'string' ? raw.loss.trim() : '';
  const title = String(raw.title ?? '').trim().slice(0, 160);
  if (!title) problems.push('缺 title（一句话说清问题）');
  if (source === 'agent') {
    if (!basis) problems.push('agent 提交的发现必须写 basis');
    if (!raw.evidence || (!raw.evidence.screenshot && !raw.evidence.observed && !raw.evidence.steps)) problems.push('缺证据：evidence.observed / steps / screenshot 至少一项');
  }
  if (loss && SPECULATIVE.test(loss)) problems.push('loss 里有推测词（可能/疑似/或许…），写实测到的损失，或者别写 loss 并降为可容忍');
  if (basis === 'cosmetic' && tier !== 'tolerable') { tier = 'tolerable'; problems.push('cosmetic 最高只能是 tolerable，已自动降级'); }
  if (!loss && tier !== 'tolerable') { tier = 'tolerable'; problems.push('没写 loss 的发现最高只能是 tolerable，已自动降级'); }
  const path = stablePath(raw.path ?? raw.url ?? '/');
  const finding = {
    id: raw.id ?? null,
    fingerprint: raw.fingerprint ?? fingerprintOf({ site, path, kind, target: raw.target, text: raw.match ?? raw.title }),
    site: site ?? raw.site ?? null, path, url: raw.url ?? null, kind, title, basis, tier,
    ...(loss ? { loss } : {}),
    ...(raw.expected ? { expected: String(raw.expected).slice(0, 400) } : {}),
    ...(raw.observed ? { observed: String(raw.observed).slice(0, 600) } : {}),
    ...(raw.target ? { target: String(raw.target).slice(0, 300) } : {}),
    ...(raw.viewport ? { viewport: raw.viewport } : {}),
    ...(raw.prd ? { prd: String(raw.prd).slice(0, 300) } : {}),
    ...(raw.repro ? { repro: [].concat(raw.repro).map(String).slice(0, 12) } : {}),
    evidence: raw.evidence ?? {},
    ...(raw.detector ? { detector: String(raw.detector).slice(0, 60) } : {}),
    confidence: raw.confidence ?? (source === 'agent' ? 'reported' : 'observed'),
    source, runId: runId ?? null, at: raw.at ?? new Date().toISOString(),
  };
  return { finding, problems };
}

/** 一句话描述（报告、列表里用） */
export function oneLine(f) {
  const where = f.path && f.path !== '/' ? f.path : '首页';
  return `[${f.tier}${f.basis ? '/' + f.basis : ''}] ${where} · ${f.title}`;
}
