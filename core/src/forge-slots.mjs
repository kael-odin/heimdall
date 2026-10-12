/**
 * forge-slots — 锻造槽计数（一个槽 = 一个 Chromium 实例）
 *
 * 抽出来的理由：这块**曾经有一笔账一直是错的，而且错得完全不出声**。
 * 引擎原来在任务退出时用一串 if/else 归还槽位，末尾是兜底的 `else forgeSlots--`。
 * 于是**任何没占过槽的任务类型**（CAS 回收 / 编辑清单 / 域名替换就是这三种）
 * 退出时也会减一 —— 计数变成负数，控制台上显示「克隆槽 -1/2」。
 * 真正的后果比读数难看得多：`forgeSlots >= MAX_FORGE` 这道闸门从此**永不触发**，
 * 并发上限（默认 2 个 Chromium）静默失效，用户以为在按规矩排队。
 *
 * 所以把它做成一个会**大声失败**的小对象：归还一个没占过的槽会被拒绝并报告，
 * 计数永远不会变负，闸门也永远不会因为记账错误而失灵。
 * 调用方拿到 false 就该把这件事记进日志，而不是默默继续。
 */
export function makeSlotBox(max) {
  const cap = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1;
  let used = 0;
  let errors = 0;
  return {
    max: cap,
    get used() { return used; },
    /** 归还了没占过的槽的次数（>0 说明有一处记账漏了，值得去查） */
    get errors() { return errors; },
    /** 占一个槽；满了返回 false（调用方转 409 busy），**不加也不减** */
    acquire() {
      if (used >= cap) return false;
      used++;
      return true;
    },
    /**
     * 归还一个槽。
     * @returns {boolean} true = 正常归还；false = 这次归还没有对应的占用，已被忽略
     */
    release() {
      if (used <= 0) { errors++; return false; }
      used--;
      return true;
    },
  };
}
