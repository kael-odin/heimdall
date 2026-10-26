/**
 * 收敛控制器（E7-08，PRD 03 §5.4、05 §5）：每条规则一个用例，终态枚举固定
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, terminalOf, scoreOf, budgetExceeded, TERMINAL_STATES, LADDER } from '../src/agent/loops/converge.mjs';

let n = 0;
/** 一次迭代：score 同时作为三个视口里的最低分，verdict 默认 needs-work */
const it = (score, verdict = 'needs-work') => ({ runId: `run_${String(++n).padStart(4, '0')}`, pixel: { 375: score + 0.01, 768: score, 1440: score + 0.005 }, verdict });

test('converge: score is the worst viewport; empty history starts', () => {
  assert.equal(scoreOf({ pixel: { 375: 0.98, 1440: 0.95 } }), 0.95);
  assert.equal(scoreOf({}), null);
  assert.equal(decide([]).action, 'start');
});

test('converge: improving keeps going; pass-candidate is done (never passed)', () => {
  assert.equal(decide([it(0.90), it(0.94)]).action, 'continue');
  const d = decide([it(0.90), it(0.95), it(0.975, 'pass-candidate')]);
  assert.equal(d.action, 'done');
  assert.equal(d.best.verdict, 'pass-candidate');
});

test('converge: worse than the best so far reverts to the best run', () => {
  const a = it(0.90), b = it(0.95), c = it(0.92);
  const d = decide([a, b, c]);
  assert.equal(d.action, 'revert');
  assert.equal(d.revertTo, b.runId);
  const p = it(0.98, 'pass-candidate'), q = it(0.96);
  assert.equal(decide([it(0.9), p, q]).revertTo, p.runId, 'a lost pass-candidate is always restored');
});

test('converge: two gains under 0.2 pp escalate along the ladder, one step per window', () => {
  const s = [it(0.950), it(0.951), it(0.952)];
  const d1 = decide(s);
  assert.equal(d1.action, 'escalate');
  assert.equal(d1.reason, 'stagnant');
  assert.equal(d1.ladderStep, LADDER[0]);
  // 升级后一次迭代不足以再判停滞
  assert.equal(decide([...s, it(0.9525)], { budget: { maxIterationsPerSection: 10 } }).action, 'continue', 'needs two fresh iterations after an escalation');
});

test('converge: the ladder ends in accepting the residual', () => {
  const flat = Array.from({ length: 9 }, () => it(0.95));
  const d = decide(flat, { budget: { maxIterationsPerSection: 20 } });
  assert.equal(d.escalation, 4);
  assert.equal(d.action, 'accept-residual');
  assert.equal(d.reason, 'ladder_exhausted');
  assert.equal(decide(flat.slice(0, 7), { budget: { maxIterationsPerSection: 20 } }).ladderStep, 'ask-human');
});

test('converge: alternating scores are oscillation', () => {
  const d = decide([it(0.90), it(0.94), it(0.91), it(0.935)], { budget: { maxIterationsPerSection: 10 } });
  assert.equal(d.reason, 'oscillating');
  assert.equal(d.action, 'escalate');
  assert.ok(d.revertTo, 'the best of the swing is restored before escalating');
});

test('converge: iteration cap is 4 per section and 8 per page, configurable', () => {
  const four = [it(0.80), it(0.85), it(0.90), it(0.93)];
  assert.equal(decide(four).action, 'accept-residual');
  assert.equal(decide(four).reason, 'iteration_cap');
  assert.equal(decide(four, { scope: 'page' }).action, 'continue');
  assert.equal(decide(four, { budget: { maxIterationsPerSection: 6 } }).action, 'continue');
});

test('converge: budget and cancel stop before anything else', () => {
  assert.deepEqual(budgetExceeded({ maxUsd: 5 }, { usd: 5.2 }), { kind: 'usd', limit: 5, spent: 5.2 });
  assert.equal(budgetExceeded({ maxWallMinutes: 10 }, { wallMs: 60_000 }), null);
  assert.equal(decide([it(0.9)], { budget: { maxToolCalls: 3 }, spent: { toolCalls: 3 } }).reason, 'budget_exhausted');
  assert.equal(decide([it(0.9)], { cancelled: true }).reason, 'cancelled');
});

test('converge: terminal states come only from the fixed enum, passed only from the formal judge', () => {
  const done = { action: 'done' }, residual = { action: 'accept-residual' };
  assert.equal(terminalOf({ sections: [done] }), null, 'no formal result → still running');
  assert.equal(terminalOf({ sections: [done], formal: { status: 'passed' } }), 'passed');
  assert.equal(terminalOf({ sections: [done, residual], formal: { status: 'passed' } }), 'passed_with_residuals');
  assert.equal(terminalOf({ sections: [done], formal: { status: 'failed' } }), 'failed_with_residuals');
  assert.equal(terminalOf({ sections: [{ reason: 'budget_exhausted' }] }), 'budget_exhausted');
  assert.equal(terminalOf({ cancelled: true }), 'cancelled');
  assert.deepEqual([...TERMINAL_STATES], ['passed', 'passed_with_residuals', 'failed_with_residuals', 'budget_exhausted', 'cancelled']);
});
