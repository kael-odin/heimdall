/**
 * agent/loops/converge — 收敛控制器（E7-08，PRD 03 §5.4、05 §5）
 *
 * 纯函数：输入一个范围（分段或整页）的飞行记录（ledger.jsonl 里 type=iter 的行，按时间顺序），
 * 输出「下一步该做什么」。不读文件、不调浏览器，`rebuild status`、技能和赛后的 Autopilot 共用。
 *
 * 规则（默认值可由 heimdall.config.json 的 budget 覆盖）：
 *   迭代上限  分段 4、整页 8；到顶仍没 pass-candidate → 接受残差
 *   回退      本次比历史最好差 → revert 到最好的那次
 *   停滞      连续 2 次提升都 < 0.2 个百分点 → 升级
 *   振荡      最近 4 次分数升降交替 → 升级
 *   升级阶梯  faithful → 拆子分段 → 问人 → 接受残差；每次升级后至少再看 2 次迭代才可能再升
 *   预算      美元 / 墙钟 / 工具调用，用尽即停
 * 分数口径：各视口像素相似度的最小值（与 rebuild status 一致，木桶短板决定能不能过门禁）。
 * 快速裁判不能宣布 passed，所以单个范围最好的结局是 done（pass-candidate），终态由 terminalOf 结合正式裁判给出。
 */

export const TERMINAL_STATES = Object.freeze(['passed', 'passed_with_residuals', 'failed_with_residuals', 'budget_exhausted', 'cancelled']);
export const LADDER = Object.freeze(['faithful', 'split', 'ask-human', 'accept-residual']);
export const ACTIONS = Object.freeze(['start', 'continue', 'revert', 'escalate', 'accept-residual', 'done', 'stop']);

export const DEFAULTS = Object.freeze({
  maxIterationsPerSection: 4,
  maxIterationsPerPage: 8,
  stagnantEps: 0.002,    // 0.2 个百分点
  sameEps: 0.001,        // 低于它的变化当作噪声
});

const VERDICT_RANK = { 'pass-candidate': 3, near: 2, 'needs-work': 1, fail: 0 };

/** 一次迭代的分数：各视口最小值；没有像素数据时为 null */
export function scoreOf(entry) {
  const v = Object.values(entry?.pixel ?? {}).filter(x => typeof x === 'number');
  return v.length ? Math.min(...v) : null;
}

/** 两次迭代谁更好：先比判定等级，再比分数 */
const better = (a, b) => {
  const ra = VERDICT_RANK[a.verdict] ?? 0, rb = VERDICT_RANK[b.verdict] ?? 0;
  return ra !== rb ? ra > rb : a.score > b.score;
};

/** 预算检查；spent 由调用方给（ledger 里没有美元数） */
export function budgetExceeded(budget = {}, spent = {}) {
  if (budget.maxUsd != null && (spent.usd ?? 0) >= budget.maxUsd) return { kind: 'usd', limit: budget.maxUsd, spent: spent.usd };
  if (budget.maxWallMinutes != null && (spent.wallMs ?? 0) >= budget.maxWallMinutes * 60_000) return { kind: 'wall', limit: budget.maxWallMinutes, spent: +((spent.wallMs ?? 0) / 60_000).toFixed(1) };
  if (budget.maxToolCalls != null && (spent.toolCalls ?? 0) >= budget.maxToolCalls) return { kind: 'toolCalls', limit: budget.maxToolCalls, spent: spent.toolCalls };
  return null;
}

/**
 * 决策。
 * @param {object[]} entries  该范围的迭代记录（按时间顺序）
 * @param {object} opts { scope: 'section'|'page', budget?, spent?, cancelled? }
 * @returns {{ action, reason, iteration, cap, best, escalation, ladderStep?, revertTo?, budget? }}
 */
