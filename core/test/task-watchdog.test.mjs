/**
 * task-watchdog — 单任务熔断
 *
 * 用假时钟测，因为要断言的是"什么时候开火"，而不是等真实分钟过去。
 * 重点钉住：**有进展就不该被无进展线杀掉** —— 判错的代价是误杀正常页。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWatchdog } from '../src/task-watchdog.mjs';

/** 假时钟：手动推进时间，收集已排的定时器 */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimer: (id) => timers.delete(id),
    /** 推进到 t，按到期顺序触发 */
    advanceTo(t) {
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= t && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = t;
    },
  };
}

test('watchdog: 硬超时到点开火', () => {
  const c = fakeClock();
  const fired = [];
  createWatchdog({ timeoutMs: 1000, setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  c.advanceTo(999);
  assert.deepEqual(fired, []);
  c.advanceTo(1000);
  assert.deepEqual(fired, ['timeout']);
});

test('watchdog: 无进展到点开火', () => {
  const c = fakeClock();
  const fired = [];
  createWatchdog({ stallMs: 500, setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  c.advanceTo(500);
  assert.deepEqual(fired, ['stalled']);
});

test('watchdog: 持续有进展则永不触发 stalled（慢但正常的页不该被杀）', () => {
  const c = fakeClock();
  const fired = [];
  const w = createWatchdog({ stallMs: 100, setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  for (let t = 50; t <= 10_000; t += 50) { c.advanceTo(t); w.touch(); }
  assert.deepEqual(fired, [], '每 50ms 有进展，100ms 的线永远够不到');
});

test('watchdog: 进展停止后按最后一次进展重新计时', () => {
  const c = fakeClock();
  const fired = [];
  const w = createWatchdog({ stallMs: 100, setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  c.advanceTo(90); w.touch();
  c.advanceTo(180);
  assert.deepEqual(fired, [], '距上次进展才 90ms');
  c.advanceTo(190);
  assert.deepEqual(fired, ['stalled'], '最后一次进展在 90ms，100ms 后即 190ms 开火');
});

test('watchdog: 已经开火后不再开第二次，硬超时仍会到点但被忽略', () => {
  const c = fakeClock();
  const fired = [];
  createWatchdog({ timeoutMs: 1000, stallMs: 100, setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  c.advanceTo(100);
  c.advanceTo(2000);
  assert.deepEqual(fired, ['stalled'], '只报一次，且报的是先到的那条线');
});

test('watchdog: stop 之后不再开火', () => {
  const c = fakeClock();
  const fired = [];
  const w = createWatchdog({ timeoutMs: 1000, stallMs: 200, setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  c.advanceTo(100); w.stop();
  c.advanceTo(10_000);
  assert.deepEqual(fired, []);
});

test('watchdog: 两条线都关掉就是空转（不设时间上限的场景）', () => {
  const c = fakeClock();
  const fired = [];
  createWatchdog({ setTimer: c.setTimer, clearTimer: c.clearTimer, onKill: (r) => fired.push(r) });
  c.advanceTo(10_000_000);
  assert.deepEqual(fired, []);
});
