/**
 * qa/memory — 裁决记忆
 *
 * 人工过滤掉的问题（误报、团队约定、暂缓、设计如此…）以前只在人脑子里，
 * 下次 AI 再报同样的问题，人还要再过滤一遍。这里把每次裁决存成一条规则：
 *
 *   精确规则  match.fingerprint —— 同一个问题
 *   模式规则  match.kind / site / pathPrefix / text（正则或子串）/ target —— 一类问题
 *             例如「【】是强调写法」「政策文档四页不查」「测试环境数据不代表生产」
 *
 * 规则文件：<dataDir>/verdicts.jsonl，一行一条，只追加；撤销也是追加一条 revoke。
 * 暂缓的规则可以带 until（日期）或 reopenIf（文字条件），到期或条件写明后重新报。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { VERDICTS, SUPPRESSING, stablePath, stableText } from './findings.mjs';

const fail = (message) => { const e = new Error(message); e.code = 'invalid_args'; throw e; };
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);

export const verdictsFile = (dataDir) => join(dataDir, 'verdicts.jsonl');

export function readRules(dataDir) {
  const file = verdictsFile(dataDir);
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const revoked = new Set(rows.filter(r => r.revoke).map(r => r.revoke));
  return rows.filter(r => r.id && !r.revoke && !revoked.has(r.id));
}

function compileText(text) {
  if (!text) return null;
  if (text.startsWith('/') && text.lastIndexOf('/') > 0) {
    const end = text.lastIndexOf('/');
    try { return new RegExp(text.slice(1, end), text.slice(end + 1).replace(/[^imsu]/g, '')); } catch { fail(`text 正则不合法：${text}`); }
  }
  const needle = stableText(text, 400);
  return { test: (s) => stableText(s, 400).includes(needle) };
}

/** 规则的 match 校验：至少要有一个限定条件，免得一条规则吞掉所有发现 */
export function normalizeMatch(raw) {
  if (!object(raw)) fail('match 应为对象');
  const m = {};
  if (raw.fingerprint) m.fingerprint = String(raw.fingerprint);
  if (raw.kind) m.kind = [].concat(raw.kind).map(String);
  if (raw.site) m.site = String(raw.site);
  if (raw.pathPrefix) m.pathPrefix = stablePath(raw.pathPrefix);
  if (raw.path) m.path = stablePath(raw.path);
  if (raw.text) { compileText(raw.text); m.text = String(raw.text); }
  if (raw.target) m.target = String(raw.target);
  if (raw.environment) m.environment = String(raw.environment);
  if (!Object.keys(m).length) fail('match 至少要有 fingerprint / kind / site / path / pathPrefix / text / target 之一');
  if (!m.fingerprint && !m.text && !m.target && !m.path && !m.pathPrefix && !m.kind) fail('只按站点匹配会吞掉整个站点的发现；再加一个条件');
  return m;
}

/** 记一条裁决。返回写入的规则。 */
export function recordVerdict(dataDir, { verdict, reason, match, until, reopenIf, by = 'human', scope } = {}) {
  if (!VERDICTS.includes(verdict)) fail(`verdict 只能是 ${VERDICTS.join(' / ')}`);
  if (!reason || String(reason).trim().length < 2) fail('写一句理由（reason）：以后看到这条规则的人要知道为什么');
  const rule = {
    id: 'vr_' + randomBytes(5).toString('hex'), verdict, reason: String(reason).trim().slice(0, 500),
    match: normalizeMatch(match), by, at: new Date().toISOString(),
    ...(until ? { until: String(until).slice(0, 10) } : {}),
    ...(reopenIf ? { reopenIf: String(reopenIf).slice(0, 300) } : {}),
    ...(scope ? { scope: String(scope).slice(0, 40) } : {}),
  };
  if (rule.until && !/^\d{4}-\d{2}-\d{2}$/.test(rule.until)) fail('until 用 YYYY-MM-DD');
  mkdirSync(dirname(verdictsFile(dataDir)), { recursive: true });
  appendFileSync(verdictsFile(dataDir), JSON.stringify(rule) + '\n');
  return rule;
}

export function revokeVerdict(dataDir, ruleId, reason = '') {
  const rules = readRules(dataDir);
  if (!rules.some(r => r.id === ruleId)) fail(`没有规则 ${ruleId}`);
  appendFileSync(verdictsFile(dataDir), JSON.stringify({ revoke: ruleId, reason, at: new Date().toISOString() }) + '\n');
  return { revoked: ruleId };
}

function matches(rule, f, ctx) {
  const m = rule.match;
  if (m.fingerprint && m.fingerprint !== f.fingerprint) return false;
  if (m.kind && !m.kind.includes(f.kind)) return false;
  if (m.site && m.site !== f.site) return false;
  if (m.path && m.path !== f.path) return false;
  if (m.pathPrefix && !(f.path === m.pathPrefix || f.path.startsWith(m.pathPrefix.replace(/\/$/, '') + '/'))) return false;
  if (m.environment && m.environment !== ctx.environment) return false;
  if (m.target && !String(f.target ?? '').includes(m.target)) return false;
  if (m.text) {
    const re = compileText(m.text);
    const hay = [f.title, f.observed, f.target, f.expected].filter(Boolean).join(' \n ');
    if (!re.test(hay)) return false;
  }
  return true;
}

/** 精确规则优先，其次条件多的规则，再其次新的规则 */
const specificity = (r) => (r.match.fingerprint ? 100 : 0) + Object.keys(r.match).length * 10 + (Date.parse(r.at) || 0) / 1e13;

/**
 * 给一批发现套用裁决。返回每条发现加上 triage：
 *   { status: 'new' | 'known-bug' | 'suppressed' | 'reopened', rule?, verdict?, reason? }
 */
export function applyVerdicts(findings, rules, { today = new Date().toISOString().slice(0, 10), environment } = {}) {
  const ordered = [...rules].sort((a, b) => specificity(b) - specificity(a));
  return findings.map((f) => {
    const rule = ordered.find(r => matches(r, f, { environment }));
    if (!rule) return { ...f, triage: { status: 'new' } };
    const base = { rule: rule.id, verdict: rule.verdict, reason: rule.reason, at: rule.at, ...(rule.reopenIf ? { reopenIf: rule.reopenIf } : {}) };
    if (rule.verdict === 'bug') return { ...f, triage: { status: 'known-bug', ...base } };
    if (rule.until && rule.until < today) return { ...f, triage: { status: 'reopened', ...base, note: `暂缓到 ${rule.until}，已到期` } };
    return { ...f, triage: { status: SUPPRESSING.has(rule.verdict) ? 'suppressed' : 'new', ...base } };
  });
}

/** 按规则统计命中（报告里「按以往裁决过滤了哪些」） */
export function ruleHits(triaged) {
  const hits = new Map();
  for (const f of triaged) {
    if (!f.triage?.rule) continue;
    const h = hits.get(f.triage.rule) ?? { rule: f.triage.rule, verdict: f.triage.verdict, reason: f.triage.reason, count: 0, examples: [] };
    h.count++;
    if (h.examples.length < 3) h.examples.push(f.title);
    hits.set(f.triage.rule, h);
  }
  return [...hits.values()].sort((a, b) => b.count - a.count);
}