export function decide(entries, opts = {}) {
  const scope = opts.scope === 'page' ? 'page' : 'section';
  const cfg = { ...DEFAULTS, ...(opts.budget ?? {}) };
  const cap = scope === 'page' ? cfg.maxIterationsPerPage : cfg.maxIterationsPerSection;
  const iters = (entries ?? []).filter(e => scoreOf(e) !== null).map(e => ({ runId: e.runId, verdict: e.verdict, score: scoreOf(e) }));
  const base = { iteration: iters.length, cap };

  if (opts.cancelled) return { ...base, action: 'stop', reason: 'cancelled', best: null, escalation: 0 };
  const over = budgetExceeded(opts.budget, opts.spent);
  if (over) return { ...base, action: 'stop', reason: 'budget_exhausted', budget: over, best: null, escalation: 0 };
  if (!iters.length) return { ...base, action: 'start', reason: '还没有对比记录', best: null, escalation: 0 };

  // 按时间重放，得到最好的一次与升级次数；升级后清空观察窗口
  let best = null, escalation = 0, windowStart = 0, trigger = null;
  for (let i = 0; i < iters.length; i++) {
    if (!best || better(iters[i], best)) best = iters[i];
    trigger = null;
    const win = iters.slice(windowStart, i + 1).map(x => x.score);
    const diffs = win.slice(1).map((v, k) => v - win[k]);
    if (iters[i].verdict === 'pass-candidate') continue;
    const last3 = diffs.slice(-3);
    if (last3.length >= 3 && last3.every(x => Math.abs(x) > cfg.sameEps) && last3.every((x, k) => k === 0 || Math.sign(x) !== Math.sign(last3[k - 1]))) trigger = 'oscillating';
    else if (diffs.length >= 2 && diffs.slice(-2).every(x => x < cfg.stagnantEps)) trigger = 'stagnant';
    if (trigger) { escalation++; windowStart = i; }
  }
  const last = iters.at(-1);
  const summary = { runId: best.runId, verdict: best.verdict, score: best.score };

  if (last.verdict === 'pass-candidate') return { ...base, action: 'done', reason: 'pass-candidate', best: summary, escalation };
  if (best.verdict === 'pass-candidate') return { ...base, action: 'revert', reason: '之前已到 pass-candidate，这次退步了', revertTo: best.runId, best: summary, escalation };
  if (iters.length >= cap) return { ...base, action: 'accept-residual', reason: 'iteration_cap', best: summary, escalation, ...(best !== last ? { revertTo: best.runId } : {}) };
  if (trigger) {
    const step = LADDER[Math.min(escalation, LADDER.length) - 1];
    if (step === 'accept-residual') return { ...base, action: 'accept-residual', reason: 'ladder_exhausted', best: summary, escalation, ...(best !== last ? { revertTo: best.runId } : {}) };
    return { ...base, action: 'escalate', reason: trigger, ladderStep: step, best: summary, escalation, ...(best !== last ? { revertTo: best.runId } : {}) };
  }
  if (last.score < best.score - cfg.sameEps) return { ...base, action: 'revert', reason: 'worse_than_best', revertTo: best.runId, best: summary, escalation };
  return { ...base, action: 'continue', reason: iters.length === 1 ? '第一次对比' : 'improving', best: summary, escalation };
}

/**
 * 整个重建的终态（PRD 05 §5.5）。只有正式裁判能给 passed；没有正式结果时返回 null（还在进行）。
 * @param {object} p { sections: decide() 结果数组, formal?: { status: 'passed'|'failed' }, cancelled?, budgetExhausted? }
 */
export function terminalOf({ sections = [], formal = null, cancelled = false, budgetExhausted = false } = {}) {
  if (cancelled || sections.some(s => s.reason === 'cancelled')) return 'cancelled';
  if (budgetExhausted || sections.some(s => s.reason === 'budget_exhausted')) return 'budget_exhausted';
  if (!formal) return null;
  const residuals = sections.some(s => s.action === 'accept-residual');
  if (formal.status === 'passed') return residuals ? 'passed_with_residuals' : 'passed';
  return 'failed_with_residuals';
}
