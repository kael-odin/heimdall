/**
 * 交付包差异清单 —— "这次导出比上次多了什么、变了什么"
 *
 * 为什么是"清单"而不是"补丁"：见 docs/DELIVERY.md §5。结论是**不做补丁协议** ——
 * 我们的产物全部可以重新生成（原站还在就重抓，原站没了 HAR 快照还在），
 * 重放导出本身是幂等的。缺的只是**把增量读出来**：两份校验和做差集就够了，
 * 不需要版本协商、原子性、回滚那一整套。
 *
 * 有了它之后：
 *   · 接收方只看 changes.json 就知道要不要重新同步
 *   · 传输层做增量（rsync/robocopy 按校验和比对）而不是我们发明协议
 *   · "这次多了 3 页"是读出来的，不是靠人回忆上一次导了什么
 *
 * 纯函数、无 IO，单测直接喂两份 files 数组。
 */

/** 清单最多列这么多条路径：交付包动辄上千文件，全列进 JSON 反而没人看 */
const MAX_LIST = 200;

/**
 * 不参与比较的**元数据文件**（只认根目录下这四个名字）。
 *
 * 它们描述的是"这份包"，不是"被镜像的站点"——而且内容里带导出时间戳，
 * 每次必然不同。把它们算进差异，用户每次都会看到"变化 4"，
 * 于是真正关心的"页面变了没"被噪声淹没。（校验和清单里**仍然包含**它们，用于完整性校验。）
 *
 * 用"路径里没有斜杠"来限定根目录：页面产物里也可能出现叫 health.json 的文件，
 * 那是站点自己的东西，不该被当成我们的元数据。
 */
const META_NAME = /^(checksums\.json|changes\.json|health\.json|heimdall-live\.json)$/;
const isMeta = (p) => !p.includes('/') && META_NAME.test(p);

/**
 * @param {object|null} prev 上一次导出的 checksums.json（没有就是首次导出）
 * @param {Array<{p:string,s:number,h:string}>} files 本次导出的文件清单（不含 checksums.json 自身）
 */
export function diffChecksums(prev, files, at = new Date().toISOString()) {
  const all = files ?? [];
  const now = new Map(all.filter((f) => !isMeta(f.p)).map((f) => [f.p, f]));
  const metaCount = all.length - now.size;
  const before = new Map((prev?.files ?? []).filter((f) => !isMeta(f.p)).map((f) => [f.p, f]));

  const added = [], changed = [], removed = [], same = [];
  for (const [p, f] of now) {
    const old = before.get(p);
    if (!old) added.push(p);
    else if (old.h !== f.h || old.s !== f.s) changed.push(p);
    else same.push(p);
  }
  for (const p of before.keys()) if (!now.has(p)) removed.push(p);

  return {
    at,
    host: prev?.host ?? null,
    /** 上一次是哪一次（时间与文件数）；null 表示这是第一次导出 */
    prev: prev ? { at: prev.generatedAt ?? null, files: before.size } : null,
    firstExport: !before.size && !prev,
    counts: {
      added: added.length,
      changed: changed.length,
      removed: removed.length,
      same: same.length,
      total: now.size,
      meta: metaCount,
    },
    added: added.slice(0, MAX_LIST),
    changed: changed.slice(0, MAX_LIST),
    removed: removed.slice(0, MAX_LIST),
    truncated: added.length > MAX_LIST || changed.length > MAX_LIST || removed.length > MAX_LIST,
    note: '这是与上一次导出之间的**文件级**差异，不是补丁：接收方按校验和同步即可。'
      + '页面的增删也会体现在这里（新增页面 = 多出一组 site/ 下的文件）。'
      + 'checksums/changes/health/heimdall-live 四个根级元数据文件带时间戳，不计入差异；'
      + 'har.json 因记录的是本次抓取的请求时间，每次导出都会不同 —— 它报"变化"是正常的。',
  };
}

/** 一句话给人看的结论，供控制台与导出日志直接引用 */
export function changesLine(ch) {
  if (!ch) return '';
  if (ch.firstExport) return `首次导出 · ${ch.counts.total} 个文件`;
  const c = ch.counts;
  return `与上次导出相比：新增 ${c.added} · 变化 ${c.changed} · 删除 ${c.removed} · 不变 ${c.same}`;
}
