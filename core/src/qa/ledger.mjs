/**
 * qa/ledger — 读用户已有的问题台账，给 agent 两样东西：
 *
 *   1. 查重：提交前先查「这个问题以前报过没有、当时怎么判的」
 *   2. 教训：台账里被撤销、不成立、移出范围、暂缓的条目和理由——这正是人工过滤的经验，
 *      以前只留在台账里，AI 下次测试时看不到
 *
 * 支持的台账格式：
 *   heimdall  Heimdall 自己的裁决与历次运行（总是可用）
 *   xspark-patrol  `{ issues: [{ id, title, status, tier, basis, site, where, symptom, close_reason, accepted_reason, reopen_if }] }`
 * 台账只读，不改写。
 */
import { existsSync, readFileSync } from 'node:fs';
import { listRuns, readRun } from './run.mjs';
import { readRules } from './memory.mjs';

const clean = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** 字符二元组 Dice 系数；中文按字切分也成立 */
export function dice(a, b) {
  const x = clean(a), y = clean(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x.includes(y) || y.includes(x) ? 0.8 : 0;
  const grams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const gx = grams(x), gy = grams(y);
  let inter = 0;
  for (const [g, n] of gx) inter += Math.min(n, gy.get(g) ?? 0);
  return (2 * inter) / (x.length - 1 + y.length - 1);
}

const STATUS = { open: '未解决', fixed: '已修复', closed: '已关闭', accepted: '暂缓' };

/** 读外部台账，统一成 { id, title, status, statusLabel, text, reason, reopenIf, site, where } */
export function readLedger(ws) {
  const cfg = ws.ledger;
  if (!cfg?.file || !existsSync(cfg.file)) return [];
  let data;
  try { data = JSON.parse(readFileSync(cfg.file, 'utf8')); } catch { return []; }
  const list = Array.isArray(data) ? data : Array.isArray(data.issues) ? data.issues : [];
  return list.filter(i => i && i.title).map(i => ({
    id: String(i.id ?? ''), title: String(i.title), status: String(i.status ?? 'open'), statusLabel: STATUS[i.status] ?? String(i.status ?? ''),
    tier: i.tier ?? null, basis: i.basis ?? null, site: i.site ?? null, where: i.where ?? null,
    text: [i.title, i.where, i.symptom].filter(Boolean).join(' '),
    reason: i.close_reason ?? i.accepted_reason ?? null, reopenIf: i.reopen_if ?? null,
    lastSeen: i.last_seen ?? i.last_checked ?? null,
  }));
}

/**
 * 查相似：台账条目 + 最近几次运行里人裁决过的发现。
 * 返回按相似度排序的前 limit 条，每条带「当时怎么判的」。
 */
export function findSimilar(ws, { title, text, path, limit = 5, threshold = 0.35, runs = 10 }) {
  const query = [title, text].filter(Boolean).join(' ');
  if (!query.trim()) return [];
  const out = [];
  for (const e of readLedger(ws)) {
    const score = Math.max(dice(title ?? query, e.title), dice(query, e.text) * 0.9);
    if (score >= threshold) out.push({ source: 'ledger', id: e.id, title: e.title, score: +score.toFixed(2), status: e.statusLabel, reason: e.reason, reopenIf: e.reopenIf, where: e.where, lastSeen: e.lastSeen });
  }
  const seen = new Set();
  for (const meta of listRuns(ws, runs)) {
    let findings;
    try { ({ findings } = readRun(ws, meta.runId)); } catch { continue; }
    for (const f of findings) {
      if (seen.has(f.fingerprint)) continue;
      seen.add(f.fingerprint);
      let score = dice(title ?? query, f.title);
      if (path && f.path === path) score += 0.1;
      if (score >= threshold) out.push({ source: 'run', id: `${meta.runId}/${f.id}`, fingerprint: f.fingerprint, title: f.title, score: +Math.min(1, score).toFixed(2),
        status: f.triage?.status === 'suppressed' ? `已过滤（${f.triage.verdict}）` : f.triage?.status === 'known-bug' ? '已确认是问题' : '未裁决', reason: f.triage?.reason ?? null, path: f.path });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * 给 agent 的测试须知：分诊规则 + 团队约定 + 台账里人工推翻/暂缓过的条目（教训）+ 已记的裁决规则。
 * 这一段在 agent 开始测试前读，直接决定它少报多少「人工会过滤掉」的东西。
 */
export function guidance(ws, { maxLessons = 40 } = {}) {
  const lessons = readLedger(ws).filter(e => ['closed', 'accepted'].includes(e.status) && e.reason)
    .slice(0, maxLessons).map(e => ({ id: e.id, title: e.title, outcome: e.statusLabel, reason: e.reason, ...(e.reopenIf ? { reopenIf: e.reopenIf } : {}) }));
  const rules = readRules(ws.dataDir).slice(-60).map(r => ({ id: r.id, verdict: r.verdict, reason: r.reason, match: r.match }));
  return {
    triageRules: [
      '证据层级（basis）决定最高分级：failed 实测失败、wrong 结果错误、promise 与承诺/PRD 不符、friction 能用但费劲、cosmetic 措辞或视觉小瑕疵。',
      'cosmetic 最高只能是 tolerable（可容忍），不进提单清单。',
      '撞墙(wall)/受损(degrade) 必须写 loss：谁、做什么、损失了什么。loss 里不许出现「可能」「疑似」「或许」——推测出来的损失不算。',
      '没有实测证据（截图、页面上读到的文字、请求结果、复现步骤）的怀疑，不提交为发现。',
      '提交前先用 similar 查重：台账或以往运行里判过的，沿用当时的结论，不要重复报。',
      '点击、复制这类操作必须用真实输入（Heimdall 的检查点 steps），不要用页面里的 element.click()：后者不算用户手势，复制按钮会假失败。',
      '文字从浏览器里读，不要经过命令行转码；看到乱码先怀疑工具。',
      '页面上找不到某样东西时，先全页搜索、看页脚和其它入口，再报「不存在」。',
      '测试环境的数据和开关（例如某个防护模式被手动打开）不能代表正式环境；涉及配置的现象先做开关对照。',
      '统计、报表类结论先确认数据前提（历史数据有没有回填、聚合从哪天开始）。',
    ],
    conventions: ws.conventions.map(c => c.text),
    lessons,
    rules,
  };
}
