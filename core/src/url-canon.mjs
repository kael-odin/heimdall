/**
 * 站内 URL 归一化 —— **唯一实现**
 *
 * 为什么必须有：`https://ant.design/` 与 `https://ant.design` 是**同一个页面**，
 * 却是两个不同的字符串。不归一，侦察出来的星图里就会出现两条一模一样的路径、
 * 页面清单里同名两行；而产物目录名是按"去尾斜杠的 path"算的
 * （`pageNameOf` / `pathOf`），于是克隆其中一条会让另一条也显示"已克隆"。
 * 实测 ant.design：侦察 32 个节点里有 4 组这样的重复。
 *
 * 原本只有侦察的**种子 URL** 做了 `.replace(/\/$/,'')`，站内链接与 sitemap 没做 ——
 * 意图是对的，应用得不一致。所以这里做成一个模块，侦察与 SEO 采集共用一份实现，
 * 免得下次又在某一处漏掉（同类问题在这个仓库里已经出现过好几次）。
 *
 * 规则：去 hash；尾斜杠去掉（**根路径除外**）；其余原样（查询参数保留 ——
 * `?page=2` 是另一个页面，不能合并）。
 */
import { createHash } from 'node:crypto';

export function canonUrl(u) {
  try {
    const x = new URL(u);
    x.hash = '';
    if (x.pathname.length > 1 && x.pathname.endsWith('/')) x.pathname = x.pathname.replace(/\/+$/, '');
    return x.href;
  } catch { return null; }
}

/** 归一化并判等（用于"这两条是不是同一页"这类判断） */
export function sameCanonUrl(a, b) {
  const x = canonUrl(a), y = canonUrl(b);
  return !!x && x === y;
}

/**
 * 星图节点的稳定 id —— **url 的纯函数**，与访问顺序无关。
 *
 * 为什么不能用自增序号：侦察是 3 路并发的，`n${i++}` 会把"谁先加载完"写进 id。
 * 同一个没变的站点侦察两次 → id↔url 对不上、缩略图与边全变、任何按 id 的 diff 都报"变了"。
 * 短哈希保证同一 url 永远同一个 id（跨次、跨机一致），可复现性这才成立。
 */
export function stableNodeId(url) {
  return 'n' + createHash('sha1').update(String(url)).digest('hex').slice(0, 8);
}
