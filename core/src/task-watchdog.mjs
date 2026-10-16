/**
 * task-watchdog — 单个任务的熔断计时（硬超时 + 无进展）
 *
 * 为什么要两条线：
 *   · 硬超时（timeoutMs）管"这页跑太久了"，不管它在不在动
 *   · 无进展（stallMs）管"这页卡死了"—— 每次有进展就重新计时，
 *     所以一个正常但慢的页（大图多）不会被误杀
 *
 * 抽成独立模块的唯一理由是**可测**：熔断判错的代价是把一个其实在正常
 * 工作的页面杀掉，然后用户看到"失败"却不知道为什么。所以用注入的
 * 时钟把它钉死。
 */
export function createWatchdog(opts = {}) {
  const {
    timeoutMs = 0, stallMs = 0,
    setTimer = setTimeout, clearTimer = clearTimeout,
    onKill = () => {},
  } = opts;

  let killed = null;
  let stopped = false;
  let hardTimer = null;
  let stallTimer = null;

  const fire = (reason) => { if (!stopped && !killed) { killed = reason; onKill(reason); } };

  const armStall = () => {
    if (!stopped && stallMs > 0) stallTimer = setTimer(() => fire('stalled'), stallMs);
  };

  if (timeoutMs > 0) hardTimer = setTimer(() => fire('timeout'), timeoutMs);
  armStall();

  return {
    /** 有进展：重新计无进展的时 */
    touch() {
      if (stopped || killed || stallMs <= 0) return;
      if (stallTimer) clearTimer(stallTimer);
      armStall();
    },
    /** 任务结束：停掉所有计时 */
    stop() {
      stopped = true;
      if (hardTimer) clearTimer(hardTimer);
      if (stallTimer) clearTimer(stallTimer);
      hardTimer = stallTimer = null;
    },
    get killed() { return killed; },
  };
}
