/**
 * prefetch-cache —— 跨挂载存活的按站点小缓存
 *
 * 起因是一个很具体的浪费：DetailDock 把「资产缺口」的缓存写成 `ref()` 放在组件里
 * （audit/asset-gaps.json 一份可达 300KB），而父组件给它的 `:key` 是
 * `'dock-' + selected.id` —— 点一颗星就是一次卸载 + 重挂，组件内变量随之归零，
 * 于是**每点一颗星就重下 300KB**。用户的感受是"详情面板越点越卡"。
 *
 * 所以缓存必须活在模块作用域（模块只求值一次，组件卸载不影响它）。
 *
 * 两条约束写在这里而不是交给调用方：
 *   · **有上限**。模块级缓存没有卸载时机，不设上限就是内存泄漏 ——
 *     用户一晚上能点过几十个站。这里按 LRU 淘汰（Map 的插入顺序即访问顺序）。
 *   · **有有效期**。重跑一次资产扫描之后，缓存里那份就是旧的；
 *     界面会一直显示上一次的缺口数，而用户以为扫描没生效。
 *
 * 键是站点（host）：这些文件本来就是**一站一份**（`static/<host>/audit/asset-gaps.json`
 * 里是 pages 数组，逐页取用）。按 host+page 做键会把同一份文件存 N 次，
 * 既占内存又解决不了"换页要重下"的问题。
 */

/** 一次只留这么多站。20 个站 × 最坏 300KB 量级 —— 百万字节级，可接受。 */
const DEFAULT_MAX = 20;
/** 默认有效期：5 分钟。长到"连点十颗星不重下"，短到"重跑扫描后不用刷新页面"。 */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * @param {number} max       最多缓存多少条（LRU）
 * @param {number} ttlMs     单条有效期
 */
export function createPrefetchCache({ max = DEFAULT_MAX, ttlMs = DEFAULT_TTL_MS } = {}) {
  /** key -> { value, at, promise } */
  const entries = new Map();

  /** 命中就把它挪到末尾（Map 保序），读的时候顺手续期 */
  function touch(key, entry) {
    entries.delete(key);
    entry.at = Date.now();
    entries.set(key, entry);
    while (entries.size > max) entries.delete(entries.keys().next().value);
    return entry.value;
  }

  function fresh(key) {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.at && Date.now() - entry.at > ttlMs) { entries.delete(key); return null; }
    return entry;
  }

  return {
    /**
     * 取一次，没有就调 loader。
     *
     * 同一个 key 的并发请求**合并**：详情面板的 clone-gaps 与 live-health 是两个
     * 独立的 await，用户快速切页时会两次并发进来；不去重就会有两个 300KB 请求同时在飞。
     * 存的也不是"结果"而是 promise —— 失败（loader 返回 null）不缓存，下次还会重试。
     */
    async get(key, loader) {
      const hit = fresh(key);
      if (hit) return hit.promise ? hit.promise : touch(key, hit);
      const entry = { at: Date.now(), value: null, promise: null };
      entry.promise = (async () => {
        let value = null;
        try { value = await loader(); } catch { value = null; }
        entry.promise = null;
        // 只删自己那一格：并发时另一边可能已经写进了新值
        if (value == null) { if (entries.get(key) === entry) entries.delete(key); return null; }
        entry.value = value;
        touch(key, entry);
        return value;
      })();
      entries.set(key, entry);
      while (entries.size > max) entries.delete(entries.keys().next().value);
      return entry.promise;
    },
    /** 手动失效（例如刚重跑完扫描） */
    drop(key) { entries.delete(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

/** 资产缺口全站文档（audit/asset-gaps.json）。Atlas 与 DetailDock 共用这一份。 */
export const assetGapsPrefetch = createPrefetchCache();

/** 交互镜像体检（/api/live-health/:host）。同一站点的详情面板反复打开时不必重问。 */
export const liveHealthPrefetch = createPrefetchCache({ ttlMs: 60 * 1000 });
